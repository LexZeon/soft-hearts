import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, AnimationMixer, Bone, BufferGeometry, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import { BODY_START_AGE_MS, type BodyMotionCue, type BodyMotionResource } from '../shared/body-motion';
import { canonicalVmdClipDuration, vmdDurationMs, vmdDurationSeconds } from '../shared/vmd-duration';
import { BodyMotionController, type BodyStageGates } from '../src/stage/body-motion-controller';
import { BehaviorBodyPlayer } from '../src/stage/behavior-body';

// R19 idle isolation check: its first failure compared the player's reported
// durationMs (MMDLoader Float32 time x 1000 = 5366.666793823242) with the
// recipe (161/30*1000 = 5366.666666666666). Both sides now hold one value.
const PROUD_FRAMES = 161;
const float32Seconds = Math.fround(PROUD_FRAMES / 30);

test('the recipe, the parser frames and the loaded clip share one canonical proud duration', () => {
  const recipe = BEHAVIOR_RECIPES['idle.proud'].durationMs;
  assert.equal(recipe, vmdDurationMs(PROUD_FRAMES));
  assert.equal(recipe, 161 / 30 * 1_000, 'the canonical function is the expression the recipes always used');
  assert.equal(BEHAVIOR_RECIPES['chat.upbeat'].durationMs, 88 / 30 * 1_000);
  assert.notEqual(float32Seconds * 1_000, recipe, 'MMDLoader time is the Float32 value that failed the isolation check');
  const clip = new AnimationClip('proud', float32Seconds, []);
  assert.equal(canonicalVmdClipDuration(clip, PROUD_FRAMES), recipe);
  assert.equal(clip.duration, vmdDurationSeconds(recipe));
  const untouched = new AnimationClip('bad', float32Seconds, []);
  for (const frames of [-1, 1.5, NaN]) assert.ok(Number.isNaN(canonicalVmdClipDuration(untouched, frames)));
  assert.equal(untouched.duration, float32Seconds);
});

test('the actual controller and player report exactly the recipe duration for proud', async () => {
  const head = Object.assign(new Bone(), { name: '頭' }), mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.add(head); mesh.bind(new Skeleton([head]));
  const durationMs = BEHAVIOR_RECIPES['idle.proud'].durationMs;
  const cue: BodyMotionCue = { id: 'proud-1', token: 'token-1', recipeId: 'idle.proud', at: 1_000,
    expiresAt: 1_000 + durationMs + BODY_START_AGE_MS, durationMs, strength: 0.2 };
  const recipe = BEHAVIOR_RECIPES['idle.proud'];
  const resource = { cueId: cue.id, recipeId: cue.recipeId, packId: recipe.packId, motionId: recipe.motionId, sha256: recipe.sha256,
    maskId: recipe.mask, durationMs: recipe.durationMs, url: `mmd-asset://${'a'.repeat(32)}/${recipe.motionId}.vmd` } as BodyMotionResource;
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.1).toArray();
  const loaded = () => new AnimationClip('proud', float32Seconds, [new QuaternionKeyframeTrack('.bones[頭].quaternion', [0, float32Seconds], [...q, ...q])]);
  const gates: BodyStageGates = { ready: true, enabled: true, visible: true, manualPose: false, manualGesture: false, manualExpression: false,
    manualHead: false, dynamicPose: false, cameraOrWindow: false, inputBlocked: false, directContact: false, music: false, speaking: false,
    waitingForReply: false, chatGesture: false };
  const run = async (load: () => AnimationClip) => {
    // A controller owns (and disposes) its player.
    const player = new BehaviorBodyPlayer({ mixer: new AnimationMixer(mesh), baseActions: () => [], withBoneBindings: change => change() });
    const controller = new BodyMotionController(mesh, { player, targetSupported: true, now: () => 1_000,
      getPlan: async () => ({ mode: 'maintainer-qa', reason: 'qa-issued', cue }), resolve: async () => resource, load: async () => load() });
    controller.update({ mode: 'maintainer-qa', reason: 'qa-issued', cue: { ...cue } }, 'token-1', gates);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return { controller, player };
  };
  const raw = await run(loaded);
  assert.equal(raw.controller.getState().reason, 'invalid-duration', 'a clip that skipped the parser duration is refused, not tolerated');
  raw.controller.dispose();
  const canonical = await run(() => { const clip = loaded(); canonicalVmdClipDuration(clip, PROUD_FRAMES); return clip; });
  assert.equal(canonical.player.getState().active, true, canonical.controller.getState().reason);
  assert.equal(canonical.player.getState().durationMs, durationMs, 'the isolation check compares these with strict equality');
  canonical.controller.dispose();
});
