/**
 * R01 物理调参台: a lab tuning (shared/stage/physics-tuning.ts) applied to one part's rig plan, before its Ammo world is built.
 * Pure: a copy of the plan with the multipliers applied, plus what the runtime needs per bone. Without a tuning (or a neutral one)
 * the rig comes back unchanged, so the companion runs exactly as before the lab.
 * - A group switched off, or switched to the spring solver, stays in the world as kinematic bodies that follow her animation
 *   (they still collide), and its bones get no Ammo output.
 * - Ammo multipliers: damping (clamped to Bullet's 0..1), joint springs, joint angle limits (and the bone's display clamp), mass;
 *   gravity per body after the world is built (LocalModelPhysics reads `gravity`).
 */
import {
  DEFAULT_SUBSTEP_HZ, defaultGroupTuning, isNeutralTuning,
  type ModelPhysicsTuning, type PhysicsGroupTuning,
} from "../../shared/stage/physics-tuning";
import type { PhysicsPart } from "../../shared/stage/model-physics";
import type { PhysicsConstraint, PhysicsPartRig, PhysicsRigidBody } from "./physics-rig";
import { groupId, rigComponents } from "./physics-lab/groups";

type Triple = [number, number, number];

export interface TunedPart {
  readonly rig: PhysicsPartRig;
  /** Gravity factor per rig body (1: the world's). */
  readonly gravity: readonly number[];
  /** Output bone → its group id. */
  readonly boneGroup: ReadonlyMap<number, string>;
  /** Every group of this part with its (default when untuned) settings. */
  readonly groups: ReadonlyMap<string, PhysicsGroupTuning>;
  /** Output bones of each group (for the spring solver and the per-group strength). */
  readonly groupBones: ReadonlyMap<string, readonly number[]>;
  /** Some group still runs on Ammo: the world is needed. */
  readonly ammoNeeded: boolean;
  readonly unitStep: number;
  readonly neutral: boolean;
}

const scale3 = (value: Triple, factor: number): Triple => [value[0] * factor, value[1] * factor, value[2] * factor];
const clampAngle3 = (value: Triple): Triple => value.map(v => Math.max(-Math.PI, Math.min(Math.PI, v))) as Triple;

export function tunePart(rig: PhysicsPartRig, part: PhysicsPart, tuning: ModelPhysicsTuning | null | undefined): TunedPart {
  const components = rig.support.supported ? rigComponents(rig) : [];
  const groups = new Map<string, PhysicsGroupTuning>(), groupBones = new Map<string, number[]>(), boneGroup = new Map<number, string>();
  const bodyGroup = new Map<number, string>();
  const outputs = new Set(rig.outputBoneIndices);
  for (const component of components) {
    const id = groupId(part, rig, component);
    groups.set(id, tuning?.groups[id] ?? defaultGroupTuning(part));
    const bones: number[] = [];
    for (const index of component) {
      bodyGroup.set(index, id);
      const bone = rig.rigidBodies[index].boneIndex;
      if (outputs.has(bone) && !boneGroup.has(bone)) { boneGroup.set(bone, id); bones.push(bone); }
    }
    groupBones.set(id, bones);
  }
  const neutral = isNeutralTuning(tuning);
  const unitStep = 1 / (tuning?.substepHz ?? DEFAULT_SUBSTEP_HZ);
  if (neutral) {
    return { rig, gravity: rig.rigidBodies.map(() => 1), boneGroup, groups, groupBones, ammoNeeded: components.length > 0, unitStep, neutral };
  }
  const settingsOf = (index: number) => { const id = bodyGroup.get(index); return id ? groups.get(id)! : null; };
  const live = (group: PhysicsGroupTuning | null) => !!group && group.enabled && group.engine === "ammo";
  const rigidBodies: PhysicsRigidBody[] = rig.rigidBodies.map((body, index) => {
    const group = settingsOf(index);
    if (!group) return { ...body };
    if (!live(group)) return { ...body, type: 0, weight: 0 };
    return { ...body, weight: body.weight * group.ammo.mass,
      positionDamping: Math.min(1, body.positionDamping * group.ammo.damping), rotationDamping: Math.min(1, body.rotationDamping * group.ammo.damping) };
  });
  const constraints: PhysicsConstraint[] = rig.constraints.map(joint => {
    const group = settingsOf(joint.rigidBodyIndex1) ?? settingsOf(joint.rigidBodyIndex2);
    if (!live(group)) return { ...joint };
    const { ammo } = group!;
    return { ...joint, springPosition: scale3(joint.springPosition, ammo.spring), springRotation: scale3(joint.springRotation, ammo.spring),
      rotationLimitation1: clampAngle3(scale3(joint.rotationLimitation1, ammo.angleLimit)),
      rotationLimitation2: clampAngle3(scale3(joint.rotationLimitation2, ammo.angleLimit)) };
  });
  const gravity = rig.rigidBodies.map((_, index) => { const group = settingsOf(index); return live(group) ? group!.ammo.gravity : 1; });
  const ammoNeeded = [...groups.values()].some(group => live(group));
  return { rig: { ...rig, rigidBodies, constraints }, gravity, boneGroup, groups, groupBones, ammoNeeded, unitStep, neutral };
}
