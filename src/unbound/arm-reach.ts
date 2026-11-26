/**
 * Unbound showcase (docs/claude/2026-11-14-lapwing-showcase.md): her hands, generated live — a hand to her cheek, chin or mouth,
 * an open-palm wave beside her face, a small wave at her chest. No keyframes: a target point and a hand orientation per side,
 * each through its own springs (layer 3), then an analytic two-bone reach (upper arm, forearm) and the hand turned to the wanted
 * orientation, the forearm twist bone taking half of the twist. The result is blended with whatever the motion has by a weight
 * that eases in and out, so a hand rises from her side and goes back there; it never jumps.
 *
 * Not touching her face: the face points come from the model's own head (the vertices its head bone carries), so each target is a
 * few centimeters off that surface along its normal; `clearance()` measures the fingers against the same head (tests, preview).
 *
 * Written after the body's other residuals and before the leg IK (figure.ts), on bones the figure remembers and restores.
 */
import { Bone, Matrix4, Quaternion, Vector3, type SkinnedMesh } from 'three';
import { Spring, type SpringSpec } from './dynamics';
import { MMD_UNIT_M } from '../../shared/unbound/world';
import { signedSurfaceDistanceM } from './face-region';
import { measureHead, restPosition, type HeadShape } from './arm-reach-head';

/**
 * 'aim' (I-154 batch 4, the window's games: 猜拳, 递东西, 牵手): the arm as a performer designed it (`HandTarget.aim`), already shaped in
 * time by that performer (minimum-jerk presence, the count strokes, the hand following your mouse); the springs here only follow it
 * closely (AIM_TRACK) so a jump in what a performer asks still eases.
 */
export type HandPose = 'cheek' | 'cheek-back' | 'chin' | 'mouth' | 'wave-big' | 'wave-small' | 'tuck' | 'vsign' | 'heart' | 'point' | 'aim';

/**
 * Round 11: hand shapes finger by finger (thumb 0–2, the others 1–3): per joint [curl toward the pads, spread toward the index
 * side] in degrees, as src/initiative/rps-performance.ts poses its hands. Blended in with the reach weight like the rest of the arm.
 */
export type FingerShape = readonly (readonly [number, number])[];
/** A whole hand: the thumb's joints 0–2, then index, middle, ring, little (joints 1–3). */
export interface HandShapeTable { thumb: FingerShape; fingers: readonly [FingerShape, FingerShape, FingerShape, FingerShape] }
type V3 = { x: number; y: number; z: number };
/**
 * A designed arm (unit directions in her chest's rest frame: the model's own axes at rest): shoulder → elbow, elbow → wrist, the hand
 * (wrist → middle knuckle) and where its pads face. The elbow points the way `upper` does; the forearm twist is solved here.
 */
export interface ArmAim { upper: V3; fore: V3; hand: V3; palm: V3 }
const FIST: FingerShape = [[80, 0], [95, 0], [65, 0]];
const FIST_THUMB: FingerShape = [[18, -28], [35, 0], [45, 0]];
const STRAIGHT: FingerShape = [[0, 0], [4, 0], [3, 0]];
export const HAND_SHAPES = {
  // A V: index and middle up and a little apart, ring and little curled, the thumb over them.
  vsign: { thumb: FIST_THUMB, fingers: [[[0, 9], [4, 0], [4, 0]], [[0, -9], [4, 0], [4, 0]], FIST, FIST] },
  // A finger heart: the index bent at its base, the thumb laid across its tip; the others closed.
  heart: { thumb: [[0, -10], [10, 0], [5, 0]], fingers: [[[50, 0], [45, 0], [10, 0]], FIST, FIST, FIST] },
  // Pointing: the index straight, the others closed, the thumb on them.
  point: { thumb: FIST_THUMB, fingers: [STRAIGHT, FIST, FIST, FIST] },
} as const satisfies Record<string, { thumb: FingerShape; fingers: readonly [FingerShape, FingerShape, FingerShape, FingerShape] }>;
export type HandShapeName = keyof typeof HAND_SHAPES;
export interface HandTarget {
  /** 0..1: how much of the reach replaces the motion's arm (eased by its own spring). */
  weight: number;
  pose: HandPose;
  /** Wave swing −1..1 (already shaped in time by the performer); its size per pose below. */
  wave: number;
  /** Round 9, 'tuck' (hair behind the ear): 0 at her temple … 1 behind her ear (already shaped in time by the performer). */
  slide?: number;
  /** This beat's own variation: the hand's place off the pose's point (m, her frame) and a turn about the palm (rad). */
  offset?: { x: number; y: number; z: number }; roll?: number;
  /** 'aim': the designed arm (required for it; ignored by the other poses). */
  aim?: ArmAim;
  /** 'aim': the hand's shape this frame (degrees per joint, already shaped in time); absent: the fingers as the motion has them. */
  fingers?: HandShapeTable;
}
export type HandTargets = { left: HandTarget | null; right: HandTarget | null };

const UNITS = 1 / MMD_UNIT_M;
const WEIGHT_SPRING: SpringSpec = { hz: 1.0, eased: true }; // round 5: up in about a second, so a 2–3 s hand beat reads
const POINT_SPRING: SpringSpec = { hz: 2.0, eased: true };
const AXIS_SPRING: SpringSpec = { hz: 2.2, eased: true };
/**
 * 'aim' follows a performer that already eases its arm: the weight, the hand's place and its turn follow it this closely (two springs
 * of 8 Hz in a row: about 40 ms behind), which keeps the count strokes and the reveal on time and still turns any jump into a move.
 * A side that was busy with another gesture (or behind the performer) first catches up at WEIGHT_SPRING, then tracks.
 */
export const AIM_TRACK: SpringSpec = { hz: 8, eased: true };
/** The weight counts as caught up with the performer within this. */
const AIM_CAUGHT = 0.02;
/** Palm (its pads) off the face surface (m): the palm's own thickness plus a small gap. */
const FACE_GAP_M = 0.028;
/** A full curl per finger joint (rad), shared out 0.6 / 1 / 0.8 from the knuckle out. */
const CURL_RAD = 75 * Math.PI / 180;
/** The fingers are kept this far off her surface (m), measured as drawn (a margin: the hand is still arriving when it is measured). */
const CLEAR_MIN_M = 0.02; // round 6: 1.2 cm left a chin touch 3 mm in while her head nodded into the hand
/** A hand counts as down (its reach weight) below this: a new gesture may start fresh. */
const ARM_DOWN = 0.01;
/** How far a forearm turns about itself (rad). */
const TWIST_MAX = 110 * Math.PI / 180;
/** Half a finger's thickness (m): a fingertip bone sits this far inside the skin. */
const FINGER_HALF_M = 0.006;
/** Wave swing: degrees about the palm's normal and meters across, per pose. */
const WAVE = { 'wave-big': { deg: 24, m: 0.035 }, 'wave-small': { deg: 16, m: 0.02 } } as const;

const FINGERS = ['人指', '中指', '薬指', '小指'];
const DIGITS = ['１', '２', '３'];

interface Side {
  s: 1 | -1;
  upper: Bone; twistUpper: Bone | null; elbow: Bone; twist: Bone | null; wrist: Bone;
  l1: number; l2: number;
  /** Rest vectors (model units): shoulder → elbow, elbow → wrist; the elbow's hinge axis (it bends the forearm forward). */
  upperRest: Vector3; foreRest: Vector3; hinge: Vector3;
  /** The axis a finger joint bends about toward the pads (hand-local, rest). */
  curlAxis: Vector3;
  /** Hand-local axes at rest: toward the middle knuckle, and across the palm (index → little). The palm's pad side is their cross. */
  fingerLocal: Vector3; acrossLocal: Vector3; palmLocal: Vector3;
  fingerBones: Bone[]; tips: Bone[];
  weight: Spring; point: [Spring, Spring, Spring];
  /** The hand's orientation (chest frame: finger along x, pads along y), turned toward the goal on the shortest arc each sub-step (two axis springs would pass through nothing when the palm turns over). */
  frame: Quaternion; frameGoal: Quaternion;
  pose: HandPose | null; wave: number; slide: number; started: boolean; offset: { x: number; y: number; z: number }; roll: number;
  /** The forearm twist last frame (rad, unwrapped), null when the arm is down. */
  twistAngle: number | null;
  /** How far the face goal is pushed out (m) because the fingers came too close to the surface. */
  push: number;
  /** Round 11: every finger joint (thumb 0–2, then index … little 1–3) with its curl and spread axes (hand-local rest). */
  shapeJoints: { bone: Bone; finger: number; joint: number; curl: Vector3; spread: Vector3 }[];
  /** 'aim': the designed arm and hand shape last handed, and whether the springs track the performer (AIM_TRACK) or still catch up. */
  aim: ArmAim | null; fingers: HandShapeTable | null; tracking: boolean;
  /** The palm's centre from the wrist at rest (model units, hand-local): 0.55 of the way to the middle knuckle, ~1 cm toward the pads. */
  palmRest: Vector3;
}


const find = (mesh: SkinnedMesh, name: string) => mesh.skeleton.bones.find(b => b.name === name) ?? null;

export class ArmReach {
  private readonly sides: Side[] = [];
  private readonly head: Bone | null;
  private readonly chest: Bone | null;
  private readonly shape: HeadShape | null;
  private targets: HandTargets = { left: null, right: null };
  private readonly v = { a: new Vector3(), b: new Vector3(), c: new Vector3(), d: new Vector3(), e: new Vector3() };
  private readonly q = { a: new Quaternion(), b: new Quaternion(), c: new Quaternion() };

  constructor(private readonly mesh: SkinnedMesh) {
    this.head = find(mesh, '頭');
    this.chest = find(mesh, '上半身2') ?? find(mesh, '上半身');
    for (const [prefix, s] of [['左', 1], ['右', -1]] as const) {
      const upper = find(mesh, `${prefix}腕`), elbow = find(mesh, `${prefix}ひじ`), wrist = find(mesh, `${prefix}手首`);
      const middle = find(mesh, `${prefix}中指１`), index = find(mesh, `${prefix}人指１`), little = find(mesh, `${prefix}小指１`);
      if (!upper || !elbow || !wrist || !middle || !index || !little) continue;
      const rest = (bone: Bone) => restPosition(mesh, bone);
      const l1 = rest(elbow).distanceTo(rest(upper)), l2 = rest(wrist).distanceTo(rest(elbow));
      // MMD bones rest with no rotation of their own, so local axes are model axes at rest.
      const fingerLocal = rest(middle).sub(rest(wrist)).normalize();
      const acrossLocal = rest(little).sub(rest(index)).normalize();
      const palmLocal = new Vector3().crossVectors(fingerLocal, acrossLocal).normalize();
      // The pads face down in an A-pose (−y); flip if the cross came out the other way.
      if (palmLocal.y > 0) palmLocal.negate();
      const fingerBones = FINGERS.flatMap(f => DIGITS.map(d => find(mesh, `${prefix}${f}${d}`))).filter((b): b is Bone => !!b);
      const tips = ['人指先', '中指先', '小指先', '親指先', '中指２', '人指２'].map(n => find(mesh, `${prefix}${n}`)).filter((b): b is Bone => !!b);
      const spring3 = (spec: SpringSpec): [Spring, Spring, Spring] => [new Spring(spec), new Spring(spec), new Spring(spec)];
      const upperRest = rest(elbow).sub(rest(upper)), foreRest = rest(wrist).sub(rest(elbow));
      const hinge = new Vector3().crossVectors(foreRest.clone().normalize(), new Vector3(0, 0, 1)).normalize();
      const curlAxis = new Vector3().crossVectors(fingerLocal, palmLocal).normalize();
      // Round 11: per-joint axes for the hand shapes (each joint's own direction × the palm normal / the across direction).
      const shapeJoints: Side['shapeJoints'] = [];
      const towardIndex = acrossLocal.clone().negate();
      ['親指', ...FINGERS].forEach((name, finger) => {
        const numbers = finger === 0 ? ['０', '１', '２'] : DIGITS;
        const chain = numbers.map(d => find(mesh, `${prefix}${name}${d}`) ?? find(mesh, `${prefix}${name}${'０１２３'.indexOf(d)}`)).filter((b): b is Bone => !!b);
        const tipBone = find(mesh, `${prefix}${name}先`);
        chain.forEach((bone, joint) => {
          const next = chain[joint + 1] ?? tipBone, from = rest(bone);
          const dir = next ? rest(next).sub(from) : joint > 0 ? from.clone().sub(rest(chain[joint - 1])) : fingerLocal.clone();
          if (dir.lengthSq() < 1e-12) return;
          dir.normalize();
          const curl = dir.clone().cross(palmLocal).normalize(), spread = dir.clone().cross(towardIndex).normalize();
          if (curl.lengthSq() < 0.5 || spread.lengthSq() < 0.5) return;
          shapeJoints.push({ bone, finger, joint, curl, spread });
        });
      });
      const palmRest = rest(fingerBones[3] ?? wrist).sub(rest(wrist)).multiplyScalar(0.55).addScaledVector(palmLocal, 0.01 * UNITS);
      this.sides.push({ s, upperRest, foreRest, hinge, curlAxis, upper, twistUpper: find(mesh, `${prefix}腕捩`), elbow, twist: find(mesh, `${prefix}手捩`), wrist, l1, l2, fingerLocal, acrossLocal, palmLocal, fingerBones, tips,
        weight: new Spring(WEIGHT_SPRING), point: spring3(POINT_SPRING), frame: new Quaternion(), frameGoal: new Quaternion(), pose: null, wave: 0, slide: 0, started: false, twistAngle: null, push: 0, offset: { x: 0, y: 0, z: 0 }, roll: 0, shapeJoints,
        aim: null, fingers: null, tracking: false, palmRest });
    }
    this.shape = this.head ? measureHead(mesh, this.head) : null;
  }

  /** Both arms found and the head measured. */
  get available(): boolean { return this.sides.length === 2 && !!this.shape; }
  /** The higher hand's weight as realized now (0..1). */
  get raised(): number { return this.sides.reduce((m, side) => Math.max(m, side.weight.value), 0); }
  /** Anything to write this frame. */
  get active(): boolean { return this.sides.some(side => side.weight.value > 1e-4 || side.weight.target > 0); }

  set(targets: HandTargets | undefined): void { this.targets = targets ?? { left: null, right: null }; }

  advance(h: number): void {
    for (const side of this.sides) {
      const t = side.s === 1 ? this.targets.left : this.targets.right;
      side.weight.target = t ? Math.min(1, Math.max(0, t.weight)) : 0;
      // One gesture at a time per hand: a different one waits until this hand is down (a palm turning over in the air would
      // have to twist the forearm through a half turn). Down, the next one starts fresh from where its own goal is.
      if (t && side.pose !== null && t.pose !== side.pose && side.weight.value > ARM_DOWN) side.weight.target = 0;
      else if (t && t.pose !== side.pose) {
        side.pose = t.pose; side.started = false; side.twistAngle = null;
        // An aim on a free arm whose performer is only beginning: tracked from the start (both start at rest). Otherwise caught up first.
        side.tracking = t.pose === 'aim' && t.weight <= 0.05 && side.weight.value < ARM_DOWN;
      }
      if (!t && side.weight.value < ARM_DOWN) { side.started = false; side.twistAngle = null; }
      if (t && t.pose === side.pose) {
        side.wave = Math.min(1, Math.max(-1, t.wave));
        side.slide = Number.isFinite(t.slide) ? Math.min(1, Math.max(0, t.slide!)) : 0;
        const o = t.offset, c = (v: number) => (Number.isFinite(v) ? Math.min(0.04, Math.max(-0.04, v)) : 0);
        side.offset = o ? { x: c(o.x), y: c(o.y), z: c(o.z) } : { x: 0, y: 0, z: 0 };
        side.roll = Number.isFinite(t.roll) ? Math.min(0.4, Math.max(-0.4, t.roll!)) : 0;
        if (t.pose === 'aim') { side.aim = t.aim ?? side.aim; side.fingers = t.fingers ?? null; }
      }
      // 'aim' (I-154 batch 4): track the performer once caught up; anything else (or nothing) uses the usual springs again.
      const aiming = !!t && t.pose === 'aim' && side.pose === 'aim';
      if (!aiming) side.tracking = false;
      else if (!side.tracking && Math.abs(side.weight.value - side.weight.target) < AIM_CAUGHT && Math.abs(side.weight.velocity.v) < 0.5) side.tracking = true;
      side.weight.retune(side.tracking ? AIM_TRACK : WEIGHT_SPRING);
      for (const spring of side.point) spring.retune(side.pose === 'aim' ? AIM_TRACK : POINT_SPRING);
      side.weight.advance(h);
      if (side.started) {
        for (const spring of side.point) spring.advance(h);
        side.frame.slerp(side.frameGoal, 1 - Math.exp(-2 * Math.PI * (side.pose === 'aim' ? AIM_TRACK.hz : AXIS_SPRING.hz) * h));
      }
    }
  }

  /**
   * Writes the arms (call with every world matrix current). `remember(bone)` before a bone is changed (the figure restores it).
   */
  apply(remember: (bone: Bone) => void): void {
    if (!this.shape || !this.head) return;
    for (const side of this.sides) {
      const w = side.weight.value;
      if (!(w > 1e-4) && !(side.weight.target > 0)) { side.started = false; side.twistAngle = null; side.push = 0; continue; }
      const goal = this.goal(side);
      if (!goal) continue;
      // The springs start where the goal is the first time (the weight eases the arm in from the motion's own pose).
      const set3 = (springs: [Spring, Spring, Spring], v: Vector3) => { springs[0].target = v.x; springs[1].target = v.y; springs[2].target = v.z; };
      if (!side.started) {
        side.started = true;
        const reset3 = (springs: [Spring, Spring, Spring], v: Vector3) => { springs[0].reset(v.x); springs[1].reset(v.y); springs[2].reset(v.z); };
        reset3(side.point, goal.point); side.frame.copy(frameOf(goal.finger, goal.normal));
      }
      set3(side.point, goal.point); side.frameGoal.copy(frameOf(goal.finger, goal.normal));
      if (!(w > 1e-4)) continue;
      const read = (springs: [Spring, Spring, Spring], out: Vector3) => out.set(springs[0].value, springs[1].value, springs[2].value);
      // Spring values are in the chest's frame (so a lean or a turn carries the hand along); back to world here.
      const chestQ = this.chest ? this.chest.getWorldQuaternion(this.q.c) : this.mesh.getWorldQuaternion(this.q.c);
      const shoulder = side.upper.getWorldPosition(new Vector3());
      const point = read(side.point, new Vector3()).applyQuaternion(chestQ).add(shoulder);
      const finger = new Vector3(1, 0, 0).applyQuaternion(side.frame).applyQuaternion(chestQ).normalize();
      const normal = new Vector3(0, 1, 0).applyQuaternion(side.frame).applyQuaternion(chestQ);
      normal.addScaledVector(finger, -normal.dot(finger)).normalize();
      this.solve(side, point, finger, normal, goal.pole.applyQuaternion(chestQ), w, goal.curl, remember, goal.shape);
      // Never into her face (round 4: a palm on the cheek once went 1.8 cm in): measured on the fingers as drawn, the goal is
      // pushed out along the face's normal by what is missing (through the point springs, so it moves, never jumps), and eases
      // back slowly once there is room.
      if (side.pose !== 'wave-big' && side.pose !== 'wave-small' && side.pose !== 'aim' && w > 0.3) {
        const c = this.sideClearance(side);
        if (c !== null && c < CLEAR_MIN_M) side.push = Math.min(0.06, side.push + (CLEAR_MIN_M - c) * 1.0);
        else if (c !== null && c > CLEAR_MIN_M + 0.01) side.push = Math.max(0, side.push - 0.0003);
      }
    }
  }

  /**
   * Fingers against her head (m): the smallest margin between any finger point and the head's surface along the same direction
   * from its centre (negative: inside). null when no hand is up.
   */
  clearance(): number | null {
    let best: number | null = null;
    for (const side of this.sides) {
      if (!(side.weight.value > 0.05)) continue;
      const c = this.sideClearance(side);
      if (c !== null && (best === null || c < best)) best = c;
    }
    return best;
  }
  private sideClearance(side: Side): number | null {
    if (!this.shape || !this.head) return null;
    let best: number | null = null;
    const inverse = new Matrix4().copy(this.head.matrixWorld).invert();
    {
      const { points, normals } = this.shape.surface;
      for (const tip of side.tips) {
        const p = tip.getWorldPosition(new Vector3()).applyMatrix4(inverse);
        let nearest = -1, d2 = Infinity;
        for (let i = 0; i < points.length; i += 3) {
          const dx = p.x - points[i], dy = p.y - points[i + 1], dz = p.z - points[i + 2], d = dx * dx + dy * dy + dz * dz;
          if (d < d2) { d2 = d; nearest = i; }
        }
        if (nearest < 0) continue;
        const along = (p.x - points[nearest]) * normals[nearest] + (p.y - points[nearest + 1]) * normals[nearest + 1] + (p.z - points[nearest + 2]) * normals[nearest + 2];
        // Round 16: only a tip close to her surface can be inside it (a far hand whose nearest point faces away from it read -17 to -28 cm; a fingertip is never 3 cm into her).
        const margin = signedSurfaceDistanceM(Math.sqrt(d2), along, MMD_UNIT_M) - FINGER_HALF_M;
        if (best === null || margin < best) best = margin;
      }
    }
    return best;
  }

  /** The goal for this side now, in the chest frame relative to the shoulder (point, units) and the hand axes there. */
  private goal(side: Side): { point: Vector3; finger: Vector3; normal: Vector3; pole: Vector3; curl: number; shape?: HandShapeTable } | null {
    const pose = side.pose, shape = this.shape!, head = this.head!;
    if (!pose) return null;
    if (pose === 'aim') return aimGoal(side);
    const chestQ = this.chest ? this.chest.getWorldQuaternion(new Quaternion()) : this.mesh.getWorldQuaternion(new Quaternion());
    const toChest = chestQ.clone().invert();
    const shoulder = side.upper.getWorldPosition(new Vector3());
    const s = side.s;
    // curl: fingers −1 straight … 0 as the motion has them … 1 closed (a partial curl reads as a relaxed hand).
    let point: Vector3, finger: Vector3, normal: Vector3, pole: Vector3, curl = 0, handShape: HandShapeTable | undefined;
    if (pose === 'wave-big' || pose === 'wave-small') {
      // In the chest frame (x = her left, y up, z forward): beside her face, or in front of her chest.
      const big = pose === 'wave-big';
      const swing = WAVE[pose], angle = side.wave * swing.deg * Math.PI / 180;
      const headY = head.getWorldPosition(new Vector3()).sub(shoulder).applyQuaternion(toChest).y;
      // Offsets from her shoulder (m → units): a little out to her side, at her face or below her chest, in front of her.
      point = new Vector3((s * (big ? 0.06 : -0.02) + side.wave * swing.m) * UNITS, big ? headY - 0.03 * UNITS : -0.06 * UNITS /* round 5: the small wave at her collarbone (at the chest it was below the close framing) */, (big ? 0.2 : 0.2) * UNITS);
      // Palm toward you (forward; the pads face away from her), fingers up, swinging about the palm's normal.
      normal = new Vector3(0, 0.05, 1).normalize();
      finger = new Vector3(0, 1, -0.1).normalize().applyAxisAngle(normal, -angle);
      pole = new Vector3(s * 1, -0.45, -0.1);
      curl = -0.85;
    } else {
      // On the face: the head's own points, off the surface, carried by the head (head-local → world → chest frame).
      const m = head.matrixWorld, rot = head.getWorldQuaternion(new Quaternion());
      const local = (v: Vector3) => v.clone().applyMatrix4(m);
      const dir = (v: Vector3) => v.clone().applyQuaternion(rot).normalize();
      if (pose === 'cheek' || pose === 'cheek-back') {
        // Beside the cheek and outside the hair that hangs there (the side locks count as her surface), a little low and forward.
        const cheek = s === 1 ? shape.cheek.left : shape.cheek.right, hair = s === 1 ? shape.hairSide.left : shape.hairSide.right;
        // The palm lies flatter on the cheek than the back of a curled hand does: a little more room for it.
        const extra = pose === 'cheek' ? 0.01 * UNITS : 0;
        const lateral = Math.max(Math.abs(cheek.x - shape.center.x) + FACE_GAP_M * UNITS, hair - shape.center.x * s + 0.012 * UNITS) + extra;
        // The palm's centre at the jaw, so the fingers lie along the cheek and end below the eye.
        point = local(new Vector3(shape.center.x + s * lateral, cheek.y - 0.075 * UNITS, cheek.z + 0.005 * UNITS));
        const out = dir(new Vector3(s, -0.1, 0.6));
        finger = dir(new Vector3(s * 0.05, 1, -0.3));
        // The palm against the cheek, or the back of the hand (fingers loosely curled, pads facing out).
        normal = pose === 'cheek' ? out.clone().negate() : out.clone();
        pole = new Vector3(s * 0.55, -1, 0.05);
        curl = pose === 'cheek' ? 0.2 : 0.55;
      } else if (pose === 'tuck') {
        // Hair behind the ear (round 9, round 10 clearer). The hand starts at her temple in front of the side lock (inside her
        // outline, at the edge of her face), passes over the side hair and ends just behind the ear (the performer shapes `slide`
        // in time); the palm faces her head the whole way and the fingers curl as they pass the ear. The hair counts as her surface.
        const cheek = s === 1 ? shape.cheek.left : shape.cheek.right, hair = s === 1 ? shape.hairSide.left : shape.hairSide.right;
        const faceEdge = Math.abs(cheek.x - shape.center.x), hairEdge = Math.max(faceEdge, hair - shape.center.x * s);
        const u = side.slide;
        const lerp = (a: number, b: number) => a + (b - a) * u;
        // The palm's centre: below and in front of the fingertips (the fingers point up and back along the head). A little bulge
        // outward in the middle: over the side hair, not through it.
        // Round 11: coming down, the hand first moves out from behind the ear (lowering from there swept it through her hair).
        const leaving = side.weight.target === 0 ? 0.04 * UNITS : 0;
        const lateral = lerp(faceEdge + 0.046 * UNITS, hairEdge + 0.033 * UNITS) + 0.02 * UNITS * Math.sin(Math.PI * u) + leaving;
        point = local(new Vector3(shape.center.x + s * lateral, cheek.y + lerp(-0.03, -0.045) * UNITS, cheek.z + lerp(0.075, -0.06) * UNITS));
        finger = dir(new Vector3(s * lerp(0.15, 0), lerp(0.8, 0.35), lerp(-0.55, -1)));
        normal = dir(new Vector3(-s * lerp(0.35, 1), 0, lerp(-1, -0.15)));
        pole = new Vector3(s * 0.7, -1, -0.1);
        // The fingers curl as they pass the ear (round 9 kept them nearly straight: the pads face her head).
        curl = 0.15 + 0.4 * Math.min(1, Math.max(0, (u - 0.55) / 0.45)) ** 2;
      } else if (pose === 'vsign' || pose === 'heart' || pose === 'point') {
        // Round 11, all three by her face (where the close framing sees them), carried by her head like the other face poses:
        //  - a V beside her cheek, outside the side lock, the palm toward you and the two fingers up past her eye;
        //  - a finger heart a little lower and further forward, the thumb and index toward you;
        //  - pointing at you: the hand forward of her cheek, the index angled at the camera (straight on it would foreshorten to a knuckle).
        const cheek = s === 1 ? shape.cheek.left : shape.cheek.right, hair = s === 1 ? shape.hairSide.left : shape.hairSide.right;
        const lateral = Math.max(Math.abs(cheek.x - shape.center.x) + 0.035 * UNITS, hair - shape.center.x * s + 0.025 * UNITS);
        if (pose === 'vsign') {
          point = local(new Vector3(shape.center.x + s * lateral, cheek.y - 0.04 * UNITS, cheek.z + 0.045 * UNITS));
          finger = dir(new Vector3(s * 0.12, 1, 0.08));
          normal = dir(new Vector3(-s * 0.15, 0, 1));
          pole = new Vector3(s * 0.7, -1, -0.05);
        } else if (pose === 'heart') {
          point = local(new Vector3(shape.center.x + s * lateral, cheek.y - 0.05 * UNITS, cheek.z + 0.06 * UNITS));
          finger = dir(new Vector3(-s * 0.25, 1, 0.1));
          normal = dir(new Vector3(-s * 0.3, 0, 1));
          pole = new Vector3(s * 0.8, -1, -0.1);
        } else {
          point = local(new Vector3(shape.center.x + s * lateral, cheek.y - 0.06 * UNITS, cheek.z + 0.07 * UNITS));
          finger = dir(new Vector3(-s * 0.35, 0.2, 1));
          normal = dir(new Vector3(-s, 0.1, 0)); // the pads toward her middle, the thumb up: a neutral forearm can hold it
          pole = new Vector3(s * 0.8, -1, -0.2);
        }
        handShape = HAND_SHAPES[pose];
      } else if (pose === 'chin') {
        // A fingertip at the chin: the hand below and in front of it, fingers half curled, palm toward her.
        const out = dir(new Vector3(0, -0.35, 1));
        point = local(shape.chin).addScaledVector(out, (FACE_GAP_M + 0.03) * UNITS).addScaledVector(dir(new Vector3(0, -1, 0)), 0.05 * UNITS);
        finger = dir(new Vector3(-s * 0.3, 1, 0.15));
        normal = dir(new Vector3(0, 0.25, -1));
        pole = new Vector3(s * 0.25, -1, 0.5);
        curl = 0.5;
      } else {
        // The palm over her mouth (a laugh she half hides): in front of it, a little to her side.
        const out = dir(new Vector3(0, 0, 1));
        point = local(shape.mouth).addScaledVector(out, (FACE_GAP_M + 0.012) * UNITS).addScaledVector(dir(new Vector3(-s, -1.2, 0)), 0.015 * UNITS).addScaledVector(dir(new Vector3(0, -1, 0)), 0.032 * UNITS); // round 4: fingertips at the nose, not over the eye; round 10: below the nose
        finger = dir(new Vector3(-s * 0.85, 1, 0.08)); // round 10: across the mouth more than up the face, so no fingertip reaches the nose or an eye
        normal = dir(new Vector3(0, 0, -1));
        pole = new Vector3(s * 0.3, -1, 0.45);
        curl = 0.3; // a relaxed hand, the fingers a little bent over the lips
      }
      point.addScaledVector(dir(pose === 'cheek' || pose === 'cheek-back' ? new Vector3(s, 0, 0.4) : pose === 'tuck' ? new Vector3(s * (0.4 + 0.6 * side.slide), 0, 1 - side.slide) : pose === 'vsign' || pose === 'heart' || pose === 'point' ? new Vector3(s, 0, 0.3) : new Vector3(0, -0.2, 1)), side.push * UNITS);
      point.sub(shoulder).applyQuaternion(toChest);
      finger.applyQuaternion(toChest); normal.applyQuaternion(toChest);
    }
    // This beat's own variation (chest frame: x her left, y up, z forward).
    point.add(new Vector3(side.offset.x, side.offset.y, side.offset.z).multiplyScalar(UNITS));
    finger.normalize(); normal.normalize();
    if (side.roll) finger.applyAxisAngle(normal, side.roll);
    return { point, finger, normal, pole: pole.normalize(), curl, shape: handShape };
  }

  private solve(side: Side, palmTarget: Vector3, finger: Vector3, normal: Vector3, pole: Vector3, w: number, curl: number, remember: (bone: Bone) => void, handShape?: HandShapeTable): void {
    // Round 11: a hand shape also writes the thumb (its joints are only in shapeJoints).
    const thumb = handShape ? side.shapeJoints.filter(j => j.finger === 0).map(j => j.bone) : [];
    const bones = [side.upper, side.twistUpper, side.elbow, side.twist, side.wrist, ...side.fingerBones, ...thumb].filter((b): b is Bone => !!b);
    for (const bone of bones) remember(bone);
    const original = bones.map(b => b.quaternion.clone());
    // The hand's wanted world rotation: its rest axes (finger, across) onto the wanted ones (finger, across = palm × finger with the pad side toward `normal`).
    // Both bases right-handed (finger, pads, finger × pads), so the map is a rotation for either hand: rest pads → `normal`.
    const handWorld = handRotation(side, finger, normal);
    // Palm centre in hand-local (0.55 of the way to the knuckles, ~1 cm toward the pads): the wrist goes where that lands.
    const palmOffset = side.palmRest.clone().applyQuaternion(handWorld);
    const wristTarget = palmTarget.clone().sub(palmOffset);

    // Two bones as a real arm: the elbow is a hinge (it only bends, forward), so its bend comes from the distance alone; then the
    // whole bent arm is turned at the shoulder so the wrist lands on the target and the elbow points along the pole. No
    // shortest-arc guesses, so the upper arm's roll is defined everywhere and moves continuously.
    if (side.twistUpper) side.twistUpper.quaternion.identity();
    if (side.twist) side.twist.quaternion.identity();
    const S = side.upper.getWorldPosition(new Vector3());
    const d0 = wristTarget.clone().sub(S), dist = Math.min((side.l1 + side.l2) * 0.995, Math.max(Math.abs(side.l1 - side.l2) + 1e-3, d0.length()));
    const dir = d0.lengthSq() > 1e-12 ? d0.normalize() : new Vector3(0, -1, 0);
    const cosInner = (side.l1 * side.l1 + side.l2 * side.l2 - dist * dist) / (2 * side.l1 * side.l2);
    const bend = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosInner)));
    const hinge = new Quaternion().setFromAxisAngle(side.hinge, bend);
    side.elbow.quaternion.copy(hinge);
    // The bent arm in the upper arm's own frame (rest axes): shoulder → elbow, shoulder → wrist.
    const elbowLocal = side.upperRest.clone(), wristLocal = side.upperRest.clone().add(side.foreRest.clone().applyQuaternion(hinge));
    const a1 = wristLocal.clone().normalize(), a2 = elbowLocal.clone().addScaledVector(a1, -elbowLocal.dot(a1)).normalize();
    const p = pole.clone().addScaledVector(dir, -pole.dot(dir));
    if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(dir, -dir.y);
    p.normalize();
    const have = new Matrix4().makeBasis(a1, a2, new Vector3().crossVectors(a1, a2));
    const want = new Matrix4().makeBasis(dir, p, new Vector3().crossVectors(dir, p));
    const upperWorld = new Quaternion().setFromRotationMatrix(want.multiply(have.transpose()));
    const parentUpper = side.upper.parent ? side.upper.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
    side.upper.quaternion.copy(parentUpper.invert().multiply(upperWorld));
    side.upper.updateMatrixWorld(true);
    // The hand: its wanted world rotation, the forearm twist bone taking half of the twist about the forearm.
    const parentQ = side.wrist.parent!.getWorldQuaternion(new Quaternion());
    let local = parentQ.clone().invert().multiply(handWorld);
    if (side.twist) {
      // The whole twist about the forearm goes to the forearm twist bone (made for it); the wrist keeps only its bend, so blending
      // the wrist from the motion's pose never swings through a half turn.
      const axis = side.wrist.position.clone().normalize();
      // The twist: how far the palm has to turn about the forearm, measured between the palm's normal with no twist and the
      // wanted one, both seen along the forearm (well defined unless the palm faces along the forearm, which no pose asks for;
      // a swing-twist split of the wrist's rotation is not, near a half-turn swing).
      const forearm = side.wrist.getWorldPosition(new Vector3()).sub(side.elbow.getWorldPosition(new Vector3())).normalize();
      const palmNow = side.palmLocal.clone().applyQuaternion(parentQ);
      const p0 = palmNow.addScaledVector(forearm, -palmNow.dot(forearm)), p1 = normal.clone().addScaledVector(forearm, -normal.dot(forearm));
      let angle = Math.atan2(forearm.dot(new Vector3().crossVectors(p0, p1)), p0.dot(p1));
      // Unwrapped against last frame's (passing a half turn never flips it to the other side) and held within what a forearm can
      // turn (±110°); past that the wrist takes the rest.
      if (side.twistAngle !== null) while (angle - side.twistAngle > Math.PI) angle -= 2 * Math.PI;
      if (side.twistAngle !== null) while (angle - side.twistAngle < -Math.PI) angle += 2 * Math.PI;
      side.twistAngle = angle;
      const held = Math.max(-TWIST_MAX, Math.min(TWIST_MAX, angle));
      side.twist.quaternion.multiply(new Quaternion().setFromAxisAngle(axis, held));
      side.twist.updateMatrixWorld(true);
      local = side.wrist.parent!.getWorldQuaternion(new Quaternion()).invert().multiply(handWorld);
    }
    side.wrist.quaternion.copy(local);
    // Fingers: straighter for an open palm (their rest is straight).
    const solved = bones.map(b => b.quaternion.clone());
    const shaped = handShape ?? null;
    bones.forEach((bone, i) => {
      const f = side.fingerBones.indexOf(bone);
      const joint = shaped ? side.shapeJoints.find(j => j.bone === bone) : undefined;
      if (shaped && joint) {
        // Round 11: this joint's place in the hand shape (spread, then curl about its own axes), from the motion's own by w.
        const [c, sp] = (joint.finger === 0 ? shaped.thumb : shaped.fingers[joint.finger - 1])[Math.min(joint.joint, 2)];
        const goal = new Quaternion().setFromAxisAngle(joint.spread, sp * Math.PI / 180).multiply(new Quaternion().setFromAxisAngle(joint.curl, c * Math.PI / 180));
        bone.quaternion.copy(original[i]).slerp(goal, w);
      } else if (f >= 0) {
        // Fingers: straighter (their rest is straight) or curled toward the pads, each joint by its share; from the motion's own by w.
        bone.quaternion.copy(original[i]).slerp(curl < 0 ? new Quaternion() : new Quaternion().setFromAxisAngle(side.curlAxis, curl * CURL_RAD * [0.6, 1, 0.8][f % 3]), Math.abs(curl) * w);
      } else bone.quaternion.copy(original[i]).slerp(solved[i], w);
    });
    side.upper.updateMatrixWorld(true);
  }
}

/**
 * The hand's rotation: its rest axes (finger, pads) onto the wanted ones. Both bases right-handed (finger, pads, finger × pads), so the
 * map is a rotation for either hand. In the frame `finger` and `normal` are given in (world for solve, the chest's for aimGoal).
 */
function handRotation(side: Side, finger: Vector3, normal: Vector3): Quaternion {
  const restPalm = side.palmLocal.clone().addScaledVector(side.fingerLocal, -side.palmLocal.dot(side.fingerLocal)).normalize();
  const restBasis = new Matrix4().makeBasis(side.fingerLocal, restPalm, new Vector3().crossVectors(side.fingerLocal, restPalm));
  const wantBasis = new Matrix4().makeBasis(finger, normal, new Vector3().crossVectors(finger, normal));
  return new Quaternion().setFromRotationMatrix(wantBasis.multiply(restBasis.transpose()));
}

/**
 * 'aim' (I-154 batch 4): the designed arm as this side's goal, in the chest frame from the shoulder (units): the wrist at
 * upper·l1 + fore·l2, the palm's centre past it as the hand is turned, the elbow pointing along `upper`, the hand shape as handed.
 */
function aimGoal(side: Side): { point: Vector3; finger: Vector3; normal: Vector3; pole: Vector3; curl: number; shape?: HandShapeTable } | null {
  const a = side.aim;
  if (!a) return null;
  const unit = (v: V3) => { const out = new Vector3(v.x, v.y, v.z); return Number.isFinite(out.lengthSq()) && out.lengthSq() > 1e-12 ? out.normalize() : null; };
  const upper = unit(a.upper), fore = unit(a.fore), finger = unit(a.hand), pads = unit(a.palm);
  if (!upper || !fore || !finger || !pads) return null;
  const normal = pads.addScaledVector(finger, -pads.dot(finger));
  if (normal.lengthSq() < 1e-8) return null;
  normal.normalize();
  const point = upper.clone().multiplyScalar(side.l1).addScaledVector(fore, side.l2).add(side.palmRest.clone().applyQuaternion(handRotation(side, finger, normal)));
  return { point, finger, normal, pole: upper, curl: 0, shape: side.fingers ?? undefined };
}

/** The rotation taking x to `finger` and y to `normal` (made orthogonal to it). */
function frameOf(finger: Vector3, normal: Vector3): Quaternion {
  const f = finger.clone().normalize(), n = normal.clone().addScaledVector(f, -normal.dot(f)).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(f, n, new Vector3().crossVectors(f, n)));
}
