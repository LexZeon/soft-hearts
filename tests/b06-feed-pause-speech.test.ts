import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { validateSpeechDiagnosticRecord, type SpeechDiagnosticRecord } from '../shared/speech-diagnostics';
import { PAUSE_FADE_S, StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { FEED_MAX_PAUSE_MS, FEED_RESUME_DELAY_MS, FeedSpeechPause, feedHoldsMouth } from '../src/ui/feed-speech-pause';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { CANCEL_SETTLE_MS, PAUSE_CONFIRM_MS, RESUME_CONFIRM_MS, SpeechOutput, type SystemSpeechEvent } from '../src/ui/speech';
import { flush, pcm } from './helpers/r02-audio-world';
import { pausableEngine, pauseAudioWorld, type PlayedSpan } from './helpers/feed-pause-audio';

/*
 * B06 × R02 A snack at her mouth pauses speech and
 * the paced bubble; after the bite she continues from where she stopped.
 */
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
const feed = (near: number, prepared = false) => ({ feeding: true, prepared, near });
function segment(replyId: string, index: number, text: string): ApprovedReplySpeechSegment {
  return Object.freeze({ replyId, index, text, visibleText: text, context: Object.freeze({ replyId, segmentIndex: index }) });
}
/** Every buffer was heard exactly once, front to back: no sample skipped, none twice. */
function assertContinuous(spans: PlayedSpan[]) {
  const byBuffer = new Map<number, PlayedSpan[]>();
  for (const span of spans) byBuffer.set(span.buffer, [...(byBuffer.get(span.buffer) ?? []), span]);
  for (const [buffer, parts] of byBuffer) {
    let position = 0;
    for (const part of parts.sort((a, b) => a.at - b.at)) {
      assert.ok(Math.abs(part.from - position) < 1e-6, `buffer ${buffer} continues at ${position.toFixed(4)} s, not ${part.from.toFixed(4)} s`);
      position = part.to;
    }
    assert.ok(Math.abs(position - 0.2) < 1e-6, `buffer ${buffer} played to its end`);
  }
}

test('B06 trigger: only a snack inside the mouth radius, prepared or being eaten holds speech', () => {
  assert.equal(feedHoldsMouth(feed(0.6)), false, 'approaching the mouth does not pause her');
  assert.equal(feedHoldsMouth(feed(1)), true, 'at the mouth (the B06 preparation zone)');
  assert.equal(feedHoldsMouth(feed(0, true)), true, 'prepared / accepted bite (accepted feedback carries no proximity)');
  assert.equal(feedHoldsMouth({ feeding: false, prepared: false, near: 1 }), false);
  assert.equal(feedHoldsMouth(null), false);
});

function controller(t: TestContext) {
  const e = pausableEngine(t);
  const calls: string[] = [], sent: unknown[] = [];
  const pause = new FeedSpeechPause({ targets: [{ pause: () => calls.push(`pause@${e.now()}`), resume: () => calls.push(`resume@${e.now()}`) }],
    broadcast: message => sent.push(message), timers: e.timers, now: e.now });
  return { e, calls, sent, pause };
}

test('B06 hold: pauses at the mouth, resumes ~0.4 s after the bite, and a snack back at the mouth inside that beat keeps it paused', async t => {
  const { e, calls, sent, pause } = controller(t);
  pause.feedback(feed(0.5)); pause.feedback(feed(1)); pause.feedback(feed(1)); pause.feedback(feed(1, true));
  assert.deepEqual(calls, ['pause@0']);
  assert.deepEqual(sent, [{ paused: true }], 'only decisions cross to the other window');
  await e.advance(900);
  pause.feedback({ feeding: false, prepared: false, near: 0 }); // the accepted bite ended
  await e.advance(FEED_RESUME_DELAY_MS - 1);
  assert.deepEqual(calls, ['pause@0']);
  await e.advance(1);
  assert.deepEqual(calls, ['pause@0', `resume@${900 + FEED_RESUME_DELAY_MS}`]);
  pause.feedback(feed(1)); await e.advance(100); pause.feedback(feed(0.2)); await e.advance(200); pause.feedback(feed(1));
  await e.advance(2000);
  assert.equal(calls.length, 3, 'leaving and returning within the beat is one pause');
  pause.feedback(feed(0.2)); await e.advance(FEED_RESUME_DELAY_MS);
  assert.equal(calls.at(-1), `resume@${e.now()}`);
  assert.deepEqual(sent, [{ paused: true }, { paused: false }, { paused: true }, { paused: false }]);
});

test('B06 hold: the other window follows the decisions, bounded even if the pet goes away; junk is ignored', async t => {
  const { e, calls, pause } = controller(t);
  pause.receive('true'); pause.receive({}); pause.receive({ paused: 'yes' });
  assert.deepEqual(calls, []);
  pause.receive({ paused: true }); pause.receive({ paused: true });
  assert.deepEqual(calls, ['pause@0']);
  pause.receive({ paused: false });
  assert.deepEqual(calls, ['pause@0', 'resume@0']);
  pause.receive(true); // a boolean from an older build
  await e.advance(FEED_MAX_PAUSE_MS + 1000);
  assert.deepEqual(calls.slice(2), ['pause@0', `resume@${FEED_MAX_PAUSE_MS + 1000}`], 'a pet that never says resume cannot hold speech forever');
});

test('B06 hold: never longer than the max pause, and no new pause until the snack has left once', async t => {
  const { e, calls, pause } = controller(t);
  pause.feedback(feed(1));
  await e.advance(FEED_MAX_PAUSE_MS - 1);
  assert.equal(pause.active, true);
  await e.advance(1);
  assert.deepEqual(calls, ['pause@0', `resume@${FEED_MAX_PAUSE_MS}`]);
  pause.feedback(feed(1, true)); pause.feedback({ feeding: true, prepared: true, accepted: true });
  await e.advance(5000);
  assert.equal(calls.length, 2, 'still at the mouth (even eating): she keeps talking');
  pause.feedback(feed(0.2)); pause.feedback(feed(1));
  assert.equal(calls.at(-1), `pause@${e.now()}`, 'a fresh approach pauses again');
  pause.reset();
  assert.equal(calls.at(-1), `resume@${e.now()}`);
});

function bailian(t: TestContext) {
  const w = pauseAudioWorld(t);
  let listener: ((event: VoiceOutputEvent) => void) | null = null, ids = 0;
  const requests: { id: string; text: string }[] = [], cancellations: string[] = [], speaking: boolean[] = [], errors: string[] = [];
  const records: SpeechDiagnosticRecord[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id, text) { requests.push({ id, text }); },
      async cancelSpeech(id) { cancellations.push(id); },
      async releaseSpeech() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
      async recordSpeechDiagnostic(record) { records.push(record); },
    },
    onSpeaking: value => speaking.push(value), onError: message => errors.push(message),
    createId: () => `req-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
    createSystem: () => ({ voices: () => [], speak: () => Promise.resolve(), stop() {} }),
  });
  const shown: ApprovedReplySpeechSegment[] = [];
  const waiters: (() => void)[] = [];
  let total = Infinity;
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_replyId: string, completedIndex?: number) {
      const index = completedIndex === undefined ? 0 : completedIndex + 1;
      while (index >= shown.length && index < total) await new Promise<void>(resolve => waiters.push(resolve));
      return index < shown.length && index < total ? shown[index] : null;
    },
    async cancelReplySpeech(replyId: string) { cancellations.push(`reply:${replyId}`); },
  }, async () => assert.fail('one playback owner'), () => true, replyId => output.openReply({ ...voice }, replyId));
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index].id, ...event } as VoiceOutputEvent);
  return {
    w, output, queue, requests, cancellations, speaking, errors, records,
    show(piece: ApprovedReplySpeechSegment) { shown.push(piece); waiters.splice(0).forEach(resolve => resolve()); },
    end(count: number) { total = count; waiters.splice(0).forEach(resolve => resolve()); },
    synthesize(index: number, chunks = 3) {
      for (let i = 0; i < chunks; i++) emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: 300 } : {}) });
      emit(index, { type: 'done', firstAudioMs: 300, audioBytes: chunks * 9600 });
    },
    sources: () => w.contexts.flatMap(context => context.sources),
  };
}

test('B06 Bailian: a feed pause fades out, holds the PCM and continues from the same sample; nothing is requested while paused', async t => {
  const h = bailian(t);
  h.show(segment('r', 0, '第一句。'));
  const done = h.queue.speak('r');
  let settled = 0; void done.then(() => settled++);
  await flush(); await h.w.advance(300); h.synthesize(0); await flush();
  h.show(segment('r', 1, '第二句。')); h.show(segment('r', 2, '第三句。'));
  await h.w.advance(350); // 0.25 s into segment 0 (0.6 s): inside its second chunk
  assert.equal(h.requests.length, 2, 'segment 1 was already being synthesized');
  assert.equal(h.speaking.at(-1), true);
  h.output.pause();
  assert.equal(h.speaking.at(-1), false, 'lip-sync stops with the voice');
  const context = h.w.contexts[0], gain = context.gains.at(-1)!.gain;
  const pausedAt = context.currentTime + PAUSE_FADE_S;
  const stopped = h.sources().filter(source => source.stopAt !== Infinity);
  assert.equal(stopped.length, 2, 'the sounding chunk and the queued one are taken off the output');
  for (const source of stopped) assert.equal(source.stopAt, Math.max(source.startAt, pausedAt), 'stopped exactly at the silence point (or before it ever starts)');
  assert.ok(Math.abs(gain.at(pausedAt)) < 1e-9, 'the gain has faded to silence exactly where the PCM stops (no click)');
  const before = h.sources().length;
  h.synthesize(1); await h.w.advance(4000);
  assert.equal(h.sources().length, before, 'PCM that arrives during the pause is not scheduled');
  assert.equal(h.requests.length, 2, 'no further segment is requested while she eats');
  assert.ok(!h.speaking.slice(-1)[0]);
  h.output.resume();
  const resumedAt = context.currentTime;
  await h.w.advance(1);
  const restarted = h.sources().slice(before, before + 2);
  assert.ok(restarted[0].offset > 0, 'the interrupted chunk restarts from its offset, not from the top');
  assert.ok(Math.abs(gain.at(restarted[0].startAt)) < 1e-9 && Math.abs(gain.at(restarted[0].startAt + PAUSE_FADE_S) - voice.volume) < 1e-9, 'and fades back in');
  assert.ok(restarted[0].startAt >= resumedAt);
  await h.w.advance(700);
  assert.equal(h.speaking.at(-1), true, 'the mouth reopens when the audio clock reaches the resumed sample');
  assert.equal(h.requests.length, 3, 'the next segment is requested again after the pause');
  h.synthesize(2); h.end(3); await h.w.advance(2500); await done;
  assertContinuous(h.w.played());
  assert.equal(settled, 1, 'the reply finishes once');
  assert.deepEqual(h.errors, []);
  const paused = h.records.filter(record => record.feedPauses);
  assert.equal(paused.length, 1, 'the heard segment records the pause');
  assert.ok(paused[0].feedPausedMs! >= 4000 && paused[0].feedPausedMs! < 4100);
  for (const record of h.records) assert.deepEqual(validateSpeechDiagnosticRecord(JSON.parse(JSON.stringify(record))), record);
});

test('B06 Bailian: cancel during a pause wins; late audio never revives, not even on resume', async t => {
  const h = bailian(t);
  h.show(segment('r', 0, '第一句。'));
  const done = h.queue.speak('r');
  await flush(); await h.w.advance(300); h.synthesize(0, 2); await flush(); await h.w.advance(250);
  h.output.pause();
  h.queue.cancel(); h.end(1); await flush(); await done;
  assert.ok(h.cancellations.includes('reply:r') && h.cancellations.includes(h.requests[0].id));
  const count = h.sources().length;
  h.synthesize(0, 2); h.output.resume(); await h.w.advance(1500);
  assert.equal(h.sources().length, count, 'nothing is scheduled after the cancel, and the held PCM is gone');
  assert.equal(h.speaking.at(-1), false);
  assert.deepEqual(h.errors, []);
});

test('B06 Bailian: a new message during a pause cancels the old reply and waits silently until the pause ends', async t => {
  const h = bailian(t);
  h.show(segment('r', 0, '旧回复。'));
  const old = h.queue.speak('r');
  await flush(); await h.w.advance(300); h.synthesize(0, 2); await flush(); await h.w.advance(250);
  h.output.pause();
  const fresh = h.output.speak('新消息。', voice);
  h.end(1); await flush(); await old;
  const oldSources = h.sources().length;
  assert.equal(h.requests.length, 1, 'the new playback sends no synthesis while paused');
  await h.w.advance(2000);
  h.output.resume(); await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].text, '新消息。');
  h.synthesize(1, 1); await h.w.advance(800); await fresh;
  const later = h.sources().slice(oldSources);
  assert.equal(later.length, 1, 'only the new message plays after the pause');
  assert.ok(later.every(source => source.offset === 0 && source.buffer!.id > h.sources()[oldSources - 1].buffer!.id), 'the old reply never plays again');
  assert.deepEqual(h.errors, []);
});

function systemOutput(t: TestContext, mode: Parameters<typeof pausableEngine>[1] = { pause: 'works' }) {
  const e = pausableEngine(t, mode);
  const mouth: boolean[] = [], speaking: boolean[] = [], events: SystemSpeechEvent[] = [];
  const output = new SpeechOutput(value => speaking.push(value), { timers: e.timers, now: e.now, onMouth: value => mouth.push(value), onEvent: event => events.push(event) });
  t.after(() => output.dispose());
  return { e, output, mouth, speaking, events };
}

test('B06 system voice: a working pause() holds the utterance; resume() continues it without cancel()', async t => {
  const { e, output, mouth, events } = systemOutput(t);
  let ended = 0;
  const speech = output.speak('今天我们去公园散步吧。', voice); void speech.then(() => ended++);
  const utterance = e.queued[0];
  e.start(utterance); e.boundary(utterance, 2);
  output.pause();
  assert.deepEqual(mouth, [false]);
  await e.advance(PAUSE_CONFIRM_MS + 1000);
  assert.ok(!e.log.some(item => item.startsWith('cancel')), 'a pause the engine acknowledged is kept');
  output.resume();
  await e.advance(60);
  assert.deepEqual(mouth, [false, true], 'the mouth reopens once the engine has resumed');
  e.end(utterance); await speech;
  assert.equal(ended, 1);
  assert.deepEqual(e.queued.map(item => item.text), ['今天我们去公园散步吧。'], 'nothing was re-spoken');
  assert.deepEqual(events.filter(event => event.type.startsWith('feed') || event.type === 'pause-fallback').map(event => event.type), ['feed-pause', 'feed-resume']);
});

test('B06 system voice: pause() that silently fails is detected; the rest is re-spoken from the last word boundary', async t => {
  const { e, output, mouth, events, speaking } = systemOutput(t, { pause: 'ignored' });
  let ended = 0;
  const text = '今天我们去公园散步吧。';
  const speech = output.speak(text, voice); void speech.then(() => ended++);
  const first = e.queued[0];
  e.start(first); e.boundary(first, 2); e.boundary(first, 4);
  output.pause();
  await e.advance(200); e.boundary(first, 6); // still talking: the pause did not take
  await e.advance(PAUSE_CONFIRM_MS);
  assert.equal(e.log.filter(item => item.startsWith('cancel')).length, 1, 'the fallback cancels so she really stops');
  assert.deepEqual(events.filter(event => event.type === 'pause-fallback'), [{ type: 'pause-fallback', at: PAUSE_CONFIRM_MS, reason: 'still-speaking' }]);
  first.onend?.(); // a late end/error of the cancelled utterance completes nothing
  first.onerror?.({ error: 'interrupted' });
  assert.equal(ended, 0);
  assert.equal(speaking.at(-1), true, 'the playback is still alive (only the mouth closed)');
  await e.advance(3000);
  assert.equal(e.queued.length, 1, 'nothing is spoken while paused');
  output.resume();
  await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), [text, text.slice(6)], 'continues at the word it had reached');
  e.start(e.queued[1]);
  assert.deepEqual(mouth, [false, true]);
  e.end(e.queued[1]); await speech;
  assert.equal(ended, 1, 'one completion for the whole utterance');
  assert.ok(!events.some(event => event.type === 'quick-end'));
});

test('B06 system voice: without boundary info the segment restarts; a not-yet-started utterance waits whole', async t => {
  const { e, output } = systemOutput(t, { pause: 'ignored' });
  const text = '没有词边界的引擎。';
  const speech = output.speak(text, voice);
  e.start(e.queued[0]);
  output.pause(); await e.advance(PAUSE_CONFIRM_MS);
  output.resume(); await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), [text, text], 'restarted from the top');
  e.start(e.queued[1]); e.end(e.queued[1]); await speech;
  const queuedOnly = output.speak('还没开口。', voice);
  await e.advance(CANCEL_SETTLE_MS);
  assert.equal(e.queued.length, 3);
  output.pause();
  assert.equal(e.log.at(-1), `cancel@${e.now()}`, 'taken back from the engine before it made a sound');
  output.resume(); await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.slice(3).map(item => item.text), ['还没开口。']);
  e.start(e.queued[3]); e.end(e.queued[3]); await queuedOnly;
});

test('B06 system voice: a resume() the engine ignores falls back to re-speaking from the last boundary', async t => {
  const { e, output, mouth } = systemOutput(t, { pause: 'works', resume: 'stuck' });
  const text = '暂停之后卡住的引擎。';
  const speech = output.speak(text, voice);
  e.start(e.queued[0]); e.boundary(e.queued[0], 4);
  output.pause(); await e.advance(PAUSE_CONFIRM_MS + 100);
  assert.equal(e.synth.paused, true);
  output.resume();
  await e.advance(RESUME_CONFIRM_MS - 10);
  assert.equal(e.queued.length, 1);
  await e.advance(10 + CANCEL_SETTLE_MS + 60);
  assert.equal(e.synth.paused, false, 'the stuck engine is unpaused before speaking again');
  assert.deepEqual(e.queued.map(item => item.text), [text, text.slice(4)]);
  e.start(e.queued[1]); e.end(e.queued[1]); await speech;
  assert.deepEqual(mouth, [false, true]);
});

test('B06 system voice: stop during a pause cancels for good; speech requested during a pause waits for resume', async t => {
  const { e, output } = systemOutput(t);
  const first = output.speak('被取消的话。', voice);
  e.start(e.queued[0]);
  output.pause(); await e.advance(PAUSE_CONFIRM_MS);
  output.stop(); await first;
  assert.equal(e.synth.paused, false, 'a cancelled paused engine is released so it cannot hold the next utterance');
  const next = output.speak('新的一句。', voice);
  await e.advance(2000);
  assert.equal(e.queued.length, 1, 'nothing is handed to the engine during the pause');
  output.resume(); await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), ['被取消的话。', '新的一句。'], 'the cancelled words never come back');
  e.start(e.queued[1]); e.end(e.queued[1]); await next;
});

test('B06 system voice reply: the next segment waits for the end of the pause and the reply finishes once', async t => {
  const e = pausableEngine(t);
  const records: SpeechDiagnosticRecord[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() { assert.fail('no cloud request'); }, async cancelSpeech() {}, onSpeechEvent: () => () => {},
      async recordSpeechDiagnostic(record) { records.push(record); } },
    onSpeaking: () => {}, onError: message => assert.fail(message), now: e.now,
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const pieces = ['第一句。', '第二句。'].map((text, index) => segment('r', index, text));
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completedIndex) { return pieces[completedIndex === undefined ? 0 : completedIndex + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('one owner'), () => true, id => output.openReply(voice, id));
  let settled = 0;
  const done = queue.speak('r').then(() => { settled++; });
  await flush(); e.start(e.queued[0]); await flush();
  e.end(e.queued[0]); output.pause(); // segment 1 had just finished as the snack arrived
  await e.advance(3000);
  assert.equal(e.queued.length, 1, 'segment 2 is not spoken while she eats');
  output.resume(); await e.advance(CANCEL_SETTLE_MS);
  assert.deepEqual(e.queued.map(item => item.text), ['第一句。', '第二句。']);
  e.start(e.queued[1]); e.end(e.queued[1]); await done;
  assert.equal(settled, 1);
  assert.ok(records.every(record => validateSpeechDiagnosticRecord(JSON.parse(JSON.stringify(record)))));
  const waited = records.find(record => record.segmentIndex === 1)!;
  assert.ok(waited.feedPauses === 1 && waited.feedPausedMs! >= 2900, 'the segment that waited records the pause');
});

test('B06 bubble: the paced reveal freezes, keeps the rest of its hold, and shows text that arrived meanwhile only after', () => {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    set: (callback: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear: (id: ReturnType<typeof setTimeout>) => { timers.delete(id as unknown as number); },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].callback();
    }
    now = target;
  };
  const state = new ReplyPresentationState(clock);
  const paints: { at: number; text: string }[] = [];
  state.begin('r');
  state.startReadout('r', prefix => paints.push({ at: now, text: prefix }));
  const body = '第一句很短。第二句也短。';
  state.readoutContent('r', body);
  assert.deepEqual(paints.map(paint => paint.text), ['第一句很短。']);
  const hold = 250 + 6 * 70; // the first sentence's reading hold
  advance(300);
  state.pause();
  advance(10_000);
  assert.equal(paints.length, 1, 'no advance to the next bubble while paused');
  const more = body + '第三句来了。';
  state.readoutContent('r', more);
  let drained = 0;
  state.finishReadout('r', () => drained++);
  advance(10_000);
  assert.equal(paints.length, 1, 'text arriving during the pause waits too');
  state.resume();
  advance(hold - 300 - 1);
  assert.equal(paints.length, 1, 'the first sentence keeps the rest of its hold');
  advance(1);
  assert.deepEqual(paints.map(paint => paint.text), ['第一句很短。', '第一句很短。第二句也短。']);
  advance(10_000);
  assert.equal(paints.at(-1)!.text, more);
  assert.equal(drained, 1, 'the reply still drains exactly once');
});
