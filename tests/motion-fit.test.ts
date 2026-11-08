import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelProfile } from '../shared/model-profile';
import {
  LINEAR_INTERPOLATION, buildRetargetRig, evaluatePose, planRetarget, qarc, qconj, qrotate, retargetTracks, rigFromCompact, tracksOnRig, vnormalize, vsub,
  type CompactRig, type Quat, type RetargetRig, type TrackKey, type Tracks, type VmdLike,
} from '../shared/motion-retarget';
import { FIT_SAMPLE_SECONDS, adaptMotion, checkTracks, fitFrames, fitMotion, newIssues, segmentDistance, usesFittedBody } from '../shared/motion-fit';
import geneSource from '../shared/retarget-gene-source.json';
import { profileInput, toyModel, type ModelData, type ToyOptions } from './helpers/model-fixtures';
import { catalogMotions, loadBundledMotion, readGene } from './helpers/bundled-motions';

const gene = readGene();
const rigOf = (data: ModelData, key: string) => buildRetargetRig({ key, profile: buildModelProfile(profileInput(data)), bones: data.bones, morphNames: data.morphs.map(morph => morph.name) });
const source = rigFromCompact(geneSource as CompactRig), geneRig = rigOf(gene, 'gene-mesh');
const toy = (options: ToyOptions) => rigOf(toyModel(options), JSON.stringify(options));
const motions = catalogMotions, load = loadBundledMotion;
const still = (q: Quat, p: [number, number, number] = [0, 0, 0]): TrackKey[] => [0, 60].map(frame => ({ frame, p, q, interp: LINEAR_INTERPOLATION }));
const keys = (values: [number, Quat, [number, number, number]?][]): TrackKey[] => values.map(([frame, q, p]) => ({ frame, q, p: p ?? [0, 0, 0], interp: LINEAR_INTERPOLATION }));
const IDENTITY: Quat = [0, 0, 0, 1];

/** Gene names: the left upper arm straight down, the forearm bent across the chest (through the torso). */
function forearmThroughChest(rig: RetargetRig): VmdLike {
  const at = (slot: 'armLeft' | 'elbowLeft' | 'wristLeft') => rig.bones[rig.slots[slot]!].position;
  const arm = qarc(vsub(at('elbowLeft'), at('armLeft')), [0, -1, 0]);
  const elbow = qarc(vnormalize(vsub(at('wristLeft'), at('elbowLeft'))), qrotate(qconj(arm), [-1, 0, 0]));
  const frame = (boneName: string, frameNum: number, rotation: Quat) => ({ boneName, frameNum, position: [0, 0, 0], rotation, interpolation: [...LINEAR_INTERPOLATION] });
  const list = [frame('左腕', 0, arm), frame('左腕', 60, arm), frame('左ひじ', 0, elbow), frame('左ひじ', 60, elbow)];
  return { metadata: { motionCount: list.length, morphCount: 0 }, motions: list, morphs: [] };
}

test('segment distance is the true closest distance (parallel, crossing, degenerate)', () => {
  assert.equal(segmentDistance([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]), 1);
  assert.ok(Math.abs(segmentDistance([-1, 0, 0], [1, 0, 0], [0, -1, 2], [0, 1, 2]) - 2) < 1e-12);
  assert.ok(Math.abs(segmentDistance([0, 0, 0], [0, 0, 0], [3, 4, 0], [3, 4, 0]) - 5) < 1e-12);
  assert.ok(Math.abs(segmentDistance([0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 1, 0]) - Math.SQRT2) < 1e-12);
});

test('samples every 0.25 s to the last frame', () => {
  assert.equal(FIT_SAMPLE_SECONDS, 0.25);
  assert.deepEqual(fitFrames(30), [0, 7.5, 15, 22.5, 30]);
  assert.deepEqual(fitFrames(0), [0]);
});

test('calibration: every reviewed library motion checks clean on Gene itself (the dance keeps only its authored hip lift)', () => {
  assert.equal(motions.length, 76);
  // Gene is checked against its fitted collision proxy; the rough body (models without skin data) must agree.
  assert.ok(usesFittedBody(geneRig) && usesFittedBody(source));
  const rough: RetargetRig = { ...geneRig, collision: null };
  assert.equal(usesFittedBody(rough), false);
  for (const motion of motions) {
    const vmd = load(motion.id), last = Math.max(0, ...vmd.motions.map(entry => entry.frameNum), ...vmd.morphs.map(entry => entry.frameNum));
    const { issues } = checkTracks(geneRig, tracksOnRig(vmd, geneRig), last);
    if (motion.id === 'split-dance') assert.deepEqual(issues.map(issue => issue.check).sort(), ['floating', 'stretch']);
    else assert.deepEqual(issues, [], motion.id);
    // The compact source rig (standard bones only) scores the same as the full Gene skeleton.
    assert.deepEqual(checkTracks(source, tracksOnRig(vmd, source), last).issues.map(issue => issue.check), issues.map(issue => issue.check), motion.id);
    assert.deepEqual(checkTracks(rough, tracksOnRig(vmd, rough), last).issues.map(issue => issue.check), issues.map(issue => issue.check), `${motion.id} (rough body)`);
  }
});

test('a clean retargeted motion passes; a forearm driven through the chest is caught and hidden', () => {
  const target = toy({ pose: 'T' }), plan = planRetarget(source, target);
  const clean = adaptMotion(load('stand'), plan);
  assert.equal(clean.fit.status, 'ok');
  assert.deepEqual(clean.fit.issues, []);
  const through = retargetTracks(forearmThroughChest(source), plan);
  const bad = fitMotion(target, through.tracks, through.lastFrame, []);
  assert.equal(bad.status, 'hidden');
  assert.equal(bad.issues[0].check, 'penetration');
  assert.match(bad.issues[0].where, /left arm into torso/);
  assert.equal(bad.issues[0].samples, bad.samples, 'every sample of the held pose');
  assert.ok(bad.adjustments.length > 0, 'easing the arm out was tried first');
  // Relative to the source: the same pose already penetrates on Gene, so as a library motion it is authored, not new.
  assert.equal(checkTracks(source, tracksOnRig(forearmThroughChest(source), source), 60).issues[0]?.check, 'penetration');
  assert.equal(adaptMotion(forearmThroughChest(source), plan).fit.status, 'ok');
});

test('a fixable penetration is corrected (arm eased out, smooth) and reported as adjusted', () => {
  const target = toy({ pose: 'T' }), plan = planRetarget(source, target), vmd = load('arms-behind-back-idle');
  const converted = retargetTracks(vmd, plan);
  const raw = checkTracks(target, converted.tracks, converted.lastFrame).issues;
  assert.equal(raw[0]?.check, 'penetration', 'this model is shallower behind the arms than Gene');
  const fit = fitMotion(target, converted.tracks, converted.lastFrame, []);
  assert.equal(fit.status, 'adjusted');
  assert.match(fit.adjustments.join(), /armRight eased out/);
  assert.deepEqual(checkTracks(target, converted.tracks, converted.lastFrame).issues, [], 'the corrected tracks re-check clean');
  // Smooth: neighbouring baked keys never jump more than a few degrees.
  const arm = converted.tracks.get(target.slots.armRight!)!;
  for (let k = 1; k < arm.length; k++) {
    const [a, b] = [arm[k - 1].q, arm[k].q], dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    assert.ok(2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI < 6, `key ${k}`);
  }
  assert.equal(adaptMotion(vmd, plan).fit.status, 'adjusted', 'and the whole pipeline agrees');
});

test('feet, joint-limit and stretch checks catch constructed failures on the target', () => {
  const target = toy({ ik: true }), last = 60;
  const ik = (side: 'Left' | 'Right') => target.slots[`legIk${side}`]!;
  const check = (tracks: Tracks) => checkTracks(target, tracks, last).issues.map(issue => issue.check);
  assert.deepEqual(check(new Map()), [], 'rest pose is clean');
  // Both feet lifted together (no jump in a desk pet's library): floating.
  assert.deepEqual(check(new Map([[ik('Left'), still(IDENTITY, [0, 1.2, 0])], [ik('Right'), still(IDENTITY, [0, 1.2, 0])]])), ['floating']);
  // A planted foot dragged sideways: sliding.
  const drag = keys([[0, IDENTITY], [8, IDENTITY, [2, 0, 0]], [16, IDENTITY], [24, IDENTITY, [2, 0, 0]], [32, IDENTITY], [40, IDENTITY, [2, 0, 0]], [48, IDENTITY], [60, IDENTITY]]);
  assert.deepEqual(check(new Map([[ik('Left'), drag]])), ['sliding']);
  // Hips lowered on a model without leg IK (and no re-solve): the feet go through the floor.
  const fk = toy({});
  assert.deepEqual(checkTracks(fk, new Map([[fk.slots.center!, still(IDENTITY, [0, -1, 0])]]), last).issues.map(issue => issue.check), ['sinking']);
  // An IK target the leg cannot reach: stretch (and the foot leaves the floor with it).
  assert.ok(check(new Map([[ik('Right'), still(IDENTITY, [0, -1, 6])]])).includes('stretch'));
  // A head turned 120°: joint limit.
  const turn: Quat = [0, Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];
  const head = checkTracks(target, new Map([[target.slots.head!, still(turn)]]), last).issues;
  assert.deepEqual(head.map(issue => [issue.check, issue.where]), [['joint-limit', 'head']]);
  // A forearm translated off its joint: stretch.
  assert.deepEqual(check(new Map([[target.slots.elbowLeft!, still(IDENTITY, [1.5, 0, 0])]])), ['stretch']);
});

test('issues already present on the source model are authored, not counted against the target', () => {
  const failing = [{ check: 'floating' as const, samples: 7, worst: 0.13, where: 'both feet' }];
  assert.deepEqual(newIssues(failing, failing), []);
  assert.deepEqual(newIssues([{ ...failing[0], samples: 20 }], failing).map(issue => issue.samples), [20], 'clearly worse on the target counts');
  assert.deepEqual(newIssues(failing, []), failing);
  const dance = adaptMotion(load('split-dance'), planRetarget(source, toy({ pose: 'T', names: 'english' })));
  assert.equal(dance.fit.status, 'ok');
});

test('the whole library on test skeletons: A/T pose, heights, English names, no twist bones, IK or not', () => {
  for (const options of [{ pose: 'T' }, { pose: 'A', scale: 1.3 }, { pose: 'T', names: 'english', scale: 0.8 }, { pose: 'A', twist: true, groove: true, ik: true }] as ToyOptions[]) {
    const plan = planRetarget(source, toy(options));
    const statuses = motions.map(motion => adaptMotion(load(motion.id), plan).fit.status);
    assert.equal(statuses.filter(status => status === 'hidden').length, 0, JSON.stringify(options));
    assert.ok(statuses.filter(status => status === 'ok').length >= 50, JSON.stringify(options));
  }
  // Gene itself: identity, every motion ok without even sampling.
  const identity = planRetarget(source, geneRig);
  assert.ok(motions.every(motion => adaptMotion(load(motion.id), identity).fit.samples === 0));
});

test('the check uses the pose the target will show: retargeted tracks drive its own FK', () => {
  const target = toy({ pose: 'T' }), plan = planRetarget(source, target);
  const result = retargetTracks(load('stand'), plan), pose = evaluatePose(target, result.tracks, 30);
  // Hands hang beside the hips, outside the torso proxy.
  const wrist = pose.wp[target.slots.wristLeft!], hip = pose.wp[target.slots.legLeft!];
  assert.ok(wrist[1] < pose.wp[target.slots.upperBody!][1] && wrist[0] > hip[0], String(wrist));
});
