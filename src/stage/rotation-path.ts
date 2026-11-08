import type { Quaternion } from 'three';

/** Below this vector-part length the relative rotation's axis is noise (a whole number of half-angle turns). */
const AXIS_EPSILON = 1e-6;

/**
 * R29e (docs/claude/2026-11-02-R29e-half-turn.md): which way round a blend goes,
 * kept continuous while both of its ends move.
 *
 * A blend from `from` toward `to` by `weight` is from * (from^-1 * to)^weight.
 * The plain shortest slerp chooses the short way round afresh for every pair, so
 * when the relative rotation passes a half turn (180 deg) - a live target that
 * keeps turning, or a layer whose base drifts away from its sample - it switches
 * to the other way round between two frames and the blended pose jumps by up to
 * 2 * 180 * min(w, 1 - w) degrees, however small the input step was (Codex
 * T-002 / P-003). Fixing the quaternion sign does not help: the jump is in the
 * choice of path, not in the representation.
 *
 * This keeps the relative rotation as an unwrapped axis and half-angle that
 * follow it from one blend to the next:
 * - the first blend after construction or reset() takes the short way, so it
 *   equals the shortest slerp (and stays equal for as long as the relative
 *   rotation stays short of a half turn: every static target, every target that
 *   never gets that far);
 * - later blends continue the way the relative rotation actually went, through
 *   a half turn and past a full turn, so a small input step is a small output
 *   step; q and -q of either end give the same result;
 * - the end points never change: weight 0 is `from`, weight 1 is `to`.
 * The history is one axis and one angle; it says nothing about speed, so the
 * result does not depend on the frame rate. A jump of the input itself (a cut
 * in the target) is not smoothed here: it passes through scaled by the weight,
 * as before, and the display guard (pose-continuity.ts) handles it.
 */
export class RotationPath {
  private ax = 0;
  private ay = 0;
  private az = 0;
  private axisKnown = false;
  /** Unwrapped half-angle of the relative rotation (radians); its sign goes with the stored axis. */
  private half = 0;

  /** Forget the way round: the next blend takes the short way. */
  reset(): void { this.half = 0; this.axisKnown = false; }

  /** Writes from * (from^-1 * to)^weight into `out` (which may be `from` or `to`); both inputs are normalized copies. */
  blend(from: Quaternion, to: Quaternion, weight: number, out: Quaternion): Quaternion {
    const fn = Math.hypot(from.x, from.y, from.z, from.w) || 1, tn = Math.hypot(to.x, to.y, to.z, to.w) || 1;
    const fx = from.x / fn, fy = from.y / fn, fz = from.z / fn, fw = from.w / fn;
    const tx = to.x / tn, ty = to.y / tn, tz = to.z / tn, tw = to.w / tn;
    // Relative rotation conj(from) * to.
    const rx = fw * tx - fx * tw - fy * tz + fz * ty;
    const ry = fw * ty - fy * tw - fz * tx + fx * tz;
    const rz = fw * tz - fz * tw - fx * ty + fy * tx;
    const rw = fw * tw + fx * tx + fy * ty + fz * tz;
    const s = Math.hypot(rx, ry, rz), turns = Math.round(this.half / Math.PI);
    let mx: number, my: number, mz: number, angle: number;
    if (s <= AXIS_EPSILON && this.axisKnown && turns !== 0) {
      // A whole number of half-angle turns past the start: the vector part is noise,
      // so keep the axis the turns were made about.
      mx = this.ax; my = this.ay; mz = this.az; angle = turns * Math.PI;
    } else {
      // The same rotation is (m, a + k*pi) or (-m, -a + k*pi) for every integer k: take the
      // axis sign nearest the stored axis, then the turn count nearest the stored angle.
      angle = Math.atan2(s, rw);
      if (s > 0) { mx = rx / s; my = ry / s; mz = rz / s; } else { mx = 1; my = 0; mz = 0; }
      if (this.axisKnown && mx * this.ax + my * this.ay + mz * this.az < 0) { mx = -mx; my = -my; mz = -mz; angle = -angle; }
      angle += Math.round((this.half - angle) / Math.PI) * Math.PI;
      if (s > AXIS_EPSILON) { this.ax = mx; this.ay = my; this.az = mz; this.axisKnown = true; }
    }
    this.half = angle;
    const turn = (Number.isFinite(weight) ? weight : 0) * angle, sin = Math.sin(turn);
    const px = mx * sin, py = my * sin, pz = mz * sin, pw = Math.cos(turn);
    // out = from * part
    return out.set(
      fw * px + fx * pw + fy * pz - fz * py,
      fw * py + fy * pw + fz * px - fx * pz,
      fw * pz + fz * pw + fx * py - fy * px,
      fw * pw - fx * px - fy * py - fz * pz,
    );
  }
}
