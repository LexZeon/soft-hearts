/**
 * Unbound U2, layer 2 math for peek-lens (docs/claude/2026-11-12-unbound-peek.md): where "the lens" is, where her eye has to be,
 * where she should stand, how far she can lean, and which eye. Pure (plain objects, meters, her world: y up, the screen at z = 0,
 * the viewer's eye in front of it). No Three.js. I-192: the lean, reach and stand math is the shared arrival solve's (shared/unbound/arrival/solve.ts),
 * which makes it general for any part of her; these keep the peek's own names for one eye.
 */
import { leanPoint, reachLean, standUnder } from '../../../shared/unbound/arrival';

export interface V3 { x: number; y: number; z: number }

/** The lens: the camera (the viewer's eye) and the axis from it through the centre of the window, into her world (unit). */
export interface LensView {
  camera: V3; axis: V3; /** How tall the view is per meter ahead (the window's frustum). */ heightPerM?: number;
  /** I-192 follow-up: the window per metre ahead (x right, y up over the depth; the camera looks down −z), so "in frame" can be checked. */
  window?: { left: number; right: number; top: number; bottom: number };
}

/** The axis through the window's centre for an off-axis frustum (near-plane extents relative to the eye; the camera looks down −z). */
export function lensView(camera: V3, frustum: { left: number; right: number; top: number; bottom: number; near: number }): LensView {
  const x = (frustum.left + frustum.right) / 2, y = (frustum.top + frustum.bottom) / 2, z = -frustum.near;
  const length = Math.hypot(x, y, z) || 1;
  const n = frustum.near;
  return { camera: { ...camera }, axis: { x: x / length, y: y / length, z: z / length }, heightPerM: (frustum.top - frustum.bottom) / n,
    window: { left: frustum.left / n, right: frustum.right / n, top: frustum.top / n, bottom: frustum.bottom / n } };
}

/** The point `distance` along the axis from the camera. */
export const onAxis = (view: LensView, distance: number): V3 =>
  ({ x: view.camera.x + view.axis.x * distance, y: view.camera.y + view.axis.y * distance, z: view.camera.z + view.axis.z * distance });

/** A point's distance along the axis, and how far it is off the axis (m). */
export function axisOffset(view: LensView, point: V3): { along: number; off: number } {
  const dx = point.x - view.camera.x, dy = point.y - view.camera.y, dz = point.z - view.camera.z;
  const along = dx * view.axis.x + dy * view.axis.y + dz * view.axis.z;
  return { along, off: Math.hypot(dx - view.axis.x * along, dy - view.axis.y * along, dz - view.axis.z * along) };
}

/** The heading (rad, 0 = facing +z, toward the viewer) that faces back along the axis. */
export const facingLens = (view: LensView) => Math.atan2(-view.axis.x, -view.axis.z);

/**
 * Her body as the generator needs it, measured in her own frame at the moment (root on her floor, x toward her left, y up, z
 * forward): each eye, and the lean pivot (the bottom of her upper body).
 */
export interface BodyFrame { eyes: { left: V3; right: V3 }; pivot: V3 }
export type EyeSide = 'left' | 'right';
/** I-192 follow-up: what the peek brings onto the axis: one eye (I-104's first look), or the point between both (both eyes in the frame). */
export type EyeAim = EyeSide | 'both';
/** The eye (or the point between both) for an aim; null when an eye it needs is unknown. */
export function eyePoint(eyes: { left: V3 | null; right: V3 | null }, aim: EyeAim): V3 | null {
  if (aim !== 'both') return eyes[aim];
  const l = eyes.left, r = eyes.right;
  return l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, z: (l.z + r.z) / 2 } : null;
}

/** Where the eye ends up after leaning the upper body forward by `lean` about the pivot (her frame). */
export const leanEye = (frame: BodyFrame, eye: EyeAim, lean: number): V3 => leanPoint(eyePoint(frame.eyes, eye)!, frame.pivot, lean);

/**
 * The lean to use: the wanted one, or less when leaning would bring her eye too low to reach the axis even on her toes
 * (`rise`: how much higher she can bring it, m), never less than `min`.
 */
export const leanFor = (frame: BodyFrame, eye: EyeAim, targetY: number, wanted: number, rise: number, min = 0.03): number =>
  reachLean(lean => leanEye(frame, eye, lean), targetY, wanted, rise, min);

/**
 * Where she stands (her root on her floor) so that, facing back along the axis and leaning by `lean`, her chosen eye is at
 * `target` across and in depth; `rise` is what is left for her height (+ = she has to come up: her toes; − = bend a little).
 */
export const standFor = (frame: BodyFrame, eye: EyeAim, target: V3, lean: number, heading: number): { x: number; z: number; heading: number; rise: number } =>
  standUnder(leanEye(frame, eye, lean), target, heading);

/**
 * Which eye comes to the lens: the one nearer the lens centre as she stands (to the right of the axis, as you see her, her right
 * eye is nearer), or the other one when `other` (the host's template bag says so now and then).
 */
export function chooseEye(view: LensView, rootX: number, rootZ: number, other = false): EyeSide {
  const t = view.axis.z !== 0 ? (rootZ - view.camera.z) / view.axis.z : 0;
  const axisX = view.camera.x + view.axis.x * t;
  // Facing you, her right eye is on your left (−x): standing at +x of the axis, her right eye is the nearer one.
  const nearer: EyeSide = rootX >= axisX ? 'right' : 'left';
  return other ? (nearer === 'left' ? 'right' : 'left') : nearer;
}

/** A world vector in her frame (x her left, y up, z forward) for heading `h`. */
export function toHerFrame(v: V3, heading: number): V3 {
  const c = Math.cos(heading), s = Math.sin(heading);
  return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}
