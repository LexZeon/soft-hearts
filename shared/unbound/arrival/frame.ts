/**
 * I-192 follow-up (Codex T-263, docs/claude/2026-11-22-i192-arrival-targets.md "2026-11-22 晚"): has her face really arrived? The user's goal:
 * "抱抱重点不是手收拢，在unbound里是脸贴过来……终点大概是到只看得到闭眼的稍稍侧的脸。亲亲同理。和凑过来看异曲同工" and "注意不能穿模摄像头那一块".
 * So the hold starts only when both her eyes and her mouth are inside the window and nothing of her head is nearer the lens than the guard;
 * a short bounded wait, then she holds where she is (she never freezes). Before this the hold began when the lean's timer ended, wherever
 * her face was (measured on every model: the mouth below the window's bottom edge at the first hold frame, 1.03–1.52 half-heights).
 *
 *   inWindow     where a point is in the window (u across, v up; inside when both are within ±1)
 *   frameWorst   the worst of several points (the largest |u| or |v|)
 *   alongToFit   how much farther along the lens axis the points (moving with her along the axis) must go to be inside the window, shrunk by
 *                an inset (≤ 0: room to spare). The arrival distance is pushed out by it when her toes and hips cannot bring her face onto
 *                the axis (the close-up camera sits at her standing face height; leaning, her face drops more than her toes can lift it)
 *   headNow      her head's measured points (face.ts FaceGeometry.points) where they are now, turned as her two eyes show her head turned
 *   settledShift where the loop (loop.ts) will still move her: what it can deliver of the error, within its limits (the rest stays off)
 * Pure: plain numbers. The camera looks straight down −z (src/unbound/camera.ts); the axis goes through the window's centre.
 */
import type { V3 } from './solve';
import { intoHerFrame, axisPlace, type ArrivalLens } from './solve';
import { ARRIVAL_LOOP, type LoopLimits } from './loop';

/** The window per metre ahead of the camera (x right, y up over the depth along −z). */
export interface ArrivalWindow { left: number; right: number; top: number; bottom: number }
/** A lens that knows its window (src/unbound/motion/lens-align.ts lensView adds it). */
export interface FramedLens extends ArrivalLens { window?: ArrivalWindow }

const finite = (...v: number[]) => v.every(Number.isFinite);
const usable = (w: ArrivalWindow | undefined): w is ArrivalWindow => !!w && finite(w.left, w.right, w.top, w.bottom) && w.right > w.left && w.top > w.bottom;

/** Where `p` is in the window: u across (−1 left edge, +1 right edge), v up, its depth ahead of the camera (m; ≤ 0: behind it). */
export function inWindow(lens: FramedLens, p: V3): { u: number; v: number; depth: number } | null {
  const w = lens.window;
  if (!usable(w)) return null;
  const depth = lens.camera.z - p.z;
  if (!(depth > 1e-6)) return { u: Infinity, v: Infinity, depth };
  const x = (p.x - lens.camera.x) / depth, y = (p.y - lens.camera.y) / depth;
  return { u: (2 * x - w.left - w.right) / (w.right - w.left), v: (2 * y - w.top - w.bottom) / (w.top - w.bottom), depth };
}

/** The worst of the points (the largest |u| or |v|; > 1: out of the window); null without a window or a point. */
export function frameWorst(lens: FramedLens, points: readonly (V3 | null)[]): number | null {
  let worst = -Infinity, any = false;
  for (const p of points) {
    if (!p) return Infinity; // a point we cannot see is not in frame
    const at = inWindow(lens, p);
    if (!at) return null;
    any = true;
    worst = Math.max(worst, Math.abs(at.u), Math.abs(at.v));
  }
  return any ? worst : null;
}

/**
 * How far (m) farther along the axis the points must move (all together, along the axis) so each is inside the window shrunk by `inset`
 * (a share of each half: 0.1 keeps the outer tenth free). Negative: that much room to spare. null without a window or a point.
 * A point p = camera + r moved by axis·Δ: its depth D − a.z·Δ grows and it slides toward the window's centre, so each edge gives one bound
 * on Δ (the axis through the window's centre: a.x = −cx·a.z, a.y = −cy·a.z).
 */
export function alongToFit(lens: FramedLens, points: readonly V3[], inset = 0): number | null {
  const w = lens.window, az = -lens.axis.z;
  if (!usable(w) || !points.length || !(az > 1e-3)) return null;
  const k = 1 - Math.min(0.9, Math.max(0, Number.isFinite(inset) ? inset : 0));
  const cx = (w.left + w.right) / 2, cy = (w.top + w.bottom) / 2, hx = (w.right - w.left) / 2 * k, hy = (w.top - w.bottom) / 2 * k;
  let need = -Infinity;
  for (const p of points) {
    const rx = p.x - lens.camera.x, ry = p.y - lens.camera.y, d = lens.camera.z - p.z;
    // right: rx + a.x Δ ≤ (cx + hx)(d − a.z Δ)  ⇔  Δ ≥ (rx − (cx + hx) d) / (az hx); the other three edges the same way.
    need = Math.max(need, (rx - (cx + hx) * d) / (az * hx), ((cx - hx) * d - rx) / (az * hx), (ry - (cy + hy) * d) / (az * hy), ((cy - hy) * d - ry) / (az * hy));
  }
  return Number.isFinite(need) ? need : null;
}

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (v: V3): V3 | null => { const l = Math.hypot(v.x, v.y, v.z); return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : null; };
const fromHerFrame = (v: V3, heading: number): V3 => { const c = Math.cos(heading), s = Math.sin(heading); return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }; };

/**
 * Her head's points (from her head bone, her frame at rest: face.ts) where they are now (world), turned as her two eyes show it: the line
 * between her eyes is her head's left (her frame x at rest), the head bone → eyes vector the second direction (TRIAD). null when unknown.
 */
export function headNow(points: readonly V3[], restEyes: V3, now: { head: V3; left: V3; right: V3; heading: number }): V3[] | null {
  const her = (v: V3) => intoHerFrame(v, now.heading);
  const head = her(now.head), left = her(now.left), right = her(now.right);
  const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, z: (left.z + right.z) / 2 };
  const a1 = { x: 1, y: 0, z: 0 }, b1 = unit(sub(left, right));
  const a2 = unit(cross(a1, restEyes)), b2u = b1 ? unit(cross(b1, sub(mid, head))) : null;
  if (!b1 || !a2 || !b2u) return null;
  const a3 = cross(a1, a2), b3 = cross(b1, b2u);
  // R = [b1 b2 b3]·[a1 a2 a3]ᵀ, applied to each point.
  return points.map(p => {
    const c1 = p.x * a1.x + p.y * a1.y + p.z * a1.z, c2 = p.x * a2.x + p.y * a2.y + p.z * a2.z, c3 = p.x * a3.x + p.y * a3.y + p.z * a3.z;
    const r = { x: head.x + b1.x * c1 + b2u.x * c2 + b3.x * c3, y: head.y + b1.y * c1 + b2u.y * c2 + b3.y * c3, z: head.z + b1.z * c1 + b2u.z * c2 + b3.z * c3 };
    return fromHerFrame(r, now.heading);
  });
}

/** The nearest of the points along the axis (m; Infinity for none). */
export function nearestAlong(lens: ArrivalLens, points: readonly V3[]): number {
  let near = Infinity;
  for (const p of points) near = Math.min(near, axisPlace(lens, p).along);
  return near;
}

/**
 * Where the closed loop will still move her (world, m): `error` = target − the part now (world), `realized` = the hip offset and height her body
 * shows (her frame), `rise` = her toes' reach. The loop goes on until its command is the error plus what is realized, within its limits; what
 * it cannot deliver stays off. The shift is that command less what is realized, back in the world.
 */
export function settledShift(error: V3, realized: { lateral: number; forward: number; up: number }, rise: number, heading: number, limits: Readonly<LoopLimits> = ARRIVAL_LOOP): V3 {
  const e = intoHerFrame(error, heading), clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const lateral = clamp(e.x + realized.lateral, -limits.lateral, limits.lateral) - realized.lateral;
  const forward = clamp(e.z + realized.forward, limits.forwardBack, limits.forward) - realized.forward;
  const up = clamp(e.y + realized.up, limits.down, Math.max(1e-3, rise)) - realized.up;
  return fromHerFrame({ x: lateral, y: up, z: forward }, heading);
}
