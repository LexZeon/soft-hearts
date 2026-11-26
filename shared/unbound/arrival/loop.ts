/**
 * I-192: the closed loop that brings a part of her body the last few centimetres to its arrival point, every frame, from where that part really
 * is (the peek's loop, src/unbound/motion/procedural.ts U2, moved here unchanged so the peek, the kiss and the hug share one).
 *
 * Where the part would be with no hip offset and flat feet ("base") = measured − the offset already realized; the offset that puts it on target
 * = target − base = error + realized. The command follows that estimate through a first-order filter (no integrator, so nothing winds up while
 * her springs and her toes are still on their way), at most `maxRate` m/s, within the hips' reach. The outputs are goals like any other: the
 * figure's springs decide how fast she gets there, so she never jumps.
 */
export interface LoopError { x: number; y: number; z: number }
export interface LoopLimits { gain: number; maxRate: number; lateral: number; forwardBack: number; forward: number; down: number }

/** Gain (1/s), the rate limit (m/s) and how far the hips may be moved (m: across, back, forward, down; up is her toes' rise). */
export const ARRIVAL_LOOP: Readonly<LoopLimits> = Object.freeze({ gain: 4, maxRate: 0.25, lateral: 0.1, forwardBack: -0.08, forward: 0.12, down: -0.12 });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class ArrivalLoop {
  /** The hip offset and height commanded (her frame, m: lateral + = her left, forward, up). */
  lateral = 0; forward = 0; up = 0;
  /** The last error (her frame, m), for tests and the developer line. */
  lastError: LoopError = { x: 0, y: 0, z: 0 };
  constructor(private readonly limits: Readonly<LoopLimits> = ARRIVAL_LOOP) {}

  reset(): void { this.lateral = this.forward = this.up = 0; this.lastError = { x: 0, y: 0, z: 0 }; }

  /**
   * One frame: `error` = target − measured (her frame), `realized` = the hip offset and height her body shows now, `rise` = how high her toes
   * can bring her (m), `weight` 0..1 = how much the loop drives (0: it holds where it is), `dt` s.
   */
  step(error: LoopError, realized: { lateral: number; forward: number; up: number }, rise: number, weight: number, dt: number): void {
    const l = this.limits, step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.lastError = { ...error };
    const w = clamp(Number.isFinite(weight) ? weight : 0, 0, 1), k = 1 - Math.exp(-l.gain * w * step);
    const toward = (current: number, wanted: number, lo: number, hi: number) => current + clamp((clamp(wanted, lo, hi) - current) * k, -l.maxRate * dt, l.maxRate * dt);
    this.lateral = toward(this.lateral, error.x + realized.lateral, -l.lateral, l.lateral);
    this.forward = toward(this.forward, error.z + realized.forward, l.forwardBack, l.forward);
    this.up = toward(this.up, error.y + realized.up, l.down, Math.max(1e-3, rise));
  }

  /** The loop as pose goals: hips (down only; up is her toes) and tiptoe 0..1. */
  goals(rise: number): { pelvis: { lateral: number; forward: number; vertical: number }; tiptoe: number } {
    const r = Math.max(1e-3, rise), up = this.up;
    return { pelvis: { lateral: this.lateral, forward: this.forward, vertical: Math.min(0, up) }, tiptoe: up > 0 ? Math.min(1, up / r) : 0 };
  }
}
