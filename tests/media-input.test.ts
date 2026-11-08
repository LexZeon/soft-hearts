import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import ts from "typescript";
import { VoiceSegmentRuntime } from "../electron/voice-segment-runtime";
import { voiceFaultEvent } from "../electron/voice-chat-host";
import { VoiceRoute } from "../electron/asr/voice-route";
import { AudioCaptureHost } from "../electron/audio-capture-host";
import { MediaRuntime } from "../electron/runtime";
import { MicrophoneInput } from "../src/ui/MicrophoneInput";
import type { AudioCaptureState } from "../shared/audio-capture";
import type { VoiceCaptureBinding } from "../shared/voice-segments";
import type { VoiceConversationEvent } from "../shared/voice-conversation";
import type { DesktopAPI } from "../shared/contracts";
import type { RuntimeState } from "../shared/contracts";
import { encodeWav, MediaInput, resamplePcm, VoiceSegmenter } from "../src/ui/MediaInput";

const off: RuntimeState = { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null };
const voice: RuntimeState = { ...off, voiceInput: true, voiceOwner: "pet" };
const camera: RuntimeState = { ...off, cameraSharing: true, cameraOwner: "pet" };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("PCM resampling preserves duration and WAV encodes bounded mono 16-bit audio", () => {
  const pcm = resamplePcm(new Float32Array(48000).fill(0.5), 48000);
  assert.equal(pcm.length, 16000);
  assert.equal(pcm[1000], 0.5);
  const wav = encodeWav(new Float32Array([-1, -0.5, 0, 0.5, 1, NaN]));
  const view = new DataView(wav), text = new TextDecoder("ascii");
  assert.equal(text.decode(wav.slice(0, 4)), "RIFF");
  assert.equal(text.decode(wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true)), [-32768, -16384, 0, 16384, 32767, 0]);
  assert.throws(() => encodeWav(new Float32Array(2_000_000)), /大小限制/);
});

test("voice segmentation rejects short noise, ends on silence and bounds long speech", () => {
  const segmenter = new VoiceSegmenter(), quiet = new Float32Array(1600), speech = new Float32Array(1600).fill(0.1);
  assert.equal(segmenter.push(speech, 16000), null);
  for (let index = 0; index < 7; index++) assert.equal(segmenter.push(quiet, 16000), null);
  for (let index = 0; index < 3; index++) segmenter.push(speech, 16000);
  let result: Float32Array | null = null;
  for (let index = 0; index < 7; index++) result = segmenter.push(quiet, 16000) ?? result;
  assert.equal(result?.length, 7200);
  for (let index = 0; index < 149; index++) assert.equal(segmenter.push(speech, 16000), null);
  assert.equal(segmenter.push(speech, 16000)?.length, 240000);
});

test("quiet speech is segmented while low microphone noise remains below the gate", () => {
  const segmenter = new VoiceSegmenter();
  for (let index = 0; index < 10; index++) assert.equal(segmenter.push(new Float32Array(1600).fill(0.004), 16000), null);
  for (let index = 0; index < 4; index++) assert.equal(segmenter.push(new Float32Array(1600).fill(0.012), 16000), null);
  let result: Float32Array | null = null;
  for (let index = 0; index < 7; index++) result = segmenter.push(new Float32Array(1600), 16000) ?? result;
  assert.ok(result && result.length > 6400);
});

// Execute the real host's sanitized recognizer boundary and fault publisher.
// Only recognizer results/devices are fixtures; queued receipts never await ASR.
const hostSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const hostAst = ts.createSourceFile('main.ts', hostSource, ts.ScriptTarget.Latest, true);
function hostCallback(variable: string, property: string): string {
  let callback: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(hostAst) === variable && node.initializer
      && ts.isNewExpression(node.initializer)) {
      const options = node.initializer.arguments?.[0];
      if (options && ts.isObjectLiteralExpression(options)) for (const member of options.properties)
        if (ts.isPropertyAssignment(member) && member.name.getText(hostAst) === property) callback = member.initializer.getText(hostAst);
    }
    ts.forEachChild(node, visit);
  };
  visit(hostAst); assert.ok(callback, `${variable}.${property} must remain an actual host callback`);
  return callback;
}
// The fault publisher lives in electron/voice-chat-host.ts (R33): its actual
// voiceFaultEvent is imported and run here, the host's capture is the fixture's.
// 识别方式 (2026-11-03): the host now routes through the real VoiceRoute; here it is set to the compatible address,
// whose recognizer is the fixture below.
const createHostBoundary = new Function('transcribeWav', 'voiceEvent', 'voiceFaultEvent', 'VoiceRoute', ts.transpileModule(`
  const store = { current: { voiceInput: { engine: 'compatible' } } }, DEFAULT_SETTINGS = { voiceInput: {} };
  const voiceRoute = new VoiceRoute({ config: () => store.current.voiceInput, local: () => null, compatible: transcribeWav, journal() {}, characterId: () => null });
  let voiceCapture;
  const voiceHost = { get capture() { return voiceCapture; } };
  const voiceCurrent = capture => voiceCapture === capture;
  const transcribe = ${hostCallback('foregroundAsr', 'transcribe')};
  const fault = value => { const capture = voiceHost.capture; if (capture) voiceEvent(capture, voiceFaultEvent(capture, value.stage)); return undefined; };
  return { transcribe, fault, open(capture) { voiceCapture = capture; }, close(capture) { if (voiceCapture === capture) voiceCapture = undefined; } };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText) as
  (transcribe: (config: unknown, wav: ArrayBuffer, signal: AbortSignal) => Promise<string>,
   event: (capture: { binding: VoiceCaptureBinding; owner: 'pet' }, payload: { type: 'fault'; message?: string }) => void,
   faultEvent: typeof voiceFaultEvent, route: typeof VoiceRoute) => {
    transcribe(wav: ArrayBuffer, signal: AbortSignal): Promise<string>;
    fault(value: { stage: string }): undefined;
    open(capture: object): void; close(capture: object): void;
  };

function environment(t: TestContext, options: { media?: Promise<MediaStream>; play?: Promise<void>; asr?: Promise<string>; publish?: Promise<void>; publications?: Promise<void>[]; cameraMode?: "local" | "share" } = {}) {
  const keys = ["window", "navigator", "document", "AudioContext", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout"];
  const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let acquisitions = 0, stops = 0, closes = 0, disconnects = 0, pauses = 0, clock = 10000;
  const constraints: MediaStreamConstraints[] = [], transcripts: string[] = [], errors: string[] = [], wavs: ArrayBuffer[] = [], frames: string[] = [], sampleIds: string[] = [];
  const cameraListeners = new Set<(id: string) => void>(), oldCameraListeners: ((id: string) => void)[] = [];
  const draws: { width: number; height: number }[] = [];
  const processors: { onaudioprocess: ((event: AudioProcessingEvent) => void) | null; connect(): void; disconnect(): void }[] = [];
  const contexts: { state: string; sampleRate: number; close(): Promise<void> }[] = [];
  const timers = new Map<number, () => void>(); let timerId = 0;
  const endedListeners = new Set<() => void>();
  const endTrack = () => { for (const listener of [...endedListeners]) listener(); };
  const track = {
    addEventListener: (type: string, listener: () => void) => { if (type === "ended") endedListeners.add(listener); },
    removeEventListener: (type: string, listener: () => void) => { if (type === "ended") endedListeners.delete(listener); },
    stop: () => { stops++; endTrack(); },
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const videos: { videoWidth: number; videoHeight: number; srcObject: MediaStream | null; muted: boolean; playsInline: boolean; play(): Promise<void>; pause(): void }[] = [];
  const canvases: { width: number; height: number; getContext(): object; toDataURL(): string }[] = [];
  const node = () => ({ connect: () => {}, disconnect: () => { disconnects++; } });
  class AudioMock {
    sampleRate = 16000; state = "running"; destination = {};
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { const processor = { ...node(), onaudioprocess: null }; processors.push(processor); return processor; }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; closes++; }
  }
  const voiceEvents: VoiceConversationEvent[] = [], voiceStarts: string[] = [], voiceSeals: object[] = [], voiceCancels: object[] = [];
  let capture: { owner: 'pet'; binding: VoiceCaptureBinding } | undefined, epoch = 0;
  let microphone!: MicrophoneInput, captureHost!: AudioCaptureHost, hostRuntime!: MediaRuntime;
  let microphoneWork: Promise<void> = Promise.resolve(), physicalReady = false;
  const captureListeners = new Set<(state: AudioCaptureState) => void>();
  const released = new Set<string>(), releaseWaiters = new Map<string, (() => void)[]>();
  const releaseObserved = (id: string) => {
    released.add(id); for (const resolve of releaseWaiters.get(id) ?? []) resolve(); releaseWaiters.delete(id);
  };
  const waitForRelease = (id: string) => released.has(id) ? Promise.resolve() : new Promise<void>(resolve => {
    const waiters = releaseWaiters.get(id) ?? []; waiters.push(resolve); releaseWaiters.set(id, waiters);
  });
  const disableFeature = (feature: 'voiceInput' | 'cameraSharing') => {
    if (!hostRuntime.state[feature]) return;
    const next = hostRuntime.update({ [feature]: false }, 'pet');
    void media.applyRuntime(next);
  };
  const usedResponses = new WeakSet<Promise<string>>();
  const boundary = createHostBoundary((_config, wav, signal) => {
    wavs.push(wav);
    const response = options.asr;
    if (!response) return Promise.resolve("你好");
    if (!usedResponses.has(response)) { usedResponses.add(response); return response; }
    // A second recognizer request has its own pending response. Reusing one
    // configured response Promise would fabricate a second successful final.
    return new Promise<string>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Capture cancelled', 'AbortError'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }, (scope, payload) => {
    const event: VoiceConversationEvent = { ...payload, owner: scope.owner, epoch: scope.binding.epoch };
    voiceEvents.push(event); media.receiveVoiceFault(event as Extract<VoiceConversationEvent, { type: 'fault' }>);
  }, voiceFaultEvent, VoiceRoute);
  const producer = new VoiceSegmentRuntime({
    transcribe: boundary.transcribe,
    final: value => { transcripts.push(value.text); },
    seal: value => { voiceSeals.push(value); },
    cancel: value => { voiceCancels.push(value); },
    fault: value => { boundary.fault({ stage: value.reason }); },
    speechStarted: () => { voiceStarts.push(capture!.binding.captureSessionId); },
  });
  const desktop = {
    transcribeAudio: async (_wav: ArrayBuffer): Promise<string> => { throw Error('Grouped capture must use submitVoicePcm.'); },
    openVoiceCapture: async () => {
      const binding = producer.open(1, `capture-${++epoch}`);
      capture = { owner: 'pet', binding }; boundary.open(capture); return binding;
    },
    submitVoicePcm: async value => producer.submit(1, value),
    signalVoiceCapture: async (id, signal) => {
      if (!capture || capture.binding.captureSessionId !== id) return false;
      if (signal === 'cancel') {
        const previous = capture; capture = undefined; boundary.close(previous); producer.cancel('voice-off');
        disableFeature('voiceInput'); return true;
      }
      return signal === 'speech-start' ? producer.speechStarted(1, id)
        : signal === 'endpoint' ? producer.endpoint(1, id) : producer.finishSpeaking(1, id);
    },
    onVoiceConversation: listener => {
      const receive = listener; // Typed subscription boundary is available to the app fixture.
      voiceListeners.add(receive); return () => { voiceListeners.delete(receive); };
    },
    onAudioCaptureState: listener => {
      captureListeners.add(listener); return () => { captureListeners.delete(listener); };
    },
    ackAudioCapture: async value => {
      const accepted = captureHost.ack('pet', value);
      if (accepted && value.source === 'microphone' && value.phase !== 'ready') releaseObserved(value.id);
      return accepted;
    },
    onCameraSample: (listener: (id: string) => void) => {
      cameraListeners.add(listener); oldCameraListeners.push(listener);
      return () => { cameraListeners.delete(listener); };
    },
    publishCameraSample: async (id: string, frame: string) => {
      sampleIds.push(id); frames.push(frame);
      await (options.publications?.shift() ?? options.publish);
    },
    // I-036 「发图片」: the small frame kept ready at the host (through the real MediaRuntime, which checks owner and size).
    publishCameraFrame: async (frame: string) => { glances.push(frame); hostRuntime.publishCamera('pet', frame); },
  } satisfies Pick<DesktopAPI, 'transcribeAudio' | 'openVoiceCapture' | 'submitVoicePcm' | 'signalVoiceCapture'
    | 'onVoiceConversation' | 'onAudioCaptureState' | 'ackAudioCapture' | 'onCameraSample' | 'publishCameraSample' | 'publishCameraFrame'>;
  const glances: string[] = [];
  const voiceListeners = new Set<(event: VoiceConversationEvent) => void>();
  const timeouts = new Map<number, () => void>();
  const globals: Record<string, unknown> = {
    window: { desktop },
    navigator: { mediaDevices: { getUserMedia: (constraint: MediaStreamConstraints) => {
      acquisitions++; constraints.push(constraint);
      // A fresh successful device request returns its own MediaStream identity;
      // pending-permission scenarios still resolve the original exposed stream.
      return options.media ?? Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream);
    } } },
    AudioContext: AudioMock,
    performance: { now: () => clock },
    setInterval: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearInterval: (id: number) => timers.delete(id),
    setTimeout: (callback: () => void) => { timeouts.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timeouts.delete(id),
    document: { createElement: (tag: string) => {
      if (tag === "video") { const video = { videoWidth: 1920, videoHeight: 1080, srcObject: null, muted: false, playsInline: false, play: () => options.play ?? Promise.resolve(), pause: () => { pauses++; } }; videos.push(video); return video; }
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (_video: unknown, _x: number, _y: number, width: number, height: number) => { draws.push({ width, height }); } }), toDataURL: () => "data:image/jpeg;base64,AA==" }; canvases.push(canvas); return canvas;
    } },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const media = new MediaInput({ windowKind: "pet", onTranscript: value => transcripts.push(value), onError: (error, feature) => {
    errors.push(`${feature}:${error}`); disableFeature(feature);
  } });
  microphone = new MicrophoneInput({ owner: 'pet', acknowledge: value => desktop.ackAudioCapture(value),
    onPcm: (samples, rate) => media.pushVoicePcm(samples, rate),
    onReady: value => { physicalReady = value; media.microphoneReady(value); },
    onError: error => { errors.push(`voiceInput:${error}`); },
  });
  captureHost = new AudioCaptureHost({ available: () => true,
    publish: state => { for (const listener of [...captureListeners]) listener(state); },
    lost: (source, owner) => { if (source === 'microphone' && hostRuntime.state.voiceOwner === owner) disableFeature('voiceInput'); },
  });
  hostRuntime = new MediaRuntime(state => { captureHost.setChat(state.voiceInput ? state.voiceOwner : null); },
    options.cameraMode ? { mode: () => options.cameraMode! } : undefined);
  const stopCaptureListener = desktop.onAudioCaptureState(state => {
    microphoneWork = microphone.apply(state.slots.microphone);
    void microphoneWork.catch(error => { errors.push(`voiceInput:${String(error)}`); });
  });
  // This driver is the explicit runtime/renderer boundary, not another media
  // implementation. Physical counts are still changed only by the original
  // getUserMedia/stream/context mocks and the real shared microphone class.
  const driver = {
    async applyRuntime(state: RuntimeState): Promise<void> {
      const before = captureHost.getState().slots.microphone, wasReady = physicalReady;
      const owner = state.voiceOwner ?? state.cameraOwner ?? 'pet';
      const next = hostRuntime.update({ voiceInput: state.voiceInput, cameraSharing: state.cameraSharing, screenSharing: state.screenSharing },
        owner, requested => captureHost.selectChatOwner(requested));
      await media.applyRuntime(next);
      if (next.voiceInput && next.voiceOwner === 'pet') await microphoneWork;
      else if (wasReady && before && captureHost.getState().slots.microphone?.id !== before.id) await waitForRelease(before.id);
      // An off transition never waits for an unresolved permission request.
    },
    setSpeaking: (value: boolean) => media.setSpeaking(value),
    receiveVoiceFault: (event: Extract<VoiceConversationEvent, { type: 'fault' }>) => media.receiveVoiceFault(event),
    dispose() { media.dispose(); hostRuntime.reset(); captureHost.clear(); void microphone.dispose().catch(error => { errors.push(`voiceInput:${String(error)}`); }); },
  };
  t.after(async () => {
    const before = captureHost.getState().slots.microphone, wasReady = physicalReady;
    driver.dispose(); producer.cancel("teardown"); timeouts.clear();
    if (wasReady && before) await waitForRelease(before.id);
    stopCaptureListener(); captureHost.dropOwner('pet'); captureHost.dropOwner('controls');
    for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const process = (speech: boolean, count: number) => {
    for (let index = 0; index < count; index++) processors.at(-1)?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(speech ? 0.1 : 0) } } as unknown as AudioProcessingEvent);
  };
  return { media: driver, captureHost, hostRuntime, voiceEvents, voiceStarts, voiceSeals, voiceCancels, stream, constraints, processors, contexts, videos, canvases, timers, transcripts, errors, wavs, frames, sampleIds, cameraListeners, oldCameraListeners, draws, endedListeners, endTrack,
    glances, timeouts, fireTimeouts: async () => { for (const [id, callback] of [...timeouts]) { timeouts.delete(id); callback(); } await flush(); },
    counts: () => ({ acquisitions, stops, closes, disconnects, pauses }), process,
    advance: (ms: number) => { clock += ms; }, tick: async (ms: number) => { clock += ms; for (const callback of timers.values()) callback(); await flush(); },
    sample: async (id: string) => { for (const listener of [...cameraListeners]) listener(id); await flush(); },
  };
}

test("off or other-window ownership never acquires either device", async t => {
  const env = environment(t);
  await env.media.applyRuntime(off);
  await env.media.applyRuntime({ ...voice, cameraSharing: true, voiceOwner: "controls", cameraOwner: "controls" });
  assert.equal(env.counts().acquisitions, 0);
});

test("late microphone acquisition after ownership removal immediately stops tracks", async t => {
  const pending = deferred<MediaStream>(), env = environment(t, { media: pending.promise });
  const start = env.media.applyRuntime(voice);
  await flush();
  await env.media.applyRuntime(off);
  pending.resolve(env.stream); await start;
  assert.equal(env.counts().stops, 1);
  assert.equal(env.contexts.length, 0);
  assert.equal(env.transcripts.length, 0);
});

test("one ASR request is allowed and a disabled microphone discards its late transcript", async t => {
  const pending = deferred<string>(), env = environment(t, { asr: pending.promise });
  await env.media.applyRuntime(voice);
  assert.equal(env.constraints[0].video, false);
  env.process(true, 3); env.process(false, 7);
  env.process(true, 3); env.process(false, 7);
  assert.equal(env.wavs.length, 1);
  assert.equal(new DataView(env.wavs[0]).getUint32(24, true), 16000);
  await env.media.applyRuntime(off);
  assert.equal(env.processors[0].onaudioprocess, null);
  assert.equal(env.counts().closes, 1);
  assert.equal(env.counts().stops, 1);
  pending.resolve("不得提交的旧转写"); await flush();
  assert.deepEqual(env.transcripts, []);
});

test("speech output clears partial utterances and VAD resumes after the playback tail", async t => {
  const env = environment(t);
  await env.media.applyRuntime(voice);
  env.process(true, 2);
  env.media.setSpeaking(true); env.process(true, 3); env.process(false, 7);
  assert.equal(env.wavs.length, 0);
  env.media.setSpeaking(false); env.advance(250);
  env.process(true, 1); env.process(false, 7);
  assert.equal(env.wavs.length, 0);
  env.process(true, 3); env.process(false, 7); await flush();
  assert.deepEqual(env.transcripts, ["你好"]);
});

// I-036 「发图片」 replaces "no polling timer or unsolicited frame on enable": a small frame is kept ready
// at the host so a message never waits for the camera; a clear JPEG is still taken only for a host request.
test("camera (「发图片」) keeps one small frame ready, takes a clear JPEG only for a host event, and off releases all resources", async t => {
  const env = environment(t);
  await env.media.applyRuntime(camera); await flush();
  assert.equal(env.hostRuntime.state.cameraImages, true);
  assert.equal(env.constraints[0].audio, false);
  assert.equal(env.frames.length, 0, "no clear frame without a host request");
  assert.equal(env.glances.length, 1, "one small frame right away");
  assert.deepEqual(env.draws, [{ width: 320, height: 180 }], "about 320×240 (1920×1080 → 320×180)");
  assert.deepEqual(env.hostRuntime.cameraAttachment(), { source: "camera", dataUrl: env.glances[0] }, "the host keeps it");
  assert.equal(env.timers.size, 0);
  assert.equal(env.timeouts.size, 1, "the next small frame is scheduled");
  await env.fireTimeouts(); assert.equal(env.glances.length, 2, "refreshed on the timer");
  await env.tick(10_000); assert.equal(env.frames.length, 0);
  await env.sample("camera-message-one");
  assert.equal(env.frames.length, 1);
  assert.deepEqual(env.draws.filter(draw => draw.width > 320), [{ width: 1280, height: 720 }]);
  for (const canvas of env.canvases) assert.equal(canvas.width, 1, "no picture is kept in a canvas");
  assert.equal(env.canvases.at(-1)!.height, 1);
  // "别看": the host holds it, the window stops drawing small frames at once; asking again resumes.
  env.hostRuntime.holdCamera(true);
  await env.media.applyRuntime({ ...env.hostRuntime.state }); // (the driver re-applies the host state as the broadcast would)
  const held = env.glances.length;
  assert.equal(env.timeouts.size, 0, "no small frame is scheduled while held");
  assert.equal(env.hostRuntime.cameraAttachment(), null);
  env.hostRuntime.holdCamera(false);
  await env.media.applyRuntime({ ...env.hostRuntime.state });
  assert.equal(env.glances.length, held + 1, "asking her to look again draws one right away");
  await env.sample("camera-message-one");
  await env.tick(10_000); assert.equal(env.frames.length, 1);
  await env.sample("camera-attention-two");
  assert.deepEqual(env.sampleIds, ["camera-message-one", "camera-attention-two"]);
  await env.media.applyRuntime(off);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.counts().pauses, 1);
  assert.equal(env.videos[0].srcObject, null);
  assert.equal(env.timers.size, 0);
  assert.equal(env.cameraListeners.size, 0);
  assert.equal(env.canvases[0].width, 1);
  await env.sample("camera-after-off");
  await env.tick(2000); assert.equal(env.frames.length, 2);
});

test("local pose sensing (I-001): the owner window never opens the camera or answers a frame request", async t => {
  const env = environment(t, { cameraMode: 'local' });
  await env.media.applyRuntime(camera); await flush();
  assert.equal(env.hostRuntime.state.cameraLocal, true);
  assert.equal(env.constraints.length, 0, "no getUserMedia in the pet/control window");
  assert.equal(env.videos.length, 0);
  await env.sample("camera-message-local");
  assert.equal(env.frames.length, 0, "nothing for chat to attach");
  await env.media.applyRuntime(off);
  const share = environment(t, { cameraMode: 'share' });
  await share.media.applyRuntime(camera); await flush();
  assert.equal(share.constraints.length, 1, "the old sharing mode still works where it applies");
  await share.media.applyRuntime(off);
});

test("camera canceled during device acquisition or play cannot restart publishing", async t => {
  const pending = deferred<void>(), env = environment(t, { play: pending.promise });
  const start = env.media.applyRuntime(camera); await flush();
  await env.media.applyRuntime(off);
  pending.resolve(); await start;
  assert.equal(env.counts().stops, 1);
  assert.equal(env.videos[0].srcObject, null);
  assert.equal(env.frames.length, 0);
  assert.equal(env.timers.size, 0);
});

test("late camera streams after disposal stop without a video or publication", async t => {
  const pending = deferred<MediaStream>(), env = environment(t, { media: pending.promise });
  const start = env.media.applyRuntime(camera);
  env.media.dispose(); pending.resolve(env.stream); await start;
  assert.equal(env.counts().stops, 1);
  assert.equal(env.videos.length, 0);
  assert.equal(env.frames.length, 0);
});

test("camera publication is single-flight and errors after off cannot restore sharing", async t => {
  const pending = deferred<void>(), env = environment(t, { publish: pending.promise });
  await env.media.applyRuntime(camera);
  await env.sample("camera-first");
  await env.sample("camera-busy");
  await env.tick(2000);
  assert.equal(env.frames.length, 1);
  await env.media.applyRuntime(off);
  pending.reject(new Error("old publication failed")); await flush();
  assert.deepEqual(env.errors, []);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.timers.size, 0);
});

test("an active ASR failure stops the microphone and reports the correct toggle", async t => {
  const pending = deferred<string>(), env = environment(t, { asr: pending.promise });
  await env.media.applyRuntime(voice);
  env.process(true, 3); env.process(false, 7);
  pending.reject(new Error("ASR unavailable")); await flush();
  assert.deepEqual(env.errors, ["voiceInput:ASR unavailable"]);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.counts().closes, 1);
  assert.equal(env.processors[0].onaudioprocess, null);
});

test('a refused transcription releases capture and only an explicit reopen can submit one recovered transcript', async t => {
  const failed = deferred<string>(), recovered = deferred<string>();
  const options = { asr: failed.promise }, env = environment(t, options);
  const reason = '无法连接语音识别服务（http://127.0.0.1:9942，ECONNREFUSED）。';
  await env.media.applyRuntime(voice);
  env.process(true, 3); env.process(false, 7);
  failed.reject(new Error(`Error invoking remote method 'desk:transcribeAudio': Error: ${reason}`)); await flush();
  assert.deepEqual(env.errors, [`voiceInput:${reason}`]);
  assert.equal(env.counts().stops, 1); assert.equal(env.counts().closes, 1);
  assert.equal(env.endedListeners.size, 0); assert.equal(env.processors[0].onaudioprocess, null);
  assert.equal(env.contexts[0].state, 'closed'); assert.ok(env.counts().disconnects >= 3);
  assert.deepEqual(env.transcripts, []);
  // The host clears ownership after the voiceInput error. No timeout or old
  // processor can reopen capture; the next true state models a new user toggle.
  await env.media.applyRuntime(off);
  env.advance(60_000); env.process(true, 3); env.process(false, 7); await flush();
  assert.equal(env.counts().acquisitions, 1); assert.equal(env.wavs.length, 1);
  options.asr = recovered.promise;
  await env.media.applyRuntime(voice);
  assert.equal(env.counts().acquisitions, 2); assert.equal(env.contexts.length, 2);
  env.process(true, 3); env.process(false, 7);
  env.process(true, 3); env.process(false, 7);
  assert.equal(env.wavs.length, 2, 'the recovered capture still has one in-flight ASR request');
  recovered.resolve('恢复后的测试语音'); await flush();
  env.process(false, 10); await flush();
  assert.deepEqual(env.transcripts, ['恢复后的测试语音']);
  assert.equal(env.errors.length, 1); assert.equal(env.counts().stops, 1);
});

test('microphone permission errors and unrelated IPC messages retain their original meaning', async t => {
  const pending = deferred<string>(), env = environment(t, { asr: pending.promise });
  await env.media.applyRuntime(voice);
  env.process(true, 3); env.process(false, 7);
  const unrelated = "Error invoking remote method 'desk:other': Error: 请求来源未授权。";
  pending.reject(new Error(unrelated)); await flush();
  assert.deepEqual(env.errors, [`voiceInput:${unrelated}`]);
});

test('a denied microphone stays denied and its permission message is not stripped', async t => {
  const pending = deferred<MediaStream>(), env = environment(t, { media: pending.promise });
  const opening = env.media.applyRuntime(voice);
  await flush();
  pending.reject(new DOMException('麦克风权限被拒绝。', 'NotAllowedError'));
  await opening;
  assert.deepEqual(env.errors, ['voiceInput:麦克风权限被拒绝。']);
  assert.equal(env.counts().acquisitions, 1); assert.equal(env.contexts.length, 0); assert.deepEqual(env.transcripts, []);
});

test("a valid empty transcript is ignored without disabling continuous voice input", async t => {
  const env = environment(t, { asr: Promise.resolve("  ") });
  await env.media.applyRuntime(voice);
  env.process(true, 3); env.process(false, 7); await flush();
  assert.deepEqual(env.transcripts, []);
  assert.deepEqual(env.errors, []);
  assert.equal(env.counts().stops, 0);
  env.process(true, 3); env.process(false, 7); await flush();
  assert.equal(env.wavs.length, 2);
});

test("ended camera tracks stop publication, clear the video and remove listeners", async t => {
  const env = environment(t);
  await env.media.applyRuntime(camera); await flush();
  assert.equal(env.endedListeners.size, 1);
  env.endTrack();
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0], /^cameraSharing:摄像头已断开/);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.videos[0].srcObject, null);
  assert.equal(env.endedListeners.size, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.cameraListeners.size, 0);
  await env.sample("camera-after-ended");
  await env.tick(2000); assert.equal(env.frames.length, 0);
});

test("invalid host IDs and callbacks from an earlier camera generation cannot capture", async t => {
  const env = environment(t);
  await env.media.applyRuntime(camera);
  const oldSample = env.oldCameraListeners[0];
  for (const id of ["", "other-id", "camera-", "camera-../file", `camera-${"a".repeat(101)}`]) await env.sample(id);
  assert.equal(env.frames.length, 0);
  await env.media.applyRuntime(off);
  await env.media.applyRuntime(camera);
  oldSample("camera-stale"); await flush();
  assert.equal(env.frames.length, 0);
  assert.equal(env.cameraListeners.size, 1);
  await env.sample("camera-fresh");
  assert.equal(env.frames.length, 1);
  env.media.dispose();
  assert.equal(env.cameraListeners.size, 0);
  env.oldCameraListeners.at(-1)!("camera-after-dispose"); await flush();
  assert.equal(env.frames.length, 1);
});

test("late sample completion cannot clear a new generation's in-flight sample", async t => {
  const first = deferred<void>(), second = deferred<void>();
  const env = environment(t, { publications: [first.promise, second.promise] });
  await env.media.applyRuntime(camera);
  await env.sample("camera-old");
  await env.media.applyRuntime(off);
  await env.media.applyRuntime(camera);
  await env.sample("camera-new");
  assert.equal(env.frames.length, 2);
  first.resolve(); await flush();
  await env.sample("camera-still-busy");
  assert.equal(env.frames.length, 2);
  second.resolve(); await flush();
  // A skipped busy event is not queued and cannot replay after completion.
  await env.sample("camera-still-busy");
  assert.equal(env.frames.length, 2);
  await env.sample("camera-after-completion");
  assert.equal(env.frames.length, 3);
});

test("cancelled event publication keeps an explicitly enabled camera available", async t => {
  const pending = deferred<void>(), env = environment(t, { publications: [pending.promise] });
  await env.media.applyRuntime(camera);
  await env.sample("camera-cancelled-event");
  pending.reject(new Error("Host event cancelled")); await flush();
  assert.equal(env.counts().stops, 0);
  assert.equal(env.cameraListeners.size, 1);
  assert.deepEqual(env.errors, []);
  await env.sample("camera-next-event");
  assert.equal(env.frames.length, 2);
});

test("intentional microphone stop removes ended listeners and ignores stale callbacks", async t => {
  const env = environment(t);
  await env.media.applyRuntime(voice);
  const oldEnded = [...env.endedListeners][0];
  await env.media.applyRuntime(off);
  assert.equal(env.endedListeners.size, 0);
  assert.deepEqual(env.errors, []);
  await env.media.applyRuntime(voice);
  oldEnded();
  assert.deepEqual(env.errors, []);
  assert.equal(env.endedListeners.size, 1);
  env.endTrack();
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0], /^voiceInput:麦克风已断开/);
  assert.equal(env.processors.at(-1)!.onaudioprocess, null);
  assert.equal(env.endedListeners.size, 0);
  assert.equal(env.counts().closes, 2);
});


test('host ASR fault releases capture immediately and an old epoch cannot stop its replacement', async t => {
  const failed = deferred<string>(), options = { asr: failed.promise }, env = environment(t, options);
  await env.media.applyRuntime(voice);
  env.process(true, 3); env.process(false, 7);
  failed.reject(new Error('安全的识别失败说明')); await flush();
  assert.deepEqual(env.errors, ['voiceInput:安全的识别失败说明']);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.processors[0].onaudioprocess, null);
  const oldFault = env.voiceEvents.at(-1)!;
  assert.equal(oldFault.type, 'fault');
  await env.media.applyRuntime(off);
  options.asr = deferred<string>().promise;
  await env.media.applyRuntime(voice);
  env.media.receiveVoiceFault(oldFault as Extract<VoiceConversationEvent, { type: 'fault' }>);
  env.media.receiveVoiceFault({ ...oldFault, owner: 'controls' } as Extract<VoiceConversationEvent, { type: 'fault' }>);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.counts().closes, 1);
  assert.equal(env.contexts.at(-1)!.state, 'running');
  assert.equal(env.errors.length, 1);
});

test('unpublishable recognizer diagnostics keep the generic host fault and release capture', async t => {
  const failed = deferred<string>(), env = environment(t, { asr: failed.promise });
  await env.media.applyRuntime(voice);
  env.process(true, 3); env.process(false, 7);
  failed.reject(new Error('blocked\0diagnostic')); await flush();
  assert.deepEqual(env.errors, ['voiceInput:连续语音已暂停，请重新开启语音输入。']);
  assert.equal(env.counts().stops, 1);
  assert.equal(env.counts().closes, 1);
  assert.equal(env.voiceEvents.at(-1)!.type, 'fault');
  assert.equal('message' in env.voiceEvents.at(-1)!, false);
});

test('ambient microphone and chat share one physical stream until the final real host reference is released', async t => {
  const env = environment(t), signal = new AbortController();
  const ambient = await env.captureHost.acquire({ scopeId: 'synthetic-ambient', source: 'microphone', epoch: 1, signal: signal.signal });
  assert.equal(env.counts().acquisitions, 1);
  assert.deepEqual(env.constraints[0], { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  await env.media.applyRuntime(voice);
  assert.equal(env.counts().acquisitions, 1); assert.equal(env.captureHost.getState().slots.microphone?.chat, true);
  env.process(true, 3); env.process(false, 7); await flush();
  assert.deepEqual(env.transcripts, ['你好']);
  await env.media.applyRuntime(off);
  assert.equal(env.counts().stops, 0); assert.equal(env.contexts[0].state, 'running');
  assert.equal(env.captureHost.getState().slots.microphone?.chat, false);
  assert.equal(env.captureHost.getState().slots.microphone?.ambient?.captureId, ambient.captureId);
  await ambient.release();
  assert.equal(env.counts().stops, 1); assert.equal(env.counts().closes, 1);
  assert.equal(env.processors[0].onaudioprocess, null); assert.equal(env.captureHost.getState().slots.microphone, null);
});
