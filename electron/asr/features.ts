/**
 * SenseVoice front end in plain TypeScript (no native code): Kaldi-compatible 80-bin log-mel filter banks, low frame
 * rate stacking (LFR) and CMVN, matching FunASR's WavFrontend for SenseVoiceSmall (frame 25 ms / shift 10 ms, Hamming
 * window, dither 0, snip_edges, samples in the int16 range; LFR m=7 n=6 with FunASR's padding; CMVN from the model's
 * own metadata). Used by the local recognizer's inference process (electron/asr/worker.ts); tests/local-asr-features.test.ts.
 */

export const SAMPLE_RATE = 16_000;
export const MEL_BINS = 80;
const FRAME_LENGTH = 400; // 25 ms
const FRAME_SHIFT = 160; // 10 ms
const FFT_SIZE = 512;
const PREEMPHASIS = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2;
/** torch.finfo(torch.float).eps, Kaldi's log floor. */
const LOG_FLOOR = 1.1920928955078125e-7;

/** A 16 kHz mono 16-bit PCM WAV (as checked by electron/asr.ts validateWav) → samples in [-1, 1). */
export function wavSamples(wav: ArrayBuffer): Float32Array {
  const view = new DataView(wav), bytes = new Uint8Array(wav);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (wav.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12, format = false;
  while (offset + 8 <= wav.byteLength) {
    const type = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > wav.byteLength) throw new Error('truncated WAV');
    if (type === 'fmt ') {
      if (size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== SAMPLE_RATE || view.getUint16(start + 14, true) !== 16) throw new Error('WAV must be 16 kHz mono PCM16');
      format = true;
    } else if (type === 'data') {
      if (!format) throw new Error('WAV data before format');
      const out = new Float32Array(Math.floor(size / 2));
      for (let index = 0; index < out.length; index++) out[index] = view.getInt16(start + index * 2, true) / 32768;
      return out;
    }
    offset = start + size + (size % 2);
  }
  throw new Error('WAV has no data');
}

let cached: { window: Float32Array; bank: Float32Array[]; bankStart: Int32Array; cos: Float32Array; sin: Float32Array; reverse: Uint16Array } | null = null;
const melScale = (hz: number) => 1127 * Math.log(1 + hz / 700);

function tables() {
  if (cached) return cached;
  const window = new Float32Array(FRAME_LENGTH);
  for (let n = 0; n < FRAME_LENGTH; n++) window[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FRAME_LENGTH - 1));
  // Kaldi/torchaudio mel banks: triangles on the mel scale over the 256 lower FFT bins (the Nyquist bin gets weight 0).
  const bins = FFT_SIZE / 2, width = SAMPLE_RATE / FFT_SIZE, low = melScale(LOW_FREQ), delta = (melScale(HIGH_FREQ) - low) / (MEL_BINS + 1);
  const bank: Float32Array[] = [], bankStart = new Int32Array(MEL_BINS);
  for (let b = 0; b < MEL_BINS; b++) {
    const left = low + b * delta, center = left + delta, right = center + delta;
    const weights = new Float32Array(bins);
    let first = -1, last = -1;
    for (let i = 0; i < bins; i++) {
      const mel = melScale(i * width);
      const up = (mel - left) / (center - left), down = (right - mel) / (right - center);
      const weight = Math.max(0, Math.min(up, down));
      if (weight > 0) { if (first < 0) first = i; last = i; }
      weights[i] = weight;
    }
    bankStart[b] = Math.max(0, first);
    bank.push(weights.slice(Math.max(0, first), last + 1));
  }
  const cos = new Float32Array(FFT_SIZE / 2), sin = new Float32Array(FFT_SIZE / 2);
  for (let k = 0; k < FFT_SIZE / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / FFT_SIZE); sin[k] = -Math.sin((2 * Math.PI * k) / FFT_SIZE); }
  const reverse = new Uint16Array(FFT_SIZE), bitsCount = Math.log2(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) { let r = 0; for (let b = 0; b < bitsCount; b++) r |= ((i >> b) & 1) << (bitsCount - 1 - b); reverse[i] = r; }
  cached = { window, bank, bankStart, cos, sin, reverse };
  return cached;
}

/** In-place radix-2 complex FFT of size 512 (re/im). */
function fft(re: Float64Array, im: Float64Array): void {
  const { cos, sin, reverse } = tables();
  for (let i = 0; i < FFT_SIZE; i++) { const j = reverse[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1, step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size)
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step], a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
  }
}

export interface Features { data: Float32Array; frames: number; dim: number }

/** 80-bin Kaldi log-mel filter banks of 16 kHz samples in [-1, 1) (scaled to the int16 range first, as the model expects). */
export function fbank(samples: Float32Array): Features {
  const frames = samples.length < FRAME_LENGTH ? 0 : 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT);
  const out = new Float32Array(frames * MEL_BINS);
  const { window, bank, bankStart } = tables();
  const frame = new Float64Array(FRAME_LENGTH), re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE), power = new Float64Array(FFT_SIZE / 2 + 1);
  for (let f = 0; f < frames; f++) {
    const offset = f * FRAME_SHIFT;
    let mean = 0;
    for (let n = 0; n < FRAME_LENGTH; n++) { frame[n] = samples[offset + n] * 32768; mean += frame[n]; }
    mean /= FRAME_LENGTH;
    for (let n = 0; n < FRAME_LENGTH; n++) frame[n] -= mean;
    for (let n = FRAME_LENGTH - 1; n > 0; n--) frame[n] -= PREEMPHASIS * frame[n - 1];
    frame[0] -= PREEMPHASIS * frame[0];
    re.fill(0); im.fill(0);
    for (let n = 0; n < FRAME_LENGTH; n++) re[n] = frame[n] * window[n];
    fft(re, im);
    for (let k = 0; k <= FFT_SIZE / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < MEL_BINS; b++) {
      const weights = bank[b], start = bankStart[b];
      let energy = 0;
      for (let i = 0; i < weights.length; i++) energy += weights[i] * power[start + i];
      out[f * MEL_BINS + b] = Math.log(Math.max(energy, LOG_FLOOR));
    }
  }
  return { data: out, frames, dim: MEL_BINS };
}

/**
 * Low frame rate stacking as FunASR's apply_lfr: (m-1)/2 copies of the first frame in front, then windows of m frames
 * every n frames; the last windows are padded with the last frame. Output: ceil(T / n) frames of m·dim values.
 */
export function applyLfr(input: Features, m = 7, n = 6): Features {
  const { data, frames, dim } = input;
  if (!frames) return { data: new Float32Array(0), frames: 0, dim: dim * m };
  const outFrames = Math.ceil(frames / n), left = (m - 1) >> 1, outDim = dim * m;
  const out = new Float32Array(outFrames * outDim);
  for (let i = 0; i < outFrames; i++)
    for (let j = 0; j < m; j++) {
      const source = Math.min(frames - 1, Math.max(0, i * n + j - left));
      out.set(data.subarray(source * dim, source * dim + dim), i * outDim + j * dim);
    }
  return { data: out, frames: outFrames, dim: outDim };
}

/** CMVN in place: (x + negMean) · invStddev per dimension (the model's AddShift / Rescale). */
export function applyCmvn(input: Features, negMean: Float32Array, invStddev: Float32Array): Features {
  if (negMean.length !== input.dim || invStddev.length !== input.dim) throw new Error('CMVN size does not match the features');
  const { data, dim } = input;
  for (let index = 0; index < data.length; index++) { const d = index % dim; data[index] = (data[index] + negMean[d]) * invStddev[d]; }
  return input;
}

/** The whole front end: samples → model input frames. */
export function senseVoiceFeatures(samples: Float32Array, cmvn: { negMean: Float32Array; invStddev: Float32Array }, lfr = { m: 7, n: 6 }): Features {
  return applyCmvn(applyLfr(fbank(samples), lfr.m, lfr.n), cmvn.negMean, cmvn.invStddev);
}
