// C: turning the microphone on while she
// reads lets the sentence being heard finish, reads nothing more of that reply (its bubbles still show), then she listens.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { CompletedReplySpeechQueue, type ReplySpeechSession } from '../src/ui/completed-reply-speech-queue';
import { flush, pcm, world } from './helpers/r02-audio-world';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { DEFAULT_SETTINGS as SETTINGS } from '../shared/defaults';
import type { MediaOwner } from '../electron/runtime';
import { MediaInput } from '../src/ui/MediaInput';
import { VOICE_OPEN_AFTER_REPLY } from '../shared/voice-segments';

const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
const segment = (replyId: string, index: number, text: string): ApprovedReplySpeechSegment =>
  Object.freeze({ replyId, index, text, visibleText: text, context: Object.freeze({ replyId, segmentIndex: index }) });

function bailian(t: TestContext) {
  const w = world(t);
  let listener: ((event: VoiceOutputEvent) => void) | null = null, ids = 0;
  const requests: { id: string; text: string }[] = [], cancellations: string[] = [], speaking: boolean[] = [], errors: string[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id, text) { requests.push({ id, text }); },
      async cancelSpeech(id) { cancellations.push(id); }, async releaseSpeech() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
    },
    onSpeaking: value => speaking.push(value), onError: message => errors.push(message),
    createId: () => `seg-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  const shown: ApprovedReplySpeechSegment[] = [], asked: (number | undefined)[] = [];
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id: string, completedIndex?: number) {
      asked.push(completedIndex);
      const index = completedIndex === undefined ? 0 : completedIndex + 1;
      return shown[index] ?? null;
    },
    async cancelReplySpeech(id: string) { cancellations.push(`reply:${id}`); },
  }, async () => assert.fail('one playback owner'), () => true, id => output.openReply({ ...voice }, id));
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index].id, ...event } as VoiceOutputEvent);
  const synthesize = (index: number, chunks = 3) => {
    for (let i = 0; i < chunks; i++) emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: 300 } : {}) });
    emit(index, { type: 'done', firstAudioMs: 300, audioBytes: chunks * 9600 });
  };
  return { w, output, queue, requests, cancellations, speaking, errors, shown, asked, synthesize };
}

test('Bailian: the sentence being heard plays to its end; the next one, already being synthesized, is dropped', async t => {
  const h = bailian(t);
  h.shown.push(segment('r1', 0, '第一句。'), segment('r1', 1, '第二句。'), segment('r1', 2, '第三句。'));
  const speaking = h.queue.speak('r1');
  await flush(); await h.w.advance(300); h.synthesize(0); await flush();
  await h.w.advance(150); // sentence 0 (0.6 s) is audible, sentence 1 is being synthesized
  assert.equal(h.requests.length, 2);
  assert.equal(h.queue.finishCurrent('r1'), true);
  await flush();
  assert.ok(h.cancellations.includes(h.requests[1].id), 'the request for the next sentence is cancelled');
  h.synthesize(1); await flush(); // late audio of the dropped sentence
  await h.w.advance(300);
  assert.equal(h.speaking.at(-1), true, 'the first sentence is still being read: not cut mid-sentence');
  await h.w.advance(1500); await speaking;
  const sources = h.w.contexts[0].sources;
  assert.equal(sources.filter(source => source.startAt >= 0).length, 3, 'only the first sentence was ever scheduled');
  assert.equal(h.requests.length, 2, 'nothing after it is requested');
  assert.equal(h.speaking.at(-1), false);
  assert.deepEqual(h.errors, []);
  assert.equal(h.asked.length, 2, 'the queue asks the host for nothing more');
});

test('Bailian: a later sentence already queued behind the current one is never heard', async t => {
  const h = bailian(t);
  h.shown.push(segment('r2', 0, '一。'), segment('r2', 1, '二。'));
  const speaking = h.queue.speak('r2');
  await flush(); await h.w.advance(300); h.synthesize(0); await flush();
  await h.w.advance(150); h.synthesize(1); await flush(); // sentence 1's audio is scheduled right behind sentence 0
  const scheduled = h.w.contexts[0].sources.length;
  assert.equal(scheduled, 6);
  h.queue.finishCurrent('r2'); await flush();
  await h.w.advance(1200); await speaking;
  const later = h.w.contexts[0].sources.slice(3);
  assert.ok(later.every(source => source.stopped > 0 || source.startAt < 0), 'the second sentence is stopped at the boundary');
  assert.equal(h.speaking.at(-1), false);
});

test('Bailian: with nothing audible yet it stops at once', async t => {
  const h = bailian(t);
  h.shown.push(segment('r3', 0, '一。'));
  const speaking = h.queue.speak('r3');
  await flush();
  h.queue.finishCurrent('r3'); await flush(); await speaking;
  h.synthesize(0); await h.w.advance(1000);
  assert.ok(h.w.contexts.every(context => context.sources.every(source => source.startAt < 0)));
});

test('a reply that has not started reading is not read at all; the next reply reads normally', async () => {
  const played: string[] = [];
  const pieces: Record<string, ApprovedReplySpeechSegment[]> = { a: [segment('a', 0, 'A0。')], b: [segment('b', 0, 'B0。')] };
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(id: string, completed?: number) { return pieces[id][completed === undefined ? 0 : completed + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async piece => { played.push(piece.text); }, () => true);
  assert.equal(queue.finishCurrent('a'), false);
  await queue.speak('a');
  assert.deepEqual(played, []);
  await queue.speak('b');
  assert.deepEqual(played, ['B0。']);
});

test('system voice: the utterance being spoken ends by itself and no queued sentence is launched', async () => {
  const pieces = [segment('s', 0, '零。'), segment('s', 1, '一。'), segment('s', 2, '二。')];
  const launched: string[] = [];
  let finishCurrent = 0, endCurrent: () => void = () => {};
  const session: ReplySpeechSession = {
    append: text => new Promise(resolve => { launched.push(text); endCurrent = () => resolve(!finishCurrent); if (launched.length === 1) queueMicrotask(() => resolve(true)); }),
    close: async () => {}, cancel: () => assert.fail('never cancelled: the current sentence must finish'),
    finishCurrent: () => { finishCurrent++; },
  };
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id: string, completed?: number) { return pieces[completed === undefined ? 0 : completed + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('session owns playback'), () => true, () => session);
  const reading = queue.speak('s');
  await flush(); // sentence 0 started; sentence 1 handed over and waiting
  assert.deepEqual(launched, ['零。', '一。']);
  assert.equal(queue.finishCurrent('s'), true);
  assert.equal(finishCurrent, 1);
  endCurrent(); await reading;
  assert.deepEqual(launched, ['零。', '一。'], 'no third sentence is handed over');
});

test('system voice playback: queued sentences are not launched after finishCurrent', async t => {
  const w = world(t);
  const spoken: string[] = [];
  let end: () => void = () => {};
  const output = new VoiceOutput({
    getTtsConfig: () => DEFAULT_TTS_CONFIG, getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() {}, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: () => {}, onError: message => assert.fail(message), now: w.now,
    createSystem: callback => ({ voices: () => [], stop() {},
      speak: text => { spoken.push(text); callback(true); return new Promise<void>(resolve => { end = () => { callback(false); resolve(); }; }); } }),
  });
  t.after(() => output.dispose());
  const reply = output.openReply(voice, 'sys')!;
  const first = reply.append('零。', { replyId: 'sys', segmentIndex: 0 });
  await flush();
  const second = reply.append('一。', { replyId: 'sys', segmentIndex: 1 });
  reply.finishCurrent();
  assert.equal(await first, true);
  end(); await flush();
  assert.equal(await second, false);
  assert.deepEqual(spoken, ['零。'], 'only the sentence that was being spoken');
});

test('opening the microphone asks the reading window to finish its sentence, never to stop now', () => {
  const stops: (string | undefined)[] = [];
  const media = { voiceInput: true, voiceOwner: 'controls' as MediaOwner };
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => SETTINGS, companion: () => ({ beginVoiceGroup: async () => assert.fail() }) as never,
    ambient: () => null, reserveChat: () => true, releaseChat() {}, userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async () => assert.fail() } as never, languageProfile: () => null, chatDirectory: () => '.', tempDirectory: () => '.',
    transcribe: async () => '', stopReading: mode => { stops.push(mode); }, prepareSpeech() {},
  });
  host.open(5, 'controls');
  assert.ok(stops.length > 0);
  assert.ok(stops.every(mode => mode === 'sentence'), 'opening only ever finishes the sentence');
  stops.length = 0;
  host.revoke('stop-generation');
  assert.ok(stops.length > 0 && stops.every(mode => mode !== 'sentence'), 'stopping generation still stops reading at once');
});

test('voice input switched on while her reply is still being written waits for it instead of turning itself off', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let refusals = 2;
  const signals: string[] = [], errors: string[] = [], statuses: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop: {
    openVoiceCapture: async () => {
      if (refusals-- > 0) throw new Error(`Error invoking remote method 'desk:openVoiceCapture': Error: ${VOICE_OPEN_AFTER_REPLY}`);
      signals.push('open'); return { captureSessionId: 'capture', epoch: 'epoch' };
    },
    signalVoiceCapture: async (_id: string, signal: string) => { signals.push(signal); return true; },
  } } });
  const realTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout: unknown }).setTimeout = (callback: () => void) => realTimeout(callback, 0);
  try {
    const media = new MediaInput({ windowKind: 'controls', onTranscript() {}, onError: message => errors.push(message), onVoiceStatus: text => statuses.push(text) });
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', screenSharing: false, cameraSharing: false, cameraOwner: null });
    assert.deepEqual(errors, [], 'never turned off');
    assert.deepEqual(signals, ['open']);
    assert.ok(statuses.some(text => /说完|finishing/.test(text)), 'it says she is finishing first');
    media.dispose();
  } finally {
    (globalThis as { setTimeout: unknown }).setTimeout = realTimeout;
    if (saved) Object.defineProperty(globalThis, 'window', saved); else Reflect.deleteProperty(globalThis, 'window');
  }
});
