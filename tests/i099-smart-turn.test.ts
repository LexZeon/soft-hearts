// I-099 / I-100: Smart Turn v3.2 in calls — she hears whether you have finished, not only that you went quiet.
//  - the model file (BSD-2-Clause, pinned official CPU ONNX, bundled, hash-checked, credited);
//  - our own log-mel front end (properties that can be checked without a reference);
//  - the process boundary (protocol, worker, host, bridge);
//  - the decision logic (judge) and MediaInput in a call with a fake model: complete → end now, not yet → wait up to the cap,
//    resumed → one turn, any failure / no VAD / outside a call → exactly the old silence rule;
//  - the closed journal field.
// Synthetic audio and fake probabilities; no microphone, no Claude, no network. The real model is in i099-smart-turn-real.test.ts (opt-in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import smartTurn from '../shared/voice/smart-turn.json';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { melFilterBank, powerSpectrum, smartTurnFeatures, turnWindow, TURN_FRAMES, TURN_MELS, TURN_SAMPLES } from '../electron/senses/asr/smart-turn-features';
import { SmartTurn } from '../electron/senses/asr/smart-turn';
import { checkedTurnPcm, parseAsrHostMessage, parseAsrWorkerMessage } from '../electron/senses/asr/protocol';
import { LocalAsrHost, TURN_REQUEST_TIMEOUT_MS, type AsrWorkerHandle } from '../electron/senses/asr/host';
import { startAsrWorker } from '../electron/senses/asr/worker';
import type { AsrOrtLike } from '../electron/senses/asr/engine';
import { CallVadBridge, loadSmartTurnModel } from '../electron/voice/voice-call/vad';
import { CallTurnStream, TurnEndJudge, toTurnAudio } from '../src/voice/voice-call/turn-end';
import { CallTurnClock } from '../src/voice/voice-call/turn-clock';
import { MediaInput, type CallInputEvent } from '../src/senses/MediaInput';
import { syntheticSpeech } from './helpers/synthetic-speech';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ROOT = path.resolve('.');
const K = VOICE_CALL_KNOBS.turn;

// ================================================================ the model file

test('the bundled Smart Turn is the official v3.2 CPU file at the pinned revision: size and SHA-256 pinned, BSD-2 licence beside it, credited with the data caveat', async () => {
  const model = await readFile(path.join(ROOT, 'assets/bundled', smartTurn.model.relativePath));
  assert.equal(model.length, 8_679_182); assert.equal(smartTurn.model.bytes, 8_679_182);
  assert.equal(createHash('sha256').update(model).digest('hex'), smartTurn.model.sha256);
  assert.equal(smartTurn.revision, 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93');
  assert.equal(smartTurn.url, `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/${smartTurn.revision}/smart-turn-v3.2-cpu.onnx`);
  const licence = await readFile(path.join(ROOT, 'assets/bundled', smartTurn.licenseFile.relativePath));
  assert.equal(createHash('sha256').update(licence).digest('hex'), smartTurn.licenseFile.sha256);
  assert.match(licence.toString('utf8'), /^BSD 2-Clause License/); assert.ok(licence.toString('utf8').includes(smartTurn.license.attribution));
  const notices = await readFile(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const needle of [smartTurn.model.sha256, smartTurn.licenseFile.sha256, 'pipecat-ai/smart-turn', 'BSD 2-Clause', 'CC BY 4.0', 'Not verified', smartTurn.revision]) assert.ok(notices.includes(needle), needle);
  assert.ok((await readFile(path.join(ROOT, 'ACKNOWLEDGEMENTS.md'), 'utf8')).includes('pipecat-ai/smart-turn'));
});

test('the host loads the model only when its size and hash match (a changed or missing file: the call goes by silence)', () => {
  const file = path.join(ROOT, 'assets/bundled', smartTurn.model.relativePath);
  const loaded = loadSmartTurnModel(file);
  assert.ok(loaded); assert.equal(loaded.bytes.byteLength, smartTurn.model.bytes); assert.equal(loaded.sha256, smartTurn.model.sha256);
  const changed = Uint8Array.from(readFileSync(file)); changed[1000] ^= 1;
  assert.equal(loadSmartTurnModel(file, () => changed), null);
  assert.equal(loadSmartTurnModel(file, () => changed.slice(1)), null);
  assert.equal(loadSmartTurnModel(path.join(ROOT, 'assets/bundled/smart-turn/nope.onnx')), null);
});

// ================================================================ the front end

test('features: 80 mel bins x 800 frames for any input length; the last 8 s are used, shorter audio is padded with zeros IN FRONT', () => {
  assert.equal(smartTurnFeatures(new Float32Array(16_000)).length, TURN_MELS * TURN_FRAMES);
  assert.equal(TURN_MELS * TURN_FRAMES, 64_000); assert.equal(TURN_SAMPLES, 128_000);
  const long = syntheticSpeech(16_000 * 10, 2);
  assert.deepEqual(smartTurnFeatures(long), smartTurnFeatures(long.subarray(16_000 * 2)), 'only the newest 8 s count');
  const short = syntheticSpeech(16_000, 3);
  const window = turnWindow(short);
  assert.equal(window.length, TURN_SAMPLES);
  assert.ok(window.subarray(0, TURN_SAMPLES - short.length).every(v => v === 0), 'zeros in front');
  assert.deepEqual(window.subarray(TURN_SAMPLES - short.length), short, 'the end of the audio is the end of the window');
  const features = smartTurnFeatures(short);
  const column = (frame: number) => Array.from({ length: TURN_MELS }, (_, m) => features[m * TURN_FRAMES + frame]);
  assert.deepEqual(column(5), column(500), 'the padded front is one constant stretch');
  assert.notDeepEqual(column(5), column(TURN_FRAMES - 5), 'the speech at the end is not');
});

test('features: silence gives the floor value everywhere; the scale of the signal does not matter; the values stay within two units of the loudest', () => {
  const silence = smartTurnFeatures(new Float32Array(48_000));
  assert.ok(silence.every(v => v === -1.5), 'log floor 1e-10 → (−10 + 4) / 4');
  const speech = syntheticSpeech(48_000, 1), quiet = speech.map(v => v * 0.5);
  const a = smartTurnFeatures(speech), b = smartTurnFeatures(quiet);
  let worst = 0, high = -Infinity, low = Infinity;
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - b[i])); high = Math.max(high, a[i]); low = Math.min(low, a[i]); assert.ok(Number.isFinite(a[i])); }
  assert.ok(worst < 1e-3, `gain changes the features by at most ${worst}`);
  assert.ok(high - low <= 2 + 1e-6, `range ${low}..${high}: nothing below the loudest minus 8 (in log10), i.e. two units after the /4`);
});

test('features: a pure tone lands in the mel bin the Slaney scale says, and higher tones in higher bins', () => {
  const tone = (hz: number) => Float32Array.from({ length: 16_000 * 4 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * hz * i / 16_000));
  const peak = (hz: number) => {
    const features = smartTurnFeatures(tone(hz)), frame = TURN_FRAMES - 100;
    let best = 0;
    for (let m = 1; m < TURN_MELS; m++) if (features[m * TURN_FRAMES + frame] > features[best * TURN_FRAMES + frame]) best = m;
    return best;
  };
  // Slaney: 1000 Hz = 15 mel, 8000 Hz = 45.25 mel; 82 equally spaced edges → bin i peaks at edge i + 1: (1000 Hz → 25.9, 4000 Hz → 61.9)
  const mel = (hz: number) => hz >= 1000 ? 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27) : hz / (200 / 3);
  for (const hz of [300, 1000, 2500, 4000, 6500]) {
    const expected = mel(hz) / (mel(8000) / 81) - 1;
    assert.ok(Math.abs(peak(hz) - expected) <= 1, `${hz} Hz: bin ${peak(hz)} vs ${expected.toFixed(1)}`);
  }
  assert.ok(peak(300) < peak(1000) && peak(1000) < peak(2500) && peak(2500) < peak(4000) && peak(4000) < peak(6500));
});

test('features: the 400-point FFT agrees with a plain DFT, and the mel filters are 80 area-normalised triangles over 0–8000 Hz', () => {
  let x = 5; const frame = Float64Array.from({ length: 400 }, () => { x = (x * 9301 + 49297) % 233280; return x / 233280 - 0.5; });
  const power = new Float64Array(201); powerSpectrum(frame, power);
  for (const k of [0, 1, 2, 7, 50, 133, 199, 200]) {
    let re = 0, im = 0;
    for (let n = 0; n < 400; n++) { re += frame[n] * Math.cos(2 * Math.PI * k * n / 400); im -= frame[n] * Math.sin(2 * Math.PI * k * n / 400); }
    assert.ok(Math.abs(power[k] - (re * re + im * im)) < 1e-9 * Math.max(1, re * re + im * im), `bin ${k}`);
  }
  const bank = melFilterBank();
  assert.equal(bank.length, 80);
  assert.ok(bank.every(row => row.length === 201 && row.every(v => v >= 0)));
  assert.equal(bank[0][0], 0, 'the first triangle starts above 0 Hz');
  assert.ok(bank[79][200] === 0 || bank[79][199] > 0, 'the last triangle ends at 8000 Hz');
  for (const m of [20, 40, 60, 79]) {
    const area = bank[m].reduce((a, b) => a + b, 0) * 40; // Hz per bin
    assert.ok(Math.abs(area - 1) < 0.12, `filter ${m}: area ${area.toFixed(3)} (Slaney: 1)`);
  }
});

// ================================================================ the process boundary

test('protocol: Smart Turn requests carry only a bounded finite turn (up to 8 s); answers only a probability in [0, 1]', () => {
  const pcm = new Float32Array(16_000).fill(0.1);
  assert.deepEqual(parseAsrHostMessage({ type: 'turn', id: 't1', pcm }), { type: 'turn', id: 't1', pcm });
  assert.ok(parseAsrHostMessage({ type: 'turn', id: 't1', pcm: new Float32Array(TURN_SAMPLES) }), 'exactly 8 s');
  assert.equal(parseAsrHostMessage({ type: 'turn', id: 't1', pcm: new Float32Array(TURN_SAMPLES + 1) }), null);
  assert.equal(parseAsrHostMessage({ type: 'turn', id: 't1', pcm: new Float32Array(0) }), null);
  assert.equal(parseAsrHostMessage({ type: 'turn', id: 't1', pcm: [0.1, 0.2] }), null);
  assert.equal(parseAsrHostMessage({ type: 'turn', id: 'bad id!', pcm }), null);
  assert.equal(checkedTurnPcm(Float32Array.of(0.1, NaN)), null); assert.equal(checkedTurnPcm(Float32Array.of(0.1, 99)), null);
  assert.equal(parseAsrHostMessage({ type: 'turn-init', model: new ArrayBuffer(8), sha256: 'zz' }), null);
  assert.ok(parseAsrHostMessage({ type: 'turn-init', model: new ArrayBuffer(8), sha256: 'a'.repeat(64) }));
  assert.equal(parseAsrHostMessage({ type: 'turn-init', model: new ArrayBuffer(30_000_000), sha256: 'a'.repeat(64) }), null);
  assert.deepEqual(parseAsrWorkerMessage({ type: 'turn-result', id: 't1', p: 0.25 }), { type: 'turn-result', id: 't1', p: 0.25 });
  for (const p of [-0.1, 1.1, NaN, '0.5', null]) assert.equal(parseAsrWorkerMessage({ type: 'turn-result', id: 't1', p }), null);
  assert.equal(parseAsrWorkerMessage({ type: 'turn-result', id: 't1', p: 0.5, text: '秘密' }), null, 'no extra fields');
  assert.deepEqual(parseAsrWorkerMessage({ type: 'turn-ready' }), { type: 'turn-ready' });
  assert.deepEqual(parseAsrWorkerMessage({ type: 'turn-failed' }), { type: 'turn-failed' });
  assert.deepEqual(parseAsrWorkerMessage({ type: 'turn-error', id: 't1' }), { type: 'turn-error', id: 't1' });
});

/** A fake onnxruntime: the Smart Turn session answers `answer(features)`; records what it was fed. */
function fakeTurnOrt(answer: (features: Float32Array) => number, log: { dims: number[][]; names: string[] } = { dims: [], names: [] }) {
  const session = { inputNames: ['input_features'], outputNames: ['logits'],
    run: async (feeds: Record<string, unknown>) => {
      const [name, tensor] = Object.entries(feeds)[0] as [string, { data: Float32Array; dims: number[] }];
      log.names.push(name); log.dims.push(tensor.dims);
      return { logits: { data: [answer(tensor.data)], dims: [1, 1] } };
    }, release: async () => {} };
  return { session, log, ort: { InferenceSession: { create: async () => session }, Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} } } };
}

test('engine: audio becomes one [1, 80, 800] float32 input named input_features; the answer is clamped to [0, 1]; too long / empty audio is refused', async () => {
  const fake = fakeTurnOrt(features => features.length === 64_000 ? 0.75 : 5);
  const turn = await SmartTurn.open(fake.ort as never, new Uint8Array(4));
  assert.equal(await turn.complete(syntheticSpeech(16_000, 1)), 0.75);
  assert.deepEqual(fake.log.dims, [[1, 80, 800]]); assert.deepEqual(fake.log.names, ['input_features']);
  const loud = fakeTurnOrt(() => 4), loudTurn = await SmartTurn.open(loud.ort as never, new Uint8Array(4));
  assert.equal(await loudTurn.complete(new Float32Array(100)), 1);
  await assert.rejects(turn.complete(new Float32Array(TURN_SAMPLES + 1)));
  await assert.rejects(turn.complete(new Float32Array(0)));
  const wrong = { InferenceSession: { create: async () => ({ ...fake.session, inputNames: ['x'] }) }, Tensor: fake.ort.Tensor };
  await assert.rejects(SmartTurn.open(wrong as never, new Uint8Array(4)), /unexpected/);
  const nan = fakeTurnOrt(() => NaN);
  await assert.rejects((await SmartTurn.open(nan.ort as never, new Uint8Array(4))).complete(new Float32Array(10)));
  await turn.release();
  await assert.rejects(turn.complete(new Float32Array(10)), /released/);
});

test('speech process: Smart Turn loads from checked bytes after the recognizer on its own lane; a bad hash is refused', async () => {
  const fake = fakeTurnOrt(() => 0.83);
  const ort = { InferenceSession: { create: async (what: unknown) => { if (typeof what === 'string') throw new Error('no recognizer in this test'); return fake.session; } }, Tensor: fake.ort.Tensor } as unknown as AsrOrtLike;
  const sent: Record<string, unknown>[] = [];
  let listener: (event: { data: unknown }) => void = () => {};
  startAsrWorker({ on: (_e, l) => { listener = l; }, postMessage: m => sent.push(m as Record<string, unknown>) }, () => ort, () => {}, () => 0);
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  const until = async (check: () => boolean) => { for (const end = Date.now() + 3000; !check() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5)); };
  // the recognizer never became ready in this test (runtime loads, model refuses), so Smart Turn is not offered either
  listener({ data: { type: 'turn-init', model: new Uint8Array([1, 2]).buffer, sha256: hash(new Uint8Array([1, 2])) } });
  await until(() => sent.some(m => m.type === 'turn-failed'));
  assert.ok(sent.some(m => m.type === 'turn-failed'), 'no runtime yet: refused, never fatal');
  listener({ data: { type: 'turn', id: 't0', pcm: new Float32Array(100) } });
  await until(() => sent.some(m => m.type === 'turn-error'));
  assert.deepEqual(sent.find(m => m.type === 'turn-error'), { type: 'turn-error', id: 't0' });
  // with a runtime (a started recognizer) the bytes are checked again and then used
  const dirModel = new Uint8Array([7, 7, 7]);
  const worker = startWithRuntime(ort);
  worker.listener({ data: { type: 'turn-init', model: dirModel.buffer.slice(0), sha256: '0'.repeat(64) } });
  await until(() => worker.sent.some(m => m.type === 'turn-failed'));
  assert.ok(worker.sent.some(m => m.type === 'turn-failed'), 'bytes that do not match their hash are refused');
  worker.listener({ data: { type: 'turn-init', model: dirModel.buffer.slice(0), sha256: hash(dirModel) } });
  await until(() => worker.sent.some(m => m.type === 'turn-ready'));
  worker.listener({ data: { type: 'turn', id: 't1', pcm: syntheticSpeech(32_000, 1) } });
  await until(() => worker.sent.some(m => m.type === 'turn-result'));
  assert.deepEqual(worker.sent.find(m => m.type === 'turn-result'), { type: 'turn-result', id: 't1', p: 0.83 });
});

/** A worker whose recognizer runtime is loaded (an init with a missing model leaves `runtime` set; Smart Turn only needs the runtime). */
function startWithRuntime(ort: AsrOrtLike) {
  const sent: Record<string, unknown>[] = [];
  let listener: (event: { data: unknown }) => void = () => {};
  startAsrWorker({ on: (_e, l) => { listener = l; }, postMessage: m => sent.push(m as Record<string, unknown>) }, () => ort, () => {}, () => 0);
  listener({ data: { type: 'init', runtimeEntry: path.join(ROOT, 'ort'), model: path.join(ROOT, 'no-such-model.onnx'), modelSize: 1, modelSha256: 'a'.repeat(64), tokens: path.join(ROOT, 'no-such-tokens.txt'), tokensSha256: 'a'.repeat(64), threads: 2 } });
  return { sent, get listener() { return listener; } };
}

function clock() {
  let now = 0, id = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => { due.set(++id, { at: now + ms, run }); return id; },
    clearTimer: (handle: unknown) => { due.delete(handle as number); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].run(); await flush();
      }
      now = end;
    },
  };
}
function fakeStore(installed = true) {
  return { installed, working: false, downloadBytes: 1, officialDownloadBytes: 1, installedBytes: 1,
    installedDir: () => installed ? 'C:\\components\\asr' : null, installedFile: (to: string) => installed ? `C:\\components\\asr\\${to}` : null,
    refresh: async () => installed, install: async () => {}, importFiles: async () => ({ accepted: 0, rejected: 0, complete: false }), remove: async () => {} };
}
function asrHost(options: { installed?: boolean; model?: { bytes: Uint8Array; sha256: string } | null } = {}) {
  const time = clock(), made: { sent: Record<string, unknown>[]; message?: (m: unknown) => void; exit?: (code: number) => void }[] = [];
  const fork = (): AsrWorkerHandle => {
    const worker = { sent: [] as Record<string, unknown>[], message: undefined as ((m: unknown) => void) | undefined, exit: undefined as ((code: number) => void) | undefined };
    made.push(worker);
    return { postMessage: message => { worker.sent.push(message as Record<string, unknown>); }, onMessage: l => { worker.message = l; }, onExit: l => { worker.exit = l; }, kill: () => { worker.exit?.(1); } };
  };
  const model = options.model === undefined ? { bytes: new Uint8Array([9, 9]), sha256: 'a'.repeat(64) } : options.model;
  const value = new LocalAsrHost({ store: fakeStore(options.installed ?? true) as never, fork, publish() {}, promptRaised() {}, setTimer: time.setTimer, clearTimer: time.clearTimer, turnModel: () => model });
  return { value, time, made };
}

test('recognizer host: the first turn loads Smart Turn once from the bundled bytes, after the recognizer is ready; the answer is one probability; nothing is retried', async () => {
  const h = asrHost();
  const first = h.value.turn(new Float32Array(16_000).fill(0.1));
  await flush();
  const worker = h.made[0];
  assert.deepEqual(worker.sent.map(m => m.type), ['init'], 'nothing about Smart Turn before the recognizer is ready');
  worker.message!({ type: 'ready', loadMs: 5 }); await flush();
  assert.deepEqual(worker.sent.map(m => m.type), ['init', 'turn-init']);
  assert.deepEqual(new Uint8Array(worker.sent[1].model as ArrayBuffer), new Uint8Array([9, 9]));
  worker.message!({ type: 'turn-ready' }); await flush();
  const request = worker.sent[2];
  assert.equal(request.type, 'turn'); assert.equal((request.pcm as Float32Array).length, 16_000);
  worker.message!({ type: 'turn-result', id: request.id, p: 0.9 });
  assert.equal(await first, 0.9);
  const second = h.value.turn(new Float32Array(100)); await flush();
  assert.equal(worker.sent.filter(m => m.type === 'turn-init').length, 1, 'loaded once per process');
  worker.message!({ type: 'turn-error', id: worker.sent.at(-1)!.id });
  assert.equal(await second, null);
  const slow = h.value.turn(new Float32Array(100)); await flush();
  await h.time.advance(TURN_REQUEST_TIMEOUT_MS);
  assert.equal(await slow, null, 'too slow: this pause goes by silence');
  // without the model / the component / after a failed load
  const none = asrHost({ model: null });
  const a = none.value.turn(new Float32Array(10)); await flush();
  none.made[0].message!({ type: 'ready', loadMs: 1 }); await flush();
  assert.equal(await a, null); assert.ok(!none.made[0].sent.some(m => m.type === 'turn-init'));
  const missing = asrHost({ installed: false });
  assert.equal(await missing.value.turn(new Float32Array(10)), null); assert.equal(missing.made.length, 0, 'no process for a call without the component');
  const failing = asrHost();
  const b = failing.value.turn(new Float32Array(10)); await flush();
  failing.made[0].message!({ type: 'ready', loadMs: 1 }); await flush();
  failing.made[0].message!({ type: 'turn-failed' });
  assert.equal(await b, null); assert.equal(await failing.value.turn(new Float32Array(10)), null);
  assert.equal(failing.made[0].sent.filter(m => m.type === 'turn-init').length, 1);
});

test('host bridge: only the call\'s own window, only while it owns the microphone, only checked samples; the answer is dropped if the call ended meanwhile', async () => {
  let callOwner: 'pet' | 'controls' | null = 'controls', micOwner: string | null = 'controls';
  const asked: number[] = [];
  let answer: (p: number | null) => void = () => {};
  const bridge = new CallVadBridge({ callOwner: () => callOwner, microphoneOwner: () => micOwner,
    engine: () => ({ vad: async () => null, turn: pcm => { asked.push(pcm.length); return new Promise(resolve => { answer = resolve; }); } }) });
  const pcm = new Float32Array(16_000).fill(0.01);
  assert.equal(await bridge.probeTurn('pet', pcm), null, 'the other window');
  micOwner = 'pet';
  assert.equal(await bridge.probeTurn('controls', pcm), null, 'the microphone belongs to another window');
  micOwner = 'controls';
  assert.equal(await bridge.probeTurn('controls', [0.1, 0.2]), null);
  assert.equal(await bridge.probeTurn('controls', new Float32Array(TURN_SAMPLES + 1)), null);
  assert.deepEqual(asked, [], 'none of those reached the recognizer');
  const live = bridge.probeTurn('controls', pcm); await flush(); answer(0.7);
  assert.equal(await live, 0.7);
  const bad = bridge.probeTurn('controls', pcm); await flush(); answer(1.5);
  assert.equal(await bad, null, 'not a probability');
  const late = bridge.probeTurn('controls', pcm); await flush(); callOwner = null; answer(0.9);
  assert.equal(await late, null, 'hung up while it was being heard');
  assert.equal(await bridge.probeTurn('controls', pcm), null, 'no call');
  callOwner = 'controls';
  const noTurn = new CallVadBridge({ callOwner: () => 'controls', microphoneOwner: () => 'controls', engine: () => ({ vad: async () => null }) });
  assert.equal(await noTurn.probeTurn('controls', pcm), null, 'an engine without it');
  const noEngine = new CallVadBridge({ callOwner: () => 'controls', microphoneOwner: () => 'controls', engine: () => null });
  assert.equal(await noEngine.probeTurn('controls', pcm), null, 'not the local recognizer (a transcription address): silence');
});

// ================================================================ the window side

test('stream: a call warms the model up; any failure falls back to silence, a run of them for the rest of the call', async () => {
  const time = clock(), calls: number[] = [];
  let reply: () => Promise<number | null> = async () => 0.4;
  const stream = new CallTurnStream(() => ({ voiceCallTurn: async pcm => { calls.push(pcm.length); return reply(); } }), K, { set: time.setTimer, clear: time.clearTimer });
  assert.equal(await stream.ask(new Float32Array(100)), null, 'no call: never asked'); assert.deepEqual(calls, []);
  stream.start(); await flush();
  assert.deepEqual(calls, [16_000], 'one second of silence warms the model');
  assert.equal(stream.ready, true);
  reply = async () => 0.8;
  assert.equal(await stream.ask(new Float32Array(5000)), 0.8);
  reply = async () => 3 as never;
  assert.equal(await stream.ask(new Float32Array(5000)), null, 'not a probability');
  reply = () => new Promise(() => {});
  for (let i = 2; i < K.failLimit; i++) { const pending = stream.ask(new Float32Array(5000)); await time.advance(K.timeoutMs); assert.equal(await pending, null); }
  assert.equal(stream.ready, true);
  const last = stream.ask(new Float32Array(5000)); await time.advance(K.timeoutMs);
  assert.equal(await last, null); assert.equal(stream.status, 'off', 'a run of failures: the rest of the call goes by silence');
  stream.stop(); reply = async () => null;
  stream.start(); await flush();
  assert.equal(stream.status, 'off', 'model missing (the host says null): silence for this call');
  let thrown = 0;
  const throwing = new CallTurnStream(() => { thrown++; throw new Error('no api'); }, K, { set: time.setTimer, clear: time.clearTimer });
  throwing.start(); await flush(); assert.equal(throwing.status, 'off'); assert.ok(thrown > 0);
});

test('audio for the model: 16 kHz from the window\'s rate', () => {
  assert.equal(toTurnAudio(new Float32Array(0), 48_000), null);
  assert.equal(toTurnAudio(new Float32Array(100), 0), null);
  assert.ok(Math.abs(toTurnAudio(new Float32Array(48_000), 48_000)!.length - 16_000) <= 1);
  assert.equal(toTurnAudio(new Float32Array(16_000), 16_000)!.length, 16_000);
});

// ---------------------------------------------------------------- the decision logic

interface Rig { judge: TurnEndJudge; asks: number[]; ended: number; set(p: number | null | 'hang'): void; release(p: number | null): void; stream: { ready: boolean; ask: (pcm: Float32Array) => Promise<number | null> } }
function rig(audio: Float32Array | null = new Float32Array(16_000)): Rig {
  const state = { reply: 0.9 as number | null | 'hang', waiting: [] as ((p: number | null) => void)[] };
  const stream = { ready: true, async ask(pcm: Float32Array) { r.asks.push(pcm.length); return state.reply === 'hang' ? new Promise<number | null>(resolve => state.waiting.push(resolve)) : state.reply; } };
  const r: Rig = { asks: [], ended: 0, stream, set: p => { state.reply = p; }, release: p => { state.waiting.splice(0).forEach(resolve => resolve(p)); },
    judge: new TurnEndJudge(stream, K, { audio: () => audio, endNow: () => { r.ended++; } }) };
  return r;
}
const quiet = (r: Rig, ms: number, step = 50) => { for (let t = 0; t < ms; t += step) r.judge.chunk(false, true, step); };

test('judge: after pauseMs of quiet the model is asked once; complete → the turn ends now (smart-turn); the same pause is never asked again', async () => {
  const r = rig();
  r.judge.chunk(true, true, 100);
  quiet(r, K.pauseMs - 50); await flush();
  assert.deepEqual(r.asks, [], 'not yet');
  quiet(r, 50); await flush();
  assert.equal(r.asks.length, 1); assert.equal(r.ended, 1, 'complete: end now, no waiting for the silence rule');
  assert.equal(r.judge.takeBy(), 'smart-turn');
  assert.equal(r.judge.takeBy(), 'silence', 'taken once');
  const again = rig(); again.judge.chunk(true, true, 100); quiet(again, 3000); await flush();
  assert.equal(again.asks.length, 1, 'one look per pause');
});

test('judge: exactly the threshold counts as finished, just below it does not', async () => {
  const at = rig(); at.set(K.threshold);
  at.judge.chunk(true, true, 100); quiet(at, K.pauseMs); await flush();
  assert.equal(at.ended, 1);
  const below = rig(); below.set(K.threshold - 0.001);
  below.judge.chunk(true, true, 100); quiet(below, K.pauseMs); await flush();
  assert.equal(below.ended, 0);
});

test('judge: not complete → keep waiting up to capMs of silence (smart-waited); speaking again starts the pause over and drops the old answer', async () => {
  const r = rig(); r.set(0.2);
  r.judge.chunk(true, true, 100);
  quiet(r, K.pauseMs); await flush();
  assert.equal(r.ended, 0);
  assert.equal(r.judge.silenceMs(700), K.capMs, 'the silence rule now waits for the long cap');
  assert.equal(r.judge.takeBy(), 'smart-waited');
  const s = rig(); s.set('hang');
  s.judge.chunk(true, true, 100); quiet(s, K.pauseMs); await flush();
  assert.equal(s.judge.silenceMs(700), K.capMs, 'while the model is being heard the turn is not cut');
  s.judge.chunk(true, true, 100); // she hears you speak again
  s.release(0.99); await flush();
  assert.equal(s.ended, 0, 'a late "complete" about the old pause is dropped');
  assert.equal(s.judge.silenceMs(700), K.capMs, 'ready and nothing known yet: the cap stays until the pause is judged');
  quiet(s, K.pauseMs); await flush();
  assert.equal(s.asks.length, 2, 'the new pause is a new look');
});

test('judge: no answer, an error, no audio, no model, or not in a turn → today\'s silence rule, labelled silence', async () => {
  const none = rig(); none.set(null);
  none.judge.chunk(true, true, 100); quiet(none, K.pauseMs); await flush();
  assert.equal(none.judge.silenceMs(700), 700, 'null answer: exactly endpointSilenceMs'); assert.equal(none.ended, 0);
  assert.equal(none.judge.takeBy(), 'silence');
  const noAudio = rig(null);
  noAudio.judge.chunk(true, true, 100); quiet(noAudio, K.pauseMs); await flush();
  assert.equal(noAudio.asks.length, 0); assert.equal(noAudio.judge.silenceMs(700), 700);
  const off = rig(); off.stream.ready = false;
  off.judge.chunk(true, true, 100); quiet(off, 3000); await flush();
  assert.equal(off.asks.length, 0, 'model not ready: never asked'); assert.equal(off.judge.silenceMs(700), 700); assert.equal(off.judge.takeBy(), 'silence');
  const idle = rig(); for (let t = 0; t < 3000; t += 50) idle.judge.chunk(false, false, 50); await flush();
  assert.equal(idle.asks.length, 0, 'no utterance being collected: nothing to judge');
  const thrower = rig(); thrower.stream.ask = async () => { throw new Error('boom'); };
  thrower.judge.chunk(true, true, 100); quiet(thrower, K.pauseMs); await flush();
  assert.equal(thrower.judge.silenceMs(700), 700, 'a throwing model never holds the call up');
});

// ---------------------------------------------------------------- MediaInput in a call, with a fake VAD and a fake turn model

const RATE = 16000, CHUNK = 1024, CHUNK_MS = CHUNK / RATE * 1000; // 64 ms
function chunk(rms: number, seed = 1): Float32Array {
  const out = new Float32Array(CHUNK);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < CHUNK; i++) { x = (x * 9301 + 49297) % 233280; out[i] = (x / 233280 * 2 - 1) * rms * Math.sqrt(3); }
  return out;
}
class FakeVad {
  ready = true; probes = 0; queue: number[] = [];
  start(): void {} stop(): void {}
  async probe(): Promise<readonly number[] | null> { this.probes++; const p = this.queue.shift(); return p === undefined ? null : [p, p]; }
}
class FakeTurn {
  ready = true; started = 0; stopped = 0; asks: { samples: number }[] = []; reply: number | null = 0.9;
  start(): void { this.started++; } stop(): void { this.stopped++; }
  async ask(pcm: Float32Array): Promise<number | null> { this.asks.push({ samples: pcm.length }); return this.ready ? this.reply : null; }
}
interface Mic { media: MediaInput; turn: FakeTurn; vad: FakeVad; signals: string[]; events: CallInputEvent[]; submits: ArrayBuffer[]; step(rms: number, count: number, prob: number): Promise<number | null>; }
async function mic(run: (m: Mic) => Promise<void>, options: { vad?: boolean; turn?: boolean } = {}): Promise<void> {
  const names = ['window', 'performance', 'setTimeout', 'clearTimeout'] as const;
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const realSetTimeout = setTimeout;
  const signals: string[] = [], events: CallInputEvent[] = [], submits: ArrayBuffer[] = [];
  let now = 1000, seq = 0;
  const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  install('performance', { now: () => now });
  install('setTimeout', (fn: () => void) => { queueMicrotask(fn); return 1; });
  install('clearTimeout', () => {});
  install('window', { desktop: {
    openVoiceCapture: async () => ({ captureSessionId: 'capture', epoch: 'epoch' }),
    signalVoiceCapture: async (_id: string, signal: string) => { signals.push(signal); return true; },
    submitVoicePcm: async (value: { wav: ArrayBuffer; captureSeq: number }) => { submits.push(value.wav); return { state: 'queued', groupId: 'g', segmentId: 's' + (++seq), captureSeq: value.captureSeq }; },
    noteJournalFact: async () => true,
  } });
  const vad = new FakeVad(), turn = new FakeTurn();
  const media = new MediaInput({ windowKind: 'controls', pushToTalk: true, onTranscript: () => {}, onError: message => { throw Error(message); },
    onCallEvent: event => events.push(event), ...(options.vad === false ? {} : { callVad: vad }), ...(options.turn === false ? {} : { callTurn: turn }) });
  const tick = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', cameraSharing: false, cameraOwner: null, screenSharing: false });
    media.microphoneReady(true);
    await run({ media, turn, vad, signals, events, submits,
      /** Feeds `count` chunks one by one (letting every answer arrive between them); returns the number of the chunk after which an utterance was handed in, or null. */
      step: async (rms, count, prob) => {
        for (let i = 0; i < count; i++) {
          const before = submits.length;
          vad.queue.push(prob); media.pushVoicePcm(chunk(rms, i + now), RATE); now += CHUNK_MS;
          for (let k = 0; k < 8; k++) await tick();
          if (submits.length > before) return i + 1;
        }
        return null;
      } });
  } finally {
    media.dispose();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
const OLD_CUT = Math.ceil(VOICE_CALL_KNOBS.endpointSilenceMs / CHUNK_MS); // chunks of quiet the old rule needs
const endpoint = (m: Mic) => m.events.find((e): e is Extract<CallInputEvent, { type: 'endpoint' }> => e.type === 'endpoint');

test('call: the model says finished → the turn is handed in after the short pause, long before the silence rule; the endpoint says smart-turn', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    assert.equal(m.turn.started, 1, 'a call warms the turn model');
    assert.equal(await m.step(0.1, 12, 0.9), null);
    const cut = await m.step(0.02, 30, 0.05);
    assert.ok(cut !== null && cut >= Math.ceil(K.pauseMs / CHUNK_MS) && cut < OLD_CUT, `cut after ${cut} quiet chunks (${cut! * CHUNK_MS} ms), the old rule needs ${OLD_CUT}`);
    assert.equal(m.turn.asks.length, 1, 'asked once');
    assert.equal(m.turn.asks[0].samples, 12 * CHUNK + Math.floor(RATE * K.tailMs / 1000), 'the whole turn plus exactly tailMs of its quiet end (the rest of the quiet is trimmed)');
    assert.deepEqual(m.signals, ['speech-start', 'endpoint']);
    assert.equal(endpoint(m)!.by, 'smart-turn');
    assert.equal(m.submits.length, 1);
  });
});

test('call: a long turn gives the model only its newest 8 s (the front of a 10 s turn is not sent)', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    assert.equal(await m.step(0.1, 160, 0.9), null); // 10.2 s of speech
    assert.ok(await m.step(0.02, 30, 0.05) !== null);
    assert.equal(m.turn.asks[0].samples, 8 * RATE, 'exactly the newest 8 s, the quiet end trimmed to tailMs inside it');
    assert.ok(new DataView(m.submits[0]).getUint32(40, true) / 2 / 16000 > 10, 'while recognition still gets the whole turn');
  });
});

test('call: the model says not yet → she keeps listening up to capMs; speaking again is the same turn; the cap ends it (smart-waited)', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS); m.turn.reply = 0.1;
    assert.equal(await m.step(0.1, 12, 0.9), null);
    assert.equal(await m.step(0.02, OLD_CUT + 2, 0.05), null, 'the old rule would have cut by now; she waits'); // +2, not +8: the cap is 1200 ms since 2026-11-19
    assert.equal(m.turn.asks.length, 1);
    assert.equal(await m.step(0.1, 10, 0.9), null, 'speaking again: still one turn');
    assert.equal(m.submits.length, 0);
    const cut = await m.step(0.02, 80, 0.05);
    const capChunks = Math.ceil(K.capMs / CHUNK_MS);
    assert.ok(cut !== null && cut >= capChunks - 1 && cut <= capChunks + 1, `cut after ${cut} chunks, the cap is ${capChunks}`);
    assert.equal(m.turn.asks.length, 2, 'the new pause was looked at once more');
    assert.equal(endpoint(m)!.by, 'smart-waited');
    assert.equal(m.submits.length, 1, 'one turn');
    assert.ok(new DataView(m.submits[0]).getUint32(40, true) / 2 / 16000 > (12 + 10 + OLD_CUT + 2) * CHUNK_MS / 1000, 'both parts of the speech and the pause between them are in the clip');
  });
});

test('call: no answer from the model → exactly today\'s timing, labelled silence', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS); m.turn.reply = null;
    assert.equal(await m.step(0.1, 12, 0.9), null);
    const cut = await m.step(0.02, 40, 0.05);
    assert.equal(cut, OLD_CUT, 'the same chunk the old rule cuts at');
    assert.equal(endpoint(m)!.by, 'silence');
  });
  await mic(async m => { // the same with the model not ready at all: never asked
    m.media.setCall(VOICE_CALL_KNOBS); m.turn.ready = false;
    assert.equal(await m.step(0.1, 12, 0.9), null);
    assert.equal(await m.step(0.02, 40, 0.05), OLD_CUT);
    assert.equal(m.turn.asks.length, 0);
  });
});

test('call: without the VAD (a transcription address) the turn model is never asked; without a call neither; the endpoint rule is the old one', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.vad.ready = false; // loudness decides this call
    for (let i = 0; i < 12; i++) m.media.pushVoicePcm(chunk(0.1, i), RATE);
    let cut: number | null = null;
    for (let i = 0; i < 40 && cut === null; i++) { const before = m.submits.length; m.media.pushVoicePcm(chunk(0.001, 100 + i), RATE); await new Promise<void>(r => setImmediate(r)); await new Promise<void>(r => setImmediate(r)); if (m.submits.length > before) cut = i + 1; }
    assert.equal(m.turn.asks.length, 0, 'loudness only: the model is not asked');
    assert.ok(cut !== null && cut >= OLD_CUT - 1 && cut <= OLD_CUT + 1, `old rule: ${cut}`);
    assert.equal(endpoint(m)?.by, undefined);
  }, { vad: false });
  await mic(async m => { // not in a call: nothing starts, nothing is asked
    for (let i = 0; i < 20; i++) m.media.pushVoicePcm(chunk(0.1, i), RATE);
    await m.step(0.02, 10, 0.05);
    assert.equal(m.turn.started, 0); assert.equal(m.turn.asks.length, 0);
  });
  await mic(async m => { // the call ends: the model is stopped, and nothing is asked afterwards
    m.media.setCall(VOICE_CALL_KNOBS); m.media.setCall(null);
    assert.equal(m.turn.stopped, 1);
    await m.step(0.1, 12, 0.9); await m.step(0.02, 15, 0.05);
    assert.equal(m.turn.asks.length, 0);
  });
  await mic(async m => { // an app without the turn model at all: the old behaviour
    m.media.setCall(VOICE_CALL_KNOBS);
    await m.step(0.1, 12, 0.9);
    assert.equal(await m.step(0.02, 40, 0.05), OLD_CUT);
  }, { turn: false });
});

test('call: the model\'s "finished" while she is already reading (a barge-in turn) or after the turn was cut another way does nothing extra', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    await m.step(0.1, 12, 0.9);
    const cut = await m.step(0.02, 30, 0.05);
    assert.ok(cut !== null);
    const submitted = m.submits.length;
    await m.step(0.02, 20, 0.05);
    assert.equal(m.submits.length, submitted, 'nothing more is handed in by a late answer');
    assert.equal(m.events.filter(e => e.type === 'endpoint').length, 1);
  });
});

// ================================================================ the experience record

test('turn clock and journal: how the end was decided is one of three closed words; no audio, no text', () => {
  let now = 0; const sent: Record<string, unknown>[] = [];
  const clock = new CallTurnClock(() => now, timing => sent.push(timing as never));
  now = 1000; clock.voiced(960, true); now = 1400; clock.endpoint('smart-turn'); now = 2000; clock.firstSound();
  now = 3000; clock.voiced(); now = 5600; clock.endpoint('smart-waited'); now = 6000; clock.firstSound();
  now = 7000; clock.voiced(); now = 7700; clock.endpoint(); now = 8000; clock.firstSound();
  assert.deepEqual(sent.map(s => s.endBy), ['smart-turn', 'smart-waited', 'silence']);
  const base = { type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 400, handInMs: 460, textMs: 520, fillerMs: 700, firstCharMs: 1500, firstSoundMs: 1600, bargeIn: false, endToSoundMs: 800, vad: true };
  const entry = buildJournalEntry({ ...base, endBy: 'smart-turn', words: '秘密', audio: 'AAAA' }, 1)!;
  assert.equal((entry as { endBy?: string }).endBy, 'smart-turn');
  assert.doesNotMatch(JSON.stringify(entry), /秘密|words|audio|AAAA/);
  assert.equal((buildJournalEntry({ ...base, endBy: 'whatever it said' }, 1) as { endBy?: string }).endBy, undefined, 'only the closed words');
  assert.equal((buildJournalEntry(base, 1) as { endBy?: string }).endBy, undefined, 'older lines have none');
  const tr = (s: string, ...args: unknown[]) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s);
  assert.match(describeJournalEntry(entry, tr), /说完了吗模型判断你说完了/);
  assert.match(describeJournalEntry(buildJournalEntry({ ...base, endBy: 'smart-waited' }, 1)!, tr), /还没说完/);
  assert.match(describeJournalEntry(buildJournalEntry({ ...base, endBy: 'silence' }, 1)!, tr), /按安静时长判断/);
});

// ================================================================ the guard: a miscalibrated model can never make a call slower than today

// 2026-11-19: the guard trips at 2 wasted waits of the last 4 (was 3).
test('guard: 2 of the last 4 "not yet" decisions ended by the cap (you never resumed) → the model is off for the rest of the call', async () => {
  const wasted = async (r: Rig) => { r.judge.chunk(true, true, 100); quiet(r, K.pauseMs); await flush(); return r.judge.takeBy(); };
  const resumed = async (r: Rig) => { r.judge.chunk(true, true, 100); quiet(r, K.pauseMs); await flush(); r.judge.chunk(true, true, 100); };
  const r = rig(); r.set(0.1);
  assert.equal(K.guardWasted, 2); assert.equal(K.guardOf, 4);
  assert.equal(await wasted(r), 'smart-waited'); assert.equal(r.judge.offReason, null);
  assert.equal(await wasted(r), 'smart-waited'); assert.equal(r.judge.offReason, 'guard', 'the second wasted wait trips it');
  const asks = r.asks.length;
  r.judge.chunk(true, true, 100); quiet(r, 3000); await flush();
  assert.equal(r.asks.length, asks, 'never asked again in this call');
  assert.equal(r.judge.silenceMs(700), 700, 'exactly the plain silence rule');
  assert.equal(r.judge.takeBy(), 'silence');
  // resuming is the model being right: W R R R W never trips (1 of the last 4 at the end), W R W does (2 of the last 3)
  const mixed = rig(); mixed.set(0.1);
  await wasted(mixed); await resumed(mixed); await resumed(mixed); await resumed(mixed); await wasted(mixed);
  assert.equal(mixed.judge.offReason, null);
  const late = rig(); late.set(0.1);
  await wasted(late); await resumed(late); assert.equal(late.judge.offReason, null);
  await wasted(late); assert.equal(late.judge.offReason, 'guard');
  // a model that says finished is never counted against it
  const good = rig();
  for (let i = 0; i < 6; i++) { good.judge.chunk(true, true, 100); quiet(good, K.pauseMs); await flush(); good.judge.takeBy(); }
  assert.equal(good.judge.offReason, null);
  assert.equal(rig().judge.offReason, null, 'each call has its own judge: a new call starts with the model on');
});

test('guard in a call: two turns that waited to the cap, then the third is cut by the plain rule and the journal says the model is off', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS); m.turn.reply = 0.1;
    for (let turn = 0; turn < 2; turn++) {
      assert.equal(await m.step(0.1, 12, 0.9), null);
      assert.ok(await m.step(0.02, 80, 0.05) !== null, `turn ${turn + 1} ended by the cap`);
    }
    const ends = m.events.filter((e): e is Extract<CallInputEvent, { type: 'endpoint' }> => e.type === 'endpoint');
    assert.deepEqual(ends.map(e => e.by), ['smart-waited', 'smart-waited']);
    assert.deepEqual(ends.map(e => e.smartTurnOff), [undefined, 'guard'], 'the turn that tripped it already says so');
    assert.equal(m.turn.asks.length, 2);
    assert.equal(await m.step(0.1, 12, 0.9), null);
    assert.equal(await m.step(0.02, 40, 0.05), OLD_CUT, 'exactly today\'s timing again');
    assert.equal(m.turn.asks.length, 2, 'not asked in the third turn');
    const last = m.events.filter(e => e.type === 'endpoint').at(-1) as Extract<CallInputEvent, { type: 'endpoint' }>;
    assert.equal(last.by, 'silence'); assert.equal(last.smartTurnOff, 'guard');
  });
  await mic(async m => { // the next call starts with the model on again
    m.media.setCall(VOICE_CALL_KNOBS); m.turn.reply = 0.1;
    for (let turn = 0; turn < 2; turn++) { await m.step(0.1, 12, 0.9); await m.step(0.02, 80, 0.05); }
    m.media.setCall(null); m.media.setCall(VOICE_CALL_KNOBS);
    await m.step(0.1, 12, 0.9);
    assert.equal(await m.step(0.02, 80, 0.05) !== null, true);
    assert.equal(m.turn.asks.length, 3, 'asked again in the new call');
  });
});

test('guard in the experience record: only the closed word "guard"', () => {
  const base = { type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 400, handInMs: 460, textMs: 520, fillerMs: 700, firstCharMs: 1500, firstSoundMs: 1600, bargeIn: false, endToSoundMs: 800, vad: true, endBy: 'smart-waited' };
  assert.equal((buildJournalEntry({ ...base, smartTurnOff: 'guard' }, 1) as { smartTurnOff?: string }).smartTurnOff, 'guard');
  assert.equal((buildJournalEntry({ ...base, smartTurnOff: 'whatever' }, 1) as { smartTurnOff?: string }).smartTurnOff, undefined);
  assert.equal((buildJournalEntry(base, 1) as { smartTurnOff?: string }).smartTurnOff, undefined);
  let now = 0; const sent: Record<string, unknown>[] = [];
  const clock = new CallTurnClock(() => now, timing => sent.push(timing as never));
  now = 1000; clock.voiced(); now = 1700; clock.endpoint('silence', 'guard'); now = 2000; clock.firstSound();
  now = 3000; clock.voiced(); now = 3700; clock.endpoint('silence'); now = 4000; clock.firstSound();
  assert.equal(sent[0].smartTurnOff, 'guard'); assert.equal('smartTurnOff' in sent[1], false);
  const tr = (s: string, ...args: unknown[]) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s);
  assert.match(describeJournalEntry(buildJournalEntry({ ...base, smartTurnOff: 'guard' }, 1)!, tr), /已关掉/);
});
