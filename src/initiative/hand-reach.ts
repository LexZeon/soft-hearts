/**
 * I-087 她的手伸向你的鼠标（docs/claude/2026-11-11-i087-hands.md）：一套伸手，三种用法（牵手张开手、拉钩伸小指、击掌抬手心）。
 *
 * 所以手跟鼠标走用和视线同一套平滑办法：
 *  - 鼠标位置按 100 毫秒一个关键点读（pointer-keys.ts：鼠标停着时速度稳定，动着时速度连续）；
 *  - 手的目标用临界阻尼跟过去（procedural.ts dampCritical：从静止起步、逐渐加速、到了不晃）；
 *  - 肩、肘、手腕一起分着转（两节手臂的解析 IK，肘往下、往外弯；肩膀在手抬高时跟着抬一点），身体最后跟（上半身的小转身和前倾，
 *    更低的阻尼，慢半拍）；
 *  - 够不着就不硬够：目标离肩膀的距离和方向都有软边界（伸到手臂长的 88% 为止，不伸到身后、不越过身体太多、不直直朝上）；
 *  - 伸出、收回是最小加加速度段（rps-performance.ts MinJerk：从当前位置、速度、加速度出发），中途掉头也平滑；
 *  - 手的样子走手指骨（有就用，没有就跳过）：张开的手、伸出小指、抬起的手心；握紧、回握是手指弯曲的平滑变化。
 *
 * 写法和递点心（give-performance.ts）、猜拳（rps-performance.ts）一样：一层程序 FK，写在动作混合和程序层之后、动作过渡和
 * 连续性护栏之前；每根骨先记下（port.remember），下一帧舞台还原；PMX / VMD 一个字节都不改。付与（grant）的子骨跟着走。
 * 骨：右臂（没有就左臂）的 腕、ひじ、手首、可选 手捩、肩；上半身；手指 親指0–2、人指/中指/薬指/小指 1–3（全角、半角数字都认）。
 */
import { Matrix4, Quaternion, Vector3, type Bone, type Camera, type SkinnedMesh } from 'three';
import type { LifeActivity } from '../stage';
import { dampCritical } from '../stage';
import { PointerKeys } from '../stage';
import { MinJerk, alignTwo } from './rps-performance';
import { PALM_TARGET, palmTargetRadius } from './touch-target';
import type { HandReading } from '../senses';
import type { HandStyle, HandUse } from '../../shared/behaviors/hands/knobs';
import { buildHandRig, gripRow, PALM, PINKY, RELAXED, type HandRig, type HandShapeFinger } from './hand-rig';
import { handShapeOf, type PerformerArmAim } from './arm-aim';

export type HandShape = 'open' | 'pinky' | 'palm';
export const HAND_SHAPE_OF: Readonly<Record<HandUse, HandShape>> = Object.freeze({ hold: 'open', pinky: 'pinky', 'high-five': 'palm' });
export type HandReachPhase = 'idle' | 'reach' | 'out' | 'held' | 'touch' | 'back';
export interface HandReachCue { readonly use: HandUse; readonly style: HandStyle }

export const HAND_REACH = Object.freeze({
  /** The hand's target follows the keyed pointer (rad/s): the gaze's head uses 10; sleepy she follows slower. */
  followOmega: 9, sleepyOmega: 4.5, followSoften: 2,
  /** Width of the reach's soft limits (direction components; distance as a share of the arm). */
  soft: 0.18,
  /** The body follows last (slower than the hand). */
  leanOmega: 3.2,
  /** Finger curls follow their target (rad/s). */
  fingerOmega: 11,
  /** Reach in / back: seconds for the whole way (scaled by the share still to go, and by her style). */
  armSeconds: 1.05, armMin: 0.45,
  /** Hesitant (shy, early days): she stops this far into the reach for this long, then comes the rest of the way. */
  hesitateAt: 0.45, hesitateS: 0.7,
  /** Reach limits, as shares of the arm's length (upper + forearm). */
  reachMin: 0.42, reachMax: 0.88,
  /** Her hand moves in a plane this far (share of the arm) in front of her shoulder, toward the camera. */
  planeAhead: 0.5,
  /** Body: at most this much turn toward your hand and lean forward (degrees, at full reach); the shoulder lifts with a high hand. */
  leanYawDeg: 7, leanPitchDeg: 3, shoulderLiftDeg: 8,
  /** Your hand counts as far away past this share of her reach (or at the window's edge). */
  farRatio: 1.45, edge: 0.985,
  /** A touch (pinky, high five): her hand meets yours, this share of the arm toward you, over these seconds (in, out). */
  touchPush: 0.1, touchIn: 0.22, touchOut: 0.4,
  /** A squeeze while holding: the fingers curl this much more and back, over this long. */
  squeezeDeg: 20, squeezeS: 0.6,
  /** Swinging hands (D high, while holding): a slow side-to-side of the target (window units, Hz). */
  swingAmp: 0.045, swingHz: 0.45,
  /** High five: the target is lifted by this share of the arm (lively adds up to liftLively more). */
  palmLift: 0.32, liftLively: 0.12,
  faceOmega: 7,
});

// ---------------------------------------------------------------- the face

type FaceValues = Required<Pick<LifeActivity, 'smileEyes' | 'mouthSmile' | 'lookUp' | 'headZ' | 'lidSoft'>>;
const FACE: Readonly<Record<'reach' | 'shy' | 'held' | 'touch' | 'fine', FaceValues>> = {
  reach: { smileEyes: 0.18, mouthSmile: 0.16, lookUp: 0.35, headZ: 0.012, lidSoft: 0.04 },
  shy: { smileEyes: 0.14, mouthSmile: 0.12, lookUp: 0.1, headZ: 0.03, lidSoft: 0.12 },
  held: { smileEyes: 0.38, mouthSmile: 0.3, lookUp: 0.4, headZ: 0.02, lidSoft: 0.08 },
  touch: { smileEyes: 0.45, mouthSmile: 0.42, lookUp: 0.55, headZ: 0.03, lidSoft: 0 },
  // Not taken, let go: a calm little smile; no pout, no hurt (user rule: no guilt).
  fine: { smileEyes: 0.1, mouthSmile: 0.1, lookUp: 0.2, headZ: 0, lidSoft: 0.04 },
};
const FACE_KEYS = ['smileEyes', 'mouthSmile', 'lookUp', 'headZ', 'lidSoft'] as const;
const NEUTRAL: LifeActivity = Object.freeze({ gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0,
  sway: 1, bodyZ: 0, blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 });

// ---------------------------------------------------------------- soft limits

/** A smooth max(x, low): equal to x well above low, to low well below, C¹ in between (width k). */
const softAbove = (x: number, low: number, k: number) => { const d = (x - low) / k; return d > 30 ? x : low + k * Math.log1p(Math.exp(d)); };
const softBelow = (x: number, high: number, k: number) => -softAbove(-x, -high, k);
const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x));

// ---------------------------------------------------------------- the layer

export interface HandReachPort { remember(bone: Bone): void }
export interface HandReachState {
  active: boolean; phase: HandReachPhase; use: HandUse | null; presence: number; arrived: boolean; far: boolean;
  /** How far your hand is, as a share of her reach (1 = just at the limit). */
  reachRatio: number; arm: boolean; fingers: number; side: string | null;
}

export class HandReach {
  private cueValue: HandReachCue | null = null;
  private phaseValue: HandReachPhase = 'idle';
  private readonly presence = new MinJerk();
  private readonly faceWeight = new MinJerk();
  private readonly touchPulse = new MinJerk();
  private readonly squeezePulse = new MinJerk();
  private readonly swingWeight = new MinJerk();
  private readonly gripWeight = new MinJerk();
  private hesitate: 'no' | 'first' | 'pause' | 'done' = 'no';
  private pauseClock = 0;
  private touchClock = 0;
  private squeezeClock = 0;
  private clock = 0;
  private dt = 0;
  private rig: HandRig | null = null;
  private rigOwner: SkinnedMesh | null = null;
  private readonly keys = new PointerKeys();
  private reading: HandReading | null = null;
  /** The followed target in window units and its own speed (critically damped). */
  private readonly follow = { x: 0, y: 0 };
  private readonly followV = { x: 0, y: 0 };
  private followStarted = false;
  /** Body follows last: yaw, pitch (rad) and the shoulder lift, each with its own speed. */
  private readonly lean = { yaw: 0, pitch: 0, lift: 0 };
  private readonly leanV = { yaw: 0, pitch: 0, lift: 0 };
  private readonly leanGoal = { yaw: 0, pitch: 0, lift: 0 };
  private ratio = 0;
  private farValue = false;
  private faceKind: keyof typeof FACE = 'reach';
  private readonly faceValues: FaceValues = { ...FACE.fine, smileEyes: 0, mouthSmile: 0, lookUp: 0 };
  private readonly faceSpeed: Record<string, number> = {};
  private readonly activityOut: LifeActivity = { ...NEUTRAL };
  private readonly base = new Map<Bone, Quaternion>();
  private readonly baseSet = new Set<Bone>();
  private readonly q1 = new Quaternion(); private readonly q2 = new Quaternion(); private readonly q3 = new Quaternion(); private readonly q4 = new Quaternion();
  private readonly v = Array.from({ length: 14 }, () => new Vector3());
  private readonly sv = Array.from({ length: 6 }, () => new Vector3());
  /** alignTwo's own scratch (it overwrites all six). */
  private readonly as = Array.from({ length: 6 }, () => new Vector3());
  private readonly m1 = new Matrix4(); private readonly m2 = new Matrix4();
  private readonly anchorPoint = new Vector3();
  private anchorKnown = false;

  get active(): boolean {
    return this.phaseValue !== 'idle' || this.presence.x > 1e-4 || this.faceWeight.x > 1e-4;
  }
  get phase(): HandReachPhase { return this.phaseValue; }

  /** She reaches out (a new offer). One already out turns into this one from where it is (smoothly). */
  start(cue: HandReachCue): void {
    this.cueValue = { use: cue.use, style: { ...cue.style } };
    this.phaseValue = 'reach';
    this.hesitate = cue.style.hesitant ? 'first' : 'no'; this.pauseClock = 0;
    this.touchPulse.snap(this.touchPulse.x); this.squeezePulse.snap(this.squeezePulse.x);
    this.gripWeight.to(0, 0.4); this.swingWeight.to(0, 0.6);
    this.faceKind = cue.style.hesitant ? 'shy' : 'reach';
    this.faceWeight.to(1, 0.6);
    this.planReach();
  }

  /** Holding (a click on her hand while she offers to hold): her fingers close around yours; her hand keeps following. */
  hold(): void {
    if (this.phaseValue !== 'reach' && this.phaseValue !== 'out') return;
    const style = this.cueValue?.style;
    this.phaseValue = 'held';
    if (this.presence.goal !== 1 || this.hesitate === 'first' || this.hesitate === 'pause') { this.hesitate = 'done'; this.presence.to(1, this.armSeconds(1)); }
    this.gripWeight.to(1, 0.45);
    if ((style?.swing ?? 0) > 0) this.swingWeight.to(1, 1.6);
    this.faceKind = 'held';
  }

  /** The touch of a pinky promise or a high five: her hand meets yours and comes back a little. */
  touch(): void {
    if (this.phaseValue !== 'reach' && this.phaseValue !== 'out') return;
    this.phaseValue = 'touch'; this.touchClock = 0;
    if (this.presence.goal !== 1 || this.hesitate === 'first' || this.hesitate === 'pause') { this.hesitate = 'done'; this.presence.to(1, this.armSeconds(1)); }
    this.touchPulse.to(1, HAND_REACH.touchIn);
    this.faceKind = 'touch';
  }

  /** A gentle squeeze while holding: a finger-curl pulse. */
  squeeze(): void {
    if (this.phaseValue !== 'held') return;
    this.squeezeClock = 0;
    this.squeezePulse.to(1, HAND_REACH.squeezeS / 2);
  }

  /** She takes her hand back (not taken, let go, interrupted, after a touch). */
  release(): void {
    if (this.phaseValue === 'idle' || this.phaseValue === 'back') return;
    this.phaseValue = 'back'; this.hesitate = 'done';
    this.presence.to(0, this.armSeconds(this.presence.x));
    this.gripWeight.to(0, 0.5); this.swingWeight.to(0, 0.5);
    if (this.touchPulse.goal !== 0) this.touchPulse.to(0, HAND_REACH.touchOut);
    if (this.squeezePulse.goal !== 0) this.squeezePulse.to(0, HAND_REACH.squeezeS / 2);
    this.faceKind = 'fine'; this.faceWeight.to(0, 1.4);
  }

  private planReach(): void {
    const goal = this.hesitate === 'first' ? HAND_REACH.hesitateAt : 1;
    this.presence.to(goal, this.armSeconds(Math.abs(goal - this.presence.x)));
  }

  private armSeconds(share: number): number {
    const style = this.cueValue?.style;
    const speed = style?.sleepy ? 0.75 : style?.hesitant ? 0.85 : 1 + 0.25 * (style?.lively ?? 0);
    return Math.max(HAND_REACH.armMin, HAND_REACH.armSeconds * Math.sqrt(clamp(share, 0, 1)) / speed);
  }

  /** One display frame: clocks, the reach's segments and "where your hand is" (window units, or null). Call before applyPose. */
  frame(delta: number, owner: SkinnedMesh | null, reading: HandReading | null): void {
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    this.dt = dt; this.clock += dt;
    if (owner !== this.rigOwner) {
      // Another model (or none): nothing of the old one is carried over; a reach on the old model simply ends.
      const replaced = this.rigOwner !== null;
      this.rigOwner = owner; this.rig = null; this.base.clear(); this.baseSet.clear();
      this.presence.snap(0); this.faceWeight.snap(0); this.touchPulse.snap(0); this.squeezePulse.snap(0); this.swingWeight.snap(0); this.gripWeight.snap(0);
      if (replaced) { this.phaseValue = 'idle'; this.cueValue = null; } else if (this.cueValue) this.planReach();
      this.followStarted = false; this.keys.reset();
      for (const k of ['yaw', 'pitch', 'lift'] as const) { this.lean[k] = this.leanV[k] = this.leanGoal[k] = 0; }
    }
    if (this.cueValue && !this.rig && owner) this.rig = buildHandRig(owner);
    // The 100 ms readings become keyframes; while nothing is known the keys hold their last shown value.
    this.reading = reading ? this.keys.frame(dt, reading.x, reading.y) : null;
    if (!reading) this.keys.reset();
    if (this.phaseValue === 'reach') {
      if (this.hesitate === 'first' && !this.presence.moving) { this.hesitate = 'pause'; this.pauseClock = 0; }
      else if (this.hesitate === 'pause') { this.pauseClock += dt; if (this.pauseClock >= HAND_REACH.hesitateS) { this.hesitate = 'done'; this.presence.to(1, this.armSeconds(1 - this.presence.x)); } }
      else if (!this.presence.moving && this.presence.x > 0.999) this.phaseValue = 'out';
    } else if (this.phaseValue === 'touch') {
      this.touchClock += dt;
      if (this.touchPulse.goal === 1 && !this.touchPulse.moving) this.touchPulse.to(0, HAND_REACH.touchOut);
    } else if (this.phaseValue === 'held') {
      this.squeezeClock += dt;
      if (this.squeezePulse.goal === 1 && !this.squeezePulse.moving) this.squeezePulse.to(0, HAND_REACH.squeezeS / 2);
    } else if (this.phaseValue === 'back') {
      if (this.presence.x < 1e-4 && !this.presence.moving) { this.phaseValue = 'idle'; this.cueValue = null; }
    }
    this.presence.step(dt); this.faceWeight.step(dt); this.touchPulse.step(dt); this.squeezePulse.step(dt); this.swingWeight.step(dt); this.gripWeight.step(dt);
    this.updateFace(dt);
    if (this.presence.x < 1e-5 && this.phaseValue === 'idle') this.followStarted = false;
  }

  private updateFace(dt: number): void {
    const target = FACE[this.faceKind], omega = HAND_REACH.faceOmega;
    for (const key of FACE_KEYS) {
      const x = this.faceValues[key], v = this.faceSpeed[key] ?? 0, e = x - target[key], decay = Math.exp(-omega * dt), carry = v + omega * e;
      this.faceSpeed[key] = (v - omega * carry * dt) * decay;
      this.faceValues[key] = target[key] + (e + carry * dt) * decay;
    }
  }

  /** Her face during the reach, blended over her own activity by the face weight (her gaze keeps following the mouse). */
  activity(base: LifeActivity | null): LifeActivity | null {
    const w = this.faceWeight.x;
    if (!(w > 1e-4)) return base;
    const from = base ?? NEUTRAL, out = this.activityOut, f = this.faceValues;
    Object.assign(out, from);
    const mix = (a: number, b: number) => a + (b - a) * w;
    out.smileEyes = mix(from.smileEyes, Math.max(from.smileEyes, f.smileEyes)); out.mouthSmile = mix(from.mouthSmile, Math.max(from.mouthSmile, f.mouthSmile));
    out.lookUp = mix(from.lookUp, f.lookUp); out.headZ = mix(from.headZ, f.headZ); out.lidSoft = mix(from.lidSoft, f.lidSoft);
    return out;
  }

  /**
   * Writes the body lean, the shoulder, the arm and the fingers (program layer: every bone remembered first, restored by the stage
   * next frame). `camera` turns "where your hand is" into a point in front of her.
   */
  applyPose(port: HandReachPort, camera: Camera | null): void {
    const w = this.presence.x, rig = this.rig;
    this.anchorKnown = false;
    if (!(w > 1e-5) || !rig || rig.owner !== this.rigOwner) return;
    this.baseSet.clear();
    this.stepLean();
    if (rig.body) {
      const parentQ = rig.body.parent ? rig.body.parent.getWorldQuaternion(this.q1) : this.q1.identity();
      const chestQ = rig.chest.getWorldQuaternion(this.q2);
      const up = this.v[0].copy(rig.up).applyQuaternion(chestQ), fwd = this.v[1].copy(rig.fwd).applyQuaternion(chestQ);
      const tilt = this.v[2].crossVectors(up, fwd).normalize();
      const world = this.q3.setFromAxisAngle(up, this.lean.yaw * w).multiply(this.q4.setFromAxisAngle(tilt, this.lean.pitch * w));
      // world-space turn → the bone's local: parent⁻¹ · R · parent · local
      const local = this.q4.copy(parentQ).invert().multiply(world).multiply(parentQ).multiply(rig.body.quaternion);
      this.write(port, rig.body, local, 1);
    }
    if (!rig.upper || !rig.elbow || !rig.wrist) { this.writeFingers(port, w); this.writeGrants(port); return; }
    if (rig.shoulder && Math.abs(this.lean.lift) > 1e-6) {
      const parentQ = rig.shoulder.parent ? rig.shoulder.parent.getWorldQuaternion(this.q1) : this.q1.identity();
      const chestQ = rig.chest.getWorldQuaternion(this.q2);
      const axis = this.v[0].copy(rig.out).cross(rig.up).applyQuaternion(chestQ).normalize();
      const world = this.q3.setFromAxisAngle(axis, this.lean.lift * w);
      this.write(port, rig.shoulder, this.q4.copy(parentQ).invert().multiply(world).multiply(parentQ).multiply(rig.shoulder.quaternion), 1);
    }
    const { U, K, F, H, P, chestQ } = this.solveArm(rig, rig.upper, camera);
    // 5. Write: chest frame → world → each bone's local, weighted by presence.
    U.applyQuaternion(chestQ); K.applyQuaternion(chestQ); F.applyQuaternion(chestQ); H.applyQuaternion(chestQ); P.applyQuaternion(chestQ);
    const { upper, elbow, wrist } = rig;
    const upperParent = upper.parent ? upper.parent.getWorldQuaternion(this.q3) : this.q3.identity();
    this.write(port, upper, upperParent.invert().multiply(alignTwo(rig.restUpper, rig.restHinge, U, K, this.q4, this.m1, this.m2, this.as)), w);
    const elbowParent = elbow.parent ? elbow.parent.getWorldQuaternion(this.q3) : this.q3.identity();
    const local = this.v[0].copy(F).applyQuaternion(elbowParent.invert());
    this.write(port, elbow, this.q4.setFromUnitVectors(rig.restFore, local.normalize()), w);
    const handWorld = alignTwo(rig.restHand, rig.restPalm, H, P, this.q1, this.m1, this.m2, this.as);
    if (rig.twist) {
      const relative = elbow.getWorldQuaternion(this.q3).invert().multiply(handWorld);
      const axis = rig.restFore, dot = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
      const twist = this.q4.set(axis.x * dot, axis.y * dot, axis.z * dot, relative.w);
      if (twist.lengthSq() < 1e-9) twist.identity(); else twist.normalize();
      this.write(port, rig.twist, twist, w);
      this.write(port, wrist, this.q2.copy(twist).invert().multiply(relative), w);
    } else {
      const wristParent = wrist.parent ? wrist.parent.getWorldQuaternion(this.q3) : this.q3.identity();
      this.write(port, wrist, wristParent.invert().multiply(handWorld), w);
    }
    this.writeFingers(port, w);
    this.writeGrants(port);
    this.measureAnchor();
  }

  /**
   * I-154 batch 4 (arm-aim.ts): the arm applyPose would write, as a design for the window engine's arm reach (it writes no bone): the
   * body's lean and the hand's follow step on as in applyPose (read the lean with `leanShown`), the arm is solved from the pose the
   * bones have now, the fingers' shape is this frame's. Null while down or without an arm. Then call `measureAnchor` after the frame.
   */
  armAim(camera: Camera | null): PerformerArmAim | null {
    const w = this.presence.x, rig = this.rig;
    this.anchorKnown = false;
    if (!(w > 1e-5) || !rig || rig.owner !== this.rigOwner || !rig.upper || !rig.elbow || !rig.wrist) return null;
    this.stepLean();
    const { U, F, H, P } = this.solveArm(rig, rig.upper, camera);
    this.stepFingers();
    const rows: Record<HandShapeFinger, [number, number][]> = { thumb: [[0, 0], [0, 0], [0, 0]], index: [[0, 0], [0, 0], [0, 0]], middle: [[0, 0], [0, 0], [0, 0]], ring: [[0, 0], [0, 0], [0, 0]], little: [[0, 0], [0, 0], [0, 0]] };
    for (const joint of rig.joints) rows[joint.finger][Math.min(joint.index, 2)] = [joint.c, joint.s];
    return { side: rig.side, weight: w, upper: U.clone(), fore: F.clone(), hand: H.clone(), palm: P.clone(), fingers: rig.joints.length ? handShapeOf(rows) : null };
  }
  /** The body's lean as applyPose turns her by it (rad: a turn toward your hand about her up axis, a lean forward), scaled by presence. */
  get leanShown(): { yaw: number; pitch: number } { const w = this.presence.x; return w > 1e-5 ? { yaw: this.lean.yaw * w, pitch: this.lean.pitch * w } : { yaw: 0, pitch: 0 }; }
  /** Where her palm is now (the click target's centre, PALM_TARGET.centreAt of the hand from the wrist). After her pose is final. */
  measureAnchor(): void {
    const rig = this.rig, wrist = rig?.wrist;
    if (!rig || !wrist || rig.owner !== this.rigOwner || !(this.presence.x > 1e-5)) { this.anchorKnown = false; return; }
    const handDir = this.v[1].copy(rig.restHand).applyQuaternion(wrist.getWorldQuaternion(this.q1));
    wrist.getWorldPosition(this.anchorPoint).addScaledVector(handDir, rig.handLength * PALM_TARGET.centreAt);
    this.anchorKnown = true;
  }

  /** 1. The body follows last: last frame's goals, critically damped (slower than the hand); applied scaled by presence. */
  private stepLean(): void {
    for (const k of ['yaw', 'pitch', 'lift'] as const) this.lean[k] = dampCritical(this.lean[k], this.leanGoal[k], HAND_REACH.leanOmega, this.dt, this.leanV, k);
  }

  /** 2–4: where your hand is, followed; the arm in her chest frame (shared scratch vectors, valid until the next call). */
  private solveArm(rig: HandRig, upperBone: Bone, camera: Camera | null) {
    const cue = this.cueValue, dt = this.dt;
    // 2. Where your hand is → a point in front of her (her shoulder's plane, toward the camera), followed critically damped.
    const chestQ = rig.chest.getWorldQuaternion(this.q2), chestInv = this.q3.copy(chestQ).invert();
    const S = upperBone.getWorldPosition(this.v[3]);
    const L = rig.upperLength + rig.foreLength;
    const fwdW = this.v[4].copy(rig.fwd).applyQuaternion(chestQ), upW = this.v[5].copy(rig.up).applyQuaternion(chestQ), outW = this.v[6].copy(rig.out).applyQuaternion(chestQ);
    const toward = this.v[7];
    const camPos = camera ? camera.getWorldPosition(this.v[8]) : null;
    if (camPos) { toward.copy(camPos).sub(S); toward.y = 0; if (toward.lengthSq() < 1e-9) toward.copy(fwdW); toward.normalize(); } else toward.copy(fwdW);
    const planePoint = this.v[9].copy(S).addScaledVector(toward, HAND_REACH.planeAhead * L);
    // Her own reach when there is no reading (or no camera): forward, a little out and down; the high five a little up.
    const use = cue?.use ?? 'hold', shape = HAND_SHAPE_OF[use];
    const rest = this.v[10].copy(fwdW).multiplyScalar(0.8).addScaledVector(outW, 0.28).addScaledVector(upW, shape === 'palm' ? 0.35 : -0.12).normalize()
      .multiplyScalar(0.72 * L).add(S);
    let goalX: number, goalY: number;
    const reading = this.reading;
    if (reading && camera) { goalX = reading.x; goalY = reading.y; }
    else if (camera) { const p = this.v[11].copy(rest).project(camera); goalX = Number.isFinite(p.x) ? p.x : 0; goalY = Number.isFinite(p.y) ? p.y : 0; }
    else { goalX = 0; goalY = 0; }
    if (!this.followStarted) { this.follow.x = goalX; this.follow.y = goalY; this.followV.x = this.followV.y = 0; this.followStarted = true; }
    const swing = this.swingWeight.x * (cue?.style.swing ?? 0);
    if (swing > 1e-4) goalX += swing * HAND_REACH.swingAmp * Math.sin(this.clock * Math.PI * 2 * HAND_REACH.swingHz);
    // A far jump of the cursor is a longer way for an arm than for the eyes: the spring softens with the distance still to go, so
    // a big move stays an unhurried reach (its top speed stays bounded) and a small one is followed as briskly as the gaze.
    const omega = (cue?.style.sleepy ? HAND_REACH.sleepyOmega : HAND_REACH.followOmega) / (1 + HAND_REACH.followSoften * Math.hypot(goalX - this.follow.x, goalY - this.follow.y));
    this.follow.x = dampCritical(this.follow.x, goalX, omega, dt, this.followV, 'x');
    this.follow.y = dampCritical(this.follow.y, goalY, omega, dt, this.followV, 'y');
    const target = this.v[11];
    if (camera) {
      // Ray from the camera through the followed point, met with the plane (normal = toward the camera).
      const origin = this.v[12].copy(camPos!), dir = this.v[13].set(this.follow.x, this.follow.y, 0.5).unproject(camera).sub(origin).normalize();
      const denom = dir.dot(toward);
      const t = Math.abs(denom) > 1e-6 ? (planePoint.dot(toward) - origin.dot(toward)) / denom : -1;
      if (t > 0) target.copy(origin).addScaledVector(dir, t); else target.copy(rest);
    } else target.copy(rest);
    // 3. Into her chest frame, relative to the shoulder; the reach's soft limits.
    const t = target.sub(S).applyQuaternion(chestInv);
    if (shape === 'palm') t.addScaledVector(rig.up, (HAND_REACH.palmLift + HAND_REACH.liftLively * (cue?.style.lively ?? 0)) * L);
    const raw = t.length();
    const edge = !!reading && (Math.abs(reading.x) >= HAND_REACH.edge || Math.abs(reading.y) >= HAND_REACH.edge);
    this.ratio = raw / (HAND_REACH.reachMax * L);
    this.farValue = edge || this.ratio > HAND_REACH.farRatio;
    const dirN = raw > 1e-9 ? this.sv[0].copy(t).divideScalar(raw) : this.sv[0].copy(rig.fwd);
    let f = dirN.dot(rig.fwd), u = dirN.dot(rig.up), o = dirN.dot(rig.out);
    const k = HAND_REACH.soft;
    f = softAbove(f, 0.22, k); o = softAbove(o, -0.3, k); u = softBelow(u, 0.82, k);
    const dir = this.sv[1].copy(rig.fwd).multiplyScalar(f).addScaledVector(rig.up, u).addScaledVector(rig.out, o).normalize();
    const reachScale = cue?.style.sleepy ? 0.9 : 1;
    let d = softBelow(softAbove(raw, HAND_REACH.reachMin * L, 0.06 * L), HAND_REACH.reachMax * reachScale * L, 0.06 * L);
    // A touch: her hand meets yours, a little further toward you (still not overstretched: the elbow stays bent).
    const push = this.touchPulse.x * HAND_REACH.touchPush * L;
    const tgt = this.sv[2].copy(dir).multiplyScalar(d);
    if (push > 0) { tgt.addScaledVector(this.sv[3].copy(toward).applyQuaternion(chestInv), push); d = Math.min(tgt.length(), 0.93 * L); tgt.setLength(d); }
    // Body goals for next frame: turn toward your hand, lean a little with the reach; the shoulder lifts with a high hand.
    const azimuth = Math.atan2(tgt.dot(rig.out), Math.max(1e-6, tgt.dot(rig.fwd))) - Math.atan2(0.28, 0.8);
    const side = rig.side === 'right' ? -1 : 1;
    this.leanGoal.yaw = clamp(azimuth * 0.35, -1, 1) * HAND_REACH.leanYawDeg * Math.PI / 180 * side;
    this.leanGoal.pitch = clamp(d / L, 0, 1) * HAND_REACH.leanPitchDeg * Math.PI / 180;
    this.leanGoal.lift = clamp(dir.dot(rig.up) + 0.1, 0, 1) * HAND_REACH.shoulderLiftDeg * Math.PI / 180;
    // 4. Two-bone IK in the chest frame: the elbow bends down and out (never straight: the reach stops at 88%).
    const L1 = rig.upperLength, L2 = rig.foreLength;
    const pole = this.sv[3].copy(rig.up).multiplyScalar(-0.7).addScaledVector(rig.out, 0.55).addScaledVector(rig.fwd, -0.45);
    const perp = pole.addScaledVector(dir, -pole.dot(dir));
    if (perp.lengthSq() < 1e-8) perp.copy(rig.up).multiplyScalar(-1).addScaledVector(dir, dir.y);
    perp.normalize();
    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const U = this.sv[4].copy(dir).multiplyScalar(cosA).addScaledVector(perp, sinA).normalize();
    const F = this.sv[5].copy(tgt).addScaledVector(U, -L1).normalize();
    const K = this.v[12].crossVectors(U, F).normalize();
    const solve = this.lastSolve; solve.fx = this.follow.x; solve.fy = this.follow.y; solve.raw = raw / L; solve.d = d / L;
    // Hand direction and palm by use.
    const H = this.v[13], P = this.v[10];
    if (shape === 'palm') { H.copy(rig.up).multiplyScalar(0.85).addScaledVector(F, 0.45).normalize(); P.copy(rig.fwd).addScaledVector(rig.out, 0.1).normalize(); }
    else if (shape === 'pinky') { H.copy(F).addScaledVector(rig.up, 0.25).addScaledVector(rig.fwd, 0.15).normalize(); P.copy(rig.out).multiplyScalar(-0.7).addScaledVector(rig.up, -0.5).normalize(); }
    else { H.copy(F).addScaledVector(rig.fwd, 0.25).addScaledVector(rig.up, -0.05).normalize(); P.copy(rig.out).multiplyScalar(-0.8).addScaledVector(rig.up, -0.35).addScaledVector(rig.fwd, 0.1).normalize(); }
    return { U, K, F, H, P, chestQ };
  }

  private writeFingers(port: HandReachPort, w: number): void {
    const rig = this.rig;
    if (!rig?.joints.length) return;
    this.stepFingers();
    for (const joint of rig.joints) {
      const q = this.q1.setFromAxisAngle(joint.spread, joint.s * Math.PI / 180).multiply(this.q2.setFromAxisAngle(joint.curl, joint.c * Math.PI / 180));
      this.write(port, joint.bone, q, w);
    }
  }

  /** The fingers follow this frame's shape (critically damped per joint). */
  private stepFingers(): void {
    const rig = this.rig, cue = this.cueValue;
    if (!rig?.joints.length) return;
    const shape = HAND_SHAPE_OF[cue?.use ?? 'hold'], grip = (cue?.style.grip ?? 0.6) * this.gripWeight.x, squeeze = this.squeezePulse.x * HAND_REACH.squeezeDeg;
    const omega = HAND_REACH.fingerOmega, dt = this.dt;
    for (const joint of rig.joints) {
      const j = Math.min(joint.index, 2);
      let [c, s] = shape === 'pinky' ? PINKY[joint.finger][j] : shape === 'palm' ? PALM[joint.finger][j] : RELAXED[joint.finger][j];
      if (shape === 'open' && grip > 0) {
        const [gc, gs] = gripRow(joint.finger, j, cue?.style.grip ?? 0.6), k = this.gripWeight.x;
        c += (gc - c) * k; s += (gs - s) * k;
        if (joint.finger !== 'thumb') c += squeeze;
      }
      joint.c = dampCritical(joint.c, c, omega, dt, joint.v, 'c');
      joint.s = dampCritical(joint.s, s, omega, dt, joint.v, 's');
    }
  }

  private writeGrants(port: HandReachPort): void {
    const rig = this.rig;
    if (!rig) return;
    for (const grant of rig.grants) {
      const before = this.baseSet.has(grant.parent) ? this.base.get(grant.parent) : undefined;
      if (!before) continue;
      port.remember(grant.child);
      const old = this.q2.identity().slerp(before, grant.ratio).invert(), now = this.q3.identity().slerp(grant.parent.quaternion, grant.ratio);
      grant.child.quaternion.multiply(old).multiply(now);
    }
  }

  private write(port: HandReachPort, bone: Bone, target: Quaternion, weight: number): void {
    port.remember(bone);
    if (!this.baseSet.has(bone)) {
      let saved = this.base.get(bone);
      if (!saved) this.base.set(bone, saved = new Quaternion());
      saved.copy(bone.quaternion); this.baseSet.add(bone);
    }
    bone.quaternion.slerp(target, Math.min(1, Math.max(0, weight)));
  }

  /** Where her hand is on screen (the click target), or null while it is not out far enough to take. */
  anchor(camera: Camera | null, width: number, height: number): { x: number; y: number; r: number } | null {
    if (!camera || !this.anchorKnown || !(this.presence.x > 0.6) || this.phaseValue === 'idle' || this.phaseValue === 'back') return null;
    const center = this.sv[0].copy(this.anchorPoint), edge = this.sv[1].copy(this.anchorPoint);
    edge.y += this.rig?.handLength ?? 1; // the hand's length, upright, measured on screen
    center.project(camera); edge.project(camera);
    if (![center.x, center.y, edge.y].every(Number.isFinite) || center.z < -1 || center.z > 1) return null;
    return { x: (center.x + 1) * width / 2, y: (1 - center.y) * height / 2, r: palmTargetRadius(Math.abs(edge.y - center.y) * height / 2, width, height) };
  }

  /** Is your hand (window units) within her reach (or a little past it)? For "the mouse rests near her". */
  near(reading: HandReading | null, camera: Camera | null, owner: SkinnedMesh | null): boolean {
    if (!reading || !camera || !owner || Math.abs(reading.x) >= HAND_REACH.edge || Math.abs(reading.y) >= HAND_REACH.edge) return false;
    const rig = this.rig && this.rig.owner === owner ? this.rig : (this.rig = this.rigOwner === owner ? buildHandRig(owner) : null);
    if (!rig?.upper) return false;
    const S = rig.upper.getWorldPosition(this.v[3]), p = this.v[4].copy(S).project(camera);
    const L = rig.upperLength + rig.foreLength, reachEnd = this.v[5].copy(S).addScaledVector(this.v[6].copy(rig.out).applyQuaternion(rig.chest.getWorldQuaternion(this.q1)), L).project(camera);
    const reachNdc = Math.hypot(reachEnd.x - p.x, (reachEnd.y - p.y));
    return Math.hypot(reading.x - p.x, reading.y - p.y) <= reachNdc * 1.1;
  }

  getState(): HandReachState {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return { active: this.active, phase: this.phaseValue, use: this.cueValue?.use ?? null, presence: round(this.presence.x),
      arrived: this.phaseValue === 'out' || ((this.phaseValue === 'held' || this.phaseValue === 'touch') && this.presence.x > 0.999),
      far: this.farValue, reachRatio: round(this.ratio), arm: !!this.rig?.upper, fingers: this.rig?.joints.length ?? 0, side: this.rig?.side ?? null };
  }

  /** Test seam. */
  rigForTest(): HandRig | null { return this.rig; }
  /** Test seam: the last frame's solve (window point followed, distances as shares of the arm, the clamped direction). */
  readonly lastSolve = { fx: 0, fy: 0, raw: 0, d: 0 };
}
