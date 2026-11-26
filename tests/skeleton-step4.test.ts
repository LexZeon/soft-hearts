/**
 * Universal skeleton, step 4 (docs/claude/2026-11-06-universal-skeleton-plan.md, docs/claude/2026-11-06-skeleton-step4.md):
 * contact points. 鼓掌 (two palms, the three claps) and 比心 (thumb tips together, index and middle tips together) are
 * authored on Gene; on a body with other shoulders or arm lengths the same rotations leave the hands apart in the air or push
 * them through each other. The conversion now moves the arms just enough that the hands meet the way they meet on Gene.
 *
 * Gene-derived bodies only (tests/helpers/body-variants.ts: Gene's bones moved in memory; no PMX bytes written, no other
 * model, nothing of the user's). The measure: at every touch frame, the vector between the two hands' contact points against
 * Gene's at the same frame, in Gene's head sizes (the hands keep Gene's size, so Gene's own gap is the target).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import catalogData from '../shared/actions/motion-catalog.json';
import { buildModelProfile } from '../shared/stage/model-profile';
import { RETARGET_ALGORITHM_VERSION, STANDARD_SOURCE_RIG, buildRetargetRig, evaluatePose, planRetarget, tracksOnRig, vlength, vscale, vsub, vadd, type Pose, type RetargetRig, type VmdLike } from '../shared/actions/motion-retarget';
import { MOTION_FIT_VERSION, adaptMotion } from '../shared/actions/motion-fit';
import { MOTION_SCORE_STAMP, acceptMotionFitRecord } from '../shared/actions/motion-fit-record';
import { MOTION_CONTACTS, contactFor, contactWeight } from '../shared/actions/motion-contact';
import { HER_ACTION_PACK, type HerActionId } from '../shared/actions/her-actions';
import { sha256Hex } from '../shared/foundation/sha256-sync';
import type { Vec3 } from '../shared/foundation/universal-skeleton';
import { StageMotionRetarget, clearRetargetCache } from '../src/actions/motion-retarget';
import { readGene } from './helpers/bundled-motions';
import { BODY_VARIANTS, scaleArms, widenShoulders } from './helpers/body-variants';
import type { EditableBone } from './helpers/hand-variants';
import { profileInput, toThreeMesh, type ModelData } from './helpers/model-fixtures';
import { readVmdLite } from './helpers/vmd-lite';
import { catalogMotionFile, type ShownFrame } from './helpers/frame-stats';

const GENE = readGene();
const GENE_PROPORTIONS = buildModelProfile(profileInput({ ...GENE, morphs: [] })).proportions;
const HEAD = GENE_PROPORTIONS.headSize, GENE_SHOULDERS = GENE_PROPORTIONS.shoulderWidth!;
function geneVariant(edit?: (bones: EditableBone[]) => void): ModelData {
  const bones = GENE.bones.map(bone => ({ ...bone, position: [...bone.position] as Vec3, ...(bone.grant ? { grant: { ...bone.grant } } : {}) }));
  edit?.(bones);
  return { positions: GENE.positions, skinBone: GENE.skinBone, bones, morphs: [] };
}
const actionBytes = (id: HerActionId) => new Uint8Array(readFileSync(catalogMotionFile(HER_ACTION_PACK, id)));
const actionVmd = (id: HerActionId): VmdLike => readVmdLite(actionBytes(id));

/** The touches as the test reads them off Gene (the palm-centre distance's minima and the heart's hold), kept apart from the annotation. */
const TOUCHES: Record<'clap' | 'two-hand-heart', { points: readonly (readonly string[])[]; frames: readonly number[] }> = {
  clap: { points: [['手首', '人指１', '中指１', '薬指１', '小指１']], frames: [55, 56, 57, 58, 82, 83, 84, 85, 109, 110, 111, 112] },
  'two-hand-heart': { points: [['親指先'], ['人指先'], ['中指先']], frames: Array.from({ length: 28 }, (_, k) => 75 + k) },
};
const mean = (points: readonly Vec3[]): Vec3 => vscale(points.reduce((a, b) => vadd(a, b), [0, 0, 0] as Vec3), 1 / points.length);
/** Left contact point minus right contact point, averaged over the motion's pairs (by Gene's bone names). */
function gap(rig: RetargetRig, pose: Pose, points: readonly (readonly string[])[]): Vec3 {
  const at = (name: string) => { const index = rig.bones.findIndex(bone => bone.name === name); assert.ok(index >= 0, name); return pose.wp[index]; };
  return mean(points.map(group => vsub(mean(group.map(name => at(`左${name}`))), mean(group.map(name => at(`右${name}`))))));
}
interface TouchError { error: number; signed: number; worst: number }
/**
 * The converted motion against Gene at every touch frame: the largest gap-vector difference (head sizes), and the distance
 * difference with its sign (> 0: farther apart than on Gene, the hands miss; < 0: closer, they push into each other).
 */
function touchError(id: 'clap' | 'two-hand-heart', target: RetargetRig, converted: VmdLike): TouchError {
  const touch = TOUCHES[id], source = tracksOnRig(actionVmd(id), STANDARD_SOURCE_RIG), tracks = tracksOnRig(converted, target);
  const out: TouchError = { error: 0, signed: 0, worst: -1 };
  for (const frame of touch.frames) {
    const gs = gap(STANDARD_SOURCE_RIG, evaluatePose(STANDARD_SOURCE_RIG, source, frame), touch.points);
    const gt = gap(target, evaluatePose(target, tracks, frame), touch.points);
    const error = vlength(vsub(gt, gs)) / HEAD;
    if (error > out.error) { out.error = error; out.signed = (vlength(gt) - vlength(gs)) / HEAD; out.worst = frame; }
  }
  return out;
}
/** The motion as the stage converts it for this body (the same parser hook a real load uses). */
function converted(data: ModelData, id: HerActionId): { rig: RetargetRig; vmd: VmdLike; stage: StageMotionRetarget } {
  const stage = new StageMotionRetarget(toThreeMesh(data), buildModelProfile(profileInput(data)), { reviewed: false });
  const bytes = actionBytes(id);
  return { rig: stage.rig!, vmd: stage.transform!(actionVmd(id), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer), stage };
}

test('鼓掌 / 比心 on wider or narrower shoulders, longer or shorter arms: at every touch frame the hands meet as on Gene', t => {
  clearRetargetCache();
  const lines: string[] = [], failures: string[] = [];
  for (const [label, edit] of Object.entries(BODY_VARIANTS)) {
    const data = geneVariant(edit);
    for (const id of ['clap', 'two-hand-heart'] as const) {
      const { rig, vmd, stage } = converted(data, id);
      const after = touchError(id, rig, vmd);
      lines.push(`${label} · ${id}: ${after.error.toFixed(3)} heads off Gene at f${after.worst} (distance ${after.signed >= 0 ? '+' : ''}${after.signed.toFixed(3)}), fit ${stage.view().motions[`${HER_ACTION_PACK}/${id}`]}`);
      if (!(after.error < 0.02)) failures.push(`${label} · ${id}: the hands are ${after.error.toFixed(3)} heads off where they meet on Gene (f${after.worst}, distance ${after.signed.toFixed(3)})`);
    }
  }
  t.diagnostic(lines.join('\n'));
  assert.deepEqual(failures, []);
});

test('a body whose arms are far too short for its shoulders (arms ×0.2, shoulders ×2) cannot reach: 鼓掌 and 比心 are judged unsuitable for the missed touch', () => {
  clearRetargetCache();
  const data = geneVariant(bones => { widenShoulders(bones, 2); scaleArms(bones, 0.2); });
  for (const id of ['clap', 'two-hand-heart'] as const) {
    const { stage } = converted(data, id);
    const fit = stage.fitOf(sha256Hex(actionBytes(id)));
    assert.equal(fit?.status, 'hidden', `${id}: ${JSON.stringify(fit)}`);
    assert.ok(fit!.issues.some(issue => issue.startsWith('contact: hands miss each other')), `${id}: the contact check says why: ${JSON.stringify(fit!.issues)}`);
  }
});

test('the contact metadata: only 鼓掌 and 比心, pinned to the catalog bytes, standard part words, eases inside the motion', () => {
  const catalog = (catalogData as { packs: { id: string; motions: { id: string; sha256: string; durationFrames: number }[] }[] }).packs
    .flatMap(pack => pack.motions.map(motion => ({ pack: pack.id, ...motion })));
  assert.deepEqual(MOTION_CONTACTS.map(entry => `${entry.pack}/${entry.motion}`), [`${HER_ACTION_PACK}/clap`, `${HER_ACTION_PACK}/two-hand-heart`]);
  for (const entry of MOTION_CONTACTS) {
    const motion = catalog.find(row => row.pack === entry.pack && row.id === entry.motion)!;
    assert.equal(entry.sha256, motion.sha256, `${entry.motion}: the annotation belongs to the catalog's bytes`);
    assert.equal(contactFor(motion.sha256), entry);
    assert.ok(entry.parts.every(part => part === 'palm' || /^(thumb|index|middle|ring|little)Tip$/.test(part)), JSON.stringify(entry.parts));
    const [a, b] = entry.easeIn, [c, d] = entry.easeOut, first = entry.touches[0][0], last = entry.touches.at(-1)![1];
    assert.ok(0 < a && a < b && b <= first && last <= c && c < d && d < motion.durationFrames, `${entry.motion}: eases inside the motion, around the touches`);
    for (const frame of [0, a, d, motion.durationFrames]) assert.equal(contactWeight(entry, frame), 0, `${entry.motion}: no fit at f${frame}`);
    for (const [from, to] of entry.touches) for (let frame = from; frame <= to; frame++) assert.equal(contactWeight(entry, frame), 1);
  }
  // Every other library motion (74) carries no annotation, so its conversion is exactly the plain one.
  const others = catalog.filter(row => !MOTION_CONTACTS.some(entry => entry.sha256 === row.sha256));
  assert.equal(others.length, catalog.length - 2);
  assert.ok(others.every(row => contactFor(row.sha256) === null));
  assert.equal(contactFor('0'.repeat(64)), null, 'a VMD outside the library');
});

test('Gene renamed (English names, same rest), an identical Gene copy and the reviewed Gene: the fit moves nothing', () => {
  const english = (bones: EditableBone[]) => bones.forEach(bone => {
    const match = /^(左|右)(親指|人指|中指|薬指|小指)(.*)$/.exec(bone.name.normalize('NFKC'));
    if (match) bone.name = `${match[1] === '左' ? 'Left' : 'Right'}${{ 親指: 'Thumb', 人指: 'Index', 中指: 'Middle', 薬指: 'Ring', 小指: 'Little' }[match[2]]}${match[3]}`;
    const arm = /^(左|右)(腕|ひじ|手首|手捩)$/.exec(bone.name);
    if (arm) bone.name = `${arm[1] === '左' ? 'Left' : 'Right'}${{ 腕: 'UpperArm', ひじ: 'ForeArm', 手首: 'Hand', 手捩: 'WristTwist' }[arm[2]]}`;
  });
  const data = geneVariant(english), plan = planRetarget(STANDARD_SOURCE_RIG, buildRetargetRig({ key: 'english', profile: buildModelProfile(profileInput(data)),
    bones: data.bones, morphNames: [] }));
  assert.equal(plan.identity, false, 'renamed: converted');
  const whole = { ...geneVariant(), morphs: GENE.morphs };
  const copy = planRetarget(STANDARD_SOURCE_RIG, buildRetargetRig({ key: 'gene-copy', profile: buildModelProfile(profileInput(whole)), bones: whole.bones,
    morphNames: whole.morphs.map(morph => morph.name) }));
  assert.equal(copy.identity, true);
  for (const id of ['clap', 'two-hand-heart'] as const) {
    const vmd = actionVmd(id), contact = contactFor(sha256Hex(actionBytes(id)));
    const fitted = adaptMotion(vmd, plan, { contact }), plain = adaptMotion(vmd, plan);
    assert.equal(fitted.contact?.shift, 0, `${id}: renamed Gene needs no move`);
    assert.deepEqual(fitted.vmd.motions, plain.vmd.motions, `${id}: renamed Gene converts exactly as without the fit`);
    assert.equal(fitted.fit.status, 'ok');
    const same = adaptMotion(vmd, copy, { contact });
    assert.equal(same.vmd, vmd, `${id}: the identical copy still plays the very same object`);
    assert.equal(same.fit.basis, 'source');
    assert.equal(same.contact?.shift, 0);
  }
  const gene = geneVariant();
  assert.equal(new StageMotionRetarget(toThreeMesh(gene), buildModelProfile(profileInput(gene)), { reviewed: true }).transform, undefined, 'the reviewed Gene: no transform');
});

test('versions: the conversion (4) and the check (2) changed, and the stored scores\' stamp says so', () => {
  // 4: 鼓掌 / 比心 have their arms moved to meet. 2: the 'contact' check. Scores stored by the old ones are scored again.
  assert.equal(RETARGET_ALGORITHM_VERSION, 4);
  assert.equal(MOTION_FIT_VERSION, 2);
  assert.match(MOTION_SCORE_STAMP, /^r1\.4-f2-c\d+-[0-9a-f]{16}$/);
  assert.ok(acceptMotionFitRecord({ version: 1, stamp: MOTION_SCORE_STAMP, input: `fit:${'a'.repeat(64)}`, motions: [{ sha256: 'b'.repeat(64), pack: HER_ACTION_PACK,
    motion: 'clap', status: 'hidden', basis: 'sampled', samples: 22, issues: ['contact: hands miss each other (palm)'], adjustments: [], lost: [] }] }),
    'a stored contact issue is kept');
});

/**
 * Guard for the stored scores: the contact fit's output and verdict on fixed bodies, pinned. If it changes, the conversion or
 * the check changed: bump RETARGET_ALGORITHM_VERSION or MOTION_FIT_VERSION (scores stored by the old ones would be stale).
 */
test('the contact fit\'s output on fixed bodies is pinned to the versions', () => {
  const round = (value: number) => Math.round(value * 1e5) / 1e5 || 0;
  const bodies = { ...BODY_VARIANTS, unreachable: (bones: EditableBone[]) => { widenShoulders(bones, 2); scaleArms(bones, 0.2); } };
  const out = Object.entries(bodies).map(([label, edit]) => {
    const data = geneVariant(edit), plan = planRetarget(STANDARD_SOURCE_RIG, buildRetargetRig({ key: label, profile: buildModelProfile(profileInput(data)), bones: data.bones, morphNames: [] }));
    return [label, (['clap', 'two-hand-heart'] as const).map(id => {
      const adapted = adaptMotion(actionVmd(id), plan, { contact: contactFor(sha256Hex(actionBytes(id))) });
      const arms = adapted.vmd.motions.filter(frame => /^(左|右)(腕|ひじ|手首)$/.test(frame.boneName));
      return [id, adapted.fit.status, adapted.fit.issues, adapted.contact, arms.map(frame => [frame.boneName, frame.frameNum, ...Array.from(frame.rotation, round)])];
    })];
  });
  assert.equal(`r${RETARGET_ALGORITHM_VERSION} f${MOTION_FIT_VERSION} ${sha256Hex(JSON.stringify(out)).slice(0, 16)}`, 'r4 f2 9ab934533ebd818b');
});

// ---------------------------------------------------------------- R29: the real stage frame loop

const PALM = ['手首', '人指１', '中指１', '薬指１', '小指１'], TIPS = ['親指先', '人指先', '中指先'];
/** Rotations watched for the step measures (the arm chain the fit moves, the hands, a few fingers), then the contact points. */
const TURNING = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首', '右人指１', '右人指２', '左人指１', '右親指１', '左親指１', '右中指２', '左中指２'] as const;
const POINTS = [...new Set([...PALM, ...TIPS].flatMap(name => [`左${name}`, `右${name}`]))];
const EXTRA = [...TURNING, ...POINTS.filter(name => !(TURNING as readonly string[]).includes(name))];
const DEG = 180 / Math.PI;
const turnStep = (a: ShownFrame, b: ShownFrame) => Math.max(...TURNING.map((_, k) => a.extra[k].angleTo(b.extra[k]) * DEG));
/** R29d "unexpected step": the largest change of a frame's step over the previous step, over the watched rotations. */
function surprise(frames: readonly ShownFrame[]): number {
  let best = 0;
  for (let i = 2; i < frames.length; i++) for (let k = 0; k < TURNING.length; k++) {
    const q = frames[i].extra, p = frames[i - 1].extra, o = frames[i - 2].extra;
    const step = q[k].clone().multiply(p[k].clone().invert()), last = p[k].clone().multiply(o[k].clone().invert());
    best = Math.max(best, step.angleTo(last) * DEG);
  }
  return best;
}
const shownAt = (frame: ShownFrame, name: string): Vec3 => { const p = frame.extraAt[EXTRA.indexOf(name)]; return [p.x, p.y, p.z]; };
/** The shown gap between the hands' contact points (left minus right), from the recorded world positions. */
const shownGap = (frame: ShownFrame, id: 'clap' | 'two-hand-heart'): Vec3 =>
  mean(TOUCHES[id].points.map(group => vsub(mean(group.map(name => shownAt(frame, `左${name}`))), mean(group.map(name => shownAt(frame, `右${name}`))))));

const SHOWN_MODELS = { gene: undefined, 'wide shoulders (×1.25)': BODY_VARIANTS['wide shoulders (×1.25)'], 'short arms (×0.8)': BODY_VARIANTS['short arms (×0.8)'] } as const;
