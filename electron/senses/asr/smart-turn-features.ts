/**
 * I-099/I-100: the log-mel features Smart Turn v3.2 (shared/voice/smart-turn.json) takes as input.
 * Our own TypeScript, written from the published description of the Whisper front end the model was trained on (the
 * pinned model card and example inference code at shared/voice/smart-turn.json `license.codeRevision`; the numbers are computed
 * here from their formulas, nothing is copied):
 *
 *  1. the last 8 s of the turn at 16 kHz, shorter audio padded with zeros IN FRONT (so the end of speech is always at the end);
 *  2. zero mean and unit variance over those 8 s (variance + 1e-7);
 *  3. a 400-sample periodic Hann window every 160 samples, the signal reflected by 200 samples at both ends (801 frames,
 *     the last one dropped: 800);
 *  4. power spectrum → 80 triangular mel filters (Slaney mel scale, area-normalised, 0–8000 Hz) → log10 (floor 1e-10);
 *  5. nothing below (the loudest value - 8) → (value + 4) / 4.
 * Output: 80 x 800 float32, row-major (mel bin, frame) = the model's `input_features` [1, 80, 800].
 */
export const TURN_RATE = 16_000;
export const TURN_SECONDS = 8;
export const TURN_SAMPLES = TURN_RATE * TURN_SECONDS;
export const TURN_FFT = 400;
export const TURN_HOP = 160;
export const TURN_MELS = 80;
export const TURN_FRAMES = TURN_SAMPLES / TURN_HOP; // 800
const BINS = TURN_FFT / 2 + 1; // 201

// ---- the mel filter bank (Slaney scale: linear below 1 kHz, logarithmic above)
const F_SP = 200 / 3, MIN_LOG_HZ = 1000, MIN_LOG_MEL = MIN_LOG_HZ / F_SP, LOG_STEP = Math.log(6.4) / 27;
const hzToMel = (hz: number) => hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP : hz / F_SP;
const melToHz = (mel: number) => mel >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)) : mel * F_SP;

/** `TURN_MELS` rows of `BINS` weights. */
export function melFilterBank(): Float64Array[] {
  const edges = Array.from({ length: TURN_MELS + 2 }, (_, i) => melToHz(hzToMel(0) + (hzToMel(TURN_RATE / 2) - hzToMel(0)) * i / (TURN_MELS + 1)));
  const rows: Float64Array[] = [];
  for (let m = 0; m < TURN_MELS; m++) {
    const [low, mid, high] = [edges[m], edges[m + 1], edges[m + 2]], row = new Float64Array(BINS), norm = 2 / (high - low);
    for (let bin = 0; bin < BINS; bin++) {
      const hz = bin * TURN_RATE / TURN_FFT;
      row[bin] = Math.max(0, Math.min((hz - low) / (mid - low), (high - hz) / (high - mid))) * norm;
    }
    rows.push(row);
  }
  return rows;
}

// ---- a 400-point FFT (400 = 2^4 * 5^2): mixed-radix, in place per level
const FACTORS = [2, 2, 2, 2, 5, 5];
const COS = Float64Array.from({ length: TURN_FFT }, (_, i) => Math.cos(2 * Math.PI * i / TURN_FFT));
const SIN = Float64Array.from({ length: TURN_FFT }, (_, i) => -Math.sin(2 * Math.PI * i / TURN_FFT));

function fft(inRe: Float64Array, inIm: Float64Array, inOff: number, inStride: number, outRe: Float64Array, outIm: Float64Array, outOff: number, n: number, level: number): void {
  if (n === 1) { outRe[outOff] = inRe[inOff]; outIm[outOff] = inIm[inOff]; return; }
  const p = FACTORS[level], m = n / p, step = TURN_FFT / n, pStep = TURN_FFT / p;
  for (let r = 0; r < p; r++) fft(inRe, inIm, inOff + r * inStride, inStride * p, outRe, outIm, outOff + r * m, m, level + 1);
  const tRe = new Float64Array(p), tIm = new Float64Array(p);
  for (let k = 0; k < m; k++) {
    for (let r = 0; r < p; r++) {
      const at = outOff + r * m + k, w = (r * k * step) % TURN_FFT;
      tRe[r] = outRe[at] * COS[w] - outIm[at] * SIN[w];
      tIm[r] = outRe[at] * SIN[w] + outIm[at] * COS[w];
    }
    for (let q = 0; q < p; q++) {
      let re = 0, im = 0;
      for (let r = 0; r < p; r++) { const w = (r * q * pStep) % TURN_FFT; re += tRe[r] * COS[w] - tIm[r] * SIN[w]; im += tRe[r] * SIN[w] + tIm[r] * COS[w]; }
      outRe[outOff + k + q * m] = re; outIm[outOff + k + q * m] = im;
    }
  }
}

const scratch = { re: new Float64Array(TURN_FFT), im: new Float64Array(TURN_FFT), outRe: new Float64Array(TURN_FFT), outIm: new Float64Array(TURN_FFT) };

/** Power spectrum (bins 0..200) of one real 400-sample frame, written into `power`. Exported so tests can compare it with a plain DFT. */
export function powerSpectrum(frame: ArrayLike<number>, power: Float64Array): void {
  const { re, im, outRe, outIm } = scratch;
  for (let i = 0; i < TURN_FFT; i++) { re[i] = frame[i]; im[i] = 0; }
  fft(re, im, 0, 1, outRe, outIm, 0, TURN_FFT, 0);
  for (let bin = 0; bin < BINS; bin++) power[bin] = outRe[bin] * outRe[bin] + outIm[bin] * outIm[bin];
}

const HANN =Float64Array.from({ length: TURN_FFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / TURN_FFT));
let filters: Float64Array[] | null = null;

/** The last `TURN_SECONDS` of `audio` (16 kHz mono), zero-padded in front when shorter; the model's whole input. */
export function turnWindow(audio: Float32Array): Float32Array {
  const out = new Float32Array(TURN_SAMPLES);
  if (audio.length >= TURN_SAMPLES) out.set(audio.subarray(audio.length - TURN_SAMPLES));
  else out.set(audio, TURN_SAMPLES - audio.length);
  return out;
}

/** Audio (any length, 16 kHz) → `TURN_MELS * TURN_FRAMES` features, row-major by mel bin. */
export function smartTurnFeatures(audio: Float32Array): Float32Array {
  filters ??= melFilterBank();
  const wave = turnWindow(audio);
  let mean = 0;
  for (const v of wave) mean += v;
  mean /= TURN_SAMPLES;
  let variance = 0;
  for (const v of wave) variance += (v - mean) * (v - mean);
  variance /= TURN_SAMPLES;
  const scale = 1 / Math.sqrt(variance + 1e-7), half = TURN_FFT / 2;
  // the signal after normalisation, reflected (without repeating the edge sample) by half a window at both ends
  const padded = new Float64Array(TURN_SAMPLES + TURN_FFT);
  for (let i = 0; i < TURN_SAMPLES; i++) padded[half + i] = (wave[i] - mean) * scale;
  for (let i = 1; i <= half; i++) { padded[half - i] = padded[half + i]; padded[half + TURN_SAMPLES - 1 + i] = padded[half + TURN_SAMPLES - 1 - i]; }
  const mel = new Float64Array(TURN_MELS * (TURN_FRAMES + 1));
  const windowed = new Float64Array(TURN_FFT), power = new Float64Array(BINS);
  for (let frame = 0; frame <= TURN_FRAMES; frame++) {
    const from = frame * TURN_HOP;
    for (let i = 0; i < TURN_FFT; i++) windowed[i] = padded[from + i] * HANN[i];
    powerSpectrum(windowed, power);
    for (let m = 0; m < TURN_MELS; m++) {
      const row = filters[m];
      let sum = 0;
      for (let bin = 0; bin < BINS; bin++) sum += row[bin] * power[bin];
      mel[m * (TURN_FRAMES + 1) + frame] = Math.log10(Math.max(1e-10, sum));
    }
  }
  const out = new Float32Array(TURN_MELS * TURN_FRAMES);
  let loudest = -Infinity;
  for (let m = 0; m < TURN_MELS; m++) for (let frame = 0; frame < TURN_FRAMES; frame++) loudest = Math.max(loudest, mel[m * (TURN_FRAMES + 1) + frame]); // the dropped last frame does not count
  for (let m = 0; m < TURN_MELS; m++) for (let frame = 0; frame < TURN_FRAMES; frame++) out[m * TURN_FRAMES + frame] = (Math.max(mel[m * (TURN_FRAMES + 1) + frame], loudest - 8) + 4) / 4;
  return out;
}
