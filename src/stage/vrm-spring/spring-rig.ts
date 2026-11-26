/**
 * I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): a VRM's spring bones made ready to simulate, from the loaded model's own
 * description (src/stage/model-adapter/vrm.ts: chains, colliders, groups). The file's bytes are never changed; nothing here moves a bone.
 *
 *  - A chain is split where the next joint is not the previous one's child; chains are ordered parents first, so a branch hanging from
 *    another chain reads its parent's solved pose.
 *  - VRM 1.0: the last joint of a chain is only the tail of the one before it. VRM 0.x (`leafTail`): it swings too, with a virtual tail
 *    7 cm along its own bone (UniVRM's rule).
 *  - Joints on a humanoid bone the pose transfer drives are left out (they would fight her body).
 *  - Body colliders (the brief's step 2): a chain hanging below her hips with no colliders of its own on her legs (One's coat and skirt
 *    have none) gets capsules on her hips, thighs and shins, sized from her own mesh (body-colliders.ts). The model's own colliders win:
 *    a leg bone that already carries one of the chain's colliders gets no runtime capsule. A runtime capsule never pushes a joint
 *    further out than it already rests (`reach`), so a coat modelled close to her legs keeps its shape at rest.
 */
import { Quaternion, Vector3, type Bone, type Object3D } from 'three';
import { STANDARD_BONES, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import type { LoadedModel, SpringChain, SpringCollider } from '../model-adapter/types';
import { BODY_COLLIDER_BONES, measureBodyCollider, nearestOnSegment } from './body-colliders';

export { nearestOnSegment };
export type SpringPart = 'hair' | 'chest';
/** Chains named for the bust are the chest switch's; everything else (hair, coat, skirt, ribbons) the hair switch's. */
export const CHEST_CHAIN = /bust|breast|oppai|胸|乳/iu;
/** UniVRM 0.x: a leaf joint's tail, this far along its bone (file metres). */
export const VIRTUAL_TAIL_M = 0.07;

export interface RigCollider {
  readonly bone: Object3D;
  readonly offset: Vector3;
  /** Capsule tail in the bone's space; null: a sphere. */
  readonly tail: Vector3 | null;
  readonly radiusM: number;
  /** A runtime body collider (not the file's). */
  readonly added: boolean;
}

export interface RigJoint {
  readonly bone: Bone;
  readonly restLocal: Quaternion;
  /** Tail direction in the bone's own space (unit) and length (the bone's local units: file metres). */
  readonly axis: Vector3;
  readonly length: number;
  readonly hitRadius: number;
  readonly stiffness: number;
  readonly gravityPower: number;
  readonly gravityDir: Vector3;
  readonly drag: number;
  /**
   * The colliders this joint's tail keeps out of. `reach` (metres): a runtime capsule's limit from the rest pose, null: full. `rest`
   * (metres): a runtime capsule's distance to the tail at rest (its soft layer stops there); null for the file's own colliders.
   */
  readonly colliders: readonly { readonly index: number; readonly reach: number | null; readonly rest: number | null }[];
}

export interface RigChain {
  readonly name: string;
  readonly part: SpringPart;
  readonly joints: readonly RigJoint[];
  /** The first joint's parent (its world pose drives the chain). */
  readonly rootParent: Object3D;
  /** Indices of the colliders any joint of this chain uses (to wake it when one moves). */
  readonly colliderIndices: readonly number[];
}

export interface SpringRig { readonly chains: readonly RigChain[]; readonly colliders: readonly RigCollider[]; readonly bodyColliders: number }

export interface SpringRigOptions {
  /** false: no runtime body colliders (the file's own only). Default true. */
  bodyColliders?: boolean;
}

const depthOf = (node: Object3D) => { let depth = 0; for (let at = node.parent; at && depth < 1024; at = at.parent) depth++; return depth; };
const v3 = (value: readonly number[] | undefined) => new Vector3(value?.[0] ?? 0, value?.[1] ?? 0, value?.[2] ?? 0);
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

export function buildSpringRig(model: Pick<LoadedModel, 'physics' | 'bone' | 'object' | 'meshes'>, options: SpringRigOptions = {}): SpringRig {
  const physics = model.physics;
  if (physics.kind !== 'vrm-spring') return { chains: [], colliders: [], bodyColliders: 0 };
  model.object.updateWorldMatrix(true, true);
  const scale = model.object.matrixWorld.getMaxScaleOnAxis() || 1; // world units per file metre (at rest)
  const colliders: RigCollider[] = [];
  const own = new Map<number, number>(); // file index → rig index
  (physics.shapes ?? []).forEach((shape: SpringCollider | null, index) => {
    if (!shape || !(shape.radius >= 0)) return;
    own.set(index, colliders.length);
    colliders.push({ bone: shape.bone, offset: v3(shape.offset), tail: shape.shape === 'capsule' ? v3(shape.tail) : null, radiusM: finite(shape.radius, 0), added: false });
  });
  const groups = physics.groups ?? [];
  // Her humanoid bones (the pose transfer writes them) and the ones her body colliders sit on.
  const humanoid = new Set<Object3D>(STANDARD_BONES.map(slot => model.bone(slot)).filter((bone): bone is Bone => !!bone));
  const legs = new Set<Object3D>(BODY_COLLIDER_BONES.map(slot => model.bone(slot)).filter((bone): bone is Bone => !!bone));
  const legBones = new Map<StandardBone, Bone>();
  for (const slot of BODY_COLLIDER_BONES) { const bone = model.bone(slot); if (bone) legBones.set(slot, bone); }
  // Every bone a spring chain names (clothes that swing are left out when her legs are measured).
  const swinging = new Set<Object3D>(physics.chains.flatMap(chain => chain.joints.map(joint => joint.bone)));
  const bodyIndex = new Map<Object3D, number>();
  const bodyCollider = (slot: StandardBone, bone: Bone): number | null => {
    const known = bodyIndex.get(bone);
    if (known !== undefined) return known;
    const collider = measureBodyCollider(slot, model, swinging);
    if (!collider) return null;
    bodyIndex.set(bone, colliders.length);
    colliders.push(collider);
    return colliders.length - 1;
  };

  const chains: RigChain[] = [];
  for (const chain of physics.chains) {
    for (const segment of splitChain(chain)) {
      const joints = segmentJoints(segment, chain, humanoid, scale);
      if (!joints.length) continue;
      const fileColliders = [...new Set(chain.colliderGroups.flatMap(group => groups[group] ?? []))].flatMap(index => own.has(index) ? [own.get(index)!] : []);
      const added: number[] = [];
      if (options.bodyColliders !== false && hangsBelowHips(segment[0].bone, joints, humanoid, legs, scale)) {
        for (const [slot, bone] of legBones) {
          if (fileColliders.some(index => colliders[index].bone === bone)) continue; // the model's own collider wins
          const index = bodyCollider(slot, bone);
          if (index !== null) added.push(index);
        }
      }
      const name = chain.name, part: SpringPart = CHEST_CHAIN.test(name) || segment.some(joint => CHEST_CHAIN.test(joint.bone.name)) ? 'chest' : 'hair';
      const withColliders = joints.map(joint => ({ ...joint, colliders: [
        ...fileColliders.map(index => ({ index, reach: null, rest: null })),
        ...added.map(index => ({ index, ...restReach(joint, colliders[index], scale) })),
      ] }));
      chains.push({ name, part, joints: withColliders, rootParent: segment[0].bone.parent!, colliderIndices: [...fileColliders, ...added] });
    }
  }
  chains.sort((a, b) => depthOf(a.joints[0].bone) - depthOf(b.joints[0].bone));
  return { chains, colliders, bodyColliders: bodyIndex.size };
}

type ChainJoint = SpringChain['joints'][number];

function splitChain(chain: SpringChain): ChainJoint[][] {
  const out: ChainJoint[][] = [];
  let current: ChainJoint[] = [];
  for (const joint of chain.joints) {
    if (current.length && joint.bone.parent !== current[current.length - 1].bone) { out.push(current); current = []; }
    current.push(joint);
  }
  if (current.length) out.push(current);
  return out.filter(segment => segment[0].bone.parent);
}

function segmentJoints(segment: ChainJoint[], chain: SpringChain, driven: ReadonlySet<Object3D>, scale: number): Omit<RigJoint, 'colliders'>[] {
  const out: Omit<RigJoint, 'colliders'>[] = [];
  const simulated = chain.leafTail ? segment.length : segment.length - 1;
  for (let k = 0; k < simulated; k++) {
    const joint = segment[k], bone = joint.bone;
    if (driven.has(bone)) break; // below a driven bone the chain would hang from her body's pose, not this one's
    const tail = new Vector3();
    if (k + 1 < segment.length) tail.copy(segment[k + 1].bone.position);
    else {
      // 0.x leaf: 7 cm on along the bone from its parent, in its own space.
      const at = bone.getWorldPosition(new Vector3()), from = bone.parent!.getWorldPosition(new Vector3());
      const direction = at.clone().sub(from);
      if (direction.lengthSq() < 1e-12) break;
      tail.copy(bone.worldToLocal(at.addScaledVector(direction.normalize(), VIRTUAL_TAIL_M * scale)));
    }
    const length = tail.length();
    if (!(length > 1e-6)) break;
    const gravity = v3(joint.gravityDir);
    if (gravity.lengthSq() > 1e-12) gravity.normalize(); else gravity.set(0, 0, 0);
    out.push({ bone, restLocal: bone.quaternion.clone(), axis: tail.clone().divideScalar(length), length,
      hitRadius: Math.max(0, finite(joint.hitRadius, 0)), stiffness: Math.max(0, finite(joint.stiffness, 1)), gravityPower: Math.max(0, finite(joint.gravityPower, 0)),
      gravityDir: gravity, drag: Math.min(1, Math.max(0, finite(joint.dragForce, 0.5))) });
  }
  return out;
}

/** Hangs below her hips: its nearest humanoid ancestor is her hips or a leg, and its last tail rests at least 5 cm below its root. */
function hangsBelowHips(root: Bone, joints: readonly Omit<RigJoint, 'colliders'>[], humanoid: ReadonlySet<Object3D>, legs: ReadonlySet<Object3D>, scale: number): boolean {
  let node = root.parent;
  for (let depth = 0; node && !humanoid.has(node) && depth < 1024; depth++) node = node.parent;
  if (!node || !legs.has(node)) return false;
  const last = joints[joints.length - 1];
  const tip = last.axis.clone().multiplyScalar(last.length).applyMatrix4(last.bone.matrixWorld);
  return tip.y < root.getWorldPosition(new Vector3()).y - 0.05 * scale;
}

/**
 * A runtime capsule and this joint at rest: how close it may push the tail (`reach`, metres: null for its full reach, less when the tail
 * already rests nearer) and how far the tail rests from its axis (`rest`, metres: the soft layer never reaches past it).
 */
function restReach(joint: Omit<RigJoint, 'colliders'>, collider: RigCollider, scale: number): { reach: number | null; rest: number } {
  const tail = joint.axis.clone().multiplyScalar(joint.length).applyMatrix4(joint.bone.matrixWorld);
  const a = collider.offset.clone().applyMatrix4(collider.bone.matrixWorld), b = collider.tail ? collider.tail.clone().applyMatrix4(collider.bone.matrixWorld) : null;
  const distance = tail.distanceTo(nearestOnSegment(tail, a, b, new Vector3())) / scale, full = collider.radiusM + joint.hitRadius;
  return { reach: distance < full ? distance : null, rest: distance };
}

