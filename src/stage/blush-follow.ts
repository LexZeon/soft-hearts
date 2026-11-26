/**
 * The companion's blush comes and goes like a real flush (after the showcase's round-15 fix for a blush
 * that "瞬间出现"). Measured before: the shy show's blush went from 0.1 to 0.6 in 0.35 s and was gone in 0.4 s; the mood cue's
 * card envelope rises in 0.45 s by default.
 *
 * Every natural blush (the shy show, the mood cue, procedural life's blush and accents) passes through this one follower before it
 * is painted, so no source can make the cheeks jump: a critically damped spring toward the target, quicker up than down.
 * - Up (rate 3.05/s): 10%→90% of a step in about 1.1 s, 0.1→0.6 in about 0.5 s, 95% at about 1.55 s.
 * - Down (rate 1.8/s): 90%→10% in about 1.9 s, down to 5% at about 2.6 s.
 * A blush shorter than that still shows (the shy show reaches about 0.87 of its own level, the mood cue about 0.93); the fade simply
 * outlasts the cue, which is what a flush does.
 *
 * The settings slider preview and the character page's 试一下 bypass it (they show the setting itself, at once). Exact per-step
 * solution, so any frame time is stable; it snaps to the target once within 1e-4 so "back to 0" is exactly 0.
 */
export const BLUSH_FOLLOW = Object.freeze({ rise: 3.05, fall: 1.8 });

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export class BlushFollow {
  private current = 0;
  private velocity = 0;

  get value(): number { return this.current; }

  reset(value = 0): void { this.current = clamp01(Number.isFinite(value) ? value : 0); this.velocity = 0; }

  /** One frame toward `target` (0..1) after `delta` seconds; returns the blush to paint. */
  frame(target: number, delta: number): number {
    const goal = clamp01(Number.isFinite(target) ? target : 0);
    if (!(delta > 0) || !Number.isFinite(delta)) return this.current;
    const rate = goal > this.current ? BLUSH_FOLLOW.rise : BLUSH_FOLLOW.fall;
    const offset = this.current - goal, carry = this.velocity + rate * offset, decay = Math.exp(-rate * delta);
    const next = goal + (offset + carry * delta) * decay;
    this.velocity = (carry - rate * (offset + carry * delta)) * decay;
    this.current = clamp01(next);
    if (this.current !== next) this.velocity = 0; // held at 0 or 1: no stored push past the edge
    if (Math.abs(this.current - goal) < 1e-4 && Math.abs(this.velocity) < 1e-3) { this.current = goal; this.velocity = 0; }
    return this.current;
  }
}
