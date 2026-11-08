/**
 * G1 和她玩猜拳, stage side (docs/claude/2026-11-03-rps.md): her raised hand, the "石头——剪刀——布！" strokes,
 * a procedural hand shape on any MMD model, and her face, from the host's view (shared/rps.ts RpsView).
 *
 * Motion rules (R29, how-we-work 「做事方式」 2): one program FK layer written after the mixer and the procedural
 * layers, before motionTransition and the continuity guard; every bone is remembered and restored by the stage
 * each frame. Nothing jumps:
 *  - Presence (arm up / arm down) follows minimum-jerk segments that start from the current value, speed and
 *    acceleration, so an interruption turns around smoothly. Duration from the pose difference and a peak
 *    angular acceleration (RPS_MOTION.armAccel), 0.45–1.6 s.
 *  - The count strokes are smooth pulses of the forearm about the elbow hinge (zero speed at both ends).
 *  - Hand shapes change by minimum-jerk weights (zero speed and acceleration at both ends; an interrupted change turns round
 *    from the blend shown, at its speed).
 *  - The face is an eased LifeActivity (procedural-life.ts) that the R36 continuous expression smooths again.
 * Bones: the right arm (else the left): 腕, ひじ, 手首, optional 手捩 (twist), fingers 親指0–2 and 人指/中指/薬指/小指
 * 1–3 (full- or half-width digits). No fingers: the arm alone. No arm: only the face. Grant children (付与, e.g.
 * 腕捩連, 手捩連) follow the written bones by delta. The raised hand is kept clear of the body's capsules
 * (shared/collision-proxy.ts; a shoulder-width capsule without a proxy).
 */
import { Matrix4, Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import type { LifeActivity } from './procedural-life';
import { rpsRevealAfterMs, RPS_TIMING, type RpsFace, type RpsHand, type RpsView } from '../../shared/rps';
import type { CollisionProxy } from '../../shared/collision-proxy';

export type RpsStagePhase = 'ready' | 'count' | 'wait' | 'reveal' | 'end' | 'idle';
export interface RpsStageCue {
  /** Changes with every phase (and round): a new key restarts the phase clock. */
  key: string;
  phase: RpsStagePhase;
  leadMs: number;
  beatMs: number;
  /** How far into the phase the view already was (a pet reload mid-phase). */
  elapsedMs: number;
  /** Her revealed hand (null: the counting fist). */
  hand: RpsHand | null;
  /**
   * A pretend cheat: the hand she pretends she showed. The host sets it only while she says it (her words come a moment
   * after the reveal) and clears it when she owns up; never before RPS_MOTION.teaseAt into the reveal.
   */
  tease: RpsHand | null;
  face: RpsFace;
}
/** The host's view as the stage needs it; invitations and asides do not raise the arm. */
export function rpsStageCue(view: RpsView | null | undefined): RpsStageCue | null {
  if (!view || view.phase === 'invite' || view.phase === 'aside') return null;
  return { key: `${view.id}:${view.round}:${view.phase}`, phase: view.phase, leadMs: RPS_TIMING.leadMs, beatMs: view.beatMs, elapsedMs: view.elapsedMs,
    hand: view.revealed?.hand ?? null, tease: view.tease, face: view.face };
}

export const RPS_MOTION = Object.freeze({
  /** Peak angular acceleration of the arm while it comes up or goes down (°/s²), and the duration bounds (s). */
  armAccel: 300, armMin: 0.45, armMax: 1.6,
  /** Count stroke: forearm swing (rad) and the half-width of each pulse (s). */
  strokeAmp: 0.24, strokeHalf: 0.28,
  /**
   * Hand shape change: its duration from the largest finger-joint turn and this peak angular acceleration (°/s²), within the
   * bounds (s). Pretrial 2026-11-03: a fixed 0.42 s (about 3100°/s² for Gene's 95° curl) was caught by the display guard at
   * 30 fps when a frame came late at the reveal; at 1500°/s² Gene's fist opens in about 0.6 s, continuous at 30 fps with a
   * dropped frame. The pretend cheat starts once the real hand is shown (s into the reveal).
   */
  fingerAccel: 1500, shapeMin: 0.3, shapeMax: 0.8, teaseAt: 0.65,
  /** Face spring (rad/s). */
  faceOmega: 9,
});

export interface RpsPort { remember(bone: Bone): void }

// ---------------------------------------------------------------- shapes

type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
const FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'little'];
const FINGER_NAMES: Readonly<Record<Finger, string>> = { thumb: '親指', index: '人指', middle: '中指', ring: '薬指', little: '小指' };
type Shape = RpsHand;
/** Per finger, per joint: [curl, spread] in degrees (curl toward the palm; spread toward the index side). */
type ShapeTable = Readonly<Record<Finger, readonly (readonly [number, number])[]>>;
const FIST_FINGER: readonly (readonly [number, number])[] = [[80, 0], [95, 0], [65, 0]];
const FIST_THUMB: readonly (readonly [number, number])[] = [[18, -28], [35, 0], [45, 0]];
const SHAPES: Readonly<Record<RpsHand, ShapeTable>> = {
  rock: { thumb: FIST_THUMB, index: FIST_FINGER, middle: FIST_FINGER, ring: FIST_FINGER, little: FIST_FINGER },
  scissors: { thumb: FIST_THUMB, index: [[0, 9], [4, 0], [4, 0]], middle: [[0, -9], [4, 0], [4, 0]], ring: FIST_FINGER, little: FIST_FINGER },
  paper: { thumb: [[0, 14], [6, 0], [6, 0]], index: [[2, 6], [4, 0], [3, 0]], middle: [[2, 0], [4, 0], [3, 0]], ring: [[2, -4], [4, 0], [3, 0]], little: [[2, -9], [4, 0], [3, 0]] },
};

// ---------------------------------------------------------------- the rig

interface Joint { bone: Bone; curl: Vector3; spread: Vector3; targets: Record<RpsHand, Quaternion> }
interface Grant { child: Bone; parent: Bone; ratio: number }
export interface RpsRig {
  owner: SkinnedMesh;
  side: 'right' | 'left';
  chest: Bone;
  upper: Bone | null;
  elbow: Bone | null;
  twist: Bone | null;
  wrist: Bone | null;
  joints: Joint[];
  grants: Grant[];
  /** Rest-space directions. */
  restUpper: Vector3; restFore: Vector3; restHand: Vector3; restPalm: Vector3; restHinge: Vector3;
  /** Designed pose (rest frame of the chest), after the body clearance check. */
  design: { upper: Vector3; fore: Vector3; hand: Vector3; palm: Vector3; hinge: Vector3 };
  /** The smallest clearance (model units) of the forearm and hand from the body capsules over the stroke range, and how far it was pushed (rad). */
  clearance: number;
  pushed: number;
  fingers: number;
  /** The designed joints in rest space (diagnostics and tests). */
  points: { shoulder: Vector3; elbow: Vector3; wrist: Vector3; tip: Vector3 } | null;
}

const ZERO = new Vector3();
const digits = (n: number) => [String(n), String.fromCharCode(0xff10 + n)];
function findBone(bones: readonly Bone[], names: readonly string[]): Bone | null {
  for (const name of names) { const bone = bones.find(b => b.name === name); if (bone) return bone; }
  return null;
}

/** Rest (bind) position of a bone in the mesh's rest space; MMD bones have no rest rotation. */
function restPositions(mesh: SkinnedMesh): Map<Bone, Vector3> {
  const out = new Map<Bone, Vector3>(), matrix = new Matrix4();
  mesh.skeleton.bones.forEach((bone, i) => {
    const inverse = mesh.skeleton.boneInverses[i];
    if (inverse) out.set(bone, new Vector3().setFromMatrixPosition(matrix.copy(inverse).invert()));
  });
  return out;
}

const horizontal = (v: Vector3) => { const out = v.clone(); out.y = 0; return out.lengthSq() > 1e-12 ? out.normalize() : out; };

/** Closest distance between segments p1-q1 and p2-q2. */
export function segmentDistance(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
  if (a <= 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1.dot(d2), denom = a * e - b * b;
      s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}

interface Capsule { a: Vector3; b: Vector3; radius: number }
function bodyCapsules(proxy: CollisionProxy | null | undefined, rest: Map<Bone, Vector3>, bones: readonly Bone[], shoulderWidth: number): Capsule[] {
  const torso = proxy?.capsules.filter(c => ['pelvis', 'abdomen', 'chest', 'neck', 'head'].includes(c.segment)) ?? [];
  if (torso.length) return torso.map(c => ({ a: new Vector3(...c.a), b: new Vector3(...c.b), radius: c.radius }));
  // No proxy: the old approximation (motion-fit): hips to neck, 0.27 shoulder widths, plus a head sphere.
  const hips = findBone(bones, ['下半身', '腰', 'センター']), neck = findBone(bones, ['首']), head = findBone(bones, ['頭']);
  const out: Capsule[] = [];
  if (hips && neck && rest.get(hips) && rest.get(neck)) out.push({ a: rest.get(hips)!.clone(), b: rest.get(neck)!.clone(), radius: 0.27 * shoulderWidth });
  if (head && rest.get(head)) out.push({ a: rest.get(head)!.clone(), b: rest.get(head)!.clone(), radius: 0.35 * shoulderWidth });
  return out;
}

/** Rotation that maps a1 → b1 and a2 (orthogonalised) → b2. Also the wave back of P1 (pose-reaction-stage.ts). */
export function alignTwo(a1: Vector3, a2: Vector3, b1: Vector3, b2: Vector3, out: Quaternion, m1: Matrix4, m2: Matrix4, s: Vector3[]): Quaternion {
  const [x1, y1, z1, x2, y2, z2] = s;
  x1.copy(a1).normalize(); z1.crossVectors(x1, a2).normalize(); y1.crossVectors(z1, x1);
  x2.copy(b1).normalize(); z2.crossVectors(x2, b2).normalize(); y2.crossVectors(z2, x2);
  if (z1.lengthSq() < 0.5 || z2.lengthSq() < 0.5) return out.setFromUnitVectors(x1, x2);
  m1.makeBasis(x1, y1, z1); m2.makeBasis(x2, y2, z2);
  return out.setFromRotationMatrix(m2.multiply(m1.transpose()));
}

export function buildRpsRig(mesh: SkinnedMesh, proxy?: CollisionProxy | null): RpsRig | null {
  const bones = mesh.skeleton?.bones ?? [];
  const chest = findBone(bones, ['上半身2', '上半身', 'spine', 'Spine', 'Chest']);
  if (!chest) return null;
  const rest = restPositions(mesh);
  const pick = (prefix: string) => ({ upper: findBone(bones, [`${prefix}腕`]), elbow: findBone(bones, [`${prefix}ひじ`]), wrist: findBone(bones, [`${prefix}手首`]) });
  let side: 'right' | 'left' = 'right', arm = pick('右');
  if (!arm.upper || !arm.elbow || !arm.wrist) { const left = pick('左'); if (left.upper && left.elbow && left.wrist) { side = 'left'; arm = left; } }
  const prefix = side === 'right' ? '右' : '左', other = side === 'right' ? '左' : '右';
  const at = (bone: Bone | null) => bone ? rest.get(bone) ?? null : null;
  const up = new Vector3(0, 1, 0);
  const head = findBone(bones, ['頭']), eyes = [findBone(bones, ['左目']), findBone(bones, ['右目'])].filter((b): b is Bone => !!b && !!rest.get(b));
  let fwd = new Vector3(0, 0, 1);
  if (head && at(head) && eyes.length) {
    const mid = eyes.reduce((sum, eye) => sum.add(rest.get(eye)!), new Vector3()).divideScalar(eyes.length);
    const candidate = horizontal(mid.sub(at(head)!));
    if (candidate.lengthSq() > 0.5) fwd = candidate;
  }
  const otherUpper = findBone(bones, [`${other}腕`]);
  let out = side === 'right' ? fwd.clone().cross(up) : up.clone().cross(fwd);
  if (arm.upper && otherUpper && at(arm.upper) && at(otherUpper)) { const c = horizontal(at(arm.upper)!.clone().sub(at(otherUpper)!)); if (c.lengthSq() > 0.5) out = c; }
  const shoulderWidth = arm.upper && otherUpper && at(arm.upper) && at(otherUpper) ? at(arm.upper)!.distanceTo(at(otherUpper)!) : 1;
  const twist = findBone(bones, [`${prefix}手捩`]);
  const rig: RpsRig = { owner: mesh, side, chest, upper: arm.upper, elbow: arm.elbow, twist: twist && arm.wrist?.parent === twist && twist.parent === arm.elbow ? twist : null, wrist: arm.wrist,
    joints: [], grants: [], restUpper: new Vector3(), restFore: new Vector3(), restHand: new Vector3(), restPalm: new Vector3(), restHinge: new Vector3(),
    design: { upper: new Vector3(), fore: new Vector3(), hand: new Vector3(), palm: new Vector3(), hinge: new Vector3() }, clearance: Infinity, pushed: 0, fingers: 0, points: null };
  if (!arm.upper || !arm.elbow || !arm.wrist || !at(arm.upper) || !at(arm.elbow) || !at(arm.wrist)) { rig.upper = rig.elbow = rig.wrist = rig.twist = null; return rig; }
  const A = at(arm.upper)!, E = at(arm.elbow)!, W = at(arm.wrist)!;
  const L1 = A.distanceTo(E), L2 = E.distanceTo(W);
  rig.restUpper.subVectors(E, A).normalize(); rig.restFore.subVectors(W, E).normalize();
  // Fingers and the hand's own frame.
  const finger = (f: Finger, n: number) => findBone(bones, digits(n).map(d => `${prefix}${FINGER_NAMES[f]}${d}`));
  const tip = (f: Finger) => findBone(bones, [`${prefix}${FINGER_NAMES[f]}先`]);
  const middle1 = finger('middle', 1), index1 = finger('index', 1), little1 = finger('little', 1);
  const handEnd = at(middle1) ?? at(findBone(bones, [`${prefix}手先`]));
  rig.restHand.copy(handEnd ? handEnd.clone().sub(W) : rig.restFore).normalize();
  const across = at(index1) && at(little1) ? at(index1)!.clone().sub(at(little1)!) : fwd.clone();
  rig.restPalm.crossVectors(across, rig.restHand).normalize();
  if (rig.restPalm.lengthSq() < 0.5) rig.restPalm.copy(up).multiplyScalar(-1);
  if (rig.restPalm.y > 0) rig.restPalm.negate(); // palms face down in an A or T pose
  const flex = fwd.clone().addScaledVector(rig.restUpper, -fwd.dot(rig.restUpper)).normalize();
  rig.restHinge.crossVectors(rig.restUpper, flex).normalize();
  const handLength = handEnd ? Math.max(handEnd.distanceTo(W) * 2, 0.3 * L2) : 0.4 * L2;
  // Fingers: a curl axis per joint (toward the palm) and a spread axis (within the palm plane).
  const acrossDir = across.clone().normalize(), q1 = new Quaternion(), q2 = new Quaternion();
  for (const f of FINGERS) {
    const numbers = f === 'thumb' ? [0, 1, 2] : [1, 2, 3];
    const chain = numbers.map(n => finger(f, n)).filter((b): b is Bone => !!b && !!rest.get(b));
    if (!chain.length) continue;
    rig.fingers++;
    chain.forEach((bone, j) => {
      const next = chain[j + 1] ?? tip(f), from = rest.get(bone)!, to = next ? rest.get(next) : null;
      const dir = to && to.distanceTo(from) > 1e-6 ? to.clone().sub(from).normalize()
        : j > 0 ? from.clone().sub(rest.get(chain[j - 1])!).normalize() : rig.restHand.clone();
      // The thumb curls toward the palm and across toward the little finger.
      const curl = dir.clone().cross(rig.restPalm).normalize(), spread = dir.clone().cross(acrossDir).normalize();
      if (curl.lengthSq() < 0.5 || spread.lengthSq() < 0.5) return;
      const shape = (hand: RpsHand) => {
        const [c, s] = SHAPES[hand][f][Math.min(j, 2)];
        q1.setFromAxisAngle(curl, c * Math.PI / 180); q2.setFromAxisAngle(spread, s * Math.PI / 180);
        return q2.clone().multiply(q1);
      };
      rig.joints.push({ bone, curl, spread, targets: { rock: shape('rock'), scissors: shape('scissors'), paper: shape('paper') } });
    });
  }
  // Grant children of what this layer writes (rotation, non-local), in the helper's order.
  const written = new Set<Bone>([arm.upper, arm.elbow, arm.wrist, ...(rig.twist ? [rig.twist] : []), ...rig.joints.map(joint => joint.bone)]);
  const grants = (mesh.geometry?.userData?.MMD?.grants ?? []) as { index: number; parentIndex: number; ratio: number; affectRotation: boolean; isLocal: boolean }[];
  for (const grant of grants) {
    const child = bones[grant.index], parent = bones[grant.parentIndex];
    if (child && parent && grant.affectRotation && !grant.isLocal && written.has(parent) && !written.has(child) && Number.isFinite(grant.ratio))
      rig.grants.push({ child, parent, ratio: grant.ratio });
  }
  designPose(rig, { up, fwd, out, A, L1, L2, handLength, capsules: bodyCapsules(proxy, rest, bones, shoulderWidth), margin: 0.08 * L1 });
  return rig;
}

/** The raised-hand pose in the chest's rest frame, pushed outward until the forearm and hand clear the body over the whole stroke. */
function designPose(rig: RpsRig, input: { up: Vector3; fwd: Vector3; out: Vector3; A: Vector3; L1: number; L2: number; handLength: number; capsules: Capsule[]; margin: number }): void {
  const { up, fwd, out, A, L1, L2, handLength, capsules, margin } = input;
  const sign = Math.sign(up.clone().cross(fwd).dot(out)) || 1, turn = new Quaternion();
  const u0 = new Vector3().addScaledVector(up, -0.82).addScaledVector(out, 0.4).addScaledVector(fwd, 0.4).normalize();
  const f0 = new Vector3().addScaledVector(up, 0.8).addScaledVector(fwd, 0.5).addScaledVector(out, 0.12).normalize();
  const h0 = new Vector3().addScaledVector(up, 0.95).addScaledVector(fwd, 0.2).normalize();
  const clearance = (u: Vector3, f: Vector3, h: Vector3) => {
    const hinge = u.clone().cross(f.clone().addScaledVector(u, -f.dot(u))).normalize();
    let least = Infinity;
    for (const stroke of [0, -RPS_MOTION.strokeAmp]) {
      const q = new Quaternion().setFromAxisAngle(hinge, stroke);
      const E = A.clone().addScaledVector(u, L1), W = E.clone().addScaledVector(f.clone().applyQuaternion(q), L2), T = W.clone().addScaledVector(h.clone().applyQuaternion(q), handLength);
      for (const c of capsules) least = Math.min(least, segmentDistance(E, W, c.a, c.b) - c.radius, segmentDistance(W, T, c.a, c.b) - c.radius);
    }
    return least;
  };
  let pushed = 0, u = u0.clone(), f = f0.clone(), h = h0.clone(), clear = clearance(u, f, h);
  for (let step = 1; step <= 12 && clear < margin; step++) {
    pushed = step * 4 * Math.PI / 180;
    // About the vertical: positive turns forward toward up × fwd; `sign` makes it turn toward her own side.
    turn.setFromAxisAngle(up, sign * pushed);
    u = u0.clone().applyQuaternion(turn); f = f0.clone().applyQuaternion(turn); h = h0.clone().applyQuaternion(turn);
    clear = clearance(u, f, h);
  }
  rig.design.upper.copy(u); rig.design.fore.copy(f); rig.design.hand.copy(h);
  rig.design.palm.copy(fwd).addScaledVector(h, -fwd.dot(h)).normalize();
  rig.design.hinge.copy(u).cross(f.clone().addScaledVector(u, -f.dot(u))).normalize();
  rig.clearance = clear; rig.pushed = pushed;
  const E = A.clone().addScaledVector(u, L1), W = E.clone().addScaledVector(f, L2);
  rig.points = { shoulder: A.clone(), elbow: E, wrist: W, tip: W.clone().addScaledVector(h, handLength) };
}

// ---------------------------------------------------------------- timing curves

/** A minimum-jerk segment from (x, v, a) to (target, 0, 0) over T seconds; continuous in position, speed and acceleration. */
export class MinJerk {
  x = 0; v = 0; a = 0;
  private c = [0, 0, 0, 0, 0, 0]; private t = 0; private T = 0; private target = 0;
  get goal(): number { return this.target; }
  get moving(): boolean { return this.t < this.T; }
  to(target: number, seconds: number): void {
    const T = Math.max(1e-3, seconds), p0 = this.x, v0 = this.v, a0 = this.a, d = target - p0;
    this.c = [p0, v0, a0 / 2,
      (20 * d - 12 * v0 * T - 3 * a0 * T * T) / (2 * T ** 3),
      (-30 * d + 16 * v0 * T + 3 * a0 * T * T) / (2 * T ** 4),
      (12 * d - 6 * v0 * T - a0 * T * T) / (2 * T ** 5)];
    this.t = 0; this.T = T; this.target = target;
  }
  step(dt: number): number {
    if (this.t >= this.T) { this.x = this.target; this.v = 0; this.a = 0; return this.x; }
    this.t = Math.min(this.T, this.t + dt);
    const t = this.t, c = this.c;
    this.x = c[0] + c[1] * t + c[2] * t * t + c[3] * t ** 3 + c[4] * t ** 4 + c[5] * t ** 5;
    this.v = c[1] + 2 * c[2] * t + 3 * c[3] * t * t + 4 * c[4] * t ** 3 + 5 * c[5] * t ** 4;
    this.a = 2 * c[2] + 6 * c[3] * t + 12 * c[4] * t * t + 20 * c[5] * t ** 3;
    if (this.t >= this.T) { this.x = this.target; this.v = 0; this.a = 0; }
    return this.x;
  }
  snap(value: number): void { this.x = this.target = value; this.v = this.a = 0; this.t = this.T = 0; }
  static at(value: number): MinJerk { const segment = new MinJerk(); segment.snap(value); return segment; }
  /** The largest |acceleration| a segment from the current state to `target` over `seconds` would reach (sampled). */
  peakAcceleration(target: number, seconds: number): number {
    const T = Math.max(1e-3, seconds), v0 = this.v, a0 = this.a, d = target - this.x;
    const c3 = (20 * d - 12 * v0 * T - 3 * a0 * T * T) / (2 * T ** 3), c4 = (-30 * d + 16 * v0 * T + 3 * a0 * T * T) / (2 * T ** 4), c5 = (12 * d - 6 * v0 * T - a0 * T * T) / (2 * T ** 5);
    let peak = 0;
    for (let k = 0; k <= 16; k++) { const t = T * k / 16; peak = Math.max(peak, Math.abs(a0 + 6 * c3 * t + 12 * c4 * t * t + 20 * c5 * t ** 3)); }
    return peak;
  }
}
const SHAPE_NAMES: readonly Shape[] = ['rock', 'scissors', 'paper'];
/** The joint's rotation for a weighted blend of the three shapes (normalized sum in one hemisphere; the weights sum to 1). */
function blendShapes(targets: Record<Shape, Quaternion>, rock: number, scissors: number, paper: number, out: Quaternion): Quaternion {
  const r = targets.rock, sc = targets.scissors, p = targets.paper;
  const s1 = r.dot(sc) < 0 ? -scissors : scissors, s2 = r.dot(p) < 0 ? -paper : paper;
  out.set(r.x * rock + sc.x * s1 + p.x * s2, r.y * rock + sc.y * s1 + p.y * s2, r.z * rock + sc.z * s1 + p.z * s2, r.w * rock + sc.w * s1 + p.w * s2);
  return out.lengthSq() > 1e-12 ? out.normalize() : out.copy(r);
}
/** One count stroke: a smooth pulse peaking at 0 (C¹, zero speed at both ends), width 2 × half. */
const pulse = (t: number, half: number) => { const x = t / half; return Math.abs(x) >= 1 ? 0 : (1 - x * x) ** 2; };

// ---------------------------------------------------------------- the face

type FaceValues = Required<Pick<LifeActivity, 'lookUp' | 'smileEyes' | 'mouthSmile' | 'lidSoft' | 'headZ' | 'gazeY'>> & { sad: number; angry: number };
const FACE_KEYS = ['lookUp', 'smileEyes', 'mouthSmile', 'lidSoft', 'headZ', 'gazeY', 'sad', 'angry'] as const;
const face = (values: Partial<FaceValues>): FaceValues => ({ lookUp: 0, smileEyes: 0, mouthSmile: 0, lidSoft: 0, headZ: 0, gazeY: 0, sad: 0, angry: 0, ...values });
export const RPS_FACE_TABLE: Readonly<Record<RpsFace, FaceValues>> = Object.freeze({
  neutral: face({ lookUp: 0.5 }),
  nervous: face({ lookUp: 0.55, sad: 0.12, mouthSmile: 0.04, gazeY: -0.015 }),
  expectant: face({ lookUp: 0.9, smileEyes: 0.12, mouthSmile: 0.12 }),
  smug: face({ lookUp: 0.8, smileEyes: 0.35, mouthSmile: 0.4, headZ: 0.03 }),
  pout: face({ lookUp: 0.45, sad: 0.12, angry: 0.15, headZ: -0.02 }),
  gentle: face({ lookUp: 0.7, smileEyes: 0.3, mouthSmile: 0.25, lidSoft: 0.08 }),
  tease: face({ lookUp: 1, smileEyes: 0.4, mouthSmile: 0.35, headZ: 0.04 }),
  surprised: face({ lookUp: 1, mouthSmile: 0.1 }),
  happy: face({ lookUp: 0.6, smileEyes: 0.3, mouthSmile: 0.3 }),
});
const NEUTRAL_ACTIVITY: LifeActivity = Object.freeze({ gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0,
  sway: 1, bodyZ: 0, blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 });

// ---------------------------------------------------------------- the layer

export interface RpsPerformanceState {
  active: boolean; phase: RpsStagePhase; presence: number; shape: Shape; shapeProgress: number; fingers: number; arm: boolean; side: string | null;
  clearance: number | null; pushed: number; strokes: number;
}

export class RpsPerformance {
  private cueValue: RpsStageCue | null = null;
  private phaseClock = 0;
  /** Time since this count began (strokes), kept running into the reveal so the last stroke finishes. */
  private countClock: number | null = null;
  private readonly presence = new MinJerk();
  private readonly faceWeight = new MinJerk();
  private rig: RpsRig | null = null;
  private rigOwner: SkinnedMesh | null = null;
  /**
   * The hand shape as one minimum-jerk weight per shape (pretrial 2026-11-03): a change that starts while another is still
   * under way continues from the blend shown, at its speed (it used to restart from whichever shape was nearer: a jump).
   * The three weights start together with one duration, so they always sum to 1.
   */
  private readonly shapeWeights: Record<Shape, MinJerk> = { rock: MinJerk.at(1), scissors: MinJerk.at(0), paper: MinJerk.at(0) };
  private shapeTo: Shape = 'rock';
  private faceValues = face({});
  private faceSpeed: Record<string, number> = {};
  private strokes = 0;
  private readonly sq = new Quaternion(); private readonly sq2 = new Quaternion(); private readonly sq3 = new Quaternion(); private readonly sq4 = new Quaternion();
  private readonly sv = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly v1 = new Vector3(); private readonly v2 = new Vector3(); private readonly v3 = new Vector3(); private readonly v4 = new Vector3(); private readonly v5 = new Vector3();
  private readonly m1 = new Matrix4(); private readonly m2 = new Matrix4();
  /** Each written bone's value before this layer wrote it this frame (grant deltas); reused, no per-frame allocation. */
  private readonly base = new Map<Bone, Quaternion>();
  private readonly baseSet = new Set<Bone>();
  private activityOut: LifeActivity = { ...NEUTRAL_ACTIVITY };

  get active(): boolean { return this.cueValue !== null || this.presence.x > 1e-4 || this.faceWeight.x > 1e-4; }

  /** The host's latest view (rpsStageCue). Null: the game is over; the arm comes down, the face goes back. */
  cue(next: RpsStageCue | null): void {
    const previous = this.cueValue;
    if (next && previous?.key === next.key) { this.cueValue = { ...next, elapsedMs: previous.elapsedMs }; return; }
    this.cueValue = next ? { ...next } : null;
    this.phaseClock = next ? Math.max(0, next.elapsedMs) / 1000 : 0;
    if (next?.phase === 'count') this.countClock = this.phaseClock;
    else if (next?.phase === 'ready' || !next) this.countClock = null;
    // Null keeps the last shape: the whole layer fades with the arm.
    if (next) this.shapeGoal(next.phase === 'reveal' || next.phase === 'end' ? next.hand ?? 'rock' : 'rock');
    // The arm's own segments are planned on the next frame, when the pose difference can be measured.
    this.planned = false;
  }
  private planned = false;

  private shapeGoal(shape: Shape): void {
    if (shape === this.shapeTo) return;
    // From where the fingers are now, at their speed: an interrupted change turns round smoothly (tease, a new round).
    this.shapeTo = shape;
    const seconds = this.shapeSeconds(shape);
    for (const hand of SHAPE_NAMES) this.shapeWeights[hand].to(hand === shape ? 1 : 0, seconds);
  }
  /**
   * From the largest finger-joint turn between the blend shown and the new shape, and the weights' own speed: a change that
   * turns round mid-way takes long enough that no weight accelerates past the budget (no fingers: the bounds' upper end).
   */
  private shapeSeconds(shape: Shape): number {
    const rig = this.rig, weights = this.shapeWeights, degrees = 180 / Math.PI;
    let span = 95, full = 95;
    if (rig?.joints.length) {
      span = 0; full = 0;
      for (const joint of rig.joints) {
        span = Math.max(span, blendShapes(joint.targets, weights.rock.x, weights.scissors.x, weights.paper.x, this.sq4).angleTo(joint.targets[shape]) * degrees);
        for (const a of SHAPE_NAMES) for (const b of SHAPE_NAMES) if (a < b) full = Math.max(full, joint.targets[a].angleTo(joint.targets[b]) * degrees);
      }
    }
    const { shapeMin, shapeMax, fingerAccel } = RPS_MOTION;
    let seconds = Math.min(shapeMax, Math.max(shapeMin, Math.sqrt(5.77 * span / fingerAccel)));
    // A weight moves the joints by at most `full` degrees per unit; lengthen until every weight stays within the budget.
    const peak = (T: number) => Math.max(...SHAPE_NAMES.map(hand => weights[hand].peakAcceleration(hand === shape ? 1 : 0, T))) * full;
    while (seconds < shapeMax && peak(seconds) > fingerAccel) seconds = Math.min(shapeMax, seconds * 1.05);
    return seconds;
  }
  private snapShape(shape: Shape): void { this.shapeTo = shape; for (const hand of SHAPE_NAMES) this.shapeWeights[hand].snap(hand === shape ? 1 : 0); }

  /** One display frame: clocks and weights. Call once per rendered frame before the writers. */
  frame(delta: number, owner: SkinnedMesh | null, proxy?: CollisionProxy | null): void {
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    if (owner !== this.rigOwner) {
      this.rigOwner = owner; this.rig = null; this.presence.snap(0); this.faceWeight.snap(0); this.base.clear(); this.baseSet.clear();
      this.snapShape('rock');
    }
    const cue = this.cueValue, up = cue !== null && cue.phase !== 'idle';
    if (up && !this.rig && owner) this.rig = buildRpsRig(owner, proxy);
    if (!this.planned) {
      this.planned = true;
      const target = up ? 1 : 0;
      if (this.presence.goal !== target || (!up && this.presence.x > 0)) this.presence.to(target, this.armSeconds());
      if (this.faceWeight.goal !== target) this.faceWeight.to(target, up ? 0.5 : 0.8);
    }
    this.presence.step(dt); this.faceWeight.step(dt);
    if (cue) {
      this.phaseClock += dt;
      if (cue.phase === 'count' && this.countClock === null) this.countClock = this.phaseClock;
      if (this.countClock !== null) this.countClock += dt;
      // The pretend cheat: the real hand first, then the fake one while she says it, then back when she owns up.
      if (cue.phase === 'reveal' && cue.hand) this.shapeGoal(cue.tease && this.phaseClock >= RPS_MOTION.teaseAt ? cue.tease : cue.hand);
    }
    for (const hand of SHAPE_NAMES) this.shapeWeights[hand].step(dt);
    this.updateFace(dt, cue?.face ?? 'neutral');
  }

  /** Duration of an arm segment: from the largest bone difference between the base and the raised pose. */
  private armSeconds(): number {
    const span = this.rig ? this.spanDegrees() : 60;
    return Math.min(RPS_MOTION.armMax, Math.max(RPS_MOTION.armMin, Math.sqrt(5.77 * span / RPS_MOTION.armAccel)));
  }
  private spanDegrees(): number {
    // The designed arm differs from a hanging arm by roughly the angle between the rest upper arm and the designed one plus the elbow bend.
    const rig = this.rig!;
    const upper = rig.restUpper.angleTo(rig.design.upper), elbow = rig.design.upper.angleTo(rig.design.fore);
    return (upper + elbow) * 180 / Math.PI;
  }

  private updateFace(dt: number, kind: RpsFace): void {
    const target = RPS_FACE_TABLE[kind] ?? RPS_FACE_TABLE.neutral, omega = RPS_MOTION.faceOmega;
    for (const key of FACE_KEYS) {
      const x = this.faceValues[key], v = this.faceSpeed[key] ?? 0, e = x - target[key], decay = Math.exp(-omega * dt), carry = v + omega * e;
      this.faceSpeed[key] = (v - omega * carry * dt) * decay;
      this.faceValues[key] = target[key] + (e + carry * dt) * decay;
    }
  }

  /** Her face during the game, blended over her own activity (her-life) by the face weight. */
  activity(base: LifeActivity | null): LifeActivity | null {
    const w = this.faceWeight.x;
    if (!(w > 1e-4)) return base;
    const from = base ?? NEUTRAL_ACTIVITY, out = this.activityOut, f = this.faceValues;
    Object.assign(out, from);
    const mix = (a: number, b: number) => a + (b - a) * w;
    out.lookUp = mix(from.lookUp, f.lookUp); out.smileEyes = mix(from.smileEyes, f.smileEyes); out.mouthSmile = mix(from.mouthSmile, f.mouthSmile);
    out.lidSoft = mix(from.lidSoft, f.lidSoft); out.headZ = mix(from.headZ, f.headZ); out.gazeY = mix(from.gazeY, f.gazeY);
    out.gazeX = mix(from.gazeX, 0); out.headX = mix(from.headX, 0); out.headY = mix(from.headY, 0);
    out.pointerFollow = mix(from.pointerFollow, 1); out.saccade = mix(from.saccade, 0.6); out.lookAtUser = mix(from.lookAtUser, 1);
    out.sway = mix(from.sway, 0.7); out.bodyZ = mix(from.bodyZ, 0); out.blinkInterval = mix(from.blinkInterval, 1);
    out.sad = mix(from.sad ?? 0, f.sad); out.angry = mix(from.angry ?? 0, f.angry);
    return out;
  }

  /** Forearm stroke angle (rad) now: three pulses landing on 石头, 剪刀, 布. */
  private stroke(): number {
    const cue = this.cueValue;
    if (this.countClock === null || !cue) return 0;
    const t = this.countClock, lead = cue.leadMs / 1000, beat = cue.beatMs / 1000, half = Math.min(RPS_MOTION.strokeHalf, lead, beat / 2);
    let sum = 0;
    for (let k = 0; k < 3; k++) sum += pulse(t - (lead + k * beat), half);
    return RPS_MOTION.strokeAmp * sum;
  }

  /** Writes the arm and the fingers (program layer: every bone remembered first, restored by the stage next frame). */
  applyPose(port: RpsPort): void {
    const w = this.presence.x, rig = this.rig;
    if (!(w > 1e-5) || !rig || rig.owner !== this.rigOwner) return;
    const { upper, elbow, wrist } = rig;
    this.baseSet.clear();
    if (upper && elbow && wrist) {
      const chestQ = rig.chest.getWorldQuaternion(this.sq);
      const U = this.v1.copy(rig.design.upper).applyQuaternion(chestQ), K = this.v2.copy(rig.design.hinge).applyQuaternion(chestQ);
      const stroke = this.stroke();
      if (stroke > 0) this.strokes++;
      // Negative about the hinge = less elbow flexion: the fist dips forward on each beat.
      const bend = this.sq2.setFromAxisAngle(K, -stroke);
      const F = this.v3.copy(rig.design.fore).applyQuaternion(chestQ).applyQuaternion(bend);
      const H = this.v4.copy(rig.design.hand).applyQuaternion(chestQ).applyQuaternion(bend);
      const P = this.v5.copy(rig.design.palm).applyQuaternion(chestQ).applyQuaternion(bend);
      // Upper arm: its bone axis to U and the elbow hinge to K (so the elbow bends like an elbow).
      const parentQ = upper.parent ? upper.parent.getWorldQuaternion(this.sq3) : this.sq3.identity();
      const world = alignTwo(rig.restUpper, rig.restHinge, U, K, this.sq4, this.m1, this.m2, this.sv);
      this.write(port, upper, parentQ.invert().multiply(world), w);
      // Elbow: the smallest swing from its parent's frame to the forearm direction.
      const elbowParent = elbow.parent ? elbow.parent.getWorldQuaternion(this.sq3) : this.sq3.identity();
      const local = this.sv[0].copy(F).applyQuaternion(elbowParent.invert());
      this.write(port, elbow, this.sq4.setFromUnitVectors(rig.restFore, local.normalize()), w);
      // Hand: fingers up, palm to the viewer. The twist about the forearm goes to 手捩 when there is one.
      const handWorld = alignTwo(rig.restHand, rig.restPalm, H, P, this.sq2, this.m1, this.m2, this.sv);
      if (rig.twist) {
        const elbowWorld = elbow.getWorldQuaternion(this.sq3);
        const relative = elbowWorld.invert().multiply(handWorld); // elbow frame → hand
        const axis = rig.restFore, dot = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
        const twist = this.sq4.set(axis.x * dot, axis.y * dot, axis.z * dot, relative.w);
        if (twist.lengthSq() < 1e-9) twist.identity(); else twist.normalize();
        this.write(port, rig.twist, twist, w);
        this.write(port, wrist, this.sq2.copy(twist).invert().multiply(relative), w);
      } else {
        const wristParent = wrist.parent ? wrist.parent.getWorldQuaternion(this.sq3) : this.sq3.identity();
        this.write(port, wrist, wristParent.invert().multiply(handWorld), w);
      }
    }
    // Fingers: the shape blend, weighted by presence.
    const weights = this.shapeWeights;
    for (const joint of rig.joints) {
      this.write(port, joint.bone, blendShapes(joint.targets, weights.rock.x, weights.scissors.x, weights.paper.x, this.sq3), w);
    }
    // Grant children follow by delta: child ← child · g(base)⁻¹ · g(new).
    for (const grant of rig.grants) {
      const before = this.baseSet.has(grant.parent) ? this.base.get(grant.parent) : undefined;
      if (!before) continue;
      port.remember(grant.child);
      const old = this.sq2.identity().slerp(before, grant.ratio).invert(), now = this.sq3.identity().slerp(grant.parent.quaternion, grant.ratio);
      grant.child.quaternion.multiply(old).multiply(now);
    }
  }

  private write(port: RpsPort, bone: Bone, target: Quaternion, weight: number): void {
    port.remember(bone);
    if (!this.baseSet.has(bone)) {
      let saved = this.base.get(bone);
      if (!saved) this.base.set(bone, saved = new Quaternion());
      saved.copy(bone.quaternion); this.baseSet.add(bone);
    }
    bone.quaternion.slerp(target, Math.min(1, Math.max(0, weight)));
  }

  getState(): RpsPerformanceState {
    return { active: this.active, phase: this.cueValue?.phase ?? 'idle', presence: Math.round(this.presence.x * 1000) / 1000, shape: this.shapeTo, shapeProgress: Math.round(this.shapeWeights[this.shapeTo].x * 1000) / 1000,
      fingers: this.rig?.fingers ?? 0, arm: !!this.rig?.upper, side: this.rig?.side ?? null,
      clearance: this.rig && Number.isFinite(this.rig.clearance) ? Math.round(this.rig.clearance * 1000) / 1000 : null, pushed: this.rig?.pushed ?? 0, strokes: this.strokes };
  }

  /**
   * Where the raised arm is (world space, reused vectors), so the buttons can sit clear of it; null while the arm is mostly
   * down or the model has no arm. Read after the frame is posed.
   */
  raisedArm(): { elbow: Vector3; wrist: Vector3 } | null {
    const rig = this.rig;
    if (!rig?.elbow || !rig.wrist || rig.owner !== this.rigOwner || this.presence.x < 0.5) return null;
    rig.elbow.getWorldPosition(this.armOut.elbow); rig.wrist.getWorldPosition(this.armOut.wrist);
    return this.armOut;
  }
  private readonly armOut = { elbow: new Vector3(), wrist: new Vector3() };

  /** Test seam. */
  rigForTest(): RpsRig | null { return this.rig; }
}
