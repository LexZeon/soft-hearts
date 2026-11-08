import { Bone, Matrix3, PerspectiveCamera, Vector3 } from 'three';
import type { BlushAnchors, BlushPoint } from '../../src/stage/procedural-blush';
import type { CheekRegion, CheekSide } from '../../src/ui/CheekPinch';

const finiteVector = (value: Vector3): boolean => [value.x, value.y, value.z].every(Number.isFinite);
const validTuple = (value: BlushPoint): boolean => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const vector = (value: BlushPoint): Vector3 => new Vector3().fromArray(value);
const validMatrix = (matrix: { elements: number[] }): boolean => matrix.elements.every(Number.isFinite);

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

  const project = (world: Vector3): { x: number; y: number } | null => {
    const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
    // Projection alone would mirror points behind the camera onto the canvas.
    if (!finiteVector(view) || view.z >= 0) return null;
    const point = world.clone().project(camera);
    if (!finiteVector(point) || point.z < -1 || point.z > 1
      || point.x < -1 || point.x > 1 || point.y < -1 || point.y > 1) return null;
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
  };
  const result: CheekRegion[] = [];
  for (const side of ['left', 'right'] as const) {
    const local = vector(side === 'left' ? anchors.leftCheek : anchors.rightCheek);
    const normal = vector(side === 'left' ? anchors.leftNormal : anchors.rightNormal);
    if (normal.lengthSq() < 1e-12) continue;
    normal.applyNormalMatrix(normalMatrix);
    const world = local.clone().applyMatrix4(head.matrixWorld);
    const towardCamera = cameraPosition.clone().sub(world);
    if (!finiteVector(world) || !finiteVector(normal) || towardCamera.lengthSq() < 1e-12
      || normal.dot(towardCamera.normalize()) < 0.25) continue;
    const horizontal = right.clone().multiplyScalar(anchors.eyeDistance * 0.28);
    const vertical = up.clone().multiplyScalar(anchors.eyeDistance * 0.22);
    const center = project(world);
    const xEnd = project(local.clone().add(horizontal).applyMatrix4(head.matrixWorld));
    const yEnd = project(local.clone().add(vertical).applyMatrix4(head.matrixWorld));
    const xBack = project(local.clone().sub(horizontal).applyMatrix4(head.matrixWorld));
    const yBack = project(local.clone().sub(vertical).applyMatrix4(head.matrixWorld));
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
    const radiusX = Math.sqrt(a), radiusY = Math.sqrt(c);
    if (center.x - radiusX < 0 || center.x + radiusX > width
      || center.y - radiusY < 0 || center.y + radiusY > height) continue;
    result.push({ side: side as CheekSide, ...center, axisXX, axisXY, axisYX, axisYY, referenceWidth });
  }
  return result;
}
