import assert from 'node:assert/strict';
import { AnimationClip, Euler, NumberKeyframeTrack, PerspectiveCamera, Quaternion, QuaternionKeyframeTrack, Scene, Vector3 } from 'three';
import type { AnimationAction, AnimationMixer, BufferGeometry, MeshBasicMaterial, SkinnedMesh } from 'three';
import { MmdStage as Stage } from '../../src/stage/MmdStage';
import { physicsMesh } from '../physics-fixture';
import { LayeredMmdAnimation } from '../../src/stage/motion-layers';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { DEFAULT_BLUSH_CALIBRATION } from '../../shared/blush';
import { MoodFeedback, EMPTY_CONTACT } from '../../src/stage/mood-feedback';
import { MusicDance } from '../../src/stage/music-dance';
import { normalizeModelPhysicsSettings } from '../../shared/model-physics';

type FixtureAnimation = Omit<LayeredMmdAnimation, 'helper'> & {
  readonly helper: Omit<LayeredMmdAnimation['helper'], 'update'> & { update(delta: number): void };
};

// The checked-in Stage frame is a prototype method (R24), so the fixture runs
// the real tick and every other actual method without evaluating source text.
const frameTick = (Stage.prototype as unknown as { frameTick(this: object, time: number): void }).frameTick;

export function fatigueStageFixture() {
  const keys = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const events: string[] = [], physicsDeltas: number[] = [];
  let rafCount = 0, renders = 0, bodyIpc = 0;
  Object.assign(globalThis, {
    document: { hidden: false },
    window: { devicePixelRatio: 1, desktop: {
      getBehaviorBodyPlan: async () => { bodyIpc++; return { mode: 'closed', reason: 'normal-pool-closed', cue: null }; },
      resolveBehaviorBody: async () => { throw Error('This fixture grants no body resource.'); },
    } },
    requestAnimationFrame() { return ++rafCount; }, cancelAnimationFrame() {},
  });
  const mesh = physicsMesh() as SkinnedMesh<BufferGeometry, MeshBasicMaterial>; mesh.geometry.userData.MMD.iks = []; mesh.geometry.userData.MMD.grants = [];
  mesh.morphTargetInfluences = [0]; mesh.morphTargetDictionary = { smile: 0 };
  const animation = new LayeredMmdAnimation(mesh) as FixtureAnimation;
  animation.setClips({
    pose: new AnimationClip('manual-pose', 8, [new QuaternionKeyframeTrack('.bones[頭].quaternion', [0, 8], [0, 0, 0, 1, 0, Math.sin(.3), 0, Math.cos(.3)])]),
    gesture: new AnimationClip('manual-gesture', 6, [new QuaternionKeyframeTrack('.bones[首].quaternion', [0, 6], [0, 0, 0, 1, Math.sin(.2), 0, 0, Math.cos(.2)])]),
    expression: new AnimationClip('manual-expression', 5, [new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 5], [.1, .8])]),
  });
  const mixer = animation.helper.objects.get(mesh)!.mixer! as AnimationMixer & { _actions: AnimationAction[] };
  const actions = [...mixer._actions];
  const update = animation.helper.update.bind(animation.helper);
  animation.helper.update = (delta: number) => { events.push(`helper:${delta}`); update(delta); };
  const settings = structuredClone(DEFAULT_SETTINGS); settings.pet.breath = .4; settings.pet.followMouse = true; settings.pet.fps = 30;
  const camera = new PerspectiveCamera(32, 400 / 560, .1, 3000); camera.position.set(0, 10, 30); camera.lookAt(0, 4, 0); camera.updateMatrixWorld(true);
  const stage = Object.create(Stage.prototype) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  const physicsState = { support: null, enabled: { hair: true, chest: false }, running: true, quality: 'standard', status: 'running', bodyCount: 0, constraintCount: 0, steps: 0, liveObjects: 0, avgStepMs: 0 };
  Object.assign(stage, {
    modelUrl: '', blushCalibrationModelUrl: '', blushCalibration: structuredClone(DEFAULT_BLUSH_CALIBRATION),
    scene: new Scene(), mesh, camera, settings, options: { transparent: true }, container: { clientWidth: 400, clientHeight: 560 },
    controls: { interacting: false, update() { events.push('input'); } }, renderer: { domElement: { dataset: {} }, render() { renders++; events.push('render'); } },
    animation, motionTransition: null, behaviorMotion: null, chatGesturePlayer: null,
    head: mesh.skeleton.bones[3], chest: mesh.skeleton.bones[1], center: mesh.skeleton.bones[0], eyes: [], arms: [], height: 20,
    elapsed: 0, previousFrame: 0, frameId: 0, disposed: false, hostVisible: true, hasRenderedModel: false,
    pointer: { x: .35, y: -.2 }, gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 }, gazeOrigin: new Vector3(), eyePoint: new Vector3(), facePoint: new Vector3(),
    rotation: new Euler(), offset: new Quaternion(), nextBlink: Infinity, blinkStart: -10, naturalBlink: 0, speaking: false, mouth: 0,
    blinkIndex: -1, mouthIndex: -1, smileIndex: -1, sadIndex: -1, blushChannel: null, boneLayers: [], morphLayers: [],
    restPose: mesh.skeleton.bones.map((bone: any) => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone() })),
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodView: null, moodFaceBlocked: true, moodHeadBlocked: true, moodMouthBlocked: true,
    musicDance: new MusicDance(), musicEnabled: false, musicSettings: { strength: .7 }, musicSuppressed: false, musicManualHeadBlocked: false,
    musicPose: { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 }, musicPoint: new Vector3(),
    proceduralBlush: null, blushPreviewUntil: 0, behaviorBlocked: false, bodyReady: true, bodyTargetSupported: false, bodyMotion: null,
    bodyConsumedIds: new Set(), bodyManualPose: true, bodyManualGesture: true, bodyDynamicPose: true, bodyWaitingForReply: false, bodyInputBlocked: false,
    tearLayer: null, tears: null, physicsSettings: normalizeModelPhysicsSettings(undefined), physicsSupport: null, physicsError: '',
    localPhysics: { restore() { events.push('physics.restore'); }, frame(delta: number) { events.push('physics.frame'); physicsDeltas.push(delta); }, setVisible() {}, getState: () => physicsState, getDiagnostics: () => null },
  });
  stage.tick = (time: number) => frameTick.call(stage, time);
  let now = 1000;
  const sample = () => ({ time: mixer.time, times: animation.getLayerTimes(), head: mesh.skeleton.bones[3].quaternion.clone(), expression: mesh.morphTargetInfluences![0], renders,
    renderSerial: JSON.parse(stage.renderer.domElement.dataset.musicDance ?? '{}').frameSerial ?? 0 });
  const advance = (frames = 12) => {
    const before = sample(), acceptedBefore = renders;
    for (let index = 0; index < frames; index++) { now += 1000 / 30; stage.tick(now); }
    const after = sample();
    assert.equal(renders - acceptedBefore, frames, 'Every visible accepted frame reaches the renderer.');
    assert.equal(after.renderSerial - before.renderSerial, frames, 'Existing completed-render diagnostics advance even with music off.');
    assert.equal(JSON.parse(stage.renderer.domElement.dataset.chatGesture).baseTime, after.time);
    assert.equal(JSON.parse(stage.renderer.domElement.dataset.motionTransition).layerTimes.pose, after.times.pose);
    assert.ok(after.time > before.time + (frames - 1) / 30, 'The actual base mixer clock continues.');
    for (const key of ['pose', 'gesture', 'expression'] as const) assert.ok(after.times[key]! > (before.times[key] ?? 0), `${key} phase continues without restart.`);
    assert.ok(after.head.angleTo(before.head) > .001, 'The resolved authored bone moves; a clock counter alone is insufficient.');
    assert.ok(Math.abs(after.expression - before.expression) > .001, 'Manual expression continues independently.');
    assert.ok(actions.every((action: any) => mixer._actions.includes(action) && action.enabled && !action.paused && action.timeScale === 1));
    assert.equal(bodyIpc, 0, 'A closed unsupported automatic-body scope cannot request resources.');
    return { before, after };
  };
  const close = () => {
    stage.bodyMotion?.dispose(); animation.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
    keys.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  };
  return { stage, advance, sample, close, events, physicsDeltas, actions, mixer, renders: () => renders, raf: () => rafCount };
}
