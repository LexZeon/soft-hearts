import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SystemAudioState } from "../shared/contracts";
import { SystemAudioInput, type SystemAudioSample } from "../src/ui/SystemAudio";

const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeStream(audio = true) {
  const track = (kind: "audio" | "video") => {
    const listeners = new Set<() => void>();
    return {
      kind, stops: 0, readyState: "live", listeners,
      addEventListener(type: string, listener: () => void) { if (type === "ended") listeners.add(listener); },
      removeEventListener(type: string, listener: () => void) { if (type === "ended") listeners.delete(listener); },
      end() { this.readyState = "ended"; for (const listener of [...listeners]) listener(); },
      stop() { this.stops++; this.end(); },
    };
  };
  const videoTrack = track("video"), audioTrack = track("audio");
  const stream = {
    getTracks: () => audio ? [videoTrack, audioTrack] : [videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => audio ? [audioTrack] : [],
  } as unknown as MediaStream;
  return { stream, audio: audioTrack, video: videoTrack };
}

function environment(t: TestContext) {
  const keys = ["window", "document", "navigator", "AudioContext", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const capture = makeStream();
  const captures = [capture];
  const displayQueue: Promise<MediaStream>[] = [];
  const permissionQueue: Promise<SystemAudioState>[] = [];
  const resumeQueue: Promise<void>[] = [];
  const requests: DisplayMediaStreamOptions[] = [];
  const permissions: boolean[] = [];
  const states: SystemAudioState[] = [], errors: string[] = [], statuses: string[] = [], samples: SystemAudioSample[] = [];
  const listeners = new Set<(state: SystemAudioState) => void>();
  const emitHost = (active: boolean) => { for (const listener of [...listeners]) listener({ active }); };
  let frameId = 0, clock = 10000, rmsValue = 0.2, disconnected = 0, readFailure = false;
  const frames = new Map<number, FrameRequestCallback>();
  const contextInstances: AudioMock[] = [];
  const destinations: unknown[] = [];
  const processors: { onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null; disconnected: boolean; connect(destination: unknown): void; disconnect(): void }[] = [];
  const gains: { gain: { value: number }; disconnected: boolean; connect(destination: unknown): void; disconnect(): void }[] = [];
  const analysers: { fftSize: number; frequencyBinCount: number; smoothingTimeConstant: number; disconnect(): void }[] = [];
  const spectrum = new Float32Array(1024).fill(-Infinity);
  const interaction = { focused: true, activated: true };
  spectrum[5] = -12; spectrum[20] = -18; spectrum[150] = -24;
  class AudioMock {
    sampleRate = 48000;
    state = resumeQueue.length ? "suspended" : "running";
    closes = 0;
    destination = { forbiddenDestination: true };
    constructor() { contextInstances.push(this); }
    createAnalyser() {
      const analyser = {
        fftSize: 0, frequencyBinCount: 1024, smoothingTimeConstant: 0,
        getFloatTimeDomainData(values: Float32Array) { if (readFailure) throw new Error("analyser failed"); values.fill(rmsValue); },
        getFloatFrequencyData(values: Float32Array) { values.set(spectrum); },
        disconnect() { disconnected++; },
      };
      analysers.push(analyser);
      return analyser;
    }
    createMediaStreamSource() { return { connect: (destination: unknown) => destinations.push(destination), disconnect: () => { disconnected++; } }; }
    createScriptProcessor(bufferSize: number, inputs: number, outputs: number) {
      assert.deepEqual([bufferSize, inputs, outputs], [4096, 1, 1]);
      const processor = { onaudioprocess: null as ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null,
        disconnected: false, connect: (destination: unknown) => destinations.push(destination),
        disconnect() { this.disconnected = true; } };
      processors.push(processor); return processor;
    }
    createGain() {
      const gain = { gain: { value: 1 }, disconnected: false, connect: (destination: unknown) => destinations.push(destination),
        disconnect() { this.disconnected = true; } };
      gains.push(gain); return gain;
    }
    async resume() { await resumeQueue.shift(); if (this.state !== "closed") this.state = "running"; }
    async close() { this.state = "closed"; this.closes++; }
  }
  const globals: Record<string, unknown> = {
    window: { desktop: {
      onSystemAudioState(callback: (state: SystemAudioState) => void) { listeners.add(callback); return () => listeners.delete(callback); },
      async setSystemAudioSharing(enabled: boolean) { permissions.push(enabled); emitHost(enabled); return permissionQueue.shift() ?? { active: enabled }; },
    } },
    document: { hasFocus: () => interaction.focused },
    navigator: {
      userActivation: { get isActive() { return interaction.activated; } },
      mediaDevices: { getDisplayMedia(options: DisplayMediaStreamOptions) { requests.push(options); return displayQueue.shift() ?? Promise.resolve(capture.stream); } },
    },
    AudioContext: AudioMock,
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const input = new SystemAudioInput({ onSample: value => samples.push(value), onState: value => states.push(value), onStatus: value => statuses.push(value), onError: value => errors.push(value) });
  t.after(async () => {
    input.dispose(); await flush();
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    input, capture, captures, displayQueue, permissionQueue, resumeQueue, requests, permissions, states, errors, statuses, samples, listeners, frames,
    contexts: contextInstances, analysers, destinations, processors, gains, emitHost, spectrum, interaction,
    setRms(value: number) { rmsValue = value; },
    setReadFailure() { readFailure = true; },
    disconnected: () => disconnected,
    async tick(ms = 34) { clock += ms; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(clock); await flush(); },
  };
}

test("system audio defaults off and only becomes active after a real audio stream is ready", async t => {
  const env = environment(t), pending = deferred<MediaStream>();
  assert.equal(env.input.active, false);
  assert.deepEqual(env.permissions, []);
  assert.equal(env.requests.length, 0);
  env.displayQueue.push(pending.promise);
  const start = env.input.setEnabled(true); await flush();
  assert.deepEqual(env.permissions, [true]);
  assert.equal(env.input.active, false, "a host grant is not a ready audio stream");
  assert.deepEqual(env.requests, [{
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: true,
  }], 'loopback requests no speech echo cancellation, noise suppression or automatic gain');
  pending.resolve(env.capture.stream); await start;
  assert.equal(env.capture.video.stops, 1, "discard the fallback self-window video immediately");
  assert.equal(env.capture.audio.stops, 0);
  assert.equal(env.input.active, true);
  assert.equal(env.analysers[0].fftSize, 2048);
  assert.equal(env.destinations.length, 1);
  assert.equal(env.destinations[0], env.analysers[0], "the graph has no speaker destination or feedback path");
});

test("sampling is limited to 30 Hz and reports bounded RMS and separated frequency bands", async t => {
  const env = environment(t);
  await env.input.setEnabled(true);
  await env.tick(0); await env.tick(10); await env.tick(24);
  assert.equal(env.samples.length, 2);
  const sample = env.samples[0];
  assert.equal(sample.time, 10);
  assert.ok(Math.abs(sample.rms - 0.2) < 1e-6);
  assert.ok(Math.abs(sample.low - 10 ** (-12 / 20)) < 1e-6);
  assert.ok(Math.abs(sample.mid - 10 ** (-18 / 20)) < 1e-6);
  assert.ok(Math.abs(sample.high - 10 ** (-24 / 20)) < 1e-6);
  env.setRms(NaN); env.spectrum.fill(Infinity); await env.tick(34);
  assert.deepEqual(env.samples.at(-1), { time: 10.068, rms: 0, low: 0, mid: 0, high: 0 });
  await env.tick(1000);
  assert.equal(env.statuses.at(-1), "等待系统声音");
});

test('soft audible input reports detection without claiming an active dance', async t => {
  const env = environment(t); await env.input.setEnabled(true);
  env.setRms(0.004); await env.tick();
  assert.equal(env.statuses.at(-1), '检测到系统声音 · 仅本机分析');
  env.setRms(0); await env.tick(801);
  assert.equal(env.statuses.at(-1), '等待系统声音');
  assert.equal(env.processors.length, 0, 'music analysis alone does not create a PCM consumer');
});

test('the optional PCM listener reuses one loopback graph, owns copied samples, and releases stale callbacks', async t => {
  const env = environment(t);
  const received: { samples: Float32Array; rate: number; time: number }[] = [];
  env.input.setPcmListener((samples, rate, time) => received.push({ samples, rate, time }));
  assert.equal(env.requests.length, 0, 'registering a consumer cannot acquire capture');
  assert.equal(env.processors.length, 0);
  await env.input.setEnabled(true);
  assert.equal(env.requests.length, 1);
  assert.equal(env.processors.length, 1);
  assert.equal(env.gains[0].gain.value, 0, 'the consumer adds no audible feedback');
  const processor = env.processors[0], stale = processor.onaudioprocess!;
  const buffer = new Float32Array([0.1, -0.2, 0.3]);
  stale({ inputBuffer: { getChannelData: () => buffer } });
  assert.equal(received.length, 1); assert.equal(received[0].rate, 48000);
  assert.ok(Number.isFinite(received[0].time));
  assert.notEqual(received[0].samples, buffer); assert.deepEqual(received[0].samples, buffer);
  env.input.setPcmListener(null);
  assert.equal(processor.onaudioprocess, null); assert.equal(processor.disconnected, true); assert.equal(env.gains[0].disconnected, true);
  stale({ inputBuffer: { getChannelData: () => buffer } });
  assert.equal(received.length, 1, 'a removed consumer cannot be revived by a pending callback');
  assert.equal(env.input.active, true, 'removing a consumer preserves the original music analysis');
  await env.input.stop();
  assert.equal(env.capture.audio.stops, 1); assert.equal(env.contexts[0].closes, 1);
});

test("stop releases tracks, listeners, context and animation frames without recording or stale samples", async t => {
  const env = environment(t);
  await env.input.setEnabled(true); await env.tick();
  assert.equal(env.capture.audio.listeners.size, 1);
  await env.input.stop();
  assert.equal(env.input.active, false);
  assert.equal(env.capture.audio.stops, 1);
  assert.equal(env.capture.audio.listeners.size, 0);
  assert.equal(env.contexts[0].closes, 1);
  assert.equal(env.disconnected(), 2);
  assert.equal(env.frames.size, 0);
  assert.deepEqual(env.permissions, [true, false]);
  const count = env.samples.length;
  env.capture.audio.end(); await env.tick(1000);
  assert.equal(env.samples.length, count);
  assert.deepEqual(env.errors, []);
});

test("rapid start-stop-start never overlaps native capture and releases every late track", async t => {
  const env = environment(t), pending = deferred<MediaStream>();
  env.displayQueue.push(pending.promise);
  const start = env.input.setEnabled(true); await flush();
  await env.input.stop();
  await env.input.setEnabled(true);
  assert.equal(env.requests.length, 1, "a second native request must not overlap the canceled request");
  assert.equal(env.input.active, false);
  assert.deepEqual(env.permissions, [true, false]);
  assert.match(env.errors[0], /上一轮.*仍在结束/);
  pending.resolve(env.capture.stream); await start;
  assert.ok(env.capture.video.stops >= 1);
  assert.equal(env.capture.audio.stops, 1);
  assert.equal(env.contexts.length, 0);
  assert.equal(env.input.active, false);
  await flush();
  assert.equal(env.requests.length, 1, "settling the old request must not queue an automatic restart");
  const next = makeStream(); env.displayQueue.push(Promise.resolve(next.stream));
  await env.input.setEnabled(true);
  assert.equal(env.input.active, true);
  assert.equal(env.requests.length, 2);
  assert.equal(next.audio.stops, 0);
  assert.deepEqual(env.permissions, [true, false, true]);
  assert.equal(env.errors.length, 1);
});

test("stop while the grant response is pending prevents display capture and queues revocation", async t => {
  const env = environment(t), permission = deferred<SystemAudioState>();
  env.permissionQueue.push(permission.promise);
  const start = env.input.setEnabled(true); await flush();
  const stopping = env.input.stop();
  permission.resolve({ active: true });
  await Promise.all([start, stopping]);
  assert.equal(env.requests.length, 0);
  assert.deepEqual(env.permissions, [true, false]);
  assert.equal(env.input.active, false);
});

test("a canceled native capture must reject before a fresh explicit start can succeed", async t => {
  const env = environment(t), oldCapture = deferred<MediaStream>();
  env.displayQueue.push(oldCapture.promise);
  const oldStart = env.input.setEnabled(true); await flush();
  await env.input.stop();
  await env.input.setEnabled(true);
  assert.equal(env.requests.length, 1);
  oldCapture.reject(new Error("old permission was canceled")); await oldStart; await flush();
  assert.equal(env.input.active, false);
  assert.equal(env.requests.length, 1);
  await env.input.setEnabled(true);
  assert.equal(env.input.active, true);
  assert.deepEqual(env.permissions, [true, false, true]);
  assert.equal(env.errors.length, 1, "a stale rejection is silent after the explicit blocked-start notice");
});

test("cancellation during context resume cannot reactivate its closed capture", async t => {
  const env = environment(t), resume = deferred<void>();
  env.resumeQueue.push(resume.promise);
  const start = env.input.setEnabled(true); await flush();
  assert.equal(env.contexts.length, 1);
  await env.input.stop();
  resume.resolve(); await start;
  assert.equal(env.contexts[0].state, "closed");
  assert.equal(env.contexts[0].closes, 1);
  assert.equal(env.capture.audio.stops, 1);
  assert.equal(env.frames.size, 0);
  assert.equal(env.input.active, false);
});

test("host revocation cancels a pending capture and stops a ready capture", async t => {
  const env = environment(t), pending = deferred<MediaStream>();
  env.displayQueue.push(pending.promise);
  const starting = env.input.setEnabled(true); await flush();
  env.emitHost(false);
  pending.resolve(env.capture.stream); await starting;
  assert.equal(env.contexts.length, 0);
  assert.equal(env.capture.audio.stops, 1);
  const second = makeStream(); env.displayQueue.push(Promise.resolve(second.stream));
  await env.input.setEnabled(true);
  env.emitHost(false);
  assert.equal(env.input.active, false);
  assert.equal(second.audio.stops, 1);
  assert.equal(env.contexts[0].closes, 1);
  assert.equal(env.frames.size, 0);
});

test("an ended audio track stops analysis, revokes the host grant and reports one actionable error", async t => {
  const env = environment(t);
  await env.input.setEnabled(true);
  env.capture.audio.end(); await flush();
  assert.equal(env.input.active, false);
  assert.equal(env.frames.size, 0);
  assert.equal(env.contexts[0].closes, 1);
  assert.equal(env.capture.audio.listeners.size, 0);
  assert.deepEqual(env.permissions, [true, false]);
  assert.deepEqual(env.errors, ["系统声音共享已结束。"]);
});

test("missing audio and capture rejection never leave an active grant or analysis graph", async t => {
  const env = environment(t), videoOnly = makeStream(false);
  env.displayQueue.push(Promise.resolve(videoOnly.stream));
  await env.input.setEnabled(true); await flush();
  assert.match(env.errors[0], /未取得系统音轨/);
  assert.equal(env.contexts.length, 0);
  assert.ok(videoOnly.video.stops >= 1);
  env.displayQueue.push(Promise.reject(new Error("capture denied")));
  await env.input.setEnabled(true); await flush();
  assert.match(env.errors.at(-1)!, /系统声音连接失败.*采集/);
  assert.ok(!env.errors.at(-1)!.includes("capture denied"), "arbitrary native text is not forwarded");
  assert.equal(env.input.active, false);
  assert.deepEqual(env.permissions, [true, false, true, false]);
});

test("analysis failure releases its stream and does not schedule another sample", async t => {
  const env = environment(t);
  await env.input.setEnabled(true); env.setReadFailure(); await env.tick();
  assert.equal(env.input.active, false);
  assert.equal(env.frames.size, 0);
  assert.equal(env.capture.audio.stops, 1);
  assert.deepEqual(env.errors, ["analyser failed"]);
  assert.deepEqual(env.permissions, [true, false]);
});

test("dispose invalidates a late capture, unsubscribes host events and refuses new requests", async t => {
  const env = environment(t), pending = deferred<MediaStream>();
  env.displayQueue.push(pending.promise);
  const start = env.input.setEnabled(true); await flush();
  env.input.dispose();
  assert.equal(env.listeners.size, 0);
  pending.resolve(env.capture.stream); await start; await flush();
  await env.input.setEnabled(true); await env.input.toggle();
  assert.equal(env.requests.length, 1);
  assert.equal(env.contexts.length, 0);
  assert.equal(env.capture.audio.stops, 1);
  assert.equal(env.input.active, false);
  assert.deepEqual(env.permissions, [true, false]);
});

test("an unfinished host revocation blocks a new start without queuing native capture", async t => {
  const env = environment(t), stopped = deferred<SystemAudioState>();
  await env.input.setEnabled(true);
  env.permissionQueue.push(stopped.promise);
  const stop = env.input.stop(); await flush();
  const next = makeStream(); env.displayQueue.push(Promise.resolve(next.stream));
  await env.input.setEnabled(true);
  assert.equal(env.requests.length, 1);
  assert.match(env.errors[0], /上一轮.*仍在结束/);
  env.emitHost(false);
  stopped.resolve({ active: false });
  await stop; await flush();
  assert.equal(env.requests.length, 1);
  await env.input.setEnabled(true);
  assert.equal(env.input.active, true);
  assert.equal(next.audio.stops, 0);
  assert.deepEqual(env.permissions, [true, false, true]);
  assert.equal(env.errors.length, 1);
});

test("capture denial revokes permission, reports safe focus evidence and permits an explicit retry", async t => {
  const env = environment(t), denied = deferred<MediaStream>();
  env.interaction.focused = false; env.interaction.activated = false;
  env.displayQueue.push(denied.promise);
  const start = env.input.setEnabled(true); await flush();
  denied.reject(new DOMException("private native detail", "NotAllowedError"));
  await start; await flush();
  assert.equal(env.input.active, false);
  assert.equal(env.contexts.length, 0);
  assert.deepEqual(env.permissions, [true, false]);
  assert.match(env.errors[0], /采集被拒绝.*采集；NotAllowedError；窗口未聚焦；无点击激活/);
  assert.ok(!env.errors[0].includes("private native detail"));
  env.interaction.focused = true; env.interaction.activated = true;
  await env.input.setEnabled(true);
  assert.equal(env.input.active, true);
  assert.equal(env.requests.length, 2);
  assert.deepEqual(env.permissions, [true, false, true]);
});

test("grant denial is distinct from native capture failure and never opens a capture", async t => {
  const env = environment(t), grant = deferred<SystemAudioState>();
  env.permissionQueue.push(grant.promise);
  const start = env.input.setEnabled(true); await flush();
  grant.reject(new DOMException("private grant detail", "SecurityError"));
  await start; await flush();
  assert.equal(env.requests.length, 0);
  assert.deepEqual(env.permissions, [true, false]);
  assert.match(env.errors[0], /共享未获授权.*授权；SecurityError/);
  assert.ok(!env.errors[0].includes("private grant detail"));
});

test("audio context denial releases its granted stream and identifies the analysis stage", async t => {
  const env = environment(t), resume = deferred<void>();
  env.resumeQueue.push(resume.promise);
  const start = env.input.setEnabled(true); await flush();
  resume.reject(new DOMException("private context detail", "InvalidStateError"));
  await start; await flush();
  assert.equal(env.input.active, false);
  assert.equal(env.capture.audio.stops, 1);
  assert.equal(env.contexts[0].closes, 1);
  assert.equal(env.frames.size, 0);
  assert.deepEqual(env.permissions, [true, false]);
  assert.match(env.errors[0], /分析未能启动.*音频分析；InvalidStateError/);
  assert.ok(!env.errors[0].includes("private context detail"));
});

test("unrecognized exception names and messages do not escape the connection error boundary", async t => {
  const env = environment(t), pending = deferred<MediaStream>();
  env.displayQueue.push(pending.promise);
  const start = env.input.setEnabled(true); await flush();
  const error = new Error("private exception message"); error.name = "PrivateExceptionName";
  pending.reject(error); await start; await flush();
  assert.match(env.errors[0], /系统声音连接失败.*采集/);
  assert.ok(!env.errors[0].includes("private exception"));
  assert.ok(!env.errors[0].includes("PrivateExceptionName"));
});
