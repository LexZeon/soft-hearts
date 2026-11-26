/**
 * I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): the standard skeleton Unbound's engine drives for a model that is not
 * MMD. One bone per standard part, named the way the library's motions and the engine name them (Gene's own names: センター, 上半身,
 * 左腕, 左足ＩＫ…), resting at identity (MMD's convention: a bone's rest frame is the model's frame), placed where the model's own
 * joints are, except that each arm rests at Gene's angle (a VRM's T pose is laid in turned down about the shoulder joint): a motion
 * that leaves the arms out then shows them as on Gene, and the engine's idle lowers them from there as it does Gene's. The engine (figure.ts and everything under it: motion layers, leg IK, gait, springs, gaze, mouth) runs on this
 * skeleton exactly as it runs on an MMD model; body-transfer.ts then writes the pose onto the model's own bones through the
 * correspondence table (VRM: its humanoid map). The model's file is never changed.
 *
 * What it needs from the model: where each standard part is (LoadedModel.bone / finger, at rest, in the model's own space). Parts a
 * model lacks are placed between their neighbours and drive nothing (their turns reach the model through the parts below them).
 * Built once per model; no DOM, no WebGL.
 */
import { Bone, BufferAttribute, BufferGeometry, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { FINGERS, FINGER_JOINTS, NAMED_FACE_SHAPE_IDS, STANDARD_POSE, type Finger, type FingerSlot, type MorphSlot, type NamedFaceShape, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import type { LoadedModel } from '../../stage';

/** One bone of the standard skeleton: its name, parent (index, parents first), rest position (model units), and the model bone it drives. */
export interface StandardBoneSpec {
  readonly name: string;
  readonly slot: StandardBone | null;
  readonly finger: FingerSlot | null;
  readonly parent: number;
  readonly position: Vector3;
  /** The model's bone this one turns (null: a part the model has not, or one that only steers others: center, groove, twists, IK). */
  readonly drives: Bone | null;
  /**
   * The turn (model frame) from the model's own rest to this bone's rest, when they differ: a T-posed model's arms rest in the
   * standard skeleton at Gene's angle (see ARM_REST), so a motion that leaves the arms out shows them as on Gene. null: the same.
   */
  readonly restTurn: Quaternion | null;
}

/**
 * Gene's upper arms at rest, the direction every library motion was authored from (about 34° below level). A model whose arms rest
 * otherwise (VRM: a T pose, level) is laid into the standard skeleton with each whole arm turned to it about the shoulder joint.
 */
const ARM_REST = (side: 'Left' | 'Right') => {
  const at = (slot: StandardBone) => new Vector3(...STANDARD_POSE.bones.find(bone => bone.slot === slot)!.position);
  return at(`elbow${side}`).sub(at(`arm${side}`)).normalize();
};
/** Below this the arm already rests as Gene's: nothing is turned (an MMD-like A-pose model keeps its own rest exactly). */
const ARM_REST_EPSILON_DEG = 0.5;

/** The parts every humanoid needs; without one the standard body is not made (the error names them). */
export const REQUIRED_PARTS: readonly StandardBone[] = Object.freeze(['lowerBody', 'upperBody', 'head', 'armLeft', 'elbowLeft', 'wristLeft', 'armRight', 'elbowRight',
  'wristRight', 'legLeft', 'kneeLeft', 'ankleLeft', 'legRight', 'kneeRight', 'ankleRight']);

const POSE_NAME = new Map<StandardBone, string>(STANDARD_POSE.bones.map(bone => [bone.slot, bone.name]));
const FINGER_NAME = new Map<FingerSlot, string>((STANDARD_POSE.fingers ?? []).flatMap(f => f.slot ? [[f.slot, f.name] as const] : []));
// ui-zh-ok: MMD bone names inside the standard skeleton, not interface text
const FINGER_TIP: Readonly<Record<Finger, string>> = Object.freeze({ thumb: '親指先', index: '人指先', middle: '中指先', ring: '薬指先', little: '小指先' });
/** The standard name of a part (Gene's own, the names the library's motions use). */
export const standardName = (slot: StandardBone): string => POSE_NAME.get(slot) ?? slot;
export const fingerName = (slot: FingerSlot): string => FINGER_NAME.get(slot) ?? slot;

/**
 * The bones, parents first, in Gene's hierarchy: 全ての親 → センター → グルーブ → 下半身 → legs; グルーブ → 上半身 → 上半身2 → 首 → 頭
 * (eyes); 上半身2 → shoulders → arms (twist bones between) → wrists → fingers; 全ての親 → 足ＩＫ → つま先ＩＫ.
 */
export function standardSkeletonSpec(model: Pick<LoadedModel, 'bone' | 'finger' | 'rest' | 'object'>): StandardBoneSpec[] {
  model.object.updateMatrixWorld(true);
  const u = model.rest.unitsPerMeter;
  const own = (slot: StandardBone) => model.bone(slot) ?? null;
  const at = (bone: Bone | null) => bone ? bone.getWorldPosition(new Vector3()) : null;
  const missing = REQUIRED_PARTS.filter(slot => !own(slot));
  if (missing.length) throw new Error(`standard skeleton: the model has no ${missing.join(', ')}`);
  const hips = own('lowerBody')!, spine = own('upperBody')!, head = own('head')!;
  // The stage's chest falls back to the spine (humanoid.ts): only a bone of its own drives 上半身2.
  const chestBone = own('upperBody2') && own('upperBody2') !== spine ? own('upperBody2') : null;
  const H = at(hips)!, S = at(spine)!, Hd = at(head)!;
  const neckBone = own('neck');
  const C = at(chestBone) ?? S.clone().lerp(at(neckBone) ?? Hd, 0.5);
  const N = at(neckBone) ?? C.clone().lerp(Hd, 0.6);

  const specs: StandardBoneSpec[] = [];
  let turn: { pivot: Vector3; q: Quaternion } | null = null; // set while one arm is being laid in
  const add = (name: string, slot: StandardBone | null, parent: number, position: Vector3, drives: Bone | null, finger: FingerSlot | null = null) => {
    const placed = turn ? position.clone().sub(turn.pivot).applyQuaternion(turn.q).add(turn.pivot) : position.clone();
    specs.push({ name, slot, finger, parent, position: placed, drives, restTurn: turn ? turn.q.clone() : null });
    return specs.length - 1;
  };
  const part = (slot: StandardBone, parent: number, position: Vector3, drives: Bone | null) => add(standardName(slot), slot, parent, position, drives);

  const root = part('root', -1, new Vector3(0, 0, 0), null);
  const center = part('center', root, new Vector3(H.x, H.y * 0.8, H.z), null);
  const groove = part('groove', center, new Vector3(H.x, H.y * 0.82, H.z), null);
  const lower = part('lowerBody', groove, H, hips);
  const upper = part('upperBody', groove, S, spine);
  const upper2 = part('upperBody2', upper, C, chestBone);
  const neck = part('neck', upper2, N, neckBone);
  const headIndex = part('head', neck, Hd, head);
  const eyeL = own('eyeLeft'), eyeR = own('eyeRight');
  const eyeAt = (bone: Bone | null, side: 1 | -1) => at(bone) ?? Hd.clone().add(new Vector3(0.032 * side * u, 0.065 * u, 0.06 * u));
  const EL = eyeAt(eyeL, 1), ER = eyeAt(eyeR, -1);
  part('eyes', headIndex, EL.clone().lerp(ER, 0.5).add(new Vector3(0, 0.12 * u, 0)), null);
  part('eyeLeft', headIndex, EL, eyeL);
  part('eyeRight', headIndex, ER, eyeR);

  for (const side of ['Left', 'Right'] as const) {
    const shoulderBone = own(`shoulder${side}`), armBone = own(`arm${side}`)!, elbowBone = own(`elbow${side}`)!, wristBone = own(`wrist${side}`)!;
    const A = at(armBone)!, E = at(elbowBone)!, W = at(wristBone)!;
    const SH = at(shoulderBone) ?? new Vector3(N.x + (A.x - N.x) * 0.2, A.y, N.z + (A.z - N.z) * 0.2);
    const shoulder = part(`shoulder${side}`, upper2, SH, shoulderBone);
    const rest = E.clone().sub(A).normalize(), goal = ARM_REST(side);
    turn = rest.angleTo(goal) * 180 / Math.PI > ARM_REST_EPSILON_DEG ? { pivot: A.clone(), q: new Quaternion().setFromUnitVectors(rest, goal) } : null;
    const arm = part(`arm${side}`, shoulder, A, armBone);
    const armTwist = part(`armTwist${side}`, arm, A.clone().lerp(E, 0.5), null);
    const elbow = part(`elbow${side}`, armTwist, E, elbowBone);
    const wristTwist = part(`wristTwist${side}`, elbow, E.clone().lerp(W, 0.5), null);
    const wrist = part(`wrist${side}`, wristTwist, W, wristBone);
    for (const finger of FINGERS) {
      let parent = wrist, previous = W;
      const lastJoint = FINGER_JOINTS[finger][FINGER_JOINTS[finger].length - 1];
      for (const joint of FINGER_JOINTS[finger]) {
        const slot = `${finger}${joint}${side}` as FingerSlot, bone = model.finger(slot) ?? null;
        if (!bone) continue;
        const P = at(bone)!;
        parent = add(fingerName(slot), null, parent, P, bone, slot);
        if (joint !== lastJoint) previous = P;
        else {
          const tip = P.clone().add(P.clone().sub(previous).multiplyScalar(0.85));
          add(`${side === 'Left' ? '左' : '右'}${FINGER_TIP[finger]}`, null, parent, tip, null); // ui-zh-ok: MMD bone name
        }
      }
    }
    turn = null;
  }
  const legs: { leg: number; ankle: number; toe: number; side: 'Left' | 'Right' }[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const legBone = own(`leg${side}`)!, kneeBone = own(`knee${side}`)!, ankleBone = own(`ankle${side}`)!, toeBone = own(`toe${side}`);
    const L = at(legBone)!, K = at(kneeBone)!, A = at(ankleBone)!;
    // The toe tip the toe IK aims: the model's toe joint, or a foot's length ahead of the ankle on the floor.
    const T = at(toeBone) ?? new Vector3(A.x, Math.min(A.y, 0.02 * u), A.z + 0.1 * u);
    const leg = part(`leg${side}`, lower, L, legBone);
    const knee = part(`knee${side}`, leg, K, kneeBone);
    const ankle = part(`ankle${side}`, knee, A, ankleBone);
    const toe = part(`toe${side}`, ankle, T, null);
    legs.push({ leg, ankle, toe, side });
  }
  for (const { ankle, toe, side } of legs) {
    const ik = part(`legIk${side}`, root, specs[ankle].position, null);
    part(`toeIk${side}`, ik, specs[toe].position, null);
  }
  return specs;
}

/** MMD-style IK and grant records for the standard skeleton (as MMDLoader writes them; Gene's own limits and counts). */
export function standardRig(specs: readonly StandardBoneSpec[]) {
  const index = (slot: StandardBone) => specs.findIndex(spec => spec.slot === slot);
  const iks = (['Left', 'Right'] as const).flatMap(side => [
    { target: index(`legIk${side}`), effector: index(`ankle${side}`), iteration: 40, maxAngle: 2.0071287155151367,
      links: [{ index: index(`knee${side}`), rotationMin: new Vector3(-0.1745329350233078, 0, 0), rotationMax: new Vector3(2.879793405532837, 0, 0) }, { index: index(`leg${side}`) }] },
    { target: index(`toeIk${side}`), effector: index(`toe${side}`), iteration: 3, maxAngle: 4.014257431030273, links: [{ index: index(`ankle${side}`) }] },
  ]);
  // Gene's eyes follow 両目 by 0.15 (付与): the library's motions that turn 両目 move the eyes as on Gene.
  const grants = (['eyeLeft', 'eyeRight'] as const).map(slot => ({ index: index(slot), parentIndex: index('eyes'), ratio: 0.15, isLocal: false,
    affectRotation: true, affectPosition: false, transformationClass: 0 }));
  return { iks, grants };
}

/**
 * A morph of the standard skeleton: its name (what the engine looks up) and the expression slot it stands for, or (I-164, slot null)
 * the named face shape of her face actions it is (cheekPuff, tongueOut …: the face exclusive finds it by that name).
 */
export interface StandardMorphSpec { readonly name: string; readonly slot: MorphSlot | null; readonly shape?: NamedFaceShape }
/**
 * The standard face: each expression slot by Gene's own name (あ, まばたき, 笑い…), plus the names the engine's own cues look for
 * that Gene spells otherwise (intent-layer.ts: a smile is にやり). Only slots in `has` (the model can show them).
 */
export function standardMorphSpec(has: (slot: MorphSlot) => boolean, hasShape: (shape: NamedFaceShape) => boolean = () => false): StandardMorphSpec[] {
  const out: StandardMorphSpec[] = [];
  for (const [slot, entry] of Object.entries(STANDARD_POSE.morphSlots) as [MorphSlot, { name: string }][]) if (has(slot)) out.push({ name: entry.name, slot });
  // ui-zh-ok: MMD morph name the engine's smile cue looks for (intent-layer.ts FACE_MORPHS), not interface text
  if (has('smileEyes') && !out.some(spec => spec.name === 'にやり')) out.push({ name: 'にやり', slot: 'smileEyes' });
  // I-164 (docs/claude/2026-11-20-vrm-gaps.md), after everything above so its indices stay: the pucker (Gene has none, so no Gene name) and
  // the named shapes her face actions write, each under the name the action's clip uses.
  if (has('mouthPucker')) out.push({ name: 'mouthPucker', slot: 'mouthPucker' });
  for (const shape of NAMED_FACE_SHAPE_IDS) if (hasShape(shape)) out.push({ name: shape, slot: null, shape });
  return out;
}

/**
 * The standard skeleton as a skinned mesh with no vertices and an invisible material (never drawn): MMDLoader's shape, so the
 * engine's MMD machinery (the layered mixer and its IK and grant solvers, the VMD clip builder, the switch bridge) takes it as it
 * takes an MMD model. Every bone rests at identity.
 */
export function standardMesh(specs: readonly StandardBoneSpec[], morphs: readonly StandardMorphSpec[]): SkinnedMesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(0), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(0), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(0), 4));
  const rig = standardRig(specs);
  geometry.userData.MMD = { format: 'pmx', bones: specs.map(spec => ({ name: spec.name, parent: spec.parent, transformationClass: 0 })),
    iks: rig.iks, grants: rig.grants, rigidBodies: [], constraints: [] };
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial({ visible: false }));
  mesh.name = 'standard-body';
  mesh.frustumCulled = false;
  const bones = specs.map(spec => { const bone = new Bone(); bone.name = spec.name; return bone; });
  specs.forEach((spec, i) => {
    const parent = spec.parent >= 0 ? specs[spec.parent].position : new Vector3();
    bones[i].position.copy(spec.position).sub(parent);
    if (spec.parent >= 0) bones[spec.parent].add(bones[i]); else mesh.add(bones[i]);
  });
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((morph, i) => [morph.name, i]));
  mesh.morphTargetInfluences = morphs.map(() => 0);
  return mesh;
}
