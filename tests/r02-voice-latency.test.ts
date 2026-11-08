import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type SpeechRequestContext, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { synthesizeBailianSpeech } from '../electron/tts';
import { SpeechRuntime } from '../electron/speech-runtime';
import { EmotionalVoiceControls, StreamingVoicePlayer, type EmotionalVoicePlaybackState } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';

/*
 * R02 · "首个音频包 1281 ms · 开始播放约 9507 ms". These tests replay that
 * timeline with a fake clock, a fake audio device and a fake SSE stream. They
 * never touch a real network, key or speaker.
 */
import { flush, pcm, world } from './helpers/r02-audio-world';

function voiceHarness(t: TestContext, w: ReturnType<typeof world>, options: { reuse?: boolean } = {}) {
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  let ids = 0;
  const requests: { id: string; text: string; at: number; context?: SpeechRequestContext }[] = [];
  const cancellations: string[] = [], speaking: { value: boolean; at: number }[] = [], states: EmotionalVoicePlaybackState[] = [], errors: string[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  const audio = options.reuse ? new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers }) : undefined;
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => ({ ...DEFAULT_SETTINGS.voice, enabled: true }),
    api: {
      async synthesizeSpeech(id, text, context) { requests.push({ id, text, at: w.now(), ...(context ? { context } : {}) }); },
      async cancelSpeech(id) { cancellations.push(id); },
      async releaseSpeech() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
    },
    onSpeaking: value => speaking.push({ value, at: w.now() }), onState: state => states.push(state), onError: message => errors.push(message),
    createId: () => `r02-${++ids}`,
    ...(audio ? { audio } : {}),
    now: w.now,
    // The player is the real one; only its clock and timers are synthetic.
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, ...(audio ? {} : { createContext: w.createContext }), now: w.now, timers: w.timers }),
  });
  t.after(() => output.dispose());
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index].id, ...event } as VoiceOutputEvent);
  const audioChunk = (index: number, firstAudioMs?: number) => emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(firstAudioMs === undefined ? {} : { firstAudioMs }) });
  return { output, requests, cancellations, speaking, states, errors, audioChunk, done: (index: number, firstAudioMs: number, bytes: number) => emit(index, { type: 'done', firstAudioMs, audioBytes: bytes }) };
}

test('R02 root cause: synthesis is dispatched while a slow audio device starts, not after it', async t => {
  const w = world(t, { deviceStartMs: 8000 });
  const h = voiceHarness(t, w);
  const preview = h.output.preview('你好，我会在这里陪你。');
  await flush();
  assert.equal(h.requests.length, 1, 'the paid request must not wait ~8 s for the output device');
  assert.equal(h.requests[0].at, 1000);
  await w.advance(1281); h.audioChunk(0, 1281); h.audioChunk(0); await flush();
  assert.equal(h.speaking.some(s => s.value), false, 'no lip-sync before the device actually plays');
  h.done(0, 1281, 19200);
  await w.advance(8000);
  const audible = h.speaking.find(s => s.value);
  assert.ok(audible, 'speech becomes audible once the device runs');
  // Device start (8000 ms) and network (1281 ms) now overlap: audible ≈ device + 100 ms lead, not their sum.
  assert.ok(audible.at - 1000 <= 8000 + 150, `audible after ${audible.at - 1000} ms`);
  const measured = h.states.find(s => Number.isFinite(s.playbackStartMs));
  assert.ok(measured && Math.abs(measured.playbackStartMs! - (audible.at - 1000)) <= 5, 'status reports the measured start');
  assert.equal(measured.firstAudioMs, 1281);
  assert.ok(h.states.some(s => s.deviceStartMs === 8000), 'the slow device start is visible in the status');
  await w.advance(1000); await preview;
  assert.deepEqual(h.errors, []);
});

test('R02: later utterances reuse the warm output device instead of opening a new one each time', async t => {
  const w = world(t, { deviceStartMs: 3000 });
  const h = voiceHarness(t, w, { reuse: true });
  for (let turn = 0; turn < 3; turn++) {
    const started = w.now();
    const speech = h.output.speak(`第${turn}句。`, { ...DEFAULT_SETTINGS.voice, enabled: true }, { replyId: `reply-${turn}` });
    await flush();
    await w.advance(300); h.audioChunk(turn, 300); h.done(turn, 300, 9600);
    await w.advance(turn === 0 ? 3500 : 600);
    const audible = h.speaking.filter(s => s.value).at(-1)!;
    assert.ok(audible.at >= started, `turn ${turn} became audible`);
    if (turn > 0) assert.ok(audible.at - started <= 300 + 150, `warm turn ${turn} audible after ${audible.at - started} ms`);
    await w.advance(300); await speech;
  }
  assert.equal(w.contexts.length, 1, 'one AudioContext for all three utterances');
  assert.equal(w.contexts[0].closes, 0, 'the warm context is kept between utterances');
  assert.deepEqual(h.errors, []);
});

test('R02: lip-sync follows the audio clock, closes on an underrun and reopens when PCM resumes', async t => {
  const w = world(t);
  const speaking: { value: boolean; at: number }[] = [];
  const player = new StreamingVoicePlayer({ onSpeaking: value => speaking.push({ value, at: w.now() }), createContext: w.createContext, now: w.now, timers: w.timers });
  const begin = player.begin('a', 1, w.now()); await w.advance(1); await begin;
  speaking.length = 0;
  await player.accept({ id: 'a', type: 'audio', data: pcm(2400), format: 'pcm_s16le', sampleRate: 24000, channels: 1, firstAudioMs: 5 });
  const source = w.contexts[0].sources[0];
  assert.ok(source.startAt - w.contexts[0].currentTime <= 0.1 + 1e-9, 'first chunk starts within the bounded 100 ms jitter lead');
  assert.equal(speaking.length, 0, 'scheduling alone is not proof of sound');
  await w.advance(120);
  assert.deepEqual(speaking.map(s => s.value), [true]);
  await w.advance(150); // 0.1 s chunk ended; the next has not arrived (network gap)
  assert.deepEqual(speaking.map(s => s.value), [true, false], 'mouth closes while the queue is empty');
  await player.accept({ id: 'a', type: 'audio', data: pcm(2400), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await w.advance(60);
  assert.deepEqual(speaking.map(s => s.value), [true, false, true]);
  player.dispose();
});

test('R02: a device whose clock never advances never moves the mouth', async t => {
  const w = world(t);
  const speaking: boolean[] = [];
  const stalled = { state: 'running', currentTime: 0, baseLatency: 0, outputLatency: 0, destination: {}, sources: [] as { start(at: number): void }[],
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBuffer: (_c: number, frames: number, rate: number) => { const samples = new Float32Array(frames); return { duration: frames / rate, getChannelData: () => samples }; },
    createBufferSource() { const source = { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} }; this.sources.push(source); return source; },
    resume: async () => {}, suspend: async () => {}, close: async () => {} };
  const player = new StreamingVoicePlayer({ onSpeaking: value => speaking.push(value), createContext: () => stalled as unknown as AudioContext, now: w.now, timers: w.timers });
  await player.begin('a');
  await player.accept({ id: 'a', type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await w.advance(2000);
  assert.equal(stalled.sources.length, 1);
  assert.equal(speaking.includes(true), false);
  player.dispose();
});

test('R02 evidence: the host forwards every SSE audio event as it arrives, without waiting for [DONE]', async () => {
  let push!: (text: string) => void, end!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    const encoder = new TextEncoder();
    push = text => controller.enqueue(encoder.encode(text)); end = () => controller.close();
  } });
  const fetch = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch;
  let clock = 0;
  const wire: { type: string; at: number }[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'r', apiKey: 'k' };
  const runtime = new SpeechRuntime(() => config, (_owner, event) => wire.push({ type: event.type, at: clock }),
    (value, text, signal, emit) => synthesizeBailianSpeech(value, text, signal, emit, { fetch, now: () => clock }));
  const speaking = runtime.speak(7, 'req-1', '你好。');
  await flush();
  const event = (data: string, finish = 'null') => `data:{"output":{"audio":{"data":"${data}"},"finish_reason":${finish === 'null' ? 'null' : `"${finish}"`}}}\n\n`;
  clock = 1281; push(event(Buffer.alloc(8).toString('base64'))); await flush();
  assert.deepEqual(wire, [{ type: 'audio', at: 1281 }], 'first packet reaches IPC immediately');
  clock = 1400; push(event(Buffer.alloc(8).toString('base64'))); await flush();
  assert.equal(wire.length, 2);
  clock = 2000; push(event('', 'stop')); push('data:[DONE]\n\n'); end(); await speaking;
  assert.deepEqual(wire.map(item => item.type), ['audio', 'audio', 'done']);
});

class ElementMock {
  id = ''; textContent = ''; className = ''; value = ''; type = ''; placeholder = '';
  hidden = false; disabled = false; autocomplete = ''; spellcheck = true; maxLength = 0; rows = 0;
  min = ''; max = ''; step = ''; dataset: Record<string, string> = {};
  children: ElementMock[] = []; attributes = new Map<string, string>();
  onclick: (() => void) | null = null; onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  append(...children: ElementMock[]) { this.children.push(...children); }
  replaceChildren(...children: ElementMock[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  focus() {}
}

test('R02: the status line shows the measured start and a slow device, never a browser estimate', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementMock() } });
  const container = new ElementMock();
  const controls = new EmotionalVoiceControls(container as unknown as HTMLElement, {
    getConfig: () => ({ ...DEFAULT_TTS_CONFIG, introduced: true }), onChange: async () => {}, onPreview: async () => {}, onStop() {}, onError() {},
  });
  t.after(() => { controls.dispose(); if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); });
  const find = (node: ElementMock): ElementMock | undefined => node.id === 'tts-playback-status' ? node : node.children.map(find).find(Boolean);
  controls.setPlaybackState({ phase: 'playing', firstAudioMs: 1281, firstPlaybackMs: 9507, playbackStartMs: 1390, deviceStartMs: 120 });
  const status = find(container)!;
  assert.match(status.textContent, /首个音频包 1281 ms/);
  assert.match(status.textContent, /开始出声 1390 ms（实测）/);
  assert.doesNotMatch(status.textContent, /浏览器估计|9507/);
  assert.doesNotMatch(status.textContent, /音频设备启动/, 'a fast device is not called out');
  controls.setPlaybackState({ phase: 'playing', firstAudioMs: 1281, playbackStartMs: 8100, deviceStartMs: 8000 });
  assert.match(status.textContent, /音频设备启动 8000 ms/);
  // X-088: an inferred start is labelled as an estimate, never as measured.
  controls.setPlaybackState({ phase: 'playing', firstAudioMs: 1281, playbackStartMs: 1390, playbackStartEstimated: true });
  assert.match(status.textContent, /开始出声 1390 ms（估计）/);
  assert.doesNotMatch(status.textContent, /实测/);
});

test('X-088: the player marks its start as measured only when it was read off the device output clock', async t => {
  for (const withStamp of [false, true]) {
    const w = world(t, { deviceStartMs: 50 });
    const h = voiceHarness(t, w);
    const preview = h.output.preview('你好。');
    await flush();
    while (!w.contexts.length) await w.advance(1);
    // Every fake device of this world (the prewarmed one and the player's) reports a real output timestamp.
    if (withStamp) Object.getPrototypeOf(w.contexts[0]).getOutputTimestamp = function (this: { currentTime: number }): AudioTimestamp {
      return { contextTime: this.currentTime, performanceTime: w.now() };
    };
    await w.advance(100); h.audioChunk(0, 100); h.done(0, 100, 9600);
    await w.advance(800); await preview;
    const state = h.states.find(s => Number.isFinite(s.playbackStartMs))!;
    assert.ok(state, 'a start was recorded');
    assert.equal(state.playbackStartEstimated === true, !withStamp, withStamp ? 'device output timestamp: measured' : 'no output timestamp: estimated');
    assert.deepEqual(h.errors, []);
  }
});

test('X-088: a prewarm nobody uses (failed or cancelled reply, read-aloud off) still goes idle and suspends the device', async t => {
  const w = world(t, { deviceStartMs: 50 });
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers, idleMs: 500 });
  t.after(() => audio.dispose());
  audio.prewarm(); // chat sent, but no speech follows
  await w.advance(60);
  const device = w.contexts[0];
  assert.equal(device.state, 'running');
  await w.advance(600);
  assert.equal(device.state, 'suspended', 'the warm device does not stay running forever');
  assert.equal(device.suspends, 1);
  // A prewarm followed by real speech is unchanged: held while in use, idle again only after release.
  audio.prewarm();
  await w.advance(60);
  const lease = await audio.acquire();
  await w.advance(600);
  assert.equal(device.state, 'running', 'never suspended while held');
  lease.release();
  await w.advance(600);
  assert.equal(device.state, 'suspended');
  assert.equal(w.contexts.length, 1, 'the same device was reused throughout');
});
