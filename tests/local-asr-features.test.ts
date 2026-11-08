// Local recognizer front end (electron/asr/features.ts): Kaldi-compatible fbank, FunASR LFR and CMVN.
// The fbank is checked against an independent, deliberately naive implementation (direct DFT, mel weights from the
// Kaldi formula), so a mistake in the FFT, the window, pre-emphasis or the mel banks shows up as a mismatch.
// End-to-end correctness with the real SenseVoice model was checked by hand (docs/claude/2026-11-03-voice-input-local.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCmvn, applyLfr, fbank, MEL_BINS, senseVoiceFeatures, wavSamples, type Features } from '../electron/asr/features';
import { encodeWav } from '../src/ui/MediaInput';

function naiveFbank(samples: Float32Array): number[][] {
  const rows: number[][] = [];
  const mel = (hz: number) => 1127 * Math.log(1 + hz / 700);
  const low = mel(20), delta = (mel(8000) - low) / 81;
  for (let start = 0; start + 400 <= samples.length; start += 160) {
    const x = Array.from(samples.subarray(start, start + 400), v => v * 32768);
    const mean = x.reduce((a, b) => a + b, 0) / 400;
    const centered = x.map(v => v - mean);
    const pre = centered.map((v, i) => v - 0.97 * centered[Math.max(0, i - 1)]);
    const windowed = pre.map((v, n) => v * (0.54 - 0.46 * Math.cos(2 * Math.PI * n / 399)));
    const power: number[] = [];
    for (let k = 0; k <= 256; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < 400; n++) { re += windowed[n] * Math.cos(2 * Math.PI * k * n / 512); im -= windowed[n] * Math.sin(2 * Math.PI * k * n / 512); }
      power.push(re * re + im * im);
    }
    const row: number[] = [];
    for (let b = 0; b < 80; b++) {
      const left = low + b * delta, center = left + delta, right = center + delta;
      let energy = 0;
      for (let i = 0; i < 256; i++) {
        const m = mel(i * 31.25);
        energy += Math.max(0, Math.min((m - left) / (center - left), (right - m) / (right - center))) * power[i];
      }
      row.push(Math.log(Math.max(energy, 1.1920928955078125e-7)));
    }
    rows.push(row);
  }
  return rows;
}

function signal(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * 16000));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 16000) + 0.1 * Math.sin(2 * Math.PI * 1830 * i / 16000) + 0.02 * (seed / 0x7fffffff - 0.5);
  }
  return out;
}

test('fbank matches a naive Kaldi reference (frames, window, pre-emphasis, mel banks, log floor)', () => {
  const samples = signal(0.1);
  const ours = fbank(samples), reference = naiveFbank(samples);
  assert.equal(ours.frames, 1 + Math.floor((1600 - 400) / 160));
  assert.equal(ours.frames, reference.length);
  assert.equal(ours.dim, MEL_BINS);
  let worst = 0;
  for (let f = 0; f < ours.frames; f++) for (let b = 0; b < 80; b++) worst = Math.max(worst, Math.abs(ours.data[f * 80 + b] - reference[f][b]));
  assert.ok(worst < 2e-3, `largest difference ${worst}`);
});

test('fbank: silence sits on the log floor, a tone peaks in the right mel bin, too-short audio has no frames', () => {
  const silent = fbank(new Float32Array(1600));
  assert.ok(silent.data.every(value => Math.abs(value - Math.log(1.1920928955078125e-7)) < 1e-4));
  assert.equal(fbank(new Float32Array(399)).frames, 0);
  const tone = new Float32Array(4000).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 1000 * i / 16000));
  const features = fbank(tone);
  const row = Array.from(features.data.subarray(80, 160));
  const peak = row.indexOf(Math.max(...row));
  const mel = (hz: number) => 1127 * Math.log(1 + hz / 700), delta = (mel(8000) - mel(20)) / 81;
  const expected = Math.round((mel(1000) - mel(20)) / delta) - 1;
  assert.ok(Math.abs(peak - expected) <= 1, `peak bin ${peak}, expected about ${expected}`);
});

test('LFR follows FunASR: 3 copies of the first frame in front, 7 frames every 6, the tail padded with the last frame', () => {
  const frames = 10, dim = 2;
  const input: Features = { data: Float32Array.from({ length: frames * dim }, (_, i) => Math.floor(i / dim)), frames, dim };
  const out = applyLfr(input, 7, 6);
  assert.equal(out.frames, Math.ceil(10 / 6));
  assert.equal(out.dim, 14);
  const frameIds = (row: number) => Array.from({ length: 7 }, (_, j) => out.data[row * 14 + j * 2]);
  assert.deepEqual(frameIds(0), [0, 0, 0, 0, 1, 2, 3]);
  assert.deepEqual(frameIds(1), [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(applyLfr({ data: new Float32Array(0), frames: 0, dim: 80 }).frames, 0);
});

test('CMVN adds the negative mean and scales per dimension, and refuses a size mismatch', () => {
  const features: Features = { data: Float32Array.of(1, 2, 3, 4), frames: 2, dim: 2 };
  applyCmvn(features, Float32Array.of(-1, -2), Float32Array.of(2, 0.5));
  assert.deepEqual(Array.from(features.data), [0, 0, 4, 1]);
  assert.throws(() => applyCmvn(features, Float32Array.of(0), Float32Array.of(1)));
  const full = senseVoiceFeatures(signal(1), { negMean: new Float32Array(560), invStddev: new Float32Array(560).fill(1) });
  assert.equal(full.dim, 560);
  assert.equal(full.frames, Math.ceil((1 + Math.floor((16000 - 400) / 160)) / 6));
});

test('WAV from the microphone path decodes back to the same samples', () => {
  const samples = signal(0.25);
  const decoded = wavSamples(encodeWav(samples));
  assert.equal(decoded.length, samples.length);
  let worst = 0;
  for (let i = 0; i < samples.length; i++) worst = Math.max(worst, Math.abs(decoded[i] - samples[i]));
  assert.ok(worst < 1 / 16384);
  assert.throws(() => wavSamples(new ArrayBuffer(8)));
  assert.throws(() => wavSamples(encodeWav(samples, 8000)), /16 kHz/);
});
