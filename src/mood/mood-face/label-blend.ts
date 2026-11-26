/**
 * Twitch round 3 (docs/claude/2026-11-10-face-head-twitch.md "第三轮"): a mood label (primary, companion) used to pick a
 * whole row of face targets at once, so when it changed every target stepped on the same frame and the first-order
 * followers (continuous-expression.ts, mood-feedback.ts) started at full speed: the face and the tiny head pitch
 * "twitched" with nobody talking. LabelBlend turns the label into weights that drift from the old label(s) to the new one
 * along a smootherstep (zero speed at both ends) over MOOD_FACE_KNOBS.driftSeconds; callers evaluate their per-label
 * targets and sum them by these weights, so the target is continuous with continuous speed, and the follower's output
 * starts moving at zero speed.
 *
 * A change in the middle of a drift starts a new drift from the weights shown at that moment (no jump). Weights always sum
 * to 1; the first label seen (or after reset) is taken at once (there is no old face to drift from).
 */

const MAX_ENTRIES = 4;
const smootherstep = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * t * (t * (6 * t - 15) + 10); };

export interface LabelWeight { label: string; weight: number }

export class LabelBlend {
  /** Labels shown when the current drift started, with their weights then (sum 1). */
  private readonly start: LabelWeight[] = [];
  private current: string | null = null;
  private progress = 1;
  /** This frame's labels and weights (sum 1; the current label is always among them). Read only. */
  readonly out: LabelWeight[] = [];
  private readonly pool: LabelWeight[] = [];

  reset(): void { this.start.length = 0; this.out.length = 0; this.current = null; this.progress = 1; }

  /** Advances by `delta` s toward `label`, drifting over `seconds` (0 or less: at once). Returns `out`. */
  frame(delta: number, label: string, seconds: number): readonly LabelWeight[] {
    const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (this.current === null) {
      this.current = label; this.progress = 1;
      this.start.length = 0; this.start.push({ label, weight: 1 });
    } else if (label !== this.current) {
      // Start again from what is shown now: the shown weights become the start, the new label grows from 0.
      this.start.length = 0;
      for (const entry of this.out) this.start.push({ label: entry.label, weight: entry.weight });
      this.current = label; this.progress = 0;
      if (this.start.length > MAX_ENTRIES) this.fold();
    }
    this.progress = seconds > 0 && Number.isFinite(seconds) ? Math.min(1, this.progress + dt / seconds) : 1;
    const s = smootherstep(this.progress);
    this.out.length = 0;
    let own = s;
    for (const entry of this.start) {
      const weight = entry.weight * (1 - s);
      if (entry.label === this.current) own += weight;
      else if (weight > 0) this.put(entry.label, weight);
    }
    this.put(this.current, own);
    if (this.progress >= 1) { this.start.length = 0; this.start.push({ label: this.current, weight: 1 }); }
    return this.out;
  }

  /** Σ weight · fn(label) over this frame's weights. */
  sum(fn: (label: string) => number): number {
    let total = 0;
    for (const entry of this.out) total += entry.weight * fn(entry.label);
    return total;
  }

  /** Entry objects are reused frame to frame (no allocation per frame); `start` holds its own copies. */
  private put(label: string, weight: number): void {
    const entry = this.pool[this.out.length] ??= { label, weight };
    entry.label = label; entry.weight = weight;
    this.out.push(entry);
  }

  /** More than MAX_ENTRIES labels at once (labels changing faster than the drift): the smallest ones go to the largest old one. */
  private fold(): void {
    this.start.sort((a, b) => b.weight - a.weight);
    while (this.start.length > MAX_ENTRIES) this.start[0].weight += this.start.pop()!.weight;
  }
}
