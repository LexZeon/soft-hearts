/**
 * I-072 (docs/claude/2026-11-10-i072-music-overhaul.md): the drum hits, from a spectrum that is NOT smoothed over time.
 *
 * The capture (src/senses/SystemAudio.ts) reads two analysers on the same sound: the smoothed one (smoothingTimeConstant 0.65) for the
 * levels the song recognizer and the dance already use, and one with smoothing 0 only for this. The smoothing blunted every attack
 * (a kick's rise was spread over ~3 frames), so the beat under a loud voice was hard to see (user's Words Actually Dance keeps a
 * separate unsmoothed analyser for its drums; this is the same idea, written for our three bands).
 *
 * Per band (the same 40–180 / 180–2000 / 2000–8000 Hz as the levels): a spectral flux = the mean rise of each bin's dB level since
 * the previous read (falls count 0), each bin weighted by its share of the band's amplitude now, so the steady harmonics of a held
 * vowel add ~0 while new energy between them (a snare, a hi-hat, a kick) shows. The flux is ADDED to a running counter per band.
 * A counter, not a per-frame value, because the samples travel through the host and the companion window's fusion, which can drop a
 * sample (one still in flight) or repeat the latest one (it re-times it on display frames): the stage takes the difference of two
 * counters, so a repeat adds 0 and a drop moves the rise to the next sample instead of losing it. The counter wraps at ONSET_WRAP.
 *
 * Only numbers derived from one analyser frame: no audio is kept.
 */
export const ONSET_WRAP = 4096;
/** One bin's rise counts at most this much (dB); the stage clamps a band's rise to 20 dB as before. */
export const ONSET_BIN_MAX_DB = 30;
/** Bins under this are treated as this (dBFS), so rises out of the numerical floor do not count as hits. */
export const ONSET_FLOOR_DB = -100;
export const ONSET_BANDS: readonly (readonly [number, number])[] = [[40, 180], [180, 2000], [2000, 8000]];

export interface OnsetCounters { onsetLow: number; onsetMid: number; onsetHigh: number }

/** Feed every read of the unsmoothed analyser (dB per bin, as getFloatFrequencyData gives them); read `counters`. */
export class OnsetFlux {
  private previous: Float32Array | null = null;
  private readonly total = [0, 0, 0];

  get counters(): OnsetCounters { return { onsetLow: this.total[0]!, onsetMid: this.total[1]!, onsetHigh: this.total[2]! }; }

  /** `spectrumDb`: one analyser frame in dBFS per bin (fftSize / 2 bins); `binHz` = sampleRate / fftSize. */
  push(spectrumDb: Float32Array, binHz: number): void {
    const previous = this.previous;
    if (!previous || previous.length !== spectrumDb.length || !(binHz > 0)) {
      this.previous = Float32Array.from(spectrumDb, value => floor(value));
      return;
    }
    for (let band = 0; band < ONSET_BANDS.length; band++) {
      const [from, to] = ONSET_BANDS[band]!;
      let weight = 0, rise = 0;
      for (let bin = Math.max(1, Math.ceil(from / binHz)); bin < spectrumDb.length && bin * binHz < to; bin++) {
        const now = floor(spectrumDb[bin]!), amplitude = Math.pow(10, now / 20);
        weight += amplitude;
        rise += amplitude * Math.min(ONSET_BIN_MAX_DB, Math.max(0, now - previous[bin]!));
      }
      const flux = weight > 0 ? rise / weight : 0;
      this.total[band] = (this.total[band]! + flux) % ONSET_WRAP;
    }
    for (let bin = 0; bin < spectrumDb.length; bin++) previous[bin] = floor(spectrumDb[bin]!);
  }

  reset(): void { this.previous = null; this.total.fill(0); }
}

function floor(value: number): number { return Number.isFinite(value) ? Math.max(ONSET_FLOOR_DB, value) : ONSET_FLOOR_DB; }

/** The rise between two counter readings (wrap-aware); NaN when either is missing or out of range. */
export function onsetDelta(now: number | undefined, before: number | undefined): number {
  if (!validCounter(now) || !validCounter(before)) return Number.NaN;
  return ((now - before) % ONSET_WRAP + ONSET_WRAP) % ONSET_WRAP;
}
export function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < ONSET_WRAP;
}
