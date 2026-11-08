import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { AUDIO_OUTPUT_START_TIMEOUT_MS, SharedAudioOutput } from '../src/ui/audio-output';
import { deferred, flush, pcm, world } from './helpers/r02-audio-world';

/*
 * Codex T-207 round 6 (pinned 656ee87, audio-result.md; 2026-11-04, the morning she did not speak):
 * 1. A start begun while hidden, every resume stuck, shown at 9 s, hidden and shown again at 18 s: the same waiter was
 *    rejected only at 28 s — each restart set a whole new 10 s timer. The wait now has one budget from its first attempt;
 *    showing the window retries within it and never extends it.
 * 2. The idle suspend (async) had not settled when a new reading took the lease: the lease came back as "running", the
 *    suspend then landed, and the reading stayed silent and pending forever (16 s after its PCM and done: no start, no end,
 *    no error). Now a lease taken while a suspend is in flight waits for it and resumes the device, inside the same budget.
 * Fake clock and fake devices only; no real audio.
 *
 * 2026-11-05 (the freeze: building an AudioContext blocks the window for up to 15 s): showing the window asks the same
 * context again instead of building a new one, a failed start keeps its context, and only a context that could not start
 * twice in a row with the window visible is rebuilt, once, while nothing plays. The budgets below are unchanged.
 */
const LIMIT = { timeout: 30_000 };

function observe<T>(promise: Promise<T>) {
  const seen: { state: 'waiting' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { state: 'waiting' };
  void promise.then(value => { seen.state = 'fulfilled'; seen.value = value; }, error => { seen.state = 'rejected'; seen.error = error; });
  return seen;
}

function harness(t: TestContext, options: { hidden?: boolean; idleMs?: number; stuck?: number; stuckWhileHidden?: number } = {}) {
  const w = world(t, { deviceStartMs: 50 });
  let stuck = options.stuck ?? 0, stuckWhileHidden = options.stuckWhileHidden ?? 0;
  const createContext = () => {
    const context = w.createContext() as unknown as { resume(): Promise<void>; resumes: number };
    // The next `stuck` devices never start (resume() never settles); the next `stuckWhileHidden` ones only hang for a
    // resume() asked while the window is hidden, like the one in the hidden window.
    if (stuck > 0) { stuck--; context.resume = () => { context.resumes++; return new Promise<void>(() => {}); }; }
    else if (stuckWhileHidden > 0) {
      stuckWhileHidden--;
      const resume = context.resume.bind(context);
      context.resume = () => { if (!hidden) return resume(); context.resumes++; return new Promise<void>(() => {}); };
    }
    return context as unknown as AudioContext;
  };
  let hidden = options.hidden ?? false;
  const listeners = new Set<() => void>();
  const visibility = { hidden: () => hidden, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const audio = new SharedAudioOutput({ createContext, now: w.now, timers: w.timers, visibility, idleMs: options.idleMs });
  t.after(() => audio.dispose());
  return {
    w, audio,
    hide() { hidden = true; for (const each of [...listeners]) each(); },
    show() { hidden = false; for (const each of [...listeners]) each(); },
    get listening() { return listeners.size; },
  };
}

test('audio wait budget: showing the window again and again retries the start but never extends the wait past 10 s', LIMIT, async t => {
  const h = harness(t, { hidden: true, stuck: 1 });
  const began = h.w.now();
  const waiting = observe(h.audio.acquire());
  await h.w.advance(9000);
  h.show(); // asked again at once, on the same context
  await flush();
  assert.equal(h.w.contexts.length, 1, 'shown: no new context is built (2026-11-05)');
  assert.equal(h.w.contexts[0].resumes, 2, 'the hidden start is asked again');
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS - 9000 - 1);
  assert.equal(waiting.state, 'waiting', 'nothing gives up before the bound');
  await h.w.advance(1);
  assert.equal(waiting.state, 'rejected', `rejected ${h.w.now() - began} ms after the first attempt (was 28 s on 656ee87)`);
  assert.equal(h.w.now() - began, AUDIO_OUTPUT_START_TIMEOUT_MS);
  assert.equal(h.w.contexts[0].closes, 0, 'one failed start keeps its context');
  // Codex's later toggle (18 s) finds nothing waiting: no further attempt, nothing kept listening.
  await h.w.advance(8000);
  h.hide(); h.show();
  await h.w.advance(10_000);
  assert.equal(h.w.contexts.length, 1);
  assert.equal(h.w.contexts[0].resumes, 2);
  assert.equal(h.listening, 0);
  // The next reading asks the same context again; it still cannot start, and fails at its own bound.
  const second = observe(h.audio.acquire());
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS);
  assert.equal(second.state, 'rejected');
  assert.equal(h.w.contexts[0].resumes, 3);
  // Two starts in a row that could not run with the window visible: rebuilt once, while nothing waits.
  await h.w.advance(1);
  assert.equal(h.w.contexts.length, 2);
  assert.equal(h.w.contexts[0].closes, 1);
  const next = observe(h.audio.acquire());
  await h.w.advance(60);
  assert.equal(next.state, 'fulfilled');
  assert.equal(next.value!.context, h.w.contexts[1] as unknown as AudioContext);
  assert.equal(h.w.contexts.length, 2, 'the reading itself built nothing');
  next.value!.release();
});

test('audio wait budget: several hide/show toggles inside one wait still end it at the first attempt\'s 10 s', LIMIT, async t => {
  const h = harness(t, { hidden: true, stuck: 10 });
  const began = h.w.now();
  const waiting = observe(h.audio.acquire());
  for (const at of [2000, 4000, 6000, 8000, 9500]) {
    await h.w.advance(at - (h.w.now() - began));
    h.hide(); h.show();
  }
  assert.equal(h.w.contexts.length, 1, 'each show asked the same context again, nothing was built');
  assert.equal(h.w.contexts[0].resumes, 6);
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS - (h.w.now() - began) - 1);
  assert.equal(waiting.state, 'waiting');
  await h.w.advance(1);
  assert.equal(waiting.state, 'rejected');
  assert.equal(h.w.contexts[0].closes, 0);
  assert.equal(h.listening, 0);
});

test('audio wait budget (guarded): a reading waiting on a hidden start still plays on the same context when shown in time', LIMIT, async t => {
  const h = harness(t, { hidden: true, stuckWhileHidden: 1 });
  const waiting = observe(h.audio.acquire());
  await h.w.advance(9000);
  h.show();
  await h.w.advance(60);
  assert.equal(waiting.state, 'fulfilled', 'the context ran within the budget once asked again');
  assert.equal(waiting.value!.context, h.w.contexts[0] as unknown as AudioContext);
  assert.equal(h.w.contexts.length, 1);
  assert.equal(h.audio.lastStartMs, 9050, 'the start is measured from the first attempt');
  waiting.value!.release();
});

/** A device whose next suspend() stays in flight until `gate` settles (its state reads "running" until then). */
function slowSuspend(device: { suspends: number; state: AudioContextState; suspend(): Promise<void> }) {
  const gate = deferred();
  device.suspend = () => {
    device.suspends++;
    return gate.promise.then(() => { device.state = 'suspended'; (device as unknown as { runningSince: number }).runningSince = -1; });
  };
  return gate;
}

function playerFor(h: ReturnType<typeof harness>) {
  const speaking: { value: boolean; at: number }[] = [], errors: string[] = [], marks: string[] = [];
  const player = new StreamingVoicePlayer({
    output: h.audio, now: h.w.now, timers: h.w.timers,
    onSpeaking: value => speaking.push({ value, at: h.w.now() }), onError: message => errors.push(message), onMark: mark => marks.push(mark.kind),
  });
  return { player, speaking, errors, marks };
}

test('audio idle suspend: a suspend still in flight when a new reading takes the device no longer leaves it silent and pending', LIMIT, async t => {
  const h = harness(t, { idleMs: 200 });
  const { player, speaking, errors, marks } = playerFor(h);
  t.after(() => player.dispose());
  const warm = await (async () => { const lease = h.audio.acquire(); await h.w.advance(60); return lease; })();
  const device = h.w.contexts[0];
  assert.equal(device.state, 'running');
  const gate = slowSuspend(device);
  warm.release();
  await h.w.advance(200);
  assert.equal(device.suspends, 1, 'the idle suspend was asked for');
  assert.equal(device.state, 'running', 'and has not landed yet');
  const opened = h.w.now();
  void player.begin('idle-race');
  const finished = observe(player.finished);
  await flush();
  gate.resolve(); // the suspend lands after the new reading asked for the device
  await flush();
  void player.accept({ id: 'idle-race', type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  void player.accept({ id: 'idle-race', type: 'done', firstAudioMs: 300, audioBytes: 9600 });
  await h.w.advance(200);
  assert.equal(device.state, 'running', 'the late suspend did not leave the device suspended under the reading');
  assert.equal(device.resumes, 2, 'resumed again after the suspend landed');
  await h.w.advance(16_000 - 200);
  t.diagnostic(JSON.stringify({ device: device.state, resumes: device.resumes, marks, speaking, errors, finished: finished.state }));
  assert.notEqual(finished.state, 'waiting', 'the reading ends one way or the other (on 656ee87 it waited forever)');
  assert.equal(finished.state, 'fulfilled', 'it is heard, not given up');
  assert.deepEqual(errors, []);
  assert.equal(device.suspends, 2, 'idle again only after the reading ended (the ordinary idle suspend)');
  assert.equal(h.w.contexts.length, 1, 'the same device');
  const heard = speaking.find(s => s.value);
  assert.ok(heard && heard.at - opened <= 200, `heard ${heard ? heard.at - opened + ' ms' : 'never'} after the reading began`);
  assert.deepEqual(marks.slice(0, 2), ['device', 'scheduled']);
  assert.ok(marks.includes('audible') && marks.includes('drained'));
});

test('audio idle suspend: a suspend that never lands is bounded by the start budget and fails the reading instead of hanging', LIMIT, async t => {
  const h = harness(t, { idleMs: 200 });
  const { player, speaking, errors } = playerFor(h);
  t.after(() => player.dispose());
  const warm = h.audio.acquire();
  await h.w.advance(60);
  const device = h.w.contexts[0];
  slowSuspend(device); // never resolved
  (await warm).release();
  await h.w.advance(200);
  assert.equal(device.suspends, 1);
  void player.begin('stuck-suspend');
  const finished = observe(player.finished);
  void player.accept({ id: 'stuck-suspend', type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  void player.accept({ id: 'stuck-suspend', type: 'done', firstAudioMs: 300, audioBytes: 9600 });
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS - 1);
  assert.equal(finished.state, 'waiting', 'nothing gives up before the bound');
  await h.w.advance(1);
  assert.equal(finished.state, 'rejected', 'the ordinary playback error path (the caller can fall back)');
  assert.equal(errors.length, 1);
  assert.equal(speaking.some(s => s.value), false, 'the mouth never moved for silence');
  assert.equal(device.closes, 0, 'one failed start keeps the context (2026-11-05)');
  // The next reading asks the same context again; the suspend still has not landed, so it fails at its bound too.
  const second = observe(h.audio.acquire());
  await flush();
  assert.equal(h.w.contexts.length, 1, 'no build at the moment a reading starts');
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS);
  assert.equal(second.state, 'rejected');
  // Wedged twice with the window visible: rebuilt once, as soon as nothing waits; the next reading is heard on it.
  await h.w.advance(1);
  assert.equal(h.w.contexts.length, 2);
  assert.equal(device.closes, 1, 'the wedged context is let go once its replacement exists');
  const next = observe(h.audio.acquire());
  await h.w.advance(60);
  assert.equal(next.state, 'fulfilled');
  assert.equal(next.value!.context, h.w.contexts[1] as unknown as AudioContext);
  next.value!.release();
});

test('audio idle suspend (guarded): a suspend that already landed is resumed as before, and a warm device is served at once', LIMIT, async t => {
  const h = harness(t, { idleMs: 200 });
  const first = h.audio.acquire();
  await h.w.advance(60);
  const device = h.w.contexts[0];
  (await first).release();
  await h.w.advance(300);
  assert.equal(device.state, 'suspended');
  const resumed = observe(h.audio.acquire());
  await h.w.advance(60);
  assert.equal(resumed.state, 'fulfilled');
  assert.equal(resumed.value!.startMs, 50, 'a suspended device is waited for and measured');
  assert.equal(device.resumes, 2);
  const warm = observe(h.audio.acquire());
  await flush();
  assert.equal(warm.state, 'fulfilled', 'a running device with no suspend in flight is served without waiting');
  assert.equal(warm.value!.startMs, 0);
  assert.equal(device.resumes, 2);
  resumed.value!.release(); warm.value!.release();
});
