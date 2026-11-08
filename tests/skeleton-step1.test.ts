/**
 * Universal skeleton, step 1 (docs/claude/2026-11-06-universal-skeleton-plan.md, docs/claude/2026-11-06-skeleton-step1.md):
 * the card says what the stage does for face actions, and the motion scores are stored per model content.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as profileModule from '../shared/model-profile';
import { MODEL_PROFILE_VERSION, acceptCachedProfile, buildModelProfile, type ModelProfile } from '../shared/model-profile';
import { HER_ACTION_PART_NAMES, HER_ACTION_SPECS, HER_FACE_ACTIONS, herActionSupport } from '../shared/her-actions';
import { GENE_STANDARD_PARENTS, modelAdaptation } from '../shared/model-adaptation';
import { STANDARD_SOURCE_RIG, rigFromCompact, type CompactRig } from '../shared/motion-retarget';
import { adaptMotion } from '../shared/motion-fit';
import { MOTION_SCORE_STAMP, acceptMotionFitRecord, mergeMotionFitRecords, type MotionFitRecord } from '../shared/motion-fit-record';
import * as skeleton from '../shared/universal-skeleton';
import { sha256Hex } from '../shared/sha256-sync';
import { MAX_MOTION_FIT_MODELS, MOTION_FITS_FILE, MotionFitStore } from '../electron/motion-fit-store';
import { resolveFaceMorphs } from '../src/stage/face-exclusive';
import { GENE_SOURCE_RIG, StageMotionRetarget, clearRetargetCache, motionFitStorage, type MotionFitView } from '../src/stage/motion-retarget';
import { catalogMotions, motionBytes, readGene } from './helpers/bundled-motions';
import { readVmdLite } from './helpers/vmd-lite';
import { stripDefaultVmdTracks } from '../src/stage/vmd-tracks';
import { JAPANESE_MORPHS, profileInput, toThreeMesh, toyModel, type ModelData } from './helpers/model-fixtures';

/** The stage's own lookup for a face action (MmdStage.playFaceAction): the mesh's names, the profile's slots, real vertex movement. */
function stageFaceMissing(data: ModelData, id: typeof HER_FACE_ACTIONS[number]): string[] {
  const mesh = toThreeMesh(data), profile = buildModelProfile(profileInput(data));
  const base = mesh.geometry.getAttribute('position'), targets = mesh.geometry.morphAttributes.position ?? [];
  const displaces = (index: number) => {
    const target = targets[index];
    if (!target) return false;
    for (let vertex = 0; vertex < base.count; vertex++) {
      const dx = target.getX(vertex) - base.getX(vertex), dy = target.getY(vertex) - base.getY(vertex), dz = target.getZ(vertex) - base.getZ(vertex);
      if (dx * dx + dy * dy + dz * dz > 1e-14) return true;
    }
    return false;
  };
  return resolveFaceMorphs(HER_ACTION_SPECS[id].face!, { names: mesh.morphTargetDictionary, count: mesh.morphTargetInfluences?.length ?? 0,
    slot: slot => profile.morphs[slot]?.index ?? -1, displaces }).missing;
}

test('the card says a face action cannot be done when the model lacks its face shape, in the stage\'s own words', () => {
  const data = toyModel(); // あ, う, ウィンク … but no cheekPuff, mouthPucker or tongueOut
  const support = herActionSupport(buildModelProfile(profileInput(data)));
  for (const id of HER_FACE_ACTIONS) {
    const stage = stageFaceMissing(data, id);
    assert.deepEqual({ ok: support[id].ok, missing: support[id].missing }, { ok: stage.length === 0, missing: stage }, id);
  }
  assert.deepEqual(support['cheek-puff'].missing, ['鼓腮的表情（cheekPuff）']);
  // Step 2: no mouthPucker but "う": an approximation (tests/skeleton-step2.test.ts), still the stage's own answer.
  assert.deepEqual({ ok: support.pout.ok, approximate: support.pout.approximate?.length }, { ok: true, approximate: 1 });
  assert.deepEqual(support['tongue-out'].missing, ['吐舌的表情（tongueOut）']);
  assert.equal(support.wink.ok, true, 'ウィンク is a vertex-checked slot');
});

test('a face shape that is there by name but moves nothing counts as missing on the card, as on the stage', () => {
  const data = toyModel({ morphs: [...JAPANESE_MORPHS, { name: 'cheekPuff', region: 'cheeks', amount: 0 }, { name: 'tongueOut', region: 'mouth', amount: 0.2 }] });
  const support = herActionSupport(buildModelProfile(profileInput(data)));
  assert.deepEqual(stageFaceMissing(data, 'cheek-puff'), ['鼓腮的表情（cheekPuff）']);
  assert.deepEqual(support['cheek-puff'].missing, ['鼓腮的表情（cheekPuff）']);
  assert.deepEqual(stageFaceMissing(data, 'tongue-out'), []);
  assert.equal(support['tongue-out'].ok, true);
});

test('Gene: every face action is there on the card and on the stage', () => {
  const gene = readGene(), support = herActionSupport(buildModelProfile(profileInput(gene)));
  for (const id of HER_FACE_ACTIONS) {
    assert.deepEqual(stageFaceMissing(gene, id), [], id);
    assert.equal(support[id].ok, true, id);
  }
});

// ---------------------------------------------------------------- one place

test('the universal skeleton is the one place: profile, conversion, card and part words all read it', () => {
  assert.equal(profileModule.STANDARD_BONES, skeleton.STANDARD_BONES);
  assert.equal(profileModule.FINGER_SLOTS, skeleton.FINGER_SLOTS);
  assert.equal(profileModule.MORPH_ALIASES, skeleton.MORPH_ALIASES);
  assert.equal(profileModule.REFERENCE_AMPLITUDE, skeleton.REFERENCE_AMPLITUDE);
  assert.equal(profileModule.standardParents, skeleton.standardParents);
  assert.equal(GENE_STANDARD_PARENTS, skeleton.STANDARD_PARENTS, 'the card\'s skeleton shape is the standard pose\'s');
  assert.equal(GENE_SOURCE_RIG, STANDARD_SOURCE_RIG, 'the stage converts from the standard pose');
  assert.deepEqual(STANDARD_SOURCE_RIG, rigFromCompact(skeleton.STANDARD_POSE as CompactRig));
  assert.match(skeleton.STANDARD_POSE.key, /^gene:0ef63a75/, 'the standard pose is Gene\'s, the model every motion was reviewed on');
  assert.equal(HER_ACTION_PART_NAMES, skeleton.STANDARD_PART_WORDS);
  // The face ruler (Gene's amounts in head sizes) and the standard pose agree: two views of one measurement.
  for (const [slot, value] of Object.entries(skeleton.REFERENCE_AMPLITUDE))
    assert.ok(Math.abs(value! / skeleton.STANDARD_POSE.morphSlots[slot as keyof typeof skeleton.STANDARD_POSE.morphSlots]!.amplitude - 1) < 1e-3, slot);
  // The body ruler: Gene measured again equals the standard body in head sizes.
  const gene = buildModelProfile(profileInput(readGene())).proportions;
  const measured = skeleton.bodyInHeads(gene), standard = skeleton.STANDARD_BODY_IN_HEADS;
  for (const key of ['height', 'shoulderWidth', 'armLength', 'legLength'] as const) assert.ok(Math.abs(measured[key]! - standard[key]!) < 1e-4, key);
  assert.ok(Math.abs(gene.headsTall - standard.height) < 1e-4);
  // Every face action's morph is either a standard face slot or a named face shape, with the universal skeleton's own aliases.
  for (const id of HER_FACE_ACTIONS) for (const morph of HER_ACTION_SPECS[id].face!.morphs) {
    if (morph.slot) continue;
    assert.ok(skeleton.isNamedFaceShape(morph.track), `${id}: ${morph.track}`);
    assert.deepEqual(morph.aliases, skeleton.NAMED_FACE_SHAPES[morph.track as skeleton.NamedFaceShape]);
  }
});

test('profile version 5 carries the named face shapes; a cached one must name this model\'s own morphs', () => {
  const data = readGene(), profile = buildModelProfile(profileInput(data));
  assert.equal(MODEL_PROFILE_VERSION, 6, 'step 2 (6): 嘟嘴 became a slot, mouth corners a named shape (tests/skeleton-step2.test.ts)');
  assert.deepEqual(Object.keys(profile.faceShapes).sort(), [...skeleton.NAMED_FACE_SHAPE_IDS].sort());
  // Gene names each by its ARKit id, except the corners-down shape (step 2), which it has under MMD's ∧.
  for (const [shape, entry] of Object.entries(profile.faceShapes)) assert.equal(data.morphs[entry!.index].name, shape === 'mouthCornersDown' ? '∧' : shape);
  const identity = { vertices: data.positions.length / 3, bones: data.bones.map(bone => bone.name), morphs: data.morphs.map(morph => morph.name) };
  const plain = JSON.parse(JSON.stringify(profile)) as ModelProfile;
  assert.ok(acceptCachedProfile(plain, identity));
  assert.equal(acceptCachedProfile({ ...plain, version: 4 }, identity), null, 'a version 4 profile has no face shapes: recomputed once');
  const wrong = JSON.parse(JSON.stringify(profile)); wrong.faceShapes.tongueOut.index = profile.faceShapes.cheekPuff!.index;
  assert.equal(acceptCachedProfile(wrong, identity), null);
  const unknown = JSON.parse(JSON.stringify(profile)); unknown.faceShapes.mystery = { index: 0, name: data.morphs[0].name };
  assert.equal(acceptCachedProfile(unknown, identity), null);
  const { faceShapes: _gone, ...without } = plain;
  assert.equal(acceptCachedProfile(without, identity), null);
});

test('haiku\'s checked match for a face slot counts on the card, as the stage fills it in on load', () => {
  // Neither wink (step 2: with the right one there, the wink would be approximated with it).
  const data = toyModel({ morphs: JAPANESE_MORPHS.filter(morph => !['ウィンク', 'ウィンク右'].includes(morph.name)) });
  const profile = buildModelProfile(profileInput(data));
  assert.deepEqual(herActionSupport(profile).wink.missing, ['单眼闭眼的表情（ウィンク）', '右眼单独闭的表情（ウィンク右）']);
  assert.equal(herActionSupport(profile, {}, { blinkLeft: 6 }).wink.ok, true);
  assert.equal(modelAdaptation(profile, { morphs: { blinkLeft: 6 } }).actions.wink.ok, true);
});

// ---------------------------------------------------------------- stored motion scores

const parsedFor = (packId: string, motionId: string) => {
  const motion = catalogMotions.find(entry => entry.packId === packId && entry.id === motionId)!;
  const bytes = motionBytes(packId, motion.relativePath);
  return { vmd: stripDefaultVmdTracks(readVmdLite(bytes)).vmd, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
};
/** The stage's scan with the real parser hook; stops once it would fetch more than `limit` motions; counts what was parsed (= converted and scored). */
async function scanSome(stage: StageMotionRetarget, limit: number): Promise<{ parsed: string[]; view: MotionFitView }> {
  let resolved = 0, last = { packId: '', motionId: '' };
  const parsed: string[] = [];
  await stage.scan({
    resolve: async (packId, motionId) => { resolved++; return `${packId}|${motionId}`; },
    read: async url => { const [packId, motionId] = url.split('|'); last = { packId, motionId }; return parsedFor(packId, motionId).buffer; },
    parse: buffer => { parsed.push(`${last.packId}/${last.motionId}`); return stage.transform!(parsedFor(last.packId, last.motionId).vmd, buffer); },
    current: () => resolved <= limit,
    pause: async () => {},
  });
  return { parsed, view: stage.view() };
}
type StageOptions = ConstructorParameters<typeof StageMotionRetarget>[2];
const stageOn = (data: ModelData, options: Partial<StageOptions> = {}) =>
  new StageMotionRetarget(toThreeMesh(data), buildModelProfile(profileInput(data)), { reviewed: false, ...options });
const first3 = catalogMotions.slice(0, 3).map(motion => `${motion.packId}/${motion.id}`);
/** One scored record of the first three library motions on this model (a fresh session). */
async function scoredOnce(data: ModelData): Promise<{ record: MotionFitRecord; view: MotionFitView }> {
  clearRetargetCache();
  const saved: MotionFitRecord[] = [];
  const view = (await scanSome(stageOn(data, { persist: record => saved.push(record) }), 3)).view;
  assert.equal(saved.length, 1);
  clearRetargetCache();
  return { record: JSON.parse(JSON.stringify(saved[0])) as MotionFitRecord, view };
}
const tPose = () => toyModel({ pose: 'T', names: 'english' });

test('the scores are stored once and the same model\'s second load uses them without converting again', async () => {
  clearRetargetCache();
  const data = tPose(), saved: unknown[] = [];
  const first = stageOn(data, { persist: record => saved.push(record) });
  const one = await scanSome(first, 3);
  assert.deepEqual(one.parsed, first3);
  assert.equal(saved.length, 1, 'stored after the scan');
  clearRetargetCache(); // a new session: nothing in memory
  const second = stageOn(data, { stored: JSON.parse(JSON.stringify(saved[0])), persist: record => saved.push(record) });
  assert.deepEqual(second.view().motions, one.view.motions, 'known before anything loads');
  assert.deepEqual(second.summary().checked, 3);
  const two = await scanSome(second, 0);
  assert.deepEqual(two.parsed, [], 'nothing converted or scored again');
  assert.equal(saved.length, 1, 'nothing new to store');
  // Playing a stored motion still converts it (the scores are not the motion), and gives the same verdict.
  const motion = catalogMotions[0], { vmd, buffer } = parsedFor(motion.packId, motion.id);
  second.transform!(vmd, buffer);
  assert.deepEqual(second.view().motions, one.view.motions);
});

test('a new conversion or check version, another model or profile: the stored scores are not used', async () => {
  const data = tPose(), { record } = await scoredOnce(data);
  for (const [why, stored] of [['stamp', { ...record, stamp: `${record.stamp}x` }], ['input', { ...record, input: `fit:${'0'.repeat(64)}` }]] as const) {
    const stage = stageOn(data, { stored });
    assert.equal(stage.summary().checked, 0, why);
    assert.deepEqual((await scanSome(stage, 3)).parsed, first3, why);
  }
  // Another model (same skeleton, other scale) has another input: the record made for the first is not its own.
  const other = stageOn(toyModel({ pose: 'T', names: 'english', scale: 1.1 }), { stored: record });
  assert.equal(other.summary().checked, 0);
  // r1.4-f2: skeleton step 4 fits 鼓掌 / 比心 so the hands meet (RETARGET_ALGORITHM_VERSION 4) and adds the contact check (MOTION_FIT_VERSION 2),
  // so older scores are redone (r1.3: step 3 aligned the hands and fingers by their rest frames).
  assert.match(MOTION_SCORE_STAMP, /^r1\.4-f2-c\d+-[0-9a-f]{16}$/);
});

test('the library changed: a motion whose bytes or id changed is scored again, the others are kept', async () => {
  const data = tPose(), { record } = await scoredOnce(data);
  const changed = structuredClone(record); changed.motions[0].sha256 = sha256Hex('another version of this motion');
  const moved = structuredClone(record); moved.motions[1].motion = 'renamed';
  for (const [stored, again] of [[changed, first3[0]], [moved, first3[1]]] as const) {
    const stage = stageOn(data, { stored });
    assert.equal(stage.summary().checked, 2);
    assert.deepEqual((await scanSome(stage, 1)).parsed, [again]);
  }
});

test('a broken stored record counts as none: everything is scored again, nothing throws', async () => {
  const data = tPose(), { record } = await scoredOnce(data);
  const broken: unknown[] = ['{', 42, [], { ...record, version: 2 }, { ...record, motions: 'x' },
    { ...record, motions: [{ ...record.motions[0], status: 'great' }] }, { ...record, motions: [{ ...record.motions[0], samples: -1 }] }];
  for (const stored of broken) {
    const stage = stageOn(data, { stored });
    assert.equal(stage.summary().checked, 0, JSON.stringify(stored).slice(0, 60));
    assert.deepEqual((await scanSome(stage, 3)).parsed, first3);
  }
});

test('what is stored has no path and no model names: standard part ids, words and numbers', async () => {
  const data = toyModel({ pose: 'T', names: 'english' }), { record } = await scoredOnce(data);
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /[\\/]|\b[A-Za-z]:[\\/]|mmd-asset|local:/u);
  for (const bone of data.bones) assert.equal(text.includes(`"${bone.name}"`), false, bone.name);
  for (const motion of record.motions) for (const part of motion.lost) assert.ok(skeleton.isStandardPart(part), part);
  // The check that keeps it so (mutation-verified: relaxing it lets each of these through).
  const row = record.motions[0];
  for (const bad of [{ issues: ['penetration: C:\\Users\\me'] }, { issues: ['joint-limit: /home/me/model.pmx'] }, { adjustments: ['see ../private'] },
    { lost: ['右人指１'] }, { lost: ['Arm_L'] }, { pack: 'gene/../x' }, { issues: ['made-up: x'] }]) {
    assert.equal(acceptMotionFitRecord({ ...record, motions: [{ ...row, ...bad }] }), null, JSON.stringify(bad));
  }
  const extra = acceptMotionFitRecord({ ...record, motions: [{ ...row, path: 'C:\\x' }], note: 'x' });
  assert.ok(extra && !JSON.stringify(extra).includes('C:'), 'unknown fields are dropped, not kept');
});

test('a motion that plays without some parts stores them as standard part ids (the partial count survives a reload)', async () => {
  const data = toyModel({ pose: 'T', names: 'english' }); // no finger bones: finger tracks are lost
  clearRetargetCache();
  const heart = catalogMotions.find(motion => motion.id === 'two-hand-heart')!;
  const saved: MotionFitRecord[] = [];
  const stage = stageOn(data, { persist: record => saved.push(record) });
  const { vmd, buffer } = parsedFor(heart.packId, heart.id);
  stage.transform!(vmd, buffer);
  const lost = stage.fitOf(heart.sha256)!.lost;
  assert.ok(lost.includes('index1Right') && lost.includes('thumb0Left'), lost.join());
  assert.ok(lost.every(skeleton.isStandardPart));
  const record = stage.storedRecord()!;
  clearRetargetCache();
  const again = stageOn(data, { stored: JSON.parse(JSON.stringify(record)) });
  assert.deepEqual(again.fitOf(heart.sha256)!.lost, lost);
  assert.equal(again.summary().partial, stage.summary().partial);
});

test('the reviewed Gene: no conversion, nothing restored or stored (its motions stay byte for byte the old path)', async () => {
  const gene = readGene(), saved: unknown[] = [];
  const stage = new StageMotionRetarget(toThreeMesh(gene), buildModelProfile(profileInput(gene)), { reviewed: true, stored: { anything: true }, persist: record => saved.push(record) });
  assert.equal(stage.transform, undefined);
  assert.equal(stage.storedRecord(), null);
  await stage.scan({ resolve: async () => '', read: async () => new ArrayBuffer(0), parse: () => null, current: () => true });
  assert.deepEqual(saved, []);
  assert.equal(stage.summary().model, 'reviewed');
});

test('a VMD that is not in the library still passes through untouched with stored scores in place', async () => {
  const data = tPose(), { record } = await scoredOnce(data);
  const stage = stageOn(data, { stored: record });
  const motion = catalogMotions[0], { vmd } = parsedFor(motion.packId, motion.id);
  const other = new Uint8Array(motionBytes(motion.packId, motion.relativePath)); other[other.length - 1] ^= 1;
  assert.equal(stage.transform!(vmd, other.buffer), vmd);
});

test('the stage hooks: stored scores from the cache view, saves under that model\'s key', async () => {
  const calls: [string, unknown][] = [];
  const hooks = motionFitStorage({ modelKey: 'a'.repeat(64), motionFits: { x: 1 } }, { saveMotionFits: async (key, record) => { calls.push([key, record]); return true; } });
  assert.deepEqual(hooks.stored, { x: 1 });
  hooks.persist!({ version: 1, stamp: 's', input: 'fit:', motions: [] });
  assert.deepEqual(calls.map(call => call[0]), ['a'.repeat(64)]);
  assert.deepEqual(motionFitStorage(null, undefined), {});
  const failing = motionFitStorage({ modelKey: 'b'.repeat(64) }, { saveMotionFits: () => { throw new Error('host gone'); } });
  assert.doesNotThrow(() => failing.persist!({ version: 1, stamp: 's', input: 'fit:', motions: [] }));
});

/**
 * Guard for the stored scores: the check's verdict on a fixed model, pinned. If this changes, what the check flags changed, so
 * scores stored by the old check would be stale: bump MOTION_FIT_VERSION (shared/motion-fit.ts) and update the pin.
 */
test('the scores a stored record holds are pinned to MOTION_FIT_VERSION', () => {
  clearRetargetCache();
  const data = toyModel({ pose: 'A', names: 'japanese', twist: true }), stage = stageOn(data);
  const fits = ['laugh', 'stand', 'hello-wave', 'clap', 'bow', 'split-dance'].map(id => {
    const motion = catalogMotions.find(entry => entry.id === id)!, { vmd } = parsedFor(motion.packId, motion.id);
    const fit = adaptMotion(vmd, stage.plan!).fit;
    return { id, status: fit.status, samples: fit.samples, issues: fit.issues, adjustments: fit.adjustments, before: fit.before };
  });
  assert.equal(`${MOTION_SCORE_STAMP.split('-')[1]} ${sha256Hex(JSON.stringify(fits)).slice(0, 16)}`, 'f2 543f2be0d0c3eded');
  // f2 (step 4): the same verdicts; only the version moved. This pin calls adaptMotion without a contact annotation, so it
  // still guards the other checks; the contact fit and check have their own pin in skeleton-step4.test.ts.
});

// ---------------------------------------------------------------- the host's store

async function tempDir(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), 'soft-motion-fits-')); }
const KEY = 'c'.repeat(64);

test('the host store keeps each model\'s scores by content key, merges saves, and survives a restart', async () => {
  const directory = await tempDir();
  try {
    const { record } = await scoredOnce(tPose());
    const store = new MotionFitStore(directory); await store.load();
    assert.equal(store.get(KEY), null);
    assert.equal(await store.set(KEY, { ...record, motions: record.motions.slice(0, 2) }), true);
    assert.equal(await store.set(KEY, { ...record, motions: record.motions.slice(2) }), true);
    assert.equal(store.get(KEY)!.motions.length, 3, 'same conversion and input: the motions of both saves');
    const reread = new MotionFitStore(directory); await reread.load();
    assert.deepEqual(reread.get(KEY), store.get(KEY));
    // Another stamp replaces (the old scores are of another check).
    assert.equal(await store.set(KEY, { ...record, stamp: 'other-1', motions: record.motions.slice(0, 1) }), true);
    assert.equal(store.get(KEY)!.motions.length, 1);
    const text = await readFile(path.join(directory, MOTION_FITS_FILE), 'utf8');
    assert.doesNotMatch(text.replaceAll(KEY, ''), /[\\/]|[A-Za-z]:\\/u, 'no path in the file');
    await assert.rejects(store.set('not-a-key', record));
    await assert.rejects(store.set(KEY, { ...record, motions: [{ ...record.motions[0], issues: ['stretch: C:\\x'] }] }));
    // Bounded: the oldest models go first.
    for (let k = 0; k < MAX_MOTION_FIT_MODELS + 2; k++) await store.set(k.toString(16).padStart(64, '0'), record);
    assert.equal(store.get(KEY), null, 'the oldest was dropped');
    assert.ok(store.get((MAX_MOTION_FIT_MODELS + 1).toString(16).padStart(64, '0')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a broken file is no scores: loading never throws, and the next save writes a good file', async () => {
  const directory = await tempDir();
  try {
    const { record } = await scoredOnce(tPose());
    for (const content of ['{not json', JSON.stringify({ version: 9, models: [] }), JSON.stringify({ version: 1, models: [{ modelKey: KEY, record: { version: 1 } }] })]) {
      await writeFile(path.join(directory, MOTION_FITS_FILE), content);
      const store = new MotionFitStore(directory); await store.load();
      assert.equal(store.get(KEY), null, content);
      assert.equal(await store.set(KEY, record), true);
      const reread = new MotionFitStore(directory); await reread.load();
      assert.equal(reread.get(KEY)!.motions.length, record.motions.length);
    }
    // A failing disk keeps the scores for this session only.
    const failing = new MotionFitStore(directory, { write: async () => { throw new Error('disk'); } }); await failing.load();
    assert.equal(await failing.set(KEY, mergeMotionFitRecords(null, { ...record, stamp: 'other-2' })), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
