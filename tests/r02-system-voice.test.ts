import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment } from '../shared/tts';
import { CANCEL_SETTLE_MS, NO_PROGRESS_MS, QUICK_END_MS, SpeechOutput, type SystemSpeechEvent } from '../src/ui/speech';
import { VoiceOutput } from '../src/ui/VoiceOutput';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { flush } from './helpers/r02-audio-world';
import { engine } from './helpers/r02-speech-engine';

/*
 * R02 goal 3: "the mouth moves but there is no sound" with the system voice.
 * Suspects: each segment did cancel() and then speak() at once, and lip-sync
 * trusted the start event alone. Segments of one reply now play back to back
 * without cancel(), and the mouth closes when the engine makes no progress.
 */
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };

test('R02 system voice: back-to-back utterances are never cancelled; an interruption cancels and waits before speaking', async t => {
  const e = engine(t);
  const output = new SpeechOutput(() => {}, { timers: e.timers, now: e.now });
  const first = output.speak('第一句。', voice);
  e.start(e.queued[0]); e.end(e.queued[0]); await first;
  void output.speak('第二句。', voice);
  assert.deepEqual(e.log, ['speak:第一句。@0', 'speak:第二句。@0'], 'the next segment is spoken at once, without cancel()');
  e.start(e.queued[1]);
  void output.speak('打断。', voice);
  assert.equal(e.log.at(-1), 'cancel@0', 'interrupting an owned utterance cancels it');
  assert.equal(e.queued.length, 2, 'but the replacement is not spoken in the same task as cancel()');
  await e.advance(CANCEL_SETTLE_MS);
  assert.equal(e.log.at(-1), `speak:打断。@${CANCEL_SETTLE_MS}`);
  output.stop();
});

test('R02 system voice: an engine that stops making progress closes the mouth, and progress reopens it', async t => {
  const e = engine(t);
  const mouth: boolean[] = [], events: SystemSpeechEvent[] = [];
  const output = new SpeechOutput(() => {}, { timers: e.timers, now: e.now, onMouth: value => mouth.push(value), onEvent: event => events.push(event) });
  void output.speak('一段比较长的回复。', voice);
  const utterance = e.queued[0];
  e.start(utterance);
  e.synth.speaking = false; // "started", but the engine says nothing is playing
  await e.advance(1000);
  assert.deepEqual(mouth, [false], 'the mouth closes while the engine reports no speech');
  assert.ok(events.some(event => event.type === 'stall' && event.reason === 'not-speaking'));
  e.synth.speaking = true; utterance.onboundary?.();
  assert.deepEqual(mouth, [false, true], 'a word boundary is real progress: the mouth reopens');
  assert.equal(events.filter(event => event.type === 'first-boundary').length, 1);
  await e.advance(NO_PROGRESS_MS + 500);
  assert.deepEqual(mouth, [false, true, false], 'with boundaries known to work, a long silence without one closes the mouth');
  assert.ok(events.some(event => event.type === 'stall' && event.reason === 'no-progress'));
  output.stop();
});

test('R02 system voice: an utterance that ends at once or errors is recorded without its text', async t => {
  const e = engine(t);
  const events: SystemSpeechEvent[] = [];
  const output = new SpeechOutput(() => {}, { timers: e.timers, now: e.now, onEvent: event => events.push(event) });
  const quick = output.speak('这句话其实没有声音。', voice);
  e.start(e.queued[0]); await e.advance(QUICK_END_MS - 100); e.end(e.queued[0]); await quick;
  assert.deepEqual(events.map(event => event.type), ['queued', 'start', 'quick-end', 'end']);
  const failed = output.speak('失败。', voice);
  e.queued[1].onerror?.({ error: 'synthesis-failed' });
  await assert.rejects(failed, /系统语音播放失败/);
  assert.deepEqual(events.at(-1), { type: 'error', at: e.now(), code: 'synthesis-failed' });
  assert.ok(!JSON.stringify(events).includes('声音'), 'events never carry the spoken text');
});

test('R02 system voice: a reply speaks its segments back to back and prepares the next one while the current plays', async t => {
  const e = engine(t);
  const speaking: boolean[] = [], asked: (number | undefined)[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() { throw Error('no cloud request for the system voice'); }, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: value => speaking.push(value), onError: message => assert.fail(message),
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const pieces = ['第一句。', '第二句。', '第三句。'].map((text, index): ApprovedReplySpeechSegment =>
    Object.freeze({ replyId: 'r', index, text, visibleText: text, context: Object.freeze({ replyId: 'r', segmentIndex: index }) }));
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completedIndex) { asked.push(completedIndex); return pieces[completedIndex === undefined ? 0 : completedIndex + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('the reply uses one playback owner'), () => true, id => output.openReply(voice, id));
  const done = queue.speak('r');
  await flush();
  assert.equal(e.queued.length, 1);
  e.start(e.queued[0]); await flush();
  assert.deepEqual(asked, [undefined, 0], 'segment 2 is asked for while segment 1 is still playing');
  assert.equal(e.queued.length, 1, 'but it is not spoken over segment 1');
  e.end(e.queued[0]); await flush();
  assert.equal(e.queued.length, 2, 'segment 2 is spoken right after segment 1 ends');
  e.start(e.queued[1]); await flush(); e.end(e.queued[1]); await flush();
  e.start(e.queued[2]); await flush(); e.end(e.queued[2]); await done;
  assert.deepEqual(e.queued.map(item => item.text), ['第一句。', '第二句。', '第三句。']);
  assert.ok(!e.log.some(entry => entry.startsWith('cancel')), 'no cancel() between the segments of one reply');
  assert.equal(speaking.at(-1), false);
});

test('R02 system voice: a stall closes the mouth without ending the reply; cancelling never starts the waiting segment', async t => {
  const e = engine(t);
  const speaking: boolean[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() {}, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: value => speaking.push(value), onError: () => {},
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const reply = output.openReply(voice, 'r')!;
  const first = reply.append('第一句。', { replyId: 'r', segmentIndex: 0 });
  await flush();
  e.start(e.queued[0]); assert.equal(await first, true, 'ready for the next segment once this one started');
  e.synth.speaking = false; await e.advance(1000);
  assert.equal(speaking.at(-1), false, 'stalled engine: the mouth is closed');
  e.synth.speaking = true; e.queued[0].onboundary?.();
  assert.equal(speaking.at(-1), true, 'progress reopens it; the reply is still playing');
  const second = reply.append('第二句。', { replyId: 'r', segmentIndex: 1 });
  reply.cancel(); await flush();
  assert.equal(await second, false, 'the queue is told to stop');
  e.end(e.queued[0]); await e.advance(CANCEL_SETTLE_MS + 10);
  assert.deepEqual(e.queued.map(item => item.text), ['第一句。'], 'the cancelled reply never speaks its waiting segment');
  assert.equal(speaking.at(-1), false);
});
