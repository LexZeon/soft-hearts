import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, Bone, BufferGeometry, Euler, MeshBasicMaterial, NumberKeyframeTrack, PerspectiveCamera, Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';
import type { ChatGestureCue, ChatGestureResource } from '../shared/chat-gesture';
import { MmdStage } from '../src/stage/MmdStage';
import { ChatGesturePlayer } from '../src/stage/chat-gesture';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { MusicDance } from '../src/stage/music-dance';
import { LayeredMmdAnimation } from '../src/stage/motion-layers';
import { HANDOFF_MAX_MS, MAX_DRIFT_DEG, MotionTransition, SWITCH_MAX_MS, captureMotionPose } from '../src/stage/motion-transition';

const Z = new Vector3(0, 0, 1);
const q = (angle: number) => new Quaternion().setFromAxisAngle(Z, angle);
const track = (name: string, start: number, end = start, duration = 2) => new QuaternionKeyframeTrack(`.bones[${name}].quaternion`, [0, duration], [...q(start).toArray(), ...q(end).toArray()]);
const gesture = () => new AnimationClip('chat', 2, [track('左腕', 1.2, -0.3), track('右腕', -1.1, 0.3), track('上半身2', 0.15, -0.15)]);
const same = (actual: Quaternion, expected: Quaternion, message = 'quaternion restored') => assert.ok(actual.clone().normalize().angleTo(expected.clone().normalize()) < 1e-7, message);

function harness() {
  const geometry = new BufferGeometry(); geometry.userData.MMD = { iks: [], grants: [] };
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const center = new Bone(), chest = new Bone(), head = new Bone(), left = new Bone(), right = new Bone();
  [center, chest, head, left, right].forEach((bone, index) => { bone.name = ['センター', '上半身2', '頭', '左腕', '右腕'][index]; });
  mesh.add(center); center.add(chest); chest.add(head, left, right); head.position.y = 15;
  left.quaternion.copy(q(0.04)); right.quaternion.copy(q(-0.03));
  mesh.bind(new Skeleton([center, chest, head, left, right])); mesh.morphTargetInfluences = [0.1];
  const scene = new Scene(); scene.add(mesh);
  const camera = new PerspectiveCamera(32, 1, 0.1, 3000); camera.position.set(0, 15, 30); camera.lookAt(0, 15, 0); camera.updateMatrixWorld(true);
  const settings = structuredClone(DEFAULT_SETTINGS); settings.pet.breath = 0; settings.pet.followMouse = false;
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  const player = new ChatGesturePlayer(mesh);
  Object.assign(stage, { scene, mesh, center, chest, head, eyes: [], camera, settings, options: { transparent: true },
    controls: { interacting: false, setEnabled() {} }, renderer: { render() {}, domElement: { dataset: {} } }, container: { clientWidth: 400, clientHeight: 560 },
    animation: null, arms: [{ bone: left, roll: 0.72 }, { bone: right, roll: -0.68 }], height: 20, width: 12, centerX: 0, baseY: 0,
    elapsed: 0, gazeOrigin: new Vector3(), eyePoint: new Vector3(), pointer: { x: 0, y: 0 }, gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 },
    nextBlink: Infinity, blinkStart: -10, speaking: false, mouth: 0, blinkIndex: -1, mouthIndex: -1, smileIndex: -1, sadIndex: -1,
    boneLayers: [], morphLayers: [], rotation: new Euler(), offset: new Quaternion(), restPose: mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() })),
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodFaceBlocked: false, moodHeadBlocked: false,
    moodView: { characterId: 'role-a', token: 'token-a', revision: 1, developerMode: false, expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot: getMoodSnapshot(createMoodState(0)) },
    musicDance: new MusicDance(), musicEnabled: false, hostVisible: true, disposed: false, frameId: 0, previousFrame: 0, hasRenderedModel: false,
    chatGesturePlayer: player, chatGestureGeneration: 0, chatGestureBlocked: false, chatGestureIds: new Set(), chatGestureClips: new Map(), chatGestureResource: null, chatGestureError: '',
    motionGeneration: 0, motionClips: new Map(), modelGeneration: 0, proceduralBlush: null, blushChannel: null, blushPreviewUntil: 0, blushPreviewing: false,
  });
  // Real stage methods and actual player in exactly the production tick order.
  const step = (blocked = stage.chatGestureBlocked) => {
    const delta = 1 / 30; stage.elapsed += delta; stage.previousFrame = stage.elapsed * 1_000;
    stage.motionTransition?.restore();
    stage.chatGesturePlayer?.restore(); stage.restoreLayers(); stage.animation?.helper.update(delta); stage.animateIdle(delta);
    stage.chatGesturePlayer?.frame(delta, { blocked }); stage.animateMood(delta); stage.animateMusic(delta);
    stage.motionTransition?.frame(delta);
    stage.renderer.render(stage.scene, stage.camera);
    stage.hasRenderedModel = stage.mesh !== null;
  };
  return { stage, player, mesh, left, right, chest, head, step,
    dispose() { stage.motionTransition?.dispose(); player.dispose(); stage.animation?.dispose(); geometry.dispose(); material.dispose(); mesh.skeleton.dispose(); } };
}
function browserGlobals(resolveChatGesture: (id: string, token: string) => Promise<ChatGestureResource>) {
  const names = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, { window: { desktop: { resolveChatGesture } }, document: { hidden: false }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  return () => names.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
}
function cue(id: string): ChatGestureCue { return { id, at: Date.now(), expiresAt: Date.now() + 10_000, intent: 'explain', strength: 0.55, reason: 'test' }; }
function resource(id: string): ChatGestureResource { return { cueId: id, intent: 'explain', packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', sha256: 'a'.repeat(64), durationMs: 2000, url: 'app-asset://test/chat.vmd' }; }

test('200 real idle/player frames end at the same relaxed arms without accumulating roll', () => {
  const h = harness(), control = harness();
  try {
    control.step(); const relaxedLeft = control.left.quaternion.clone(), relaxedRight = control.right.quaternion.clone();
    h.player.play({ id: 'natural', clip: gesture(), strength: 0.65 }); let sawGesture = false;
    for (let frame = 0; frame < 200; frame++) {
      h.step();
      if (h.player.getState().weight > 0.2 && h.left.quaternion.angleTo(relaxedLeft) > 0.05) sawGesture = true;
      if (!h.player.getState().active) { same(h.left.quaternion, relaxedLeft); same(h.right.quaternion, relaxedRight); }
    }
    assert.equal(sawGesture, true); assert.equal(h.player.getState().active, false);
    same(h.left.quaternion, relaxedLeft); same(h.right.quaternion, relaxedRight);
  } finally { h.dispose(); control.dispose(); }
});

test('identity cancels immediately while visible interaction fades to the same relaxed arms', () => {
  for (const mode of ['identity', 'contact']) {
    const h = harness(), control = harness();
    try {
      control.step(); const expected = [control.left.quaternion.clone(), control.right.quaternion.clone()];
      h.player.play({ id: `cancel-${mode}`, clip: gesture(), strength: 0.65 }); for (let frame = 0; frame < 20; frame++) h.step();
      if (mode === 'identity') h.stage.setMood({ ...h.stage.moodView, characterId: 'role-b', token: 'token-b' });
      else h.stage.setMoodContact({ ...EMPTY_CONTACT, contact: true });
      assert.equal(h.player.getState().active, false);
      let previous = Infinity, bridged = 0, start = NaN, peaked = false;
      for (let frame = 0; frame < 200; frame++) {
        h.step();
        const distance = h.left.quaternion.angleTo(expected[0]);
        // R29d: the visible cancel is the shared hand-off (handOffToBase), sized by the correction within HANDOFF_MAX_MS.
        // R29f: it starts at the speed the arm had (it may coast on a little, at most MAX_DRIFT_DEG), then retires steadily.
        if (mode === 'contact' && h.stage.motionTransition?.getState().active) {
          if (Number.isNaN(start)) start = distance;
          // (smootherstep lands closer than smoothstep did: the last bridged frame is within ~1e-5 rad.)
          assert.ok(distance > 1e-8 && distance <= start + MAX_DRIFT_DEG * Math.PI / 180, 'visible cancellation stays near where it was');
          if (distance < previous - 1e-7) peaked = true;
          else assert.ok(!peaked || distance <= previous + 1e-7, 'once it turns back, the cancellation retires continuously');
          previous = distance; bridged++;
        } else { same(h.left.quaternion, expected[0]); same(h.right.quaternion, expected[1]); }
      }
      if (mode === 'contact') assert.ok(bridged >= 8 && bridged <= Math.ceil(HANDOFF_MAX_MS / 1000 * 30), `bridged over ${bridged} frames`);
    } finally { h.dispose(); control.dispose(); }
  }
});

test('clearing all manual clips bridges into the actual idle arms while the base clock continues', () => {
  const h = harness(), restoreGlobals = browserGlobals(async id => resource(id));
  try {
    h.stage.settings.motion = { path: 'test', url: 'app-asset://test/base.vmd', name: 'base' };
    h.stage.animation = new LayeredMmdAnimation(h.mesh);
    h.stage.animation.setClips({ pose: new AnimationClip('pose', 8, [track('左腕', 0.1, 0.3, 8), track('右腕', -0.1, -0.3, 8)]), gesture: null, expression: null });
    for (let frame = 0; frame < 30; frame++) h.step();
    const previous = h.left.quaternion.clone();
    const animation = h.stage.animation;
    const time = animation.helper.objects.get(h.mesh)!.mixer!.time;
    assert.equal(h.stage.hasRenderedModel, true);
    h.stage.setVisible(true); // Main applies this even when an ordinary settings update keeps the pet visible.
    assert.equal(h.stage.previousFrame, 0, 'visibility reconciliation resets only the frame clock');
    assert.equal(h.stage.hasRenderedModel, true, 'the displayed model remains a valid transition source');
    h.stage.settings.motion = null;
    h.stage.clearMotionSmooth(); h.step();
    assert.ok(h.left.quaternion.angleTo(previous) < 0.03, 'the first idle frame cannot jump to a T pose or add a second relaxed roll');
    assert.equal(h.stage.motionTransition.getState().active, true);
    for (let frame = 0; frame < 240; frame++) h.step();
    same(h.left.quaternion, q(0.04 + 0.72)); same(h.right.quaternion, q(-0.03 - 0.68));
    assert.equal(h.stage.animation, animation);
    assert.ok(animation.helper.objects.get(h.mesh)!.mixer!.time > time + 7);
  } finally { h.dispose(); restoreGlobals(); }
});

test('real idle overlays and transient gesture leave the same layered base action advancing', () => {
  const h = harness();
  try {
    h.stage.settings.motion = { path: 'test-pose', url: 'app-asset://test/base.vmd', name: 'base' };
    h.stage.animation = new LayeredMmdAnimation(h.mesh);
    h.stage.animation.setClips({ pose: new AnimationClip('base', 10, [track('左腕', 0, 1, 10), track('右腕', 0, -0.8, 10)]), gesture: null, expression: null });
    const mixer = h.stage.animation.helper.objects.get(h.mesh).mixer, actions = [...mixer._actions];
    h.player.play({ id: 'layered', clip: gesture(), strength: 0.55 });
    for (let frame = 0; frame < 200; frame++) h.step();
    assert.equal(h.player.getState().active, false); assert.deepEqual(mixer._actions, actions);
    assert.ok(Math.abs(actions[0].time - 200 / 30) < 1e-9); same(h.left.quaternion, q(2 / 3)); same(h.right.quaternion, q(-8 / 15));
  } finally { h.dispose(); }
});

test('turning music off during an automatic gesture preserves the no-motion relaxed base', () => {
  const h = harness(), control = harness();
  try {
    control.step(); const expected = [control.left.quaternion.clone(), control.right.quaternion.clone()];
    h.stage.setMusicEnabled(true); h.player.play({ id: 'music-off', clip: gesture(), strength: 0.65 });
    for (let frame = 0; frame < 20; frame++) h.step(); h.stage.setMusicEnabled(false);
    for (let frame = 0; frame < 200; frame++) h.step();
    same(h.left.quaternion, expected[0], 'music toggle must not double the relaxed arm roll'); same(h.right.quaternion, expected[1]);
  } finally { h.dispose(); control.dispose(); }
});

test('manual selection consumes a cue and a late resource cannot play after hidden or token invalidation', async () => {
  let resolve!: (value: ChatGestureResource) => void, calls = 0;
  let pendingResource = new Promise<ChatGestureResource>(done => { resolve = done; });
  const restoreGlobals = browserGlobals(async () => { calls++; return pendingResource; });
  const h = harness();
  try {
    const blockedCue = cue('manual-block'); h.stage.moodView.gesture = blockedCue; h.stage.chatGestureBlocked = true;
    await h.stage.playChatGesture(blockedCue, 'token-a'); assert.equal(calls, 0);
    h.stage.chatGestureBlocked = false; await h.stage.playChatGesture(blockedCue, 'token-a'); assert.equal(calls, 0, 'blocked IDs cannot queue');
    const hiddenCue = cue('hidden'); h.stage.moodView.gesture = hiddenCue;
    const pending = h.stage.playChatGesture(hiddenCue, 'token-a'); assert.equal(calls, 1); h.stage.setVisible(false);
    resolve(resource(hiddenCue.id)); await pending; assert.equal(h.player.getState().active, false);
    h.stage.hostVisible = true;
    pendingResource = new Promise<ChatGestureResource>(done => { resolve = done; });
    const oldTokenCue = cue('old-token'); h.stage.moodView.gesture = oldTokenCue;
    const stale = h.stage.playChatGesture(oldTokenCue, 'token-a'); assert.equal(calls, 2);
    h.stage.setMood({ ...h.stage.moodView, token: 'token-b', gesture: undefined }); resolve(resource(oldTokenCue.id)); await stale;
    assert.equal(h.player.getState().active, false); assert.equal(h.stage.chatGestureClips.size, 0);
  } finally { h.dispose(); restoreGlobals(); }
});

test('a late parsed clip is discarded after the actual model teardown', async () => {
  const item = cue('old-model'), resolved = resource(item.id);
  const restoreGlobals = browserGlobals(async () => resolved), h = harness();
  try {
    h.step(); assert.equal(h.stage.hasRenderedModel, true);
    let resolveClip!: (value: AnimationClip) => void;
    h.stage.chatGestureClips.set(resolved.sha256, new Promise<AnimationClip>(done => { resolveClip = done; }));
    h.stage.moodView.gesture = item; const pending = h.stage.playChatGesture(item, 'token-a'); await Promise.resolve();
    h.stage.clearModel(); resolveClip(gesture()); await pending;
    assert.equal(h.stage.mesh, null); assert.equal(h.stage.chatGesturePlayer, null); assert.equal(h.player.getState().active, false); assert.equal(h.stage.chatGestureClips.size, 0);
    assert.equal(h.stage.hasRenderedModel, false, 'a newly loaded model cannot inherit the old model display qualification');
  } finally { h.dispose(); restoreGlobals(); }
});

test('an accepted resource with no playable model tracks reports failure and cannot silently replay', async () => {
  let calls = 0;
  const item = cue('no-compatible-tracks'), resolved = resource(item.id);
  const restoreGlobals = browserGlobals(async () => { calls++; return resolved; }), h = harness();
  try {
    h.stage.chatGestureClips.set(resolved.sha256, Promise.resolve(new AnimationClip('unmatched', 2, [track('UnknownArm', 0, 1)])));
    h.stage.moodView.gesture = item;
    await h.stage.playChatGesture(item, 'token-a');
    assert.equal(h.player.getState().active, false);
    assert.match(h.stage.getMoodDegradation(), /没有可播放的会话上身轨道/);
    assert.equal(calls, 1);
    h.stage.chatGestureClips.set(resolved.sha256, Promise.resolve(gesture()));
    await h.stage.playChatGesture(item, 'token-a');
    assert.equal(calls, 1, 'a later compatible clip cannot revive the consumed identity');
    assert.equal(h.player.getState().active, false);
  } finally { h.dispose(); restoreGlobals(); }
});

test('manual upper-body priority reports its useful reason without clearing or replacing the selected motion', () => {
  const h = harness();
  try {
    const selected = { path: 'private-selection', url: 'app-asset://test/manual.vmd', name: 'manual' };
    h.stage.settings.motion = selected;
    h.stage.chatGestureBlocked = true;
    h.stage.chatGestureBlockReason = 'manual-pose';
    assert.match(h.stage.getMoodDegradation(), /身体动作占用上身/);
    h.stage.chatGestureBlockReason = 'manual-gesture';
    assert.match(h.stage.getMoodDegradation(), /手选手势优先/);
    assert.equal(h.stage.settings.motion, selected);
  } finally { h.dispose(); }
});

test('new motion loading keeps the old manual layer protected until its replacement is ready', async () => {
  const h = harness(), original = MMDLoader.prototype.loadAnimation;
  let complete!: (value: AnimationClip) => void;
  MMDLoader.prototype.loadAnimation = ((...args: any[]) => { complete = args[2]; }) as any;
  try {
    h.stage.chatGestureBlocked = true;
    h.stage.animation = new LayeredMmdAnimation(h.mesh);
    h.stage.animation.setClips({ pose: null, gesture: new AnimationClip('manual', 4, [track('左腕', 0.8, 0.9, 4)]), expression: null });
    const loading = h.stage.loadMotions({ pose: { url: 'app-asset://test/new-base.vmd' }, gesture: null, expression: null }, false);
    const protectedDuringLoad = h.stage.chatGestureBlocked;
    complete(new AnimationClip('new-base', 4, [track('左腕', 0.2, 0.2, 4)])); await loading;
    assert.equal(protectedDuringLoad, true, 'old manual gesture still owns the arms during an asynchronous replacement');
    assert.equal(h.stage.chatGestureBlocked, false, 'a completed static base releases the automatic channel');
  } finally { MMDLoader.prototype.loadAnimation = original; h.dispose(); }
});

test('the neutral background candidate releases the channel only after content verification and still yields to manual gestures', async () => {
  const h = harness(), original = MMDLoader.prototype.loadAnimation;
  const pose = { path: 'reviewed-local-candidate', url: 'mmd-asset://registered/neutral-idle.vmd', name: 'neutral-idle.vmd' };
  h.stage.defaultPoseChecks = new Map([[pose.url, Promise.resolve(true)]]);
  MMDLoader.prototype.loadAnimation = ((_url: string, _mesh: unknown, done: (clip: AnimationClip) => void) => {
    done(new AnimationClip('small-background', 4, [track('左腕', 0, 0.02, 4)]));
  }) as typeof original;
  try {
    await h.stage.loadMotions({ pose, gesture: null, expression: null }, false);
    assert.equal(h.stage.chatGestureBlocked, false, 'the caller must not retain its old Stand-only filename precondition');
    h.stage.defaultPoseChecks.set(pose.url, Promise.resolve(false));
    await h.stage.loadMotions({ pose, gesture: null, expression: null }, false);
    assert.equal(h.stage.chatGestureBlocked, true, 'a matching candidate name without verified bytes remains manual');
    assert.equal(h.stage.chatGestureBlockReason, 'manual-pose');
    h.stage.defaultPoseChecks.set(pose.url, Promise.resolve(true));
    await h.stage.loadMotions({ pose, gesture: { url: 'app-asset://test/manual.vmd', name: 'manual' }, expression: null }, false);
    assert.equal(h.stage.chatGestureBlocked, true);
    assert.equal(h.stage.chatGestureBlockReason, 'manual-gesture');
  } finally { MMDLoader.prototype.loadAnimation = original; h.dispose(); }
});

test('cached rapid reselection captures the displayed bridge instead of its unblended target', async () => {
  const h = harness();
  try {
    h.stage.settings.motion = { path: 'test', url: 'app-asset://test/b.vmd', name: 'b' };
    h.stage.animation = new LayeredMmdAnimation(h.mesh);
    const clip = new AnimationClip('b', 4, [track('左腕', 1)]);
    const previous = captureMotionPose(h.mesh);
    const affected = h.stage.animation.setClips({ pose: clip, gesture: null, expression: null });
    h.stage.motionTransition = new MotionTransition(h.mesh); h.stage.motionTransition.start(previous, affected);
    for (let frame = 0; frame < 3; frame++) h.step();
    const displayed = h.left.quaternion.clone();
    const url = 'app-asset://test/b.vmd'; h.stage.motionClips.set(url, Promise.resolve(clip));
    await h.stage.loadMotions({ pose: null, gesture: { url, name: 'b' }, expression: null }, false);
    h.step();
    assert.ok(h.left.quaternion.angleTo(displayed) < 0.03, 'loading an already cached layer does not expose its full target between two transitions');
  } finally { h.stage.motionTransition?.dispose(); h.dispose(); }
});

test('cached selection still bridges after repeated visible settings reconcile the frame clock', async () => {
  const h = harness(), restoreGlobals = browserGlobals(async id => resource(id));
  try {
    h.stage.animation = new LayeredMmdAnimation(h.mesh);
    h.stage.animation.setClips({ pose: new AnimationClip('displayed-pose', 4, [track('左腕', 0.2), track('右腕', -0.2)]), gesture: null, expression: null });
    h.step();
    const displayed = h.left.quaternion.clone(), animation = h.stage.animation;
    assert.equal(h.stage.hasRenderedModel, true); assert.ok(h.stage.previousFrame > 0);
    assert.equal(h.stage.motionTransition?.getState().active ?? false, false, 'this is not continuing an already existing bridge');
    h.stage.setVisible(true); h.stage.setVisible(true);
    assert.equal(h.stage.previousFrame, 0);
    assert.equal(h.stage.hasRenderedModel, true, 'same-visible updates cannot erase an actually displayed model');
    const url = 'app-asset://test/cached-selection.vmd';
    h.stage.motionClips.set(url, Promise.resolve(new AnimationClip('cached-selection', 4, [track('左腕', 1.4), track('右腕', -1.4)])));
    await h.stage.loadMotions({ pose: { url, name: 'cached-selection' }, gesture: null, expression: null }, false);
    assert.equal(h.stage.motionTransition?.getState().active, true, 'cached completion before the next frame still starts a bridge');
    same(h.left.quaternion, displayed, 'commit preserves the last visible pose before another render');
    h.step(); assert.ok(h.left.quaternion.angleTo(displayed) < 0.04, 'the first new frame approaches the target rather than jumping');
    // R29d: a switch is sized by its correction, within SWITCH_MAX_MS.
    for (let frame = 0; frame < Math.ceil(SWITCH_MAX_MS / 1000 * 30); frame++) h.step();
    same(h.left.quaternion, q(1.4)); assert.equal(h.stage.animation, animation);
    assert.ok(animation.getLayerTimes().pose! > 0.5);
  } finally { h.dispose(); restoreGlobals(); }
});

test('actual hiding clears the displayed-model qualification until a model is rendered again', async () => {
  const h = harness(), restoreGlobals = browserGlobals(async id => resource(id));
  try {
    h.stage.animation = new LayeredMmdAnimation(h.mesh);
    h.stage.animation.setClips({ pose: new AnimationClip('old-visible', 4, [track('左腕', 0.2)]), gesture: null, expression: null });
    h.step(); assert.equal(h.stage.hasRenderedModel, true);
    h.stage.setVisible(false);
    assert.equal(h.stage.hasRenderedModel, false); assert.equal(h.stage.previousFrame, 0);
    h.stage.setVisible(true);
    assert.equal(h.stage.hasRenderedModel, false, 'showing alone does not qualify a stale hidden frame');
    const url = 'app-asset://test/after-hide.vmd';
    h.stage.motionClips.set(url, Promise.resolve(new AnimationClip('after-hide', 4, [track('左腕', 1)])));
    await h.stage.loadMotions({ pose: { url, name: 'after-hide' }, gesture: null, expression: null }, false);
    assert.equal(h.stage.motionTransition?.getState().active ?? false, false, 'the stale hidden pose is not replayed as an entrance');
    h.step(); assert.equal(h.stage.hasRenderedModel, true); same(h.left.quaternion, q(1));
  } finally { h.dispose(); restoreGlobals(); }
});

test('pending settings cannot add relaxed-arm roll over a still-committed pose or gesture', () => {
  for (const channel of ['pose', 'gesture'] as const) {
    const h = harness();
    try {
      h.stage.animation = new LayeredMmdAnimation(h.mesh);
      h.stage.animation.setClips({ pose: null, gesture: null, expression: null,
        [channel]: new AnimationClip(channel, 4, [track('左腕', 0.3)]) });
      h.stage.animation.helper.update(0); // a valid action at time zero still owns its properties.
      const base = h.left.quaternion.clone();
      h.stage.settings.motion = null; h.stage.settings.motionLayers = { gesture: null, expression: null };
      h.stage.animateIdle(1 / 30);
      same(h.left.quaternion, base, 'old committed layer remains protected while another asset is still loading or fails');
    } finally { h.dispose(); }
  }
});

test('turning music off during a display bridge cannot retain a second idle arm roll', () => {
  const h = harness();
  try {
    h.step(); const expected = h.left.quaternion.clone();
    const displayed = captureMotionPose(h.mesh);
    h.stage.motionTransition = new MotionTransition(h.mesh);
    h.stage.motionTransition.start(displayed, ['.bones[左腕].quaternion']);
    h.stage.musicEnabled = true;
    for (let frame = 0; frame < 3; frame++) h.step();
    h.stage.setMusicEnabled(false);
    for (let frame = 0; frame < 240; frame++) h.step();
    same(h.left.quaternion, expected, 'disabling music restores the final bridge before the earlier procedural layer');
  } finally { h.stage.motionTransition?.dispose(); h.dispose(); }
});

test('an active automatic gesture enters a cached manual layer from the same displayed pose', async () => {
  const h = harness();
  try {
    h.player.play({ id: 'auto-before-manual', clip: gesture(), strength: 0.65 });
    for (let frame = 0; frame < 20; frame++) h.step();
    const displayed = h.left.quaternion.clone();
    const url = 'app-asset://test/manual.vmd', clip = new AnimationClip('manual', 4, [track('左腕', -0.1)]);
    h.stage.motionClips.set(url, Promise.resolve(clip));
    await h.stage.loadMotions({ pose: null, gesture: { url, name: 'manual' }, expression: null }, false);
    h.step();
    assert.ok(h.left.quaternion.angleTo(displayed) < 0.04);
    assert.equal(h.player.getState().active, false, 'the automatic player is already cancelled, rather than overlaying the new manual action');
  } finally { h.stage.motionTransition?.dispose(); h.dispose(); }
});

test('explicit alternate mouth vowels block feeding while unrelated eye morphs do not', async () => {
  const h = harness();
  try {
    h.mesh.morphTargetDictionary = { あ: 0, い: 1, 笑い: 2 }; h.mesh.morphTargetInfluences = [0, 0, 0]; h.stage.mouthIndex = 0;
    for (const [index, expected] of [[1, true], [2, false]] as const) {
      const url = `app-asset://test/face-${index}.vmd`;
      h.stage.motionClips.set(url, Promise.resolve(new AnimationClip('face', 4,
        [new NumberKeyframeTrack(`.morphTargetInfluences[${index}]`, [0, 4], [0.5, 0.5])])));
      await h.stage.loadMotions({ pose: null, gesture: null, expression: { url, name: 'face' } }, false);
      assert.equal(h.stage.moodMouthBlocked, expected);
    }
  } finally { h.dispose(); }
});
