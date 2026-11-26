/**
 * T-213 (Codex, 2026-11-05, 研究成果/Codex/T-213; docs/claude/2026-11-05-t213-adaptation-fixes.md): three ways a model passed
 * the name check while one of her actions did not bind or did not adapt, and the fit check still said "ok":
 *  1. English finger names (RightIndex1): the target had 20 recognisable finger bones per hand, but all 15 finger tracks of
 *     指一指 were dropped (the retarget only bound non-standard tracks by exact name).
 *  2. A second bone named 右手首: the capability card said 能做手势, while the clip players (which drop shared names) refused
 *     the wrist, so 指一指 said the right wrist was missing.
 *  3. The head hung under the center instead of the neck: the plan still took the identity fast path (fit ok, 0 samples), and
 *     a 20° neck turn left the head 0.518 units from where the source's hierarchy puts it.
 * Gene-derived metadata only: the bundled Gene's parsed bones renamed, duplicated or re-hung in memory (no PMX bytes written,
 * no other model, nothing of the user's). Everything runs through the real modules: the profile, the capability card, the
 * stage's playHerAction with its loader, retarget hook and fit check (tests/helpers/her-action-harness.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import geneSource from '../shared/foundation/retarget-gene-source.json';
import { acceptCachedProfile, buildModelProfile, fingerPartOfName, profileFingerCount, type ModelProfile } from '../shared/stage/model-profile';
import { buildRetargetRig, evaluatePose, planRetarget, qaxisAngle, rigFromCompact, tracksOnRig, vlength, vsub, type CompactRig, type RetargetRig, type VmdLike } from '../shared/actions/motion-retarget';
import { adaptMotion, checkTracks } from '../shared/actions/motion-fit';
import { catalogMotions, loadBundledMotion, readGene } from './helpers/bundled-motions';
import { profileInput, type ModelData } from './helpers/model-fixtures';
import type { PmxLiteBone } from './helpers/pmx-lite';

const GENE = readGene();
/** Gene's bones (copied, then edited); no morphs unless asked (the stage tests are about the skeleton, and a mesh of 184 morphs is heavy). */
function geneVariant(edit?: (bones: PmxLiteBone[]) => void, withMorphs = false): ModelData {
  const bones = GENE.bones.map(bone => ({ ...bone, position: [...bone.position] as [number, number, number], ...(bone.grant ? { grant: { ...bone.grant } } : {}) }));
  edit?.(bones);
  return { positions: GENE.positions, skinBone: GENE.skinBone, bones, morphs: withMorphs ? GENE.morphs : [] };
}
const GENE_PROFILE = buildModelProfile(profileInput(geneVariant()));
const index = (bones: PmxLiteBone[], name: string) => { const at = bones.findIndex(bone => bone.name === name); assert.ok(at >= 0, name); return at; };

/** Codex's variants (variants.mts): common English names for the standard bones, then for the fingers too. */
const SIDE_WORDS: Record<string, string> = { eye: 'Eye', shoulder: 'Shoulder', arm: 'UpperArm', armTwist: 'ArmTwist', elbow: 'ForeArm', wristTwist: 'WristTwist',
  wrist: 'Hand', leg: 'UpperLeg', knee: 'LowerLeg', ankle: 'Foot', toe: 'Toe', legIk: 'LegIK', toeIk: 'ToeIK' };
const ENGLISH: Record<string, string> = { root: 'Root', center: 'Center', groove: 'Groove', waist: 'Waist', lowerBody: 'Hips', upperBody: 'Spine', upperBody2: 'Chest',
  neck: 'Neck', head: 'Head', eyes: 'BothEyes',
  ...Object.fromEntries(Object.entries(SIDE_WORDS).flatMap(([part, word]) => [[`${part}Left`, `Left${word}`], [`${part}Right`, `Right${word}`]])) };
const englishStandard = (bones: PmxLiteBone[]) => { for (const [slot, entry] of Object.entries(GENE_PROFILE.bones.map)) if (ENGLISH[slot]) bones[entry!.index].name = ENGLISH[slot]; };
const FINGER_WORDS: Record<string, string> = { 親指: 'Thumb', 人指: 'Index', 中指: 'Middle', 薬指: 'Ring', 小指: 'Little' };
const englishFingers = (bones: PmxLiteBone[]) => bones.forEach(bone => {
  const match = /^(左|右)(親指|人指|中指|薬指|小指)(.*)$/.exec(bone.name.normalize('NFKC'));
  if (match) bone.name = `${match[1] === '左' ? 'Left' : 'Right'}${FINGER_WORDS[match[2]]}${match[3]}`;
});
/** 右人指１ → 右人指1: the same names a motion uses, but half-width digits (exact-name binding misses them). */
const halfWidthFingers = (bones: PmxLiteBone[]) => bones.forEach(bone => { if (/^(左|右)(親指|人指|中指|薬指|小指)/.test(bone.name)) bone.name = bone.name.normalize('NFKC'); });
const duplicateRightWrist = (bones: PmxLiteBone[]) => { const wrist = bones[index(bones, '右手首')]; bones.push({ ...wrist, position: [...wrist.position] }); };
const headUnderCenter = (bones: PmxLiteBone[]) => { bones[index(bones, '頭')].parent = index(bones, 'センター'); };

const boneOf = (track: string) => /^\.bones\[(.+)\]\.quaternion$/.exec(track)?.[1] ?? '';
const fingerTracks = (tracks: readonly string[], side: 'left' | 'right') => tracks.filter(track => fingerPartOfName(boneOf(track))?.side === side);

test('T-213 the finger reader: MMD, Chinese and English names; tips, words and other numberings are never turned into a joint', () => {
  const read = (name: string) => { const part = fingerPartOfName(name); return part && `${part.side}:${part.finger}:${part.joint}${part.tip ? ':tip' : ''}`; };
  for (const [name, expected] of [
    ['右人指１', 'right:index:1'], ['左親指０', 'left:thumb:0'], ['右人指先', 'right:index:null:tip'], ['左小指3', 'left:little:3'], ['左手食指1', 'left:index:1'],
    ['RightIndex1', 'right:index:1'], ['Index1_R', 'right:index:1'], ['LeftHandThumb1', 'left:thumb:1'], ['J_Bip_L_Index1', 'left:index:1'],
    ['mixamorig:LeftHandIndex4', 'left:index:4'], ['Thumb0_L', 'left:thumb:0'], ['RightIndex先', 'right:index:null:tip'], ['thumb_l', 'left:thumb:null'],
    ['LeftThumbProximal', 'left:thumb:null'], ['LeftLittle_end', 'left:little:null:tip'],
    ['右手首', null], ['Wrist_L', null], ['LeftEarring', null], ['RightHand', null], ['Index_LR', null],
  ] as const) assert.equal(read(name), expected, name);
  // The profile: a Mixamo-like index 1–4 (4 a bare tip) maps 1–3; a metacarpal 人指０ above the chain is fine; words, shared
  // names and a finger not under its wrist are left out with the reason.
  const profile = (edit: (bones: PmxLiteBone[]) => void) => buildModelProfile(profileInput(geneVariant(edit)));
  const tip = profile(bones => { bones[index(bones, '右人指先')].name = '右人指4'; });
  assert.deepEqual([tip.bones.fingers.index3Right?.name, tip.bones.fingerIssues], ['右人指３', []]);
  const metacarpal = profile(bones => { const first = index(bones, '右人指１'); bones.push({ name: '右人指０', parent: bones[first].parent, position: [...bones[first].position], ik: false });
    bones[first].parent = bones.length - 1; });
  assert.deepEqual([profileFingerCount(metacarpal).right, metacarpal.bones.fingerIssues], [15, []]);
  const words = profile(bones => { bones[index(bones, '右中指１')].name = 'RightMiddleProximal'; });
  assert.deepEqual(words.bones.fingerIssues, [{ finger: 'middleRight', reason: 'numbering' }]);
  const sharedName = profile(bones => { const ring = bones[index(bones, '右薬指２')]; bones.push({ ...ring, position: [...ring.position] }); });
  assert.deepEqual(sharedName.bones.fingerIssues, [{ finger: 'ringRight', reason: 'duplicate' }]);
  const loose = profile(bones => { bones[index(bones, '右小指１')].parent = index(bones, '右ひじ'); });
  assert.deepEqual(loose.bones.fingerIssues, [{ finger: 'littleRight', reason: 'chain' }]);
  assert.equal(profileFingerCount(loose).right, 12);
});

test('T-213 profile version 4: a cached profile keeps its finger joints, duplicates and parents, and an older one is computed again', () => {
  const data = geneVariant(duplicateRightWrist), profile = buildModelProfile(profileInput(data));
  const identity = { vertices: data.positions.length / 3, bones: data.bones.map(bone => bone.name), morphs: [] as string[] };
  const cached = acceptCachedProfile(JSON.parse(JSON.stringify(profile)), identity)!;
  assert.deepEqual([cached.bones.duplicates, Object.keys(cached.bones.fingers).length, cached.bones.parents.head], [['wristRight'], 30, 'neck']);
  assert.equal(acceptCachedProfile({ ...JSON.parse(JSON.stringify(profile)), version: 3 }, identity), null, 'an older profile has no finger joints: recomputed');
  const wrongFinger = JSON.parse(JSON.stringify(profile)); wrongFinger.bones.fingers.index1Right.name = 'RightIndex1';
  assert.equal(acceptCachedProfile(wrongFinger, identity), null, 'every finger joint must be this model\'s own bone');
  const wrongParent = JSON.parse(JSON.stringify(profile)); wrongParent.bones.parents.head = 'tail';
  assert.equal(acceptCachedProfile(wrongParent, identity), null);
});

test('T-213 #3 the head under the center: never the identity; the fit check samples it and holds back what pulls the head off (Codex witness 0.518)', () => {
  // Codex's minimal witness (topology-failure.json): the production Gene compact rig, only the head's parent changed.
  const source = rigFromCompact(geneSource as CompactRig), target = rigFromCompact(geneSource as CompactRig);
  const head = target.slots.head!, neck = target.slots.neck!, center = target.slots.center!;
  target.key = 'T213:head-reparented'; target.bones[head].parent = center;
  const q = qaxisAngle([0, 0, 1], 20 * Math.PI / 180);
  const vmd: VmdLike = { metadata: { motionCount: 4, morphCount: 0 }, morphs: [], motions: [0, 30].flatMap(frameNum => [
    { boneName: source.bones[neck].name, frameNum, position: [0, 0, 0], rotation: q },
    { boneName: source.bones[head].name, frameNum, position: [0, 0, 0], rotation: [0, 0, 0, 1] }]) };
  const at15 = (rig: RetargetRig) => evaluatePose(rig, tracksOnRig(vmd, rig), 15).wp[rig.slots.head!];
  const distance = vlength(vsub(at15(source), at15(target)));
  assert.ok(Math.abs(distance - 0.5183450197811168) < 1e-6, `the witness: ${distance}`);
  assert.equal(checkTracks(target, tracksOnRig(vmd, target), 30).issues.length, 0, 'the old checks alone do not see it (Codex: 5 samples, 0 issues)');

  const plan = planRetarget(source, target);
  assert.equal(plan.identity, false, 'a re-hung head is not the source skeleton');
  assert.deepEqual(plan.structure, [{ bone: 'head', expected: 'neck', actual: 'center' }]);
  const adapted = adaptMotion(vmd, plan);
  assert.equal(adapted.fit.basis, 'sampled');
  assert.ok(adapted.fit.samples > 0, 'sampled on this model');
  assert.equal(adapted.fit.status, 'hidden');
  assert.equal(adapted.fit.issues[0]?.check, 'structure');
  assert.ok(Math.abs(adapted.fit.issues[0].worst - distance / source.headSize) < 1e-3, `the head's pivot drift in head sizes (Codex 0.180854): ${adapted.fit.issues[0].worst}`);
  // What does not move the neck or the torso is not held back: the right arm's wave on the same skeleton.
  const wave = adaptMotion(loadBundledMotion('hello-wave'), plan);
  assert.equal(wave.fit.issues.some(issue => issue.check === 'structure'), false, JSON.stringify(wave.fit.issues));
});

/** A rig from a Gene variant, the way the stage builds it (shared/actions/motion-retarget.ts buildRetargetRig over the profile). */
function rigOf(data: ModelData, key: string): RetargetRig {
  const profile: ModelProfile = buildModelProfile(profileInput(data));
  return buildRetargetRig({ key, profile, bones: data.bones.map(bone => ({ name: bone.name, parent: bone.parent, position: bone.position })),
    morphNames: data.morphs.map(morph => morph.name) });
}
/** Gene without one bone: its children hang from its parent (as a model that never had it). */
const without = (name: string) => (bones: PmxLiteBone[]) => {
  const at = index(bones, name), parent = bones[at].parent;
  for (const bone of bones) if (bone.parent === at) bone.parent = parent; else if (bone.parent > at) bone.parent--;
  bones.splice(at, 1);
};

test('T-213 #3 no false alarms: Gene, a missing 上半身2 or 首 (folded), English names and half-width fingers keep their structure', () => {
  const source = rigFromCompact(geneSource as CompactRig);
  for (const [label, edit] of [['Gene', undefined], ['no 上半身2', without('上半身2')], ['no 首', without('首')], ['English names', englishStandard],
    ['half-width fingers', halfWidthFingers]] as const) {
    const plan = planRetarget(source, rigOf(geneVariant(edit, true), `t213:${label}`));
    assert.deepEqual(plan.structure, [], label);
  }
  // Gene itself: every catalog motion still takes the identity fast path, on the 'source' basis, nothing lost.
  const gene = planRetarget(source, rigOf(geneVariant(undefined, true), 't213:gene'));
  assert.equal(gene.identity, true);
  for (const motion of catalogMotions) {
    const fit = adaptMotion(loadBundledMotion(motion.id), gene).fit;
    assert.deepEqual({ status: fit.status, basis: fit.basis, samples: fit.samples, lost: fit.lost }, { status: 'ok', basis: 'source', samples: 0, lost: [] }, motion.id);
  }
});
