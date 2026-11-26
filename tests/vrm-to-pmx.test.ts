/**
 * VRM → PMX converter (electron/stage/model-import/vrm/) on a synthetic VRM built in the test (tests/helpers/synthetic-vrm.ts;
 * never a user's model). The output is read back with three's MMDParser and built with three's MMDLoader, then checked the
 * way the stage reads it: the model profile (standard bones, face slots, A pose), the physics rig, the procedural blush.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Texture, Vector3, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { convertVrmToPmx, geneArmDownDeg, mergeMapping, VrmImportError } from '../electron/stage/model-import/vrm/index';
import { defaultSourcePanel } from '../electron/stage/model-import/vrm/mapping';
import { splitTwists } from '../electron/stage/model-import/vrm/mesh';
import { StageModelProfile } from '../src/stage/model-profile';
import { buildPhysicsRigPlan } from '../src/stage/physics-rig';
import { syntheticVrm } from './helpers/synthetic-vrm';

interface ParsedBone { name: string; parentIndex: number; position: number[]; grant?: { parentIndex: number; ratio: number }; ik?: { effector: number; links: { index: number; angleLimitation: number; lowerLimitationAngle?: number[]; upperLimitationAngle?: number[] }[] } }
interface ParsedPmx {
  metadata: { encoding: number; version: number; vertexCount: number; faceCount: number };
  vertices: { position: number[]; normal: number[]; uv: number[]; type: number; skinIndices: number[]; skinWeights: number[] }[];
  faces: { indices: number[] }[];
  textures: string[];
  materials: { name: string; flag: number; edgeColor: number[]; edgeSize: number; textureIndex: number; faceCount: number; diffuse: number[] }[];
  bones: ParsedBone[];
  morphs: { name: string; panel: number; type: number; elements: { index: number; ratio?: number; position?: number[] }[] }[];
  frames: { name: string }[];
  rigidBodies: { name: string; boneIndex: number; type: number; shapeType: number; groupIndex: number; groupTarget: number }[];
  constraints: { rigidBodyIndex1: number; rigidBodyIndex2: number }[];
}
const { MMDParser } = await import('three/examples/jsm/libs/mmdparser.module.js' as string) as { MMDParser: { Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): ParsedPmx } } };
const parse = (bytes: Uint8Array, leftToRight = true) => new MMDParser.Parser().parsePmx(bytes.slice().buffer, leftToRight);

/** The stage's loader path with inert textures (tests/public-gene-fixture.ts does the same for Gene). */
function meshOf(bytes: Uint8Array): SkinnedMesh {
  const loader = new MMDLoader() as unknown as { meshBuilder: { materialBuilder: { _loadTexture: () => Texture }; build(data: unknown, resourcePath: string): SkinnedMesh } };
  loader.meshBuilder.materialBuilder._loadTexture = () => Object.assign(new Texture(), { readyCallbacks: [] });
  return loader.meshBuilder.build(parse(bytes), '');
}

const v1 = convertVrmToPmx(syntheticVrm());
const v0 = convertVrmToPmx(syntheticVrm({ version: '0.x' }));
const pmx1 = parse(v1.pmx), pmx0 = parse(v0.pmx);
const bone = (pmx: ParsedPmx, name: string) => { const index = pmx.bones.findIndex(b => b.name === name); assert.ok(index >= 0, `bone ${name}`); return index; };
const parentName = (pmx: ParsedPmx, name: string) => pmx.bones[pmx.bones[bone(pmx, name)].parentIndex]?.name;

test('the PMX is UTF-16 PMX 2.0 that MMDParser reads, with the merged geometry', () => {
  assert.equal(pmx1.metadata.encoding, 0);
  assert.equal(pmx1.metadata.version, 2);
  // Body 27 + face 15 (two primitives sharing one vertex block) + hair 6.
  assert.equal(pmx1.metadata.vertexCount, 48);
  assert.equal(pmx1.metadata.faceCount, 16);
  assert.equal(v1.report.counts.vertices, 48);
});

test('humanoid bones get the MMD standard names and the MMD structure', () => {
  for (const name of ['全ての親', 'センター', 'グルーブ', '下半身', '上半身', '上半身2', '首', '頭', '両目', '左目', '右目', '左肩', '左腕', '左腕捩', '左ひじ', '左手捩', '左手首',
    '左親指０', '左親指１', '左親指２', '左人指１', '左人指２', '左人指３', '右人指３', '左足', '左ひざ', '左足首', '左つま先', '右足', '右つま先', '左足IK親', '左足ＩＫ', '左つま先ＩＫ', '右足ＩＫ', '右つま先ＩＫ'])
    bone(pmx1, name);
  assert.equal(pmx1.bones[0].name, '全ての親');
  assert.equal(parentName(pmx1, 'センター'), '全ての親');
  assert.equal(parentName(pmx1, 'グルーブ'), 'センター');
  assert.equal(parentName(pmx1, '上半身'), 'グルーブ');
  assert.equal(parentName(pmx1, '下半身'), 'グルーブ');
  assert.equal(parentName(pmx1, '上半身2'), '上半身');
  assert.equal(parentName(pmx1, '左肩'), '上半身2');
  assert.equal(parentName(pmx1, '左腕'), '左肩');
  assert.equal(parentName(pmx1, '左腕捩'), '左腕');
  assert.equal(parentName(pmx1, '左ひじ'), '左腕捩');
  assert.equal(parentName(pmx1, '左手捩'), '左ひじ');
  assert.equal(parentName(pmx1, '左手首'), '左手捩');
  assert.equal(parentName(pmx1, '左人指１'), '左手首');
  assert.equal(parentName(pmx1, '左足'), '下半身');
  assert.equal(parentName(pmx1, '左つま先'), '左足首');
  // Spring and other nodes keep their own names and hang where they did; the non-humanoid Root folded into 全ての親.
  assert.equal(parentName(pmx1, 'J_Sec_Hair1_01'), '頭');
  assert.equal(parentName(pmx1, 'J_Sec_Hair2_01'), 'J_Sec_Hair1_01');
  assert.ok(!pmx1.bones.some(b => b.name === 'Root'));
  assert.deepEqual(v1.report.bones.foldedIntoRoot, ['Root']);
  // Parents always come before their children.
  pmx1.bones.forEach((b, k) => assert.ok(b.parentIndex < k, `${b.name} after its parent`));
  // Eyes follow 両目 by Gene's ratio.
  assert.equal(pmx1.bones[bone(pmx1, '左目')].grant?.parentIndex, bone(pmx1, '両目'));
  assert.ok(Math.abs(pmx1.bones[bone(pmx1, '右目')].grant!.ratio - 0.15) < 1e-6);
});

test('leg and toe IK chains as on the MMD standard models', () => {
  const legIk = pmx1.bones[bone(pmx1, '左足ＩＫ')].ik!;
  assert.equal(legIk.effector, bone(pmx1, '左足首'));
  assert.deepEqual(legIk.links.map(link => link.index), [bone(pmx1, '左ひざ'), bone(pmx1, '左足')]);
  assert.equal(legIk.links[0].angleLimitation, 1);
  assert.ok(Math.abs(legIk.links[0].lowerLimitationAngle![0] + Math.PI) < 1e-5);
  assert.ok(legIk.links[0].upperLimitationAngle![0] < 0 && legIk.links[0].upperLimitationAngle![0] > -0.02);
  assert.equal(legIk.links[1].angleLimitation, 0);
  const toeIk = pmx1.bones[bone(pmx1, '左つま先ＩＫ')].ik!;
  assert.equal(toeIk.effector, bone(pmx1, '左つま先'));
  assert.deepEqual(toeIk.links.map(link => link.index), [bone(pmx1, '左足首')]);
  assert.equal(parentName(pmx1, '左つま先ＩＫ'), '左足ＩＫ');
  assert.equal(parentName(pmx1, '左足ＩＫ'), '左足IK親');
});

test('weights: BDEF1/2/4, normalised, tiny ones dropped, the upper arm shared with its twist bone toward the elbow', () => {
  const types = new Set(pmx1.vertices.map(v => v.type));
  assert.ok(types.has(0) && types.has(1) && types.has(2));
  for (const v of pmx1.vertices) assert.ok(Math.abs(v.skinWeights.reduce((a, b) => a + b, 0) - 1) < 1e-5);
  const thumb = bone(pmx1, '左親指０');
  assert.ok(!pmx1.vertices.some(v => v.skinIndices.some((index, k) => index === thumb && v.skinWeights[k] > 0)), 'the 0.2 % thumb weight is dropped');
  // The upper-arm triangle near the elbow (body vertices 6–8): mostly 腕捩 by then, the rest 腕.
  const arm = bone(pmx1, '左腕'), twist = bone(pmx1, '左腕捩');
  const near = pmx1.vertices[7];
  const weightOn = (v: ParsedPmx['vertices'][number], index: number) => v.skinIndices.reduce((sum, b, k) => sum + (b === index ? v.skinWeights[k] : 0), 0);
  assert.ok(weightOn(near, twist) > 0.8 && weightOn(near, arm) > 0, `twist ${weightOn(near, twist)}`);
  // The split itself: nothing at the shoulder, all at the elbow.
  const split = { twists: [{ base: 1, twist: 2, start: [0, 0, 0] as [number, number, number], end: [1, 0, 0] as [number, number, number] }] };
  assert.deepEqual(splitTwists(new Map([[1, 1]]), new Vector3(0, 0, 0), split), [[1, 1]]);
  assert.deepEqual(splitTwists(new Map([[1, 1]]), new Vector3(1, 0, 0), split), [[2, 1]]);
});

test('A pose: the arms are lowered to Gene\'s angle, and the stage profile reads an A pose', async () => {
  // Gene's angle straight from the bundled gene.pmx, not only from the shipped standard pose.
  const gene = parse(new Uint8Array(await readFile(new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url))));
  const at = (name: string) => gene.bones.find(b => b.name === name)!.position;
  const geneDeg = Math.atan2(at('左腕')[1] - at('左ひじ')[1], at('左ひじ')[0] - at('左腕')[0]) * 180 / Math.PI;
  assert.ok(Math.abs(geneDeg - geneArmDownDeg()) < 0.01, `${geneDeg} vs ${geneArmDownDeg()}`);
  assert.ok(geneDeg > 25 && geneDeg < 45);
  for (const [label, pmx, result] of [['1.0', pmx1, v1], ['0.x', pmx0, v0]] as const) {
    const p = (name: string) => pmx.bones[bone(pmx, name)].position;
    const left = Math.atan2(p('左腕')[1] - p('左ひじ')[1], p('左ひじ')[0] - p('左腕')[0]) * 180 / Math.PI;
    const right = Math.atan2(p('右腕')[1] - p('右ひじ')[1], p('右腕')[0] - p('右ひじ')[0]) * 180 / Math.PI;
    assert.ok(Math.abs(left - geneDeg) < 0.01 && Math.abs(right - geneDeg) < 0.01, `${label}: ${left} / ${right}`);
    assert.deepEqual(result.report.aPose!.beforeDeg, [0, 0]);
    // The forearm and hand follow the upper arm: the arm stays straight, the hand vertices moved with the bones.
    const hand = p('左手首'), elbow = p('左ひじ');
    assert.ok(Math.abs(Math.atan2(elbow[1] - hand[1], hand[0] - elbow[0]) * 180 / Math.PI - geneDeg) < 0.01);
    const handVertex = pmx.vertices[15].position; // the triangle around (0.55, 1.3) m, skinned to the hand
    assert.ok(handVertex[1] < 1.3 * 12.5 - 2, `${label}: hand vertex lowered (${handVertex[1]})`);
    const profile = new StageModelProfile(meshOf(result.pmx), { reviewed: false });
    assert.equal(profile.summary.restPose, 'A', label);
    assert.ok(Math.abs(profile.summary.restArmDeg! - geneDeg) < 0.6, `${label}: ${profile.summary.restArmDeg}`);
    for (const core of ['center', 'upperBody', 'neck', 'head', 'armLeft', 'elbowLeft', 'wristLeft', 'legLeft', 'kneeLeft', 'ankleLeft'])
      assert.ok(!profile.summary.missingBones.includes(core as never), `${label}: ${core}`);
    const features = profile.summary.features!;
    assert.ok(features.ik && features.legIk && features.armTwist && features.wristTwist && features.groove && features.eyes === 'pair', `${label}: ${JSON.stringify(features)}`);
  }
});

test('facing and winding: 1.0 (+Z) and 0.x (−Z) both come out facing MMD\'s front, faces outward after MMDLoader', () => {
  for (const [label, result] of [['1.0', v1], ['0.x', v0]] as const) {
    const file = parse(result.pmx, false), three = parse(result.pmx, true);
    const at = (pmx: ParsedPmx, name: string) => pmx.bones[bone(pmx, name)].position;
    assert.ok(at(three, '左腕')[0] > 0, `${label}: her left arm at +X`);
    assert.ok(at(file, '左つま先')[2] < at(file, '左足首')[2], `${label}: toes toward −Z in the file (MMD front)`);
    assert.ok(at(three, '左つま先')[2] > at(three, '左足首')[2], `${label}: toes toward +Z after MMDLoader (Three front)`);
    const mesh = meshOf(result.pmx), position = mesh.geometry.getAttribute('position'), normal = mesh.geometry.getAttribute('normal'), index = mesh.geometry.index!;
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [0, 1, 2].map(k => new Vector3().fromBufferAttribute(position, index.getX(t + k)));
      const face = b.sub(a).cross(c.sub(a)).normalize();
      const n = new Vector3().fromBufferAttribute(normal, index.getX(t));
      assert.ok(face.dot(n) > 0.9, `${label}: triangle ${t / 3} faces its normal`);
      assert.ok(n.z > 0.9, `${label}: front-facing normal toward +Z`);
    }
  }
});

test('morphs: every source target kept on its panel, the stage names made from them (expressions first)', () => {
  const morph = (pmx: ParsedPmx, name: string) => { const index = pmx.morphs.findIndex(m => m.name === name); assert.ok(index >= 0, `morph ${name}`); return pmx.morphs[index]; };
  for (const pmx of [pmx1, pmx0]) {
    assert.equal(morph(pmx, 'Fcl_EYE_Close').type, 1);
    assert.equal(morph(pmx, 'Fcl_EYE_Close').panel, 2);
    assert.equal(morph(pmx, 'Fcl_MTH_A').panel, 3);
    const blink = morph(pmx, 'まばたき'), a = morph(pmx, 'あ');
    assert.equal(blink.type, 0);
    assert.equal(pmx.morphs[blink.elements[0].index].name, 'Fcl_EYE_Close');
    assert.equal(blink.panel, 2);
    assert.equal(pmx.morphs[a.elements[0].index].name, 'Fcl_MTH_A');
    assert.equal(a.panel, 3);
  }
  // 笑い has no VRM expression: taken from the VRoid eye-smile target.
  assert.equal(pmx1.morphs[morph(pmx1, '笑い').elements[0].index].name, 'Fcl_EYE_Joy');
  assert.equal(v1.report.morphs.mapped['まばたき'], 'Fcl_EYE_Close');
  assert.deepEqual([defaultSourcePanel('Fcl_BRW_Angry'), defaultSourcePanel('Fcl_HA_Hide'), defaultSourcePanel('Fcl_ALL_Joy')], ['brow', 'mouth', 'other']);
  const profile = new StageModelProfile(meshOf(v1.pmx), { reviewed: false });
  assert.equal(profile.summary.found.blink, 'まばたき');
  assert.equal(profile.summary.found.a, 'あ');
  assert.equal(profile.summary.found.smileEyes, '笑い');
});

test('a changed mapping changes the output, and the report\'s own mapping converts to the same bytes', () => {
  const changed = convertVrmToPmx(syntheticVrm(), { mapping: { morphs: { 笑い: { from: [{ morph: 'Fcl_MTH_A', weight: 0.5 }], panel: 'mouth' }, あ: null } } });
  const pmx = parse(changed.pmx);
  const smile = pmx.morphs.find(m => m.name === '笑い')!;
  assert.equal(pmx.morphs[smile.elements[0].index].name, 'Fcl_MTH_A');
  assert.equal(smile.elements[0].ratio, 0.5);
  assert.equal(smile.panel, 3);
  assert.ok(!pmx.morphs.some(m => m.name === 'あ'));
  assert.equal(changed.report.mapping.morphs['笑い'].from[0].morph, 'Fcl_MTH_A');
  // A humanoid remapped: the PMX's 頭 is now another node.
  const remapped = parse(convertVrmToPmx(syntheticVrm(), { mapping: { humanoid: { head: 'J_Bip_C_Neck', neck: null } } }).pmx);
  assert.ok(!remapped.bones.some(b => b.name === '首'));
  // The full report as a mapping: identical bytes.
  const again = convertVrmToPmx(syntheticVrm(), { mapping: JSON.parse(JSON.stringify(v1.report)) });
  assert.deepEqual(again.pmx, v1.pmx);
  const lowered = convertVrmToPmx(syntheticVrm(), { mapping: { aPose: { armDownDeg: 20 } } });
  assert.ok(Math.abs(lowered.report.aPose!.afterDeg[0] - 20) < 1e-6);
});

test('a malformed mapping is refused with the path that is wrong', () => {
  assert.throws(() => convertVrmToPmx(syntheticVrm(), { mapping: { humanoid: { tail: 'J_Bip_C_Hips' } } }), (error: unknown) => error instanceof VrmImportError && /humanoid\.tail/.test(error.message));
  assert.throws(() => mergeMapping(v1.report.mapping, { morphs: { 笑い: { from: [] } } }), /morphs\.笑い/);
  assert.throws(() => mergeMapping(v1.report.mapping, { aPose: { armDownDeg: 120 } }), /armDownDeg/);
  assert.throws(() => convertVrmToPmx(new Uint8Array(40)), VrmImportError);
});

test('materials: draw order for MMDLoader, culling, outline, textures and the baked texture transform', () => {
  assert.deepEqual(pmx1.materials.map(m => m.name), ['Body_00_SKIN', 'Face_00_SKIN', 'EyeIris_00_EYE', 'Hair_00_HAIR']);
  const [body, face, iris, hair] = pmx1.materials;
  assert.equal(body.flag & 0x01, 0);
  assert.equal(face.flag & 0x01, 1);
  assert.equal(hair.flag & 0x01, 1);
  assert.equal(body.flag & 0x10, 0x10);
  assert.deepEqual(body.edgeColor.map(v => Math.round(v * 100) / 100), [0.1, 0.2, 0.3, 1]);
  assert.ok(body.edgeSize > 0.3 && body.edgeSize < 0.7);
  assert.equal(face.flag & 0x10, 0);
  assert.deepEqual(pmx1.materials.map(m => m.diffuse[3]), [1, 1, 1, 1], 'no material forced into the transparent pass');
  assert.deepEqual(pmx1.textures, ['tex/00_skin_tex.png']);
  assert.equal(v1.textures.length, 1);
  assert.deepEqual([...v1.textures[0].bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok([body, face, iris, hair].every(m => m.textureIndex === 0));
  // The hair material carries KHR_texture_transform offset (0.5, 0.25) scale 0.5: hair vertex 1 (uv 0.5, 1) → (0.75, 0.75).
  assert.deepEqual(pmx1.vertices[43].uv, [0.75, 0.75]);
  assert.deepEqual(pmx1.vertices[27].uv, [0, 0], 'the face has none');
  // Hair triangles sorted back to front: the farther (z −0.145 m) strand first.
  const hairFirst = pmx1.faces[pmx1.faces.length - 2].indices.map(i => pmx1.vertices[i].position[2]);
  assert.ok(hairFirst.every(z => z < -0.14 * 12.5 + 1e-3), `${hairFirst}`);
});

test('physics: the hair chain as dynamic capsules hung from a 頭 anchor, colliders kinematic, the stage\'s rig finds hair', () => {
  const bodies = pmx1.rigidBodies, byBone = (name: string) => bodies.filter(b => b.boneIndex === bone(pmx1, name));
  assert.equal(byBone('J_Sec_Hair1_01')[0].type, 2);
  assert.equal(byBone('J_Sec_Hair2_01')[0].type, 2);
  assert.equal(byBone('J_Sec_Hair3_01').length, 0, 'the tail has no body');
  const anchor = byBone('頭').find(b => b.name.endsWith('_anchor'))!;
  assert.equal(anchor.type, 0);
  assert.equal(anchor.groupTarget, 0);
  const head = byBone('頭').find(b => !b.name.endsWith('_anchor'))!;
  assert.equal(head.type, 0);
  const first = bodies.indexOf(byBone('J_Sec_Hair1_01')[0]), second = bodies.indexOf(byBone('J_Sec_Hair2_01')[0]);
  const pairs = pmx1.constraints.map(c => [c.rigidBodyIndex1, c.rigidBodyIndex2].sort().join('-'));
  assert.ok(pairs.includes([bodies.indexOf(anchor), first].sort().join('-')));
  assert.ok(pairs.includes([first, second].sort().join('-')));
  // The root segment starts inside the head sphere: it does not collide with the head group; dynamic bodies never collide with each other.
  assert.equal(bodies[first].groupTarget & (1 << head.groupIndex), 0);
  assert.equal(bodies[first].groupTarget & (1 << 15), 0);
  const plan = buildPhysicsRigPlan(meshOf(v1.pmx));
  assert.equal(plan.support.hair.supported, true, plan.support.hair.reason ?? '');
  assert.equal(v0.report.physics!.chains, 1);
  assert.equal(parse(convertVrmToPmx(syntheticVrm(), { physics: false }).pmx).rigidBodies.length, 0);
});
