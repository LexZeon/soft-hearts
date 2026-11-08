import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaInput } from '../src/ui/MediaInput';
import { MicrophoneInput } from '../src/ui/MicrophoneInput';
import { AudioCaptureHost } from '../electron/audio-capture-host';
import { MediaRuntime } from '../electron/runtime';
import { VoiceInputPipeline } from '../electron/voice-input-pipeline';
import type { VoicePcmReceipt, VoicePcmSubmission } from '../shared/voice-segments';
import type { VoiceTextCompletion, VoiceTextSettlement } from '../electron/voice-text-continuation';
import { setUiLanguage } from '../shared/ui-language';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const receipt = (seq: number): VoicePcmReceipt => ({ state: 'queued', groupId: 'group', segmentId: 'segment-' + seq, captureSeq: seq });
async function fixture(run: (value: { media: MediaInput; feed(samples: Float32Array): void; timers: Map<number, () => void>;
  signals: string[]; submissions: number[]; errors: string[]; statuses: string[]; setSubmit(fn: (seq: number) => Promise<VoicePcmReceipt>): void; stopped(): boolean }) => Promise<void>, allowStart = true, pipeline?: VoiceInputPipeline, extra: { pushToTalk?: boolean } = {}) {
  const names = ['window', 'navigator', 'AudioContext', 'setTimeout', 'clearTimeout'] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const timers = new Map<number, () => void>(), signals: string[] = [], submissions: number[] = [], errors: string[] = [], statuses: string[] = [];
  let timerSeq = 0, stopped = false, submit: (seq: number) => Promise<VoicePcmReceipt> = async seq => receipt(seq);
  const node = () => ({ connect() {}, disconnect() {} });
  let processor: { onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null };
  const track = { stop() { stopped = true; }, addEventListener() {}, removeEventListener() {} };
  let media!: MediaInput, microphone!: MicrophoneInput, hostRuntime!: MediaRuntime;
  let microphoneWork: Promise<void> = Promise.resolve();
  // These ports model only IPC transport. Ownership, acquisition, PCM and release
  // run through the same actual host/runtime/microphone classes as the app.
  const disableVoice = () => {
    if (!hostRuntime.state.voiceInput) return;
    const state = hostRuntime.update({ voiceInput: false }, 'controls');
    void media.applyRuntime(state);
  };
  const captureHost = new AudioCaptureHost({ available: owner => owner === 'controls',
    publish: state => { microphoneWork = microphone.apply(state.slots.microphone); },
    lost: () => disableVoice() });
  hostRuntime = new MediaRuntime(state => { captureHost.setChat(state.voiceInput ? state.voiceOwner : null); });
  class AudioFixture {
    sampleRate = 16000; state = 'running'; destination = {};
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { processor = { ...node(), onaudioprocess: null }; return processor; }
    createGain() { return { ...node(), gain: { value: 0 } }; }
    async resume() {} async close() { this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop: {
    openVoiceCapture: async () => {
      signals.push('open');
      // MediaInput's real canStartVoice gate precedes this successful host open.
      // A rejected draft gate therefore never mints a descriptor or acquires media.
      hostRuntime.update({ voiceInput: true }, 'controls', owner => captureHost.selectChatOwner(owner));
      return pipeline?.open(1, 'epoch') ?? { captureSessionId: 'capture', epoch: 'epoch' };
    },
    signalVoiceCapture: async (id: string, signal: string) => {
      signals.push(signal);
      if (signal === 'cancel') { pipeline?.cancel(1, id, 'voice-off'); disableVoice(); return true; }
      if (pipeline && signal === 'endpoint') return pipeline.endpoint(1, id);
      if (pipeline && signal === 'speech-start') return pipeline.speechStarted(1, id);
      if (pipeline && signal === 'finish-speaking') return pipeline.finishSpeaking(1, id);
      return true;
    },
    submitVoicePcm: async (value: VoicePcmSubmission) => {
      assert.ok(value.wav.byteLength <= 480044); submissions.push(value.captureSeq); signals.push('submit-' + value.captureSeq); return pipeline?.submit(1, value) ?? submit(value.captureSeq);
    },
  } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (options: unknown) => {
    assert.deepEqual(options, { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    return { getTracks: () => [track] };
  } } } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: AudioFixture });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void, ms: number) => {
    assert.equal(ms, 1500); const id = ++timerSeq; timers.set(id, fn); return id;
  } });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id); } });
  media = new MediaInput({ windowKind: 'controls', pushToTalk: extra.pushToTalk, onTranscript: () => { throw Error('legacy auto-chat must not run'); },
    canStartVoice: () => allowStart,
    onVoiceStatus: message => statuses.push(message),
    onError: message => { errors.push(message); disableVoice(); } });
  microphone = new MicrophoneInput({ owner: 'controls',
    acknowledge: async value => captureHost.ack('controls', value),
    onPcm: (samples, rate) => media.pushVoicePcm(samples, rate),
    onReady: ready => media.microphoneReady(ready),
    onError: message => { errors.push(message); disableVoice(); } });
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', cameraSharing: false, cameraOwner: null, screenSharing: false });
    await microphoneWork;
    await run({ media, feed: samples => processor.onaudioprocess!({ inputBuffer: { getChannelData: () => samples } }),
      timers, signals, submissions, errors, statuses, setSubmit: fn => { submit = fn; }, stopped: () => stopped });
  } finally {
    media.dispose(); hostRuntime.reset(); captureHost.clear(); await microphone.dispose(); await tick();
    for (const name of names) { const descriptor = descriptors.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
const voice = () => new Float32Array(4800).fill(0.1), silence = () => new Float32Array(11200);

test('new speech while the endpoint waits for PCM acknowledgement invalidates that old endpoint', async () => {
  await fixture(async ({ feed, timers, signals, setSubmit }) => {
    const held = deferred<VoicePcmReceipt>(); setSubmit(() => held.promise);
    feed(voice()); feed(silence()); assert.equal(timers.size, 1);
    const timer = [...timers.values()][0]; timers.clear(); timer(); await tick();
    feed(voice()); held.resolve(receipt(1)); await tick(); await tick();
    assert.equal(signals.includes('endpoint'), false); assert.equal(signals.filter(value => value === 'speech-start').length, 2);
  });
});
test('finish marker flushes current speech and precedes later PCM while the first submit is still pending', async () => {
  await fixture(async ({ media, feed, signals, submissions, setSubmit }) => {
    const held = deferred<VoicePcmReceipt>(); setSubmit(seq => seq === 1 ? held.promise : Promise.resolve(receipt(seq)));
    feed(voice()); const finishing = media.finishSpeaking();
    feed(voice()); feed(silence()); assert.deepEqual(submissions, [1]);
    held.resolve(receipt(1)); await finishing; await tick();
    assert.deepEqual(signals.filter(value => value.startsWith('submit-') || value === 'finish-speaking'), ['submit-1', 'finish-speaking', 'submit-2']);
  });
});
test('rejected or overflowing PCM pauses capture once without retrying the same submission', async () => {
  await fixture(async ({ feed, submissions, errors, stopped, setSubmit }) => {
    setSubmit(async () => ({ state: 'rejected', reason: 'unavailable' }));
    feed(voice()); feed(silence()); await tick(); await tick();
    assert.deepEqual(submissions, [1]); assert.equal(errors.length, 1); assert.equal(stopped(), true);
  });
  await fixture(async ({ feed, submissions, errors, stopped, setSubmit }) => {
    const held = deferred<VoicePcmReceipt>(); setSubmit(() => held.promise);
    for (let count = 0; count < 4; count++) { feed(voice()); feed(silence()); }
    assert.deepEqual(submissions, [1]); assert.equal(errors.length, 1); assert.match(errors[0], /队列已满/); assert.equal(stopped(), true);
    held.resolve(receipt(1)); await tick(); assert.deepEqual(submissions, [1]);
  });
});

test('unhandled visible voice originals gate a new capture before IPC or microphone acquisition', async () => {
  await fixture(async ({ signals, errors, stopped }) => {
    assert.deepEqual(signals, []); assert.equal(stopped(), false);
    assert.equal(errors.length, 1); assert.match(errors[0], /草稿/);
  }, false);
});

test('automatic pause endpoint drains accepted PCM and seals one actual host group without manual talk actions', async () => {
  const completed = deferred<VoiceTextCompletion>(), rows: string[] = [], settlements: VoiceTextSettlement[] = [];
  let through = 0, requests = 0;
  const pipeline = new VoiceInputPipeline({ transcribe: async () => '自动停顿的合成语音',
    dispatch: leg => { requests++; through = leg.throughSeq; return completed.promise; },
    userRow: value => { rows.push(value.canonicalUserText); return undefined; }, reply() {},
    settlement: value => { settlements.push(value); return undefined; }, stopTts() {}, cancelled() {}, fault() {}, rejectedDraft() {},
  });
  try { await fixture(async ({ feed, timers, signals, errors }) => {
    feed(voice()); feed(silence()); await tick(); await tick();
    assert.equal(requests, 1); assert.equal(timers.size, 1); assert.equal(settlements.length, 0);
    const endpoint = [...timers.values()][0]; timers.clear(); endpoint(); await tick();
    completed.resolve({ status: 'complete', coveredThroughSeq: through, hasAppraisal: false }); await tick(); await tick();
    assert.deepEqual(rows, ['自动停顿的合成语音']); assert.equal(settlements.length, 1); assert.equal(settlements[0].status, 'complete');
    assert.equal(signals.filter(value => value === 'endpoint').length, 1); assert.equal(signals.includes('finish-speaking'), false);
    assert.deepEqual(errors, []);
  }, true, pipeline); } finally { pipeline.dispose(); }
});

test('microphone off cancels an in-flight synthetic recognizer without converting off into a seal or late user row', async () => {
  const recognized = deferred<string>(), rows: string[] = [], settlements: VoiceTextSettlement[] = [];
  const pipeline = new VoiceInputPipeline({ transcribe: () => recognized.promise,
    dispatch: async () => { assert.fail('cancelled original must not dispatch'); },
    userRow: value => { rows.push(value.canonicalUserText); return undefined; }, reply() {},
    settlement: value => { settlements.push(value); return undefined; }, stopTts() {}, cancelled() {}, fault() {}, rejectedDraft() {},
  });
  try { await fixture(async ({ media, feed, timers, signals }) => {
    feed(voice()); feed(silence()); await tick();
    await media.applyRuntime({ voiceInput: false, voiceOwner: null, cameraSharing: false, cameraOwner: null, screenSharing: false });
    recognized.resolve('取消后的迟到原文'); await tick(); await tick();
    assert.equal(timers.size, 0); assert.equal(signals.includes('cancel'), true);
    assert.equal(signals.includes('endpoint'), false); assert.equal(signals.includes('finish-speaking'), false);
    assert.deepEqual(rows, []); assert.deepEqual(settlements, []);
  }, true, pipeline); } finally { recognized.resolve('cleanup'); pipeline.dispose(); }
});

test('actual microphone voice status uses English while presentation refresh never opens or submits capture', async () => {
  try {
    setUiLanguage('en'); await fixture(async ({ media, feed, statuses, signals, submissions }) => {
      assert.ok(statuses.some(value => /Opening the microphone/.test(value))); assert.match(statuses.at(-1)!, /Listening/);
      feed(voice()); await tick(); assert.match(statuses.at(-1)!, /Speech detected/);
      const before = [...signals]; setUiLanguage('zh-CN'); media.refreshVoiceStatus(); assert.match(statuses.at(-1)!, /检测到声音/);
      assert.deepEqual(signals, before); assert.deepEqual(submissions, []);
    });
  } finally { setUiLanguage('zh-CN'); }
});

test('hold T to talk: without T the microphone is thrown away; held, all of it is sent when T comes up (no pause wait); a tap sends nothing', async () => {
  const realNow = performance.now.bind(performance); let offset = 0;
  performance.now = () => realNow() + offset;
  try { await fixture(async ({ media, feed, timers, signals, submissions, statuses, errors }) => {
    assert.equal(media.canHoldToTalk, true);
    feed(voice()); feed(voice()); feed(silence()); await tick(); await tick();
    assert.deepEqual(submissions, [], 'nothing is sent without T');
    assert.equal(signals.includes('speech-start'), false, 'and she is not told anyone talked');
    assert.match(statuses.at(-1) ?? '', /按住 T/);
    media.holdToTalk(); offset += 300;
    feed(voice()); feed(silence()); feed(silence()); feed(voice()); await tick(); await tick();
    assert.ok(signals.includes('speech-start'), 'held past the tap length: she is told');
    assert.deepEqual(submissions, [], 'a pause does not end it while T is held');
    assert.match(statuses.at(-1) ?? '', /松开 T/);
    media.releaseToTalk(true); await tick(); await tick(); await tick(); await tick();
    assert.equal(submissions.length, 1, 'one piece with everything said');
    assert.equal(signals.at(-1), 'endpoint', 'and it is sent at once');
    assert.equal(timers.size, 0, 'no pause timer');
    const before = signals.length;
    media.holdToTalk(); feed(voice()); media.releaseToTalk(false); await tick(); await tick();
    assert.equal(submissions.length, 1, 'a tap sends nothing');
    assert.deepEqual(signals.slice(before), [], 'and says nothing');
    assert.deepEqual(errors, []);
  }, true, undefined, { pushToTalk: true }); } finally { performance.now = realNow; }
});
