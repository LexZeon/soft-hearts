// I-165: the reading window's voice tells her bubble when each reply sentence (the host's segment index) became audible, ended, or had
// nothing to say (src/voice/VoiceOutput.ts onSegmentHeard). The real VoiceOutput with the system-voice engine and the cloud player of
// the R02 tests (synthetic audio, fake clocks).
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment, type TtsConfig, type TtsStreamEvent } from '../shared/voice/tts';
import { SpeechOutput } from '../src/voice/speech';
import { StreamingVoicePlayer } from '../src/voice/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/voice/VoiceOutput';
import { SharedAudioOutput } from '../src/voice/audio-output';
import { CompletedReplySpeechQueue } from '../src/voice/completed-reply-speech-queue';
import { flush, pcm, world } from './helpers/r02-audio-world';
import { engine } from './helpers/r02-speech-engine';

const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
type Fact = { replyId: string; segmentIndex: number; phase: 'start' | 'end' | 'skip' };
const piece = (index: number, text: string): ApprovedReplySpeechSegment =>
  Object.freeze({ replyId: 'r', index, text, visibleText: text, context: Object.freeze({ replyId: 'r', segmentIndex: index }) });

test('system voice: each sentence says start when the engine starts it and end when it played out; a stage direction says skip', async t => {
  const e = engine(t), facts: Fact[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() { throw Error('no cloud'); }, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: () => {}, onError: message => assert.fail(message), onSegmentHeard: fact => facts.push(fact),
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const pieces = [piece(0, '第一句。'), piece(1, '（笑）'), piece(2, '第三句。')];
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completed) { return pieces[completed === undefined ? 0 : completed + 1] ?? null; }, async cancelReplySpeech() {},
  }, async () => assert.fail('one playback owner'), () => true, id => output.openReply(voice, id));
  const done = queue.speak('r'); await flush();
  assert.deepEqual(facts, [], 'nothing audible yet');
  e.start(e.queued[0]); await flush();
  assert.deepEqual(facts, [{ replyId: 'r', segmentIndex: 0, phase: 'start' }]);
  e.end(e.queued[0]); await flush();
  e.start(e.queued[1]); await flush(); e.end(e.queued[1]); await done;
  assert.deepEqual(facts, [
    { replyId: 'r', segmentIndex: 0, phase: 'start' }, { replyId: 'r', segmentIndex: 0, phase: 'end' },
    { replyId: 'r', segmentIndex: 1, phase: 'skip' },
    { replyId: 'r', segmentIndex: 2, phase: 'start' }, { replyId: 'r', segmentIndex: 2, phase: 'end' },
  ]);
  assert.deepEqual(e.queued.map(item => item.text), ['第一句。', '第三句。'], 'the stage direction was never spoken');
});

test('a preview or a reading outside a reply\'s sentence plan says nothing about sentences', async t => {
  const e = engine(t), facts: Fact[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() {}, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: () => {}, onError: () => {}, onSegmentHeard: fact => facts.push(fact),
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const whole = output.speak('整段一起读。', voice, { replyId: 'v1' }); e.start(e.queued[0]); e.end(e.queued[0]); await whole;
  const preview = output.preview('试听。'); e.start(e.queued[1]); e.end(e.queued[1]); await preview;
  assert.deepEqual(facts, []);
});

function cloud(t: TestContext) {
  const w = world(t), facts: Fact[] = [];
  let listener: ((event: VoiceOutputEvent) => void) | null = null, ids = 0;
  const requests: { id: string; text: string }[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: { async synthesizeSpeech(id, text) { requests.push({ id, text }); }, async cancelSpeech() {}, async releaseSpeech() {}, onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; } },
    onSpeaking: () => {}, onError: message => assert.fail(message), onSegmentHeard: fact => facts.push(fact),
    createId: () => `seg-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index].id, ...event } as VoiceOutputEvent);
  return { w, output, facts, requests,
    synthesize(index: number, chunks = 3) {
      for (let i = 0; i < chunks; i++) emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: 300 } : {}) });
      emit(index, { type: 'done', firstAudioMs: 300, audioBytes: chunks * 9600 });
    } };
}

test('cloud voice (one playback per reply): start at the sentence\'s first audible sample, end when it drained, the host\'s index even after a skipped stage direction', async t => {
  const h = cloud(t);
  const pieces = [piece(0, '第一句。'), piece(1, '（低头）'), piece(2, '第三句。')];
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completed) { return pieces[completed === undefined ? 0 : completed + 1] ?? null; }, async cancelReplySpeech() {},
  }, async () => assert.fail('one playback owner'), () => true, id => h.output.openReply(voice, id));
  const speaking = queue.speak('r'); await flush();
  await h.w.advance(300); h.synthesize(0); await flush();
  assert.equal(h.facts.length, 0, 'synthesized and scheduled, not audible yet');
  await h.w.advance(150);
  assert.deepEqual(h.facts[0], { replyId: 'r', segmentIndex: 0, phase: 'start' }, 'audible now');
  await flush();
  assert.ok(h.facts.some(fact => fact.segmentIndex === 1 && fact.phase === 'skip'), 'the stage direction is shown when its turn comes');
  await flush(); await h.w.advance(200); h.synthesize(1); await flush();
  await h.w.advance(700); // sentence 0 (0.6 s) drained, the next one starts
  const order = h.facts.map(fact => `${fact.segmentIndex}:${fact.phase}`);
  assert.deepEqual(order.slice(0, 3), ['0:start', '1:skip', '2:start'], 'the host\'s indexes: the third sentence is 2, not the player\'s 1');
  assert.ok(order.includes('0:end'), 'sentence 0\'s end is told too (gapless playback may report it just after the next start)');
  await h.w.advance(1500); await speaking;
  assert.equal(h.facts.at(-1)?.phase, 'end');
  assert.deepEqual(h.requests.map(request => request.text), ['第一句。', '第三句。']);
});
