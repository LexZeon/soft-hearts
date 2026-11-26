/**
 * The PMX skeleton: the VRM humanoid under MMD's standard Japanese names (the names the bundled motions, the stage and the
 * model profile look for), the MMD structure around it (全ての親 → センター → グルーブ, 上半身 and 下半身 both under グルーブ,
 * twist bones, 両目, leg and toe IK as on Gene), every other source node under its own name, and the A pose:
 * each arm turned about the front axis at its shoulder joint so the upper arm points `armDownDeg` below horizontal.
 *
 * Positions are in Three space (scene.ts `model`); `pose[b]` is the A-pose transform of PMX bone b (identity off the arms),
 * which mesh.ts bakes into the vertices with the skin weights.
 */
import { Matrix4, Vector3 } from 'three';
import type { Glb } from './glb';
import type { VrmPmxMapping } from './mapping';
import {
  BONE_FIXED_AXIS, BONE_GRANT_ROTATION, BONE_MOVE, BONE_OPERABLE, BONE_ROTATE, BONE_VISIBLE, type PmxBone, type PmxIk, type Vec3,
} from './pmx-model';
import { originOf, type SceneNodes } from './scene';
import { HUMAN_BONES, type HumanBone } from './vrm-read';

const FINGER_JP: Record<string, string> = { Index: '人指', Middle: '中指', Ring: '薬指', Little: '小指' };
const DIGIT = ['０', '１', '２', '３'];
/** The MMD standard name of each humanoid bone (Gene's exact spelling: full-width digits). */
export function standardBoneName(bone: HumanBone): string | null {
  const fixed: Partial<Record<HumanBone, string>> = {
    hips: '下半身', spine: '上半身', chest: '上半身2', upperChest: '上半身3', neck: '首', head: '頭', leftEye: '左目', rightEye: '右目',
  };
  if (fixed[bone]) return fixed[bone]!;
  const side = /^(left|right)(.*)$/.exec(bone);
  if (!side) return null;
  const jp = side[1] === 'left' ? '左' : '右', part = side[2];
  const limb: Record<string, string> = { Shoulder: '肩', UpperArm: '腕', LowerArm: 'ひじ', Hand: '手首', UpperLeg: '足', LowerLeg: 'ひざ', Foot: '足首', Toes: 'つま先' };
  if (limb[part]) return jp + limb[part];
  const thumb = /^Thumb(Metacarpal|Proximal|Distal)$/.exec(part);
  if (thumb) return `${jp}親指${DIGIT[thumb[1] === 'Metacarpal' ? 0 : thumb[1] === 'Proximal' ? 1 : 2]}`;
  const finger = /^(Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/.exec(part);
  if (finger) return `${jp}${FINGER_JP[finger[1]]}${DIGIT[finger[2] === 'Proximal' ? 1 : finger[2] === 'Intermediate' ? 2 : 3]}`;
  return null;
}

/** Gene's 両目 → 左目/右目 grant ratio: the bundled motions' 両目 keys were tuned on it. */
export const EYES_GRANT_RATIO = 0.15;
/** Knee limits of the MMD standard models (file convention): bends forward only, −180°…−0.5° about X. */
const KNEE_LIMITS = { min: [-Math.PI, 0, 0] as Vec3, max: [-0.5 * Math.PI / 180, 0, 0] as Vec3 };
/** Gene's (and the MMD standard models') IK settings. */
const LEG_IK = { loop: 40, limitRad: 2.0071287155151367 }, TOE_IK = { loop: 3, limitRad: 4.014257431030273 };

interface Draft {
  name: string; nameEn: string; rest: Vector3; parent: number; layer: number; flags: number;
  node?: number; human?: HumanBone; grant?: { parent: number; ratio: number }; fixAxis?: boolean;
  ik?: { target: number; links: { bone: number; knee?: boolean }[]; toe: boolean }; tail?: number; group: 'body' | 'ik';
}

export interface TwistSplit { base: number; twist: number; start: Vec3; end: Vec3 }
export interface Skeleton {
  bones: PmxBone[];
  /** glTF node → PMX bone carrying its skin weights (-1: not part of the skeleton). */
  nodeBone: Int32Array;
  /** PMX bone → its A-pose transform (Three space, PMX units). */
  pose: Matrix4[];
  /** Weight splits for the twist bones (base bone's weight shared with the twist bone along the segment). */
  twists: TwistSplit[];
  /** Humanoid bones that the mapping names but the file does not have, and the reverse. */
  missingHumanoid: string[];
  /** Source nodes folded into 全ての親 (non-humanoid ancestors of the hips). */
  foldedIntoRoot: string[];
  synthetic: string[];
  /** Upper arm angle below horizontal before and after the A pose (degrees, left and right). */
  armDownDeg: { before: [number, number]; after: [number, number] } | null;
}

const ROOT_FLAGS = BONE_ROTATE | BONE_MOVE | BONE_VISIBLE | BONE_OPERABLE, BODY_FLAGS = BONE_ROTATE | BONE_VISIBLE | BONE_OPERABLE;

export function buildSkeleton(glb: Glb, scene: SceneNodes, mapping: VrmPmxMapping, required: { joints: ReadonlySet<number>; extra: ReadonlySet<number> }): Skeleton {
  const nodeCount = scene.names.length;
  const nodeByName = new Map<string, number>();
  scene.names.forEach((name, index) => { if (name && !nodeByName.has(name)) nodeByName.set(name, index); });
  const human = new Map<number, HumanBone>(), humanNode: Partial<Record<HumanBone, number>> = {};
  const missingHumanoid: string[] = [];
  for (const bone of HUMAN_BONES) {
    const name = mapping.humanoid[bone];
    if (name === undefined) continue;
    const node = nodeByName.get(name);
    if (node === undefined || human.has(node)) { missingHumanoid.push(`${bone}=${name}`); continue; }
    human.set(node, bone); humanNode[bone] = node;
  }
  // Included nodes: skin joints, humanoid, physics and collider nodes, and their ancestors.
  const included = new Set<number>();
  const include = (node: number) => { for (let at = node; at >= 0 && !included.has(at); at = scene.parent[at]) included.add(at); };
  for (const node of [...required.joints, ...required.extra, ...human.keys()]) if (node >= 0 && node < nodeCount) include(node);
  // Non-humanoid ancestors of the hips fold into 全ての親.
  const folded = new Set<number>();
  const hips = humanNode.hips;
  if (hips !== undefined) for (let at = scene.parent[hips]; at >= 0; at = scene.parent[at]) if (!human.has(at)) folded.add(at);
  const meshOnly = (node: number) => glb.json.nodes?.[node]?.mesh !== undefined && !required.joints.has(node) && !required.extra.has(node) && !human.has(node);

  const drafts: Draft[] = [];
  const add = (draft: Omit<Draft, 'layer' | 'group'> & { layer?: number; group?: Draft['group'] }) => { drafts.push({ layer: 0, group: 'body', ...draft }); return drafts.length - 1; };
  const restOf = (node: number) => originOf(scene.model[node]);
  const root = add({ name: '全ての親', nameEn: 'master', rest: new Vector3(), parent: -1, flags: ROOT_FLAGS });
  const legY = (['leftUpperLeg', 'rightUpperLeg'] as const).map(bone => humanNode[bone]).filter((n): n is number => n !== undefined).map(n => restOf(n).y);
  const hipsRest = hips !== undefined ? restOf(hips) : new Vector3();
  const legHeight = legY.length ? legY.reduce((a, b) => a + b, 0) / legY.length : hipsRest.y * 0.92;
  // Gene: センター at 0.881 of the leg joints' height, グルーブ 0.019 of it above.
  const center = add({ name: 'センター', nameEn: 'center', rest: new Vector3(0, legHeight * 0.881, hipsRest.z), parent: root, flags: ROOT_FLAGS });
  const groove = add({ name: 'グルーブ', nameEn: 'groove', rest: new Vector3(0, legHeight * 0.9, hipsRest.z), parent: center, flags: ROOT_FLAGS });

  const nodeDraft = new Int32Array(nodeCount).fill(-1);
  const usedNames = new Set(['全ての親', 'センター', 'グルーブ']);
  const unique = (name: string) => { let out = name || 'bone', k = 2; while (usedNames.has(out)) out = `${name}_${k++}`; usedNames.add(out); return out; };
  const order = [...included].sort((a, b) => a - b);
  for (const node of order) {
    if (folded.has(node) || meshOnly(node)) continue;
    const bone = human.get(node);
    const name = (bone && standardBoneName(bone)) || mapping.boneNames[scene.names[node]] || scene.names[node] || `node${node}`;
    nodeDraft[node] = add({ name: unique(name), nameEn: bone ?? scene.names[node] ?? '', rest: restOf(node), parent: root, flags: BODY_FLAGS, node, human: bone });
  }
  const draftOf = (bone: HumanBone) => humanNode[bone] !== undefined ? nodeDraft[humanNode[bone]!] : -1;
  // Hierarchy: nearest included (non-folded) ancestor; 下半身 and 上半身 hang from グルーブ.
  for (const draft of drafts) {
    if (draft.node === undefined) continue;
    let parent = root;
    for (let at = scene.parent[draft.node]; at >= 0; at = scene.parent[at]) if (nodeDraft[at] >= 0) { parent = nodeDraft[at]; break; }
    draft.parent = parent;
  }
  const lower = draftOf('hips'), upper = draftOf('spine');
  if (lower >= 0) drafts[lower].parent = groove;
  if (upper >= 0) {
    drafts[upper].parent = groove;
    // Both bodies pivot at the waist, as on MMD models (the hips node itself sits lower, between the legs).
    if (lower >= 0) drafts[lower].rest = drafts[upper].rest.clone();
  }
  const synthetic: string[] = [];
  // 両目 (the stage only falls back to it; the bundled motions key it): between the eyes, driving each eye by Gene's ratio.
  const eyeL = draftOf('leftEye'), eyeR = draftOf('rightEye'), head = draftOf('head');
  if (eyeL >= 0 && eyeR >= 0 && head >= 0) {
    const both = add({ name: unique('両目'), nameEn: 'eyes', rest: drafts[eyeL].rest.clone().add(drafts[eyeR].rest).multiplyScalar(0.5), parent: head, flags: BODY_FLAGS });
    for (const eye of [eyeL, eyeR]) drafts[eye].grant = { parent: both, ratio: EYES_GRANT_RATIO };
    synthetic.push('両目');
  }
  // Twist bones: 腕捩 between 腕 and ひじ, 手捩 between ひじ and 手首 (Gene's layout), each on a fixed axis along its segment.
  const twists: { base: number; twist: number; end: number }[] = [];
  for (const side of ['left', 'right'] as const) {
    const jp = side === 'left' ? '左' : '右';
    const arm = draftOf(`${side}UpperArm`), elbow = draftOf(`${side}LowerArm`), wrist = draftOf(`${side}Hand`);
    if (arm >= 0 && elbow >= 0 && drafts[elbow].parent === arm) {
      const twist = add({ name: unique(`${jp}腕捩`), nameEn: `${side} arm twist`, rest: drafts[arm].rest.clone().lerp(drafts[elbow].rest, 0.5), parent: arm, flags: BODY_FLAGS, fixAxis: true, tail: elbow });
      drafts[elbow].parent = twist; twists.push({ base: arm, twist, end: elbow }); synthetic.push(`${jp}腕捩`);
    }
    if (elbow >= 0 && wrist >= 0 && drafts[wrist].parent === elbow) {
      const twist = add({ name: unique(`${jp}手捩`), nameEn: `${side} wrist twist`, rest: drafts[elbow].rest.clone().lerp(drafts[wrist].rest, 0.5), parent: elbow, flags: BODY_FLAGS, fixAxis: true, tail: wrist });
      drafts[wrist].parent = twist; twists.push({ base: elbow, twist, end: wrist }); synthetic.push(`${jp}手捩`);
    }
  }

  // A pose: each arm subtree turned about +Z at its upper arm joint.
  const children = (index: number) => drafts.map((draft, k) => draft.parent === index ? k : -1).filter(k => k >= 0);
  const pose = drafts.map(() => new Matrix4());
  const elevation = (from: Vector3, to: Vector3) => Math.atan2(to.y - from.y, Math.abs(to.x - from.x)) * 180 / Math.PI;
  let armDownDeg: Skeleton['armDownDeg'] = null;
  const leftArm = draftOf('leftUpperArm'), rightArm = draftOf('rightUpperArm'), leftElbow = draftOf('leftLowerArm'), rightElbow = draftOf('rightLowerArm');
  if (leftArm >= 0 && rightArm >= 0 && leftElbow >= 0 && rightElbow >= 0) {
    const before: [number, number] = [-elevation(drafts[leftArm].rest, drafts[leftElbow].rest), -elevation(drafts[rightArm].rest, drafts[rightElbow].rest)];
    for (const [arm, sign, current] of [[leftArm, 1, before[0]], [rightArm, -1, before[1]]] as const) {
      const turn = sign * -(mapping.aPose.armDownDeg - current) * Math.PI / 180;
      const pivot = drafts[arm].rest;
      const matrix = new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new Matrix4().makeRotationZ(turn)).multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      const stack = [arm];
      while (stack.length) { const at = stack.pop()!; pose[at] = matrix.clone(); stack.push(...children(at)); }
    }
    const posed = (index: number) => drafts[index].rest.clone().applyMatrix4(pose[index]);
    armDownDeg = { before, after: [-elevation(posed(leftArm), posed(leftElbow)), -elevation(posed(rightArm), posed(rightElbow))] };
  }
  for (let k = 0; k < drafts.length; k++) drafts[k].rest.applyMatrix4(pose[k]);

  // Leg and toe IK (posed positions; the legs are not posed).
  for (const side of ['left', 'right'] as const) {
    const jp = side === 'left' ? '左' : '右';
    const leg = draftOf(`${side}UpperLeg`), knee = draftOf(`${side}LowerLeg`), ankle = draftOf(`${side}Foot`);
    if (leg < 0 || knee < 0 || ankle < 0) continue;
    let toe = draftOf(`${side}Toes`);
    if (toe < 0) {
      const at = drafts[ankle].rest;
      toe = add({ name: unique(`${jp}つま先`), nameEn: `${side} toe`, rest: new Vector3(at.x, 0, at.z + legHeight * 0.12), parent: ankle, flags: BODY_FLAGS });
      synthetic.push(`${jp}つま先`);
    }
    const ankleAt = drafts[ankle].rest;
    const parentIk = add({ name: unique(`${jp}足IK親`), nameEn: `${side} leg IK parent`, rest: new Vector3(ankleAt.x, 0, ankleAt.z), parent: root, flags: ROOT_FLAGS, group: 'ik' });
    const legIk = add({ name: unique(`${jp}足ＩＫ`), nameEn: `${side} leg IK`, rest: ankleAt.clone(), parent: parentIk, layer: 1, flags: ROOT_FLAGS, group: 'ik',
      ik: { target: ankle, links: [{ bone: knee, knee: true }, { bone: leg }], toe: false } });
    add({ name: unique(`${jp}つま先ＩＫ`), nameEn: `${side} toe IK`, rest: drafts[toe].rest.clone(), parent: legIk, layer: 1, flags: ROOT_FLAGS, group: 'ik',
      ik: { target: toe, links: [{ bone: ankle }], toe: true } });
    synthetic.push(`${jp}足IK親`, `${jp}足ＩＫ`, `${jp}つま先ＩＫ`);
  }

  // Order: depth first from the root (parents before children), IK last; then remap every index.
  const visit: number[] = [];
  const walk = (index: number) => { visit.push(index); for (const child of children(index).sort((a, b) => (drafts[a].group === 'ik' ? 1 : 0) - (drafts[b].group === 'ik' ? 1 : 0) || a - b)) walk(child); };
  walk(root);
  const remap = new Int32Array(drafts.length).fill(-1);
  visit.forEach((draft, index) => { remap[draft] = index; });
  const bones: PmxBone[] = visit.map(index => {
    const draft = drafts[index];
    const kids = children(index).filter(child => drafts[child].group !== 'ik');
    const tailDraft = draft.tail ?? (kids.length === 1 || draft.human ? kids.find(child => drafts[child].human !== undefined) ?? kids[0] : undefined);
    const ik: PmxIk | undefined = draft.ik ? {
      target: remap[draft.ik.target], loop: draft.ik.toe ? TOE_IK.loop : LEG_IK.loop, limitRad: draft.ik.toe ? TOE_IK.limitRad : LEG_IK.limitRad,
      links: draft.ik.links.map(link => ({ bone: remap[link.bone], ...(link.knee ? { limits: { min: [...KNEE_LIMITS.min] as Vec3, max: [...KNEE_LIMITS.max] as Vec3 } } : {}) })),
    } : undefined;
    const fixAxis = draft.fixAxis && draft.tail !== undefined ? drafts[draft.tail].rest.clone().sub(draft.rest).normalize() : undefined;
    return {
      name: draft.name, nameEn: draft.nameEn, position: [draft.rest.x, draft.rest.y, draft.rest.z], parent: draft.parent >= 0 ? remap[draft.parent] : -1, layer: draft.layer,
      flags: draft.flags | (draft.grant ? BONE_GRANT_ROTATION : 0) | (fixAxis ? BONE_FIXED_AXIS : 0),
      tail: tailDraft !== undefined ? remap[tailDraft] : draft.ik ? remap[draft.ik.target] : [0, 0, 0],
      ...(draft.grant ? { grant: { parent: remap[draft.grant.parent], ratio: draft.grant.ratio } } : {}),
      ...(fixAxis ? { fixAxis: [fixAxis.x, fixAxis.y, fixAxis.z] as Vec3 } : {}), ...(ik ? { ik } : {}),
    };
  });
  const nodeBone = new Int32Array(nodeCount).fill(-1);
  for (let node = 0; node < nodeCount; node++) {
    if (nodeDraft[node] >= 0) nodeBone[node] = remap[nodeDraft[node]];
    else if (folded.has(node)) nodeBone[node] = remap[root];
  }
  // A node outside the skeleton (a mesh node) skins to its nearest skeleton ancestor.
  for (let node = 0; node < nodeCount; node++) if (nodeBone[node] < 0) {
    let at = scene.parent[node];
    while (at >= 0 && nodeBone[at] < 0) at = scene.parent[at];
    nodeBone[node] = at >= 0 ? nodeBone[at] : remap[root];
  }
  const tuple = (v: Vector3): Vec3 => [v.x, v.y, v.z];
  return {
    bones, nodeBone, pose: visit.map(index => pose[index]),
    twists: twists.map(entry => ({ base: remap[entry.base], twist: remap[entry.twist], start: tuple(drafts[entry.base].rest), end: tuple(drafts[entry.end].rest) })),
    missingHumanoid, foldedIntoRoot: [...folded].map(node => scene.names[node]), synthetic, armDownDeg,
  };
}
