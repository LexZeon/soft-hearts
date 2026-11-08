import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { encodeVmd, parseBvh, retargetBvhToGene, type BoneFrame, type TargetBone } from '../scripts/lib/bvh-to-gene.mjs';

// Original, tiny BVH with an extra unknown joint and a T-pose. The target uses an
// A-pose and an unmapped helper between the upper arm and elbow.
const tree = [
  ['Hips', -1, [0, 0, 0]], ['Chest', 0, [0, 2, 0]], ['Chest4', 1, [0, 2, 0]],
  ['Neck', 2, [0, 1, 0]], ['Head', 3, [0, 1, 0]],
  ['LeftCollar', 2, [0.5, 0, 0]], ['LeftShoulder', 5, [0.5, 0, 0]], ['LeftElbow', 6, [2, 0, 0]], ['LeftWrist', 7, [2, 0, 0]],
  ['RightCollar', 2, [-0.5, 0, 0]], ['RightShoulder', 9, [-0.5, 0, 0]], ['RightElbow', 10, [-2, 0, 0]], ['RightWrist', 11, [-2, 0, 0]],
  ['UnknownAccessory', 4, [0, 0.3, 0]],
] as const;
const bones: TargetBone[] = [
  { name: 'センター', parentIndex: -1, position: [0, 10, 0] },
  { name: '下半身', parentIndex: 0, position: [0, 10, 0] },
  { name: '上半身', parentIndex: 0, position: [0, 12, 0], connectIndex: 3 },
  { name: '上半身2', parentIndex: 2, position: [0, 14, 0], connectIndex: 4 },
  { name: '首', parentIndex: 3, position: [0, 15, 0], connectIndex: 5 },
  { name: '頭', parentIndex: 4, position: [0, 16, 0], offsetPosition: [0, 1, 0] },
  { name: '左肩', parentIndex: 3, position: [0.5, 14, 0], connectIndex: 7 },
  { name: '左腕', parentIndex: 6, position: [1, 14, 0], offsetPosition: [2, -1, 0] },
  { name: '左腕捩', parentIndex: 7, position: [2, 13.5, 0] },
  { name: '左ひじ', parentIndex: 8, position: [3, 13, 0], offsetPosition: [2, -1, 0] },
  { name: '左手首', parentIndex: 9, position: [5, 12, 0], offsetPosition: [1, -0.5, 0] },
  { name: '右肩', parentIndex: 3, position: [-0.5, 14, 0], connectIndex: 12 },
  { name: '右腕', parentIndex: 11, position: [-1, 14, 0], offsetPosition: [-2, -1, 0] },
  { name: '右ひじ', parentIndex: 12, position: [-3, 13, 0], offsetPosition: [-2, -1, 0] },
  { name: '右手首', parentIndex: 13, position: [-5, 12, 0], offsetPosition: [-1, -0.5, 0] },
];

function fixture(rotateRoot = false) {
  const rows: string[] = [];
  function node(index: number, depth: number) {
    const [name, parent, offset] = tree[index];
    const indent = ' '.repeat(depth);
    rows.push(`${indent}${parent < 0 ? 'ROOT' : 'JOINT'} ${name}`, `${indent}{`, `${indent} OFFSET ${offset.join(' ')}`, `${indent} CHANNELS ${parent < 0 ? '6 Xposition Yposition Zposition ' : '3 '}Zrotation Xrotation Yrotation`);
    const children = tree.map((entry, i) => entry[1] === index ? i : -1).filter(i => i >= 0);
    children.forEach(child => node(child, depth + 1));
    if (!children.length) rows.push(`${indent} End Site`, `${indent} {`, `${indent} OFFSET ${name.includes('Wrist') ? (name.startsWith('Left') ? '1 0 0' : '-1 0 0') : '0 1 0'}`, `${indent} }`);
    rows.push(`${indent}}`);
  }
  rows.push('HIERARCHY'); node(0, 0); rows.push('MOTION', 'Frames: 4', 'Frame Time: 0.03333333333333333');
  const hierarchyNames: string[] = [];
  const walk = (index: number) => { hierarchyNames.push(tree[index][0]); tree.forEach((entry, i) => { if (entry[1] === index) walk(i); }); };
  walk(0);
  for (let frame = 0; frame < 4; frame++) {
    const values: number[] = [];
    for (const name of hierarchyNames) {
      if (name === 'Hips') values.push(frame * 2, 10 + frame, frame * 3);
      values.push(name === 'LeftShoulder' ? frame * 15 : rotateRoot && name === 'Hips' ? frame * 5 : 0, name === 'Head' ? frame * 5 : 0, 0);
    }
    rows.push(values.join(' '));
  }
  return rows.join('\n');
}

async function parsed(bytes: Buffer) {
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  return new MMDParser.Parser().parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true) as { motions: BoneFrame[] };
}

function worldRotations(frames: BoneFrame[], frame: number) {
  const selected = new Map(frames.filter(entry => entry.frameNum === frame).map(entry => [entry.boneName, entry]));
  const rotations: Quaternion[] = [];
  bones.forEach(bone => {
    const rotation = new Quaternion().fromArray(selected.get(bone.name)?.rotation ?? [0, 0, 0, 1]);
    if (bone.parentIndex >= 0) rotation.premultiply(rotations[bone.parentIndex]);
    rotations.push(rotation);
  });
  return rotations;
}

test('BVH retarget solves the A-pose correction and parent/helper rotations in world space', async () => {
  const result = retargetBvhToGene(fixture(), bones, { faceForward: false, scale: 1 });
  const vmd = await parsed(result.bytes);
  assert.equal(result.report.outputFrameCount, 4);
  assert.equal(result.report.mapping['左腕'], 'LeftShoulder');
  assert.ok(!Object.values(result.report.mapping).includes('UnknownAccessory'));
  for (const frame of [0, 3]) {
    const rotations = worldRotations(vmd.motions, frame);
    const direction = new Vector3(2, -1, 0).normalize().applyQuaternion(rotations[7]);
    const expected = new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 0, 1), frame * 15 * Math.PI / 180);
    assert.ok(direction.distanceTo(expected) < 1e-6, `arm world aim at frame ${frame}`);
  }
  for (const frame of vmd.motions) {
    assert.ok([...frame.position, ...frame.rotation].every(Number.isFinite));
    assert.ok(Math.abs(new Quaternion().fromArray(frame.rotation).length() - 1) < 1e-6);
  }
});

test('root policies, source crops and upper-body-only conversion keep desktop placement explicit', async () => {
  const input = fixture();
  const fixed = await parsed(retargetBvhToGene(input, bones, { rootMode: 'fixed', scale: 1 }).bytes);
  assert.ok(fixed.motions.filter(frame => frame.boneName === 'センター').every(frame => frame.position.every(value => value === 0)));
  const relative = await parsed(retargetBvhToGene(input, bones, { rootMode: 'relative', startFrame: 1, endFrame: 3, scale: 1, faceForward: false }).bytes);
  const center = relative.motions.filter(frame => frame.boneName === 'センター');
  assert.deepEqual(center[0].position.map(value => value || 0), [0, 0, 0]);
  assert.deepEqual(center.at(-1)?.position, [4, 2, 6]);
  const upper = await parsed(retargetBvhToGene(input, bones, { upperBodyOnly: true, rootMode: 'relative', scale: 1 }).bytes);
  assert.ok(!upper.motions.some(frame => frame.boneName === '下半身'));
  assert.ok(upper.motions.filter(frame => frame.boneName === 'センター').every(frame => frame.position.every(value => value === 0)));
});

test('loop blending closes both position and quaternion seams', async () => {
  const vmd = await parsed(retargetBvhToGene(fixture(), bones, { loopBlendSeconds: 1 / 30, rootMode: 'relative', scale: 1 }).bytes);
  const first = new Map(vmd.motions.filter(frame => frame.frameNum === 0).map(frame => [frame.boneName, frame]));
  const last = vmd.motions.filter(frame => frame.frameNum === 3);
  for (const frame of last) {
    assert.deepEqual(frame.position, first.get(frame.boneName)?.position);
    const initial = new Quaternion().fromArray(first.get(frame.boneName)!.rotation);
    assert.ok(initial.angleTo(new Quaternion().fromArray(frame.rotation)) < 0.001);
  }
});

test('VMD encoding round-trips right-handed translation and rotations through the actual MMD parser', async () => {
  const source: BoneFrame = { boneName: '左足ＩＫ', frameNum: 12, position: [1, 2, 3], rotation: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4).toArray() };
  const result = await parsed(encodeVmd([source]));
  assert.equal(result.motions[0].boneName, source.boneName);
  assert.deepEqual(result.motions[0].position, source.position);
  assert.ok(new Quaternion().fromArray(result.motions[0].rotation).angleTo(new Quaternion().fromArray(source.rotation)) < 0.001);
});

test('generated leg IK targets follow FK effectors instead of pulling the pose back to rest', async () => {
  const target: TargetBone[] = [...bones,
    { name: '左足', parentIndex: 1, position: [0.5, 10, 0], connectIndex: 16 },
    { name: '左ひざ', parentIndex: 15, position: [0.5, 5, 0], connectIndex: 17 },
    { name: '左足首', parentIndex: 16, position: [0.5, 1, 0], connectIndex: 18 },
    { name: '左足先', parentIndex: 17, position: [0.5, 0, 1] },
    { name: '左足IK親', parentIndex: 0, position: [0.5, 0, 0] },
    { name: '左足ＩＫ', parentIndex: 19, position: [0.5, 1, 0], ik: { effector: 17 } },
    { name: '左つま先ＩＫ', parentIndex: 20, position: [0.5, 0, 1], ik: { effector: 18 } },
  ];
  const vmd = await parsed(retargetBvhToGene(fixture(true), target, { faceForward: false, scale: 1 }).bytes);
  const selected = new Map(vmd.motions.filter(frame => frame.frameNum === 3).map(frame => [frame.boneName, frame]));
  const positions: Vector3[] = [];
  const rotations: Quaternion[] = [];
  target.forEach(bone => {
    const motion = selected.get(bone.name);
    const local = new Vector3(...bone.position);
    const rotation = new Quaternion().fromArray(motion?.rotation ?? [0, 0, 0, 1]);
    if (bone.parentIndex >= 0) {
      local.sub(new Vector3(...target[bone.parentIndex].position));
      local.add(new Vector3().fromArray(motion?.position ?? [0, 0, 0]));
      local.applyQuaternion(rotations[bone.parentIndex]).add(positions[bone.parentIndex]);
      rotation.premultiply(rotations[bone.parentIndex]);
    } else local.add(new Vector3().fromArray(motion?.position ?? [0, 0, 0]));
    positions.push(local); rotations.push(rotation);
  });
  assert.ok(positions[20].distanceTo(positions[17]) < 1e-6);
  assert.ok(positions[21].distanceTo(positions[18]) < 1e-6);
  assert.ok(selected.get('左足ＩＫ')!.position.some(value => Math.abs(value) > 0.01));
});

test('malformed BVH, nonfinite channels, invalid crop and unsupported skeletons fail before output', () => {
  const input = fixture();
  assert.throws(() => parseBvh(input.replace('Frames: 4', 'Frames: 5')), /does not match/);
  assert.throws(() => parseBvh(input.replace('0 10 0 0', '0 NaN 0 0')), /Invalid/);
  assert.throws(() => retargetBvhToGene(input, bones, { endFrame: 50 }), /crop/);
  assert.throws(() => retargetBvhToGene(input.replaceAll('LeftShoulder', 'NotAnArm'), bones), /mappings/);
  assert.throws(() => encodeVmd([{ boneName: 'センター', frameNum: 0, position: [0, 0, NaN], rotation: [0, 0, 0, 1] }]), /Invalid/);
});
