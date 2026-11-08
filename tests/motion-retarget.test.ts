import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3, type Bone } from 'three';
import { buildModelProfile } from '../shared/model-profile';
import {
  LINEAR_INTERPOLATION, buildRetargetRig, compactRig, evaluatePose, ikTarget, planRetarget, qarc, qconj, qmul, qrotate, retargetTracks, retargetVmd,
  rigFromCompact, tracksOnRig, vlength, vnormalize, vsub, writeVmd, type CompactRig, type RetargetRig, type Tracks, type VmdLike,
} from '../shared/motion-retarget';
import { sha256Hex } from '../shared/sha256-sync';
import { stripDefaultVmdTracks } from '../src/stage/vmd-tracks';
import geneSource from '../shared/retarget-gene-source.json';
import bundled from '../shared/bundled-assets.json';
import { readVmdLite } from './helpers/vmd-lite';
import { catalogMotions, loadBundledMotion, motionBytes, readGene } from './helpers/bundled-motions';
import { profileInput, toThreeMesh, toyModel, type ModelData, type ToyMorph, type ToyOptions } from './helpers/model-fixtures';

const loadMotion = loadBundledMotion;
const gene = readGene();
const rigOf = (data: ModelData, key: string) => buildRetargetRig({ key, profile: buildModelProfile(profileInput(data)), bones: data.bones, morphNames: data.morphs.map(morph => morph.name) });
const source = rigFromCompact(geneSource as CompactRig);
const geneRig = rigOf(gene, 'gene-mesh');
const toy = (options: ToyOptions, key = JSON.stringify(options)) => rigOf(toyModel(options), key);

const angleDeg = (a: number[], b: number[]) => Math.acos(Math.min(1, Math.max(-1, vnormalize(a as never).reduce((sum, value, k) => sum + value * vnormalize(b as never)[k], 0)))) * 180 / Math.PI;
const dir = (rig: RetargetRig, tracks: Tracks, frame: number, from: string, to: string) => {
  const pose = evaluatePose(rig, tracks, frame);
  return vsub(pose.wp[rig.slots[to as never]!], pose.wp[rig.slots[from as never]!]);
};
const frame = (boneName: string, frameNum: number, rotation: number[], position = [0, 0, 0]) =>
  ({ boneName, frameNum, position, rotation, interpolation: [...LINEAR_INTERPOLATION] });
const vmdOf = (motions: ReturnType<typeof frame>[], morphs: { morphName: string; frameNum: number; weight: number }[] = []): VmdLike =>
  ({ metadata: { motionCount: motions.length, morphCount: morphs.length }, motions, morphs });

test('sync SHA-256 matches node:crypto, including padding edges and a real VMD', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const bytes = Uint8Array.from({ length }, (_, k) => (k * 31 + 7) & 255);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'), String(length));
  }
  const stand = catalogMotions.find(motion => motion.id === 'stand')!;
  assert.equal(sha256Hex(motionBytes('gene', stand.relativePath)), stand.sha256);
  assert.equal(sha256Hex('soft hearts'), createHash('sha256').update('soft hearts').digest('hex'));
});

test('the shipped Gene source rig is exactly what the bundled gene.pmx profile gives', () => {
  assert.deepEqual(compactRig({ ...geneRig, key: `gene:${bundled.model.sha256}` }), geneSource);
  assert.equal(source.key, `gene:${bundled.model.sha256}`);
});

test('formula: q_t = A_p⁻¹ · q_s · A_b keeps every segment pointing where the source points it (random rests and poses)', () => {
  // Independent check with Three's Quaternion: two-bone chains with different rest directions.
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  const randomQuat = () => new Quaternion(random(), random(), random(), random()).normalize();
  const randomDir = () => new Vector3(random(), random(), random()).normalize();
  for (let trial = 0; trial < 50; trial++) {
    const dS = [randomDir(), randomDir()], dT = [randomDir(), randomDir()];
    const A = dT.map((d, k) => new Quaternion().setFromUnitVectors(d, dS[k]));
    const qS = [randomQuat(), randomQuat()], parentWorld = randomQuat();
    const qT = [A[0].clone().premultiply(new Quaternion()).multiply(new Quaternion()), new Quaternion()];
    qT[0] = qS[0].clone().multiply(A[0]); // root of the chain: its parent needs no correction
    qT[1] = A[0].clone().invert().multiply(qS[1]).multiply(A[1]);
    const WS0 = parentWorld.clone().multiply(qS[0]), WS1 = WS0.clone().multiply(qS[1]);
    const WT0 = parentWorld.clone().multiply(qT[0]), WT1 = WT0.clone().multiply(qT[1]);
    assert.ok(dT[0].clone().applyQuaternion(WT0).distanceTo(dS[0].clone().applyQuaternion(WS0)) < 1e-9);
    assert.ok(dT[1].clone().applyQuaternion(WT1).distanceTo(dS[1].clone().applyQuaternion(WS1)) < 1e-9);
    // The module's own quaternion helpers agree with Three.
    const mine = qmul(qmul(qconj(A[0].toArray() as never), qS[1].toArray() as never), A[1].toArray() as never);
    assert.ok(new Quaternion(...mine).angleTo(qT[1]) < 1e-6);
    const arc = qarc(dT[0].toArray() as never, dS[0].toArray() as never);
    assert.ok(new Quaternion(...arc).angleTo(A[0]) < 1e-7);
  }
});

test('rest-pose correction: Gene (A-pose) stand on a T-pose model keeps the visual arm direction instead of arms out', () => {
  const target = toy({ pose: 'T' });
  const plan = planRetarget(source, target);
  assert.equal(plan.identity, false);
  assert.ok(Math.abs(plan.alignedDeg.armLeft! - 34) < 1 && Math.abs(plan.alignedDeg.armRight! - 34) < 1, JSON.stringify(plan.alignedDeg));
  const stand = loadMotion('stand');
  const sourceTracks = tracksOnRig(stand, source), result = retargetTracks(stand, plan);
  const naive = tracksOnRig(stand, target); // the old behaviour: same names, same rotations
  for (const at of [0, 30, 60, 120]) for (const side of ['Left', 'Right']) {
    for (const [from, to] of [[`arm${side}`, `elbow${side}`], [`elbow${side}`, `wrist${side}`]]) {
      const wanted = dir(source, sourceTracks, at, from, to);
      assert.ok(angleDeg(dir(target, result.tracks, at, from, to), wanted) < 0.5, `${from} at ${at}`);
      assert.ok(angleDeg(dir(target, naive, at, from, to), wanted) > 25, 'without retargeting the arms stay out');
    }
  }
  // Arms really hang: wrists well below the shoulders on the T-pose model.
  const pose = evaluatePose(target, result.tracks, 60);
  assert.ok(pose.wp[target.slots.wristLeft!][1] < pose.wp[target.slots.armLeft!][1] - 2.5);
});

test('rest-pose correction verified with Three bones: retargeted VMD values on a T-pose mesh match Gene with the original values', () => {
  const tData = toyModel({ pose: 'T', twist: true }), target = rigOf(tData, 't-twist');
  const plan = planRetarget(source, target), stand = loadMotion('stand');
  const out = retargetVmd(stand, plan).vmd;
  const pose = (data: ModelData, vmd: VmdLike) => {
    const mesh = toThreeMesh(data), byName = new Map<string, Bone>(mesh.skeleton.bones.map(bone => [bone.name, bone]));
    for (const motion of vmd.motions) if (motion.frameNum === 0) byName.get(motion.boneName)?.quaternion.fromArray(Array.from(motion.rotation));
    mesh.updateMatrixWorld(true);
    return (name: string) => byName.get(name)!.getWorldPosition(new Vector3());
  };
  const sourcePose = pose(gene, stand), targetPose = pose(tData, out);
  for (const [a, b] of [['左腕', '左ひじ'], ['左ひじ', '左手首'], ['右腕', '右ひじ'], ['右ひじ', '右手首']]) {
    const want = sourcePose(b).sub(sourcePose(a)).normalize(), got = targetPose(b).sub(targetPose(a)).normalize();
    assert.ok(want.angleTo(got) * 180 / Math.PI < 0.5, `${a}: ${(want.angleTo(got) * 180 / Math.PI).toFixed(2)}°`);
  }
});

test('missing twist bones fold into the parent: the wrist ends up exactly where the source chain puts it', () => {
  const target = toy({ pose: 'A' }), plan = planRetarget(source, target);
  assert.deepEqual(plan.routes.armTwistLeft, { kind: 'fold', targets: [target.slots.armLeft!], side: 'parent', via: ['armLeft'] });
  assert.deepEqual(plan.routes.wristTwistLeft, { kind: 'fold', targets: [target.slots.elbowLeft!], side: 'parent', via: ['elbowLeft'] });
  for (const id of ['happy', 'thinking', 'surprise']) {
    const vmd = loadMotion(id), result = retargetTracks(vmd, plan), sourceTracks = tracksOnRig(vmd, source);
    assert.ok(result.report.folded.some(entry => entry.startsWith('左腕捩→左腕')), id);
    for (const at of [0, 45, 150, 299]) {
      const s = evaluatePose(source, sourceTracks, at), t = evaluatePose(target, result.tracks, at);
      for (const side of ['Left', 'Right'] as const) {
        // World hand rotation: W_t = W_s · A (alignment of the forearm).
        const want = qmul(s.wq[source.slots[`wrist${side}`]!], plan.align[target.slots[`wrist${side}`]!] ?? [0, 0, 0, 1]);
        const got = t.wq[target.slots[`wrist${side}`]!];
        // VMD quaternions are Float32-normalized, so compare directions of unit quaternions.
        assert.ok(new Quaternion(...got).normalize().angleTo(new Quaternion(...want).normalize()) < 1e-5, `${id} ${side} ${at}`);
      }
    }
  }
  // With twist bones on the target, the tracks go to them (renamed for English names).
  const english = toy({ pose: 'A', names: 'english', twist: true });
  const route = planRetarget(source, english).routes.armTwistLeft;
  assert.deepEqual(route, { kind: 'bone', target: english.slots.armTwistLeft! });
  const happy = retargetVmd(loadMotion('happy'), planRetarget(source, english)).vmd;
  assert.deepEqual([...new Set(happy.motions.map(motion => motion.boneName))].sort(), ['ArmTwist_L', 'ArmTwist_R', 'WristTwist_L', 'WristTwist_R']);
});

test('グルーブ folds into センター when the target has none', () => {
  const vmd = vmdOf([frame('センター', 0, [0, 0, 0, 1], [0, -0.5, 0]), frame('グルーブ', 0, [0, 0, 0, 1], [0, -0.25, 0.1])]);
  const withGroove = toy({ groove: true }), without = toy({});
  const a = retargetTracks(vmd, planRetarget(source, withGroove)), b = retargetTracks(vmd, planRetarget(source, without));
  const scale = planRetarget(source, without).scale;
  assert.ok(a.tracks.has(withGroove.slots.groove!));
  const center = b.tracks.get(without.slots.center!)![0].p;
  assert.ok(vlength(vsub(center, [0, -0.75 * scale, 0.1 * scale])) < 1e-9, String(center));
});

test('proportion scaling: root, center and IK translations scale by the leg-length ratio', () => {
  const small = toy({ scale: 0.8, ik: true }), plan = planRetarget(source, small);
  const legRatio = small.legLength! / source.legLength!;
  assert.ok(Math.abs(plan.scale - legRatio) < 1e-12 && Math.abs(legRatio - 0.8 * (9.15 / 9.211)) < 0.01, String(plan.scale));
  const vmd = vmdOf([frame('センター', 0, [0, 0, 0, 1], [0.2, -1, 0.3]), frame('左足ＩＫ', 0, [0, 0, 0, 1], [0, 0.5, -0.4]), frame('全ての親', 0, [0, 0, 0, 1], [1, 0, 0])]);
  const out = retargetTracks(vmd, plan);
  const at = (slot: 'center' | 'legIkLeft' | 'root') => out.tracks.get(small.slots[slot]!)![0].p;
  assert.ok(vlength(vsub(at('center'), [0.2 * plan.scale, -plan.scale, 0.3 * plan.scale])) < 1e-12);
  assert.ok(vlength(vsub(at('legIkLeft'), [0, 0.5 * plan.scale, -0.4 * plan.scale])) < 1e-12);
  assert.ok(vlength(vsub(at('root'), [plan.scale, 0, 0])) < 1e-12);
  // Heights differ, rest arms equal: rotations of the torso are untouched.
  const turn = vmdOf([frame('上半身', 0, [0, 0.2, 0, Math.sqrt(1 - 0.04)])]);
  assert.deepEqual(retargetTracks(turn, plan).tracks.get(small.slots.upperBody!)![0].q, [0, 0.2, 0, Math.sqrt(1 - 0.04)]);
});

const squat = () => vmdOf([frame('センター', 0, [0, 0, 0, 1]), frame('センター', 30, [0, 0, 0, 1], [0, -1.5, 0.2]), frame('センター', 60, [0, 0, 0, 1])]);
test('feet stay planted: the target\'s own leg IK holds them while the hips drop (IK bones re-solved on the target)', () => {
  const target = toy({ scale: 1.2, ik: true }), plan = planRetarget(source, target);
  assert.equal(plan.bakeLegIk, false);
  const out = retargetTracks(squat(), plan);
  for (let at = 0; at <= 60; at += 5) {
    const pose = evaluatePose(target, out.tracks, at);
    for (const side of ['Left', 'Right'] as const) {
      const goal = ikTarget(target, side, pose, undefined, at)!;
      assert.ok(vlength(vsub(goal, target.bones[target.slots[`ankle${side}`]!].position)) < 1e-9, 'IK goal stays on the floor');
      assert.ok(vlength(vsub(goal, pose.wp[target.slots[`leg${side}`]!])) <= target.legLength! * (1 + 1e-9), 'and stays within reach');
    }
  }
});

test('feet stay planted without leg IK: the source\'s IK intent is re-solved into FK leg keys', () => {
  const target = toy({ scale: 0.9 }), plan = planRetarget(source, target);
  assert.equal(plan.bakeLegIk, true);
  const lift = vmdOf([...squat().motions as ReturnType<typeof frame>[], frame('左足ＩＫ', 0, [0, 0, 0, 1]), frame('左足ＩＫ', 30, [0, 0, 0, 1], [0, 0.5, 0]), frame('左足ＩＫ', 60, [0, 0, 0, 1])]);
  const out = retargetTracks(lift, plan), unbaked = retargetTracks(lift, { ...plan, bakeLegIk: false });
  assert.equal(out.report.bakedLegIk, true);
  assert.ok(Math.max(...[...out.tracks.values()].flatMap(keys => keys.map(key => key.frame))) <= 60, 'baking never extends the motion');
  const rest = (side: 'Left' | 'Right') => target.bones[target.slots[`ankle${side}`]!].position;
  for (let at = 0; at <= 60; at += 2) {
    const pose = evaluatePose(target, out.tracks, at), lifted = 0.5 * plan.scale * (1 - Math.abs(at - 30) / 30);
    assert.ok(vlength(vsub(pose.wp[target.slots.ankleRight!], rest('Right'))) < 2e-3 * target.height, `right foot planted at ${at}`);
    assert.ok(Math.abs(pose.wp[target.slots.ankleLeft!][1] - (rest('Left')[1] + lifted)) < 2e-3 * target.height, `left foot follows its IK at ${at}`);
  }
  const deepest = evaluatePose(target, unbaked.tracks, 30);
  assert.ok(rest('Right')[1] - deepest.wp[target.slots.ankleRight!][1] > 1.2 * plan.scale, 'without the re-solve the feet sink with the hips');
});

test('semantic morph tracks: Gene names map through slots with calibration; unmapped tracks are dropped', () => {
  const tracks = [{ morphName: 'あ', frameNum: 0, weight: 0.6 }, { morphName: 'まばたき', frameNum: 0, weight: 1 }, { morphName: 'にこり', frameNum: 0, weight: 0.4 },
    { morphName: '困る', frameNum: 5, weight: 0.5 }];
  const english = toy({ names: 'english' });
  const out = retargetTracks(vmdOf([], tracks), planRetarget(source, english));
  const weight = (name: string) => out.morphs.get(name)?.[0].weight;
  const ratio = source.morphSlots.a!.amplitude / english.morphSlots.a!.amplitude;
  assert.ok(Math.abs(weight('aa')! - Math.min(1, 0.6 * ratio)) < 1e-12, String(weight('aa')));
  assert.equal(weight('Blink'), 1, 'eyelid closure is not rescaled');
  assert.equal(out.morphs.has('にこり'), false);
  assert.deepEqual(out.report.droppedMorphs, ['にこり']);
  assert.deepEqual(out.report.mappedMorphs, { 'あ': 'aa', 'まばたき': 'Blink', '困る': 'Sad' });
  // A mouth twice as wide as Gene's (relative to the head) gets half the weight.
  const wide: ToyMorph[] = [{ name: 'あ', region: 'mouth', amount: 0.76 }, { name: 'にこり', region: 'mouth', amount: 0.05 }];
  const wideRig = toy({ morphs: wide });
  const wideOut = retargetTracks(vmdOf([], tracks), planRetarget(source, wideRig));
  const expected = 0.6 * source.morphSlots.a!.amplitude / wideRig.morphSlots.a!.amplitude;
  assert.ok(expected < 0.45 && Math.abs(wideOut.morphs.get('あ')![0].weight - expected) < 1e-12, String(expected));
  assert.equal(wideOut.morphs.get('にこり')![0].weight, 0.4, 'a same-named non-slot morph passes through by exact name');
  // A decoy あ that moves the eyebrows is not the target of the あ track.
  const decoy: ToyMorph[] = [{ name: 'あ', region: 'brows', amount: 0.3 }, { name: 'aa', region: 'mouth', amount: 0.38 }];
  const decoyOut = retargetTracks(vmdOf([], tracks), planRetarget(source, toy({ morphs: decoy })));
  assert.equal(decoyOut.morphs.has('あ'), false);
  assert.ok(decoyOut.morphs.get('aa')![0].weight > 0);
});

test('Gene stays bit-identical: every bundled motion on Gene itself is returned untouched', () => {
  const plan = planRetarget(source, geneRig);
  assert.equal(plan.identity, true, JSON.stringify({ scale: plan.scale, aligned: plan.alignedDeg, bake: plan.bakeLegIk }));
  assert.equal(catalogMotions.length, 76);
  for (const motion of catalogMotions) {
    const vmd = stripDefaultVmdTracks(readVmdLite(motionBytes(motion.packId, motion.relativePath))).vmd;
    const snapshot = JSON.stringify(vmd);
    const result = retargetVmd(vmd, plan);
    assert.equal(result.vmd, vmd, motion.id);
    assert.equal(result.report.identity, true);
    assert.equal(JSON.stringify(vmd), snapshot, 'input not mutated');
    // Even the full conversion path writes identical numbers for Gene (identity corrections are skipped, never multiplied).
    const forced = writeVmd(vmd, geneRig, retargetTracks(vmd, { ...plan, identity: false }));
    const key = (value: { boneName: string; frameNum: number }) => `${value.boneName}@${value.frameNum}`;
    const original = new Map<string, { position: ArrayLike<number>; rotation: ArrayLike<number>; interpolation?: ArrayLike<number> }[]>();
    for (const entry of vmd.motions) if (geneRig.bones.some(bone => bone.name === entry.boneName)) original.set(key(entry), [...(original.get(key(entry)) ?? []), entry]);
    assert.equal(forced.motions.length, [...original.values()].reduce((sum, list) => sum + list.length, 0), motion.id);
    for (const entry of forced.motions) {
      const match = original.get(key(entry))!.find(candidate => Array.from(candidate.rotation).every((value, k) => Object.is(value, entry.rotation[k]))
        && Array.from(candidate.position).every((value, k) => Object.is(value, entry.position[k]))
        && Array.from(candidate.interpolation!).every((value, k) => Object.is(value, entry.interpolation![k])));
      assert.ok(match, `${motion.id} ${key(entry)}`);
    }
    const morphKey = (value: { morphName: string; frameNum: number; weight: number }) => `${value.morphName}@${value.frameNum}=${value.weight}`;
    assert.deepEqual(forced.morphs.map(morphKey).sort(), vmd.morphs.filter(entry => geneRig.morphNames.includes(entry.morphName)).map(morphKey).sort(), motion.id);
  }
});

test('retargeting never mutates its input and keeps the authored timeline', () => {
  const plan = planRetarget(source, toy({ pose: 'T', names: 'english' }));
  for (const id of ['laugh', 'neutral-idle', 'split-dance']) {
    const vmd = loadMotion(id), snapshot = JSON.stringify(vmd);
    const out = retargetVmd(vmd, plan).vmd;
    assert.equal(JSON.stringify(vmd), snapshot);
    assert.equal(out.metadata.motionCount, out.motions.length);
    assert.equal(out.metadata.morphCount, out.morphs.length);
    const last = (value: VmdLike) => Math.max(0, ...value.motions.map(entry => entry.frameNum), ...value.morphs.map(entry => entry.frameNum));
    assert.ok(last(out) <= last(vmd), id);
    for (const entry of out.motions) {
      assert.ok(Math.abs(Math.hypot(...Array.from(entry.rotation)) - 1) < 1e-6, "unit within the Float32 source precision");
      assert.equal(entry.interpolation!.length, 64);
    }
  }
});
