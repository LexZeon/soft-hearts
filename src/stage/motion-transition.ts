import { Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import { RotationPath } from './rotation-path';

/** In-memory values from one model only; never a renderer path evaluator. */
export interface MotionPoseSnapshot {
  readonly mesh: SkinnedMesh;
  readonly values: ReadonlyMap<string, readonly number[]>;
}

export interface MotionTransitionState {
  active: boolean;
  elapsedMs: number;
  durationMs: number;
  /** Smooth target contribution: zero is the captured display, one the live target. */
  weight: number;
}

type BoneProperty = 'quaternion' | 'position' | 'scale';
type Binding = { kind: BoneProperty; bone: Bone } | { kind: 'morph'; index: number };
/**
 * `path` (rotations): which way round the live target is followed (R29e, rotation-path.ts).
 * `rate` (R29f): how fast the shown pose was moving when it was captured (bone-local, per second: a body-frame
 * angular velocity for a rotation, per axis for a position), or null.
 */
interface TransitionProperty { binding: Binding; from: readonly number[]; path: RotationPath | null; rate: readonly number[] | null }
/** R29f: the composed pose's own rate per track name at capture (StageContinuity.rates), or null when unknown. */
export type PoseRates = (name: string) => readonly number[] | null;
const DEFAULT_DURATION_MS = 400;
/**
 * R29f: the captured start keeps moving the way it was and slows to a stop (its speed decays as exp(−k t) with
 * k = DRIFT_PER_DURATION / duration), while the weight carries it to the live target. Shown speed at the first
 * frame = the speed it had (no stop dead at the start of a hand-off); the extra way it coasts is at most
 * MAX_DRIFT_DEG (rotations), so a fast swing never flings past.
 */
export const DRIFT_PER_DURATION = 4;
export const MAX_DRIFT_DEG = 10;
const finite = (values: readonly number[]) => values.every(Number.isFinite);
const validQuaternion = (values: readonly number[]) => values.length === 4 && finite(values)
  && values.reduce((sum, value) => sum + value * value, 0) > 1e-12;
/** R29f: smootherstep, zero speed and zero acceleration at both ends (was smoothstep: an acceleration step at each end). */
const smooth = (value: number) => value * value * value * (value * (value * 6 - 15) + 10);

function namedBones(mesh: SkinnedMesh): Map<string, Bone> {
  const bones = new Map<string, Bone>(), ambiguous = new Set<string>();
  for (const bone of mesh.skeleton.bones) {
    if (bones.has(bone.name)) ambiguous.add(bone.name);
    else bones.set(bone.name, bone);
  }
  for (const name of ambiguous) bones.delete(name);
  return bones;
}

/** Capture before restoring the prior transition/procedural layers for a switch. */
export function captureMotionPose(mesh: SkinnedMesh): MotionPoseSnapshot {
  const values = new Map<string, readonly number[]>();
  for (const [name, bone] of namedBones(mesh)) {
    for (const property of ['quaternion', 'position', 'scale'] as const) {
      const value = bone[property].toArray();
      if (finite(value) && (property !== 'quaternion' || validQuaternion(value)))
        values.set(`.bones[${name}].${property}`, value);
    }
  }
  mesh.morphTargetInfluences?.forEach((value, index) => {
    if (Number.isFinite(value)) values.set(`.morphTargetInfluences[${index}]`, [value]);
  });
  return { mesh, values };
}

/**
 * A short display bridge; it owns no AnimationAction, source track, or clock.
 * Tick: restore() first -> all target layers -> frame(delta) -> render.
 * Switch: captureMotionPose -> restore all layers -> setClips -> start.
 * R29e: a rotation shows from * (from^-1 * live target)^w and keeps going the
 * way round the target went since the first frame with progress (RotationPath),
 * so a target that moves across a half turn from the start never flips the
 * display. With no progress yet (w = 0) the start is shown and the way round is
 * still open; a zero-delta rebuild between ticks follows the new target at the
 * same w without choosing a new way round.
 */
export class MotionTransition {
  private readonly bones: Map<string, Bone>;
  private readonly properties = new Map<string, TransitionProperty>();
  private readonly bases = new Map<string, { binding: Binding; value: readonly number[] }>();
  private readonly fromQuaternion = new Quaternion();
  private readonly targetQuaternion = new Quaternion();
  private elapsedMs = 0;
  private durationMs = 0;
  /** R29c: a duration sized on the first composed frame (see start). */
  private sizeDuration: ((angleDeg: number) => number) | null = null;
  private weight = 1;
  private disposed = false;

  constructor(private readonly mesh: SkinnedMesh) { this.bones = namedBones(mesh); }

  /**
   * The snapshot must belong to this exact mesh, including during rapid reselects.
   * `durationMs` may be a function of the correction (degrees): it is then sized
   * once, on the first frame with elapsed time, against the fully composed target
   * (layers that return when an owner leaves are part of what the bridge covers).
   */
  start(snapshot: MotionPoseSnapshot, trackNames: readonly string[], durationMs: number | ((angleDeg: number) => number) = DEFAULT_DURATION_MS,
    rates: PoseRates | null = null): boolean {
    if (this.disposed || snapshot.mesh !== this.mesh) return false;
    const names = new Set([...this.properties.keys(), ...trackNames]);
    const next = new Map<string, TransitionProperty>();
    for (const name of names) {
      const binding = this.resolve(name), from = snapshot.values.get(name);
      if (!binding || !from || !this.valid(binding, from)) continue;
      // R29f: a rebuilt bridge (a reselect mid-way) starts from rest at what is shown; only a live pose has a rate.
      let rate = binding.kind === 'quaternion' || binding.kind === 'position' ? rates?.(name) ?? null : null;
      if (rate && (rate.length !== 3 || !finite(rate))) rate = null;
      next.set(name, { binding, from: [...from], path: binding.kind === 'quaternion' ? new RotationPath() : null, rate: rate ? [...rate] : null });
    }
    this.properties.clear();
    for (const [name, property] of next) this.properties.set(name, property);
    // The caller has already restored the prior bridge before changing bindings.
    this.bases.clear();
    this.elapsedMs = 0;
    this.sizeDuration = typeof durationMs === 'function' ? durationMs : null;
    const fixed = typeof durationMs === 'number' ? durationMs : DEFAULT_DURATION_MS;
    this.durationMs = Number.isFinite(fixed) && fixed >= 0 ? Math.min(2_000, fixed) : DEFAULT_DURATION_MS;
    this.weight = this.properties.size && this.durationMs > 0 ? 0 : 1;
    if (this.weight === 1) this.properties.clear();
    return this.properties.size > 0;
  }

  restore(): void {
    for (const { binding, value } of this.bases.values()) this.write(binding, value);
    this.bases.clear();
  }

  frame(delta: number): void {
    if (this.disposed || !this.properties.size) return;
    if (this.sizeDuration && Number.isFinite(delta) && delta > 0) {
      const size = this.sizeDuration(this.correctionDeg());
      this.sizeDuration = null;
      this.durationMs = Number.isFinite(size) && size > 0 ? Math.min(2_000, size) : DEFAULT_DURATION_MS;
    }
    this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + (Number.isFinite(delta) ? Math.max(0, Math.min(0.1, delta)) : 0) * 1_000);
    this.weight = smooth(this.elapsedMs / this.durationMs);
    if (this.weight >= 1) { this.properties.clear(); return; }
    // R29f: how far the captured start has coasted on its own speed (seconds of that speed), see DRIFT_PER_DURATION.
    const k = DRIFT_PER_DURATION / Math.max(0.05, this.durationMs / 1000), coast = (1 - Math.exp(-k * this.elapsedMs / 1000)) / k;
    for (const [name, { binding, from, path, rate }] of this.properties) {
      const target = this.read(binding);
      if (!target || !this.valid(binding, target)) continue;
      this.bases.set(name, { binding, value: target });
      if (this.weight === 0 && !(rate && coast > 0)) { this.write(binding, from); path?.reset(); }
      else if (binding.kind === 'quaternion' && path) {
        this.fromQuaternion.fromArray(from);
        if (rate && coast > 0) this.coastRotation(rate, coast, k);
        this.targetQuaternion.fromArray(target);
        if (this.weight === 0) { binding.bone.quaternion.copy(this.fromQuaternion); path.reset(); }
        else path.blend(this.fromQuaternion, this.targetQuaternion, this.weight, binding.bone.quaternion);
      } else {
        const start = rate && coast > 0 ? from.map((value, index) => value + rate[index] * coast) : from;
        this.write(binding, start.map((value, index) => value + (target[index] - value) * this.weight));
      }
    }
  }

  /** fromQuaternion ← from · exp(rate · coast), the way bounded by MAX_DRIFT_DEG in total (rate · 1/k). */
  private coastRotation(rate: readonly number[], coast: number, k: number): void {
    const speed = Math.hypot(rate[0], rate[1], rate[2]), limit = MAX_DRIFT_DEG * Math.PI / 180 * k;
    const scale = speed > limit ? limit / speed : 1, angle = speed * scale * coast;
    if (!(angle > 1e-9)) return;
    this.coast.set(rate[0] / speed, rate[1] / speed, rate[2] / speed);
    this.coastQuaternion.setFromAxisAngle(this.coast, angle);
    this.fromQuaternion.multiply(this.coastQuaternion);
  }
  private readonly coast = new Vector3();
  private readonly coastQuaternion = new Quaternion();

  getState(): MotionTransitionState {
    return { active: this.properties.size > 0, elapsedMs: this.elapsedMs, durationMs: this.durationMs, weight: this.weight };
  }
  ownsProperty(name:string):boolean { return !this.disposed&&this.properties.has(name); }

  /**
   * Largest rotation still to bridge, in degrees: per bone the angle between its
   * captured and current target rotation, accumulated down chains of bridged
   * bones (a neck and a head that both turn back add up on screen).
   */
  private correctionDeg(): number {
    const local = new Map<Bone, number>(), total = new Map<Bone, number>();
    for (const { binding, from } of this.properties.values()) {
      if (binding.kind !== 'quaternion') continue;
      this.fromQuaternion.fromArray(from).normalize();
      this.targetQuaternion.copy(binding.bone.quaternion).normalize();
      local.set(binding.bone, this.fromQuaternion.angleTo(this.targetQuaternion));
    }
    const along = (bone: Bone): number => {
      const known = total.get(bone);
      if (known !== undefined) return known;
      const parent = bone.parent as Bone | null;
      const value = (local.get(bone) ?? 0) + (parent?.isBone && local.has(parent) ? along(parent) : 0);
      total.set(bone, value);
      return value;
    };
    let largest = 0;
    for (const bone of local.keys()) largest = Math.max(largest, along(bone));
    return largest * 180 / Math.PI;
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore(); this.properties.clear(); this.bones.clear();
    this.disposed = true; this.weight = 1;
  }

  private resolve(name: string): Binding | null {
    const morph = /^\.morphTargetInfluences\[(\d+)\]$/.exec(name);
    if (morph) {
      const index = Number(morph[1]);
      return Number.isSafeInteger(index) && index < (this.mesh.morphTargetInfluences?.length ?? 0) ? { kind: 'morph', index } : null;
    }
    const bone = /^\.bones\[([^\[\]\u0000-\u001f]{1,256})\]\.(quaternion|position|scale)$/.exec(name);
    const target = bone && this.bones.get(bone[1]);
    return target && bone ? { kind: bone[2] as BoneProperty, bone: target } : null;
  }

  private read(binding: Binding): number[] | null {
    if (binding.kind === 'morph') {
      const value = this.mesh.morphTargetInfluences?.[binding.index];
      return value === undefined ? null : [value];
    }
    return binding.bone[binding.kind].toArray();
  }

  private valid(binding: Binding, value: readonly number[]): boolean {
    return binding.kind === 'quaternion' ? validQuaternion(value)
      : value.length === (binding.kind === 'morph' ? 1 : 3) && finite(value);
  }

  private write(binding: Binding, value: readonly number[]): void {
    if (binding.kind === 'morph') {
      const values = this.mesh.morphTargetInfluences;
      if (values && binding.index < values.length) values[binding.index] = value[0];
    } else binding.bone[binding.kind].fromArray(value);
  }
}

/**
 * R29c: a revoked automatic body motion hands the shown pose back to the
 * running base over a time that grows with the size of the correction, so its
 * peak angular acceleration stays near HANDOFF_ACCELERATION (deg/s^2) for
 * smoothstep (peak 6 * angle / T^2): a small correction is quick, a large one
 * is never a lunge. Bounded to [HANDOFF_MIN_MS, HANDOFF_MAX_MS].
 */
export const HANDOFF_ACCELERATION = 300;
export const HANDOFF_MIN_MS = 300;
export const HANDOFF_MAX_MS = 800;
export function handoffDurationMs(maxAngleDeg: number, maxMs = HANDOFF_MAX_MS): number {
  const seconds = Math.sqrt(6 * Math.max(0, Number.isFinite(maxAngleDeg) ? maxAngleDeg : 0) / HANDOFF_ACCELERATION);
  return Math.min(maxMs, Math.max(HANDOFF_MIN_MS, seconds * 1_000));
}
/**
 * R29d: a switch of the selected motion layers (the user's choice, or a layer
 * held because it does not suit the model) can land far from the old pose
 * (arms at the sides vs folded: ~60 deg along the arm chain). It follows the
 * same acceleration law with more room: up to SWITCH_MAX_MS.
 */
export const SWITCH_MAX_MS = 1500;
export const switchDurationMs = (maxAngleDeg: number): number => handoffDurationMs(maxAngleDeg, SWITCH_MAX_MS);

interface MmdRigMetadata {
  grants?: readonly { index: number; parentIndex: number; affectRotation?: boolean; affectPosition?: boolean }[];
  iks?: readonly { target: number; effector: number; links: readonly { index: number }[] }[];
}
/**
 * Track names plus the bones the MMD helper derives from them after the mixer:
 * grant (付与) children of moved bones, and IK links whose target or chain hangs
 * below a moved bone. Those follow the new base inside the helper, before any
 * display bridge, so a bridge over the tracks alone would still snap them
 * (Gene: 右肩連 <- 右肩, the cloak IK). Read-only; unknown structure adds nothing.
 */
export function withDerivedBones(mesh: SkinnedMesh, trackNames: readonly string[]): string[] {
  const bones = mesh.skeleton.bones, index = new Map<string, number>();
  bones.forEach((bone: Bone, i: number) => { if (!index.has(bone.name)) index.set(bone.name, i); });
  const moved = new Set<number>();
  for (const name of trackNames) {
    const match = /^\.bones\[([^\[\]]+)\]\.(?:quaternion|position)$/.exec(name), i = match ? index.get(match[1]) : undefined;
    if (i !== undefined) moved.add(i);
  }
  const rig = (mesh.geometry?.userData as { MMD?: MmdRigMetadata } | undefined)?.MMD;
  const grants = Array.isArray(rig?.grants) ? rig!.grants : [], iks = Array.isArray(rig?.iks) ? rig!.iks : [];
  const below = (i: number) => { for (let bone = bones[i] as Bone | undefined; bone; bone = bone.parent as Bone | undefined) {
    const j = bones.indexOf(bone); if (j >= 0 && moved.has(j)) return true; if (!(bone.parent as Bone | undefined)?.isBone) return false;
  } return false; };
  const names = new Set(trackNames);
  const add = (i: number, rotation: boolean, position: boolean) => {
    const name = bones[i]?.name; if (!name) return false;
    let added = false;
    if (rotation && !names.has(`.bones[${name}].quaternion`)) { names.add(`.bones[${name}].quaternion`); added = true; }
    if (position && !names.has(`.bones[${name}].position`)) { names.add(`.bones[${name}].position`); added = true; }
    if (added) moved.add(i);
    return added;
  };
  for (let changed = true, rounds = 0; changed && rounds < 8; rounds++) {
    changed = false;
    for (const grant of grants) if (moved.has(grant.parentIndex))
      changed = add(grant.index, grant.affectRotation !== false, grant.affectPosition === true) || changed;
    for (const ik of iks) if (below(ik.target) || ik.links.some((link: { index: number }) => below(link.index)))
      for (const link of ik.links) changed = add(link.index, true, false) || changed;
  }
  return [...names];
}

export interface HandoffPhysics { restore(): void; frame(delta: number): void }

/**
 * Cancel as a hand-off (docs/mood/action-composition.md: from the visible pose
 * back to the still-running base). Captures what is shown (before physics),
 * runs the owner's synchronous `stop` (which rebuilds the base at dt 0), then
 * bridges the tracks and the bones the helper derives from them from the
 * captured pose with the shared display transition, for a time set by the
 * size of the correction on the first composed frame (handoffDurationMs; it
 * includes layers that return because the owner left, e.g. the pointer-follow
 * head). Outer layers are restored before
 * the bridge restarts (switch order) and physics follows the bridged anchors at
 * dt 0. Nothing is captured when no pose was rendered yet. Returns the
 * transition to keep (created on demand).
 */
export function handOffToBase(mesh: SkinnedMesh | null, rendered: boolean, transition: MotionTransition | null,
  physics: HandoffPhysics | null | undefined, trackNames: readonly string[], stop: () => void, rates: PoseRates | null = null): MotionTransition | null {
  physics?.restore();
  const pose = mesh && rendered && trackNames.length ? captureMotionPose(mesh) : null;
  stop();
  if (!pose || !mesh) return transition;
  physics?.restore(); transition?.restore();
  const bridge = transition ?? new MotionTransition(mesh);
  // R29f: `rates` (the shown pose's own speed) lets the bridge start at that speed instead of from rest.
  bridge.start(pose, withDerivedBones(mesh, trackNames), handoffDurationMs, rates);
  bridge.frame(0); physics?.frame(0);
  return bridge;
}
