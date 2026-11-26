/**
 * I-136 Unbound v1 step 5b「拉她」, the body (docs/claude/2026-11-18-unbound-step5-plan.md「5b」; record docs/claude/2026-11-18-unbound-step5.md).
 *
 * An additive layer on top of the final pose, like the hands and the give (one FK write per bone, remembered so the stage restores
 * it next frame; no PMX / VMD byte changes). The grabbed point has a spring target that follows the mouse with caps:
 *   - hand, arm: the upper arm swings toward the pull (≤ armSwingMaxDeg) and the elbow straightens (≤ armExtend); the rest of the
 *     force goes to the upper body (leanShareArm of the lean);
 *   - body (shoulder, chest, belly, hips, skirt): the waist and up lean toward the pull (≤ leanMaxDeg), the lower body and the feet
 *     do not move (they are siblings of 上半身, never written);
 *   - head (face, hair): head and neck turn a little (≤ headMaxDeg), the upper body shares (leanShareHead);
 *   - leg, foot (the companion): the knee swings about the hip–ankle line (≤ kneeMaxDeg) and the ankle keeps its world rotation, so the
 *     foot stays exactly where the leg IK put it; the upper body bends a little toward it (leanShareFoot).
 * Every amount is the cap × ease(how hard), where how hard = the pull's distance / (fullPull × her height), so a farther drag never
 * looks bigger, only harder. Only the part of the pull across the lever turns anything (pulling along an arm does not stretch it).
 *
 * Continuity (R29: never snap): two critically damped stages, the mouse → the pull (followOmega), then each output → what is shown
 * (settleOmega); so a press, a release, a cancel or a target that jumps all start and stop with continuous speed. A hard cut (the
 * window hid, the model changed) clears at once, as every layer does (the guard then has nothing to bridge).
 */
import { Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import { standardBoneOfName, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import { PULL_KNOBS, type PullKnobs } from '../../../shared/behaviors/pull/knobs';
import type { PullGroup } from '../../../shared/behaviors/pull/session';

type Side = 'left' | 'right';
export interface PullArm { upper: Bone; elbow: Bone | null }
export interface PullLeg { thigh: Bone; knee: Bone; ankle: Bone }
export interface PullRig {
  mesh: SkinnedMesh;
  upper: Bone; upper2: Bone | null; neck: Bone | null; head: Bone | null;
  arms: Record<Side, PullArm | null>;
  legs: Record<Side, PullLeg | null>;
}

/** The bones by their standard names (any model whose names the profile knows); null without an upper body (nothing to lean). */
/** `legs: false` (Unbound: the gait and its leg IK own her legs): no leg chains, a pull on a leg only leans her. */
export function buildPullRig(mesh: SkinnedMesh, options: { legs?: boolean } = {}): PullRig | null {
  const found = new Map<StandardBone, Bone>();
  for (const bone of mesh.skeleton.bones) { const slot = standardBoneOfName(bone.name); if (slot && !found.has(slot)) found.set(slot, bone); }
  const upper = found.get('upperBody') ?? found.get('upperBody2');
  if (!upper) return null;
  const arm = (side: 'Left' | 'Right'): PullArm | null => { const u = found.get(`arm${side}`); return u ? { upper: u, elbow: found.get(`elbow${side}`) ?? null } : null; };
  const leg = (side: 'Left' | 'Right'): PullLeg | null => {
    const thigh = found.get(`leg${side}`), knee = found.get(`knee${side}`), ankle = found.get(`ankle${side}`);
    return thigh && knee && ankle ? { thigh, knee, ankle } : null;
  };
  return { mesh, upper, upper2: upper !== found.get('upperBody2') ? found.get('upperBody2') ?? null : null, neck: found.get('neck') ?? null,
    head: found.get('head') ?? null, arms: { left: arm('Left'), right: arm('Right') },
    legs: options.legs === false ? { left: null, right: null } : { left: leg('Left'), right: leg('Right') } };
}

/** How she takes it (5e: from her mood numbers and character; 1, 1, 0 = plain). */
export interface PullStance {
  /** Multiplies every cap (≤ 1: she gives less; never above 1, the caps stay hard). */
  compliance: number;
  /** Multiplies how fast she follows (sleepy: slower). */
  pace: number;
}
export const PLAIN_STANCE: PullStance = Object.freeze({ compliance: 1, pace: 1 });

export interface PullLayerPort { remember(bone: Bone): void }

export interface PullGrabTarget { group: PullGroup; side: Side | null; bone: Bone; local: Vector3 }

export interface PullLayerState {
  grabbed: boolean; group: PullGroup | null; side: Side | null;
  strength: number; leanDeg: number; headDeg: number; armDeg: number; extend: number; kneeDeg: number;
}

const DEG = Math.PI / 180;
/** The elbow straightens slower than the rest settles: its swing is the largest (a bent elbow can open 60° and more). */
const EXTEND_PACE = 0.6;
const ease = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * (2 - v); };

/** Closed-form critically damped step for one number (as src/stage/procedural.ts dampCritical, with the velocity alongside). */
function damp(value: number, velocity: number, target: number, omega: number, dt: number): [number, number] {
  const error = value - target, decay = Math.exp(-omega * dt), carry = velocity + omega * error;
  return [target + (error + carry * dt) * decay, (velocity - omega * carry * dt) * decay];
}
class Spring3 {
  readonly x = new Vector3(); readonly v = new Vector3();
  step(target: Vector3, omega: number, dt: number): Vector3 {
    [this.x.x, this.v.x] = damp(this.x.x, this.v.x, target.x, omega, dt);
    [this.x.y, this.v.y] = damp(this.x.y, this.v.y, target.y, omega, dt);
    [this.x.z, this.v.z] = damp(this.x.z, this.v.z, target.z, omega, dt);
    return this.x;
  }
  /** Settled to within 1e-4 of `scale` (rad for the turns, her pull length for the pull): too small to see. */
  quiet(scale = 1): boolean { return this.x.lengthSq() < 1e-8 * scale * scale && this.v.lengthSq() < 1e-6 * scale * scale; }
  zero(): void { this.x.set(0, 0, 0); this.v.set(0, 0, 0); }
}
class Spring1 {
  x = 0; v = 0;
  step(target: number, omega: number, dt: number): number { [this.x, this.v] = damp(this.x, this.v, target, omega, dt); return this.x; }
  quiet(tolerance = 1e-4): boolean { return Math.abs(this.x) < tolerance && Math.abs(this.v) < 10 * tolerance; }
  zero(): void { this.x = 0; this.v = 0; }
}

const v1 = new Vector3(), v2 = new Vector3(), v3 = new Vector3(), q1 = new Quaternion(), q2 = new Quaternion(), q3 = new Quaternion(), q4 = new Quaternion(), IDENTITY = new Quaternion();

export class PullLayer {
  private grabTarget: PullGrabTarget | null = null;
  private cursor: Vector3 | null = null;
  private readonly lastPoint = new Vector3();
  private hasPoint = false;
  private readonly pull = new Spring3();
  private readonly lean = new Spring3();
  private readonly turn = new Spring3();
  private readonly arm: Record<Side, Spring3> = { left: new Spring3(), right: new Spring3() };
  private readonly extend: Record<Side, Spring1> = { left: new Spring1(), right: new Spring1() };
  private readonly knee: Record<Side, Spring1> = { left: new Spring1(), right: new Spring1() };
  private stance: PullStance = PLAIN_STANCE;
  /** A full pull in model units (the last apply), the pull spring's scale for "settled". */
  private scale = 1;
  private shown: PullLayerState = { grabbed: false, group: null, side: null, strength: 0, leanDeg: 0, headDeg: 0, armDeg: 0, extend: 0, kneeDeg: 0 };

  constructor(readonly rig: PullRig, private knobs: PullKnobs = PULL_KNOBS) {}

  /** A pull began on this bone (the point in its own space). The layer goes on from what it shows now: no jump. */
  grab(target: PullGrabTarget): void { this.grabTarget = { ...target, local: target.local.clone() }; this.cursor = null; this.hasPoint = false; }
  /** Where the mouse is now (world, on the plane through the grabbed point); null keeps the last. */
  aim(cursor: Vector3 | null): void { if (cursor && Number.isFinite(cursor.x + cursor.y + cursor.z)) (this.cursor ??= new Vector3()).copy(cursor); }
  /** Released, cancelled or slipped free: everything eases back from what is shown. */
  release(): void { this.grabTarget = null; this.cursor = null; }
  setStance(stance: PullStance | null): void {
    this.stance = { compliance: clamp(stance?.compliance ?? 1, 0, 1), pace: clamp(stance?.pace ?? 1, 0.3, 1.5) };
  }
  configure(knobs: PullKnobs): void { this.knobs = knobs; }
  /** A hard cut (hidden, the model changed): nothing left to show. */
  reset(): void {
    this.release(); this.hasPoint = false;
    for (const spring of [this.pull, this.lean, this.turn, this.arm.left, this.arm.right]) spring.zero();
    for (const spring of [this.extend.left, this.extend.right, this.knee.left, this.knee.right]) spring.zero();
    this.shown = { ...this.shown, grabbed: false, group: null, side: null, strength: 0, leanDeg: 0, headDeg: 0, armDeg: 0, extend: 0, kneeDeg: 0 };
  }
  get grabbed(): boolean { return this.grabTarget !== null; }
  /** Grabbed, or still easing back: the stage's other writers hold off new gestures meanwhile. */
  get engaged(): boolean {
    return this.grabTarget !== null || !(this.pull.quiet(this.scale) && this.lean.quiet() && this.turn.quiet() && this.arm.left.quiet() && this.arm.right.quiet()
      && this.extend.left.quiet(1e-3) && this.extend.right.quiet(1e-3) && this.knee.left.quiet() && this.knee.right.quiet());
  }
  getState(): PullLayerState { return { ...this.shown }; }
  /** The grabbed point now (world), for the gaze, Unbound's follow and the jelly; null when nothing is held. */
  point(out: Vector3): Vector3 | null { return this.grabTarget && this.hasPoint ? out.copy(this.lastPoint) : null; }
  /** The pull as it is shown now (world, smoothed; zero when released and settled). */
  shownPull(out: Vector3): Vector3 { return out.copy(this.pull.x); }

  /** After every other writer of the pose, before the motion bridge and the guard. `height`: her height (model units). */
  apply(port: PullLayerPort, dt: number, height: number): void {
    if (!this.engaged || !(height > 0)) return;
    const step = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    const rig = this.rig, k = this.knobs, grab = this.grabTarget, full = Math.max(1e-6, k.fullPull * height);
    this.scale = full;
    rig.upper.updateWorldMatrix(true, true);
    for (const leg of [rig.legs.left, rig.legs.right]) leg?.thigh.updateWorldMatrix(true, true);
    // 1. The grabbed point as the pose before this layer carries it, and the pull toward the mouse (at most a full pull).
    if (grab) { this.lastPoint.copy(grab.local).applyMatrix4(grab.bone.matrixWorld); this.hasPoint = true; }
    const target = v1.set(0, 0, 0);
    if (grab && this.cursor) { target.copy(this.cursor).sub(this.lastPoint); if (target.length() > full) target.setLength(full); }
    const pace = this.stance.pace, comp = this.stance.compliance;
    const pull = this.pull.step(target, k.followOmega * pace, step);
    // 2. What each group wants (zero for the groups not grabbed: they ease back).
    const group = grab?.group ?? this.shown.group, side = grab?.side ?? this.shown.side;
    const leanShare = group === 'torso' ? 1 : group === 'arm' ? k.leanShareArm : group === 'head' ? k.leanShareHead : group === 'leg' ? k.leanShareFoot : 0;
    const leanTarget = this.hasPoint ? this.across(rig.upper, pull, full, k.leanMaxDeg * leanShare * comp, v2) : v2.set(0, 0, 0);
    const lean = this.lean.step(leanTarget, k.settleOmega * pace, step);
    const turnTarget = group === 'head' && this.hasPoint ? this.across(rig.neck ?? rig.head ?? rig.upper, pull, full, k.headMaxDeg * comp, v2) : v2.set(0, 0, 0);
    const turn = this.turn.step(turnTarget, k.settleOmega * pace, step);
    const strength = pull.length() / full;
    let armDeg = 0, extendShown = 0, kneeDeg = 0;
    // 3. Write, from the trunk out (each child's pivot after its parent moved).
    this.rotateWorld(port, rig.upper, lean, rig.upper2 ? 0.6 : 1);
    if (rig.upper2) this.rotateWorld(port, rig.upper2, lean, 0.4);
    if (rig.neck) this.rotateWorld(port, rig.neck, turn, rig.head ? 0.4 : 1);
    if (rig.head) this.rotateWorld(port, rig.head, turn, rig.neck ? 0.6 : 1);
    for (const s of ['left', 'right'] as const) {
      const chain = rig.arms[s], mine = group === 'arm' && side === s && this.hasPoint && !!chain;
      const swing = this.arm[s].step(mine ? this.across(chain!.upper, pull, full, k.armSwingMaxDeg * comp, v2) : v2.set(0, 0, 0), k.settleOmega * pace, step);
      const extend = this.extend[s].step(mine ? k.armExtend * comp * ease(strength) : 0, EXTEND_PACE * k.settleOmega * pace, step);
      if (chain) {
        this.rotateWorld(port, chain.upper, swing, 1);
        if (chain.elbow && extend > 1e-6) { port.remember(chain.elbow); chain.elbow.quaternion.slerp(IDENTITY, Math.min(1, extend)); chain.elbow.updateMatrixWorld(true); }
      }
      armDeg = Math.max(armDeg, swing.length() / DEG); extendShown = Math.max(extendShown, extend);
      const leg = rig.legs[s], wantKnee = group === 'leg' && side === s && this.hasPoint && !!leg;
      const knee = this.knee[s].step(wantKnee ? this.kneeTarget(leg!, pull, full, k.kneeMaxDeg * DEG * comp) : 0, k.settleOmega * pace, step);
      if (leg && Math.abs(knee) > 1e-7) this.swingKnee(port, leg, knee);
      kneeDeg = Math.max(kneeDeg, Math.abs(knee) / DEG);
    }
    this.shown = { grabbed: !!grab, group: this.engaged ? group : null, side: this.engaged ? side : null, strength: Math.min(1, strength),
      leanDeg: lean.length() / DEG, headDeg: turn.length() / DEG, armDeg, extend: extendShown, kneeDeg };
    if (!this.engaged) this.reset(); // settled: below what shows (≤ 0.006°); start the next one clean
  }

  /**
   * The rotation (world axis × angle) that turns the lever pivot → grabbed point toward the pull, as cap × ease(the pull across the
   * lever / full). Continuous everywhere: as the across part goes to zero, so does the angle.
   */
  private across(pivotBone: Bone, pull: Vector3, full: number, capDeg: number, out: Vector3): Vector3 {
    const lever = v3.setFromMatrixPosition(pivotBone.matrixWorld).negate().add(this.lastPoint);
    const length = lever.length();
    if (!(length > 1e-9) || !(capDeg > 0)) return out.set(0, 0, 0);
    lever.divideScalar(length);
    const across = out.copy(pull).addScaledVector(lever, -pull.dot(lever)), size = across.length();
    if (!(size > 1e-9)) return out.set(0, 0, 0);
    const angle = capDeg * DEG * ease(size / full);
    return out.crossVectors(lever, across).setLength(angle);
  }

  /** The knee's swing (signed, rad) about the hip–ankle line toward the pull. */
  private kneeTarget(leg: PullLeg, pull: Vector3, full: number, cap: number): number {
    const hip = v2.setFromMatrixPosition(leg.thigh.matrixWorld), axis = v3.setFromMatrixPosition(leg.ankle.matrixWorld).sub(hip);
    if (!(axis.length() > 1e-9)) return 0;
    axis.normalize();
    const out = new Vector3().setFromMatrixPosition(leg.knee.matrixWorld).sub(hip);
    out.addScaledVector(axis, -out.dot(axis));
    if (!(out.length() > 1e-9)) return 0;
    const sweep = new Vector3().crossVectors(axis, out.normalize());
    const m = sweep.dot(pull) / full;
    return Math.sign(m) * cap * ease(Math.abs(m));
  }

  private swingKnee(port: PullLayerPort, leg: PullLeg, angle: number): void {
    const ankleWorld = leg.ankle.getWorldQuaternion(q4);
    const hip = new Vector3().setFromMatrixPosition(leg.thigh.matrixWorld), axis = new Vector3().setFromMatrixPosition(leg.ankle.matrixWorld).sub(hip);
    if (!(axis.length() > 1e-9)) return;
    this.rotateWorld(port, leg.thigh, axis.setLength(angle), 1);
    // The ankle keeps its world rotation (its position is on the swing's axis): the foot does not move.
    port.remember(leg.ankle);
    const parent = leg.ankle.parent!.getWorldQuaternion(q1);
    leg.ankle.quaternion.copy(parent.invert().multiply(ankleWorld));
    leg.ankle.updateMatrixWorld(true);
  }

  /** bone.local ← parent⁻¹ · R · parent · bone.local, R = rotation by `vector × share` (world axis-angle). */
  private rotateWorld(port: PullLayerPort, bone: Bone, vector: Vector3, share: number): void {
    const angle = vector.length() * share;
    if (!(angle > 1e-9)) return;
    port.remember(bone);
    const parent = bone.parent ? bone.parent.getWorldQuaternion(q1) : q1.identity();
    const r = q2.setFromAxisAngle(v3.copy(vector).divideScalar(vector.length()), angle);
    const inverse = q3.copy(parent).invert();
    bone.quaternion.premultiply(parent).premultiply(r).premultiply(inverse);
    bone.updateMatrixWorld(true);
  }
}

const clamp = (value: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
