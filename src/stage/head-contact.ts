import { Bone, Camera, SkinnedMesh, Vector3 } from 'three';

/** A scalp-only ellipse in head-local coordinates; speed and feeding are separate. */
export interface HeadContactProfile {
  center: Vector3;
  right: Vector3;
  up: Vector3;
  halfWidth: number;
  halfHeight: number;
  /** `profile-eyes`: no eye bone pair, eye centers measured by the model profile (an eye-closing morph). */
  source: 'eyes-and-scalp' | 'profile-eyes' | 'head-estimate';
}
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Share of the eye-line-to-crown height below the pat region (forehead and brows). */
export const CROWN_START = 0.4;
const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

export function probeHeadContact(mesh: SkinnedMesh, head: Bone, eyes: readonly Bone[], height: number, profileEyes: readonly Vector3[] = []): HeadContactProfile {
  mesh.updateWorldMatrix(true, true); mesh.skeleton?.update();
  // Eye bones stay authoritative; measured head-local eye centers only stand in for a missing pair.
  const fromBones = eyes.length >= 2;
  const eyePoints = fromBones ? eyes.slice(0, 2).map(eye => head.worldToLocal(eye.getWorldPosition(new Vector3()))) : profileEyes.slice(0, 2).map(point => point.clone());
  if (eyePoints.length === 2 && eyePoints[0].distanceTo(eyePoints[1]) > height * 0.008) {
    const spacing = eyePoints[0].distanceTo(eyePoints[1]);
    const eyeCenter = eyePoints[0].clone().add(eyePoints[1]).multiplyScalar(0.5);
    const right = eyePoints[1].clone().sub(eyePoints[0]).normalize();
    if (right.x < 0) right.negate();
    const up = new Vector3(0, 1, 0).addScaledVector(right, -right.y).normalize();
    const forward = right.clone().cross(up).normalize();
    const yValues: number[] = [], xValues: number[] = [];
    const attribute = mesh.geometry.getAttribute('position');
    const point = new Vector3();
    for (let index = 0; index < (attribute?.count ?? 0); index++) {
      mesh.getVertexPosition(index, point); mesh.localToWorld(point); head.worldToLocal(point); point.sub(eyeCenter);
      const x = point.dot(right), y = point.dot(up), z = point.dot(forward);
      if ([x, y, z].every(Number.isFinite) && Math.abs(x) <= spacing * 3 && y >= spacing * 0.12 && y <= Math.min(spacing * 6, height * 0.22) && Math.abs(z) <= spacing * 4) {
        yValues.push(y); xValues.push(Math.abs(x));
      }
    }
    const top = yValues.length >= 12 ? clamp(percentile(yValues, 0.98) + spacing * 0.12, spacing * 0.8, Math.min(spacing * 6, height * 0.22)) : spacing * 2.5;
    // B05: a pat lands on the crown, not the brows. The ellipse starts around
    // the hairline (the upper ~60% of eye line .. crown) instead of just above
    // the eyes, which also moves its center up toward where people stroke.
    const bottom = clamp(top * CROWN_START, spacing * 0.5, top - spacing * 0.6);
    const halfWidth = xValues.length >= 12 ? clamp(percentile(xValues, 0.96), spacing * 0.65, spacing * 2.5) : spacing * 0.85;
    return { center: eyeCenter.addScaledVector(up, (bottom + top) / 2), right, up,
      halfWidth, halfHeight: (top - bottom) / 2, source: fromBones ? 'eyes-and-scalp' : 'profile-eyes' };
  }
  // A bounded upper-head estimate is explicit; never reuse the face-centered circle.
  return { center: new Vector3(0, height * 0.105, height * 0.02), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0),
    halfWidth: height * 0.055, halfHeight: height * 0.04, source: 'head-estimate' };
}

export function projectHeadContact(profile: HeadContactProfile, head: Bone, camera: Camera, width: number, height: number) {
  const project = (local: Vector3) => {
    const point = head.localToWorld(local).project(camera);
    return { x: (point.x * 0.5 + 0.5) * width, y: (-point.y * 0.5 + 0.5) * height, z: point.z };
  };
  head.updateWorldMatrix(true, false); camera.updateWorldMatrix(true, false);
  const center = project(profile.center.clone());
  const right = project(profile.center.clone().addScaledVector(profile.right, profile.halfWidth));
  const down = project(profile.center.clone().addScaledVector(profile.up, -profile.halfHeight));
  const result = { x: center.x, y: center.y, axisXX: right.x - center.x, axisXY: right.y - center.y, axisYX: down.x - center.x, axisYY: down.y - center.y };
  const determinant = result.axisXX * result.axisYY - result.axisXY * result.axisYX;
  return Object.values(result).every(Number.isFinite) && center.z >= -1 && center.z <= 1 && Math.abs(determinant) >= 4 ? result : null;
}
