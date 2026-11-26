/**
 * I-078 第 1 步: which sleep pose fits the user's camera (docs/mood/fatigue-sleep-and-furniture.md「相机感知睡姿」).
 *
 * The camera is never moved, turned or reframed here: it is only read. Each candidate pose (lying on a pillow with her head
 * to the camera's left or right, napping on the desk facing left or right, the seated doze) is placed by sleep-postures.ts;
 * this module slides it sideways along the camera's horizontal (her placement, not the camera) to keep her head well inside
 * the window, then scores it:
 *  - the head volume (head capsule + hair margin, a sphere) must project inside the window with a margin on every side (not
 *    just its center in the frustum), in front of the camera;
 *  - more of the body in frame is better; a long slide is worse;
 *  - her preference for the kind (character, closeness, variety) comes in from the caller.
 * Candidates whose head does not fit are dropped; none fits → the caller keeps the standing doze (head only, I-024).
 */
import { Vector3, type Camera, type PerspectiveCamera } from 'three';
import { placePose, placeWaypoint, type PlacedPose, type SleepKind, type SleepRig, type SleepSide } from './sleep-postures';
import { SLEEP_BODY_KNOBS } from '../../shared/behaviors/sleep-body/knobs';

export interface FrameView { camera: Camera; width: number; height: number }
export interface HeadFit {
  /** Smallest distance (NDC, 0..1 of the half window) from the head sphere's edge to a window edge; < 0: cut off. */
  margin: number;
  /** The sphere is in front of the camera. */
  front: boolean;
}

const point = new Vector3(), side = new Vector3();
/** How the head sphere sits in the window (perspective or orthographic camera). */
export function headFit(center: Vector3, radius: number, view: FrameView): HeadFit {
  const camera = view.camera as PerspectiveCamera;
  camera.updateMatrixWorld?.();
  point.copy(center).applyMatrix4(camera.matrixWorldInverse);
  const depth = -point.z;
  if (!(depth > 1e-3)) return { margin: -1, front: false };
  point.copy(center).project(camera);
  if (![point.x, point.y].every(Number.isFinite)) return { margin: -1, front: false };
  // The projected radius: project a point one radius to the side (camera space) and measure.
  side.copy(center).applyMatrix4(camera.matrixWorldInverse); side.x += radius; side.applyMatrix4(camera.matrixWorld).project(camera);
  const rx = Math.abs(side.x - point.x);
  const aspect = view.width > 0 && view.height > 0 ? view.width / view.height : 1;
  const ry = rx * aspect;
  const margin = Math.min(1 - (point.x + rx), (point.x - rx) + 1, 1 - (point.y + ry), (point.y - ry) + 1);
  return { margin, front: true };
}

/** Share (0..1) of the given body points inside the window. */
export function bodyInFrame(points: readonly Vector3[], view: FrameView): number {
  if (!points.length) return 0;
  let inside = 0;
  for (const p of points) {
    point.copy(p).project(view.camera);
    if (Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z >= -1 && point.z <= 1) inside++;
  }
  return inside / points.length;
}

/** The horizontal direction to the camera's right (world, y = 0) and the camera's yaw as seen from `from`. */
export function cameraFacing(camera: Camera, from: Vector3): { right: Vector3; yaw: number } {
  camera.updateMatrixWorld?.();
  const position = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const toCamera = position.sub(from).setY(0);
  const yaw = toCamera.lengthSq() > 1e-8 ? Math.atan2(toCamera.x, toCamera.z) : 0;
  return { right: new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), yaw };
}

export interface SleepCandidate {
  kind: SleepKind;
  side: SleepSide;
  /** The planned pose, slid sideways by `slide` (model units along the camera's right). */
  placed: PlacedPose;
  /** The seiza waypoint for the same facing (same slide). */
  waypoint: PlacedPose;
  slide: number;
  fit: HeadFit;
  body: number;
  /** fit and body combined with the caller's preference. */
  score: number;
  fits: boolean;
}

export interface ChooseInput {
  rig: SleepRig;
  view: FrameView;
  /** Her stance now (the center bone's rest position is used when absent). */
  from?: Vector3;
  /** Preference per kind (0..1+; the caller's character, closeness, variety). Missing kinds are not tried. */
  prefer: Partial<Record<SleepKind, number>>;
  /** Closeness 0..1 (hug variant share). */
  hug?: number;
}

/** Shift a placed pose by `by` (model units): the center offset, the head, the body points and the props move together. */
export function shiftPose(placed: PlacedPose, by: Vector3): PlacedPose {
  const move = (v: Vector3) => v.clone().add(by);
  return { ...placed, centerOffset: move(placed.centerOffset), head: { center: move(placed.head.center), radius: placed.head.radius }, body: placed.body.map(move),
    pillow: placed.pillow && { ...placed.pillow, center: move(placed.pillow.center) }, desk: placed.desk && { ...placed.desk, center: move(placed.desk.center) } };
}

/** Every candidate, placed, slid and scored (best first). Pure: the camera is only read. */
export function sleepCandidates(input: ChooseInput): SleepCandidate[] {
  const { rig, view } = input, knobs = SLEEP_BODY_KNOBS.framing;
  const from = input.from ?? rig.bones[rig.slot.center].rest;
  const { right, yaw } = cameraFacing(view.camera, from);
  const out: SleepCandidate[] = [];
  const kinds: [SleepKind, SleepSide][] = [['lie', -1], ['lie', 1], ['desk', -1], ['desk', 1], ['sit', 1]];
  for (const [kind, sideOf] of kinds) {
    const prefer = input.prefer[kind];
    if (!(prefer !== undefined && prefer > 0)) continue;
    const { base, waypoint } = placed(rig, kind, sideOf, yaw, input.hug ?? 0);
    // Slide along the camera's right: the best of a few positions within ± maxSlide heights (none for the seated doze).
    const max = kind === 'sit' ? 0 : knobs.maxSlide * rig.height, steps = kind === 'sit' ? 0 : 8;
    let best: { slide: number; placed: PlacedPose; fit: HeadFit; body: number; value: number } | null = null;
    for (let k = -steps; k <= steps; k++) {
      const slide = steps ? max * k / steps : 0, placed = shiftPose(base, right.clone().multiplyScalar(slide));
      const fit = headFit(placed.head.center, placed.head.radius, view), body = bodyInFrame(placed.body, view);
      // A slide where the head fits always beats one where it does not; among those that fit, margin, body and a short slide.
      const ok = fit.front && fit.margin >= knobs.headMargin;
      const value = (ok ? 0 : -10 + fit.margin) + Math.min(fit.margin, knobs.marginEnough) * 2 + body * knobs.bodyWeight - Math.abs(slide) / rig.height * knobs.slideCost;
      if (!best || value > best.value) best = { slide, placed, fit, body, value };
    }
    const fits = !!best && best.fit.front && best.fit.margin >= knobs.headMargin;
    const shifted = shiftPose(waypoint, right.clone().multiplyScalar(best!.slide));
    out.push({ kind, side: sideOf, placed: best!.placed, waypoint: shifted, slide: best!.slide, fit: best!.fit, body: best!.body,
      score: best!.value + prefer, fits });
  }
  return out.sort((a, b) => Number(b.fits) - Number(a.fits) || b.score - a.score);
}

/**
 * Placing a pose (the desk's lean solve especially) costs a few milliseconds; the camera only changes the yaw, so placements are
 * kept per rig by kind, side, yaw (whole degrees) and hug (0.05 steps). A camera drag then costs only the slides.
 */
const placements = new WeakMap<SleepRig, Map<string, { base: PlacedPose; waypoint: PlacedPose }>>();
function placed(rig: SleepRig, kind: SleepKind, sideOf: SleepSide, yaw: number, hug: number): { base: PlacedPose; waypoint: PlacedPose } {
  const degrees = Math.round(yaw * 180 / Math.PI), share = Math.round(hug * 20) / 20, key = `${kind}:${sideOf}:${degrees}:${share}`;
  let cache = placements.get(rig);
  if (!cache) placements.set(rig, cache = new Map());
  let hit = cache.get(key);
  if (!hit) {
    const cameraYaw = degrees * Math.PI / 180;
    hit = { base: placePose(rig, { kind, side: sideOf, cameraYaw, hug: share }), waypoint: placeWaypoint(rig, { kind, side: sideOf, cameraYaw }) };
    if (cache.size > 64) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}

/** A key for "the same choice" (hysteresis compares choices by it). */
export const candidateKey = (c: { kind: SleepKind; side: SleepSide } | null | undefined) => c ? `${c.kind}:${c.side}` : 'stand';
