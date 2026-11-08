import test from 'node:test';
import assert from 'node:assert/strict';
import { activeLevel, normalizeLevel, TARGET_ACTIVE_RMS, MAX_GAIN } from '../electron/asr/level';
import { SenseVoiceEngine, type AsrOrtLike } from '../electron/asr/engine';

// A talking-like clip: 2 s of low hiss around a 1.5 s burst of a 200 Hz tone at the given RMS.
function clip(speechRms: number, hiss = 0.0005): Float32Array {
  const out = new Float32Array(16000 * 4);
  for (let index = 0; index < out.length; index++) out[index] = (((index * 7919) % 200) / 100 - 1) * hiss;
  for (let index = 0; index < 24000; index++) out[16000 + index] += Math.sin(index / 16000 * 2 * Math.PI * 200) * speechRms * Math.SQRT2;
  return out;
}

test('a quiet clip is lifted to the verified level, the hiss around it stays proportional', () => {
  const quiet = clip(0.004);
  const before = activeLevel(quiet).rms;
  assert.ok(before < 0.005);
  const lifted = normalizeLevel(quiet);
  const after = activeLevel(lifted).rms;
  assert.ok(Math.abs(after - TARGET_ACTIVE_RMS) / TARGET_ACTIVE_RMS < 0.1, `active level ${after}`);
  assert.ok(after / before <= MAX_GAIN + 0.01);
  assert.notEqual(lifted, quiet, 'the input is never changed in place');
  assert.ok(Math.abs(quiet[16100]) < 0.01);
});

test('a clip that is already loud enough, or only a noise floor, is returned as it is', () => {
  const loud = clip(0.08);
  assert.equal(normalizeLevel(loud), loud);
  const hiss = clip(0, 0.002);
  assert.equal(normalizeLevel(hiss), hiss);
  const silence = new Float32Array(16000);
  assert.equal(normalizeLevel(silence), silence);
});

test('the lift never clips', () => {
  const spiky = clip(0.003);
  spiky[20000] = 0.5;
  const lifted = normalizeLevel(spiky);
  let peak = 0; for (const sample of lifted) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak <= 0.951, `peak ${peak}`);
});

test('the engine hands the model the lifted clip', async () => {
  const seen: number[] = [];
  const ort: AsrOrtLike = {
    InferenceSession: { create: async () => ({ inputNames: ['x', 'x_length', 'language', 'text_norm'], outputNames: ['out'],
      run: async (feeds: Record<string, unknown>) => { { const data = (feeds.x as { data: Float32Array }).data; let sum = 0; for (const value of data) sum += value; seen.push(sum / data.length); } return { out: { data: new Float32Array(0), dims: [1, 1, 2] } }; },
      release: async () => {} }) },
    Tensor: class { constructor(readonly type: string, readonly data: Float32Array | Int32Array, readonly dims: number[]) {} } as never,
  };
  const meta = { vocabSize: 2, lfrM: 7, lfrN: 6, negMean: new Float32Array(560), invStddev: new Float32Array(560).fill(1), languages: { auto: 0, zh: 3, en: 4, yue: 7, ja: 11, ko: 12 }, withItn: 14, withoutItn: 15 };
  const engine = await SenseVoiceEngine.open(ort, 'model.onnx', 'a 0\nb 1\n', meta as never, 1);
  const quietInput = clip(0.004), loudInput = new Float32Array(quietInput.length);
  for (let index = 0; index < loudInput.length; index++) loudInput[index] = quietInput[index] * 12;
  await engine.recognize(quietInput, 'zh').catch(() => undefined);
  await engine.recognize(loudInput, 'zh').catch(() => undefined);
  assert.equal(seen.length, 2);
  // Quiet and 12x-louder inputs now reach the model at the same scale (within the gain cap and rounding).
  assert.ok(Math.abs(seen[0] - seen[1]) < 1, `mean log-mel ${seen[0]} vs ${seen[1]} (12x apart in level is about 5 without the lift)`);
});
