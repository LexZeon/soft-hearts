/**
 * Synthetic models for model-profile tests (no private or third-party data),
 * plus a converter that turns pmx-lite/toy data into a real Three SkinnedMesh
 * shaped like MMDLoader's output (absolute morph targets, bone hierarchy at
 * rest, dominant-bone skinning) without needing `three/examples`.
 *
 * The toy humanoid is about 20 units tall with Gene-like head proportions:
 * chin ~16.8, eyes ~17.95, mouth ~17.13, brows ~18.32, crown (hair) ~19.65.
 */
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { ModelProfileInput } from '../../shared/model-profile';
import type { PmxLiteModel } from './pmx-lite';

export type ToyRegion = 'mouth' | 'eyes' | 'eyeLeft' | 'eyeRight' | 'brows' | 'cheeks' | 'body';
export interface ToyMorph {
  name: string; region: ToyRegion; amount: number;
  /** Per-vertex direction (rest x, y, z in toy units) times `amount`, instead of the region's one direction (a pucker draws the lips in). */
  offset?: (x: number, y: number, z: number) => [number, number, number];
}
export interface ToyOptions {
  names?: 'japanese' | 'english';
  eyeBones?: boolean;
  pose?: 'A' | 'T';
  scale?: number;
  morphs?: ToyMorph[];
  /** Retarget fixtures: グルーブ under センター, 捩 bones in each arm, 足ＩＫ bones under the root. Off by default (profile fixtures unchanged). */
  groove?: boolean;
  twist?: boolean;
  ik?: boolean;
}
/** Full skin weights and rigid bodies are optional: without them no collision proxy is fitted (the toy fixtures keep the rough body). */
export type ModelData = Pick<PmxLiteModel, 'positions' | 'skinBone' | 'bones' | 'morphs'> & Partial<Pick<PmxLiteModel, 'skinIndices' | 'skinWeights' | 'rigidBodies'>>;

export const JAPANESE_MORPHS: ToyMorph[] = [
  { name: 'あ', region: 'mouth', amount: 0.38 }, { name: 'い', region: 'mouth', amount: 0.068 }, { name: 'う', region: 'mouth', amount: 0.29 },
  { name: 'え', region: 'mouth', amount: 0.126 }, { name: 'お', region: 'mouth', amount: 0.38 },
  { name: 'まばたき', region: 'eyes', amount: 0.31 }, { name: 'ウィンク', region: 'eyeLeft', amount: 0.2 }, { name: 'ウィンク右', region: 'eyeRight', amount: 0.2 },
  { name: '笑い', region: 'eyes', amount: 0.2 }, { name: 'にっこり', region: 'mouth', amount: 0.04 }, { name: '困る', region: 'brows', amount: 0.17 },
  { name: '怒り', region: 'brows', amount: 0.21 }, { name: 'びっくり', region: 'eyes', amount: 0.07 }, { name: '照れ', region: 'cheeks', amount: 0.09 },
  { name: 'じと目', region: 'eyes', amount: 0.11 }, { name: '上', region: 'brows', amount: 0.105 },
];
export const ENGLISH_MORPHS: ToyMorph[] = [
  { name: 'aa', region: 'mouth', amount: 0.38 }, { name: 'ih', region: 'mouth', amount: 0.068 }, { name: 'ou', region: 'mouth', amount: 0.29 },
  { name: 'ee', region: 'mouth', amount: 0.126 }, { name: 'oh', region: 'mouth', amount: 0.38 },
  { name: 'Blink', region: 'eyes', amount: 0.31 }, { name: 'Blink_L', region: 'eyeLeft', amount: 0.2 }, { name: 'Blink_R', region: 'eyeRight', amount: 0.2 },
  { name: 'Eye_Smile', region: 'eyes', amount: 0.2 }, { name: 'Mouth_Smile', region: 'mouth', amount: 0.04 }, { name: 'Sad', region: 'brows', amount: 0.17 },
  { name: 'Angry', region: 'brows', amount: 0.21 }, { name: 'Surprised', region: 'eyes', amount: 0.07 }, { name: 'Blush', region: 'cheeks', amount: 0.09 },
  { name: 'Half_Closed', region: 'eyes', amount: 0.11 }, { name: 'Brow_Up', region: 'brows', amount: 0.105 },
];

const BONE_NAMES = {
  japanese: { root: '全ての親', center: 'センター', upper: '上半身', neck: '首', head: '頭', hair: '前髪', eyeL: '左目', eyeR: '右目',
    shoulderL: '左肩', shoulderR: '右肩', armL: '左腕', armR: '右腕', elbowL: '左ひじ', elbowR: '右ひじ', wristL: '左手首', wristR: '右手首',
    lower: '下半身', legL: '左足', legR: '右足', kneeL: '左ひざ', kneeR: '右ひざ', ankleL: '左足首', ankleR: '右足首',
    groove: 'グルーブ', armTwistL: '左腕捩', armTwistR: '右腕捩', wristTwistL: '左手捩', wristTwistR: '右手捩', legIkL: '左足ＩＫ', legIkR: '右足ＩＫ' },
  english: { root: 'Root', center: 'Center', upper: 'UpperBody', neck: 'Neck', head: 'Head', hair: 'Hair_Front', eyeL: 'Eye_L', eyeR: 'Eye_R',
    shoulderL: 'Shoulder_L', shoulderR: 'Shoulder_R', armL: 'Arm_L', armR: 'Arm_R', elbowL: 'Elbow_L', elbowR: 'Elbow_R', wristL: 'Wrist_L', wristR: 'Wrist_R',
    lower: 'LowerBody', legL: 'Leg_L', legR: 'Leg_R', kneeL: 'Knee_L', kneeR: 'Knee_R', ankleL: 'Ankle_L', ankleR: 'Ankle_R',
    groove: 'Groove', armTwistL: 'ArmTwist_L', armTwistR: 'ArmTwist_R', wristTwistL: 'WristTwist_L', wristTwistR: 'WristTwist_R', legIkL: 'LegIK_L', legIkR: 'LegIK_R' },
} as const;

export function toyModel(options: ToyOptions = {}): ModelData {
  const scale = options.scale ?? 1, names = BONE_NAMES[options.names ?? 'japanese'];
  const bones: ModelData['bones'] = [];
  const bone = (name: string, parent: number, x: number, y: number, z = 0, ik = false) => { bones.push({ name, parent, position: [x * scale, y * scale, z * scale], ik }); return bones.length - 1; };
  const root = bone(names.root, -1, 0, 0), center = bone(names.center, root, 0, 9.2);
  const body = options.groove ? bone(names.groove, center, 0, 9.4) : center, upper = bone(names.upper, body, 0, 11.8);
  const neck = bone(names.neck, upper, 0, 15.8), head = bone(names.head, neck, 0, 17.3), hair = bone(names.hair, head, 0, 19);
  if (options.eyeBones !== false) { bone(names.eyeL, head, 0.45, 17.95, 0.5); bone(names.eyeR, head, -0.45, 17.95, 0.5); }
  const t = options.pose === 'T';
  for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
    const shoulder = bone(names[`shoulder${side}`], upper, 0.27 * sign, 15.77);
    const arm = bone(names[`arm${side}`], shoulder, 1.33 * sign, 15.36);
    const ex = (t ? 3.9 : 3.69) * sign, ey = t ? 15.36 : 13.77, wx = (t ? 6.5 : 6.25) * sign, wy = t ? 15.36 : 12.05;
    const upperArm = options.twist ? bone(names[`armTwist${side}`], arm, (1.33 * sign + ex) / 2, (15.36 + ey) / 2) : arm;
    const elbow = bone(names[`elbow${side}`], upperArm, ex, ey);
    const forearm = options.twist ? bone(names[`wristTwist${side}`], elbow, (ex + wx) / 2, (ey + wy) / 2) : elbow;
    bone(names[`wrist${side}`], forearm, wx, wy);
  }
  const lower = bone(names.lower, body, 0, 11.5);
  for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
    const leg = bone(names[`leg${side}`], lower, 0.88 * sign, 10.48);
    const knee = bone(names[`knee${side}`], leg, 0.88 * sign, 5.77);
    bone(names[`ankle${side}`], knee, 0.88 * sign, 1.33);
    if (options.ik) bone(names[`legIk${side}`], root, 0.88 * sign, 1.33, 0, true);
  }
  const points: number[] = [], skin: number[] = [];
  const regions: Record<ToyRegion, number[]> = { mouth: [], eyes: [], eyeLeft: [], eyeRight: [], brows: [], cheeks: [], body: [] };
  const add = (x: number, y: number, z: number, owner: number) => { points.push(x * scale, y * scale, z * scale); skin.push(owner); return skin.length - 1; };
  for (let row = 0; row <= 30; row++) for (let column = -2; column <= 2; column++) regions.body.push(add(column * 0.5, row * 0.5, 0.3, upper));
  for (let row = 0; row <= 22; row++) for (let column = -10; column <= 10; column++) {
    const x = column / 10, y = 16.8 + row / 10;
    const vertex = add(x, y, 1 - 0.3 * x * x, head);
    add(x, y, -1, head);
    const ax = Math.abs(column);
    if (ax <= 2 && (row === 3 || row === 4)) regions.mouth.push(vertex);
    if (ax >= 3 && ax <= 6 && row >= 11 && row <= 12) { regions.eyes.push(vertex); (x > 0 ? regions.eyeLeft : regions.eyeRight).push(vertex); }
    if (ax >= 2 && ax <= 7 && row === 15) regions.brows.push(vertex);
    if (ax >= 4 && ax <= 7 && row >= 7 && row <= 9) regions.cheeks.push(vertex);
  }
  for (let row = 0; row <= 10; row++) for (let column = -11; column <= 11; column++) add(column / 10, 18.65 + row / 10, 0, hair);
  const direction: Record<ToyRegion, [number, number, number]> = { mouth: [0, -1, 0], eyes: [0, -1, 0], eyeLeft: [0, -1, 0], eyeRight: [0, -1, 0],
    brows: [0, -1, 0], cheeks: [0, 0, 1], body: [0, 0, 1] };
  const morphs = (options.morphs ?? (options.names === 'english' ? ENGLISH_MORPHS : JAPANESE_MORPHS)).map(morph => {
    const indices = regions[morph.region];
    const along = (vertex: number) => morph.offset ? morph.offset(points[vertex * 3] / scale, points[vertex * 3 + 1] / scale, points[vertex * 3 + 2] / scale) : direction[morph.region];
    return { name: morph.name, type: 1, indices: [...indices], deltas: indices.flatMap(vertex => along(vertex).map(value => value * morph.amount * scale)) };
  });
  return { positions: Float32Array.from(points), skinBone: Int32Array.from(skin), bones, morphs };
}

/** What the stage adapter (src/stage/model-profile.ts) reads from an MMDLoader mesh: full weights, dynamic rigid bodies and grants when present. */
export function profileInput(data: ModelData): ModelProfileInput {
  const physics = new Set((data.rigidBodies ?? []).filter(body => body.type !== 0 && body.boneIndex >= 0).map(body => body.boneIndex));
  return { positions: data.positions, skinBone: data.skinBone,
    ...(data.skinIndices && data.skinWeights ? { skinWeights: { indices: data.skinIndices, weights: data.skinWeights, width: 4 } } : {}),
    bones: data.bones.map((bone, index) => physics.has(index) ? { ...bone, physics: true } : bone),
    morphs: data.morphs.map(morph => ({ name: morph.name, offsets: () => morph.indices.length ? { indices: morph.indices, deltas: morph.deltas } : null })) };
}

/**
 * MMDLoader-shaped Three mesh: absolute Float32 morph targets, bones at rest under the mesh, one dominant skin bone per vertex.
 * `fullSkin` keeps all four skin weights and adds MMDLoader's rigid-body and grant metadata (what the collision proxy reads).
 */
export function toThreeMesh(data: ModelData, options: { fullSkin?: boolean } = {}): SkinnedMesh {
  const count = data.positions.length / 3, geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(data.positions, 3));
  const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
  const full = options.fullSkin === true && data.skinIndices && data.skinWeights;
  if (full) { skinIndex.set(Uint16Array.from(data.skinIndices!)); skinWeight.set(data.skinWeights!); }
  else for (let vertex = 0; vertex < count; vertex++) { skinIndex[vertex * 4] = Math.max(0, data.skinBone[vertex]); skinWeight[vertex * 4] = 1; }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  geometry.morphAttributes.position = data.morphs.map(morph => {
    const target = Float32Array.from(data.positions);
    morph.indices.forEach((vertex, k) => { for (let c = 0; c < 3; c++) target[vertex * 3 + c] += morph.deltas[k * 3 + c]; });
    const attribute = new Float32BufferAttribute(target, 3); attribute.name = morph.name;
    return attribute;
  });
  geometry.morphTargetsRelative = false;
  geometry.userData.MMD = { iks: data.bones.flatMap((bone, index) => bone.ik ? [{ target: index }] : []),
    grants: full ? data.bones.flatMap((bone, index) => bone.grant ? [{ index, parentIndex: bone.grant.parent, ratio: bone.grant.ratio, affectRotation: true, affectPosition: false }] : []) : [],
    ...(full ? { rigidBodies: (data.rigidBodies ?? []).map(body => ({ boneIndex: body.boneIndex, type: body.type })) } : {}) };
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  const bones = data.bones.map(({ name }) => Object.assign(new Bone(), { name }));
  data.bones.forEach((source, index) => {
    const parent = source.parent >= 0 ? data.bones[source.parent].position : [0, 0, 0];
    bones[index].position.set(source.position[0] - parent[0], source.position[1] - parent[1], source.position[2] - parent[2]);
    (source.parent >= 0 ? bones[source.parent] : mesh).add(bones[index]);
  });
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  mesh.updateMorphTargets(); // dictionary keyed by attribute name, as MMDLoader's meshes are
  return mesh;
}
