/**
 * I-167 (docs/claude/2026-11-21-gaze-at-user.md): the One-Euro filter (Casiez, Roussel, Vogel 2012), written from the paper's idea.
 * A low-pass filter whose cut-off rises with how fast the value moves: at rest it smooths hard (no tremble from keypoint noise), on a
 * quick move it lets the value through almost at once (little lag). Pure, no clock: the caller gives each sample its time in seconds.
 *
 *   cutoff = minCutoff + beta × |smoothed speed|        (Hz; speed in the value's units per second)
 *   alpha  = 1 / (1 + 1 / (2π · cutoff · dt))
 */

export interface OneEuroSettings {
  /** Hz: how much it smooths a value that holds still (lower = steadier, more lag). */
  readonly minCutoff: number;
  /** How quickly the cut-off opens up as the value moves (per unit/s; higher = less lag on fast moves). */
  readonly beta: number;
  /** Hz: the smoothing of the speed estimate itself. */
  readonly dCutoff: number;
}

const alphaFor = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * Math.max(1e-6, cutoff) * dt));

export class OneEuroFilter {
  private value: number | null = null;
  private speed = 0;
  private at = 0;

  constructor(private readonly settings: OneEuroSettings) {}

  /** The filtered value after a sample `x` taken at `t` (seconds). A sample not after the last one, or not finite, changes nothing. */
  next(x: number, t: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(t)) return this.value ?? (Number.isFinite(x) ? x : 0);
    if (this.value === null) { this.value = x; this.speed = 0; this.at = t; return x; }
    const dt = t - this.at;
    if (!(dt > 0)) return this.value;
    this.at = t;
    const { minCutoff, beta, dCutoff } = this.settings;
    const raw = (x - this.value) / dt;
    this.speed += alphaFor(dCutoff, dt) * (raw - this.speed);
    const cutoff = Math.max(1e-3, minCutoff) + Math.max(0, beta) * Math.abs(this.speed);
    this.value += alphaFor(cutoff, dt) * (x - this.value);
    return this.value;
  }

  /** The last filtered value (null before the first sample). */
  get current(): number | null { return this.value; }

  /** Forget everything: the next sample is taken as it is. */
  reset(): void { this.value = null; this.speed = 0; this.at = 0; }
}
