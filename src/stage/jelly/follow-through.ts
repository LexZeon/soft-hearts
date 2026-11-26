/**
 * I-147 全身果冻, layer 2: follow-through on the main skeleton (docs/claude/2026-11-17-whole-body-jelly.md).
 *
 * Spine, neck, head, shoulders and arms get a small lag and overshoot that settles when she stops or a gesture ends. Per bone one
 * damped spring (frequency in Hz, damping ratio) whose state x is a small rotation vector in the parent's frame. Its drive is the
 * change of the shown angular velocity: when a bone starts turning, x lags behind; when it stops, x carries on a little and comes
 * back (x'' = -ω0²x - 2ζω0 x' - α, α the angular acceleration of the pose it rides on). A steady turn and a held pose give 0.
 *
 * Writer order (R29): after the final pose and the continuity guard, before local physics; removed right after render (the stage),
 * or at the start of the next frame (Unbound) — remove() only undoes a value nobody has replaced since. It reads the guarded pose,
 * so a bridge the guard is running never reaches it as a jolt, and the guard never sees this layer (no fight).
 * Never a jump:
 * - output = gain · maxAngle · tanh(|x| / maxAngle) along x: always under the bound, smooth everywhere (a soft limit, no corner);
 * - switching on or off fades the gain over FADE_SECONDS; a hard reset (guard reset, a cut, a too-fast step) only forgets the
 *   velocity history (no impulse), and the spring brings what is shown back to the pose by itself;
 * - hidden: everything is cleared (nothing is on screen to jump from).
 * Bones a physics part simulates are never touched. Rotation offsets are local; grant children that copy a bone's rotation (e.g. a
 * model's 肩連) do not see the offset (at most the bound; written down in the record).
 */
import { Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import { standardBoneOfName, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import { FOLLOW_REGIONS, type FollowRegion, type FollowTuning } from '../../../shared/stage/jelly-tuning';

export const FADE_SECONDS = 0.3;
/** Integration step (s): stable for every allowed frequency at any frame rate. */
const SUBSTEP = 1 / 240;
/** A shown turn faster than this (rad/s) is a cut, not motion: no impulse from it. */
const MAX_TURN_RATE = 20;
/** Largest change of the shown angular velocity taken in one frame (rad/s). */
const MAX_IMPULSE = 6;
/** Frames longer than this are a stall: the history is forgotten, the spring keeps easing. */
const MAX_STEP_SECONDS = 0.25;
const DEG = Math.PI / 180;

const REGION_BONES: Readonly<Record<FollowRegion, readonly StandardBone[]>> = {
  spine: ['upperBody', 'upperBody2'], neck: ['neck'], head: ['head'], shoulders: ['shoulderLeft', 'shoulderRight'],
  arms: ['armLeft', 'armRight', 'elbowLeft', 'elbowRight'],
};
/** Some models have a third spine bone; it belongs with the spine. */
const EXTRA_SPINE = /^上半身3$/u;

export interface FollowBone { bone: Bone; index: number; region: FollowRegion }

/** The bones layer 2 moves, by region, without the bones physics owns. Pure lookup by name; nothing is changed. */
export function followBones(mesh: SkinnedMesh, excluded: ReadonlySet<number> = new Set()): FollowBone[] {
  const roleRegion = new Map<StandardBone, FollowRegion>();
  for (const region of FOLLOW_REGIONS) for (const role of REGION_BONES[region]) roleRegion.set(role, region);
  const out: FollowBone[] = [], taken = new Set<StandardBone>();
  mesh.skeleton.bones.forEach((bone, index) => {
    if (excluded.has(index)) return;
    const role = standardBoneOfName(bone.name);
    const region = role ? roleRegion.get(role) : EXTRA_SPINE.test(bone.name.normalize('NFKC')) ? 'spine' : undefined;
    if (!region) return;
    if (role) { if (taken.has(role)) return; taken.add(role); }
    out.push({ bone, index, region });
  });
  return out;
}

interface BoneState extends FollowBone {
  root: boolean;
  x: Vector3; v: Vector3;
  prevQ: Quaternion; hasQ: boolean;
  prevW: Vector3; hasW: boolean;
  saved: Quaternion; written: Quaternion; applied: boolean;
  w: Vector3;
}

export interface FollowState {
  active: boolean;
  gain: number;
  bones: number;
  /** Largest offset shown on the last frame (degrees). */
  maxShownDeg: number;
  /** Average cost of apply() (ms), recent frames. */
  avgMs: number;
}

const q1 = new Quaternion(), q2 = new Quaternion(), v1 = new Vector3();

/** Rotation vector (axis · angle, shortest way) of a unit quaternion. */
function rotationVector(q: Quaternion, out: Vector3): Vector3 {
  const sign = q.w < 0 ? -1 : 1, w = Math.min(1, q.w * sign), s = Math.sqrt(Math.max(0, 1 - w * w));
  const angle = 2 * Math.atan2(s, w);
  if (s < 1e-9) return out.set(q.x * sign * 2, q.y * sign * 2, q.z * sign * 2);
  const k = angle / s * sign;
  return out.set(q.x * k, q.y * k, q.z * k);
}

export class FollowThrough {
  private readonly states: BoneState[];
  private tuning: FollowTuning | null = null;
  private gain = 0;
  private maxShown = 0;
  private cost = 0;

  constructor(readonly mesh: SkinnedMesh, excluded: ReadonlySet<number> = new Set()) {
    const bones = followBones(mesh, excluded), set = new Set(bones.map(entry => entry.bone));
    this.states = bones.map(entry => ({ ...entry, root: !(entry.bone.parent && set.has(entry.bone.parent as Bone)),
      x: new Vector3(), v: new Vector3(), prevQ: new Quaternion(), hasQ: false, prevW: new Vector3(), hasW: false,
      saved: new Quaternion(), written: new Quaternion(), applied: false, w: new Vector3() }));
  }

  get boneCount(): number { return this.states.length; }
  /** Nothing shown and nothing to fade: the layer touches no bone. */
  get idle(): boolean { return this.gain <= 0 && !this.tuning?.enabled; }

  /** New knobs take effect in place (the springs keep their state: no jump). null or disabled: fade out, then idle. */
  configure(tuning: FollowTuning | null | undefined): void {
    // Switched off: keep the last knobs for the fade-out, so what is shown eases away instead of vanishing.
    this.tuning = tuning ? structuredClone(tuning) : this.tuning ? { ...this.tuning, enabled: false } : null;
  }

  /** A hard cut of the pose (guard reset, preview, character change): forget the velocity history; what is shown eases back. */
  reset(): void { for (const s of this.states) { s.hasQ = false; s.hasW = false; } }

  /** Not on screen: clear everything (the next shown frame starts from the plain pose and fades in). */
  hide(): void {
    this.remove();
    this.gain = 0; this.maxShown = 0;
    for (const s of this.states) { s.x.set(0, 0, 0); s.v.set(0, 0, 0); s.hasQ = false; s.hasW = false; }
  }

  /** After the final pose (and the guard), before physics. `dt` in seconds. */
  apply(dt: number): void {
    const started = performance.now();
    this.remove(); // defensive: a frame that threw before its remove() never leaves an offset to pile up
    const on = this.tuning?.enabled === true;
    if (!on && this.gain <= 0) { this.maxShown = 0; return; }
    if (!Number.isFinite(dt) || dt < 0) return;
    if (dt > 0) this.gain = Math.min(1, Math.max(0, this.gain + (on ? dt : -dt) / FADE_SECONDS));
    if (dt > MAX_STEP_SECONDS) this.reset();
    const step = Math.min(dt, MAX_STEP_SECONDS);
    // Measure every bone first (a root reads its world turn, which includes its parents' pose), then write.
    for (const s of this.states) this.measure(s, step);
    let shown = 0;
    for (const s of this.states) {
      const region = this.tuning?.regions[s.region];
      if (region && step > 0) this.integrate(s, step, region.hz, region.damping, region.maxDeg * DEG);
      const max = (region?.maxDeg ?? 0) * DEG, length = s.x.length();
      if (max <= 0 || length < 1e-12 || this.gain <= 0) continue;
      const angle = this.gain * max * Math.tanh(length / max);
      shown = Math.max(shown, angle);
      s.saved.copy(s.bone.quaternion);
      q1.setFromAxisAngle(v1.copy(s.x).divideScalar(length), angle);
      s.bone.quaternion.premultiply(q1);
      s.written.copy(s.bone.quaternion); s.applied = true;
    }
    this.maxShown = shown / DEG;
    if (!on && this.gain <= 0) this.hide();
    this.cost = this.cost * 0.9 + (performance.now() - started) * 0.1;
  }

  /** Right after render (or at the start of the next frame): undo this frame's offsets, unless someone replaced the value since. */
  remove(): void {
    for (const s of this.states) {
      if (!s.applied) continue;
      if (s.bone.quaternion.equals(s.written)) s.bone.quaternion.copy(s.saved);
      s.applied = false;
    }
  }

  getState(): FollowState {
    return { active: !this.idle, gain: this.gain, bones: this.states.length, maxShownDeg: this.maxShown, avgMs: this.cost };
  }

  /** The shown angular velocity (parent frame) and its change since the last frame, as a velocity impulse on the spring. */
  private measure(s: BoneState, dt: number): void {
    const current = s.root ? s.bone.getWorldQuaternion(q2) : q2.copy(s.bone.quaternion);
    if (s.hasQ && dt > 0) {
      q1.copy(s.prevQ).invert().premultiply(current);
      rotationVector(q1, s.w).divideScalar(dt);
      if (s.root && s.bone.parent) s.w.applyQuaternion(s.bone.parent.getWorldQuaternion(q1).invert());
      if (!Number.isFinite(s.w.x + s.w.y + s.w.z) || s.w.length() > MAX_TURN_RATE) s.hasW = false; // a cut: no impulse from it
      else {
        if (s.hasW) {
          v1.copy(s.w).sub(s.prevW);
          const size = v1.length();
          if (size > MAX_IMPULSE) v1.multiplyScalar(MAX_IMPULSE / size);
          s.v.sub(v1);
        }
        s.prevW.copy(s.w); s.hasW = true;
      }
    }
    if (dt > 0 || !s.hasQ) { s.prevQ.copy(current); s.hasQ = true; }
  }

  private integrate(s: BoneState, dt: number, hz: number, damping: number, max: number): void {
    const omega = 2 * Math.PI * hz, k = omega * omega, c = 2 * damping * omega;
    const count = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-9)), h = dt / count;
    for (let i = 0; i < count; i++) {
      s.v.x += (-k * s.x.x - c * s.v.x) * h; s.v.y += (-k * s.x.y - c * s.v.y) * h; s.v.z += (-k * s.x.z - c * s.v.z) * h;
      s.x.addScaledVector(s.v, h);
    }
    // Keep the state near the soft limit so a long push never winds up (the shown value is already flat out there).
    const limit = Math.max(1e-6, 2 * max), length = s.x.length();
    if (max <= 0) { s.x.set(0, 0, 0); s.v.set(0, 0, 0); }
    else if (length > limit) {
      s.x.multiplyScalar(limit / length);
      const outward = s.v.dot(v1.copy(s.x).normalize());
      if (outward > 0) s.v.addScaledVector(v1, -outward);
    }
  }
}
