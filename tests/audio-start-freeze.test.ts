import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/tts';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { FeedCuePlayer } from '../src/ui/feed-cue-player';
import {
  AUDIO_CONTEXT_BUILD_MEASURE, AUDIO_OUTPUT_RETRY_MS, AUDIO_OUTPUT_START_TIMEOUT_MS, SharedAudioOutput,
  type AudioOutputVisibility,
} from '../src/ui/audio-output';
import { flush, pcm, world } from './helpers/r02-audio-world';

/*
 * 2026-11-05, the user: "现版本容易卡死", "突然卡一小段时间，不动", "点击试音也会卡一下". Measured on the user's machine
 * (Electron 45, Windows arm64): `new AudioContext()` blocks the window's main thread for a random 0.1–15 s, while
 * resume() of an existing context is asynchronous and does not stall frames. These tests pin the lifecycle that follows:
 * one build per window (early, `warm()`), suspend when idle and resume the same context, never rebuild for a slow or failed
 * start, rebuild once (while nothing plays) only a context the browser closed or broke. Fake clock and devices, no audio.
 */
const LIMIT = { timeout: 30_000 };
/** Idle period for the fake clock (the real one is AUDIO_OUTPUT_IDLE_MS; stepping 2 minutes in 1 ms steps is slow). */
const IDLE_MS = 2_000;

type FakeDevice = ReturnType<ReturnType<typeof world>['createContext']> & {
  state: AudioContextState; resumes: number; suspends: number; closes: number; sources: unknown[];
};

/** A fake device that can also be closed or broken by the "browser" (statechange / error events, like Chromium's). */
function eventful(device: FakeDevice) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target = device as unknown as {
    addEventListener(type: string, listener: (event: Event) => void): void;
    browserClose(): void; browserError(): void;
  };
  target.addEventListener = (type, listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); };
  const fire = (type: string) => { for (const listener of listeners.get(type) ?? []) listener({ type } as Event); };
  target.browserClose = () => { device.state = 'closed'; fire('statechange'); };
  target.browserError = () => fire('error');
  return target;
}

function harness(t: TestContext, options: { deviceStartMs?: number; hidden?: boolean; buildMs?: number; eventful?: boolean; idleMs?: number } = {}) {
  const w = world(t, { deviceStartMs: options.deviceStartMs ?? 50 });
  // A build blocks the window: the fake clock jumps by `buildMs` inside createContext, like the real stall.
  let stalled = 0;
  const now = () => w.now() + stalled;
  const createContext = () => {
    stalled += options.buildMs ?? 0;
    const device = w.createContext() as unknown as FakeDevice;
    if (options.eventful) eventful(device);
    return device as unknown as AudioContext;
  };
  let hidden = options.hidden ?? false;
  const listeners = new Set<() => void>();
  const visibility: AudioOutputVisibility = { hidden: () => hidden, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const audio = new SharedAudioOutput({ createContext, now, timers: w.timers, visibility, idleMs: options.idleMs });
  t.after(() => audio.dispose());
  const devices = () => w.contexts as unknown as FakeDevice[];
  return {
    w, audio, now, devices,
    device: (index = 0) => devices()[index],
    events: (index = 0) => devices()[index] as unknown as ReturnType<typeof eventful>,
    show() { hidden = false; for (const each of [...listeners]) each(); },
  };
}

function observe<T>(promise: Promise<T>) {
  const seen: { state: 'waiting' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { state: 'waiting' };
  void promise.then(value => { seen.state = 'fulfilled'; seen.value = value; }, error => { seen.state = 'rejected'; seen.error = error; });
  return seen;
}

/** One reading's worth of holding the output: acquire, run, release. */
async function read(h: ReturnType<typeof harness>, holdMs = 500) {
  const lease = observe(h.audio.acquire());
  await h.w.advance(100);
  assert.equal(lease.state, 'fulfilled');
  await h.w.advance(holdMs);
  lease.value!.release();
  return lease.value!;
}

test('freeze: warm() builds the window\'s one context; speaking, idling and speaking again never build another', LIMIT, async t => {
  const h = harness(t, { idleMs: IDLE_MS });
  assert.equal(h.audio.warm(), true);
  assert.equal(h.devices().length, 1, 'built at the moment the window chose');
  assert.equal(h.device().resumes, 1, 'warm() also starts the device (2026-11-06), so the first reading does not wait for it');
  assert.equal(h.audio.warm(), false, 'a second warm() is a no-op');
  for (let round = 0; round < 3; round++) {
    h.audio.prewarm(); // chat sent
    await h.w.advance(2000);
    await read(h);
    await h.w.advance(IDLE_MS + 10);
    assert.equal(h.device().state, 'suspended', `round ${round}: idle suspends it`);
  }
  assert.equal(h.devices().length, 1, 'three readings with idle periods in between: one context');
  assert.equal(h.audio.builds, 1);
  assert.equal(h.device().closes, 0);
  assert.equal(h.device().suspends, 3);
});

test('freeze: after an idle suspend the next reading resumes the same context (no build at the speaking moment)', LIMIT, async t => {
  const h = harness(t, { idleMs: IDLE_MS });
  h.audio.warm();
  const first = await read(h);
  await h.w.advance(IDLE_MS + 10);
  assert.equal(h.device().state, 'suspended');
  const resumes = h.device().resumes;
  const lease = observe(h.audio.acquire());
  await flush();
  assert.equal(h.devices().length, 1, 'the reading did not build');
  await h.w.advance(60);
  assert.equal(lease.state, 'fulfilled');
  assert.equal(lease.value!.context, first.context, 'the same context');
  assert.equal(lease.value!.startMs, 50, 'it waited for the resume only');
  assert.equal(h.device().resumes, resumes + 1);
  lease.value!.release();
});

test('freeze: one output shared by the reading player and both cue players builds one context for all of them', LIMIT, async t => {
  const h = harness(t);
  h.audio.warm();
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
  const api = { async synthesizeFeedCue() { return { pcm: pcm(2400) }; } };
  const feeding = new FeedCuePlayer({ api, getTtsConfig: () => config, getVoiceConfig: () => voice, audio: h.audio, now: h.now, timers: h.w.timers });
  const thinking = new FeedCuePlayer({ api, getTtsConfig: () => config, getVoiceConfig: () => voice, audio: h.audio, now: h.now, timers: h.w.timers, kinds: ['think'] });
  const player = new StreamingVoicePlayer({ output: h.audio, now: h.now, timers: h.w.timers, onSpeaking: () => {} });
  t.after(() => { feeding.dispose(); thinking.dispose(); player.dispose(); });
  feeding.prepare(); thinking.prepare();
  await h.w.advance(200);
  // A reading, then the waiting hum, then a feeding cue while the reading is held.
  void player.begin('r1');
  void player.accept({ id: 'r1', type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await h.w.advance(100);
  const hum = await thinking.play('think', 3000);
  assert.ok(hum, 'the hum played on the shared output');
  const cue = await feeding.play('ah', 3000);
  assert.ok(cue, 'the feeding cue played on the shared output');
  void player.accept({ id: 'r1', type: 'done', firstAudioMs: 100, audioBytes: 9600 });
  await h.w.advance(2000);
  assert.equal(h.devices().length, 1, 'one context in this window');
  assert.ok(h.device().sources.length >= 3, 'the reading and both cues were scheduled on it');
  assert.equal(h.device().closes, 0);
  // Disposing the players does not close the window's context: it is not theirs.
  feeding.dispose(); thinking.dispose(); player.dispose();
  assert.equal(h.device().closes, 0);
});

test('freeze: a slow resume is waited for on the same context, and one slower than the budget fails without closing it', LIMIT, async t => {
  {
    const h = harness(t, { deviceStartMs: 9000 });
    h.audio.warm();
    const lease = observe(h.audio.acquire());
    await h.w.advance(9010);
    assert.equal(lease.state, 'fulfilled', 'a 9 s start is still waited for');
    assert.equal(h.devices().length, 1);
    lease.value!.release();
  }
  {
    const h = harness(t, { deviceStartMs: 12_000 });
    h.audio.warm();
    const slow = observe(h.audio.acquire());
    await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS + 10);
    assert.equal(slow.state, 'rejected', 'the reading fails at its bound');
    assert.equal(h.device().closes, 0, 'the context is kept');
    assert.equal(h.devices().length, 1, 'and nothing is built');
    await h.w.advance(2500); // the resume it asked for lands at 12 s
    assert.equal(h.device().state, 'running');
    const next = observe(h.audio.acquire());
    await flush();
    assert.equal(next.state, 'fulfilled', 'the next reading finds it running');
    assert.equal(next.value!.startMs, 0);
    assert.equal(h.devices().length, 1);
    next.value!.release();
  }
});

test('freeze: a refused resume is asked again on the same context inside the budget', LIMIT, async t => {
  const h = harness(t);
  h.audio.warm();
  await h.w.advance(100);
  h.device().state = 'suspended'; // as after an idle suspend
  const device = h.device() as unknown as { resume(): Promise<void>; resumes: number };
  device.resumes = 0;
  const resume = device.resume.bind(device);
  let refusals = 2;
  device.resume = () => { if (refusals > 0) { refusals--; device.resumes++; return Promise.reject(new Error('NotAllowedError')); } return resume(); };
  const lease = observe(h.audio.acquire());
  await h.w.advance(2 * AUDIO_OUTPUT_RETRY_MS + 100);
  assert.equal(lease.state, 'fulfilled');
  assert.equal(device.resumes, 3);
  assert.equal(h.devices().length, 1);
  assert.equal(h.device().closes, 0);
  lease.value!.release();
});

test('freeze: building inside a start does not use up its budget (a 12 s build used to fail the start and rebuild every time)', LIMIT, async t => {
  const h = harness(t, { buildMs: 12_000 });
  const lease = observe(h.audio.acquire()); // no warm(): this start has to build
  await h.w.advance(60);
  assert.equal(lease.state, 'fulfilled', 'the device ran 50 ms after the 12 s build');
  assert.equal(h.audio.lastBuildMs, 12_000);
  assert.equal(h.audio.lastStartMs, 12_050);
  assert.equal(h.devices().length, 1);
  assert.equal(h.device().closes, 0);
  lease.value!.release();
});

test('freeze: built while the window is hidden, the context is resumed (not rebuilt) once she is visible and speaks', LIMIT, async t => {
  const h = harness(t, { hidden: true });
  h.audio.warm();
  h.show();
  const lease = observe(h.audio.acquire());
  await h.w.advance(60);
  assert.equal(lease.state, 'fulfilled');
  assert.equal(h.devices().length, 1);
  lease.value!.release();
});

test('freeze: a context the browser closed is rebuilt once, while nothing plays, not when the next reading begins', LIMIT, async t => {
  const h = harness(t, { eventful: true });
  h.audio.warm();
  await read(h);
  h.events(0).browserClose();
  assert.equal(h.devices().length, 1, 'not in the browser\'s own event');
  await h.w.advance(1);
  assert.equal(h.devices().length, 2, 'rebuilt in a task of its own while idle');
  h.events(0).browserClose(); // a late event from the old context changes nothing
  await h.w.advance(10);
  assert.equal(h.devices().length, 2, 'once');
  const lease = observe(h.audio.acquire());
  await flush();
  assert.equal(h.devices().length, 2, 'the next reading builds nothing');
  await h.w.advance(60);
  assert.equal(lease.state, 'fulfilled');
  assert.equal(lease.value!.context, h.devices()[1] as unknown as AudioContext);
  lease.value!.release();
  assert.equal(h.audio.builds, 2);
});

test('freeze: a context broken while a reading holds it is rebuilt after that reading lets go', LIMIT, async t => {
  const h = harness(t, { eventful: true });
  h.audio.warm();
  const lease = observe(h.audio.acquire());
  await h.w.advance(60);
  assert.equal(lease.state, 'fulfilled');
  h.events(0).browserError();
  await h.w.advance(500);
  assert.equal(h.devices().length, 1, 'no build under a reading');
  lease.value!.release();
  await h.w.advance(1);
  assert.equal(h.devices().length, 2, 'rebuilt once the reading let go');
  assert.equal(h.device(0).closes, 1, 'the broken one is let go');
  const next = observe(h.audio.acquire());
  await h.w.advance(60);
  assert.equal(next.value!.context, h.devices()[1] as unknown as AudioContext);
  next.value!.release();
});

test('freeze: a context closed under a start that is waiting is rebuilt for it once, and the start is served', LIMIT, async t => {
  const h = harness(t, { eventful: true, deviceStartMs: 3000 });
  h.audio.warm();
  const lease = observe(h.audio.acquire());
  await h.w.advance(100);
  // The browser closes it while the start waits: its resume is refused.
  const device = h.device() as unknown as { resume(): Promise<void> };
  device.resume = () => Promise.reject(new Error('InvalidStateError'));
  h.events(0).browserClose();
  assert.equal(h.devices().length, 2, 'rebuilt at once for the reading that waits');
  await h.w.advance(3010);
  assert.equal(lease.state, 'fulfilled', 'the reading waits through one rebuild and is served');
  assert.equal(lease.value!.context, h.devices()[1] as unknown as AudioContext);
  assert.equal(h.devices().length, 2);
  lease.value!.release();
});

test('freeze: a real build leaves one User Timing measure (name only) for probes', LIMIT, async t => {
  world(t); // puts a fake AudioContext on globalThis
  performance.clearMeasures(AUDIO_CONTEXT_BUILD_MEASURE);
  const audio = new SharedAudioOutput({ visibility: null });
  t.after(() => { audio.dispose(); performance.clearMeasures(AUDIO_CONTEXT_BUILD_MEASURE); });
  assert.equal(audio.warm(), true);
  assert.equal(audio.warm(), false);
  assert.equal(performance.getEntriesByName(AUDIO_CONTEXT_BUILD_MEASURE).length, 1);
  assert.equal(audio.builds, 1);
});

/*
 * 2026-11-06, the user: "运行程序的第一句总是不会朗读". Stable ffbeec8 built the context at init but never started its
 * device, so the first reading after launch paid the whole cold device start (measured 6.5 s, earlier builds 8-18 s) and
 * the user, hearing nothing, sent the next message, which cancelled it. Later readings were fast (device already running).
 */
test('first reply after launch: warm() starts the device too, so the first reading is not the one that waits for it', LIMIT, async t => {
  const h = harness(t, { idleMs: 120_000, deviceStartMs: 6500 });
  assert.equal(h.audio.warm(), true);
  assert.equal(h.device().resumes, 1, 'the cold device start begins at init, while the model loads');
  await h.w.advance(7000); // the model loads, the user types, the reply is generated
  h.audio.prewarm(); // chat sent
  const lease = observe(h.audio.acquire());
  await flush();
  assert.equal(lease.state, 'fulfilled', 'the first reading finds a running device');
  assert.equal(lease.value!.startMs, 0);
  lease.value!.release();
});

test('first reply after launch: a device still starting when the reading wants it is waited for, never dropped', LIMIT, async t => {
  const h = harness(t, { idleMs: 120_000, deviceStartMs: 6500 });
  h.audio.warm();
  await h.w.advance(1000);
  const lease = observe(h.audio.acquire());
  await h.w.advance(5600);
  assert.equal(lease.state, 'fulfilled', 'one start shared with the init warm-up: ready 6.5 s after init, not 6.5 s after the reading');
  assert.equal(h.device().resumes, 1);
  lease.value!.release();
});

test('first reply after launch: a hidden window whose start never returns is asked again when shown, and builds nothing new', LIMIT, async t => {
  const h = harness(t, { idleMs: 120_000, deviceStartMs: 50, hidden: true });
  h.audio.warm();
  const device = h.device() as unknown as { resume(): Promise<void> };
  const real = device.resume.bind(device);
  let hang = true;
  device.resume = () => hang ? new Promise<void>(() => {}) : real();
  await h.w.advance(AUDIO_OUTPUT_START_TIMEOUT_MS + 100); // the warm-up start is given up while hidden
  hang = false;
  h.show(); // retried once when shown
  await h.w.advance(200);
  assert.equal(h.device().state, 'running');
  const lease = observe(h.audio.acquire());
  await flush();
  assert.equal(lease.state, 'fulfilled');
  assert.equal(lease.value!.startMs, 0);
  assert.equal(h.devices().length, 1);
  lease.value!.release();
});
