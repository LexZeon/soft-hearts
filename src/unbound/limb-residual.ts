/**
 * Motion-model spike, round 2 (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」): the hips' own turn and the arms' small idle
 * movements, as layer-3 residuals behind the same human-feel filter as the rest of the intent layer (intent-layer.ts calls this).
 *
 * Targets are turns about her body's axes (X her left, Y up, Z forward: the model's own frame), relative to each bone's parent:
 * the way scripts/ml/bvh_idle.py measures them on people, so they transfer across rest poses (the data's T-pose, Gene's A-pose).
 * Each bone gets r = q⁻¹ · P⁻¹ · W · P · q post-multiplied, where q is its pose now, P its parent's orientation in her frame and
 * W the turn: the same as turning it by W about her axes, in its parent's frame. Through springs at the table's group rates
 * (arms 1.4 Hz like the autonomy branch's arm channel, hips 2.2 Hz like the pelvis); nothing is written while all are at rest.
 * Her feet stay where they are: the leg IK runs after this (the contact owner writes the foot targets last).
 */
import { Quaternion, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { MOTION_GROUPS, RotationSpring } from './dynamics';
import type { PoseTargets, Rot } from './motion/generator';
import { figureBone } from './model/figure-bones';

export type LimbTargets = Pick<PoseTargets, 'hips' | 'armRot'>;

/** Exact names first, then the standard part they stand for (I-152 step 2, model/figure-bones.ts). */
const find = (mesh: SkinnedMesh, names: readonly string[]) => figureBone(mesh, names);
const isBone = (o: Object3D | null): o is Bone => !!o && (o as Bone).isBone === true;

/** The bone's parent's orientation in her model frame (the product of the local rotations above it, as posed now). */
function parentInModel(bone: Bone, out: Quaternion): Quaternion {
  out.identity();
  const chain: Bone[] = [];
  for (let p = bone.parent; isBone(p); p = p.parent) chain.push(p);
  for (let i = chain.length - 1; i >= 0; i--) out.multiply(chain[i].quaternion);
  return out;
}

export class LimbResidual {
  private readonly slots: { bone: Bone; spring: RotationSpring; read: (t: LimbTargets) => Rot | undefined }[] = [];
  private readonly p = new Quaternion();
  private readonly w = new Quaternion();
  private readonly r = new Quaternion();

  constructor(mesh: SkinnedMesh) {
    const add = (names: readonly string[], spec: { hz: number; zeta: number }, read: (t: LimbTargets) => Rot | undefined) => {
      const bone = find(mesh, names);
      if (bone) this.slots.push({ bone, spring: new RotationSpring({ ...spec, eased: true }), read });
    };
    add(['下半身', 'lower_body', 'Hips'], MOTION_GROUPS.pelvis, t => t.hips);
    add(['左腕', 'LeftArm', 'left_arm'], MOTION_GROUPS.arms, t => t.armRot?.left.upper);
    add(['左ひじ', 'LeftElbow', 'left_elbow'], MOTION_GROUPS.arms, t => t.armRot?.left.elbow);
    add(['右腕', 'RightArm', 'right_arm'], MOTION_GROUPS.arms, t => t.armRot?.right.upper);
    add(['右ひじ', 'RightElbow', 'right_elbow'], MOTION_GROUPS.arms, t => t.armRot?.right.elbow);
  }

  /** Bones it found (for tests). */
  get bones(): string[] { return this.slots.map(s => s.bone.name); }
  get idle(): boolean { return this.slots.every(s => s.spring.idle); }

  set(targets: LimbTargets): void {
    for (const slot of this.slots) {
      const r = slot.read(targets);
      const ok = r && Number.isFinite(r.pitch) && Number.isFinite(r.yaw) && Number.isFinite(r.roll);
      slot.spring.target(ok ? r.pitch : 0, ok ? r.yaw : 0, ok ? -r.roll : 0);
    }
  }

  advance(h: number): void { for (const slot of this.slots) slot.spring.advance(h); }

  /** Writes the residuals through `rotate` (post-multiplied, remembered for the restore by the figure). */
  apply(rotate: (bone: Bone, rotation: Quaternion) => void): void {
    for (const { bone, spring } of this.slots) {
      if (spring.idle) continue;
      spring.quaternion(this.w);
      parentInModel(bone, this.p);
      // r = q⁻¹ · P⁻¹ · W · P · q
      this.r.copy(bone.quaternion).invert().multiply(this.p.clone().invert()).multiply(this.w).multiply(this.p).multiply(bone.quaternion);
      rotate(bone, this.r.clone());
    }
  }
}
