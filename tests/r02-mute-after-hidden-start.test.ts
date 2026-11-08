import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import type { SpeechDiagnosticRecord } from '../shared/speech-diagnostics';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/ui/VoiceOutput';
import { AUDIO_OUTPUT_START_TIMEOUT_MS, SharedAudioOutput } from '../src/ui/audio-output';
import { flush, pcm, world } from './helpers/r02-audio-world';

/*
 * 2026-11-04 (stable a9ad29f): "她不会朗读……嘴也没有动". Started with the pet window hidden,
 * her first reply's PCM arrived in 911 ms but the output device never ran: no device mark, no
 * scheduled sample, cancelled after 84 s, and no later reply left a record at all. A device start
 * (AudioContext.resume) that never settles used to be shared by every later playback forever.
 * These tests use a fake clock and fake devices; one device can be made to never start.
 *
 * 2026-11-05 (the freeze): building an AudioContext blocks the window for up to 15 s, so a stuck start no longer closes
 * its context and builds another. A start asked while hidden is asked again on the same context once the window is shown
 * (`stickWhileHidden`: that device only hangs for resumes asked while hidden), and a context that cannot start twice in a
 * row with the window visible (`stickNext`: hangs for good) is rebuilt once, while nothing plays.
 */
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
/** A reply that stays silent forever fails here instead of hanging the suite. */
const LIMIT = { timeout: 30_000 };

function harness(t: TestContext, options: { hidden?: boolean; deviceStartMs?: number } = {}) {
  const w = world(t, { deviceStartMs: options.deviceStartMs ?? 50 });
  let stuck = 0, stuckWhileHidden = 0;
  // The next `stuck` devices never start (resume() never settles); the next `stuckWhileHidden` ones only hang for a
  // resume() asked while the window is hidden, like the start in the hidden window on 2026-11-04.
  const createContext = () => {
    const context = w.createContext() as unknown as { resume(): Promise<void>; resumes: number };
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
  const audio = new SharedAudioOutput({ createContext, now: w.now, timers: w.timers, visibility });
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  let ids = 0;
  const requests: { id: string; at: number }[] = [];
  const records: SpeechDiagnosticRecord[] = [], errors: string[] = [], speaking: { value: boolean; at: number }[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id) { requests.push({ id, at: w.now() }); },
      async cancelSpeech() {},
      async releaseSpeech() {},
      async beginSpeechPlaybackActivity() { return 'lease'; },
      async endSpeechPlaybackActivity() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
      async recordSpeechDiagnostic(record) { records.push(record); },
    },
    onSpeaking: value => speaking.push({ value, at: w.now() }), onError: message => errors.push(message),
    createId: () => `mute-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index].id, ...event } as VoiceOutputEvent);
  return {
    w, audio, output, requests, records, errors, speaking,
    stickNext(count = 1) { stuck = count; },
    stickWhileHidden(count = 1) { stuckWhileHidden = count; },
    hide() { hidden = true; for (const each of [...listeners]) each(); },
    show() { hidden = false; for (const each of [...listeners]) each(); },
    /** The window is visible but no visibilitychange reached this output. */
    unhideQuietly() { hidden = false; },
    get listening() { return listeners.size; },
    /** A one-sentence Bailian reply on the R02 path (host lease, one continuous player). */
    reply(replyId: string) {
      const playback = h_open(output, replyId);
      const opened = w.now();
      return { opened, outcome: playback.finished.then(() => 'ended' as const, () => 'error' as const) };
    },
    /** That reply's synthesis: three 0.2 s chunks, then done. */
    synthesize(index: number) {
      for (let i = 0; i < 3; i++) emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: 900 } : {}) });
      emit(index, { type: 'done', firstAudioMs: 900, audioBytes: 3 * 9600 });
    },
    audibleSince(at: number) { return speaking.find(s => s.value && s.at >= at)?.at; },
  };
}
function h_open(output: VoiceOutput, replyId: string) {
  const playback = output.openReply(voice, replyId)!;
  void playback.append('第一句。', { replyId, segmentIndex: 0 }).catch(() => false);
  const finished = playback.close();
  void finished.catch(() => {});
  return { finished };
}

test('mute bug: a device start that never settles no longer keeps this and every later reply silent', LIMIT, async t => {
  const h = harness(t);
  h.stickNext();
  h.output.prewarm(); // chat sent
  const first = h.reply('reply-1');
  await flush();
  assert.equal(h.requests.length, 1, 'synthesis is still dispatched while the device starts (R02)');
  await h.w.advance(911); h.synthesize(0); await flush();
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS - 911 - 2);
  assert.deepEqual(h.errors, [], 'nothing gives up before the bound');
  await h.w.advance(10);
  assert.equal(await first.outcome, 'error', 'the stuck reading ends through the ordinary failure path instead of waiting forever');
  assert.equal(h.errors.length, 1);
  assert.equal(h.speaking.some(s => s.value), false, 'the mouth never moved for silence');
  assert.equal(h.w.contexts[0].closes, 0, '2026-11-05: one failed start does not close the context (building another freezes her)');
  assert.equal(h.w.contexts.length, 1);
  const failed = h.records.find(record => record.outcome === 'error');
  assert.ok(failed, 'the failure leaves a developer record (the stuck reply used to leave none)');
  assert.ok(failed.t.firstPacket !== undefined && failed.t.deviceStart === undefined && failed.t.scheduled === undefined);
  // The next reply asks the same context again; it still cannot start, so it fails at its own bound too.
  const second = h.reply('reply-2');
  await flush();
  assert.equal(h.w.contexts.length, 1, 'no build at the moment she starts speaking');
  assert.equal(h.w.contexts[0].resumes, 2, 'the same context is asked again');
  await h.w.advance(300); h.synthesize(1); await flush();
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS);
  assert.equal(await second.outcome, 'error');
  assert.equal(h.errors.length, 2);
  // Twice in a row with the window visible: the browser has wedged it. It is rebuilt once, while nothing plays.
  await h.w.advance(10);
  assert.equal(h.w.contexts.length, 2, 'rebuilt after the failed reading, before the next one opens');
  assert.equal(h.w.contexts[0].closes, 1, 'the wedged context is let go once its replacement exists');
  const third = h.reply('reply-3');
  await flush();
  await h.w.advance(300); h.synthesize(2); await flush();
  await h.w.advance(1000);
  assert.equal(await third.outcome, 'ended');
  assert.equal(h.w.contexts.length, 2, 'the reply itself built nothing');
  assert.ok(h.audibleSince(third.opened), 'she is heard again');
  assert.equal(h.errors.length, 2, 'no further error');
  assert.ok(h.records.some(record => record.outcome === 'ended' && record.t.deviceEnd !== undefined && record.t.playbackStart !== undefined));
});

test('mute bug: a start begun while the window was hidden is asked again when it is shown, for the reply that waits on it', LIMIT, async t => {
  const h = harness(t, { hidden: true });
  h.stickWhileHidden();
  h.output.prewarm(); // the device is asked for while the pet window is hidden
  await h.w.advance(3000);
  assert.equal(h.listening, 1, 'a waiting start watches the window visibility');
  h.show();
  await h.w.advance(60);
  assert.equal(h.w.contexts[0].resumes, 2, 'the hidden start is asked again when the window is shown');
  assert.equal(h.w.contexts[0].state, 'running', 'the same context runs at once');
  assert.equal(h.w.contexts.length, 1, 'no new context is built (2026-11-05)');
  assert.equal(h.w.contexts[0].closes, 0);
  assert.equal(h.listening, 0, 'no visibility listener once the device runs');
  const reply = h.reply('reply-1');
  await flush();
  await h.w.advance(300); h.synthesize(0); await flush();
  await h.w.advance(1000);
  assert.equal(await reply.outcome, 'ended');
  const audible = h.audibleSince(reply.opened);
  assert.ok(audible !== undefined && audible - reply.opened <= 300 + 110, `heard ${audible === undefined ? 'never' : audible - reply.opened + ' ms'} after the reply opened`);
  assert.deepEqual(h.errors, []);
});

test('mute bug: a reply already waiting on a hidden start plays on the same context when the window is shown', LIMIT, async t => {
  const h = harness(t, { hidden: true });
  h.stickWhileHidden();
  const reply = h.reply('reply-1');
  await flush();
  await h.w.advance(911); h.synthesize(0); await flush();
  await h.w.advance(2000);
  h.show();
  await h.w.advance(1500);
  assert.equal(await reply.outcome, 'ended', 'the same reading plays once the window is visible');
  assert.ok(h.audibleSince(reply.opened));
  assert.deepEqual(h.errors, []);
  assert.equal(h.w.contexts.length, 1);
});

test('mute bug: a start given up while hidden is tried once more when the window is shown, so the next reply is warm', LIMIT, async t => {
  const h = harness(t, { hidden: true });
  h.stickWhileHidden();
  h.output.prewarm();
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS + 50);
  assert.equal(h.w.contexts[0].state, 'suspended', 'given up after the bound even while hidden');
  assert.equal(h.w.contexts[0].closes, 0, 'but kept (2026-11-05)');
  assert.deepEqual(h.errors, [], 'a prewarm nobody listened to says nothing');
  assert.equal(h.w.contexts[0].resumes, 1, 'nothing is retried while still hidden');
  h.show();
  await h.w.advance(60);
  assert.equal(h.w.contexts.length, 1);
  assert.equal(h.w.contexts[0].resumes, 2);
  assert.equal(h.w.contexts[0].state, 'running', 'one retry once she is visible, on the same context');
  assert.equal(h.listening, 0);
  h.hide(); h.show();
  assert.equal(h.w.contexts[0].resumes, 2, 'only once');
  const reply = h.reply('reply-1');
  await flush();
  await h.w.advance(300); h.synthesize(0); await flush();
  await h.w.advance(1000);
  assert.equal(await reply.outcome, 'ended');
  const first = h.records.find(record => record.kind === 'reply');
  assert.equal(first?.t.deviceEnd, first?.t.deviceStart, 'the device was already running: no wait');
  assert.deepEqual(h.errors, []);
});

test('mute bug: the next playback never just waits on a hidden start once the window is visible, even if no event arrived', LIMIT, async t => {
  const h = harness(t, { hidden: true });
  h.stickWhileHidden();
  h.output.prewarm();
  await h.w.advance(2000);
  h.unhideQuietly();
  const reply = h.reply('reply-1');
  await flush();
  await h.w.advance(300); h.synthesize(0); await flush();
  await h.w.advance(1000);
  assert.equal(await reply.outcome, 'ended');
  assert.equal(h.w.contexts[0].resumes, 2, 'asked again on the same context');
  assert.equal(h.w.contexts.length, 1);
  assert.equal(h.w.contexts[0].closes, 0);
  assert.deepEqual(h.errors, []);
});

test('mute fix keeps the normal path: warm device and slow cold device are heard exactly when they were before', LIMIT, async t => {
  // Warm: chat sent, Claude writes for 2 s, the reply's first PCM arrives 300 ms after it opens.
  {
    const h = harness(t);
    const sent = h.w.now();
    h.output.prewarm();
    await h.w.advance(2000);
    const reply = h.reply('reply-1');
    await flush();
    assert.equal(h.requests[0].at, reply.opened, 'requested at once');
    await h.w.advance(300); h.synthesize(0); await flush();
    await h.w.advance(1000);
    assert.equal(await reply.outcome, 'ended');
    // Measured on the code before this fix: heard 2402 ms after the send (300 ms network + 100 ms lead).
    assert.equal(h.audibleSince(sent)! - sent, 2402);
    assert.equal(h.w.contexts.length, 1); assert.equal(h.w.contexts[0].closes, 0);
    assert.equal(h.audio.lastStartMs, 50);
    assert.equal(h.listening, 0, 'nothing left watching the window');
  }
  // Cold and slow (8 s): still waited for, never cut by the bound; synthesis runs in parallel.
  {
    const h = harness(t, { deviceStartMs: 8000 });
    const reply = h.reply('reply-1');
    await flush();
    assert.equal(h.requests[0].at, reply.opened, 'the paid request does not wait for the device');
    await h.w.advance(300); h.synthesize(0); await flush();
    await h.w.advance(9000);
    assert.equal(await reply.outcome, 'ended');
    // Measured on the code before this fix: heard 8102 ms after the reply opened.
    assert.equal(h.audibleSince(reply.opened)! - reply.opened, 8102);
    assert.equal(h.w.contexts.length, 1); assert.equal(h.w.contexts[0].closes, 0);
    assert.deepEqual(h.errors, []);
  }
});
