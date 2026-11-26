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
import catalog from '../shared/actions/motion-catalog.json';
import { HER_ACTIONS, HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, fingerSide, herActionMissing, isHerActionCue, readHerActionOutcome, type HerActionId } from '../shared/actions/her-actions';
import { HerActionPlayer } from '../src/initiative/her-action';
import { PoseContinuity } from '../src/senses/pose-continuity';

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
