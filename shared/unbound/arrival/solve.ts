/**
 * I-192: where she stands and how far she leans so that a part of her body arrives at a point in viewer space (on the lens axis, a distance
 * from the lens). The peek's own geometry (src/unbound/motion/lens-align.ts, U2) made general: any point of her upper body, not only one eye,
 * and her head turned on the way. Pure (her world: y up, the screen at z = 0, the viewer's eye in front of it; her frame: root on her floor,
 * x toward her left, y up, z forward).
 *
 *   lean    her upper body pitches forward about the pivot (the bottom of her upper body); her head counter-pitches about as much, so her face
 *           stays toward you: a head point rides the head bone's arc, its offset from the head bone keeps its direction (turned by the yaw)
 *   reach   the lean she can use: the wanted one, or less when leaning would bring the point below the target even on her toes, within limits
 *   stand   the root that puts the leaned point at the target (across and in depth); what is left in height is for her toes or a small bend
 * The rest is the closed loop's (loop.ts): each frame it measures where the part really is and moves her hips the last few centimetres.
 */
export interface V3 { x: number; y: number; z: number }
/** The lens: the camera (the viewer's eye) and the unit axis from it through the window's centre; `heightPerM`: the view's height per metre ahead. */
export interface ArrivalLens { camera: V3; axis: V3; heightPerM?: number }

/** Joint limits of the reach (rad): she never bows deeper than this to arrive, and never less than `minLean` once she leans at all. */
export const ARRIVAL_LIMITS = Object.freeze({ maxLean: 0.42, minLean: 0.03 });

/** The point `distance` along the lens axis from the camera. */
export const alongAxis = (lens: ArrivalLens, distance: number): V3 =>
  ({ x: lens.camera.x + lens.axis.x * distance, y: lens.camera.y + lens.axis.y * distance, z: lens.camera.z + lens.axis.z * distance });

/** The window per metre ahead of the camera (x right, y up over the depth; the camera looks down −z). */
export interface WindowPerM { left: number; right: number; top: number; bottom: number }
/**
 * I-203: the point `along` the axis from the camera, moved within its depth to sit at `spot` in the window (u across, v up; ±1 the edges).
 * Spot {0, 0} or no window: on the axis (alongAxis). The hug's ear goes to the screen's right this way (shared/unbound/arrival/screen-frame.ts).
 */
export function windowPoint(lens: ArrivalLens & { window?: WindowPerM }, along: number, spot: { u: number; v: number } = { u: 0, v: 0 }): V3 {
  const p = alongAxis(lens, along), w = lens.window;
  if (!w || !(w.right > w.left) || !(w.top > w.bottom) || !Number.isFinite(spot.u) || !Number.isFinite(spot.v) || (spot.u === 0 && spot.v === 0)) return p;
  const depth = lens.camera.z - p.z, cx = (w.left + w.right) / 2, cy = (w.top + w.bottom) / 2, hx = (w.right - w.left) / 2, hy = (w.top - w.bottom) / 2;
  return { x: lens.camera.x + depth * (cx + spot.u * hx), y: lens.camera.y + depth * (cy + spot.v * hy), z: p.z };
}

/** A point's distance along the axis and how far off it (m). */
export function axisPlace(lens: ArrivalLens, p: V3): { along: number; off: number } {
  const dx = p.x - lens.camera.x, dy = p.y - lens.camera.y, dz = p.z - lens.camera.z;
  const along = dx * lens.axis.x + dy * lens.axis.y + dz * lens.axis.z;
  return { along, off: Math.hypot(dx - lens.axis.x * along, dy - lens.axis.y * along, dz - lens.axis.z * along) };
}

/** A point of her (her frame) after the upper body leans by `lean` about `pivot` (the whole point rides the arc). */
export function leanPoint(p: V3, pivot: V3, lean: number): V3 {
  const up = p.y - pivot.y, fwd = p.z - pivot.z, c = Math.cos(lean), s = Math.sin(lean);
  return { x: p.x, y: pivot.y + up * c - fwd * s, z: pivot.z + fwd * c + up * s };
}
/** A head point: the head bone rides the lean's arc, the point keeps its offset from it (the head counter-pitches: the face stays toward you). */
export const leanHeadPoint = (head: V3, offset: V3, pivot: V3, lean: number): V3 => {
  const h = leanPoint(head, pivot, lean);
  return { x: h.x + offset.x, y: h.y + offset.y, z: h.z + offset.z };
};

/**
 * The lean to use: `wanted`, or less when it would bring the point lower than `targetY` even with `rise` of toes (m), never below `min` and
 * never past the limit. `at(lean)` is where the point is at that lean (leanPoint or leanHeadPoint).
 */
export function reachLean(at: (lean: number) => V3, targetY: number, wanted: number, rise: number, min: number = ARRIVAL_LIMITS.minLean): number {
  const want = Math.min(ARRIVAL_LIMITS.maxLean, wanted);
  if (at(want).y + rise >= targetY) return want;
  let lo = Math.min(min, want), hi = want;
  if (at(lo).y + rise < targetY) return lo;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (at(mid).y + rise >= targetY) lo = mid; else hi = mid; }
  return lo;
}

/** Her frame → world on the floor for heading `h`: x (her left) is (cos h, −sin h), z (forward) is (sin h, cos h). */
export function standUnder(leaned: V3, target: V3, heading: number): { x: number; z: number; heading: number; rise: number } {
  const c = Math.cos(heading), s = Math.sin(heading), wx = leaned.x * c + leaned.z * s, wz = -leaned.x * s + leaned.z * c;
  return { x: target.x - wx, z: target.z - wz, heading, rise: target.y - leaned.y };
}

/** A world vector in her frame for heading `h`. */
export function intoHerFrame(v: V3, heading: number): V3 {
  const c = Math.cos(heading), s = Math.sin(heading);
  return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}

/** The heading (rad, 0 = facing +z, toward the viewer) that faces back along the axis. */
export const facingAxis = (lens: ArrivalLens): number => Math.atan2(-lens.axis.x, -lens.axis.z);

export interface ArrivalSolve { stand: { x: number; z: number }; heading: number; lean: number; target: V3; rise: number }
/**
 * The whole solve for a head point: `head` (her head bone, her frame, as she stands now), `offset` (the point from the head bone, turned as her
 * head will be), `pivot`; the target `distanceM` along the axis; the lean she wants and how much her toes can add.
 */
export function solveHeadArrival(input: { head: V3; offset: V3; pivot: V3; lens: ArrivalLens & { window?: WindowPerM }; distanceM: number; wantedLean: number; rise: number; spot?: { u: number; v: number } }): ArrivalSolve {
  const target = windowPoint(input.lens, input.distanceM, input.spot), heading = facingAxis(input.lens);
  const at = (lean: number) => leanHeadPoint(input.head, input.offset, input.pivot, lean);
  const lean = reachLean(at, target.y, input.wantedLean, input.rise);
  const stand = standUnder(at(lean), target, heading);
  return { stand: { x: stand.x, z: stand.z }, heading, lean, target, rise: stand.rise };
}
