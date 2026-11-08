/**
 * I-038 part A (3): the personal pose (个性化姿势: an arm's soft bend, the other arm, a head or torso tweak) on any model.
 *
 * A pose binding is written on Gene: bone index + Gene name + a local rotation (shared/personalize-body-bindings.ts,
 * electron/personalize-body-tweak.ts). On the reviewed Gene it is applied exactly as before. On another model each rotation goes
 * through the same retargeting a library motion gets (universal-target.ts `convertRotations`: renamed bones, A/T-pose arm
 * alignment, a missing shoulder folded into the arm) and lands on that model's own bone. What cannot land is skipped and named:
 * a bone the model lacks, and the torso's "current lean" (written for Gene's upper body under its groove; not carried yet).
 */
import type { Bone, Quaternion, SkinnedMesh } from 'three';
import type { BodyPoseProperty } from '../../shared/personalize-body';
import { PersonalizeStaticPose } from './personalize-static-pose';
import { universalTarget } from './universal-target';

export interface UniversalPose { properties: BodyPoseProperty[]; skipped: string[] }

/** The binding's properties as this model's (null target: nothing maps). Throws only on malformed input. */
export function universalPoseProperties(mesh: SkinnedMesh, properties: readonly BodyPoseProperty[], target: ReturnType<typeof universalTarget>): UniversalPose {
  if (!target) return { properties: [], skipped: properties.map(row => row.boneName) };
  if (target.reviewed) return { properties: properties.map(row => ({ ...row })), skipped: [] };
  const skipped: string[] = [], rows: { name: string; quaternion: [number, number, number, number] }[] = [], weights = new Map<string, number | undefined>();
  for (const row of properties) {
    if (row.currentTorsoDelta) { skipped.push(row.boneName); continue; }
    rows.push({ name: row.boneName, quaternion: [...row.quaternion] as [number, number, number, number] }); weights.set(row.boneName, row.weight);
  }
  const converted = target.convertRotations(rows);
  skipped.push(...converted.lost);
  const bones = mesh.skeleton.bones;
  const out: BodyPoseProperty[] = [];
  for (const row of converted.rows) {
    const at = bones.findIndex(bone => bone.name === row.name);
    if (at < 0 || bones.filter(bone => bone.name === row.name).length !== 1) { skipped.push(target.standardBone(row.name) ?? row.name); continue; }
    const source = target.standardBone(row.name), weight = source === null ? undefined : weights.get(source);
    out.push({ boneIndex: at, boneName: row.name, quaternion: row.quaternion, ...(weight === undefined ? {} : { weight }) });
  }
  return { properties: out, skipped };
}

/**
 * The overlay for a pose binding on this model: the reviewed Gene's as before, any other model through the universal target.
 * Throws (as PersonalizeStaticPose does for a bad binding) when nothing of the pose lands on this model.
 */
export function personalizePose(mesh: SkinnedMesh, properties: readonly BodyPoseProperty[], rest: readonly { bone: Bone; quaternion: Quaternion }[],
  reviewed: boolean, retarget: Parameters<typeof universalTarget>[0]): PersonalizeStaticPose {
  if (reviewed) return new PersonalizeStaticPose(mesh, properties, rest);
  const pose = universalPoseProperties(mesh, properties, universalTarget(retarget));
  if (!pose.properties.length) throw Error(`这个模型上找不到这个姿势要用的骨骼（${pose.skipped.join('、') || '无'}）。`);
  return new PersonalizeStaticPose(mesh, pose.properties, rest);
}
