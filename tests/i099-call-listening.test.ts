// I-099 / I-100: how she listens on a call.
//  - Silero VAD (downloaded with the user's consent, bundled, MIT) decides start / end / talking over her in a call only; the
//    loudness gate stays as the fallback when the model cannot answer.
//  - The local recognizer's own tone tags give her voice turn one closed private line (laughing, crying, angry, sad, happy).
//  - One end-to-end number per call turn: the user's last speech frame → her first sound.
// Synthetic audio frames, a fake VAD probability source, fake processes; no microphone, no Claude, no network. One opt-in test
// loads the real model with the real ONNX Runtime (SOFT_HEARTS_ORT_ENTRY = the component's onnxruntime-node entry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import silero from '../shared/voice/silero-vad.json';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { USER_TONES, turnTone, userToneLine, userToneOf } from '../shared/senses/user-tone';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { SileroVad, VAD_WINDOW, VAD_CONTEXT, type VadOrtLike, type VadOrtSession } from '../electron/senses/asr/vad';
import { parseAsrHostMessage, parseAsrWorkerMessage } from '../electron/senses/asr/protocol';
import { LocalAsrHost, VAD_REQUEST_TIMEOUT_MS, type AsrWorkerHandle } from '../electron/senses/asr/host';
import { startAsrWorker } from '../electron/senses/asr/worker';
import type { AsrOrtLike, AsrOrtSession } from '../electron/senses/asr/engine';
import { VoiceRoute } from '../electron/senses/asr/voice-route';
import { CallVadBridge, loadSileroModel } from '../electron/voice/voice-call/vad';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { BargeInDetector } from '../src/voice/voice-call/barge-in';
import { CallTurnClock } from '../src/voice/voice-call/turn-clock';
import { CallVadStream, ChunkLead, StreamResampler, VadSpeechDetector } from '../src/voice/voice-call/vad';
import { MediaInput, encodeWav, type CallInputEvent } from '../src/senses/MediaInput';
import { onnxWithMetadata, senseVoiceMetadata } from './helpers/onnx-proto';
import { syntheticSpeech } from './helpers/synthetic-speech';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ROOT = path.resolve('.');

// ================================================================ the model file

test('the bundled Silero VAD is the official v6.2 file: size and SHA-256 pinned, MIT licence beside it, credited', async () => {
  const model = await readFile(path.join(ROOT, 'assets/bundled', silero.model.relativePath));
  assert.equal(model.length, silero.model.bytes);
  assert.equal(createHash('sha256').update(model).digest('hex'), silero.model.sha256);
  assert.equal(silero.version, 'v6.2');
  assert.match(silero.url, /^https:\/\/raw\.githubusercontent\.com\/snakers4\/silero-vad\/v6\.2\/src\/silero_vad\/data\/silero_vad\.onnx$/);
  const licence = await readFile(path.join(ROOT, 'assets/bundled', silero.licenseFile.relativePath), 'utf8');
  assert.match(licence, /^MIT License/); assert.ok(licence.includes('Copyright (c) 2020-present Silero Team'));
  const notices = await readFile(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.ok(notices.includes(silero.model.sha256) && notices.includes('snakers4/silero-vad') && notices.includes('MIT'));
  assert.ok((await readFile(path.join(ROOT, 'ACKNOWLEDGEMENTS.md'), 'utf8')).includes('maomao-2001/Whispera'));
});

test('the host loads the model only when its size and hash match (a changed or missing file: the call goes by loudness)', () => {
  const file = path.join(ROOT, 'assets/bundled', silero.model.relativePath);
  const loaded = loadSileroModel(file);
  assert.ok(loaded); assert.equal(loaded.bytes.byteLength, silero.model.bytes); assert.equal(loaded.sha256, silero.model.sha256);
  const changed = Uint8Array.from(readFileSync(file)); changed[100] ^= 1;
  assert.equal(loadSileroModel(file, () => changed), null);
  assert.equal(loadSileroModel(file, () => changed.subarray(1)), null);
  assert.equal(loadSileroModel(path.join(ROOT, 'no-such-model.onnx')), null);
});

// ================================================================ the VAD engine (inside the speech process)

function fakeVadOrt(prob: (input: Float32Array) => number, log: { inputs: Float32Array[]; states: number[] } = { inputs: [], states: [] }) {
  const session: VadOrtSession = {
    inputNames: ['input', 'state', 'sr'], outputNames: ['output', 'stateN'],
    run: async feeds => {
      const input = (feeds.input as { data: Float32Array }).data, state = (feeds.state as { data: Float32Array }).data;
      log.inputs.push(input.slice()); log.states.push(state[0]);
      const next = new Float32Array(256).fill(state[0] + 1);
      return { output: { data: [prob(input)], dims: [1, 1] }, stateN: { data: next, dims: [2, 1, 128] } };
    },
    release: async () => {},
  };
  const ort: VadOrtLike = {
    InferenceSession: { create: async () => session },
    Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} } as never,
  };
  return { ort, session, log };
}

test('VAD engine: 512-sample windows with the 64 samples before each, the state carried, leftovers kept for the next chunk; reset forgets', async () => {
  const fake = fakeVadOrt(input => input[VAD_CONTEXT]);
  const vad = await SileroVad.open(fake.ort, new Uint8Array(4));
  const ramp = Float32Array.from({ length: 1365 }, (_, i) => i / 10_000);
  assert.equal((await vad.push(ramp)).length, 2, '1365 samples: two windows, 341 carried');
  assert.equal((await vad.push(ramp)).length, 3, '341 + 1365 = 1706 samples: three more windows');
  assert.equal(fake.log.inputs[0].length, VAD_CONTEXT + VAD_WINDOW);
  assert.deepEqual(Array.from(fake.log.inputs[0].subarray(0, VAD_CONTEXT)), new Array(VAD_CONTEXT).fill(0), 'the first window has silence before it');
  assert.deepEqual(Array.from(fake.log.inputs[1].subarray(0, VAD_CONTEXT)), Array.from(fake.log.inputs[0].subarray(-VAD_CONTEXT)), 'each window sees the 64 samples before it');
  assert.deepEqual(fake.log.states, [0, 1, 2, 3, 4], 'the recurrent state is carried window to window');
  vad.reset();
  await vad.push(new Float32Array(512));
  assert.equal(fake.log.states.at(-1), 0, 'a new call starts from a fresh state');
  const wrong = fakeVadOrt(() => 0); wrong.session.inputNames = ['x'];
  await assert.rejects(SileroVad.open(wrong.ort, new Uint8Array(4)), /unexpected VAD/);
});

test('VAD engine with the real model and ONNX Runtime (opt-in): silence and a pure tone are not speech, a synthetic vowel stream is', { skip: !process.env.SOFT_HEARTS_ORT_ENTRY && 'set SOFT_HEARTS_ORT_ENTRY to the onnxruntime-node entry to run' }, async () => {
  const ort = createRequire(import.meta.url)(path.resolve(process.env.SOFT_HEARTS_ORT_ENTRY!)) as VadOrtLike;
  const vad = await SileroVad.open(ort, new Uint8Array(readFileSync(path.join(ROOT, 'assets/bundled', silero.model.relativePath))));
  try {
    const silence = await vad.push(new Float32Array(16_000));
    vad.reset();
    const tone = await vad.push(Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 16_000)));
    vad.reset();
    const voice = await vad.push(syntheticSpeech(16_000, 1));
    for (const probs of [silence, tone, voice]) { assert.equal(probs.length, 31); assert.ok(probs.every(p => p >= 0 && p <= 1)); }
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    assert.ok(Math.max(...silence) < 0.1, `silence ${Math.max(...silence)}`);
    assert.ok(mean(tone) < 0.1, `tone ${mean(tone)}`);
    assert.ok(mean(voice) > 0.4 && Math.max(...voice) > 0.9, `synthetic speech ${mean(voice)}`);
    // 48 kHz microphone chunks through the window's resampler give the same verdict (the call path end to end, minus IPC).
    vad.reset();
    const resampler = new StreamResampler(), speech48 = syntheticSpeech(48_000, 1, 48_000), streamed: number[] = [];
    for (let at = 0; at + 4096 <= speech48.length; at += 4096) streamed.push(...await vad.push(resampler.push(speech48.subarray(at, at + 4096), 48_000)));
    assert.ok(mean(streamed) > 0.4, `streamed ${mean(streamed)}`);
    console.log(`real Silero v6.2: silence max ${Math.max(...silence).toFixed(3)}, tone mean ${mean(tone).toFixed(3)}, synthetic speech mean ${mean(voice).toFixed(3)}, streamed 48 kHz mean ${mean(streamed).toFixed(3)}`);
  } finally { await vad.release(); }
});

// ================================================================ the process boundary

test('protocol: VAD requests carry only bounded finite samples; answers carry only probabilities in [0, 1]', () => {
  const pcm = new Float32Array(1365).fill(0.1);
  assert.deepEqual(parseAsrHostMessage({ type: 'vad', id: 'v1', pcm, reset: true })?.type, 'vad');
  assert.equal(parseAsrHostMessage({ type: 'vad', id: 'v1', pcm: new Float32Array(16_001), reset: false }), null, 'more than one second');
  assert.equal(parseAsrHostMessage({ type: 'vad', id: 'v1', pcm: Float32Array.of(0, NaN), reset: false }), null);
  assert.equal(parseAsrHostMessage({ type: 'vad', id: 'v1', pcm: [0.1, 0.2], reset: false }), null, 'only a Float32Array');
  assert.equal(parseAsrHostMessage({ type: 'vad', id: 'v1', pcm, reset: 'yes' }), null);
  assert.equal(parseAsrHostMessage({ type: 'vad-init', model: new ArrayBuffer(8), sha256: 'x' }), null);
  assert.deepEqual(parseAsrWorkerMessage({ type: 'vad-result', id: 'v1', probs: [0, 0.5, 1] }), { type: 'vad-result', id: 'v1', probs: [0, 0.5, 1] });
  for (const probs of [[1.2], [-0.1], [NaN], ['0.5'], new Array(40).fill(0.5)]) assert.equal(parseAsrWorkerMessage({ type: 'vad-result', id: 'v1', probs }), null);
  assert.equal(parseAsrWorkerMessage({ type: 'vad-result', id: 'v1', probs: [0.5], text: 'words' }), null, 'nothing else rides along');
});

test('speech process: the VAD loads from checked bytes after the recognizer, answers on its own lane (a slow recognition does not hold it up)', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'i099-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const model = onnxWithMetadata(senseVoiceMetadata());
  const tokens = ['<unk>', '<s>', '</s>', '<|zh|>', '<|en|>', '<|NEUTRAL|>', '<|Speech|>', '<|withitn|>', '今天', '天气', '真', '好', '。', '▁hi', '<|woitn|>', '<|HAPPY|>', '<|Laughter|>']
    .map((piece, id) => `${piece} ${id}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'model.onnx'), model); writeFileSync(path.join(dir, 'tokens.txt'), tokens);
  let releaseRecognition!: () => void;
  const recognitionGate = new Promise<void>(resolve => { releaseRecognition = resolve; });
  const asrSession: AsrOrtSession = { inputNames: ['x', 'x_length', 'language', 'text_norm'], outputNames: ['logits'],
    run: async () => { await recognitionGate; const best = [3, 16, 15, 7, 11], data = new Float32Array(best.length * 17); best.forEach((id, f) => { data[f * 17 + id] = 9; }); return { logits: { data, dims: [1, best.length, 17] } }; },
    release: async () => {} };
  const vadFake = fakeVadOrt(() => 0.8);
  const ort = { InferenceSession: { create: async (what: unknown) => typeof what === 'string' ? asrSession : vadFake.session },
    Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} } } as unknown as AsrOrtLike;
  const sent: Record<string, unknown>[] = [];
  let listener: (event: { data: unknown }) => void = () => {};
  startAsrWorker({ on: (_e, l) => { listener = l; }, postMessage: m => sent.push(m as Record<string, unknown>) }, () => ort, () => {}, () => 0);
  const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
  const until = async (check: () => boolean) => { for (const end = Date.now() + 3000; !check() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5)); };
  listener({ data: { type: 'init', runtimeEntry: path.join(dir, 'ort'), model: path.join(dir, 'model.onnx'), modelSize: model.length, modelSha256: hash(model),
    tokens: path.join(dir, 'tokens.txt'), tokensSha256: hash(tokens), threads: 2 } });
  await until(() => sent.some(m => m.type === 'ready'));
  const bytes = new Uint8Array([1, 2, 3, 4]);
  listener({ data: { type: 'vad-init', model: bytes.buffer.slice(0), sha256: '0'.repeat(64) } });
  await until(() => sent.some(m => m.type === 'vad-failed'));
  assert.ok(sent.some(m => m.type === 'vad-failed'), 'bytes that do not match their hash are refused');
  listener({ data: { type: 'vad-init', model: bytes.buffer.slice(0), sha256: hash(bytes) } });
  await until(() => sent.some(m => m.type === 'vad-ready'));
  listener({ data: { type: 'recognize', id: 'r1', wav: encodeWav(new Float32Array(16000).fill(0.05)), language: 'zh', tags: true } });
  listener({ data: { type: 'vad', id: 'v1', pcm: new Float32Array(1024).fill(0.1), reset: true } });
  await until(() => sent.some(m => m.type === 'vad-result'));
  assert.deepEqual(sent.find(m => m.type === 'vad-result'), { type: 'vad-result', id: 'v1', probs: [0.8, 0.8] }, 'answered while the recognition is still running');
  assert.ok(!sent.some(m => m.type === 'result'));
  releaseRecognition();
  await until(() => sent.some(m => m.type === 'result'));
  assert.deepEqual((sent.find(m => m.type === 'result') as { tags: unknown }).tags, { language: 'zh', event: 'laughter', emotion: 'happy' }, 'the tone tags come back when asked');
});

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
  const value = new LocalAsrHost({ store: fakeStore(options.installed ?? true) as never, fork, publish() {}, promptRaised() {}, setTimer: time.setTimer, clearTimer: time.clearTimer,
    vadModel: () => model });
  return { value, time, made };
}

test('recognizer host: the first call chunk loads the VAD once from the bundled bytes, after the recognizer is ready; answers are probabilities only', async () => {
  const h = asrHost();
  const first = h.value.vad(new Float32Array(1365).fill(0.1), true);
  await flush();
  const worker = h.made[0];
  assert.deepEqual(worker.sent.map(m => m.type), ['init'], 'nothing about the VAD before the recognizer is ready');
  worker.message!({ type: 'ready', loadMs: 5 }); await flush();
  assert.deepEqual(worker.sent.map(m => m.type), ['init', 'vad-init']);
  assert.deepEqual(new Uint8Array(worker.sent[1].model as ArrayBuffer), new Uint8Array([9, 9]));
  worker.message!({ type: 'vad-ready' }); await flush();
  const request = worker.sent[2];
  assert.equal(request.type, 'vad'); assert.equal(request.reset, true); assert.equal((request.pcm as Float32Array).length, 1365);
  worker.message!({ type: 'vad-result', id: request.id, probs: [0.2, 0.9] });
  assert.deepEqual(await first, [0.2, 0.9]);
  const second = h.value.vad(new Float32Array(1365), false); await flush();
  assert.equal(worker.sent.filter(m => m.type === 'vad-init').length, 1, 'loaded once per process');
  worker.message!({ type: 'vad-error', id: worker.sent.at(-1)!.id });
  assert.equal(await second, null);
  const slow = h.value.vad(new Float32Array(1365), false); await flush();
  await h.time.advance(VAD_REQUEST_TIMEOUT_MS);
  assert.equal(await slow, null, 'too slow: that chunk goes by loudness');
});

test('recognizer host: without the model (or the component, or after a failed load) the VAD answers null and nothing is retried', async () => {
  const none = asrHost({ model: null });
  const a = none.value.vad(new Float32Array(10), true); await flush();
  none.made[0].message!({ type: 'ready', loadMs: 1 }); await flush();
  assert.equal(await a, null);
  assert.ok(!none.made[0].sent.some(m => m.type === 'vad-init'), 'no model: nothing is sent');
  const missing = asrHost({ installed: false });
  assert.equal(await missing.value.vad(new Float32Array(10), true), null);
  assert.equal(missing.made.length, 0, 'no process is started for a call without the component');
  const failing = asrHost();
  const b = failing.value.vad(new Float32Array(10), true); await flush();
  failing.made[0].message!({ type: 'ready', loadMs: 1 }); await flush();
  failing.made[0].message!({ type: 'vad-failed' });
  assert.equal(await b, null);
  assert.equal(await failing.value.vad(new Float32Array(10), false), null);
  assert.equal(failing.made[0].sent.filter(m => m.type === 'vad-init').length, 1);
});

test('host bridge: only the call\'s own window, only while it owns the microphone, only checked samples; the answer is dropped if the call ended meanwhile', async () => {
  let callOwner: 'pet' | 'controls' | null = 'controls', micOwner: string | null = 'controls';
  const asked: number[] = [];
  let answer: (probs: number[]) => void = () => {};
  const bridge = new CallVadBridge({ callOwner: () => callOwner, microphoneOwner: () => micOwner,
    engine: () => ({ vad: pcm => { asked.push(pcm.length); return new Promise(resolve => { answer = resolve; }); } }) });
  const pcm = new Float32Array(1365).fill(0.01);
  assert.equal(await bridge.probe('pet', pcm, false), null, 'the other window');
  micOwner = 'pet';
  assert.equal(await bridge.probe('controls', pcm, false), null, 'the microphone belongs to another window');
  micOwner = 'controls';
  assert.equal(await bridge.probe('controls', [0.1, 0.2], false), null);
  assert.equal(await bridge.probe('controls', new Float32Array(20_000), false), null);
  assert.deepEqual(asked, [], 'none of those reached the recognizer');
  const live = bridge.probe('controls', pcm, true); answer([0.4]);
  assert.deepEqual(await live, [0.4]);
  const late = bridge.probe('controls', pcm, false); callOwner = null; answer([0.9]);
  assert.equal(await late, null, 'hung up while it was being heard');
  assert.equal(await bridge.probe('controls', pcm, false), null, 'no call');
  const noEngine = new CallVadBridge({ callOwner: () => 'controls', microphoneOwner: () => 'controls', engine: () => null });
  assert.equal(await noEngine.probe('controls', pcm, false), null, 'not the local recognizer: loudness');
});

// ================================================================ the window side

test('stream: 48 kHz chunks become 16 kHz without losing samples at the edges', () => {
  const resampler = new StreamResampler();
  let total = 0;
  for (let i = 0; i < 30; i++) total += resampler.push(new Float32Array(4096).fill(0.5), 48_000).length;
  assert.ok(Math.abs(total - 30 * 4096 / 3) <= 1, `${total} samples`);
  assert.ok(resampler.push(new Float32Array(4096).fill(0.5), 48_000).every(v => Math.abs(v - 0.5) < 1e-6));
});

test('stream: a call warms the model up with a fresh stream; any failure falls back to loudness, a run of them for the rest of the call', async () => {
  const time = clock(), calls: { length: number; reset: boolean }[] = [];
  let reply: () => Promise<readonly number[] | null> = async () => [0.1];
  const stream = new CallVadStream(() => ({ voiceCallVad: async (pcm, reset) => { calls.push({ length: pcm.length, reset }); return reply(); } }), VOICE_CALL_KNOBS.vad,
    { set: time.setTimer, clear: time.clearTimer });
  assert.equal(await stream.probe(new Float32Array(4096), 48_000), null, 'no call: never asked');
  stream.start(); await flush();
  assert.deepEqual(calls, [{ length: 512, reset: true }]);
  assert.equal(stream.ready, true);
  reply = async () => [0.3, 0.7, 0.9];
  assert.deepEqual(await stream.probe(new Float32Array(4096), 48_000), [0.3, 0.7, 0.9]);
  assert.equal(calls[1].reset, false); assert.ok(calls[1].length === 1365);
  reply = () => new Promise(() => {}); // the process stops answering
  for (let i = 0; i < VOICE_CALL_KNOBS.vad.failLimit; i++) {
    const pending = stream.probe(new Float32Array(4096), 48_000);
    await time.advance(VOICE_CALL_KNOBS.vad.timeoutMs);
    assert.equal(await pending, null);
  }
  assert.equal(stream.ready, false); assert.equal(stream.status, 'off');
  stream.stop(); reply = async () => null;
  stream.start(); await flush();
  assert.equal(stream.status, 'off', 'model missing (host says null): loudness for this call');
});

// the computer was busy, three answers came late, and the rest of the
// call went by loudness, so any noise counted as speech. Now the model is warmed again after retryAfterMs.
test('stream: after giving up it warms the model again after retryAfterMs, keeps trying while it fails, and stops trying when the call ends', async () => {
  const time = clock(), calls: { length: number; reset: boolean }[] = [];
  let reply: () => Promise<readonly number[] | null> = async () => [0.1];
  const stream = new CallVadStream(() => ({ voiceCallVad: async (pcm, reset) => { calls.push({ length: pcm.length, reset }); return reply(); } }), VOICE_CALL_KNOBS.vad,
    { set: time.setTimer, clear: time.clearTimer });
  stream.start(); await flush();
  assert.equal(stream.status, 'ready');
  reply = () => new Promise(() => {}); // busy: no answer in time
  for (let i = 0; i < VOICE_CALL_KNOBS.vad.failLimit; i++) {
    const pending = stream.probe(new Float32Array(4096), 48_000);
    await time.advance(VOICE_CALL_KNOBS.vad.timeoutMs);
    await pending;
  }
  assert.equal(stream.status, 'off');
  const before = calls.length;
  await time.advance(VOICE_CALL_KNOBS.vad.retryAfterMs - 1);
  assert.equal(calls.length, before, 'not before retryAfterMs');
  reply = async () => null; // still not answering: off again, and another try later
  await time.advance(1); await flush();
  assert.equal(calls.length, before + 1); assert.deepEqual(calls.at(-1), { length: 512, reset: true });
  assert.equal(stream.status, 'off');
  reply = async () => [0.2]; // the computer is free again
  await time.advance(VOICE_CALL_KNOBS.vad.retryAfterMs); await flush();
  assert.equal(stream.status, 'ready', 'the model decides again within the same call');
  // Off again, then the call ends: no more tries.
  reply = async () => null;
  for (let i = 0; i < VOICE_CALL_KNOBS.vad.failLimit; i++) await stream.probe(new Float32Array(4096), 48_000);
  assert.equal(stream.status, 'off');
  stream.stop();
  const after = calls.length;
  await time.advance(VOICE_CALL_KNOBS.vad.retryAfterMs * 3); await flush();
  assert.equal(calls.length, after, 'a finished call is not warmed again');
  assert.equal(stream.status, 'idle');
});

test('detector: the start needs 128 ms of speech in a row; inside an utterance a dip down to 0.35 is still speech; the tail says when it ended', () => {
  const d = new VadSpeechDetector();
  assert.equal(d.push([0.9, 0.9, 0.9], false).speech, false, '96 ms is not a start');
  assert.equal(d.push([0.2], false).speech, false);
  const start = d.push([0.9, 0.9, 0.9, 0.9], false);
  assert.ok(start.speech && start.started);
  assert.equal(d.push([0.4, 0.4], true).speech, true, 'hysteresis inside an utterance');
  const end = d.push([0.8, 0.1, 0.1], true);
  assert.equal(end.speech, true); assert.equal(end.tailMs, 64, 'speech ended two windows before the chunk did');
  assert.equal(d.push([0.1, 0.2], true).speech, false);
  assert.equal(d.push([0.6, 0.6, 0.2, 0.2], true).share, 0.5);
});

test('barge-in with the VAD: over the echo gate AND speech; her echo (speech, below the gate) never; a loud cough or knock (over the gate, not speech) never', () => {
  const RATE = 16000, chunk = (rms: number, seed = 1) => { const out = new Float32Array(1024); let x = seed * 9301 + 49297; for (let i = 0; i < 1024; i++) { x = (x * 9301 + 49297) % 233280; out[i] = (x / 233280 * 2 - 1) * rms * Math.sqrt(3); } return out; };
  const echoOnly = new BargeInDetector();
  for (let i = 0; i < 80; i++) assert.equal(echoOnly.push(chunk(i % 4 < 2 ? 0.035 : 0.02, i), RATE, 0.01, true), false, 'her own voice, which the VAD calls speech');
  const knock = new BargeInDetector(), knockRms = new BargeInDetector();
  let rmsFired = 0;
  for (let i = 0; i < 30; i++) {
    const c = i < 10 ? chunk(0.02, i) : chunk(0.3, i);
    assert.equal(knock.push(c, RATE, 0.01, false), false, 'loud but not speech');
    if (knockRms.push(c, RATE, 0.01)) rmsFired++;
  }
  assert.equal(rmsFired, 1, 'loudness alone would have stopped her');
  const user = new BargeInDetector();
  let fired = 0;
  for (let i = 0; i < 10; i++) user.push(chunk(0.02, i), RATE, 0.01, true);
  for (let i = 0; i < 10; i++) if (user.push(chunk(0.2, i + 50), RATE, 0.01, true)) fired++;
  assert.equal(fired, 1, 'the user talking over her stops her once');
});

// ---------------------------------------------------------------- MediaInput in a call, with a fake VAD

const RATE = 16000, CHUNK = 1024; // 64 ms chunks; two 32 ms windows each
function chunk(rms: number, seed = 1): Float32Array {
  const out = new Float32Array(CHUNK);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < CHUNK; i++) { x = (x * 9301 + 49297) % 233280; out[i] = (x / 233280 * 2 - 1) * rms * Math.sqrt(3); }
  return out;
}
/** A fake VAD: every chunk fed gets the probability the test says (both of its windows). */
class FakeVad {
  ready = true; probes = 0; started = 0; stopped = 0; queue: number[] = [];
  start(): void { this.started++; }
  stop(): void { this.stopped++; }
  async probe(): Promise<readonly number[] | null> { this.probes++; if (!this.ready) return null; const p = this.queue.shift(); return p === undefined ? null : [p, p]; }
}
interface Mic {
  media: MediaInput; vad: FakeVad; signals: string[]; events: CallInputEvent[]; submits: ArrayBuffer[]; now(): number;
  feed(rms: number | Float32Array, count: number, prob?: number): void; settle(): Promise<void>;
}
async function mic(run: (m: Mic) => Promise<void>, options: { vad?: boolean; overHerHeld?: () => boolean } = {}): Promise<void> {
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
  const vad = new FakeVad();
  const media = new MediaInput({ windowKind: 'controls', pushToTalk: true, onTranscript: () => {}, onError: message => { throw Error(message); },
    onCallEvent: event => events.push(event), ...(options.vad === false ? {} : { callVad: vad }), ...(options.overHerHeld ? { overHerHeld: options.overHerHeld } : {}) });
  const tick = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', cameraSharing: false, cameraOwner: null, screenSharing: false });
    media.microphoneReady(true);
    await run({ media, vad, signals, events, submits, now: () => now,
      feed: (value, count, prob = 0) => { for (let i = 0; i < count; i++) { vad.queue.push(prob); media.pushVoicePcm(typeof value === 'number' ? chunk(value, i + now) : value, RATE); now += CHUNK / RATE * 1000; } },
      settle: async () => { for (let i = 0; i < 8; i++) await tick(); } });
  } finally {
    media.dispose();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
const wavSeconds = (wav: ArrayBuffer) => new DataView(wav).getUint32(40, true) / 2 / 16000;
const SILENT_CHUNKS = Math.ceil(VOICE_CALL_KNOBS.endpointSilenceMs / 64);

test('call with the VAD: loud background that is not speech starts nothing; speech starts; the end is the VAD\'s silence even while the room stays loud', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    assert.equal(m.vad.started, 1, 'a call starts a fresh VAD stream');
    m.feed(0.1, 20, 0.02); // music / typing, as loud as speech
    await m.settle();
    assert.deepEqual(m.signals, [], 'not speech: no turn starts');
    m.feed(0.1, 12, 0.9);
    await m.settle();
    assert.deepEqual(m.signals, ['speech-start']);
    m.feed(0.1, SILENT_CHUNKS - 1, 0.05); // the user stopped; the loud room goes on
    await m.settle();
    assert.equal(m.submits.length, 0, 'still inside the silence wait');
    m.feed(0.1, 2, 0.05);
    await m.settle();
    assert.equal(m.submits.length, 1, 'cut after endpointSilenceMs of non-speech, although the room never got quiet');
    assert.deepEqual(m.signals, ['speech-start', 'endpoint']);
    assert.ok(m.events.some(event => event.type === 'endpoint'));
  });
});

test('fallback: the same loud background with no VAD answer (model missing) goes by loudness exactly as before', async () => {
  await mic(async m => {
    m.vad.ready = false;
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.1, 20, 0.02);
    await m.settle();
    assert.deepEqual(m.signals, ['speech-start'], 'loudness counts it as speech');
    assert.equal(m.vad.probes, 0, 'the VAD is not asked while it is not ready');
  });
});

test('call with the VAD: the start needs 128 ms; the moments before the confirmed start (and the first syllable) reach recognition', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10, 0);
    m.feed(0.1, 1, 0.9); m.feed(0.0005, 3, 0.1); // one 64 ms blip
    await m.settle();
    assert.deepEqual(m.signals, [], '64 ms is not a start');
    m.feed(0.0005, 6, 0);
    m.feed(0.1, 10, 0.9); // 640 ms of speech; the start is confirmed on its second chunk
    m.feed(0.0005, SILENT_CHUNKS + 1, 0.02);
    await m.settle();
    assert.equal(m.submits.length, 1);
    const seconds = wavSeconds(m.submits[0]);
    assert.ok(seconds >= 0.95, `the clip has the first chunk and the lead before it (${seconds.toFixed(3)} s; 0.73 s without it)`);
  });
});

test('call with the VAD: "voiced" says when the speech ended (the last speech window) and that the VAD said so', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.1, 4, 0.9);
    await m.settle();
    const voiced = m.events.filter((event): event is Extract<CallInputEvent, { type: 'voiced' }> => event.type === 'voiced');
    assert.ok(voiced.length >= 3);
    assert.ok(voiced.every(event => event.vad === true && typeof event.at === 'number'));
  });
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.1, 3, 0);
    await m.settle();
    assert.ok(m.events.filter(event => event.type === 'voiced').every(event => event.type === 'voiced' && event.vad === false), 'loudness: vad false');
  }, { vad: false });
});

test('call with the VAD while she reads: her echo (speech, quiet) and a loud non-speech knock do not stop her; the user talking over her does, once', async () => {
  const echo = (i: number) => chunk(i % 4 < 2 ? 0.035 : 0.02, i);
  const mix = (a: Float32Array, b: Float32Array) => a.map((value, i) => value + b[i]);
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10, 0);
    await m.settle(); // the VAD answers within milliseconds: these chunks were heard before she started reading
    m.media.setSpeaking(true);
    for (let i = 0; i < 60; i++) m.feed(echo(i), 1, 0.95);
    for (let i = 0; i < 10; i++) m.feed(mix(echo(i), chunk(0.3, i + 5)), 1, 0.05);
    await m.settle();
    assert.equal(m.events.filter(event => event.type === 'barge-in').length, 0, 'her voice and a knock never count');
    for (let i = 0; i < 8; i++) m.feed(mix(echo(i), chunk(0.15, i + 3)), 1, 0.9);
    await m.settle();
    assert.equal(m.events.filter(event => event.type === 'barge-in').length, 1, 'exactly one interruption');
  });
  await mic(async m => { // the same knock without the VAD stops her (why the VAD is worth having)
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10);
    m.media.setSpeaking(true);
    for (let i = 0; i < 60; i++) m.feed(echo(i), 1);
    for (let i = 0; i < 10; i++) m.feed(mix(echo(i), chunk(0.3, i + 5)), 1);
    await m.settle();
    assert.equal(m.events.filter(event => event.type === 'barge-in').length, 1);
  }, { vad: false });
});

test('I-189 #2: while your face is turned from the screen (sure), talking while she reads is not talking over her; facing her again, it is', async () => {
  const echo = (i: number) => chunk(i % 4 < 2 ? 0.035 : 0.02, i);
  const mix = (a: Float32Array, b: Float32Array) => a.map((value, i) => value + b[i]);
  let turned = true, asked = 0;
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10, 0);
    await m.settle();
    m.media.setSpeaking(true);
    for (let i = 0; i < 60; i++) m.feed(echo(i), 1, 0.95);
    for (let i = 0; i < 12; i++) m.feed(mix(echo(i), chunk(0.15, i + 3)), 1, 0.9); // the user talks (to somebody else, face turned)
    await m.settle();
    assert.equal(m.events.filter(event => event.type === 'barge-in').length, 0, 'face turned: no barge-in, no duck');
    assert.ok(asked >= 1, 'asked only when a barge-in would fire');
    turned = false;
    for (let i = 0; i < 40; i++) m.feed(echo(i), 1, 0.95); // the echo follower learns again after the held episode
    for (let i = 0; i < 10; i++) m.feed(mix(echo(i), chunk(0.15, i + 3)), 1, 0.9);
    await m.settle();
    assert.equal(m.events.filter(event => event.type === 'barge-in').length, 1, 'facing the screen: talking over her as before');
  }, { overHerHeld: () => { asked++; return turned; } });
});

test('call with the VAD while her short "嗯" plays: her own "嗯" is speech to the VAD, so it must still reach the raised gate', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10, 0);
    await m.settle();
    m.media.setEchoGuard(true);
    m.feed(0.025, 8, 0.95);
    await m.settle();
    assert.deepEqual(m.signals, [], 'her "嗯" through the speakers starts nothing');
    m.feed(0.2, 4, 0.95);
    await m.settle();
    assert.deepEqual(m.signals, ['speech-start'], 'the user, louder and speaking');
  });
});

test('outside a call the VAD is never asked and nothing changes', async () => {
  await mic(async m => {
    m.feed(0.1, 20, 0.9);
    await m.settle();
    assert.equal(m.vad.probes, 0); assert.equal(m.vad.started, 0);
    m.media.setCall(VOICE_CALL_KNOBS); m.media.setCall(null);
    assert.equal(m.vad.stopped, 1, 'hanging up ends the stream');
  });
});

test('lead: keeps about prerollMs of the newest chunks', () => {
  const lead = new ChunkLead();
  for (let i = 0; i < 20; i++) lead.keep(new Float32Array(1024).fill(i), 16000, 300);
  const kept = lead.take();
  assert.equal(kept.length, 5); assert.equal(kept.at(-1)![0], 19);
  assert.deepEqual(lead.take(), []);
});

// ================================================================ the end-to-end number

test('turn clock: one number from the last speech frame to her first sound of any kind, and whether the VAD found that frame', () => {
  let now = 0; const sent: Record<string, unknown>[] = [];
  const clock = new CallTurnClock(() => now, timing => sent.push(timing as never));
  now = 1000; clock.voiced(960, true); // the chunk arrived at 1000; its last speech window ended at 960
  now = 1700; clock.endpoint(); now = 2100; clock.filler(); now = 3000; clock.firstChar(); now = 3400; clock.firstSound();
  assert.equal(sent[0].endToSoundMs, 1140, 'the "嗯" at 2100 − 960');
  assert.equal(sent[0].firstSoundMs, 2440);
  assert.equal(sent[0].vad, true);
  now = 4000; clock.voiced(); now = 4700; clock.endpoint(); now = 6000; clock.firstSound();
  assert.equal(sent[1].endToSoundMs, 2000, 'no "嗯": the reply\'s first sound'); assert.equal(sent[1].vad, false);
  now = 7000; clock.voiced(); now = 7700; clock.endpoint(); clock.flush();
  assert.equal(sent[2].endToSoundMs, null, 'no sound this turn');
  const entry = buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 700, handInMs: 760, textMs: 820, fillerMs: 1100, firstCharMs: 2000,
    firstSoundMs: 2600, bargeIn: false, endToSoundMs: 1100, vad: true, words: '秘密' }, 1)!;
  assert.equal((entry as { endToSoundMs?: number }).endToSoundMs, 1100);
  assert.doesNotMatch(JSON.stringify(entry), /秘密|words/);
  const text = describeJournalEntry(entry, (s: string, ...args: unknown[]) => args.reduce<string>((acc, a, i) => acc.replace(`{${i}}`, String(a)), s));
  assert.match(text, /你说完到她出声共 1\.10 秒（语音检测判断你说完）/);
});

// ================================================================ the tone of the user's voice

test('tone: only five closed values, from the recognizer\'s own tags; neutral and everything else give nothing; a heard laugh or cry comes first', () => {
  assert.deepEqual([...USER_TONES], ['laughing', 'crying', 'angry', 'sad', 'happy']);
  const cases: [string | null, string | null, string | null][] = [
    ['speech', 'neutral', null], ['speech', 'happy', 'happy'], ['speech', 'sad', 'sad'], ['speech', 'angry', 'angry'],
    ['laughter', 'neutral', 'laughing'], ['laughter', 'sad', 'laughing'], ['cry', 'neutral', 'crying'], ['cry', 'sad', 'crying'],
    ['speech', 'fearful', null], ['speech', 'surprised', null], ['speech', 'disgusted', null], ['speech', 'unknown', null], ['bgm', null, null], [null, null, null],
  ];
  for (const [event, emotion, tone] of cases) assert.equal(userToneOf({ event, emotion }), tone, `${event}/${emotion}`);
  assert.equal(userToneOf(null), null);
  for (const tone of USER_TONES) { const line = userToneLine(tone); assert.ok(line.startsWith('\n（听声音') && line.length < 120); }
  assert.equal(userToneLine(null), '');
  assert.equal(userToneLine('excited' as never), '', 'nothing outside the closed list');
  assert.equal(new Set(USER_TONES.map(userToneLine)).size, 5);
  assert.equal(turnTone([null, 'laughing', null]), 'laughing'); assert.equal(turnTone(['sad', 'happy']), 'happy'); assert.equal(turnTone([null, null]), null);
});

test('tone: the local recognizer is asked for its tags on the user\'s own clips; the closed tone is kept per clip, taken once; the transcription address gives none', async () => {
  const calls: string[] = [];
  const config = { engine: 'local', language: 'zh', baseUrl: '', model: '' };
  const route = new VoiceRoute({ config: () => config as never, compatible: async () => '在吗', journal() {}, characterId: () => null,
    local: () => ({ voiceBlocked: () => null, transcribe: async () => { calls.push('plain'); return 'x'; },
      recognize: async (_wav, _language, _signal, options) => { calls.push(`tags ${options?.tags}`); return { text: '哈哈哈太好笑了', tags: { language: 'zh', event: 'laughter', emotion: 'happy' } }; } }) });
  const wav = new ArrayBuffer(8), other = new ArrayBuffer(8);
  assert.equal(await route.transcribe(wav, new AbortController().signal), '哈哈哈太好笑了');
  assert.deepEqual(calls, ['tags true']);
  assert.equal(route.toneOf(other), null);
  assert.equal(route.toneOf(wav), 'laughing');
  assert.equal(route.toneOf(wav), null, 'taken once');
  config.engine = 'compatible';
  assert.equal(await route.transcribe(wav, new AbortController().signal), '在吗');
  assert.equal(route.toneOf(wav), null);
});

async function voiceHost() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i100-tone-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const personas: string[] = [], shown: string[] = [], asr: string[] = [], tones: (string | null)[] = [];
  const pending = new Set<string>();
  const host = new VoiceChatHost({
    broadcast: event => { if ('text' in event && typeof event.text === 'string') shown.push(event.text); },
    memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {}, speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => { personas.push(task.session!.persona); emit('delta', '嗯嗯。'); return { superseded: false, output: '嗯嗯。' }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', toneOf: () => (tones.shift() ?? null) as never, stopReading() {}, prepareSpeech() {},
  });
  let binding = host.open(77, 'controls'), seq = 0;
  const say = async (text: string, tone: string | null) => {
    asr.push(text); tones.push(tone);
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(77, binding.captureSessionId);
    const before = personas.length;
    for (let i = 0; i < 400 && personas.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 400 && pending.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await host.drain();
  };
  const reopen = () => { binding = host.open(77, 'controls'); seq = 0; };
  const dispose = async () => { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); };
  return { host, personas, shown, say, reopen, dispose, tones };
}

test('tone in a voice turn: one private line for a clear tone, none for neutral; never shown in the chat; a new capture starts clean', async () => {
  const h = await voiceHost();
  try {
    await h.say('哈哈哈你太逗了', 'laughing');
    assert.ok(h.personas[0].includes(userToneLine('laughing')), 'she hears that it was said laughing');
    await h.say('今天有点累', null);
    for (const tone of USER_TONES) assert.ok(!h.personas[1].includes(userToneLine(tone)), 'neutral: no line');
    assert.ok(!h.shown.some(text => text.includes('听声音')), 'the line is private, never in the chat');
    await h.say('呜呜我好难过', 'crying');
    assert.ok(h.personas[2].includes(userToneLine('crying')));
    assert.equal(h.personas[2].split('（听声音').length - 1, 1, 'one line per turn, the earlier tones already taken');
  } finally { await h.dispose(); }
});
