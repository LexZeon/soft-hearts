/**
 * I-192 (docs/claude/2026-11-22-i192-arrival-targets.md): the thin adapter between a showcase intent's `arrive` and the shared closed loop
 * (shared/unbound/arrival/loop.ts). Each frame it measures where the aim point on her face really is (from her two visible eyes, so it moves
 * with her head however it is turned or tilted), compares it with the arrival point on the lens axis, and turns the loop's command into hip
 * and toe goals, mixed with the posture's own hips by the intent's weight (so on the way back her hips come home smoothly).
 */
import {
  ARRIVAL_KNOBS, ArrivalLoop, alongToFit, axisPlace, frameWorst, headNow, headPointNow, intoHerFrame, nearestAlong, settledShift, windowPoint,
  type ArrivalKnobs, type FaceGeometry, type HeadOffset, type ScreenSpot, type V3,
} from '../../../shared/unbound/arrival';
import type { LensView } from './lens-align';
import type { ShowcaseArrive } from './generator';

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (v: V3): V3 => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

/** The aim point now: `dropM` below her eyes' midpoint along her head's own down (world up made square to the line between her eyes). */
export function faceAimNow(eyes: { left: V3 | null; right: V3 | null }, dropM: number): V3 | null {
  const l = eyes.left, r = eyes.right;
  if (!l || !r) return null;
  const across = norm(sub(l, r)), d = across.y; // up − (up · across) across
  const up = norm({ x: -d * across.x, y: 1 - d * across.y, z: -d * across.z });
  return { x: (l.x + r.x) / 2 - up.x * dropM, y: (l.y + r.y) / 2 - up.y * dropM, z: (l.z + r.z) / 2 - up.z * dropM };
}

export interface ArriveSense { eyes: { left: V3 | null; right: V3 | null }; root: { heading: number }; offsets: { lateral: number; forward: number; up: number }; tiptoeRise: number }

export class FaceArrival {
  private readonly loop = new ArrivalLoop();
  /** The last error (her frame, m) and the aim point's distance from the target (m), for tests and the developer line. */
  get lastError(): V3 { return this.loop.lastError; }
  reset(): void { this.loop.reset(); }

  /** The hip and toe goals for this frame, mixed with the posture's own hips (`base`) by the intent's weight; null when her eyes are unknown. */
  goals(arrive: ShowcaseArrive, lens: LensView, sense: ArriveSense, dt: number, base: { lateral: number; forward: number; vertical: number }):
    { pelvis: { lateral: number; forward: number; vertical: number }; tiptoe: number } | null {
    const aim = arrive.point ? headPointNow(sense.eyes, arrive.point) : faceAimNow(sense.eyes, arrive.dropM);
    if (!aim) return null;
    const w = Math.min(1, Math.max(0, Number.isFinite(arrive.weight) ? arrive.weight : 0));
    const error = intoHerFrame(sub(windowPoint(lens, arrive.distanceM, arrive.spot), aim), sense.root.heading);
    // I-203: her toes only as far as the intent lets them (never while she steps); the loop's height command stays within that.
    const toes = Math.min(1, Math.max(0, Number.isFinite(arrive.toes) ? arrive.toes! : 1));
    this.loop.step(error, sense.offsets, sense.tiptoeRise * toes, w > 1e-4 && arrive.chase !== false ? 1 : 0, dt);
    const g = this.loop.goals(sense.tiptoeRise), mix = (a: number, b: number) => a + (b - a) * w;
    if (w <= 1e-4) this.loop.reset();
    return { pelvis: { lateral: mix(base.lateral, g.pelvis.lateral), forward: mix(base.forward, g.pelvis.forward), vertical: mix(base.vertical, g.pelvis.vertical) }, tiptoe: g.tiptoe * w };
  }
}

/** What the arrival check reads of her each frame (BodySense has it). */
export interface ArrivalCheckSense { eyes: { left: V3 | null; right: V3 | null }; head: V3 | null; root: { heading: number }; offsets: { lateral: number; forward: number; up: number }; tiptoeRise: number }
export interface ArrivalCheckFrame {
  /** Her face is there now: both eyes and her mouth inside the window, nothing of her head nearer than the guard, the aim at its distance. */
  reached: boolean;
  /** The worst of her eyes and mouth in the window (> 1: out), her head's nearest point along the axis (m), where her aim point is (m). */
  worst: number | null; nearestM: number | null; aimM: number | null;
}
/** How fast (m/s) the arrival distance may move out (or back) so her eyes and mouth fit: slower than her face rises on her toes. */
export const FRAME_PUSH_MPS = 0.12;
/** The farthest (m) the push takes her past the planned distance (her hips' reach back and forward, ARRIVAL_LOOP, is 0.2 m in all). */
export const FRAME_PUSH_MAX_M = 0.12;

/**
 * I-192 follow-up (Codex T-263): has her face really arrived? And when it cannot get onto the axis (the close-up camera sits at her standing
 * face height and leaning drops her face more than her toes lift it: measured 1–2 cm below on every model), how much farther she stops so her
 * eyes and mouth are both in the window and her head stays out of the camera. `framedM` is the arrival distance the aim goes to: the planned
 * one, pushed out (rate-limited, back toward the plan when there is room) by what the loop cannot deliver (shared/unbound/arrival/frame.ts).
 */
export class FaceArrivalCheck {
  framedM: number;
  /**
   * I-203: `spot` where in the window the point goes (the hug's ear at the screen's right; absent: on the axis), `point` the head point that goes
   * there instead of the aim below her eyes. With a `point` (the hug) that point must be in the window, not her eyes and mouth: her face is
   * turned outward and cut by the right edge, as in the user's picture; and its distance is its head share, never pushed out.
   */
  constructor(readonly plannedM: number, private readonly knobs: ArrivalKnobs = ARRIVAL_KNOBS, private readonly spot: ScreenSpot = { u: 0, v: 0 }, private readonly point: HeadOffset | null = null) { this.framedM = plannedM; }

  /** One frame of the wait or the hold. `dropM`: her aim point below her eyes; `mouthDropM`: her mouth below them; `face`: her measured head. */
  frame(dt: number, lens: LensView, sense: ArriveSense & ArrivalCheckSense, dropM: number, mouthDropM: number, face: FaceGeometry | null, outOnly = false): ArrivalCheckFrame {
    const l = sense.eyes.left, r = sense.eyes.right, aim = this.point ? headPointNow(sense.eyes, this.point) : faceAimNow(sense.eyes, dropM), mouth = faceAimNow(sense.eyes, mouthDropM);
    // T-264: an eye (or so her aim and mouth) not read this frame is never "in the window": not reached; the bounded wait decides (frameWorst says the same of a missing point).
    if (!l || !r || !aim || !mouth) return { reached: false, worst: null, nearestM: null, aimM: null };
    const heading = sense.root.heading, guard = this.knobs.minClearM + this.knobs.hairSwingM;
    // Where the loop will still bring her (it cannot lift her past her toes): her eyes, mouth and head there.
    const target = windowPoint(lens, this.framedM, this.spot);
    const shift = settledShift(sub(target, aim), sense.offsets, sense.tiptoeRise, heading);
    const moved = (p: V3): V3 => ({ x: p.x + shift.x, y: p.y + shift.y, z: p.z + shift.z });
    const head = face && sense.head ? headNow(face.points, face.eyes, { head: sense.head, left: l, right: r, heading }) : null;
    // What must be in the window: her eyes and her mouth (the kiss: the storyboard's end frame), or the point itself (the hug's ear).
    const seen = this.point ? [aim] : [l, r, mouth];
    const fit = this.point ? null : alongToFit(lens, seen.map(moved), this.knobs.frameInset);
    const clip = head ? guard - nearestAlong(lens, head.map(moved)) : -Infinity;
    // `outOnly` (the hold): she may still ease out to keep her eyes and mouth in, never back in (no slow hunting while she stays).
    // Never past what her hips can take her back (ARRIVAL_LOOP: a window she cannot fill does not send her across the room).
    const wanted = Math.min(this.plannedM + FRAME_PUSH_MAX_M, Math.max(this.plannedM, outOnly ? this.framedM : -Infinity, this.framedM + Math.max(fit ?? -Infinity, clip)));
    const step = FRAME_PUSH_MPS * Math.max(0, Math.min(0.1, dt));
    this.framedM += Math.max(-step, Math.min(step, wanted - this.framedM));
    // Now (not predicted): in the window, out of the camera, at its distance, the push settled.
    const worst = frameWorst(lens, seen), nearestM = head ? nearestAlong(lens, head) : null, aimM = axisPlace(lens, aim).along, targetM = axisPlace(lens, target).along;
    const reached = (worst === null || worst <= 1) && (nearestM === null || nearestM >= guard - 0.005) && Math.abs(aimM - targetM) <= 0.02 && Math.abs(wanted - this.framedM) <= 0.01;
    return { reached, worst, nearestM, aimM };
  }
}
