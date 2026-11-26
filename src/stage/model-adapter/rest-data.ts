// Format-neutral rest readings of a loaded model (I-152 step 0): bounds, the rest hierarchy for retargeting, morph names, whether
// the arms rest level (T) or lowered (A). Three core only (no loaders), so it runs in the node tests.
import { Box3, Matrix4, Vector3, type Bone, type Object3D } from 'three';
import type { RigBone } from '../../../shared/actions';
import type { ModelBounds, ModelRest } from './types';

/** Rest-pose extent of `object` in stage space, exactly as the stage measured it before the adapter (Box3.setFromObject). */
export function measureObjectBounds(object: Object3D): ModelBounds {
  const bounds = new Box3().setFromObject(object);
  return {
    height: Math.max(1, bounds.max.y - bounds.min.y),
    width: Math.max(1, bounds.max.x - bounds.min.x),
    centerX: (bounds.min.x + bounds.max.x) / 2,
    baseY: bounds.min.y,
  };
}

/**
 * Rest hierarchy in `root`'s local space ("model space"): name, parent index (-1: none in the list) and position, for every bone
 * in `bones` in that order. The same reading as src/actions/motion-retarget.ts meshRigBones for an MMD mesh (root = the mesh);
 * tests/model-adapter.test.ts keeps the two equal.
 */
export function restRigBones(root: Object3D, bones: readonly Bone[]): RigBone[] {
  const order = new Map<object, number>(bones.map((bone, index) => [bone, index]));
  root.updateMatrixWorld(true);
  const toModel = new Matrix4().copy(root.matrixWorld).invert();
  return bones.map(bone => {
    const point = bone.getWorldPosition(new Vector3()).applyMatrix4(toModel);
    return { name: bone.name, parent: bone.parent ? order.get(bone.parent) ?? -1 : -1, position: [point.x, point.y, point.z] };
  });
}

/** Morph names by index from a morph dictionary (holes become ''). */
export function morphNamesOf(dictionary: Readonly<Record<string, number>> | undefined): string[] {
  const names: string[] = [];
  for (const [name, index] of Object.entries(dictionary ?? {})) if (Number.isInteger(index) && index >= 0 && index < 65_536) names[index] = name;
  return Array.from(names, name => name ?? '');
}

/**
 * Whether the upper arms rest about level (T: within 15° of horizontal) or clearly lowered (A: 15°–80°), from the world positions
 * of the upper arm and its child (elbow). 'unknown' without both arms' pair or when the two sides disagree.
 */
export function restArmPose(arms: readonly { upper: Bone | undefined; lower: Bone | undefined }[]): ModelRest['pose'] {
  const kinds = new Set<ModelRest['pose']>();
  for (const { upper, lower } of arms) {
    if (!upper || !lower) return 'unknown';
    upper.updateWorldMatrix(true, false); lower.updateWorldMatrix(true, false);
    const direction = lower.getWorldPosition(new Vector3()).sub(upper.getWorldPosition(new Vector3()));
    const length = direction.length();
    if (!(length > 1e-6)) return 'unknown';
    const below = Math.asin(Math.max(-1, Math.min(1, -direction.y / length))) * 180 / Math.PI;
    kinds.add(Math.abs(below) <= 15 ? 'T' : below > 15 && below <= 80 ? 'A' : 'unknown');
  }
  return kinds.size === 1 ? [...kinds][0] : 'unknown';
}
