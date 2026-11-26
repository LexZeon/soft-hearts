/**
 * I-073 part 3, layer 4 ("排时"): where in the voice an accent lands.
 *
 * The cloud voices (Bailian, Fish) schedule their PCM a little ahead of playing it; EmotionalVoice reports each scheduled
 * chunk's loudness (RMS per short window) with how far ahead it plays. Those levels are kept here on the layer's clock,
 * tagged with the reply segment they belong to. Only real samples count:
 *  - a loud point = the largest level inside the clause's window (an accent lands there);
 *  - a real pause = levels below `pauseLevel` × the segment's loudest for at least `minPause` seconds. A dip between words
 *    is shorter; a network underrun has no samples at all (nothing was scheduled), so neither is a pause.
 * The system voice gives no PCM: then there is nothing to find here and the accent goes to the clause's estimated start.
 * Pure data structure, fixed size, no allocation per frame.
 */
const CAPACITY = 2048;

export class LevelTrack {
  private readonly t = new Float64Array(CAPACITY);
  private readonly v = new Float32Array(CAPACITY);
  private readonly k: string[] = new Array(CAPACITY).fill('');
  private head = 0;
  private size = 0;
  /** Seconds per sample of the latest report (for span ends). */
  private step = 0.04;

  clear(): void { this.head = 0; this.size = 0; }

  /** Levels for `key` (a reply segment), the first one at `at` (layer clock, s), then every `step` s. */
  add(key: string, at: number, step: number, levels: ArrayLike<number>): void {
    if (!(step > 0) || !Number.isFinite(at)) return;
    this.step = step;
    for (let i = 0; i < levels.length; i++) {
      const value = Number(levels[i]);
      const slot = (this.head + this.size) % CAPACITY;
      this.t[slot] = at + i * step; this.v[slot] = Number.isFinite(value) && value > 0 ? Math.min(1, value) : 0; this.k[slot] = key;
      if (this.size < CAPACITY) this.size++; else this.head = (this.head + 1) % CAPACITY;
    }
  }

  /** Forget samples older than `before` (layer clock). */
  prune(before: number): void {
    while (this.size > 0 && this.t[this.head] < before) { this.head = (this.head + 1) % CAPACITY; this.size--; }
  }

  /** [first, last + step] of `key`'s samples, or null. */
  span(key: string): { from: number; to: number; peak: number } | null {
    let from = Infinity, to = -Infinity, peak = 0;
    for (let n = 0; n < this.size; n++) {
      const i = (this.head + n) % CAPACITY;
      if (this.k[i] !== key) continue;
      if (this.t[i] < from) from = this.t[i];
      if (this.t[i] > to) to = this.t[i];
      if (this.v[i] > peak) peak = this.v[i];
    }
    return from <= to ? { from, to: to + this.step, peak } : null;
  }

  /** The time of the loudest sample of `key` in [from, to] at or above `floor`, or null. */
  loudest(key: string, from: number, to: number, floor: number): number | null {
    let best = -1, at: number | null = null;
    for (let n = 0; n < this.size; n++) {
      const i = (this.head + n) % CAPACITY;
      if (this.k[i] !== key || this.t[i] < from || this.t[i] > to) continue;
      if (this.v[i] >= floor && this.v[i] > best) { best = this.v[i]; at = this.t[i]; }
    }
    return at;
  }

  /**
   * The start of the first real pause of `key` in [from, to]: consecutive samples (no gap longer than 1.5 steps: an
   * underrun breaks the run) below `quiet`, lasting at least `minPause` s. Null when there is none.
   */
  pause(key: string, from: number, to: number, quiet: number, minPause: number): number | null {
    let runStart = NaN, prev = NaN;
    for (let n = 0; n < this.size; n++) {
      const i = (this.head + n) % CAPACITY;
      if (this.k[i] !== key || this.t[i] < from) continue;
      if (this.t[i] > to && Number.isNaN(runStart)) break;
      const t = this.t[i];
      const contiguous = !Number.isNaN(prev) && t - prev <= this.step * 1.5;
      if (this.v[i] < quiet) {
        if (Number.isNaN(runStart) || !contiguous) runStart = t;
        if (t + this.step - runStart >= minPause - 1e-9) return runStart;
      } else runStart = NaN;
      prev = t;
    }
    return null;
  }

  get length(): number { return this.size; }
}

/** Loudness of a PCM span as RMS per window (`windowSamples` samples each), for EmotionalVoice's scheduled chunks. */
export function rmsLevels(samples: ArrayLike<number>, windowSamples: number): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(windowSamples));
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i++) { const s = samples[i]; sum += s * s; }
    out.push(Math.round(Math.sqrt(sum / Math.max(1, end - start)) * 1e4) / 1e4);
  }
  return out;
}
