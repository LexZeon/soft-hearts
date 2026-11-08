import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Skeleton, SkinnedMesh } from 'three';
import { FINGERS, FINGER_JOINTS, buildModelProfile, type Vec3 } from '../shared/model-profile';
import { PROXY_SEGMENTS, acceptCollisionProxy, type CollisionProxy } from '../shared/collision-proxy';
import { adaptMotion, usesFittedBody } from '../shared/motion-fit';
import type { RetargetRig } from '../shared/motion-retarget';
import { stripDefaultVmdTracks } from '../src/stage/vmd-tracks';
import {
  CATALOG_MOTION_COUNT, GENE_SOURCE_RIG, RETARGET_CACHE_LIMIT, StageMotionRetarget, clearRetargetCache, meshRigBones, retargetCacheSize, retargetCacheStats,
  retargetInputKey, type MotionFitView,
} from '../src/stage/motion-retarget';
import { readVmdLite } from './helpers/vmd-lite';
import { bundledMotionBytes, catalogMotions, readGene } from './helpers/bundled-motions';
import { profileInput, toThreeMesh, toyModel, type ModelData, type ToyOptions } from './helpers/model-fixtures';

const gene = readGene();
const stageFor = (data: ModelData, options: { reviewed?: boolean; onChange?: (view: MotionFitView) => void } = {}) =>
  new StageMotionRetarget(toThreeMesh(data), buildModelProfile(profileInput(data)), { reviewed: options.reviewed ?? false, onChange: options.onChange });
/** What the stage's parser hook sees: the parsed, default-stripped data plus the original bytes. */
const parsed = (id: string) => {
  const bytes = bundledMotionBytes(id);
  return { vmd: stripDefaultVmdTracks(readVmdLite(bytes)).vmd, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
};
const toy = (options: ToyOptions) => toyModel(options);

test('the host-verified Gene gets no transform at all: its VMD load path is the old one', () => {
  const stage = stageFor(gene, { reviewed: true });
  assert.equal(stage.transform, undefined);
  assert.equal(stage.plan, null);
  assert.deepEqual(stage.summary(), { model: 'reviewed', total: 76, checked: 76, usable: 76, ok: 76, adjusted: 0, hidden: 0, hiddenMotions: [], adjustedMotions: [],
    partial: 0, partialMotions: [], structure: [], scan: 'none', armAlignDeg: null, scale: null });
  assert.equal(stage.statusOf('gene', 'laugh'), 'ok');
});

test('an unverified copy of Gene still plans as identity and gets the very same parsed objects back', () => {
  clearRetargetCache();
  const stage = stageFor(gene);
  assert.equal(stage.plan?.identity, true);
  for (const id of ['stand', 'laugh', 'conversation-joy', 'split-dance']) {
    const { vmd, buffer } = parsed(id);
    assert.equal(stage.transform!(vmd, buffer), vmd, id);
  }
  assert.equal(stage.summary().ok, 4);
  // The rig read from a real Three skeleton is Gene's own rest skeleton.
  const rig = meshRigBones(toThreeMesh(gene));
  assert.ok(rig.every((bone, index) => Math.hypot(...bone.position.map((value, k) => value - gene.bones[index].position[k])) < 1e-5));
});

test('a T-pose model: library motions are retargeted (renamed, re-posed) and their fit recorded by sha256', () => {
  clearRetargetCache();
  const views: MotionFitView[] = [];
  const stage = stageFor(toy({ pose: 'T', names: 'english' }), { onChange: view => views.push(view) });
  assert.ok(stage.plan && !stage.plan.identity);
  const { vmd, buffer } = parsed('stand');
  const out = stage.transform!(vmd, buffer);
  assert.notEqual(out, vmd);
  assert.ok(out.motions.some(frame => frame.boneName === 'Arm_L') && !out.motions.some(frame => frame.boneName === '左腕'));
  const stand = catalogMotions.find(motion => motion.id === 'stand')!;
  assert.equal(stage.fitOf(stand.sha256)?.status, 'ok');
  assert.equal(stage.statusOf('gene', 'stand'), 'ok');
  assert.equal(views.at(-1)?.motions['gene/stand'], 'ok');
  const summary = stage.summary();
  assert.equal(summary.model, 'adapted'); assert.equal(summary.total, CATALOG_MOTION_COUNT); assert.equal(summary.checked, 1); assert.equal(summary.usable, 1);
  assert.ok(Math.abs(summary.armAlignDeg! - 34) < 1, String(summary.armAlignDeg));
  assert.ok(!/[A-Za-z]:\\\\|\/home\/|mmd-asset/.test(JSON.stringify(stage.view())), 'plain data: no paths or asset URLs');
});

test('a VMD that is not a library motion passes through untouched (its source rig is unknown)', () => {
  const stage = stageFor(toy({ pose: 'T' }));
  const { vmd } = parsed('stand');
  const other = new Uint8Array([...bundledMotionBytes('stand')]); other[other.length - 1] ^= 1;
  assert.equal(stage.transform!(vmd, other.buffer), vmd);
  assert.equal(stage.summary().checked, 0);
});

test('caching: one conversion per (motion, model), shared across stages; bounded LRU', () => {
  clearRetargetCache();
  const data = toy({ pose: 'T', scale: 1.1 });
  const first = stageFor(data), second = stageFor(data);
  const { vmd, buffer } = parsed('laugh');
  const a = first.transform!(vmd, buffer);
  assert.deepEqual(retargetCacheStats, { hits: 0, misses: 1 });
  const b = second.transform!(parsed('laugh').vmd, buffer);
  assert.equal(b, a, 'the same converted data for the same model content');
  assert.deepEqual(retargetCacheStats, { hits: 1, misses: 1 });
  assert.equal(second.statusOf('gene', 'laugh'), first.statusOf('gene', 'laugh'), 'a cache hit still records the fit on that stage');
  const other = stageFor(toy({ pose: 'A', scale: 1.1 }));
  assert.notEqual(other.transform!(vmd, buffer), a);
  assert.deepEqual(retargetCacheStats, { hits: 1, misses: 2 });
  // Bounded: many models never grow the cache past its limit; the oldest entry is the one evicted.
  const small = parsed('normal');
  for (let k = 0; k < RETARGET_CACHE_LIMIT + 3; k++) stageFor(toy({ scale: 1 + (k + 1) / 997 })).transform!(small.vmd, small.buffer);
  assert.equal(retargetCacheSize(), RETARGET_CACHE_LIMIT);
  const misses = retargetCacheStats.misses;
  first.transform!(vmd, buffer);
  assert.equal(retargetCacheStats.misses, misses + 1, 'the first model was evicted');
});

/**
 * Codex's X-322 fixture (T-213 retest-c130 round-001, regression.mts + cache-schema-control.mts), rebuilt step by step: the
 * Japanese toy (groove, twists, leg IK) with finger chains, the shipped Gene proxy scaled to it as profile A, and B the same
 * profile with the pelvis, abdomen, chest and neck capsules widened. Same bones, morphs and rigKey; only the collision differs.
 * (A probe confirmed it is byte-for-byte theirs: profile hashes f1123705…/c9e91061…, then ba37348b…/8edbd645… with `missing`.)
 */
function codexCacheFixture() {
  const fingerJP = { thumb: '親指', index: '人指', middle: '中指', ring: '薬指', little: '小指' } as const;
  const data = toyModel({ names: 'japanese', twist: true, groove: true, ik: true }), first = buildModelProfile(profileInput(data));
  for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
    const wrist = first.bones.map[`wrist${side}`]!.index, at = data.bones[wrist].position;
    for (const [f, finger] of FINGERS.entries()) {
      let parent = wrist;
      for (const [j, joint] of FINGER_JOINTS[finger].entries()) {
        data.bones.push({ name: `${side === 'Left' ? '左' : '右'}${fingerJP[finger]}${'０１２３'[joint]}`, parent,
          position: [at[0] + sign * (j + 1) * 0.18, at[1] - (f - 2) * 0.08, at[2] + f * 0.06] } as ModelData['bones'][number]);
        parent = data.bones.length - 1;
      }
    }
  }
  const base = buildModelProfile(profileInput(data));
  // A bones-only skinned mesh, as Codex's: the rig reads names, parents and rest positions; the morph names come along.
  const mesh = new SkinnedMesh(), bones = data.bones.map(bone => Object.assign(new Bone(), { name: bone.name }));
  data.bones.forEach((bone, i) => {
    const parent = bone.parent >= 0 ? data.bones[bone.parent].position : [0, 0, 0];
    bones[i].position.set(bone.position[0] - parent[0], bone.position[1] - parent[1], bone.position[2] - parent[2]);
    (bone.parent >= 0 ? bones[bone.parent] : mesh).add(bones[i]);
  });
  mesh.skeleton = new Skeleton(bones); mesh.morphTargetDictionary = Object.fromEntries(data.morphs.map((morph, i) => [morph.name, i])); mesh.updateMatrixWorld(true);
  const gene = GENE_SOURCE_RIG.collision!, h = base.proportions.height, H = GENE_SOURCE_RIG.height;
  const proxy: CollisionProxy = { ...structuredClone(gene), capsules: gene.capsules.filter(capsule => base.bones.map[capsule.bone]).map(capsule => ({ ...capsule,
    a: capsule.a.map(v => v * h / H) as Vec3, b: capsule.b.map(v => v * h / H) as Vec3, radius: capsule.radius * h / H })) };
  const a = structuredClone(base), b = structuredClone(base);
  a.collision = proxy; b.collision = structuredClone(proxy);
  for (const capsule of b.collision.capsules) if (['pelvis', 'abdomen', 'chest', 'neck'].includes(capsule.segment)) capsule.radius = Math.max(capsule.radius * 4, b.proportions.shoulderWidth!);
  // Codex's schema correction: the segments without a capsule are listed, so the strict reader accepts both.
  for (const profile of [a, b]) profile.collision!.missing = PROXY_SEGMENTS.filter(segment => !profile.collision!.capsules.some(capsule => capsule.segment === segment));
  return { mesh, a, b };
}

test('X-322: one skeleton, two collision profiles: each gets its own conversion and fit, never the other\'s cached one', () => {
  const { mesh, a, b } = codexCacheFixture();
  for (const profile of [a, b]) assert.ok(acceptCollisionProxy(profile.collision, slot => !!profile.bones.map[slot]), 'a schema-valid proxy (Codex\'s corrected control)');
  const point = catalogMotions.find(motion => motion.id === 'point')!, { vmd, buffer } = parsed('point');
  const stageA = new StageMotionRetarget(mesh, a, { reviewed: false }), stageB = new StageMotionRetarget(mesh, b, { reviewed: false });
  assert.equal(stageA.plan!.target.key, stageB.plan!.target.key, 'the same model content: one rigKey');
  assert.ok(!stageA.plan!.identity && usesFittedBody(stageA.plan!.target) && usesFittedBody(stageB.plan!.target));
  // What B is on its own (no stage cache): the widened torso holds the pointing arm back.
  const direct = adaptMotion(vmd, stageB.plan!);
  assert.equal(direct.fit.status, 'hidden');
  assert.equal(direct.fit.issues[0]?.check, 'penetration');

  clearRetargetCache();
  const outA = stageA.transform!(vmd, buffer);
  assert.equal(stageA.fitOf(point.sha256)?.status, 'ok');
  const outB = stageB.transform!(parsed('point').vmd, buffer);
  assert.deepEqual(retargetCacheStats, { hits: 0, misses: 2 }, 'B is converted for B, not served A\'s entry');
  assert.notEqual(outB, outA);
  assert.equal(stageB.fitOf(point.sha256)?.status, 'hidden', 'B keeps its own verdict after A');
  assert.deepEqual(stageB.fitOf(point.sha256)?.adjustments, direct.fit.adjustments);
  assert.deepEqual(outB, direct.vmd, 'the very conversion B gets on its own');
  // The same content still shares: another stage with an equal copy of B's profile is a hit on B's entry.
  const again = new StageMotionRetarget(mesh, structuredClone(b), { reviewed: false });
  assert.equal(again.transform!(parsed('point').vmd, buffer), outB);
  assert.deepEqual(retargetCacheStats, { hits: 1, misses: 2 });
  assert.equal(again.fitOf(point.sha256)?.status, 'hidden');
  mesh.skeleton.dispose();
});

test('X-322: the cache identity covers every rig input the conversion and its fit read (each field of either rig changes it)', () => {
  const { mesh, a } = codexCacheFixture();
  const plan = new StageMotionRetarget(mesh, a, { reviewed: false }).plan!;
  const key = retargetInputKey(plan);
  assert.equal(retargetInputKey({ source: structuredClone(plan.source), target: structuredClone(plan.target) }), key, 'content, not object identity');
  const fields = new Set([...Object.keys(plan.target), ...Object.keys(plan.source)]);
  // Every field a rig has today; a field added later is covered the same way (the whole rig is digested).
  for (const field of ['key', 'bones', 'slots', 'height', 'legLength', 'armLength', 'shoulderWidth', 'headSize', 'morphSlots', 'morphNames', 'collision', 'fingers'])
    assert.ok(fields.has(field), field);
  const changed = (side: 'source' | 'target', edit: (rig: RetargetRig) => void) => {
    const copy = { source: structuredClone(plan.source), target: structuredClone(plan.target) };
    edit(copy[side]);
    return retargetInputKey(copy) !== key;
  };
  for (const side of ['source', 'target'] as const) {
    assert.ok(changed(side, rig => { rig.key += '!'; }), `${side}.key`);
    assert.ok(changed(side, rig => { rig.bones[1].position[1] += 1e-9; }), `${side}: a rest position`);
    assert.ok(changed(side, rig => { rig.bones[3].parent = rig.bones[3].parent === 0 ? 1 : 0; }), `${side}: a parent`);
    assert.ok(changed(side, rig => { delete rig.slots.neck; }), `${side}: the standard-bone mapping`);
    assert.ok(changed(side, rig => { rig.headSize *= 1.01; }), `${side}: a proportion`);
    assert.ok(changed(side, rig => { rig.legLength = rig.legLength === null ? 1 : null; }), `${side}: leg length`);
    assert.ok(changed(side, rig => { rig.morphSlots.a!.amplitude += 0.01; }), `${side}: a morph slot`);
    assert.ok(changed(side, rig => { rig.morphNames.push('extra'); }), `${side}: morph names`);
    assert.ok(changed(side, rig => { rig.collision!.capsules[0].radius *= 1.5; }), `${side}: a capsule radius`);
    assert.ok(changed(side, rig => { rig.collision = null; }), `${side}: no proxy`);
  }
  assert.ok(changed('target', rig => { delete rig.fingers!.index1Right; }), 'a finger joint');
  mesh.skeleton.dispose();
});

test('scan: every catalog motion is checked once on this model, with a plain "N of M usable" summary', async () => {
  clearRetargetCache();
  const views: MotionFitView[] = [];
  const stage = stageFor(toy({ pose: 'T' }), { onChange: view => views.push(view) });
  const resolved: string[] = [];
  const summary = await stage.scan({
    resolve: async (packId, motionId) => { resolved.push(`${packId}/${motionId}`); return motionId; },
    read: async id => { const bytes = bundledMotionBytes(id); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; },
    parse: buffer => stage.transform!(stripDefaultVmdTracks(readVmdLite(new Uint8Array(buffer))).vmd, buffer),
    current: () => true, pause: async () => {},
  });
  assert.equal(resolved.length, 76);
  assert.equal(summary.scan, 'done'); assert.equal(summary.checked, 76);
  assert.equal(summary.usable + summary.hidden, 76);
  assert.ok(summary.usable >= 50, JSON.stringify(summary));
  assert.equal(views.at(-1)!.summary.checked, 76);
  assert.equal(Object.keys(views.at(-1)!.motions).length, 76);
  // A second scan re-checks nothing.
  resolved.length = 0;
  await stage.scan({ resolve: async (_, motionId) => { resolved.push(motionId); return motionId; }, read: async () => new ArrayBuffer(0), parse: () => null, current: () => true, pause: async () => {} });
  assert.equal(resolved.length, 0);
});

test('scan stops as soon as the model is no longer current', async () => {
  const stage = stageFor(toy({ pose: 'A', scale: 0.95 }));
  let calls = 0;
  const summary = await stage.scan({ resolve: async (_, id) => { calls++; return id; }, read: async () => new ArrayBuffer(0), parse: () => null,
    current: () => calls < 3, pause: async () => {} });
  assert.equal(summary.scan, 'stopped');
  assert.equal(calls, 3);
});

test('the Gene source rig is the shipped one', () => {
  assert.equal(GENE_SOURCE_RIG.key.startsWith('gene:0ef63a75'), true);
  assert.equal(GENE_SOURCE_RIG.bones[GENE_SOURCE_RIG.slots.armLeft!].name, '左腕');
});
