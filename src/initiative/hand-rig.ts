/**
 * I-087 她的手伸向你的鼠标 (hand-reach.ts): the rig (her reaching arm's bones, rest directions, fingers with their curl and spread axes,
 * the grant children) and the hand shapes (degrees: [curl, spread] per joint). Split out of hand-reach.ts unchanged (I-154 batch 4).
 */
import { Matrix4, Vector3, type Bone, type SkinnedMesh } from 'three';

export type HandShapeFinger = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
type Finger = HandShapeFinger;
export const FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'little'];
// ui-zh-ok: MMD bone names inside the model file, not interface text
const FINGER_NAMES: Readonly<Record<Finger, string>> = { thumb: '親指', index: '人指', middle: '中指', ring: '薬指', little: '小指' };
const digits = (n: number) => [String(n), String.fromCharCode(0xff10 + n)];

export interface HandJoint { bone: Bone; finger: Finger; index: number; curl: Vector3; spread: Vector3; c: number; s: number; v: { c: number; s: number } }
interface Grant { child: Bone; parent: Bone; ratio: number }
export interface HandRig {
  owner: SkinnedMesh; side: 'right' | 'left';
  chest: Bone; body: Bone | null; shoulder: Bone | null;
  upper: Bone | null; elbow: Bone | null; twist: Bone | null; wrist: Bone | null;
  joints: HandJoint[]; grants: Grant[];
  restUpper: Vector3; restFore: Vector3; restHand: Vector3; restPalm: Vector3; restHinge: Vector3;
  /** Rest-space frame of her body: forward (toward the viewer), up, outward on the reaching side. */
  fwd: Vector3; up: Vector3; out: Vector3;
  upperLength: number; foreLength: number; handLength: number; height: number;
}

function findBone(bones: readonly Bone[], names: readonly string[]): Bone | null {
  for (const name of names) { const bone = bones.find(b => b.name === name); if (bone) return bone; }
  return null;
}
function restPositions(mesh: SkinnedMesh): Map<Bone, Vector3> {
  const out = new Map<Bone, Vector3>(), matrix = new Matrix4();
  mesh.skeleton.bones.forEach((bone, i) => {
    const inverse = mesh.skeleton.boneInverses[i];
    if (inverse) out.set(bone, new Vector3().setFromMatrixPosition(matrix.copy(inverse).invert()));
  });
  return out;
}
const horizontal = (v: Vector3) => { const out = v.clone(); out.y = 0; return out.lengthSq() > 1e-12 ? out.normalize() : out; };
const isAncestor = (maybe: Bone, of: Bone | null) => { for (let b = of?.parent ?? null; b; b = b.parent) if (b === maybe) return true; return false; };

export function buildHandRig(mesh: SkinnedMesh): HandRig | null {
  const bones = mesh.skeleton?.bones ?? [];
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const chest = findBone(bones, ['上半身2', '上半身', 'spine', 'Spine', 'Chest']);
  if (!chest) return null;
  const rest = restPositions(mesh);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const pick = (prefix: string) => ({ upper: findBone(bones, [`${prefix}腕`]), elbow: findBone(bones, [`${prefix}ひじ`]), wrist: findBone(bones, [`${prefix}手首`]) });
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  let side: 'right' | 'left' = 'right', arm = pick('右');
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  if (!arm.upper || !arm.elbow || !arm.wrist) { const left = pick('左'); if (left.upper && left.elbow && left.wrist) { side = 'left'; arm = left; } }
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const prefix = side === 'right' ? '右' : '左', other = side === 'right' ? '左' : '右';
  const at = (bone: Bone | null) => bone ? rest.get(bone) ?? null : null;
  const up = new Vector3(0, 1, 0);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const head = findBone(bones, ['頭']), eyes = [findBone(bones, ['左目']), findBone(bones, ['右目'])].filter((b): b is Bone => !!b && !!rest.get(b));
  let fwd = new Vector3(0, 0, 1);
  if (head && at(head) && eyes.length) {
    const mid = eyes.reduce((sum, eye) => sum.add(rest.get(eye)!), new Vector3()).divideScalar(eyes.length);
    const candidate = horizontal(mid.sub(at(head)!));
    if (candidate.lengthSq() > 0.5) fwd = candidate;
  }
  let out = side === 'right' ? fwd.clone().cross(up) : up.clone().cross(fwd);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const otherUpper = findBone(bones, [`${other}腕`]);
  if (arm.upper && otherUpper && at(arm.upper) && at(otherUpper)) { const c = horizontal(at(arm.upper)!.clone().sub(at(otherUpper)!)); if (c.lengthSq() > 0.5) out = c; }
  let lowest = Infinity, highest = -Infinity;
  for (const p of rest.values()) { lowest = Math.min(lowest, p.y); highest = Math.max(highest, p.y); }
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const body = findBone(bones, ['上半身']), shoulder = findBone(bones, [`${prefix}肩`]);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const twist = findBone(bones, [`${prefix}手捩`]);
  const rig: HandRig = { owner: mesh, side, chest,
    body: body && body !== chest && isAncestor(body, arm.upper) ? body : body === chest && isAncestor(body, arm.upper) ? body : null,
    shoulder: shoulder && arm.upper?.parent === shoulder ? shoulder : null,
    upper: arm.upper, elbow: arm.elbow, wrist: arm.wrist,
    twist: twist && arm.wrist?.parent === twist && twist.parent === arm.elbow ? twist : null, joints: [], grants: [],
    restUpper: new Vector3(), restFore: new Vector3(), restHand: new Vector3(), restPalm: new Vector3(), restHinge: new Vector3(),
    fwd, up, out: out.normalize(), upperLength: 1, foreLength: 1, handLength: 0.4,
    height: Number.isFinite(highest - lowest) && highest > lowest ? highest - lowest : 20 };
  if (!arm.upper || !arm.elbow || !arm.wrist || !at(arm.upper) || !at(arm.elbow) || !at(arm.wrist)) {
    rig.upper = rig.elbow = rig.wrist = rig.twist = rig.shoulder = null; return rig;
  }
  const A = at(arm.upper)!, E = at(arm.elbow)!, W = at(arm.wrist)!;
  rig.upperLength = A.distanceTo(E); rig.foreLength = E.distanceTo(W);
  rig.restUpper.subVectors(E, A).normalize(); rig.restFore.subVectors(W, E).normalize();
  const finger = (f: Finger, n: number) => findBone(bones, digits(n).map(d => `${prefix}${FINGER_NAMES[f]}${d}`));
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const tip = (f: Finger) => findBone(bones, [`${prefix}${FINGER_NAMES[f]}先`]);
  const middle1 = finger('middle', 1), index1 = finger('index', 1), little1 = finger('little', 1);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  const handEnd = at(middle1) ?? at(findBone(bones, [`${prefix}手先`]));
  rig.restHand.copy(handEnd ? handEnd.clone().sub(W) : rig.restFore).normalize();
  const across = at(index1) && at(little1) ? at(index1)!.clone().sub(at(little1)!) : fwd.clone();
  rig.restPalm.crossVectors(across, rig.restHand).normalize();
  if (rig.restPalm.lengthSq() < 0.5) rig.restPalm.copy(up).multiplyScalar(-1);
  if (rig.restPalm.y > 0) rig.restPalm.negate();
  const flex = fwd.clone().addScaledVector(rig.restUpper, -fwd.dot(rig.restUpper)).normalize();
  rig.restHinge.crossVectors(rig.restUpper, flex).normalize();
  rig.handLength = handEnd ? Math.max(handEnd.distanceTo(W) * 2, 0.3 * rig.foreLength) : 0.4 * rig.foreLength;
  const acrossDir = across.clone().normalize();
  for (const f of FINGERS) {
    const numbers = f === 'thumb' ? [0, 1, 2] : [1, 2, 3];
    const chain = numbers.map(n => finger(f, n)).filter((b): b is Bone => !!b && !!rest.get(b));
    chain.forEach((bone, j) => {
      const next = chain[j + 1] ?? tip(f), from = rest.get(bone)!, to = next ? rest.get(next) : null;
      const dir = to && to.distanceTo(from) > 1e-6 ? to.clone().sub(from).normalize()
        : j > 0 ? from.clone().sub(rest.get(chain[j - 1])!).normalize() : rig.restHand.clone();
      const curl = dir.clone().cross(rig.restPalm).normalize(), spread = dir.clone().cross(acrossDir).normalize();
      if (curl.lengthSq() < 0.5 || spread.lengthSq() < 0.5) return;
      rig.joints.push({ bone, finger: f, index: j, curl, spread, c: 0, s: 0, v: { c: 0, s: 0 } });
    });
  }
  const written = new Set<Bone>([arm.upper, arm.elbow, arm.wrist, ...(rig.twist ? [rig.twist] : []), ...(rig.shoulder ? [rig.shoulder] : []),
    ...(rig.body ? [rig.body] : []), ...rig.joints.map(joint => joint.bone)]);
  const grants = (mesh.geometry?.userData?.MMD?.grants ?? []) as { index: number; parentIndex: number; ratio: number; affectRotation: boolean; isLocal: boolean }[];
  for (const grant of grants) {
    const child = bones[grant.index], parent = bones[grant.parentIndex];
    if (child && parent && grant.affectRotation && !grant.isLocal && written.has(parent) && !written.has(child) && Number.isFinite(grant.ratio))
      rig.grants.push({ child, parent, ratio: grant.ratio });
  }
  return rig;
}

// ---------------------------------------------------------------- hand shapes (degrees: [curl, spread] per joint)

type ShapeRow = readonly (readonly [number, number])[];
export const RELAXED: Readonly<Record<Finger, ShapeRow>> = {
  thumb: [[4, 10], [8, 0], [8, 0]], index: [[6, 5], [10, 0], [8, 0]], middle: [[8, 0], [12, 0], [9, 0]], ring: [[10, -4], [13, 0], [10, 0]], little: [[12, -8], [14, 0], [10, 0]],
};
const FIST: ShapeRow = [[80, 0], [95, 0], [65, 0]];
export const PINKY: Readonly<Record<Finger, ShapeRow>> = {
  thumb: [[18, -28], [35, 0], [45, 0]], index: FIST, middle: FIST, ring: FIST, little: [[0, -10], [4, 0], [3, 0]],
};
export const PALM: Readonly<Record<Finger, ShapeRow>> = {
  thumb: [[0, 16], [5, 0], [5, 0]], index: [[0, 7], [3, 0], [2, 0]], middle: [[0, 0], [3, 0], [2, 0]], ring: [[0, -5], [3, 0], [2, 0]], little: [[0, -10], [3, 0], [2, 0]],
};
/** Holding: the four fingers close around your hand by `grip` (0.3 loose … 1 tight); the thumb comes across. */
export function gripRow(f: Finger, j: number, grip: number): readonly [number, number] {
  if (f === 'thumb') return [[12 + 10 * grip, -14 - 10 * grip], [18 + 14 * grip, 0], [16 + 16 * grip, 0]][Math.min(j, 2)] as [number, number];
  const base = RELAXED[f][Math.min(j, 2)];
  return [base[0] + [22, 30, 22][Math.min(j, 2)] * grip, base[1] * 0.5];
}
