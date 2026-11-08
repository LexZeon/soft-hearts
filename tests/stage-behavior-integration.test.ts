import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, Bone, BufferGeometry, Euler, MeshBasicMaterial, NumberKeyframeTrack, PerspectiveCamera, Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Vector3 } from 'three';
import type { BehaviorMotionCue, BehaviorMotionResource } from '../shared/behavior-motion';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';
import { MmdStage } from '../src/stage/MmdStage';
import { BehaviorMotionPlayer } from '../src/stage/behavior-motion';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { captureMotionPose, MotionTransition } from '../src/stage/motion-transition';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { MusicDance } from '../src/stage/music-dance';

const BASE_BROW = 0.23;
const BROW = '.morphTargetInfluences[0]';
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
type StopMode = 'hover' | 'window' | 'plan' | 'intensity';

function globals() {
  const names = ['document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, { document: { hidden: false }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  return () => names.forEach((name, index) => {
    const descriptor = previous[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  });
}

async function fixture(legacyUnordered = false) {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material), arm = new Bone();
  arm.name = '左腕'; mesh.add(arm); mesh.bind(new Skeleton([arm]));
  mesh.morphTargetDictionary = { にこり: 0, 笑い: 1, まばたき: 2, あ: 3, 赤み: 4 };
  mesh.morphTargetInfluences = [BASE_BROW, 0.17, 0.05, 0.11, 0.07];
  const scene = new Scene(); scene.add(mesh);
  const settings = structuredClone(DEFAULT_SETTINGS); settings.pet.breath = 0; settings.pet.followMouse = false;
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  const cue: BehaviorMotionCue = { id: 'accepted-state', kind: 'state', bindingId: 'face.happy', semantic: 'mood.happy', at: 10_000, expiresAt: 21_500, strength: 0.6, stateKey: 'happy-neutral' };
  const resource: BehaviorMotionResource = { cueId: cue.id, bindingId: cue.bindingId, packId: 'gene', motionId: 'happy', sha256: 'a'.repeat(64), durationMs: 2_000, url: 'mmd-asset://approved-face', recipe: 'emotion-face' };
  const face = new BehaviorMotionPlayer(mesh, {
    targetSupported: true,
    now: () => 10_000, resolve: async () => resource,
    load: async (_resource, target) => {
      assert.equal(target, mesh);
      return new AnimationClip('temporary-face', 2, [new NumberKeyframeTrack(BROW, [0, 2], [0.83, 0.83])]);
    },
  });
  const animation = new LayeredMmdAnimation(mesh);
  animation.setClips({ pose: new AnimationClip('advancing-body', 8, [new QuaternionKeyframeTrack('.bones[左腕].quaternion', [0, 8], [0, 0, 0, 1, 0, 0, Math.sin(0.3), Math.cos(0.3)])]), gesture: null, expression: null });
  const mixer = animation.helper.objects.get(mesh)!.mixer! as any, bodyAction = mixer._actions[0];
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000); camera.position.set(0, 10, 35); camera.lookAt(0, 10, 0); camera.updateMatrixWorld(true);
  const snapshot = getMoodSnapshot(createMoodState(10_000)); snapshot.primary = 'happy';
  Object.assign(stage, {
    mesh, scene, camera, settings, options: { transparent: false }, container: { clientWidth: 400, clientHeight: 560 },
    controls: { interacting: false, setEnabled() {}, update() {} }, renderer: { render() {}, domElement: { dataset: {} } },
    animation, behaviorMotion: face, behaviorBlocked: false, motionTransition: null,
    head: undefined, chest: undefined, center: undefined, eyes: [], arms: [], height: 20,
    elapsed: 0, previousFrame: 0, hasRenderedModel: false, frameId: 0, disposed: false, hostVisible: true,
    gazeOrigin: new Vector3(), eyePoint: new Vector3(), pointer: { x: 0, y: 0 }, gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 },
    nextBlink: Infinity, blinkStart: -10, naturalBlink: 0, speaking: false, mouth: 0,
    blinkIndex: 2, mouthIndex: 3, smileIndex: 1, sadIndex: -1, blushChannel: null,
    boneLayers: [], morphLayers: [], rotation: new Euler(), offset: new Quaternion(),
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodFaceBlocked: false, moodHeadBlocked: false, moodMouthBlocked: false,
    moodView: { characterId: 'gene', token: 'scope', revision: 1, developerMode: false, expressions: true,
      parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot, gesture: null, behavior: { state: cue, reaction: null } },
    musicDance: new MusicDance(), musicEnabled: false, proceduralBlush: null, blushPreviewUntil: 0, blushPreviewing: false,
    chatGesturePlayer: null, chatGestureGeneration: 0, chatGestureBlocked: false, chatGestureResource: null,
  });
  if (legacyUnordered) {
    // Model the former event path using the same production update implementation
    // while deliberately omitting its new outer restore/reapply wrapper.
    const orderedUpdate = stage.updateBehaviorMotion;
    stage.updateBehaviorMotion = function () { orderedUpdate.call(this, true); };
  }
  let frames = 0;
  // tick is an instance arrow callback; retain its production composition order
  // while using actual stage methods and actual layer/helper implementations.
  const step = () => {
    const delta = 1 / 30; frames++; stage.elapsed += delta; stage.previousFrame = frames * 1_000 / 30;
    stage.motionTransition?.restore(); stage.behaviorMotion.restore(); stage.chatGesturePlayer?.restore(); stage.restoreLayers();
    stage.animation.helper.update(delta); stage.animateIdle(delta);
    stage.chatGesturePlayer?.frame(delta, { blocked: stage.behaviorBlocked });
    stage.animateMood(delta); stage.animateMusic(delta); stage.updateBehaviorMotion(true);
    stage.behaviorMotion.frame(delta); stage.motionTransition?.frame(delta); stage.controls.update(delta);
    stage.renderer.render(stage.scene, stage.camera); stage.hasRenderedModel = stage.mesh !== null;
  };
  stage.setMood(stage.moodView); await flush();
  for (let frame = 0; frame < 10; frame++) step();
  assert.ok(face.getState().state.weight > 0.5);
  assert.ok(mesh.morphTargetInfluences![0] > BASE_BROW + 0.3);
  // A real outer bridge owns the same eyebrow as the temporary face layer.
  // Its origin represents an earlier manual display, and its target keeps
  // moving with the inner face sampler. The body Action is never replaced.
  const target = mesh.morphTargetInfluences![0]; mesh.morphTargetInfluences![0] = 0.94;
  const from = captureMotionPose(mesh); mesh.morphTargetInfluences![0] = target;
  stage.motionTransition = new MotionTransition(mesh); stage.motionTransition.start(from, [BROW]); stage.motionTransition.frame(0);
  step(); step();
  assert.equal(stage.motionTransition.getState().active, true);
  const stop = (mode: StopMode) => {
    if (mode === 'hover') stage.setMoodContact({ ...EMPTY_CONTACT, hover: 0.6 });
    if (mode === 'window') stage.setBehaviorBlocked(true);
    if (mode === 'plan') stage.setMood({ ...stage.moodView, behavior: { state: null, reaction: null } });
    if (mode === 'intensity') stage.setMood({ ...stage.moodView, snapshot: { ...stage.moodView.snapshot, intensity: { ...stage.moodView.snapshot.intensity, expression: 0 } } });
  };
  return {
    stage, mesh, face, step, stop, mixer, bodyAction, get frames() { return frames; },
    dispose() { stage.motionTransition?.dispose(); face.dispose(); animation.dispose(); geometry.dispose(); material.dispose(); mesh.skeleton.dispose(); },
  };
}

test('the former unordered event fixture reproduces a cancelled eyebrow becoming the permanent base', async () => {
  const restore = globals(), f = await fixture(true);
  try {
    // c6a2dc8 (pretrial 2026-11-03): a touch now fades the face out (0.2 s); this control keeps the former instant cut (stop()) to show
    // what the unordered event path did with it.
    f.stop('hover'); f.face.stop(); assert.equal(f.face.getState().active, false);
    for (let frame = 0; frame < 45; frame++) f.step();
    assert.equal(f.stage.motionTransition.getState().active, false);
    assert.ok(f.mesh.morphTargetInfluences![0] > BASE_BROW + 0.3, 'the old outer snapshot restores an already cancelled inner target');
  } finally { f.dispose(); restore(); }
});

for (const mode of ['hover', 'window', 'plan', 'intensity'] as const) {
  test(`frame-external ${mode} cancellation refreshes the bridge target and returns to the exact nonzero base`, async () => {
    const restore = globals(), f = await fixture();
    try {
      const progress = f.stage.motionTransition.getState().elapsedMs;
      const shown = () => f.face.getState().state.weight + f.face.getState().reaction.weight, before = shown();
      f.stop(mode);
      if (mode === 'intensity') assert.ok(f.stage.moodView.parameters.intensity.expression > 0, 'effective response suppression works while the common template stays enabled');
      assert.equal(f.stage.motionTransition.getState().elapsedMs, progress, 'the event callback never advances the display clock');
      // c6a2dc8 (pretrial 2026-11-03): a touch, a window adjustment or 0 intensity fades the face (0.2 s), no one-frame cut.
      if (mode !== 'plan') assert.ok(!f.face.getState().active || shown() <= before, 'gone or fading, never growing');
      f.step(); assert.ok(Number.isFinite(f.mesh.morphTargetInfluences![0]));
      for (let frame = 0; frame < 60; frame++) f.step();
      assert.equal(f.stage.motionTransition.getState().active, false);
      assert.equal(f.face.getState().active, false);
      assert.equal(f.mesh.morphTargetInfluences![0], BASE_BROW, 'a removed morph owner cannot leave its last target behind');
      for (let frame = 0; frame < 45; frame++) { f.step(); assert.equal(f.mesh.morphTargetInfluences![0], BASE_BROW, 'no accumulation or late replay'); }
      assert.equal(f.mixer._actions[0], f.bodyAction);
      assert.ok(Math.abs(f.bodyAction.time - f.frames / 30) < 1e-8, 'the original body clock advances through the whole cancellation');
      assert.ok(f.mesh.skeleton.bones[0].quaternion.angleTo(new Quaternion()) > 0.05);
    } finally { f.dispose(); restore(); }
  });
}
