/**
 * Universal skeleton, step 3 (docs/claude/2026-11-06-universal-skeleton-plan.md, docs/claude/2026-11-06-skeleton-step3.md):
 * finger and palm rest orientation. Before this step only the two arms were aligned; the hand and fingers rode along with the
 * forearm, so on a model whose palm or finger joints rest another way than Gene's, 比心 / 鼓掌 / 指一指 curled the fingers the
 * wrong way. Gene-derived skeletons only (tests/helpers/hand-variants.ts: Gene's parsed bones edited in memory; no PMX bytes
 * written, no other model, nothing of the user's).
 *
 * The measure: each finger segment's world direction, expressed in the palm's frame (wrist, finger bases), against Gene playing
 * the same frame; and the palm's own world orientation against Gene's.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildModelProfile } from '../shared/model-profile';
import {
  RETARGET_ALGORITHM_VERSION, STANDARD_SOURCE_RIG, buildRetargetRig, compactRig, evaluatePose, groupBoneFrames, planRetarget, qangle, qbasis, qconj, qmul,
  qrotate, retargetTracks, retargetVmd, rigFromCompact, tracksOnRig, vcross, vdot, vnormalize, vscale, vsub, type CompactRig, type Pose, type Quat, type RetargetRig,
  type VmdLike,
} from '../shared/motion-retarget';
import { adaptMotion } from '../shared/motion-fit';
import { MOTION_SCORE_STAMP } from '../shared/motion-fit-record';
import { sha256Hex } from '../shared/sha256-sync';
import { HER_ACTION_PACK, HER_ACTION_SPECS, herActionDurationMs, type HerActionId } from '../shared/her-actions';
import { STANDARD_POSE, type Vec3 } from '../shared/universal-skeleton';
import { StageMotionRetarget, clearRetargetCache } from '../src/stage/motion-retarget';
import { loadBundledMotion, readGene } from './helpers/bundled-motions';
import { catalogMotionFile, geneStage, type GeneStage, type ShownFrame } from './helpers/gene-stage-harness';
import { hideBones, reshapeFingers, rollHands, tPoseRolled, type EditableBone } from './helpers/hand-variants';
import { profileInput, toThreeMesh, type ModelData } from './helpers/model-fixtures';
import { readVmdLite } from './helpers/vmd-lite';

const DEG = 180 / Math.PI;
const GENE = readGene();
function geneVariant(edit?: (bones: EditableBone[]) => void): ModelData {
  const bones = GENE.bones.map(bone => ({ ...bone, position: [...bone.position] as Vec3, ...(bone.grant ? { grant: { ...bone.grant } } : {}) }));
  edit?.(bones);
  return { positions: GENE.positions, skinBone: GENE.skinBone, bones, morphs: [] };
}
const rigOf = (data: ModelData, key: string) => buildRetargetRig({ key, profile: buildModelProfile(profileInput(data)), bones: data.bones, morphNames: [] });
const GENE_RIG = rigOf(geneVariant(), 'gene-full');
const at = (name: string) => { const index = GENE.bones.findIndex(bone => bone.name === name); assert.ok(index >= 0, name); return index; };
const actionVmd = (id: HerActionId): VmdLike => readVmdLite(new Uint8Array(readFileSync(catalogMotionFile(HER_ACTION_PACK, id))));

const LONG = ['人指', '中指', '薬指', '小指'] as const;
const FINGER_OF: Record<string, string> = { 親指: 'thumb', 人指: 'index', 中指: 'middle', 薬指: 'ring', 小指: 'little' };
/** Each finger segment by Gene's names: [joint, its end, finger]. */
const SEGMENTS = (mark: string) => [['親指０', '親指１', '親指'], ['親指１', '親指２', '親指'], ['親指２', '親指先', '親指'],
  ...LONG.flatMap(f => [[`${f}１`, `${f}２`, f], [`${f}２`, `${f}３`, f], [`${f}３`, `${f}先`, f]])].map(([a, b, f]) => ({ a: at(mark + a), b: at(mark + b), joint: mark + a, finger: FINGER_OF[f] }));

/** The palm's posed frame from its landmarks (wrist, middle base, index and little bases), by Gene's bone order. */
function palm(pose: Pose, mark: string): Quat {
  const wrist = pose.wp[at(`${mark}手首`)], middle = pose.wp[at(`${mark}中指１`)], index = pose.wp[at(`${mark}人指１`)], little = pose.wp[at(`${mark}小指１`)];
  const x = vnormalize(vsub(middle, wrist)), across = vsub(index, little), y = vnormalize(vsub(across, vscale(x, vdot(x, across))));
  return qbasis(x, y, vcross(x, y));
}
const angle = (a: Readonly<Vec3>, b: Readonly<Vec3>) => Math.acos(Math.min(1, Math.max(-1, vdot(vnormalize(a), vnormalize(b))))) * DEG;

interface HandError { fingers: number; palm: number; worst: string }
/**
 * How far this model's fingers (relative to its palm) and palm (in the world) are from Gene's at the same frames of `vmd`,
 * for the hands the motion moves. `fingers` limits the measure to fingers the model has; `keyedOnly` to segments the motion keys.
 */
function handError(vmd: VmdLike, data: ModelData, options: { fingers?: readonly string[]; keyedOnly?: boolean; plan?: ReturnType<typeof planRetarget>;
  /** The conversion as it was before step 3: no finger joints on the target rig, so no hand frames (Gene's names still bind every finger track). */
  before?: boolean } = {}): HandError {
  const read = rigOf(data, JSON.stringify(data.bones.slice(0, 3))), rig: RetargetRig = options.before ? { ...read, fingers: {} } : read;
  const plan = options.plan ?? planRetarget(STANDARD_SOURCE_RIG, rig);
  const result = retargetTracks(vmd, plan), sourceTracks = tracksOnRig(vmd, GENE_RIG), keyed = new Set(groupBoneFrames(vmd.motions).keys());
  const out: HandError = { fingers: 0, palm: 0, worst: '' };
  for (let frame = 0; frame <= result.lastFrame; frame += 3) {
    const ps = evaluatePose(GENE_RIG, sourceTracks, frame), pt = evaluatePose(plan.target, result.tracks, frame);
    for (const mark of ['左', '右']) {
      if (!keyed.has(`${mark}手首`)) continue;
      const qs = palm(ps, mark), qt = palm(pt, mark);
      out.palm = Math.max(out.palm, qangle(qmul(qs, qconj(qt))) * DEG);
      for (const segment of SEGMENTS(mark)) {
        if (options.fingers && !options.fingers.includes(segment.finger)) continue;
        if (options.keyedOnly && !keyed.has(segment.joint)) continue;
        const ds = qrotate(qconj(qs), vsub(ps.wp[segment.b], ps.wp[segment.a])), dt = qrotate(qconj(qt), vsub(pt.wp[segment.b], pt.wp[segment.a]));
        const error = angle(ds, dt);
        if (error > out.fingers) { out.fingers = error; out.worst = `${segment.joint}@${frame}`; }
      }
    }
  }
  return out;
}
const VARIANTS = {
  'hands rolled 90° about the forearm': rollHands,
  'T pose, palms forward': tPoseRolled,
  'finger joints rest on other axes': reshapeFingers,
} as const;
const ACTIONS: readonly HerActionId[] = ['two-hand-heart', 'clap', 'point'];

test('比心 / 鼓掌 / 指一指 on a model whose hands rest another way: every finger segment bends as on Gene, relative to the palm', t => {
  const lines: string[] = [];
  for (const [label, edit] of Object.entries(VARIANTS)) {
    const data = geneVariant(edit);
    for (const id of ACTIONS) {
      const error = handError(actionVmd(id), data), before = handError(actionVmd(id), data, { before: true });
      lines.push(`${label} · ${id}: fingers ${before.fingers.toFixed(1)}° → ${error.fingers.toFixed(3)}° (worst before ${before.worst}), palm ${before.palm.toFixed(1)}° → ${error.palm.toFixed(3)}°`);
      assert.ok(before.fingers > 20, `${label} · ${id}: the measure sees the old conversion bend fingers the wrong way (${before.fingers.toFixed(1)}°)`);
      assert.ok(error.fingers < 1, `${label} · ${id}: a finger segment is ${error.fingers.toFixed(1)}° off Gene's, relative to the palm (${error.worst})`);
      assert.ok(error.palm < 1, `${label} · ${id}: the palm faces ${error.palm.toFixed(1)}° away from Gene's`);
    }
  }
  t.diagnostic(lines.join('\n'));
});

test('the plan aligns each hand and finger joint by its rest frame; the arms keep their own alignment', () => {
  const plan = planRetarget(STANDARD_SOURCE_RIG, rigOf(geneVariant(rollHands), 'rolled'));
  assert.equal(plan.identity, false);
  assert.deepEqual(plan.alignedDeg, { armLeft: 0, elbowLeft: 0, armRight: 0, elbowRight: 0 }, 'arms rest as on Gene');
  const hands = plan.handAlignedDeg ?? {};
  assert.ok(Math.abs(hands.wristLeft! - 90) < 0.5 && Math.abs(hands.wristRight! - 90) < 0.5, JSON.stringify(hands));
  assert.equal(Object.keys(hands).length, 2 + 2 * 15, 'both wrists and every finger joint (15 a hand)');
  const t = planRetarget(STANDARD_SOURCE_RIG, rigOf(geneVariant(tPoseRolled), 't'));
  assert.ok(t.alignedDeg.armLeft! > 30, 'the T pose still aligns the arms');
});

test('Gene renamed (English standard and finger names, same rest): no hand alignment, every finger key exactly as on Gene', () => {
  const english = (bones: EditableBone[]) => bones.forEach(bone => {
    const match = /^(左|右)(親指|人指|中指|薬指|小指)(.*)$/.exec(bone.name.normalize('NFKC'));
    if (match) bone.name = `${match[1] === '左' ? 'Left' : 'Right'}${{ 親指: 'Thumb', 人指: 'Index', 中指: 'Middle', 薬指: 'Ring', 小指: 'Little' }[match[2]]}${match[3]}`;
    const arm = /^(左|右)(腕|ひじ|手首|手捩)$/.exec(bone.name);
    if (arm) bone.name = `${arm[1] === '左' ? 'Left' : 'Right'}${{ 腕: 'UpperArm', ひじ: 'ForeArm', 手首: 'Hand', 手捩: 'WristTwist' }[arm[2]]}`;
  });
  const data = geneVariant(english), rig = rigOf(data, 'english'), plan = planRetarget(STANDARD_SOURCE_RIG, rig);
  assert.ok(Object.values(plan.handAlignedDeg ?? {}).every(value => value === 0), JSON.stringify(plan.handAlignedDeg));
  assert.ok(plan.align.every(value => value === null), 'nothing aligned');
  for (const id of ACTIONS) {
    const vmd = actionVmd(id), result = retargetTracks(vmd, plan), source = groupBoneFrames(vmd.motions);
    let fingers = 0;
    for (const [name, keys] of source) {
      const slot = Object.entries(rig.fingers ?? {}).find(([key]) => GENE_RIG.fingers?.[key as never] === at(name))?.[0];
      if (!slot) continue;
      fingers++;
      const got = result.tracks.get(rig.fingers![slot as never]!)!;
      assert.deepEqual(got.map(key => key.q), keys.map(key => key.q), `${id} ${name}: the same rotations`);
    }
    assert.ok(fingers >= 15, `${id}: ${fingers} finger tracks compared`);
    const error = handError(vmd, data, { plan });
    assert.ok(error.fingers < 1e-3 && error.palm < 1e-3, JSON.stringify(error)); // acos of a dot product rounds to ~1e-6°
  }
});

test('the reviewed Gene and an identical copy: no conversion, the same objects; a VMD outside the library still passes through untouched', () => {
  const vmd = actionVmd('two-hand-heart');
  const whole = { ...geneVariant(), morphs: GENE.morphs }; // the identity also needs Gene's face slots
  const copy = planRetarget(STANDARD_SOURCE_RIG, buildRetargetRig({ key: 'gene-copy', profile: buildModelProfile(profileInput(whole)), bones: whole.bones,
    morphNames: whole.morphs.map(morph => morph.name) }));
  assert.ok(Object.values(copy.handAlignedDeg ?? {}).every(value => value === 0) && Object.keys(copy.handAlignedDeg ?? {}).length === 32, JSON.stringify(copy.handAlignedDeg));
  assert.equal(copy.identity, true, 'Gene planned against the standard pose is still the identity');
  assert.equal(retargetVmd(vmd, copy).vmd, vmd);
  assert.equal(adaptMotion(vmd, copy).vmd, vmd);
  const gene = geneVariant(), mesh = toThreeMesh(gene), profile = buildModelProfile(profileInput(gene));
  assert.equal(new StageMotionRetarget(mesh, profile, { reviewed: true }).transform, undefined, 'the reviewed Gene gets no transform');
  clearRetargetCache();
  const rolled = geneVariant(rollHands), stage = new StageMotionRetarget(toThreeMesh(rolled), buildModelProfile(profileInput(rolled)), { reviewed: false });
  const own = { ...vmd, metadata: { ...vmd.metadata } }, bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.equal(stage.transform!(own, bytes), own, 'a VMD that is not in the library plays as written');
});

test('fingers a model lacks: the others still bend right; no fingers at all keeps the old forearm alignment; nothing turns to NaN', t => {
  const lines: string[] = [];
  const noLittle = geneVariant(bones => { rollHands(bones); hideBones(bones, name => /^(左|右)小指/.test(name)); });
  const noIndex2 = geneVariant(bones => { rollHands(bones); hideBones(bones, name => /^(左|右)人指２$/.test(name)); });
  for (const id of ACTIONS) {
    const a = handError(actionVmd(id), noLittle, { fingers: ['thumb', 'index', 'middle', 'ring'] });
    lines.push(`no little fingers · ${id}: fingers ${a.fingers.toFixed(3)}°`);
    assert.ok(a.fingers < 1, `no little fingers · ${id}: ${a.fingers.toFixed(2)}° (${a.worst})`);
    const b = handError(actionVmd(id), noIndex2, { fingers: ['thumb', 'middle', 'ring', 'little'] });
    lines.push(`no index joint 2 · ${id}: other fingers ${b.fingers.toFixed(3)}°`);
    assert.ok(b.fingers < 1, `no index joint 2 · ${id}: ${b.fingers.toFixed(2)}° (${b.worst})`);
  }
  // No readable finger at all: no hand frame, so the wrist and everything under it keep the forearm's alignment (as before).
  const bare = geneVariant(bones => { tPoseRolled(bones); hideBones(bones, name => /^(左|右)(親指|人指|中指|薬指|小指)/.test(name)); });
  const rig = rigOf(bare, 'bare'), plan = planRetarget(STANDARD_SOURCE_RIG, rig);
  assert.deepEqual(plan.handAlignedDeg ?? {}, {});
  for (const side of ['Left', 'Right'] as const) assert.deepEqual(plan.align[rig.slots[`wrist${side}`]!], plan.align[rig.slots[`elbow${side}`]!]);
  for (const id of ACTIONS) for (const keys of retargetTracks(actionVmd(id), plan).tracks.values())
    assert.ok(keys.every(key => key.q.every(Number.isFinite) && key.p.every(Number.isFinite)), id);
  t.diagnostic(lines.join('\n'));
});

test('the stand pose keys 親指１ but not 親指０: the thumb it keys still bends as on Gene (a joint left out stays at rest)', t => {
  const stand = loadBundledMotion('stand');
  for (const [label, edit] of Object.entries(VARIANTS)) {
    const error = handError(stand, geneVariant(edit), { keyedOnly: true }), before = handError(stand, geneVariant(edit), { keyedOnly: true, before: true });
    t.diagnostic(`stand · ${label}: fingers ${before.fingers.toFixed(1)}° → ${error.fingers.toFixed(3)}°, palm ${before.palm.toFixed(1)}° → ${error.palm.toFixed(3)}°`);
    assert.ok(error.fingers < 1 && error.palm < 1, `${label}: ${error.fingers.toFixed(2)}° (${error.worst}), palm ${error.palm.toFixed(2)}°`);
  }
});

test('the standard pose carries Gene\'s finger joints and tips (one place), and the conversion version says the conversion changed', () => {
  assert.equal(Object.keys(STANDARD_SOURCE_RIG.fingers ?? {}).length, 30);
  assert.equal((STANDARD_POSE as { fingers?: unknown[] }).fingers?.length, 40, '30 joints and 10 tips');
  assert.deepEqual(rigFromCompact(JSON.parse(JSON.stringify(compactRig(STANDARD_SOURCE_RIG))) as CompactRig), STANDARD_SOURCE_RIG, 'round trip');
  for (const name of ['右人指１', '左親指０', '右小指先']) {
    const index = STANDARD_SOURCE_RIG.bones.findIndex(bone => bone.name === name);
    assert.ok(index >= 0, name);
    assert.ok(Math.hypot(...vsub(STANDARD_SOURCE_RIG.bones[index].position, GENE.bones[at(name)].position)) < 1e-5, name);
  }
  // 3: the hands and fingers are aligned by their rest frames (stored scores made by version 2 are scored again).
  // 4 (step 4): the contact fit of 鼓掌 / 比心 joined the conversion; the hand alignment pinned below is unchanged.
  assert.equal(RETARGET_ALGORITHM_VERSION, 4);
  assert.match(MOTION_SCORE_STAMP, /^r1\.4-/);
});

/**
 * Guard for the stored scores' other half: the conversion's output on fixed models, pinned. The scores pin in
 * skeleton-step1.test.ts uses a toy body without fingers, so it did not change with this step (its hands have no frame); this
 * one covers hands and fingers. If it changes, the conversion changed: bump RETARGET_ALGORITHM_VERSION (scores stored by the
 * old conversion would be stale) and update the pin.
 */
test('the conversion\'s output on fixed models is pinned to RETARGET_ALGORITHM_VERSION', () => {
  const round = (value: number) => Math.round(value * 1e5) / 1e5 || 0;
  const rows = [['rolled', geneVariant(rollHands)], ['t-palms', geneVariant(tPoseRolled)], ['reshaped', geneVariant(reshapeFingers)]] as const;
  const out = rows.map(([label, data]) => {
    const plan = planRetarget(STANDARD_SOURCE_RIG, rigOf(data, label));
    return [label, (['two-hand-heart', 'clap', 'point'] as const).map(id => {
      const result = retargetTracks(actionVmd(id), plan);
      return [id, [...result.tracks].sort((a, b) => a[0] - b[0]).map(([index, keys]) => [index, keys.map(key => [key.frame, ...key.q.map(round), ...key.p.map(round)])])];
    }), adaptMotion(loadBundledMotion('stand'), plan).fit.status];
  });
  assert.equal(`r${RETARGET_ALGORITHM_VERSION} ${sha256Hex(JSON.stringify(out)).slice(0, 16)}`, 'r4 61398d286aafabc0'); // r4 (step 4): same hash, the version moved for the contact fit
});

// ---------------------------------------------------------------- R29: the real stage frame loop

const WATCHED = ['右手首', '左手首', '右人指１', '右人指２', '右人指３', '左人指１', '左人指２', '右親指１', '左親指１', '右中指２', '左中指２'] as const;
const DEG_STEP = (a: ShownFrame, b: ShownFrame) => Math.max(...a.extra.map((q, k) => q.angleTo(b.extra[k]) * DEG));
function lockstep(a: GeneStage, b: GeneStage, seconds: number) { for (let i = 0, n = Math.round(seconds * a.rate); i < n; i++) { a.tick(); b.tick(); } }
const apart = (a: GeneStage, b: GeneStage, from: number, to: number) => {
  let best = 0;
  for (let i = from; i < to; i++) a.shown[i].extra.forEach((q, k) => { best = Math.max(best, q.angleTo(b.shown[i].extra[k]) * DEG); });
  return best;
};
/** Largest change of a frame's step over the previous step (R29d "unexpected step"), over the watched bones. */
function surprise(frames: readonly ShownFrame[]): number {
  let best = 0;
  for (let i = 2; i < frames.length; i++) frames[i].extra.forEach((q, k) => {
    const step = q.clone().multiply(frames[i - 1].extra[k].clone().invert()), last = frames[i - 1].extra[k].clone().multiply(frames[i - 2].extra[k].clone().invert());
    best = Math.max(best, step.angleTo(last) * DEG);
  });
  return best;
}

for (const fps of [60, 30] as const) test(`R29 at ${fps} fps: on the rolled-hand model 比心 / 鼓掌 / 指一指 ease in and out, step no more than on Gene, the guard catches nothing`, async t => {
  const lines: string[] = [];
  const options = { herActions: true, fps, extraBones: WATCHED } as const;
  const runs: Record<string, { step: number; surprise: number }> = {};
  for (const model of ['gene', 'rolled'] as const) {
    const edit = model === 'rolled' ? { restEdit: rollHands } : {};
    const h = await geneStage({ ...options, ...edit }), idle = await geneStage({ ...options, ...edit });
    try {
      assert.equal(!!h.stage.motionRetarget, model === 'rolled');
      lockstep(h, idle, 1.0);
      for (const id of ACTIONS) {
        const seconds = herActionDurationMs(id) / 1000, jumps = h.shown.at(-1)!.guardJumps, start = h.shown.length;
        const report = await h.playAction(id);
        assert.equal(report?.status, 'played', `${model} ${id}: ${JSON.stringify(report)}`);
        lockstep(h, idle, seconds + 0.6);
        const end = h.shown.length, frames = h.shown.slice(start - 1, end), finish = start + Math.round(seconds * h.rate);
        let step = 0;
        for (let i = 1; i < frames.length; i++) step = Math.max(step, DEG_STEP(frames[i], frames[i - 1]));
        const opening = apart(h, idle, start, start + 2), closing = apart(h, idle, finish - 2, finish + 2), back = apart(h, idle, end - 3, end);
        const unexpected = surprise(frames), guard = h.shown.at(-1)!.guardJumps - jumps;
        runs[`${model} ${id}`] = { step, surprise: unexpected };
        lines.push(`${fps} fps ${model} ${id}: max step ${step.toFixed(2)}°/frame, unexpected ${unexpected.toFixed(2)}°, opening ${opening.toFixed(3)}°, closing ${closing.toFixed(3)}°, back ${back.toFixed(3)}°, guard ${guard}`);
        assert.equal(guard, 0, `${model} ${id}: the display guard caught ${guard} (${h.shown.at(-1)!.guardLast})`);
        assert.ok(opening < 0.5, `${model} ${id} eases in: ${opening.toFixed(3)}°`);
        assert.ok(closing < 1, `${model} ${id} eases out: ${closing.toFixed(3)}°`);
        assert.ok(back < 1, `${model} ${id}: back in its idle (${back.toFixed(3)}°)`);
        assert.ok(step < (fps === 60 ? 9 : 18), `${model} ${id}: ${step.toFixed(2)}° in one frame`);
      }
    } finally { idle.close(); h.close(); }
  }
  for (const id of ACTIONS) {
    const gene = runs[`gene ${id}`], rolled = runs[`rolled ${id}`];
    assert.ok(rolled.step <= gene.step * 1.1 + 0.2, `${id}: the rolled hand steps ${rolled.step.toFixed(2)}°, Gene ${gene.step.toFixed(2)}°`);
    assert.ok(rolled.surprise <= gene.surprise * 1.1 + 0.2, `${id}: unexpected step ${rolled.surprise.toFixed(2)}° vs Gene ${gene.surprise.toFixed(2)}°`);
  }
  t.diagnostic(lines.join('\n'));
});
