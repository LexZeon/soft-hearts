/**
 * Brings a quiet clip up to the level the recognizer was trained on, before the features are computed.
 * (for the microphone and for 和她一起听: both feed this one recognizer. SenseVoice's front end has no
 * per-clip level normalization — the CMVN is a fixed offset — so a clip 20 dB quieter than speech normally is shifts every
 * log-mel value by a constant the model never saw, and it can answer with nothing. The synthetic test speech that was
 * checked on 2026-11-03 sits near -22 dBFS while the voice part of a laptop microphone clip is often 15-25 dB lower.)
 *
 * Only ever louder, never beyond what the clip's own peak allows, and never for what is only a noise floor.
 */

/** Active level (RMS of the loudest part of the clip) we lift quiet clips to; just under the level that was verified. */
export const TARGET_ACTIVE_RMS = 0.05;
/** Below this the clip is hiss, not a voice; amplifying it would only make noise to recognize. */
export const NOISE_ONLY_RMS = 0.0015;
/** At most +22 dB. */
export const MAX_GAIN = 12;
const WINDOW = 400;

/** RMS of the windows within 6 dB of the loudest window (the "talking" part), and the loudest sample. */
export function activeLevel(samples: Float32Array): { rms: number; peak: number } {
  const windows = Math.floor(samples.length / WINDOW);
  let peak = 0;
  for (let index = 0; index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]));
  if (!windows) return { rms: 0, peak };
  const levels = new Float64Array(windows);
  let loudest = 0;
  for (let w = 0; w < windows; w++) {
    let energy = 0;
    for (let n = w * WINDOW; n < (w + 1) * WINDOW; n++) energy += samples[n] * samples[n];
    levels[w] = energy / WINDOW; loudest = Math.max(loudest, levels[w]);
  }
  let sum = 0, count = 0;
  for (const level of levels) if (level >= loudest / 4) { sum += level; count++; }
  return { rms: Math.sqrt(sum / Math.max(1, count)), peak };
}

export function normalizeLevel(samples: Float32Array): Float32Array {
  const { rms, peak } = activeLevel(samples);
  if (!(rms >= NOISE_ONLY_RMS) || rms >= TARGET_ACTIVE_RMS || !(peak > 0)) return samples;
  const gain = Math.min(MAX_GAIN, TARGET_ACTIVE_RMS / rms, 0.95 / peak);
  if (!(gain > 1.01)) return samples;
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) out[index] = samples[index] * gain;
  return out;
}
