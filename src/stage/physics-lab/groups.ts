/**
 * 物理调参台 (physics lab): the physics groups of a model, read from the same rig plan the companion uses (src/stage/physics-rig.ts).
 * Each connected set of simulated bodies is one group: every hair chain or sheet separately (a long braid is its own group), each
 * chest side, and the other simulated parts (skirts, capes, sleeves…) listed but never run here. A group's id is
 * `<part>:<lowest source body index>`: stable for the same model bytes (overrides are keyed by the model's content hash), and it
 * carries no bone name. Pure: no Ammo, no DOM.
 */
import { Vector3, type SkinnedMesh } from "three";
import type { PhysicsPartRig, PhysicsRigPlan } from "../physics-rig";
import type { PhysicsPart } from "../../../shared/stage/model-physics";

export interface PhysicsGroupInfo {
  /** `hair:12`, `chest:193`: stable for one model's bytes, no names. */
  readonly id: string;
  readonly part: PhysicsPart;
  /** Source (PMX) indices of the group's simulated bodies. */
  readonly sourceBodies: readonly number[];
  /** Weighted output bones written by this group, root first. */
  readonly outputBones: readonly number[];
  /** Bone index used for display (the group's root output bone), or -1. */
  readonly rootBone: number;
  /** Rest-pose vertical extent of the output bones (model units): a long braid stands out. */
  readonly length: number;
}

export interface OtherPhysicsGroup {
  readonly sourceBodies: readonly number[];
  readonly rootBone: number;
}

/** Connected components of the dynamic bodies in one part's rig, as rig (not source) indices, ordered by their lowest source index. */
export function rigComponents(rig: PhysicsPartRig): number[][] {
  const dynamic = rig.rigidBodies.map((body, index) => body.type !== 0 ? index : -1).filter(index => index >= 0);
  const links = new Map<number, number[]>(dynamic.map(index => [index, []]));
  for (const joint of rig.constraints) {
    if (links.has(joint.rigidBodyIndex1) && links.has(joint.rigidBodyIndex2)) {
      links.get(joint.rigidBodyIndex1)!.push(joint.rigidBodyIndex2);
      links.get(joint.rigidBodyIndex2)!.push(joint.rigidBodyIndex1);
    }
  }
  const seen = new Set<number>(), result: number[][] = [];
  for (const start of dynamic) {
    if (seen.has(start)) continue;
    const group: number[] = [], queue = [start];
    seen.add(start);
    while (queue.length) {
      const index = queue.pop()!;
      group.push(index);
      for (const next of links.get(index) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    result.push(group.sort((a, b) => a - b));
  }
  return result.sort((a, b) => rig.sourceBodyIndices[a[0]] - rig.sourceBodyIndices[b[0]]);
}

/** The group id of a component (rig indices): the part and the lowest PMX body index. */
export function groupId(part: PhysicsPart, rig: PhysicsPartRig, component: readonly number[]): string {
  return `${part}:${Math.min(...component.map(index => rig.sourceBodyIndices[index]))}`;
}

function depth(mesh: SkinnedMesh, bone: number): number {
  let count = 0, node = mesh.skeleton.bones[bone]?.parent;
  while (node && count < 512) { count++; node = node.parent; }
  return count;
}

/** The groups of both parts; a body belongs to exactly one group. */
export function physicsGroups(mesh: SkinnedMesh, plan: PhysicsRigPlan): PhysicsGroupInfo[] {
  const groups: PhysicsGroupInfo[] = [];
  const bodies = (mesh.geometry.userData as { MMD?: { rigidBodies?: { boneIndex?: unknown }[] } }).MMD?.rigidBodies ?? [];
  const position = new Vector3();
  mesh.updateMatrixWorld(true);
  for (const part of ["hair", "chest"] as const) {
    const rig = plan[part];
    if (!rig.support.supported) continue;
    const outputs = new Set(rig.outputBoneIndices);
    for (const component of rigComponents(rig)) {
      const sourceBodies = component.map(index => rig.sourceBodyIndices[index]).sort((a, b) => a - b);
      const bones = [...new Set(sourceBodies.map(index => bodies[index]?.boneIndex)
        .filter((bone): bone is number => typeof bone === "number" && outputs.has(bone)))]
        .sort((a, b) => depth(mesh, a) - depth(mesh, b) || a - b);
      const ys = bones.map(bone => mesh.skeleton.bones[bone].getWorldPosition(position).y);
      groups.push({ id: `${part}:${sourceBodies[0]}`, part, sourceBodies, outputBones: bones, rootBone: bones[0] ?? -1,
        length: ys.length ? Math.max(...ys) - Math.min(...ys) : 0 });
    }
  }
  return groups;
}

/** Simulated parts outside hair and chest (skirts, capes, sleeves…): shown in the lab's list, never run there. */
export function otherPhysicsGroups(mesh: SkinnedMesh, plan: PhysicsRigPlan): OtherPhysicsGroup[] {
  const meta = (mesh.geometry.userData as { MMD?: { rigidBodies?: unknown[]; constraints?: unknown[] } }).MMD;
  const bodies = Array.isArray(meta?.rigidBodies) ? meta.rigidBodies as { boneIndex?: number; type?: number }[] : [];
  const joints = Array.isArray(meta?.constraints) ? meta.constraints as { rigidBodyIndex1?: number; rigidBodyIndex2?: number }[] : [];
  const used = new Set([...plan.hair.sourceBodyIndices, ...plan.chest.sourceBodyIndices]);
  const free = new Set(bodies.map((body, index) => body?.type !== 0 && !used.has(index) ? index : -1).filter(index => index >= 0));
  const links = new Map<number, number[]>([...free].map(index => [index, []]));
  for (const joint of joints) {
    const a = joint?.rigidBodyIndex1, b = joint?.rigidBodyIndex2;
    if (typeof a === "number" && typeof b === "number" && free.has(a) && free.has(b)) { links.get(a)!.push(b); links.get(b)!.push(a); }
  }
  const seen = new Set<number>(), result: OtherPhysicsGroup[] = [];
  for (const start of [...free].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const group: number[] = [], queue = [start];
    seen.add(start);
    while (queue.length) {
      const index = queue.pop()!;
      group.push(index);
      for (const next of links.get(index) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    group.sort((a, b) => a - b);
    const bone = group.map(index => bodies[index]?.boneIndex).find((value): value is number => typeof value === "number" && value >= 0) ?? -1;
    result.push({ sourceBodies: group, rootBone: bone });
  }
  return result;
}
