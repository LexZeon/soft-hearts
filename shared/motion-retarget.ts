/**
 * VMD retargeting, adaptation layer step 2 (handbook/roadmap.md, "任意模型都好用").
 *
 * Converts parsed VMD data authored for a source model (the bundled Gene, whose
 * rig ships as shared/retarget-gene-source.json) into VMD data for a target
 * model, using both model profiles (shared/model-profile.ts). The output is
 * still VMD data, so MMDLoader's own AnimationBuilder turns it into the target's
 * AnimationClip with the authored Bézier curves intact. Pure math on plain
 * arrays: no Three, no file access, the input is never mutated and the VMD bytes
 * on disk are never touched.
 *
 * Rest-pose correction. MMD bones carry no rest rotation: a bone's world
 * rotation is the product of the VMD rotations along its chain, W_b = W_p · q_b,
 * and its rest direction d_b (bone to child joint) is fixed by the joint
 * positions. The same pose on two models means each segment points the same way
 * in the world: W_b^T · d_b^T = W_b^S · d_b^S. With the rest alignment
 * A_b = arc(d_b^T → d_b^S) (A_b d^T = d^S) choose W_b^T = W_b^S · A_b; then
 *   q_b^T = (W_p^T)⁻¹ W_b^T = (W_p^S A_p)⁻¹ W_p^S q_b^S A_b = A_p⁻¹ · q_b^S · A_b.
 * In the "rest-orientation" notation R (canonical frame → rest bone frame),
 * A = R_s · R_t⁻¹, so this is q_t = (R_t,p R_s,p⁻¹) q_s (R_s,b R_t,b⁻¹); for a bone
 * whose parent needs no correction it reduces to q_t = q_s · R_s R_t⁻¹.
 * The arm chain is aligned by direction (A vs T pose is a rest convention, not design);
 * the torso, neck, head and legs keep their own design rest (A = identity), and
 * bones below an aligned bone (twist bones) inherit their parent's A,
 * so their rotations are conjugated (q_t = A⁻¹ q_s A). Universal skeleton step 3: the
 * wrist and every finger joint get their own A from full rest frames (direction plus
 * the palm's roll, shared/hand-alignment.ts), so a palm or finger that rests another
 * way than Gene's still bends toward the palm. Left/right multiplying
 * every key by a constant unit quaternion commutes with slerp, so per-key
 * correction is exact for the authored interpolation.
 */
import type { ModelProfile } from './model-profile';
import {
  FINGER_JOINTS, FINGER_SLOTS, STANDARD_BONES, STANDARD_POSE, fingerSlotOfName, standardParents, structureDifferences,
  type FingerSlot, type MorphSlot, type SlotPolicy, type StandardBone, type StandardPoseFinger, type StructureDifference, type Vec3,
} from './universal-skeleton';
import { COLLISION_PROXY_VERSION, acceptCollisionProxy, type CollisionProxy } from './collision-proxy';
import { handRestFramePairs, tipOf, type HandPart } from './hand-alignment';

export const RETARGET_VERSION = 1;
/**
 * The conversion's own version (cache keys), separate from RETARGET_VERSION, which is the CompactRig schema of the shipped
 * source rig. 2 (T-213): finger tracks follow the profile's finger joints; the identity needs the same standard skeleton.
 * 3 (universal skeleton step 3): each hand and finger joint is aligned by its rest frame (shared/hand-alignment.ts), the palm's
 * roll included, instead of riding along with the forearm; a finger joint a motion leaves out stays at rest.
 * 4 (universal skeleton step 4): a library motion whose hands touch (shared/motion-contact.ts: 鼓掌, 比心) has its arms moved
 * so the hands meet as on Gene (shared/motion-fit.ts adaptMotion runs the fit right after this conversion).
 */
export const RETARGET_ALGORITHM_VERSION = 4;
/**
 * Face slots the profile finds for the face actions only, never used to route a library motion's morph track (universal
 * skeleton step 2: 嘟嘴). Gene's own motions carry a "mouthPucker" track; on another model it still goes by its exact name,
 * as before (routing it through the slot would calibrate and rename it: a conversion change of its own, with its own version).
 * Left out of every rig, so the shipped standard pose and every conversion stay what they were.
 */
export const PROFILE_ONLY_MORPH_SLOTS: readonly MorphSlot[] = Object.freeze(['mouthPucker']);

// ---------------------------------------------------------------- quaternions ([x, y, z, w], Three's convention)

export type Quat = [number, number, number, number];
const IDENTITY: Readonly<Quat> = [0, 0, 0, 1];
export function qmul(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qconj = (q: Readonly<Quat>): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qnormalize(q: Readonly<Quat>): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length > 0 ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length] : [0, 0, 0, 1];
}
export function qrotate(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
/** Rotation angle in radians (0..π). */
export const qangle = (q: Readonly<Quat>) => 2 * Math.acos(Math.min(1, Math.abs(q[3]) / (Math.hypot(q[0], q[1], q[2], q[3]) || 1)));
export function qaxisAngle(axis: Readonly<Vec3>, angle: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1, s = Math.sin(angle / 2) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}
/** Shortest rotation taking unit-ish u onto v (Three's setFromUnitVectors). */
export function qarc(u: Readonly<Vec3>, v: Readonly<Vec3>): Quat {
  const a = vnormalize(u), b = vnormalize(v), r = vdot(a, b) + 1;
  if (r < 1e-6) {
    const axis: Vec3 = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0] : [0, -a[2], a[1]];
    return qnormalize([axis[0], axis[1], axis[2], 0]);
  }
  return qnormalize([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], r]);
}
/** Three's Quaternion.slerpFlat (shortest path; plain lerp when nearly equal). */
export function qslerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  if (t <= 0) return [a[0], a[1], a[2], a[3]];
  if (t >= 1) return [b[0], b[1], b[2], b[3]];
  let s = 1 - t;
  const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], dir = cos >= 0 ? 1 : -1, sqrSin = 1 - cos * cos;
  if (sqrSin > Number.EPSILON) {
    const sin = Math.sqrt(sqrSin), len = Math.atan2(sin, cos * dir);
    s = Math.sin(s * len) / sin; t = Math.sin(t * len) / sin;
  }
  const tDir = t * dir;
  const out: Quat = [a[0] * s + b[0] * tDir, a[1] * s + b[1] * tDir, a[2] * s + b[2] * tDir, a[3] * s + b[3] * tDir];
  return s === 1 - t ? qnormalize(out) : out;
}
/** Rotation whose matrix has the given orthonormal columns. */
export function qbasis(x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>): Quat {
  const m11 = x[0], m12 = y[0], m13 = z[0], m21 = x[1], m22 = y[1], m23 = z[1], m31 = x[2], m32 = y[2], m33 = z[2];
  const trace = m11 + m22 + m33;
  if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); return qnormalize([(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]); }
  if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return qnormalize([0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]); }
  if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return qnormalize([(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]); }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return qnormalize([(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]);
}

export const vadd = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlength = (a: Readonly<Vec3>) => Math.hypot(a[0], a[1], a[2]);
export function vnormalize(a: Readonly<Vec3>): Vec3 { const length = vlength(a); return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0]; }

// ---------------------------------------------------------------- rigs

export interface RigBone { name: string; parent: number; position: Vec3 }
export interface RigMorphSlot { name: string; amplitude: number; policy: SlotPolicy }
/** What retargeting needs from a model: its hierarchy at rest, standard-bone slots, proportions and semantic morphs. */
export interface RetargetRig {
  /** Content identity (model hash or "gene:<sha>"): cache key half. */
  key: string;
  bones: RigBone[];
  slots: Partial<Record<StandardBone, number>>;
  height: number;
  legLength: number | null;
  armLength: number | null;
  shoulderWidth: number | null;
  headSize: number;
  morphSlots: Partial<Record<MorphSlot, RigMorphSlot>>;
  morphNames: string[];
  /** Fitted body capsules (model profile); absent/null: the quality check uses its rough body approximation. */
  collision?: CollisionProxy | null;
  /**
   * T-213: finger joints (the profile's, unique names, in joint order under the wrist) the source's finger tracks land on when
   * the target names them differently (RightIndex1, 右人指1 for 右人指１). Absent: finger tracks bind by exact name only.
   */
  fingers?: Partial<Record<FingerSlot, number>>;
}

/** A finger track's joint (MMD numbering) from its name: the universal skeleton's reader (shared/universal-skeleton.ts). */
export { fingerSlotOfName };

/** The profile's proxy, only if every capsule rides a bone this rig maps. */
function rigCollision(proxy: CollisionProxy | null | undefined, slots: RetargetRig['slots']): CollisionProxy | null {
  if (!proxy || proxy.version !== COLLISION_PROXY_VERSION || !proxy.capsules.every(capsule => slots[capsule.bone] !== undefined)) return null;
  return structuredClone(proxy);
}

export function buildRetargetRig(input: { key: string; profile: ModelProfile; bones: readonly RigBone[]; morphNames: readonly string[] }): RetargetRig {
  const { profile } = input;
  const bones = input.bones.map(bone => ({ name: bone.name, parent: Number.isInteger(bone.parent) && bone.parent >= 0 && bone.parent < input.bones.length ? bone.parent : -1,
    position: [bone.position[0], bone.position[1], bone.position[2]] as Vec3 }));
  const slots: RetargetRig['slots'] = {};
  for (const slot of STANDARD_BONES) {
    const entry = profile.bones.map[slot];
    if (entry && bones[entry.index]?.name === entry.name) slots[slot] = entry.index;
  }
  const morphSlots: RetargetRig['morphSlots'] = {};
  for (const [slot, entry] of Object.entries(profile.morphs) as [MorphSlot, ModelProfile['morphs'][MorphSlot]][])
    if (entry.index >= 0 && entry.name !== null && !PROFILE_ONLY_MORPH_SLOTS.includes(slot)) morphSlots[slot] = { name: entry.name, amplitude: entry.amplitude, policy: entry.policy };
  const fingers: RetargetRig['fingers'] = {};
  for (const slot of FINGER_SLOTS) {
    const entry = profile.bones.fingers?.[slot];
    if (entry && bones[entry.index]?.name === entry.name) fingers[slot] = entry.index;
  }
  const p = profile.proportions;
  return { key: input.key, bones, slots, height: p.height, legLength: p.legLength, armLength: p.armLength, shoulderWidth: p.shoulderWidth,
    headSize: p.headSize, morphSlots, morphNames: [...input.morphNames], collision: rigCollision(profile.collision, slots), fingers };
}

/** Plain JSON form of a source rig: only the standard bones (parent = nearest standard ancestor), rounded. */
export interface CompactRig {
  version: typeof RETARGET_VERSION;
  key: string;
  bones: { slot: StandardBone; name: string; parent: number; position: Vec3 }[];
  height: number; legLength: number | null; armLength: number | null; shoulderWidth: number | null; headSize: number;
  morphSlots: Partial<Record<MorphSlot, RigMorphSlot>>;
  /** Capsules ride standard bones by slot name, so the compact rig carries them unchanged (plain JSON, validated when read). */
  collision?: unknown;
  /**
   * Universal skeleton step 3: the finger joints (by slot) and each finger's tip (slot null), parents indexing [...bones, ...fingers].
   * The hand alignment needs them; absent: a rig without fingers (its hands ride along with the forearm, as before).
   */
  fingers?: StandardPoseFinger[];
}
const round6 = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
const roundOrNull = (value: number | null) => value === null ? null : round6(value);
/** The rig's finger joints and the tips past each finger's last joint, in FINGER_SLOTS order (parents first); undefined without fingers. */
function compactFingers(rig: RetargetRig, compact: Map<number, number>): StandardPoseFinger[] | undefined {
  const out: StandardPoseFinger[] = [], at = new Map(compact), base = compact.size;
  const parentOf = (index: number) => {
    let parent = rig.bones[index].parent;
    for (let steps = 0; parent >= 0 && !at.has(parent) && steps <= rig.bones.length; steps++) parent = rig.bones[parent].parent;
    return parent >= 0 && at.has(parent) ? at.get(parent)! : -1;
  };
  const add = (slot: FingerSlot | null, index: number) => {
    const parent = parentOf(index);
    at.set(index, base + out.length);
    out.push({ slot, name: rig.bones[index].name, parent, position: rig.bones[index].position.map(round6) as Vec3 });
  };
  for (const slot of FINGER_SLOTS) {
    const index = rig.fingers?.[slot];
    if (index === undefined || at.has(index)) continue;
    add(slot, index);
    const finger = (Object.keys(FINGER_JOINTS) as (keyof typeof FINGER_JOINTS)[]).find(name => slot.startsWith(name))!;
    if (!slot.startsWith(`${finger}${FINGER_JOINTS[finger][FINGER_JOINTS[finger].length - 1]}`)) continue;
    const tip = tipOf(rig, index, finger, slot.endsWith('Left') ? 'left' : 'right');
    if (tip !== null && !at.has(tip)) add(null, tip);
  }
  return out.length ? out : undefined;
}
export function compactRig(rig: RetargetRig): CompactRig {
  const order = STANDARD_BONES.filter(slot => rig.slots[slot] !== undefined);
  const slotOf = new Map(order.map(slot => [rig.slots[slot]!, slot]));
  const bones = order.map(slot => {
    let parent = rig.bones[rig.slots[slot]!].parent;
    while (parent >= 0 && !slotOf.has(parent)) parent = rig.bones[parent].parent;
    const bone = rig.bones[rig.slots[slot]!];
    return { slot, name: bone.name, parent: parent >= 0 ? order.indexOf(slotOf.get(parent)!) : -1, position: bone.position.map(round6) as Vec3 };
  });
  const morphSlots: CompactRig['morphSlots'] = {};
  for (const [slot, entry] of Object.entries(rig.morphSlots) as [MorphSlot, RigMorphSlot][]) morphSlots[slot] = { name: entry.name, amplitude: round6(entry.amplitude), policy: entry.policy };
  const fingers = compactFingers(rig, new Map(order.map((slot, index) => [rig.slots[slot]!, index])));
  return { version: RETARGET_VERSION, key: rig.key, bones, height: round6(rig.height), legLength: roundOrNull(rig.legLength), armLength: roundOrNull(rig.armLength),
    shoulderWidth: roundOrNull(rig.shoulderWidth), headSize: round6(rig.headSize), morphSlots, collision: rig.collision ? structuredClone(rig.collision) : null,
    ...(fingers ? { fingers } : {}) };
}
export function rigFromCompact(compact: CompactRig): RetargetRig {
  const slots: RetargetRig['slots'] = {};
  compact.bones.forEach((bone, index) => { slots[bone.slot] = index; });
  const rows = Array.isArray(compact.fingers) ? compact.fingers : [];
  const fingers: RetargetRig['fingers'] = {};
  rows.forEach((row, index) => { if (row.slot) fingers[row.slot] = compact.bones.length + index; });
  return { key: compact.key, bones: [...compact.bones, ...rows].map(bone => ({ name: bone.name, parent: bone.parent, position: [...bone.position] as Vec3 })), slots,
    height: compact.height, legLength: compact.legLength, armLength: compact.armLength, shoulderWidth: compact.shoulderWidth, headSize: compact.headSize,
    morphSlots: structuredClone(compact.morphSlots), morphNames: Object.values(compact.morphSlots).map(entry => entry!.name),
    collision: rigCollision(acceptCollisionProxy(compact.collision, slot => slots[slot] !== undefined), slots), ...(rows.length ? { fingers } : {}) };
}
/**
 * The source rig of every library motion: the universal skeleton's standard pose (Gene's rest skeleton, the one the motions were
 * authored and reviewed on; shared/universal-skeleton.ts STANDARD_POSE).
 */
export const STANDARD_SOURCE_RIG: RetargetRig = rigFromCompact(STANDARD_POSE as CompactRig);

// ---------------------------------------------------------------- tracks and sampling

export interface VmdBoneFrameLike { boneName: string; frameNum: number; position: ArrayLike<number>; rotation: ArrayLike<number>; interpolation?: ArrayLike<number> }
export interface VmdMorphFrameLike { morphName: string; frameNum: number; weight: number }
export interface VmdLike { metadata: { motionCount: number; morphCount: number }; motions: readonly VmdBoneFrameLike[]; morphs: readonly VmdMorphFrameLike[] }

export interface TrackKey { frame: number; p: Vec3; q: Quat; interp: ArrayLike<number> }
export type Tracks = Map<number, TrackKey[]>;
/** x1 = y1 = 20, x2 = y2 = 107 on every channel: a straight line (MMD's default). */
export const LINEAR_INTERPOLATION: readonly number[] = Object.freeze(Array.from({ length: 64 }, (_, index) => (index % 16) < 8 ? 20 : 107));

/** MMDLoader's CubicBezierInterpolation._calculate: bisection on x, then y. */
function bezier(x1: number, x2: number, y1: number, y2: number, x: number): number {
  let c = 0.5, t = c, s = 1 - t, sst3 = 0, stt3 = 0, ttt = 0;
  for (let i = 0; i < 15; i++) {
    sst3 = 3 * s * s * t; stt3 = 3 * s * t * t; ttt = t * t * t;
    const ft = sst3 * x1 + stt3 * x2 + ttt - x;
    if (Math.abs(ft) < 1e-5) break;
    c /= 2; t += ft < 0 ? c : -c; s = 1 - t;
  }
  return sst3 * y1 + stt3 * y2 + ttt;
}
const channelRatio = (interp: ArrayLike<number>, channel: number, weight: number) =>
  bezier((interp[channel] ?? 20) / 127, (interp[channel + 8] ?? 107) / 127, (interp[channel + 4] ?? 20) / 127, (interp[channel + 12] ?? 107) / 127, weight);

/** Value of a track at a (fractional) frame, as MMDLoader plays it (segment curve from the later key; < 1.5 frames apart holds). */
export function sampleTrack(keys: readonly TrackKey[], frame: number): { p: Vec3; q: Quat } {
  if (!keys.length) return { p: [0, 0, 0], q: [0, 0, 0, 1] };
  if (frame <= keys[0].frame) return { p: [...keys[0].p], q: [...keys[0].q] };
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return { p: [...last.p], q: [...last.q] };
  let low = 0, high = keys.length - 1;
  while (high - low > 1) { const mid = (low + high) >> 1; if (keys[mid].frame <= frame) low = mid; else high = mid; }
  const a = keys[low], b = keys[high], span = b.frame - a.frame;
  const weight = span < 1.5 ? 0 : (frame - a.frame) / span;
  const p: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) { const r = channelRatio(b.interp, c, weight); p[c] = a.p[c] * (1 - r) + b.p[c] * r; }
  return { p, q: qslerp(a.q, b.q, channelRatio(b.interp, 3, weight)) };
}

function constantTrack(keys: readonly TrackKey[]): boolean {
  const first = keys[0];
  return keys.every(key => key.p.every((value, c) => value === first.p[c]) && key.q.every((value, c) => value === first.q[c]));
}

/** Frames to bake a combination at: stride 2 (MMD holds keys < 1.5 frames apart), ending exactly on `end`. */
function bakeFrames(start: number, end: number): number[] {
  const frames: number[] = [];
  for (let frame = start; frame < end; frame += 2) frames.push(frame);
  if (frames.length && end - frames[frames.length - 1] < 2 && frames.length > 1) frames.pop();
  frames.push(end);
  return [...new Set(frames)];
}

/** Groups parsed bone frames by name, sorted by frame (stable), with unit quaternions. */
export function groupBoneFrames(motions: readonly VmdBoneFrameLike[]): Map<string, TrackKey[]> {
  const tracks = new Map<string, TrackKey[]>();
  for (const frame of motions) {
    const list = tracks.get(frame.boneName) ?? [];
    list.push({ frame: frame.frameNum, p: [frame.position[0], frame.position[1], frame.position[2]],
      q: [frame.rotation[0], frame.rotation[1], frame.rotation[2], frame.rotation[3]], interp: frame.interpolation ?? LINEAR_INTERPOLATION });
    tracks.set(frame.boneName, list);
  }
  for (const list of tracks.values()) list.sort((a, b) => a.frame - b.frame);
  return tracks;
}

/** A VMD as it plays on the model it was made for: tracks bound by exact bone name. */
export function tracksOnRig(vmd: VmdLike, rig: RetargetRig): Tracks {
  const byName = new Map<string, number>();
  rig.bones.forEach((bone, index) => { if (!byName.has(bone.name)) byName.set(bone.name, index); });
  const tracks: Tracks = new Map();
  for (const [name, keys] of groupBoneFrames(vmd.motions)) { const index = byName.get(name); if (index !== undefined) tracks.set(index, keys); }
  return tracks;
}

// ---------------------------------------------------------------- forward kinematics and leg IK

export interface Pose { wq: Quat[]; wp: Vec3[]; lq: Quat[] }
/** World rotation/position of every bone (rest rotations are identity in MMD). */
export function evaluatePose(rig: RetargetRig, tracks: Tracks, frame: number): Pose {
  const count = rig.bones.length, wq: Quat[] = new Array(count), wp: Vec3[] = new Array(count), lq: Quat[] = new Array(count);
  const state = new Uint8Array(count);
  const visit = (index: number): void => {
    if (state[index] === 2) return;
    if (state[index] === 1) { wq[index] = [0, 0, 0, 1]; wp[index] = [...rig.bones[index].position]; state[index] = 2; return; } // cycle guard
    state[index] = 1;
    const bone = rig.bones[index], keys = tracks.get(index);
    const local = keys ? sampleTrack(keys, frame) : { p: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as Quat };
    lq[index] = local.q;
    if (bone.parent >= 0) {
      visit(bone.parent);
      const parent = rig.bones[bone.parent];
      const offset = vadd(vsub(bone.position, parent.position), local.p);
      wp[index] = vadd(wp[bone.parent], qrotate(wq[bone.parent], offset));
      wq[index] = qmul(wq[bone.parent], local.q);
    } else { wp[index] = vadd(bone.position, local.p); wq[index] = local.q; }
    state[index] = 2;
  };
  for (let index = 0; index < count; index++) visit(index);
  return { wq, wp, lq };
}

/**
 * Two-bone leg: hip H, target T, thigh/shin lengths. The knee bends toward
 * `pole` (the pelvis forward). Unreachable targets are clamped at full reach.
 */
export function solveTwoBone(H: Readonly<Vec3>, T: Readonly<Vec3>, thigh: number, shin: number, pole: Readonly<Vec3>): { knee: Vec3; ankle: Vec3; reach: number } {
  const toTarget = vsub(T, H), distance = vlength(toTarget), total = thigh + shin;
  const reach = total > 0 ? distance / total : 0;
  const u: Vec3 = distance > 1e-9 ? vscale(toTarget, 1 / distance) : [0, -1, 0];
  const d = Math.min(Math.max(distance, Math.abs(thigh - shin) + 1e-6), total * (1 - 1e-9));
  const along = (thigh * thigh - shin * shin + d * d) / (2 * d), side = Math.sqrt(Math.max(0, thigh * thigh - along * along));
  let n = vsub(pole, vscale(u, vdot(pole, u)));
  if (vlength(n) < 1e-9) n = Math.abs(u[2]) < 0.9 ? vsub([0, 0, 1], vscale(u, u[2])) : vsub([0, 1, 0], vscale(u, u[1]));
  n = vnormalize(n);
  const knee = vadd(vadd(H, vscale(u, along)), vscale(n, side));
  return { knee, ankle: vadd(H, vscale(u, d)), reach };
}

/** Local leg/knee rotations that put the ankle on `target` (rest frames: hip→knee down, knee bend forward). */
export function legRotations(rig: RetargetRig, side: 'Left' | 'Right', pose: Pose, target: Readonly<Vec3>): { leg: Quat; knee: Quat; ankle: Quat; reach: number } | null {
  const leg = rig.slots[`leg${side}`], knee = rig.slots[`knee${side}`], ankle = rig.slots[`ankle${side}`];
  if (leg === undefined || knee === undefined || ankle === undefined) return null;
  const parent = rig.bones[leg].parent, parentQ = parent >= 0 ? pose.wq[parent] : IDENTITY as Quat;
  const restH = rig.bones[leg].position, restK = rig.bones[knee].position, restA = rig.bones[ankle].position;
  const thigh = vlength(vsub(restK, restH)), shin = vlength(vsub(restA, restK));
  if (!(thigh > 0 && shin > 0)) return null;
  const H = pose.wp[leg], forward = qrotate(parentQ, [0, 0, 1]);
  const solved = solveTwoBone(H, target, thigh, shin, forward);
  // Thigh frame: rest (thigh dir, forward ⟂ thigh) onto posed (thigh dir, knee-forward ⟂ thigh).
  const t0 = vnormalize(vsub(restK, restH)), f0 = vnormalize(vsub([0, 0, 1], vscale(t0, t0[2])));
  const t1 = vnormalize(vsub(solved.knee, H));
  let f1 = vsub(forward, vscale(t1, vdot(forward, t1)));
  f1 = vlength(f1) > 1e-9 ? vnormalize(f1) : f0;
  const worldLeg = qmul(qbasis(t1, f1, vcross(t1, f1)), qconj(qbasis(t0, f0, vcross(t0, f0))));
  const legLocal = qnormalize(qmul(qconj(parentQ), worldLeg));
  const shinRest = vnormalize(vsub(restA, restK)), shinWorld = vnormalize(vsub(solved.ankle, solved.knee));
  const kneeLocal = qarc(shinRest, qrotate(qconj(worldLeg), shinWorld));
  // The foot keeps the root's orientation (flat), as the source's toe IK holds it at rest.
  const root = rig.slots.root ?? rig.slots.center;
  const footWorld = root !== undefined ? pose.wq[root] : IDENTITY as Quat;
  const ankleLocal = qnormalize(qmul(qconj(qmul(worldLeg, kneeLocal)), footWorld));
  return { leg: legLocal, knee: kneeLocal, ankle: ankleLocal, reach: solved.reach };
}

/** IK target world position: the IK bone (or, without one, the ankle's rest point) moved by its track, under the root. */
export function ikTarget(rig: RetargetRig, side: 'Left' | 'Right', pose: Pose, ikKeys: readonly TrackKey[] | undefined, frame: number): Vec3 | null {
  const ik = rig.slots[`legIk${side}`];
  if (ik !== undefined && !ikKeys) return pose.wp[ik];
  const ankle = rig.slots[`ankle${side}`];
  if (ankle === undefined) return null;
  const offset = ikKeys ? sampleTrack(ikKeys, frame).p : [0, 0, 0] as Vec3;
  const root = rig.slots.root;
  const base = vadd(rig.bones[ankle].position, offset);
  return root !== undefined ? vadd(pose.wp[root], qrotate(pose.wq[root], vsub(base, rig.bones[root].position))) : base;
}

// ---------------------------------------------------------------- plan

/** Arm chain: aligned by rest direction toward the named child joint. Everything else inherits its parent's alignment. */
const ALIGNED: readonly [StandardBone, StandardBone][] = [['armLeft', 'elbowLeft'], ['elbowLeft', 'wristLeft'], ['armRight', 'elbowRight'], ['elbowRight', 'wristRight']];
/** Rest directions closer than this count as equal (exact identity for the same model). */
export const ALIGN_EPSILON_DEG = 0.5;
/** Where a source bone's motion goes when the target lacks that bone. parent: fold into the parent (q_p·q); child: into the child (q·q_c). */
const FALLBACKS: Partial<Record<StandardBone, { into: StandardBone[]; side: 'parent' | 'child' }>> = {
  armTwistLeft: { into: ['armLeft'], side: 'parent' }, armTwistRight: { into: ['armRight'], side: 'parent' },
  wristTwistLeft: { into: ['elbowLeft'], side: 'parent' }, wristTwistRight: { into: ['elbowRight'], side: 'parent' },
  groove: { into: ['center'], side: 'parent' },
  upperBody2: { into: ['upperBody'], side: 'parent' },
  waist: { into: ['upperBody', 'lowerBody'], side: 'child' },
  shoulderLeft: { into: ['armLeft'], side: 'child' }, shoulderRight: { into: ['armRight'], side: 'child' },
  neck: { into: ['head'], side: 'child' },
  lowerBody: { into: ['legLeft', 'legRight'], side: 'child' },
  root: { into: ['center'], side: 'child' },
  center: { into: ['upperBody', 'lowerBody'], side: 'child' },
};
const LEG_DRIVERS: readonly StandardBone[] = ['root', 'center', 'groove', 'waist', 'lowerBody', 'legIkLeft', 'legIkRight', 'legLeft', 'legRight', 'kneeLeft', 'kneeRight', 'ankleLeft', 'ankleRight'];

export type BoneRoute = { kind: 'bone'; target: number } | { kind: 'fold'; targets: number[]; side: 'parent' | 'child'; via: StandardBone[] }
  | { kind: 'ik'; side: 'Left' | 'Right' } | { kind: 'drop'; reason: string };
export interface MorphRoute { target: string; ratio: number; slot: MorphSlot | null }
export interface RetargetPlan {
  identity: boolean;
  source: RetargetRig;
  target: RetargetRig;
  /** Translation scale: target / source leg length (else height). */
  scale: number;
  /** Per target bone: rest alignment A (null = identity). */
  align: (Quat | null)[];
  /** Per source standard bone. */
  routes: Partial<Record<StandardBone, BoneRoute>>;
  /** Target lacks leg IK while the source has it: feet are re-solved into FK leg keys. */
  bakeLegIk: boolean;
  /** Aligned rest-angle difference per arm-chain slot, degrees (for reports). */
  alignedDeg: Partial<Record<StandardBone, number>>;
  /** Skeleton step 3: rest-frame difference per wrist and finger joint both rigs have (direction and palm roll), degrees. */
  handAlignedDeg?: Partial<Record<HandPart, number>>;
  /**
   * T-213: body bones that hang under another standard bone than in the source (e.g. the head under the center, not the
   * neck). Such a plan is never the identity; the quality check measures how far each such bone drifts from where the
   * source's hierarchy would carry it (shared/motion-fit.ts, 'structure') and holds back a motion that pulls it apart.
   */
  structure: StructureDifference[];
}

function topological(rig: RetargetRig): number[] {
  const order: number[] = [], state = new Uint8Array(rig.bones.length);
  const visit = (index: number) => {
    if (state[index]) return;
    state[index] = 1;
    const parent = rig.bones[index].parent;
    if (parent >= 0) visit(parent);
    order.push(index);
  };
  rig.bones.forEach((_, index) => visit(index));
  return order;
}

export function planRetarget(source: RetargetRig, target: RetargetRig): RetargetPlan {
  const ratio = source.legLength && target.legLength ? target.legLength / source.legLength : target.height / source.height;
  const scale = Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 1e-6 ? ratio : 1;
  const align: (Quat | null)[] = new Array(target.bones.length).fill(null);
  const alignedDeg: RetargetPlan['alignedDeg'] = {};
  const own = new Map<number, Quat | null>();
  for (const [slot, child] of ALIGNED) {
    const ts = target.slots[slot], tc = target.slots[child], ss = source.slots[slot], sc = source.slots[child];
    if (ts === undefined || tc === undefined || ss === undefined || sc === undefined) continue;
    const dT = vsub(target.bones[tc].position, target.bones[ts].position), dS = vsub(source.bones[sc].position, source.bones[ss].position);
    if (!(vlength(dT) > 0 && vlength(dS) > 0)) continue;
    const arc = qarc(dT, dS), degrees = qangle(arc) * 180 / Math.PI;
    alignedDeg[slot] = Math.round(degrees * 10) / 10;
    own.set(ts, degrees < ALIGN_EPSILON_DEG ? null : arc);
  }
  // Skeleton step 3: the hand and each finger joint by its full rest frame, A = F_source · F_targetᵀ (the palm's roll included).
  const handAlignedDeg: NonNullable<RetargetPlan['handAlignedDeg']> = {};
  for (const pair of handRestFramePairs(source, target)) {
    const rest = qnormalize(qmul(qbasis(...pair.source), qconj(qbasis(...pair.target)))), degrees = qangle(rest) * 180 / Math.PI;
    handAlignedDeg[pair.part] = Math.round(degrees * 10) / 10;
    own.set(pair.bone, degrees < ALIGN_EPSILON_DEG ? null : rest);
  }
  for (const index of topological(target)) {
    const parent = target.bones[index].parent;
    align[index] = own.has(index) ? own.get(index)! : parent >= 0 ? align[parent] : null;
  }
  const routes: RetargetPlan['routes'] = {};
  const resolve = (slot: StandardBone, depth: number): BoneRoute => {
    const index = target.slots[slot];
    if (index !== undefined) return { kind: 'bone', target: index };
    if (slot === 'legIkLeft' || slot === 'legIkRight') return { kind: 'ik', side: slot === 'legIkLeft' ? 'Left' : 'Right' };
    const fallback = FALLBACKS[slot];
    if (!fallback || depth > 3) return { kind: 'drop', reason: 'target has no such bone' };
    const targets: number[] = [], via: StandardBone[] = [];
    for (const into of fallback.into) {
      const next = resolve(into, depth + 1);
      if (next.kind === 'bone') { targets.push(next.target); via.push(into); }
      else if (next.kind === 'fold' && next.side === fallback.side) { targets.push(...next.targets); via.push(...next.via); }
    }
    return targets.length ? { kind: 'fold', targets, side: fallback.side, via } : { kind: 'drop', reason: 'no fallback bone on target' };
  };
  for (const slot of STANDARD_BONES) if (source.slots[slot] !== undefined) routes[slot] = resolve(slot, 0);
  const bakeLegIk = (['Left', 'Right'] as const).some(side => source.slots[`legIk${side}`] !== undefined && target.slots[`legIk${side}`] === undefined
    && target.slots[`leg${side}`] !== undefined && target.slots[`knee${side}`] !== undefined && target.slots[`ankle${side}`] !== undefined);
  const sameNames = Object.entries(routes).every(([slot, route]) => route!.kind === 'bone'
    && target.bones[route!.target].name === source.bones[source.slots[slot as StandardBone]!].name);
  const sameMorphs = (Object.keys(source.morphSlots) as MorphSlot[]).every(slot => {
    const route = morphSlotRoute(source, target, slot);
    return route !== null && route.target === source.morphSlots[slot]!.name && route.ratio === 1;
  });
  const structure = structureDifferences(standardParents(source.bones, source.slots), standardParents(target.bones, target.slots));
  const identity = scale === 1 && align.every(value => value === null) && sameNames && !bakeLegIk && sameMorphs && !structure.length;
  return { identity, source, target, scale, align, routes, bakeLegIk, alignedDeg, handAlignedDeg, structure };
}

/**
 * The target with each re-parented body bone hung where the source's hierarchy has it (T-213): the same rest positions and
 * the same tracks, so the difference between this and the real target is exactly what the hierarchy change does to a pose.
 * null when the plan has no such bone.
 */
export function structureReference(plan: RetargetPlan): { rig: RetargetRig; bones: { slot: StandardBone; index: number; difference: StructureDifference }[] } | null {
  const { target } = plan, moved: { slot: StandardBone; index: number; difference: StructureDifference }[] = [];
  const bones = target.bones.map(bone => ({ ...bone, position: [...bone.position] as Vec3 }));
  for (const difference of plan.structure ?? []) {
    const index = target.slots[difference.bone], parent = difference.expected ? target.slots[difference.expected] : undefined;
    if (index === undefined) continue;
    bones[index].parent = parent ?? -1;
    moved.push({ slot: difference.bone, index, difference });
  }
  // A cycle could only come from a target whose standard bones already sit inside one another's chains: then no reference.
  for (const { index } of moved) {
    for (let at = bones[index].parent, steps = 0; at >= 0; at = bones[at].parent, steps++) if (at === index || steps > bones.length) return null;
  }
  return moved.length ? { rig: { ...target, bones }, bones: moved } : null;
}

/**
 * Whether this VMD plays on the target exactly as written (the identity fast path): the plan is the identity and none of
 * its finger tracks would land on a differently named joint (T-213: a model whose standard bones are Gene's but whose
 * fingers are named RightIndex1 still needs its finger tracks renamed).
 */
export function identityFor(vmd: VmdLike, plan: RetargetPlan): boolean {
  if (!plan.identity) return false;
  const fingers = plan.target.fingers ?? {};
  const seen = new Set<string>();
  for (const frame of vmd.motions) {
    if (seen.has(frame.boneName)) continue;
    seen.add(frame.boneName);
    const slot = fingerSlotOfName(frame.boneName), index = slot ? fingers[slot] : undefined;
    if (index !== undefined && plan.target.bones[index].name !== frame.boneName) return false;
  }
  return true;
}

/** Morph ratio keeps the visible amount: weight × source amplitude / target amplitude, bounded like the profile's calibration. */
export function morphSlotRoute(source: RetargetRig, target: RetargetRig, slot: MorphSlot): MorphRoute | null {
  const from = source.morphSlots[slot], to = target.morphSlots[slot];
  if (!from || !to) return null;
  let ratio = 1;
  if (from.policy === 'amplitude' && to.policy === 'amplitude' && from.amplitude > 0 && to.amplitude > 0) {
    ratio = Math.min(4, Math.max(0.25, from.amplitude / to.amplitude));
    if (Math.abs(ratio - 1) < 1e-3) ratio = 1; // rounding of the shipped source amplitudes; 0.1% is invisible
  }
  return { target: to.name, ratio, slot };
}

// ---------------------------------------------------------------- apply

export interface RetargetReport {
  identity: boolean;
  scale: number;
  alignedDeg: Partial<Record<StandardBone, number>>;
  renamed: number;
  folded: string[];
  droppedBones: string[];
  droppedMorphs: string[];
  mappedMorphs: Record<string, string>;
  bakedLegIk: boolean;
  /**
   * T-213: tracks of standard bones and finger joints that move in the source and land nowhere on this target (no such bone,
   * no fold, or a bone whose name another bone shares, which no clip track can bind). The motion still plays without them.
   */
  lost?: string[];
}

/** A track that actually moves something (not a constant rest key). */
function trackMoves(keys: readonly TrackKey[]): boolean {
  return keys.some(key => qangle(key.q) > 1e-3 || vlength(key.p) > 1e-4);
}

/** Standard and finger tracks of a VMD that move and that no unique-named target bone receives by exact name (the identity fast path). */
export function lostByName(vmd: VmdLike, source: RetargetRig, target: RetargetRig): string[] {
  const names = new Map<string, number>();
  for (const bone of target.bones) names.set(bone.name, (names.get(bone.name) ?? 0) + 1);
  const standard = new Set(Object.values(source.slots).map(index => source.bones[index!].name));
  const lost: string[] = [];
  for (const [name, keys] of groupBoneFrames(vmd.motions)) {
    if (!(standard.has(name) || fingerSlotOfName(name)) || names.get(name) === 1 || !trackMoves(keys)) continue;
    lost.push(name);
  }
  return lost;
}

/** Target-space result before it is written back as VMD frames (the quality check works on this). */
export interface RetargetedTracks {
  tracks: Tracks;
  morphs: Map<string, VmdMorphFrameLike[]>;
  lastFrame: number;
  report: RetargetReport;
}

function combine(base: TrackKey[] | undefined, extra: TrackKey[], side: 'parent' | 'child', lastFrame: number): TrackKey[] {
  // parent: extra is the folded child (C = base ∘ extra); child: extra is the folded parent (C = extra ∘ base).
  const compose = (a: { p: Vec3; q: Quat }, b: { p: Vec3; q: Quat }) => side === 'parent'
    ? { p: vadd(a.p, qrotate(a.q, b.p)), q: qnormalize(qmul(a.q, b.q)) }
    : { p: vadd(b.p, qrotate(b.q, a.p)), q: qnormalize(qmul(b.q, a.q)) };
  if (!base) return extra.map(key => ({ ...key, p: [...key.p], q: [...key.q] }));
  if (constantTrack(extra)) return base.map(key => ({ ...key, ...compose(key, extra[0]) }));
  if (constantTrack(base)) return extra.map(key => ({ ...key, ...compose(base[0], key) }));
  const start = Math.max(0, Math.min(base[0].frame, extra[0].frame));
  const end = Math.min(lastFrame, Math.max(base[base.length - 1].frame, extra[extra.length - 1].frame));
  return bakeFrames(start, end).map(frame => ({ frame, interp: LINEAR_INTERPOLATION, ...compose(sampleTrack(base, frame), sampleTrack(extra, frame)) }));
}

/** Retargets to target-space tracks (indices into plan.target.bones). */
export function retargetTracks(vmd: VmdLike, plan: RetargetPlan): RetargetedTracks {
  const { source, target } = plan;
  let lastFrame = 0;
  for (const frame of vmd.motions) if (Number.isInteger(frame.frameNum) && frame.frameNum > lastFrame) lastFrame = frame.frameNum;
  for (const frame of vmd.morphs) if (Number.isInteger(frame.frameNum) && frame.frameNum > lastFrame) lastFrame = frame.frameNum;
  const report: RetargetReport = { identity: identityFor(vmd, plan), scale: plan.scale, alignedDeg: { ...plan.alignedDeg }, renamed: 0, folded: [], droppedBones: [],
    droppedMorphs: [], mappedMorphs: {}, bakedLegIk: false, lost: [] };
  const sourceSlot = new Map<string, StandardBone>();
  for (const slot of STANDARD_BONES) { const index = source.slots[slot]; if (index !== undefined) sourceSlot.set(source.bones[index].name, slot); }
  const targetByName = new Map<string, number>(), targetNameCount = new Map<string, number>();
  target.bones.forEach((bone, index) => { if (!targetByName.has(bone.name)) targetByName.set(bone.name, index); targetNameCount.set(bone.name, (targetNameCount.get(bone.name) ?? 0) + 1); });
  const targetSlotBones = new Set(Object.values(target.slots));
  const targetFingers = target.fingers ?? {}, fingerBones = new Set(Object.values(targetFingers));

  const grouped = groupBoneFrames(vmd.motions);
  const direct = new Map<number, TrackKey[]>(), folds: { targets: number[]; side: 'parent' | 'child'; keys: TrackKey[]; name: string }[] = [];
  const ik: Partial<Record<'Left' | 'Right', TrackKey[]>> = {};
  const legDriven = new Set<StandardBone>();
  // T-213: a source track counts as lost when it moves a standard bone or a finger joint and lands on no bone a clip can bind.
  const lose = (name: string, keys: readonly TrackKey[]) => { if ((sourceSlot.has(name) || fingerSlotOfName(name)) && trackMoves(keys)) report.lost!.push(name); };
  for (const [name, keys] of grouped) {
    const slot = sourceSlot.get(name), finger = slot ? null : fingerSlotOfName(name);
    if (slot && LEG_DRIVERS.includes(slot)) legDriven.add(slot);
    // Finger tracks land on the profile's joint (same table, any naming); a joint the profile left out still binds by its exact name.
    const fingerTarget = finger ? targetFingers[finger] : undefined;
    const route: BoneRoute = slot ? plan.routes[slot] ?? { kind: 'drop', reason: 'unmapped' }
      : fingerTarget !== undefined ? { kind: 'bone', target: fingerTarget }
        : targetByName.has(name) && !targetSlotBones.has(targetByName.get(name)!) && !(finger && fingerBones.has(targetByName.get(name)!))
          ? { kind: 'bone', target: targetByName.get(name)! }
          : { kind: 'drop', reason: 'target has no such bone' };
    if (route.kind === 'bone') {
      if (direct.has(route.target)) { report.droppedBones.push(name); lose(name, keys); continue; }
      direct.set(route.target, keys);
      if (target.bones[route.target].name !== name) report.renamed++;
      if ((targetNameCount.get(target.bones[route.target].name) ?? 0) > 1) lose(name, keys);
    } else if (route.kind === 'fold') { folds.push({ targets: route.targets, side: route.side, keys, name }); report.folded.push(`${name}→${route.targets.map(index => target.bones[index].name).join('+')}`); }
    else if (route.kind === 'ik') ik[route.side] = keys;
    else { report.droppedBones.push(name); lose(name, keys); }
  }
  // Folds combine in source space, then the whole track is aligned like the bone it landed on.
  const combined = new Map(direct);
  for (const fold of folds) for (const index of fold.targets) combined.set(index, combine(combined.get(index), fold.keys, fold.side, lastFrame));

  // Skeleton step 3: a finger joint this motion leaves out stays at rest on the target (nothing else keys it either: Gene's stand
  // has no 親指０), so a joint under it is corrected against the world that joint really has, its own parent's. Other bones a motion
  // leaves out are carried by the base pose's corrected track, as before.
  const carried: (Quat | null)[] = new Array(target.bones.length).fill(null);
  for (const index of topological(target)) {
    const parent = target.bones[index].parent;
    carried[index] = combined.has(index) || !fingerBones.has(index) ? plan.align[index] : parent >= 0 ? carried[parent] : null;
  }
  const tracks: Tracks = new Map();
  const scale = plan.scale;
  for (const [index, keys] of combined) {
    const parent = target.bones[index].parent;
    const ap = parent >= 0 ? carried[parent] : null, ab = plan.align[index];
    if (!ap && !ab && scale === 1) { tracks.set(index, keys.map(key => ({ ...key, p: [...key.p], q: [...key.q] }))); continue; }
    const apInverse = ap ? qconj(ap) : null;
    tracks.set(index, keys.map(key => {
      let q = key.q;
      if (apInverse) q = qmul(apInverse, q);
      if (ab) q = qmul(q, ab);
      const p = apInverse ? qrotate(apInverse, key.p) : key.p;
      return { frame: key.frame, interp: key.interp, q: apInverse || ab ? qnormalize(q) : [...q], p: scale === 1 ? [...p] : vscale(p, scale) };
    }));
  }
  const scaledIk: Partial<Record<'Left' | 'Right', TrackKey[]>> = {};
  for (const side of ['Left', 'Right'] as const) if (ik[side]) scaledIk[side] = ik[side]!.map(key => ({ ...key, p: vscale(key.p, scale), q: [...key.q] }));

  if (plan.bakeLegIk && legDriven.size) { bakeLegs(target, tracks, scaledIk, lastFrame); report.bakedLegIk = true; }
  else for (const side of ['Left', 'Right'] as const) if (ik[side]) {
    const name = source.bones[source.slots[`legIk${side}`]!].name;
    report.droppedBones.push(name); lose(name, ik[side]!);
  }

  // Morphs: a semantic slot first (calibrated), else the identical name on the target, else dropped.
  const morphs = new Map<string, VmdMorphFrameLike[]>();
  const sourceMorphSlot = new Map<string, MorphSlot>();
  for (const [slot, entry] of Object.entries(source.morphSlots) as [MorphSlot, RigMorphSlot][]) if (!sourceMorphSlot.has(entry.name)) sourceMorphSlot.set(entry.name, slot);
  const targetMorphs = new Set(target.morphNames), groupedMorphs = new Map<string, VmdMorphFrameLike[]>();
  for (const frame of vmd.morphs) { const list = groupedMorphs.get(frame.morphName) ?? []; list.push(frame); groupedMorphs.set(frame.morphName, list); }
  const ordered = [...groupedMorphs.keys()].sort((a, b) => Number(!sourceMorphSlot.has(a)) - Number(!sourceMorphSlot.has(b)));
  for (const name of ordered) {
    const slot = sourceMorphSlot.get(name);
    const route = slot ? morphSlotRoute(source, target, slot) : targetMorphs.has(name) ? { target: name, ratio: 1, slot: null } : null;
    if (!route || morphs.has(route.target)) { report.droppedMorphs.push(name); continue; }
    if (route.target !== name) report.mappedMorphs[name] = route.target;
    morphs.set(route.target, groupedMorphs.get(name)!.map(frame => ({ morphName: route.target, frameNum: frame.frameNum,
      weight: route.ratio === 1 ? frame.weight : Math.min(1, Math.max(0, frame.weight * route.ratio)) })));
  }
  return { tracks, morphs, lastFrame, report };
}

function bakeLegs(rig: RetargetRig, tracks: Tracks, ik: Partial<Record<'Left' | 'Right', TrackKey[]>>, lastFrame: number): void {
  const drivers = new Set<number>();
  for (const slot of ['root', 'center', 'groove', 'waist', 'lowerBody'] as const) { const index = rig.slots[slot]; if (index !== undefined) drivers.add(index); }
  const moving = [...drivers].map(index => tracks.get(index)).filter((keys): keys is TrackKey[] => !!keys && !constantTrack(keys));
  for (const keys of Object.values(ik)) if (keys && !constantTrack(keys)) moving.push(keys);
  const frames = moving.length ? bakeFrames(Math.max(0, Math.min(...moving.map(keys => keys[0].frame))), Math.min(lastFrame, Math.max(...moving.map(keys => keys[keys.length - 1].frame)))) : [0];
  const baked: Record<'Left' | 'Right', { leg: TrackKey[]; knee: TrackKey[]; ankle: TrackKey[] }> = { Left: { leg: [], knee: [], ankle: [] }, Right: { leg: [], knee: [], ankle: [] } };
  const sides = (['Left', 'Right'] as const).filter(side => rig.slots[`legIk${side}`] === undefined
    && rig.slots[`leg${side}`] !== undefined && rig.slots[`knee${side}`] !== undefined && rig.slots[`ankle${side}`] !== undefined);
  for (const side of sides) for (const slot of ['leg', 'knee', 'ankle'] as const) tracks.delete(rig.slots[`${slot}${side}`]!);
  for (const frame of frames) {
    const pose = evaluatePose(rig, tracks, frame);
    for (const side of sides) {
      const goal = ikTarget(rig, side, pose, ik[side], frame);
      const solved = goal && legRotations(rig, side, pose, goal);
      if (!solved) continue;
      for (const slot of ['leg', 'knee', 'ankle'] as const) baked[side][slot].push({ frame, p: [0, 0, 0], q: solved[slot], interp: LINEAR_INTERPOLATION });
    }
  }
  for (const side of sides) for (const slot of ['leg', 'knee', 'ankle'] as const)
    if (baked[side][slot].length) tracks.set(rig.slots[`${slot}${side}`]!, baked[side][slot]);
}

/** Writes target-space tracks back as VMD data (new objects; the input VMD is untouched). */
export function writeVmd<T extends VmdLike>(vmd: T, rig: RetargetRig, result: Pick<RetargetedTracks, 'tracks' | 'morphs'>): T {
  const motions: VmdBoneFrameLike[] = [];
  for (const index of [...result.tracks.keys()].sort((a, b) => a - b)) {
    const name = rig.bones[index].name;
    for (const key of result.tracks.get(index)!)
      motions.push({ boneName: name, frameNum: key.frame, position: [...key.p], rotation: [...key.q], interpolation: Array.from(key.interp) });
  }
  const morphs: VmdMorphFrameLike[] = [];
  for (const list of result.morphs.values()) for (const frame of list) morphs.push({ ...frame });
  return { ...vmd, metadata: { ...vmd.metadata, motionCount: motions.length, morphCount: morphs.length }, motions, morphs };
}

/** Identity plans return the very same object: the source model's own motions stay bit-identical. */
export function retargetVmd<T extends VmdLike>(vmd: T, plan: RetargetPlan): { vmd: T; report: RetargetReport } {
  if (identityFor(vmd, plan)) return { vmd, report: { identity: true, scale: 1, alignedDeg: { ...plan.alignedDeg }, renamed: 0, folded: [], droppedBones: [], droppedMorphs: [],
    mappedMorphs: {}, bakedLegIk: false, lost: lostByName(vmd, plan.source, plan.target) } };
  const result = retargetTracks(vmd, plan);
  return { vmd: writeVmd(vmd, plan.target, result), report: result.report };
}
