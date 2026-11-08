import { Bone, Matrix3, PerspectiveCamera, Vector3 } from 'three';
import type { BlushAnchors, BlushPoint } from './procedural-blush';
import type { CheekExclusion, CheekRegion, CheekSide } from '../ui/CheekPinch';

/**
 * Cheek hit ellipse for the reviewed Gene face (R05), in units of the model's own
 * eye distance E, measured in its eye-mouth face frame. It is model-relative, so
 * camera distance, window size and head scale change only the projection.
 *
 * The center starts at the blush cheek anchor (0.60 E out from the eye midline,
 * 56% of the way from the eye line to the mouth) and moves outward and down. The
 * long axis tilts with the jaw, so the area reaches from under the eye out to the
 * face edge and down toward the jaw instead of sitting beside the nose. The eye,
 * nose and mouth guards below still remove those features, whatever this covers.
 *
 * Measured on the bundled Gene (front view, CPU geometry): the previous ellipse
 * (0.15 / 0.10 / 0.38 x 0.23, no tilt) covered 77% of the cheek skin a pointer
 * can reach outside the guards; this one covers about 98%, with 1.4x the hit area
 * and about the same share (~20%) falling just outside the jaw silhouette.
 */
export const CHEEK_HIT_RANGE = Object.freeze({
  /** Center shift away from the face midline. */
  outward: 0.12,
  /** Center shift toward the jaw. */
  down: 0.13,
  /** Half-length of the long axis (along the eye line before tilting). */
  halfWidth: 0.50,
  /** Half-length of the short axis. */
  halfHeight: 0.28,
  /** Radians the long axis turns so its outer end rises, following the jaw line. */
  tilt: 0.6,
});
/** Unreviewed models keep the original conservative, unguarded ellipse. */
const LEGACY_CHEEK_HALF = Object.freeze({ width: 0.28, height: 0.22 });

const finiteVector = (value: Vector3): boolean => [value.x, value.y, value.z].every(Number.isFinite);
const validTuple = (value: BlushPoint): boolean => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const vector = (value: BlushPoint): Vector3 => new Vector3().fromArray(value);
const validMatrix = (matrix: { elements: number[] }): boolean => matrix.elements.every(Number.isFinite);

type ScreenPoint = { x: number; y: number };
function convexHull(points: ScreenPoint[]): ScreenPoint[] {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (values: ScreenPoint[]) => {
    const result: ScreenPoint[] = [];
    for (const point of values) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted), upper = half(sorted.slice().reverse());
  lower.pop(); upper.pop(); return lower.concat(upper);
}

/** Pinned Gene/default-anchor calibration only; no model vertices are visited per frame. */
function projectGeneExclusions(anchors: BlushAnchors, head: Bone, camera: PerspectiveCamera, width: number, height: number): CheekExclusion[] | null {
  if (![anchors.leftEye, anchors.rightEye, anchors.mouth].every(validTuple)) return null;
  const origin = vector(anchors.leftEye).add(vector(anchors.rightEye)).multiplyScalar(0.5);
  const right = vector(anchors.right).normalize(), up = vector(anchors.up).normalize(), forward = vector(anchors.forward).normalize();
  if (Math.abs(right.dot(up)) > 1e-3 || Math.abs(right.dot(forward)) > 1e-3 || Math.abs(up.dot(forward)) > 1e-3) return null;
  const mouthY = vector(anchors.mouth).sub(origin).dot(up) / anchors.eyeDistance;
  if (!Number.isFinite(mouthY) || mouthY < -2 || mouthY > -0.3) return null;
  const boxes = [
    { x: [-0.84, -0.16], y: [-0.36, 0.36], z: [-0.18, 0.18] },
    { x: [0.16, 0.84], y: [-0.36, 0.36], z: [-0.18, 0.18] },
    { x: [-0.27, 0.27], y: [mouthY + 0.18, 0.25], z: [-0.06, 0.51] },
    // Actual primary-six mouth support, including the conservative independent
    // [0,1] mixture envelope; broad mouth morph membership is not lip anatomy.
    { x: [-0.54, 0.54], y: [-2.02, -0.04], z: [-0.64, 0.51] },
  ];
  const exclusions: CheekExclusion[] = [];
  for (const box of boxes) {
    const points: ScreenPoint[] = [];
    for (const x of box.x) for (const y of box.y) for (const z of box.z) {
      const world = origin.clone().addScaledVector(right, x * anchors.eyeDistance).addScaledVector(up, y * anchors.eyeDistance)
        .addScaledVector(forward, z * anchors.eyeDistance).applyMatrix4(head.matrixWorld);
      const view = world.clone().applyMatrix4(camera.matrixWorldInverse), point = world.project(camera);
      if (!finiteVector(view) || !finiteVector(point) || view.z >= 0 || point.z < -1 || point.z > 1) return null;
      points.push({ x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 });
    }
    const hull = convexHull(points);
    if (hull.length < 3 || hull.length > 8) return null;
    exclusions.push({ points: hull, padding: 1 });
  }
  return exclusions;
}

/**
 * Read-only face hit projection, independent of whether a blush shader compiled.
 * The anchors were sampled in the model's rest pose; only their head transform
 * changes here. This never writes a bone pose, camera setting or calibration.
 */
export function projectCheekRegions(
  anchors: BlushAnchors | null,
  head: Bone,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  referenceWidth: number,
  reviewedGene = false,
): CheekRegion[] {
  if (!anchors || !head || !camera || ![width, height, referenceWidth, anchors.eyeDistance].every(Number.isFinite)
    || width <= 0 || height <= 0 || referenceWidth < 8 || anchors.eyeDistance <= 1e-5
    || ![anchors.leftCheek, anchors.rightCheek, anchors.leftNormal, anchors.rightNormal,
      anchors.right, anchors.up, anchors.forward].every(validTuple)) return [];
  if (![camera.fov, camera.aspect, camera.near, camera.far, camera.zoom].every(Number.isFinite)
    || camera.fov <= 0 || camera.fov >= 180 || camera.aspect <= 0 || camera.near <= 0
    || camera.far <= camera.near || camera.zoom <= 0) return [];
  head.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);
  camera.updateProjectionMatrix();
  const determinant = head.matrixWorld.determinant();
  if (!validMatrix(head.matrixWorld) || !validMatrix(camera.matrixWorld) || !validMatrix(camera.matrixWorldInverse)
    || !validMatrix(camera.projectionMatrix) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return [];
  const right = vector(anchors.right), up = vector(anchors.up), forward = vector(anchors.forward);
  if ([right, up, forward].some(value => value.lengthSq() < 1e-12)) return [];
  right.normalize(); up.normalize();
  if (right.clone().cross(up).lengthSq() < 1e-6) return [];
  const cameraPosition = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const normalMatrix = new Matrix3().getNormalMatrix(head.matrixWorld);
  if (!validMatrix(normalMatrix)) return [];
  const exclusions = reviewedGene ? projectGeneExclusions(anchors, head, camera, width, height) : undefined;
  if (reviewedGene && !exclusions) return [];

  const project = (world: Vector3): { x: number; y: number } | null => {
    const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
    // Projection alone would mirror points behind the camera onto the canvas.
    if (!finiteVector(view) || view.z >= 0) return null;
    const point = world.clone().project(camera);
    if (!finiteVector(point) || point.z < -1 || point.z > 1
      || point.x < -1 || point.x > 1 || point.y < -1 || point.y > 1) return null;
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
  };
  /** Same depth guards, but an axis end may lie past the canvas edge. */
  const projectAxis = (world: Vector3): { x: number; y: number } | null => {
    const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
    if (!finiteVector(view) || view.z >= 0) return null;
    const point = world.clone().project(camera);
    if (!finiteVector(point) || point.z < -1 || point.z > 1) return null;
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
  };
  const result: CheekRegion[] = [];
  for (const side of ['left', 'right'] as const) {
    const local = vector(side === 'left' ? anchors.leftCheek : anchors.rightCheek);
    const normal = vector(side === 'left' ? anchors.leftNormal : anchors.rightNormal);
    if (normal.lengthSq() < 1e-12) continue;
    if (reviewedGene) {
      normal.normalize();
      const normalForward = normal.dot(forward.clone().normalize());
      if (normalForward < 0.35) continue;
      // Follow the cheek's sideways curvature back toward the surface as it moves out.
      const tangentDrop = Math.abs(normal.dot(right) / normalForward) * CHEEK_HIT_RANGE.outward;
      local.addScaledVector(right, (side === 'left' ? -1 : 1) * anchors.eyeDistance * CHEEK_HIT_RANGE.outward)
        .addScaledVector(up, -anchors.eyeDistance * CHEEK_HIT_RANGE.down)
        .addScaledVector(forward.clone().normalize(), -anchors.eyeDistance * tangentDrop);
    }
    normal.applyNormalMatrix(normalMatrix);
    const world = local.clone().applyMatrix4(head.matrixWorld);
    const towardCamera = cameraPosition.clone().sub(world);
    if (!finiteVector(world) || !finiteVector(normal) || towardCamera.lengthSq() < 1e-12
      || normal.dot(towardCamera.normalize()) < 0.25) continue;
    const half = reviewedGene ? { width: CHEEK_HIT_RANGE.halfWidth, height: CHEEK_HIT_RANGE.halfHeight } : LEGACY_CHEEK_HALF;
    // Reviewed cheeks follow the jaw: the outer end of the long axis rises (mirrored per side).
    const tilt = reviewedGene ? (side === 'left' ? -1 : 1) * CHEEK_HIT_RANGE.tilt : 0;
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    const horizontal = right.clone().multiplyScalar(cos).addScaledVector(up, sin).multiplyScalar(anchors.eyeDistance * half.width);
    const vertical = up.clone().multiplyScalar(cos).addScaledVector(right, -sin).multiplyScalar(anchors.eyeDistance * half.height);
    // The cheek center must be on the canvas. Its ellipse may run past an edge
    // when the face is framed close: the pointer can only reach the visible part.
    const center = project(world);
    const xEnd = projectAxis(local.clone().add(horizontal).applyMatrix4(head.matrixWorld));
    const yEnd = projectAxis(local.clone().add(vertical).applyMatrix4(head.matrixWorld));
    const xBack = projectAxis(local.clone().sub(horizontal).applyMatrix4(head.matrixWorld));
    const yBack = projectAxis(local.clone().sub(vertical).applyMatrix4(head.matrixWorld));
    if (!center || !xEnd || !yEnd || !xBack || !yBack) continue;
    const axisXX = xEnd.x - center.x, axisXY = xEnd.y - center.y;
    const axisYX = yEnd.x - center.x, axisYY = yEnd.y - center.y;
    const det = axisXX * axisYY - axisYX * axisXY;
    const a = axisXX * axisXX + axisYX * axisYX;
    const b = axisXX * axisXY + axisYX * axisYY;
    const c = axisXY * axisXY + axisYY * axisYY;
    const largest = (a + c + Math.hypot(a - c, 2 * b)) / 2;
    const smallest = largest > 0 ? det * det / largest : 0;
    if (![axisXX, axisXY, axisYX, axisYY, smallest].every(Number.isFinite) || smallest < 9) continue;
    result.push({ side: side as CheekSide, ...center, axisXX, axisXY, axisYX, axisYY, referenceWidth,
      ...(exclusions ? { exclusions } : {}) });
  }
  return result;
}
