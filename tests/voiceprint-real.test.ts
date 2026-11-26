// Unbound v1 step 3: the REAL CAM++ model (opt-in). SOFT_HEARTS_CAMPPLUS = the downloaded 3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
// (the app downloads it at runtime after the user turns the switch on; it is never committed), SOFT_HEARTS_ORT_ENTRY = the onnxruntime-node
// entry (e.g. from the pose runtime pack). Synthetic audio only: no voice of anyone. The numbers of the last run are in
// docs/claude/2026-11-17-unbound-step3.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SpeakerEngine, speakerFeatures, type VoiceOrtLike } from '../electron/senses/voiceprint/engine';
import { VOICEPRINT_MODEL_PIN } from '../electron/senses/voiceprint/manifest';
import { startVoiceprintWorker } from '../electron/senses/voiceprint/worker';
import { cosine } from '../shared/senses/voiceprint';

const MODEL = process.env.SOFT_HEARTS_CAMPPLUS, ORT = process.env.SOFT_HEARTS_ORT_ENTRY;
const SKIP = (!MODEL || !ORT) && 'set SOFT_HEARTS_CAMPPLUS and SOFT_HEARTS_ORT_ENTRY to run';
const RATE = 16_000;
/** The worker's own loader is for the bundled CommonJS file; here the same runtime entry is required directly. */
const runtime = (entry: string) => createRequire(import.meta.url)(entry) as VoiceOrtLike;
/** A crude synthetic "voice": a glottal-like pulse train at `pitch` through two resonances (`f1`, `f2`), with a slow vibrato. */
function synth(pitch: number, f1: number, f2: number, seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let phase = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, s = seed;
  const coef = (f: number, bw: number) => { const r = Math.exp(-Math.PI * bw / RATE); return [2 * r * Math.cos(2 * Math.PI * f / RATE), -r * r]; };
  const [a1, b1] = coef(f1, 90), [a2, b2] = coef(f2, 120);
  for (let i = 0; i < out.length; i++) {
    phase += (pitch * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * i / RATE))) / RATE;
    s = (s * 16807) % 2147483647;
    const source = (phase % 1 < 0.05 ? 1 : 0) + 0.01 * (s / 2147483647 - 0.5);
    const v1 = source + a1 * y1 + b1 * y2; y2 = y1; y1 = v1;
    const v2 = v1 + a2 * z1 + b2 * z2; z2 = z1; z1 = v2;
    out[i] = v2;
  }
  let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x));
  return out.map(x => 0.3 * x / (peak || 1));
}

test('real CAM++: the pinned file, its input and output, unit length, the same clip gives the same numbers, and how long it takes here', { skip: SKIP }, async () => {
  const bytes = readFileSync(MODEL!);
  assert.equal(bytes.byteLength, VOICEPRINT_MODEL_PIN.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), VOICEPRINT_MODEL_PIN.sha256);
  const ort = createRequire(import.meta.url)(path.resolve(ORT!)) as VoiceOrtLike;
  let t0 = performance.now();
  const engine = await SpeakerEngine.open(ort, bytes, 1);
  const loadMs = performance.now() - t0;
  try {
    const a1 = synth(210, 750, 1300, 3, 1), a2 = synth(215, 760, 1320, 3, 2), b = synth(120, 520, 950, 3, 3), c = synth(300, 400, 2300, 3, 4);
    assert.equal(speakerFeatures(a1).frames, 298, '3 s: 298 frames of 25 ms every 10 ms');
    t0 = performance.now();
    const [va1, va2, vb, vc, again] = [await engine.embed(a1), await engine.embed(a2), await engine.embed(b), await engine.embed(c), await engine.embed(a1)];
    const perClipMs = (performance.now() - t0) / 5;
    for (const v of [va1, va2, vb, vc]) { assert.equal(v.length, 192); let n = 0; for (const x of v) n += x * x; assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-4); }
    assert.ok(cosine(va1, again) > 0.9999, 'deterministic');
    const short = await engine.embed(synth(210, 750, 1300, 1, 5));
    const numbers = { loadMs: Math.round(loadMs), perClipMs: Math.round(perClipMs), sameish: +cosine(va1, va2).toFixed(3), lowVoice: +cosine(va1, vb).toFixed(3),
      otherVoice: +cosine(va1, vc).toFixed(3), oneSecond: +cosine(va1, short).toFixed(3) };
    console.log('# CAM++ synthetic numbers', JSON.stringify(numbers));
  } finally { await engine.release(); }
});

test('real CAM++ through the worker entry: init checks the file, then answers one clip with 192 numbers', { skip: SKIP }, async () => {
  const messages: unknown[] = [];
  let listener: (event: { data: unknown }) => void = () => {};
  let exited = false;
  startVoiceprintWorker({ on: (_event, l) => { listener = l; }, postMessage: message => messages.push(message) }, runtime, () => { exited = true; });
  listener({ data: { type: 'init', runtimeEntry: path.resolve(ORT!), model: path.resolve(MODEL!), modelSize: VOICEPRINT_MODEL_PIN.size, modelSha256: VOICEPRINT_MODEL_PIN.sha256, threads: 1 } });
  for (let i = 0; i < 200 && !messages.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((messages[0] as { type: string }).type, 'ready');
  listener({ data: { type: 'embed', id: 'vp-1', samples: synth(210, 750, 1300, 2) } });
  for (let i = 0; i < 200 && messages.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const result = messages[1] as { type: string; vector: Float32Array };
  assert.equal(result.type, 'result'); assert.equal(result.vector.length, 192);
  listener({ data: { type: 'stop' } });
  for (let i = 0; i < 100 && !exited; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(exited, true, 'it ends itself on stop');
});

test('real worker refuses a model file that is not the pinned one', { skip: SKIP }, async () => {
  const messages: unknown[] = [];
  let listener: (event: { data: unknown }) => void = () => {};
  startVoiceprintWorker({ on: (_event, l) => { listener = l; }, postMessage: message => messages.push(message) }, runtime, () => {});
  listener({ data: { type: 'init', runtimeEntry: path.resolve(ORT!), model: path.resolve(MODEL!), modelSize: VOICEPRINT_MODEL_PIN.size, modelSha256: '0'.repeat(64), threads: 1 } });
  for (let i = 0; i < 200 && !messages.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(messages[0], { type: 'failed', reason: 'model' });
});
