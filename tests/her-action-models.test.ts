/**
 * 她的动作 on models that are not the reviewed Gene (T-211, docs/claude/2026-11-04-codex-actions.md): the stage's own
 * playHerAction on synthetic bodies (no user data), with the stage's retarget (motion-retarget.ts) and fit check in its loader.
 *  - A model without a part an action needs skips that action and says which part (no partial or silent play).
 *  - What it can play is retargeted and plays with nothing for the display guard to catch, at 60 and 30 fps.
 * Plus the pinned table: every action's hash and length are the catalog's, and the part names and checks are what the note shows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnimationClip, SkinnedMesh } from 'three';
import catalog from '../shared/motion-catalog.json';
import {
  HER_ACTIONS, HER_ACTION_CUE_MS, HER_ACTION_DETAILS, HER_ACTION_PACK, HER_ACTION_SPECS, HER_BODY_ACTIONS, fingerSide, herActionMissing, isHerActionCue, readHerActionOutcome,
  type HerActionCue, type HerActionId, type HerActionOutcome,
} from '../shared/her-actions';
import { HerActionPlayer } from '../src/stage/her-action';
import { FaceExclusive } from '../src/stage/face-exclusive';
import { StageMotionRetarget, clearRetargetCache } from '../src/stage/motion-retarget';
import { PoseContinuity } from '../src/stage/pose-continuity';
import { bodyModel } from './helpers/body-fixtures';
import { stageOn } from './helpers/her-action-harness';
import { toyModel, type ModelData } from './helpers/model-fixtures';

test('the pinned table is the catalog: one action per motion of the pack, same hash and length; cues and answers are closed shapes', () => {
  const pack = catalog.packs.find(entry => entry.id === HER_ACTION_PACK)!;
  assert.deepEqual(pack.motions.map(motion => motion.id).sort(), [...HER_ACTIONS].sort());
  for (const motion of pack.motions) {
    const spec = HER_ACTION_SPECS[motion.id as HerActionId];
    assert.equal(spec.sha256, motion.sha256, motion.id);
    assert.equal(spec.durationFrames, motion.durationFrames, motion.id);
    // Body actions carry no face tracks (the expression channel stays its own); T-215's face shapes carry nothing else.
    if (spec.mode === 'face') { assert.equal(motion.boneFrames, 0, `${motion.id}: morph only`); assert.ok(motion.morphFrames > 0, motion.id); }
    else assert.equal(motion.morphFrames, 0, `${motion.id}: no face tracks (the expression channel stays its own)`);
  }
  // No id is shared with another pack: a motion id alone never means two clips.
  const others = catalog.packs.filter(entry => entry.id !== HER_ACTION_PACK).flatMap(entry => entry.motions.map(motion => motion.id));
  for (const id of HER_ACTIONS) assert.equal(others.includes(id), false, id);
  const now = Date.now();
  assert.equal(isHerActionCue({ id: 'a1', action: 'nod', at: now, expiresAt: now + HER_ACTION_CUE_MS }), true);
  for (const bad of [{ id: 'a1', action: 'finger-heart', at: now, expiresAt: now + 1 }, { id: 'a/1', action: 'nod', at: now, expiresAt: now + 1 },
    { id: 'a1', action: 'nod', at: now, expiresAt: now + HER_ACTION_CUE_MS + 1 }, { id: 'a1', action: 'nod', at: now, expiresAt: now + 1, url: 'x' }, null])
    assert.equal(isHerActionCue(bad), false, JSON.stringify(bad));
  assert.deepEqual(readHerActionOutcome({ cueId: 'a1', status: 'missing', missing: ['手指', 3, 'x'.repeat(30)], detail: 'y'.repeat(300) }),
    { cueId: 'a1', status: 'missing', missing: ['手指'], detail: 'y'.repeat(120) });
  assert.equal(readHerActionOutcome({ cueId: 'a1', status: 'danced', missing: [], detail: '' }), null);
});

test('the part check: a missing required bone, or one the clip does not reach, is named; fingers only count for the heart', () => {
  const all = () => true, none = () => false;
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS['hello-wave'], all), []);
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS['hello-wave'], slot => slot !== 'wristRight'), ['右手腕']);
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS.bow, slot => slot !== 'upperBody2'), ['胸（上半身2）']);
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS.nod, all, slot => slot !== 'neck'), ['脖子'], 'the model has it, the retargeted clip does not move it');
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS['two-hand-heart'], all, all, { left: 15, right: 1 }), ['右手手指'], 'the note says which hand');
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS['cover-face'], all, all, { left: 0, right: 0 }), [], 'fingers are optional elsewhere');
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS.point, all, all, { left: 0, right: 15 }), [], 'pointing needs only the right hand fingers');
  assert.deepEqual(herActionMissing(HER_ACTION_SPECS.point, all, all, { left: 15, right: 2 }), ['右手手指']);
  assert.equal(herActionMissing(HER_ACTION_SPECS.clap, none).length, 6);
  for (const [name, side] of [['右人指１', 'right'], ['左小指3', 'left'], ['左親指０', 'left'], ['Index1_R', 'right'], ['LeftHandThumb1', 'left'],
    ['thumb_l', 'left'], ['右手首', null], ['Wrist_L', null]] as const) assert.equal(fingerSide(name), side, name);
});

/** The player alone over the body's still rest pose, the display guard after it (the stage's order), at `fps`. */
function guardOver(mesh: SkinnedMesh, clip: AnimationClip, mode: 'arms' | 'delta', seconds: number, fps: number): string[] {
  const player = new HerActionPlayer(mesh), guard = new PoseContinuity(mesh as never, { height: 20 });
  assert.ok(player.play({ id: `g${fps}${Math.random()}`, clip, mode, durationS: seconds }));
  const caught: string[] = [];
  let last = 0;
  for (let i = 0, n = Math.round((seconds + 0.3) * fps); i < n; i++) {
    guard.remove(); player.restore(); guard.captureBase(true);
    player.frame(1 / fps, { yield: false });
    guard.apply(1 / fps, 1 / fps);
    const state = guard.getState();
    if (state.jumps > last) { caught.push(`${state.lastJump?.property} ${state.lastJump?.size}`); last = state.jumps; }
  }
  assert.equal(player.active, false, 'ended');
  return caught;
}

for (const [label, data, expectations] of [
  ['T-pose body, Japanese names, twist bones, no 上半身2 and no fingers', toyModel({ pose: 'T', twist: true, names: 'japanese' }),
    { missing: { lean: ['胸（上半身2）'], bow: ['胸（上半身2）'], 'apology-bow': ['胸（上半身2）'], 'two-hand-heart': ['左手手指', '右手手指'], point: ['右手手指'] } }],
  ['A-pose body, English names (every track renamed by the retarget), no 上半身2 and no fingers', toyModel({ pose: 'A', twist: true, names: 'english' }),
    { missing: { lean: ['胸（上半身2）'], bow: ['胸（上半身2）'], 'apology-bow': ['胸（上半身2）'], 'two-hand-heart': ['左手手指', '右手手指'], point: ['右手手指'] } }],
  ['body with 上半身2 and one finger per hand', bodyModel({ twist: true }), { missing: { 'two-hand-heart': ['左手手指', '右手手指'], point: ['右手手指'] } }],
] as const) {
  test(`other model (${label}): what it lacks is skipped and named; what it has plays, retargeted, with nothing for the guard to catch at 60 and 30 fps`, async () => {
    const h = await stageOn(data as ModelData, { fullSkin: label.startsWith('body') });
    try {
      assert.ok(h.retarget.plan, 'not the reviewed Gene: the retarget runs');
      const played: string[] = [];
      for (const id of HER_BODY_ACTIONS) {
        const report = await h.play(id);
        const expected = (expectations.missing as Partial<Record<HerActionId, readonly string[]>>)[id];
        if (expected) {
          assert.deepEqual({ status: report.status, missing: report.missing }, { status: 'missing', missing: [...expected] }, id);
          assert.equal(h.stage.herAction.active, false, `${id}: nothing starts`);
          continue;
        }
        if (report.status === 'unfit') { played.push(`${id}: hidden by the fit check`); continue; }
        assert.equal(report.status, 'played', `${id}: ${JSON.stringify(report)}`);
        played.push(id);
        // The clip the stage bound, replayed on its own over the still body with the guard (the stage would also run the base).
        const clip: AnimationClip = await h.stage.herActionClips.get(`1:${HER_ACTION_SPECS[id].sha256}`);
        h.stage.herAction.cancel({ immediate: true });
        const seconds = HER_ACTION_SPECS[id].durationFrames / 30;
        for (const fps of [60, 30]) assert.deepEqual(guardOver(h.mesh, clip, HER_ACTION_SPECS[id].mode as 'arms' | 'delta', seconds, fps), [], `${id} at ${fps} fps`);
      }
      assert.ok(played.filter(line => !line.includes('fit check')).length >= 10, played.join(', '));
    } finally { h.close(); }
  });
}

test('the guard check can fail: cutting a raised arm in one frame is caught, handing it back (yield) is not', async () => {
  const h = await stageOn(toyModel({ pose: 'T', twist: true }));
  try {
    assert.equal((await h.play('cheer')).status, 'played');
    const clip: AnimationClip = await h.stage.herActionClips.get(`1:${HER_ACTION_SPECS.cheer.sha256}`);
    h.stage.herAction.cancel({ immediate: true });
    for (const how of ['cut', 'yield'] as const) {
      const player = new HerActionPlayer(h.mesh), guard = new PoseContinuity(h.mesh as never, { height: 20 });
      assert.ok(player.play({ id: how, clip, mode: 'arms', durationS: 4 }));
      for (let i = 0; i < 150; i++) {
        guard.remove(); player.restore(); guard.captureBase(true);
        if (i === 90 && how === 'cut') player.cancel({ immediate: true });
        player.frame(1 / 60, { yield: how === 'yield' && i >= 90 });
        guard.apply(1 / 60, 1 / 60);
      }
      assert.equal(player.active, false, `${how}: over`);
      if (how === 'cut') assert.ok(guard.getState().jumps > 0, 'a one-frame cut of the raised arms is what the guard exists to catch');
      else assert.equal(guard.getState().jumps, 0, `the hand-back: ${JSON.stringify(guard.getState().lastJump)}`);
    }
  } finally { h.close(); }
});

test('T-215 face shapes on other models: a model without a needed morph skips it and names the morph; the wink binds through the profile slot', async () => {
  for (const names of ['japanese', 'english'] as const) {
    const h = await stageOn(toyModel({ pose: 'T', twist: true, names }));
    h.stage.faceExclusive = new FaceExclusive(h.mesh);
    try {
      // The toy faces have the five vowels, the blink pair and both winks, but no cheekPuff, mouthPucker or tongueOut.
      assert.deepEqual(await h.play('cheek-puff'), { cueId: 'm1', status: 'missing', missing: ['鼓腮的表情（cheekPuff）'], detail: '' });
      assert.deepEqual((await h.play('tongue-out')).missing, ['吐舌的表情（tongueOut）'], 'あ is there, the tongue is not');
      for (const scope of ['mouth', 'eyelids'] as const) assert.equal(h.stage.faceExclusive.active(scope), false, `${names}: nothing starts`);
      // Skeleton step 2: no mouthPucker, but "う" is there: the pout plays as an approximation (tests/skeleton-step2.test.ts).
      assert.deepEqual(await h.play('pout'), { cueId: 'm3', status: 'played', missing: [], detail: HER_ACTION_DETAILS.approximate });
      assert.equal(h.stage.faceExclusive.active('mouth'), true);
      const wink = await h.play('wink');
      assert.equal(wink.status, 'played', `${names}: ${JSON.stringify(wink)}`);
      const lease = h.stage.faceExclusive.getState().eyelids;
      const winkIndex = h.mesh.morphTargetDictionary![names === 'japanese' ? 'ウィンク' : 'Blink_L'];
      assert.deepEqual(lease.targets, [winkIndex], `${names}: the profile's left-eye slot`);
    } finally { h.close(); }
  }
  // No face morphs at all: every face shape is skipped, each naming what it needs; nothing is written.
  const bare = await stageOn(toyModel({ pose: 'T', twist: true, morphs: [] }));
  bare.stage.faceExclusive = new FaceExclusive(bare.mesh);
  try {
    assert.deepEqual((await bare.play('wink')).missing, ['单眼闭眼的表情（ウィンク）', '右眼单独闭的表情（ウィンク右）']);
    assert.deepEqual((await bare.play('pout')).missing, ['嘟嘴的表情（mouthPucker）', '口型“う”']);
    assert.deepEqual((await bare.play('tongue-out')).missing, ['张嘴口型（あ）', '吐舌的表情（tongueOut）']);
    assert.equal(bare.stage.faceExclusive.owned(), null);
  } finally { bare.close(); }
});

test('a model whose profile has no right wrist: the right-hand actions are skipped with that part named, the head ones still play', async () => {
  const h = await stageOn(toyModel({ pose: 'T', twist: true }), { hide: ['wristRight'] });
  try {
    for (const id of ['hello-wave', 'goodbye-wave', 'hide-laugh', 'clap'] as const) {
      const report = await h.play(id);
      assert.equal(report.status, 'missing', id); assert.ok(report.missing.includes('右手腕'), `${id}: ${report.missing}`);
    }
    assert.equal((await h.play('nod')).status, 'played');
  } finally { h.close(); }
});
