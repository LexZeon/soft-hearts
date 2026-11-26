/**
 * I-078 第 1 步 (docs/claude/2026-11-11-i078-sleep-step1.md): her sleep postures, built on the universal skeleton from the
 * model's own rest geometry, so they fit any MMD body (Gene first; other proportions in tests through edited rest skeletons).
 *
 * Nothing here is an authored rotation table for one model. Every pose is written in body terms:
 *  - `aim`: where a limb segment points, as a direction in its parent segment's frame (+x her left, +y up toward her head,
 *    +z her front). The local rotation is the shortest turn from the model's own rest direction of that segment (an A-pose
 *    arm and a T-pose arm both end up pointing the same way).
 *  - `bend`: a hinge (elbow forward, knee backward) by an angle, about the axis the model's own rest segment gives.
 *  - `turn`: a spine, neck, head or center turn (pitch x > 0 bends her forward, yaw y > 0 turns her face to her left, roll z).
 * The global placement (which way she faces, the roll onto her side, how far the center drops and slides) is solved here
 * from the body's collision capsules (shared/foundation/collision-proxy.ts): the lowest point of her body rests on the floor, her head
 * on the pillow or on her forearms, and the pillow and desk are sized from the same capsules.
 *
 * Pure planning: no bone of the mesh is touched (forward kinematics on copies of the rest positions). The stage layer
 * (sleep-body.ts) blends toward the planned local rotations; the props (sleep-props.ts) are placed from the plan.
 */
import { Matrix4, Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import type { CollisionProxy, ProxySegment } from '../../shared/actions';
import type { StandardBone } from '../../shared/actions';

export type SleepKind = 'lie' | 'desk' | 'sit';
/** Which way the pose turns on screen: lie = head to the camera's left (-1) or right (+1); desk = she faces left / right. */
export type SleepSide = -1 | 1;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- the rig

export interface RigBone { bone: Bone; name: string; parent: number; rest: Vector3 }
export interface RigCapsule { segment: ProxySegment; bone: number; a: Vector3; b: Vector3; radius: number }
/** The standard slots the postures write (each maps to one bone of the model, or is missing). */
export const SLEEP_SLOTS = ['center', 'groove', 'waist', 'upperBody', 'upperBody2', 'neck', 'head', 'lowerBody',
  'shoulderLeft', 'shoulderRight', 'armLeft', 'armRight', 'armTwistLeft', 'armTwistRight', 'elbowLeft', 'elbowRight',
  'wristTwistLeft', 'wristTwistRight', 'wristLeft', 'wristRight', 'legLeft', 'legRight', 'kneeLeft', 'kneeRight', 'ankleLeft', 'ankleRight'] as const satisfies readonly StandardBone[];
export type SleepSlot = typeof SLEEP_SLOTS[number];

export interface SleepRig {
  readonly mesh: SkinnedMesh;
  readonly bones: readonly RigBone[];
  /** Rig index per slot (-1 missing). */
  readonly slot: Readonly<Record<SleepSlot, number>>;
  readonly capsules: readonly RigCapsule[];
  /** Model height (rest bounds) and the floor (rest bounds bottom). */
  readonly height: number;
  readonly floorY: number;
  /** Rest directions (unit, model space) of the segments the postures aim or bend. */
  readonly restDir: Readonly<Partial<Record<SleepSlot, Vector3>>>;
  /** Grant children (付与, rotation, non-local) whose source the postures write: they follow by delta. */
  readonly grants: readonly { child: number; parent: number; ratio: number }[];
}

/** The slots a body needs before any lying or desk posture is tried (the seated doze needs only the spine and head). */
export const REQUIRED_SLOTS: readonly SleepSlot[] = ['center', 'upperBody', 'head', 'legLeft', 'legRight', 'kneeLeft', 'kneeRight', 'armLeft', 'armRight', 'elbowLeft', 'elbowRight'];

/** Rest (bind) positions from the skeleton's inverses (MMD bones carry no rest rotation). */
function restPositions(mesh: SkinnedMesh): Vector3[] {
  const matrix = new Matrix4();
  return mesh.skeleton.bones.map((bone, i) => {
    const inverse = mesh.skeleton.boneInverses[i];
    return inverse ? new Vector3().setFromMatrixPosition(matrix.copy(inverse).invert()) : bone.getWorldPosition(new Vector3());
  });
}

/**
 * The model as the postures see it. `slot(name)` is the profile's standard bone lookup; `proxy` the profile's collision
 * capsules (a body without them gets capsules estimated from its bones). Null when the spine or head is missing.
 */
export function buildSleepRig(mesh: SkinnedMesh, slot: (name: StandardBone) => Bone | null | undefined, proxy?: CollisionProxy | null, floorY?: number): SleepRig | null {
  const bones = mesh.skeleton?.bones;
  if (!bones?.length) return null;
  const rest = restPositions(mesh), index = new Map<Bone, number>(bones.map((bone, i) => [bone, i]));
  const rig: RigBone[] = bones.map((bone, i) => ({ bone, name: bone.name, parent: bone.parent && index.has(bone.parent as Bone) ? index.get(bone.parent as Bone)! : -1, rest: rest[i] }));
  const slots = {} as Record<SleepSlot, number>;
  for (const name of SLEEP_SLOTS) { const bone = slot(name); slots[name] = bone && index.has(bone) ? index.get(bone)! : -1; }
  if (slots.head < 0 || slots.upperBody < 0 || slots.center < 0) return null;
  // Height and floor from her own joints (helper bones far away must not count): head joint to the lowest ankle, plus the
  // head above its joint and the foot below the ankle (Gene: 17.3 + 1.33 → 19.96).
  const feet = (['ankleLeft', 'ankleRight', 'kneeLeft', 'kneeRight'] as const).map(name => slots[name]).filter(i => i >= 0).map(i => rest[i].y);
  const headY = rest[slots.head].y, low = feet.length ? Math.min(...feet) : rest[slots.center].y * 0.1;
  const floor = Number.isFinite(floorY) ? floorY! : low - (headY - low) * 0.08;
  const height = Math.max(1, (headY - floor) * 1.15);
  // Rest directions: from a slot's joint to the next joint down the limb (or up the spine).
  const at = (name: SleepSlot) => slots[name] >= 0 ? rest[slots[name]] : null;
  const dir = (from: SleepSlot, to: SleepSlot | null, fallback: Vector3): Vector3 => {
    const a = at(from), b = to ? at(to) : null;
    const d = a && b ? b.clone().sub(a) : fallback.clone();
    return d.lengthSq() > 1e-10 ? d.normalize() : fallback.clone().normalize();
  };
  const restDir: Partial<Record<SleepSlot, Vector3>> = {
    upperBody: dir('upperBody', slots.upperBody2 >= 0 ? 'upperBody2' : 'neck', new Vector3(0, 1, 0)),
    armLeft: dir('armLeft', 'elbowLeft', new Vector3(1, -0.6, 0)), armRight: dir('armRight', 'elbowRight', new Vector3(-1, -0.6, 0)),
    elbowLeft: dir('elbowLeft', 'wristLeft', new Vector3(1, -0.6, 0)), elbowRight: dir('elbowRight', 'wristRight', new Vector3(-1, -0.6, 0)),
    legLeft: dir('legLeft', 'kneeLeft', new Vector3(0, -1, 0)), legRight: dir('legRight', 'kneeRight', new Vector3(0, -1, 0)),
    kneeLeft: dir('kneeLeft', 'ankleLeft', new Vector3(0, -1, 0)), kneeRight: dir('kneeRight', 'ankleRight', new Vector3(0, -1, 0)),
  };
  const capsules = proxyCapsules(proxy, slots, rest, height) ?? estimatedCapsules(slots, rest, height);
  // Grant children of what the postures write (rotation, non-local), in the helper's order.
  const written = new Set(SLEEP_SLOTS.map(name => slots[name]).filter(i => i >= 0));
  const grants: { child: number; parent: number; ratio: number }[] = [];
  const raw = (mesh.geometry?.userData?.MMD?.grants ?? []) as { index: number; parentIndex: number; ratio: number; affectRotation: boolean; isLocal: boolean }[];
  for (const grant of raw)
    if (grant.affectRotation && !grant.isLocal && Number.isFinite(grant.ratio) && bones[grant.index] && bones[grant.parentIndex]
      && (written.has(grant.parentIndex) || grants.some(g => g.child === grant.parentIndex)) && !written.has(grant.index))
      grants.push({ child: grant.index, parent: grant.parentIndex, ratio: grant.ratio });
  return { mesh, bones: rig, slot: slots, capsules, height, floorY: floor, restDir, grants };
}

const SEGMENT_SLOT: Readonly<Record<ProxySegment, SleepSlot>> = {
  pelvis: 'lowerBody', abdomen: 'upperBody', chest: 'upperBody2', neck: 'neck', head: 'head',
  upperArmLeft: 'armLeft', forearmLeft: 'elbowLeft', handLeft: 'wristLeft', upperArmRight: 'armRight', forearmRight: 'elbowRight', handRight: 'wristRight',
  thighLeft: 'legLeft', shinLeft: 'kneeLeft', thighRight: 'legRight', shinRight: 'kneeRight',
};
function proxyCapsules(proxy: CollisionProxy | null | undefined, slots: Record<SleepSlot, number>, rest: Vector3[], height: number): RigCapsule[] | null {
  if (!proxy?.capsules?.length) return null;
  const out: RigCapsule[] = [];
  for (const capsule of proxy.capsules) {
    const name = SEGMENT_SLOT[capsule.segment];
    let bone = name ? slots[name] : -1;
    if (bone < 0 && name === 'upperBody2') bone = slots.upperBody;
    if (bone < 0 && name === 'lowerBody') bone = slots.center;
    if (bone < 0 || !(capsule.radius > 0)) continue;
    out.push({ segment: capsule.segment, bone, a: new Vector3(...capsule.a), b: new Vector3(...capsule.b), radius: Math.min(capsule.radius, height * 0.12) });
  }
  return out.some(c => c.segment === 'head') ? out : null;
}
/** Without a profile's proxy: segments between joints, radii as fractions of the height (Gene-like proportions). */
function estimatedCapsules(slots: Record<SleepSlot, number>, rest: Vector3[], height: number): RigCapsule[] {
  const out: RigCapsule[] = [];
  const seg = (segment: ProxySegment, from: SleepSlot, to: SleepSlot | null, radius: number, up = 0) => {
    const i = slots[from]; if (i < 0) return;
    const a = rest[i].clone(), b = to && slots[to] >= 0 ? rest[slots[to]].clone() : a.clone().add(new Vector3(0, up, 0));
    out.push({ segment, bone: i, a, b, radius: radius * height });
  };
  seg('head', 'head', null, 0.054, height * 0.05);
  seg('chest', slots.upperBody2 >= 0 ? 'upperBody2' : 'upperBody', 'neck', 0.045);
  seg('abdomen', 'upperBody', slots.upperBody2 >= 0 ? 'upperBody2' : 'neck', 0.05);
  for (const [s, side] of [['Left', 1], ['Right', -1]] as const) {
    void side;
    seg(`upperArm${s}`, `arm${s}`, `elbow${s}`, 0.04); seg(`forearm${s}`, `elbow${s}`, `wrist${s}`, 0.036);
    seg(`thigh${s}`, `leg${s}`, `knee${s}`, 0.035); seg(`shin${s}`, `knee${s}`, `ankle${s}`, 0.022);
  }
  return out;
}

// ---------------------------------------------------------------- forward kinematics on rest copies

export interface Fk { rot: Quaternion[]; pos: Vector3[] }
/** World rotations and positions for local rotations `local` (identity where unset) and an added center offset. */
export function forward(rig: SleepRig, local: ReadonlyMap<number, Quaternion>, centerOffset?: Vector3, out?: Fk): Fk {
  const n = rig.bones.length, fk = out ?? { rot: Array.from({ length: n }, () => new Quaternion()), pos: Array.from({ length: n }, () => new Vector3()) };
  const offset = new Vector3();
  for (let i = 0; i < n; i++) {
    const bone = rig.bones[i], q = local.get(i);
    if (bone.parent < 0) { fk.rot[i].copy(q ?? IDENTITY); fk.pos[i].copy(bone.rest); }
    else {
      const p = bone.parent;
      offset.copy(bone.rest).sub(rig.bones[p].rest).applyQuaternion(fk.rot[p]);
      fk.pos[i].copy(fk.pos[p]).add(offset);
      fk.rot[i].copy(fk.rot[p]);
      if (q) fk.rot[i].multiply(q);
    }
    if (i === rig.slot.center && centerOffset) fk.pos[i].add(centerOffset);
  }
  // Children were placed after their parents only if the bone list is parent-first (MMD's is); fix the rest in a second pass.
  for (let i = 0; i < n; i++) {
    const p = rig.bones[i].parent;
    if (p > i) {
      offset.copy(rig.bones[i].rest).sub(rig.bones[p].rest).applyQuaternion(fk.rot[p]);
      fk.pos[i].copy(fk.pos[p]).add(offset);
      fk.rot[i].copy(fk.rot[p]); const q = local.get(i); if (q) fk.rot[i].multiply(q);
    }
  }
  return fk;
}
const IDENTITY = new Quaternion();
/** A rest-space capsule point as posed: bonePos + boneRot·(p − boneRest). */
export function posedPoint(rig: SleepRig, fk: Fk, bone: number, p: Vector3, out = new Vector3()): Vector3 {
  return out.copy(p).sub(rig.bones[bone].rest).applyQuaternion(fk.rot[bone]).add(fk.pos[bone]);
}

// ---------------------------------------------------------------- posture vocabulary

type V3 = readonly [number, number, number];
/** One posture in body terms (see the file comment). Sides are her own: Left = +x. */
export interface PostureSpec {
  /** Spine / neck / head / lower-body turns [pitch, yaw, roll] in degrees. */
  turn?: Partial<Record<'upperBody' | 'upperBody2' | 'neck' | 'head' | 'lowerBody' | 'shoulderLeft' | 'shoulderRight' | 'wristLeft' | 'wristRight' | 'ankleLeft' | 'ankleRight', V3>>;
  /** Upper arm / thigh direction in the parent segment's frame (normalized here). */
  aim?: Partial<Record<'armLeft' | 'armRight' | 'legLeft' | 'legRight', V3>>;
  /** Elbow (forward) / knee (backward) hinge angles in degrees. */
  bend?: Partial<Record<'elbowLeft' | 'elbowRight' | 'kneeLeft' | 'kneeRight', number>>;
  /** Extra twist (deg) about the aimed upper arm / thigh after the aim (hand palm or knee direction). */
  twist?: Partial<Record<'armLeft' | 'armRight' | 'legLeft' | 'legRight', number>>;
  /**
   * Upper arm (arm*) and forearm (elbow*) directions in her body frame (the center's: +x her left, +y toward her head, +z her
   * front), whatever the spine does: arms placed in the room (on a desk, by her face) rather than relative to the chest.
   * Applied after the spine, upper arm before forearm; wins over `aim` / `bend` for the same bone.
   */
  reach?: Partial<Record<'armLeft' | 'armRight' | 'elbowLeft' | 'elbowRight', V3>>;
}

const euler = (v: V3 | undefined, out = new Quaternion()) => {
  if (!v) return out.identity();
  // Yaw, then pitch, then roll (intrinsic YXZ): a forward bend stays a forward bend after a yaw.
  const [x, y, z] = v, qx = new Quaternion().setFromAxisAngle(X, x * DEG), qy = new Quaternion().setFromAxisAngle(Y, y * DEG), qz = new Quaternion().setFromAxisAngle(Z, z * DEG);
  return out.copy(qy).multiply(qx).multiply(qz);
};
const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0), Z = new Vector3(0, 0, 1);

/** Mirror a spec left↔right (x → −x): yaw and roll change sign, Left and Right swap. */
export function mirrorSpec(spec: PostureSpec): PostureSpec {
  const flip = (v: V3): V3 => [v[0], -v[1], -v[2]];
  const flipDir = (v: V3): V3 => [-v[0], v[1], v[2]];
  const swap = (key: string) => key.endsWith('Left') ? key.replace(/Left$/, 'Right') : key.endsWith('Right') ? key.replace(/Right$/, 'Left') : key;
  const map = <T,>(record: Record<string, T> | undefined, f: (v: T) => T) => record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [swap(k), f(v)])) : undefined;
  return { turn: map(spec.turn as Record<string, V3>, flip) as PostureSpec['turn'], aim: map(spec.aim as Record<string, V3>, flipDir) as PostureSpec['aim'],
    bend: map(spec.bend as Record<string, number>, v => v) as PostureSpec['bend'], twist: map(spec.twist as Record<string, number>, v => -v) as PostureSpec['twist'],
    reach: map(spec.reach as Record<string, V3>, flipDir) as PostureSpec['reach'] };
}

/** Linear mix of two specs (same keys expected; a missing value counts as rest). Used for small variants (a hug, a curl). */
export function mixSpec(a: PostureSpec, b: PostureSpec, t: number): PostureSpec {
  const k = Math.min(1, Math.max(0, t));
  const mix3 = (x: V3 | undefined, y: V3 | undefined, rest: V3): V3 => { const p = x ?? rest, q = y ?? rest; return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]; };
  const keys = <T,>(r1?: Record<string, T>, r2?: Record<string, T>) => [...new Set([...Object.keys(r1 ?? {}), ...Object.keys(r2 ?? {})])];
  const out: PostureSpec = { turn: {}, aim: {}, bend: {}, twist: {}, reach: {} };
  for (const key of keys(a.reach, b.reach)) {
    const p = (a.reach as Record<string, V3>)?.[key], q = (b.reach as Record<string, V3>)?.[key];
    (out.reach as Record<string, V3>)[key] = p && q ? mix3(p, q, [0, -1, 0]) : (p ?? q)!;
  }
  for (const key of keys(a.turn, b.turn)) (out.turn as Record<string, V3>)[key] = mix3((a.turn as Record<string, V3>)?.[key], (b.turn as Record<string, V3>)?.[key], [0, 0, 0]);
  for (const key of keys(a.aim, b.aim)) {
    const p = (a.aim as Record<string, V3>)?.[key], q = (b.aim as Record<string, V3>)?.[key];
    (out.aim as Record<string, V3>)[key] = p && q ? mix3(p, q, [0, -1, 0]) : (p ?? q)!;
  }
  for (const key of keys(a.bend, b.bend)) (out.bend as Record<string, number>)[key] = ((a.bend as Record<string, number>)?.[key] ?? 0) * (1 - k) + ((b.bend as Record<string, number>)?.[key] ?? 0) * k;
  for (const key of keys(a.twist, b.twist)) (out.twist as Record<string, number>)[key] = ((a.twist as Record<string, number>)?.[key] ?? 0) * (1 - k) + ((b.twist as Record<string, number>)?.[key] ?? 0) * k;
  return out;
}

/**
 * The spec as local rotations of this rig. Every SLEEP_SLOTS bone the rig has gets a value (rest = identity), so the blend
 * fully owns those bones at weight 1; `center` is left out (the placement sets it).
 */
export function specRotations(rig: SleepRig, spec: PostureSpec): Map<number, Quaternion> {
  const out = new Map<number, Quaternion>();
  for (const name of SLEEP_SLOTS) if (name !== 'center' && rig.slot[name] >= 0) out.set(rig.slot[name], new Quaternion());
  for (const [name, v] of Object.entries(spec.turn ?? {}) as [SleepSlot, V3][]) if (rig.slot[name] >= 0) euler(v, out.get(rig.slot[name]));
  for (const [name, v] of Object.entries(spec.aim ?? {}) as ['armLeft' | 'armRight' | 'legLeft' | 'legRight', V3][]) {
    const i = rig.slot[name], rest = rig.restDir[name];
    if (i < 0 || !rest) continue;
    const want = new Vector3(...v);
    if (want.lengthSq() < 1e-10) continue;
    const q = new Quaternion().setFromUnitVectors(rest, want.normalize());
    const twist = spec.twist?.[name];
    if (twist) q.premultiply(new Quaternion().setFromAxisAngle(want, twist * DEG));
    out.get(i)!.copy(q);
  }
  for (const [name, angle] of Object.entries(spec.bend ?? {}) as ['elbowLeft' | 'elbowRight' | 'kneeLeft' | 'kneeRight', number][]) {
    const i = rig.slot[name], rest = rig.restDir[name];
    if (i < 0 || !rest || !angle) continue;
    // Elbows fold the forearm toward her front, knees fold the shin toward her back.
    const toward = name.startsWith('elbow') ? Z : new Vector3(0, 0, -1);
    const axis = new Vector3().crossVectors(rest, toward);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
    out.get(i)!.setFromAxisAngle(axis.normalize(), angle * DEG);
  }
  // Body-frame reaches: the parent's rotation (relative to the center, which is identity here) is undone, so the segment
  // points where the spec says in her body frame whatever the spine above it does.
  const want = new Vector3(), inverse = new Quaternion();
  for (const name of ['armLeft', 'elbowLeft', 'armRight', 'elbowRight'] as const) {
    const v = spec.reach?.[name], i = rig.slot[name], rest = rig.restDir[name];
    if (!v || i < 0 || !rest) continue;
    want.set(...v);
    if (want.lengthSq() < 1e-10) continue;
    const fk = forward(rig, out), parent = rig.bones[i].parent;
    if (parent >= 0) want.applyQuaternion(inverse.copy(fk.rot[parent]).invert());
    out.get(i)!.setFromUnitVectors(rest, want.normalize());
  }
  return out;
}

// ---------------------------------------------------------------- the postures (trial values, docs/claude/2026-11-11-i078-sleep-step1.md)

/** Seiza: kneeling on her heels, hands on her thighs. The shared waypoint between standing and both sleep poses. */
export const SIT_SPEC: PostureSpec = {
  turn: { upperBody: [5, 0, 0], upperBody2: [3, 0, 0], neck: [3, 0, 0], head: [5, 0, 0], ankleLeft: [-55, 0, 0], ankleRight: [-55, 0, 0] },
  aim: { legLeft: [0.08, 0.05, 1], legRight: [-0.08, 0.05, 1] },
  bend: { kneeLeft: 160, kneeRight: 160 },
  reach: { armLeft: [0.22, -0.95, 0.2], armRight: [-0.22, -0.95, 0.2], elbowLeft: [0.02, -0.55, 0.83], elbowRight: [-0.02, -0.55, 0.83] },
};
/** Seated doze (the fallback): the same seiza, slumped a little, chin down. */
export const SIT_DOZE_SPEC: PostureSpec = {
  ...SIT_SPEC,
  turn: { ...SIT_SPEC.turn, upperBody: [12, 0, 0], upperBody2: [7, 0, 0], neck: [12, 0, 4], head: [14, 0, 7] },
};
/**
 * Lying on her right side (before the global roll, so "up" is toward her head): curled a little, the lower (right) arm
 * forward with the hand near her face, the upper (left) arm resting over in front of her chest.
 */
export const LIE_SPEC: PostureSpec = {
  turn: { upperBody: [10, 0, 0], upperBody2: [6, 0, 0], neck: [4, 0, -4], head: [8, 0, -6], ankleLeft: [-25, 0, 0], ankleRight: [-20, 0, 0], lowerBody: [0, 0, 0] },
  aim: { legLeft: [0.05, -0.62, 0.78], legRight: [-0.02, -0.75, 0.66] },
  bend: { kneeLeft: 85, kneeRight: 72 },
  reach: { armRight: [-0.25, 0.05, 0.97], elbowRight: [-0.2, 0.85, 0.5], armLeft: [0.1, -0.45, 0.88], elbowLeft: [-0.6, 0.25, 0.75] },
};
/** The hug variant (closeness O high): both forearms come round in front of her face, toward the pillow. */
export const LIE_HUG_SPEC: PostureSpec = {
  ...LIE_SPEC,
  reach: { armRight: [-0.25, 0.25, 0.93], elbowRight: [0.05, 0.9, 0.42], armLeft: [-0.05, 0.1, 0.99], elbowLeft: [-0.45, 0.75, 0.48] },
};
/**
 * Desk nap facing her left (+x) before the global yaw: kneeling (seiza legs), leaning forward, forearms side by side on the
 * desk with the hands together under her face, the head turned to her right so the cheek rests on the arms and the face
 * looks back toward the camera. The lean is solved (deskLean) so the head lands on the forearms.
 */
export const DESK_SPEC: PostureSpec = {
  turn: { upperBody: [25, 0, 0], upperBody2: [15, 0, 0], neck: [10, -30, 0], head: [6, -45, -35], ankleLeft: [-55, 0, 0], ankleRight: [-55, 0, 0] },
  aim: { legLeft: [0.1, 0.05, 1], legRight: [-0.1, 0.05, 1] },
  bend: { kneeLeft: 160, kneeRight: 160 },
  reach: { armLeft: [0.5, -0.5, 0.62], armRight: [-0.5, -0.5, 0.62], elbowLeft: [-0.94, -0.05, 0.32], elbowRight: [0.94, -0.05, 0.32] },
};

/** The lean (deg, upperBody / upperBody2 share) applied on top of DESK_SPEC's own lean. */
function withLean(spec: PostureSpec, lean: number): PostureSpec {
  const t = spec.turn ?? {};
  const add = (v: V3 | undefined, d: number): V3 => [(v?.[0] ?? 0) + d, v?.[1] ?? 0, v?.[2] ?? 0];
  return { ...spec, turn: { ...t, upperBody: add(t.upperBody, lean * 0.6), upperBody2: add(t.upperBody2, lean * 0.4) } };
}

// ---------------------------------------------------------------- placement

export interface PlacedPose {
  kind: SleepKind;
  side: SleepSide;
  /** Local rotations for the written bones (center included). */
  local: Map<number, Quaternion>;
  /** Added to the center bone's position (model space). */
  centerOffset: Vector3;
  /** Head volume (center, radius incl. hair margin) as posed, model space. */
  head: { center: Vector3; radius: number };
  /** The lowest body point (should be the floor) and the head's lowest point. */
  bodyLow: number;
  headLow: number;
  /** Prop anchors (model space): the pillow under her head, or the desk under her forearms. */
  pillow?: { center: Vector3; width: number; depth: number; height: number; yaw: number; sink: number };
  desk?: { center: Vector3; width: number; depth: number; height: number; yaw: number };
  /** Points that must stay in frame besides the head (the rest of the body, for the scoring's body term). */
  body: Vector3[];
}

/** Soft minimum (smooth lower envelope): continuous in every point, so a pose sliding between contacts does not kink. */
export function softMin(values: readonly number[], softness: number): number {
  if (!values.length) return 0;
  const low = Math.min(...values);
  if (!(softness > 0)) return low;
  let sum = 0;
  for (const v of values) sum += Math.exp(-(v - low) / softness);
  return low - softness * Math.log(sum);
}

const HAIR_MARGIN = 1.35;
/** Lowest posed points of the capsules (each capsule's lowest y). */
function capsuleLows(rig: SleepRig, fk: Fk, skip: (segment: ProxySegment) => boolean): number[] {
  const a = new Vector3(), b = new Vector3(), out: number[] = [];
  for (const c of rig.capsules) {
    if (skip(c.segment)) continue;
    posedPoint(rig, fk, c.bone, c.a, a); posedPoint(rig, fk, c.bone, c.b, b);
    out.push(Math.min(a.y, b.y) - c.radius);
  }
  return out;
}
function headVolume(rig: SleepRig, fk: Fk): { center: Vector3; radius: number; low: number } {
  const c = rig.capsules.find(v => v.segment === 'head');
  const a = new Vector3(), b = new Vector3();
  if (!c) { const p = fk.pos[rig.slot.head].clone(); return { center: p, radius: rig.height * 0.07, low: p.y - rig.height * 0.05 }; }
  posedPoint(rig, fk, c.bone, c.a, a); posedPoint(rig, fk, c.bone, c.b, b);
  const center = a.clone().add(b).multiplyScalar(0.5), half = a.distanceTo(b) / 2;
  return { center, radius: (c.radius + half) * HAIR_MARGIN, low: Math.min(a.y, b.y) - c.radius };
}
function capsulePoints(rig: SleepRig, fk: Fk, segments: readonly ProxySegment[]): { a: Vector3; b: Vector3; r: number }[] {
  return rig.capsules.filter(c => segments.includes(c.segment)).map(c => ({ a: posedPoint(rig, fk, c.bone, c.a), b: posedPoint(rig, fk, c.bone, c.b), r: c.radius }));
}

export interface PlacementInput {
  kind: SleepKind;
  side: SleepSide;
  /** World yaw (rad) of the direction from her to the camera (0 = camera in front of her, +z). */
  cameraYaw: number;
  /** 0..1 closeness: the hug variant's share (lie) and how far the face turns to the camera (desk). */
  hug?: number;
}

/** The center's global rotation for a kind: face the camera (lie, sit) or turn sideways to it (desk). */
function centerRotation(input: PlacementInput, out = new Quaternion()): Quaternion {
  const yaw = new Quaternion();
  if (input.kind === 'lie') {
    // Face the camera, then roll onto her right side (head to the camera's left) or left side (head to its right).
    yaw.setFromAxisAngle(Y, input.cameraYaw);
    const roll = new Quaternion().setFromAxisAngle(Z, input.side < 0 ? Math.PI / 2 : -Math.PI / 2);
    return out.copy(yaw).multiply(roll);
  }
  if (input.kind === 'desk') {
    // Her front (+z) to the camera's left (side −1) or right (+1): yaw = cameraYaw ∓ 90°; DESK_SPEC turns her head back.
    return out.setFromAxisAngle(Y, input.cameraYaw + (input.side < 0 ? -Math.PI / 2 : Math.PI / 2));
  }
  return out.setFromAxisAngle(Y, input.cameraYaw * 0.35);
}

/** The spec this placement uses (sides mirrored so the head and face always end up toward the camera). */
export function placementSpec(input: PlacementInput): PostureSpec {
  if (input.kind === 'sit') return SIT_DOZE_SPEC;
  if (input.kind === 'lie') {
    const spec = mixSpec(LIE_SPEC, LIE_HUG_SPEC, input.hug ?? 0);
    // LIE_SPEC lies on her right side (head to the camera's left); the other side mirrors it.
    return input.side < 0 ? spec : mirrorSpec(spec);
  }
  // DESK_SPEC faces her left with the head turned to her right; facing the camera's left means facing her own right? No:
  // with yaw = cameraYaw − 90° her front points to the camera's left and her own left side is toward the camera, so the
  // head turns to her left to show the face: the mirrored spec. Facing the camera's right uses DESK_SPEC as written.
  return input.side < 0 ? mirrorSpec(DESK_SPEC) : DESK_SPEC;
}

/**
 * Where the pose goes: local rotations, the center offset that sets the lowest body point on the floor, the head volume,
 * the props. The horizontal slide (camera framing) is not part of this: placeOnScreen adds it.
 */
export function placePose(rig: SleepRig, input: PlacementInput): PlacedPose {
  let spec = placementSpec(input);
  if (input.kind === 'desk') spec = deskLean(rig, input, spec);
  return place(rig, input, spec);
}

function place(rig: SleepRig, input: PlacementInput, spec: PostureSpec, center?: Quaternion): PlacedPose {
  const local = specRotations(rig, spec);
  local.set(rig.slot.center, center ?? centerRotation(input));
  const zero = forward(rig, local);
  const onFloor = (segment: ProxySegment) => segment === 'head' || (input.kind === 'desk' && /^(forearm|hand)/.test(segment));
  const lows = capsuleLows(rig, zero, onFloor);
  const bodyLow = Math.min(...lows);
  const centerOffset = new Vector3(0, rig.floorY + rig.height * 0.004 - bodyLow, 0);
  // Keep her where she stood: the posed pelvis over the rest pelvis (horizontally), so the pose does not walk away.
  const pelvis = rig.slot.lowerBody >= 0 ? rig.slot.lowerBody : rig.slot.center;
  const drift = zero.pos[pelvis].clone().sub(rig.bones[pelvis].rest);
  if (input.kind !== 'lie') centerOffset.x -= drift.x, centerOffset.z -= drift.z;
  else {
    // Lying: the body's middle (between head and knees) over where she stood.
    const head = zero.pos[rig.slot.head], knee = rig.slot.kneeLeft >= 0 ? zero.pos[rig.slot.kneeLeft] : zero.pos[pelvis];
    const middle = head.clone().add(knee).multiplyScalar(0.5);
    centerOffset.x -= middle.x - rig.bones[rig.slot.center].rest.x; centerOffset.z -= middle.z - rig.bones[rig.slot.center].rest.z;
  }
  const fk = forward(rig, local, centerOffset);
  const head = headVolume(rig, fk);
  const body = rig.capsules.filter(c => c.segment !== 'head').flatMap(c => [posedPoint(rig, fk, c.bone, c.a), posedPoint(rig, fk, c.bone, c.b)]);
  const placed: PlacedPose = { kind: input.kind, side: input.side, local, centerOffset, head: { center: head.center, radius: head.radius },
    bodyLow: Math.min(...capsuleLows(rig, fk, onFloor)), headLow: head.low, body };
  if (input.kind === 'lie') placed.pillow = pillowFor(rig, fk, head, input);
  if (input.kind === 'desk') placed.desk = deskFor(rig, fk, input);
  return placed;
}

/** The pillow under her head: as tall as the gap from the floor to her head, plus the dent her head makes (sink). */
function pillowFor(rig: SleepRig, fk: Fk, head: { center: Vector3; radius: number; low: number }, input: PlacementInput): NonNullable<PlacedPose['pillow']> {
  const c = rig.capsules.find(v => v.segment === 'head'), r = c?.radius ?? rig.height * 0.05;
  const sink = r * 0.28;
  const height = Math.max(r * 0.6, head.low - rig.floorY + sink);
  const center = new Vector3(head.center.x, rig.floorY, head.center.z);
  // Toward the top of her head a little, so the head lies in the pillow's middle rather than at its edge.
  const neck = fk.pos[rig.slot.neck >= 0 ? rig.slot.neck : rig.slot.head];
  const along = head.center.clone().sub(neck).setY(0);
  if (along.lengthSq() > 1e-8) center.add(along.normalize().multiplyScalar(r * 0.25));
  return { center, width: r * 4.2, depth: r * 3.0, height, yaw: input.cameraYaw, sink };
}
/** The desk under her forearms: its top at the lower forearm's underside; wide enough to clear her knees and thighs. */
function deskFor(rig: SleepRig, fk: Fk, input: PlacementInput): NonNullable<PlacedPose['desk']> {
  const arms = capsulePoints(rig, fk, ['forearmLeft', 'forearmRight', 'handLeft', 'handRight']);
  const low = Math.min(...arms.map(v => Math.min(v.a.y, v.b.y) - v.r));
  const center = new Vector3(), n = arms.length * 2;
  for (const v of arms) center.add(v.a).add(v.b);
  center.multiplyScalar(1 / Math.max(1, n)).setY(rig.floorY);
  const shoulders = rig.slot.armLeft >= 0 && rig.slot.armRight >= 0 ? rig.bones[rig.slot.armLeft].rest.distanceTo(rig.bones[rig.slot.armRight].rest) : rig.height * 0.14;
  const yaw = input.cameraYaw + (input.side < 0 ? -Math.PI / 2 : Math.PI / 2);
  // Push the desk a little forward (her front) so its near edge stays clear of her knees.
  center.add(new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(rig.height * 0.02));
  return { center, width: shoulders * 2.6, depth: rig.height * 0.17, height: Math.max(rig.height * 0.05, low - rig.floorY), yaw };
}

/** The extra lean (deg) that brings her head down onto her forearms (bisection; clamped to a plausible range). */
function deskLean(rig: SleepRig, input: PlacementInput, spec: PostureSpec): PostureSpec {
  // The desk top: a low table at her seated navel (where the forearms of an upright seiza would rest), from her own body.
  const seiza = place(rig, { kind: 'sit', side: input.side, cameraYaw: input.cameraYaw }, SIT_SPEC);
  const fkSit = forward(rig, seiza.local, seiza.centerOffset);
  const upper = fkSit.pos[rig.slot.upperBody].y, chest = fkSit.pos[rig.slot.neck >= 0 ? rig.slot.neck : rig.slot.head].y;
  const deskTop = upper + (chest - upper) * DESK_TOP_SHARE;
  const c = rig.capsules.find(v => v.segment === 'head'), sink = (c?.radius ?? rig.height * 0.05) * 0.12;
  const forearms: ProxySegment[] = ['forearmLeft', 'forearmRight', 'handLeft', 'handRight'];
  const reachAt = (s: PostureSpec, down: number): PostureSpec => {
    const r = s.reach ?? {}, set = (v: V3 | undefined): V3 | undefined => v && [v[0], down, v[2]];
    return { ...s, reach: { ...r, armLeft: set(r.armLeft), armRight: set(r.armRight) } };
  };
  // For a lean: the upper arms' downward share that rests the forearms on the desk top (bisection), then the head's gap.
  const fit = (lean: number): { spec: PostureSpec; gap: number } => {
    const leaned = withLean(spec, lean);
    const bottom = (down: number) => {
      const placed = place(rig, input, reachAt(leaned, down)), fk = forward(rig, placed.local, placed.centerOffset);
      return { placed, fk, y: Math.min(...capsulePoints(rig, fk, forearms).map(v => Math.min(v.a.y, v.b.y) - v.r)) };
    };
    let lo = -1.2, hi = 0.6;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (bottom(mid).y > deskTop) hi = mid; else lo = mid; }
    const chosen = reachAt(leaned, (lo + hi) / 2), { placed, fk } = bottom((lo + hi) / 2);
    const top = Math.max(...capsulePoints(rig, fk, forearms).map(v => Math.max(v.a.y, v.b.y) + v.r));
    return { spec: chosen, gap: placed.headLow - (top - sink) };
  };
  let low = -15, high = 40;
  if (fit(low).gap <= 0) return fit(low).spec;
  if (fit(high).gap > 0) return fit(high).spec;
  for (let i = 0; i < 12; i++) { const mid = (low + high) / 2; if (fit(mid).gap > 0) low = mid; else high = mid; }
  return fit((low + high) / 2).spec;
}
/** Where the desk top sits between her seated hip joint (0) and her neck (1). */
const DESK_TOP_SHARE = 0.38;

/**
 * The seiza waypoint for a placement: facing the way its pose will (desk: already turned sideways; lie: toward the camera),
 * so she turns while she sits down and then only leans or rolls.
 */
export function placeWaypoint(rig: SleepRig, input: PlacementInput): PlacedPose {
  const yaw = input.kind === 'desk' ? input.cameraYaw + (input.side < 0 ? -Math.PI / 2 : Math.PI / 2) : input.kind === 'lie' ? input.cameraYaw : input.cameraYaw * 0.35;
  const placed = place(rig, { kind: 'sit', side: input.side, cameraYaw: input.cameraYaw }, SIT_SPEC, new Quaternion().setFromAxisAngle(Y, yaw));
  return { ...placed, kind: input.kind, side: input.side };
}
