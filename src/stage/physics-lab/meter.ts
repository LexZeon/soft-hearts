/**
 * 物理调参台: the live numbers (and the offline measurements in tests): per group, from the output bones' positions before the
 * physics frame (the final animated pose) and after it.
 * - jitter: largest per-frame move of an output bone while the motion holds still (after a short settle), model units.
 * - unexpected step: largest change of a bone's per-frame physics offset move from one frame to the next (R29d's "意外步长", on the
 *   offset from the animated pose so the test motion's own acceleration does not count): a snap or judder.
 * - swing: largest peak-to-peak range of a bone's offset from the animated pose in the window (how much it actually moves, as
 *   opposed to sitting at a fixed offset).
 * - droop: mean downward offset of the output bones from the animated pose (gravity sag), model units.
 * - stretch: largest |segment length / animated length − 1| between an output bone and its output parent.
 * - penetration: largest depth an output bone sinks into one of the model's own body colliders beyond what the animated pose
 *   already has (hair roots start inside the head), and in how many frames.
 * - settle: seconds after the motion stops until every output bone moves less than SETTLE_STEP per frame for SETTLE_HOLD.
 * - motion: mean distance from the animated pose (how much the part moves at all).
 * Points: each output bone's head, and the tail of each leaf (its child bone, else its rigid body's centre), since a leaf bone that
 * only turns (a chest on the spring solver) moves nothing but its tail. Model units throughout (the mesh's own space, so the companion's scale does not change the numbers). Pure: no Ammo, no DOM.
 */
import { Euler, Matrix4, Quaternion, Vector3, type SkinnedMesh } from "three";

export const SETTLE_STEP = 0.002;
const TAIL = 1_000_000;
export const SETTLE_HOLD = 0.3;
const STILL_WARMUP = 1.0;

export interface MeterCollider { bone: number; shape: number; radius: number; half: number; offset: Vector3; rotation: Quaternion }

export interface GroupNumbers {
  jitter: number; unexpectedStep: number; droop: number; stretch: number;
  penetrationDepth: number; penetrationFrames: number; settleSeconds: number | null; motion: number; swing: number; frames: number;
}

interface Track { bones: number[]; parents: number[]; previous: Vector3[]; previousStep: Vector3[]; offset: Vector3[]; low: Vector3[]; high: Vector3[]; valid: boolean; numbers: GroupNumbers; quietFor: number; settled: boolean; droopSum: number; motionSum: number }

const fresh = (): GroupNumbers => ({ jitter: 0, unexpectedStep: 0, droop: 0, stretch: 0, penetrationDepth: 0, penetrationFrames: 0, settleSeconds: null, motion: 0, swing: 0, frames: 0 });

/** Body colliders (kinematic bodies on bones) from the loader's rigid body data: sphere, capsule, box as a capsule. */
export function meterColliders(mesh: SkinnedMesh, sourceBodies: readonly number[]): MeterCollider[] {
  const raw = (mesh.geometry.userData as { MMD?: { rigidBodies?: Record<string, unknown>[] } }).MMD?.rigidBodies ?? [];
  const result: MeterCollider[] = [];
  for (const index of sourceBodies) {
    const body = raw[index];
    if (!body || body.type !== 0 || typeof body.boneIndex !== "number" || body.boneIndex < 0) continue;
    const w = Number(body.width), h = Number(body.height), d = Number(body.depth), shape = Number(body.shapeType);
    const position = body.position as number[], rotation = body.rotation as number[];
    if (![w, h, d].every(Number.isFinite) || !Array.isArray(position) || !Array.isArray(rotation)) continue;
    const q = new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2]));
    if (shape === 0) result.push({ bone: body.boneIndex, shape, radius: w, half: 0, offset: new Vector3(...position), rotation: q });
    else if (shape === 2) result.push({ bone: body.boneIndex, shape, radius: w, half: h / 2, offset: new Vector3(...position), rotation: q });
    else {
      // A box as a capsule along its longest axis (rotated onto y) with the middle extent as radius.
      const sorted = [w, h, d].sort((a, b) => b - a);
      const axis = w >= h && w >= d ? new Vector3(1, 0, 0) : d >= h ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
      const onto = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis);
      result.push({ bone: body.boneIndex, shape: 2, radius: sorted[1], half: Math.max(0, sorted[0] - sorted[1]), offset: new Vector3(...position), rotation: q.clone().multiply(onto) });
    }
  }
  return result;
}

export class PhysicsMeter {
  private readonly tracks = new Map<string, Track>();
  private readonly base = new Map<number, Vector3>();
  /** Leaf bones' tails (a bone turning about its own head moves nothing else): pseudo index TAIL + bone → offset in the bone. */
  private readonly tails = new Map<number, Vector3>();
  private readonly inverse = new Matrix4();
  private readonly point = new Vector3();
  private stepMsSum = 0;
  private stepMsCount = 0;

  constructor(private readonly mesh: SkinnedMesh, groups: readonly { id: string; outputBones: readonly number[] }[],
    private readonly colliders: readonly MeterCollider[] = []) {
    const parentOf = (bone: number, set: Set<number>) => {
      let node = mesh.skeleton.bones[bone].parent;
      while (node) { const index = mesh.skeleton.bones.indexOf(node as never); if (set.has(index)) return index; node = node.parent; }
      return -1;
    };
    const raw = (mesh.geometry.userData as { MMD?: { rigidBodies?: { boneIndex?: unknown; position?: unknown }[] } }).MMD?.rigidBodies ?? [];
    for (const group of groups) {
      const set = new Set(group.outputBones);
      const points = [...group.outputBones], parents = group.outputBones.map(bone => parentOf(bone, set));
      for (const bone of group.outputBones) {
        if (group.outputBones.some(other => parentOf(other, set) === bone)) continue;
        const child = mesh.skeleton.bones[bone].children.find(node => (node as { isBone?: boolean }).isBone);
        const body = raw.find(entry => entry?.boneIndex === bone)?.position;
        const tail = child && child.position.lengthSq() > 1e-8 ? child.position.clone()
          : Array.isArray(body) && body.length === 3 && body.every(Number.isFinite) ? new Vector3(body[0], body[1], body[2]) : null;
        if (!tail || tail.lengthSq() < 1e-8) continue;
        this.tails.set(TAIL + bone, tail);
        points.push(TAIL + bone); parents.push(bone);
      }
      this.tracks.set(group.id, { bones: points, parents,
        previous: points.map(() => new Vector3()), previousStep: points.map(() => new Vector3()),
        offset: points.map(() => new Vector3()), low: points.map(() => new Vector3(Infinity, Infinity, Infinity)),
        high: points.map(() => new Vector3(-Infinity, -Infinity, -Infinity)), valid: false,
        numbers: fresh(), quietFor: 0, settled: false, droopSum: 0, motionSum: 0 });
    }
  }

  private local(bone: number, target: Vector3): Vector3 {
    const tail = this.tails.get(bone);
    if (tail) return target.copy(tail).applyMatrix4(this.mesh.skeleton.bones[bone - TAIL].matrixWorld).applyMatrix4(this.inverse);
    return this.mesh.skeleton.bones[bone].getWorldPosition(target).applyMatrix4(this.inverse);
  }

  /** Call with the final animated pose, before the physics frame. */
  sampleBase(): void {
    this.mesh.updateMatrixWorld(true);
    this.inverse.copy(this.mesh.matrixWorld).invert();
    for (const track of this.tracks.values()) for (const bone of track.bones) this.local(bone, this.base.get(bone) ?? this.base.set(bone, new Vector3()).get(bone)!);
  }

  private depth(point: Vector3): number {
    let deepest = -Infinity;
    const center = new Vector3(), axis = new Vector3(), bonePosition = new Vector3(), boneRotation = new Quaternion(), scale = new Vector3();
    for (const collider of this.colliders) {
      const bone = this.mesh.skeleton.bones[collider.bone];
      bone.matrixWorld.decompose(bonePosition, boneRotation, scale);
      center.copy(collider.offset).applyQuaternion(boneRotation).add(bonePosition).applyMatrix4(this.inverse);
      let distance: number;
      if (collider.half <= 0) distance = point.distanceTo(center);
      else {
        axis.set(0, 1, 0).applyQuaternion(collider.rotation).applyQuaternion(boneRotation)
          .transformDirection(this.inverse);
        const along = Math.max(-collider.half, Math.min(collider.half, axis.dot(this.point.copy(point).sub(center))));
        distance = point.distanceTo(this.point.copy(center).addScaledVector(axis, along));
      }
      deepest = Math.max(deepest, collider.radius - distance);
    }
    return deepest;
  }

  /** Call after the physics frame. `stillFor`: seconds the motion has held still (null while it moves). */
  sampleAfter(dt: number, stillFor: number | null, stepMs?: number): void {
    this.mesh.updateMatrixWorld(true);
    if (typeof stepMs === "number" && Number.isFinite(stepMs)) { this.stepMsSum += stepMs; this.stepMsCount++; }
    const now = new Vector3(), step = new Vector3(), parent = new Vector3(), offset = new Vector3(), range = new Vector3();
    for (const track of this.tracks.values()) {
      const numbers = track.numbers;
      let frameMax = 0, droop = 0, motion = 0;
      track.bones.forEach((bone, i) => {
        this.local(bone, now);
        const base = this.base.get(bone)!;
        droop += base.y - now.y;
        motion += now.distanceTo(base);
        offset.copy(now).sub(base);
        track.low[i].min(offset); track.high[i].max(offset);
        numbers.swing = Math.max(numbers.swing, range.copy(track.high[i]).sub(track.low[i]).length());
        if (track.valid) {
          frameMax = Math.max(frameMax, step.copy(now).sub(track.previous[i]).length());
          step.copy(offset).sub(track.offset[i]);
          numbers.unexpectedStep = Math.max(numbers.unexpectedStep, step.distanceTo(track.previousStep[i]));
          track.previousStep[i].copy(step);
        }
        track.offset[i].copy(offset);
        track.previous[i].copy(now);
        const up = track.parents[i];
        if (up >= 0) {
          this.local(up, parent);
          const rest = base.distanceTo(this.base.get(up)!);
          if (rest > 1e-6) numbers.stretch = Math.max(numbers.stretch, Math.abs(now.distanceTo(parent) / rest - 1));
        }
        if (this.colliders.length) {
          const extra = this.depth(now) - Math.max(0, this.depth(base));
          if (extra > 0) { numbers.penetrationDepth = Math.max(numbers.penetrationDepth, extra); }
        }
      });
      if (this.colliders.length && track.bones.some((bone, i) => this.depth(track.previous[i]) - Math.max(0, this.depth(this.base.get(bone)!)) > 0.05)) numbers.penetrationFrames++;
      if (track.bones.length) { track.droopSum += droop / track.bones.length; track.motionSum += motion / track.bones.length; }
      numbers.frames++;
      numbers.droop = track.droopSum / numbers.frames;
      numbers.motion = track.motionSum / numbers.frames;
      if (stillFor !== null && track.valid) {
        if (stillFor >= STILL_WARMUP) numbers.jitter = Math.max(numbers.jitter, frameMax);
        if (!track.settled) {
          track.quietFor = frameMax < SETTLE_STEP ? track.quietFor + dt : 0;
          if (track.quietFor >= SETTLE_HOLD) { track.settled = true; numbers.settleSeconds = Math.max(0, stillFor - track.quietFor); }
        }
      } else if (stillFor === null) { track.quietFor = 0; track.settled = false; }
      track.valid = true;
    }
  }

  numbers(): Record<string, GroupNumbers> {
    return Object.fromEntries([...this.tracks].map(([id, track]) => [id, { ...track.numbers }]));
  }

  get avgStepMs(): number { return this.stepMsCount ? this.stepMsSum / this.stepMsCount : 0; }

  /** A new window (a new loop, a changed knob): keeps the previous positions so the first step is still measured. */
  reset(): void {
    for (const track of this.tracks.values()) {
      track.low.forEach(v => v.setScalar(Infinity)); track.high.forEach(v => v.setScalar(-Infinity));
      track.numbers = fresh(); track.droopSum = 0; track.motionSum = 0; track.quietFor = 0; track.settled = false; }
    this.stepMsSum = 0; this.stepMsCount = 0;
  }
}
