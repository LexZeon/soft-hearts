import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, Float32BufferAttribute, NumberKeyframeTrack, Quaternion, Vector3 } from 'three';
import type { AnimationAction } from 'three';
import { fatigueStageFixture } from './helpers/fatigue-stage-fixture';
import { DROWSY_RELEASE_SECONDS, DrowsyExpression, type DrowsyContext, type DrowsyFrame } from '../src/stage/drowsy-expression';
import { BehaviorMotionPlayer } from '../src/stage/behavior-motion';
import { ChatGesturePlayer } from '../src/stage/chat-gesture';
import { MotionTransition } from '../src/stage/motion-transition';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/fatigue';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import type { BehaviorMotionCue, BehaviorMotionResource } from '../shared/behavior-motion';
import type { MotionLayerClips } from '../src/stage/motion-layers';

class ObservedDrowsyExpression extends DrowsyExpression {
  last: DrowsyFrame = { headX: 0, brow: 0, rawEye: 0, eyeShape: 0, active: false };
  override frame(delta: number, context: DrowsyContext): DrowsyFrame {
    return this.last = super.frame(delta, context);
  }
}
const asset = (part: string) => ({ path: `r36-synthetic-${part}`, name: `r36-${part}.vmd`, url: `mmd-asset://r36-synthetic/${part}` });
const poseAsset = asset('pose'), gestureAsset = asset('gesture'), expressionAsset = asset('expression');
const closeTo = (actual: number, expected: number, message: string) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${message}: ${actual} / ${expected}`);
function sameQuaternionComponents(actual: Quaternion, expected: Quaternion, message: string): void {
  for (const key of ['x', 'y', 'z', 'w'] as const)
    assert.ok(Math.abs(actual[key] - expected[key]) <= 1e-12, `${message}.${key}`);
}
function view(phase: FatiguePhase = 'drowsy', token = 'r36-token'): MoodView {
  const snapshot = getMoodSnapshot(createMoodState(0));
  return { characterId: 'r36-synthetic', token, revision: 1, developerMode: false, expressions: true,
    parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), gesture: null,
    snapshot: { ...snapshot, primary: 'calm', companion: 'comfortable', cue: null,
      intensity: { ...snapshot.intensity, expression: 50, posture: 50 } },
    fatigue: { ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: .9, F: .8, phase })), sleepEntryReady: true },
  };
}

// Extends only the existing 9f inert fixture. It is an explicit synthetic
// identity/ownership port, not proof of a Gene model or actual host admission.
async function fixture() {
  const h = fatigueStageFixture(), s = h.stage, mesh = s.mesh;
  const head = s.head;
  assert.equal(mesh.skeleton.bones[3], head);
  const displaced = mesh.skeleton.bones[9];
  mesh.skeleton.bones[3] = displaced; mesh.skeleton.bones[9] = head;
  const inverse = mesh.skeleton.boneInverses[3];
  mesh.skeleton.boneInverses[3] = mesh.skeleton.boneInverses[9]; mesh.skeleton.boneInverses[9] = inverse;
  // The inert helper has not updated yet. Its first real update creates the
  // cache in the already-adjusted skeleton order; do not manufacture a cache.
  const object = s.animation.helper.objects.get(mesh) as { backupBones?: Float32Array };
  assert.equal(object.backupBones, undefined, 'the original inert fixture has not advanced');
  assert.equal(mesh.skeleton.bones.filter((bone: { name: string }) => bone.name === '頭').length, 1);

  const influences = mesh.morphTargetInfluences as number[];
  while (influences.length < 184) influences.push(0);
  Object.assign(mesh.morphTargetDictionary, { '困る': 68, 'じと目': 95, 'まばたき': 88, '笑い': 89, 'あ': 1 });
  const base = mesh.geometry.getAttribute('position');
  mesh.geometry.morphAttributes.position = Array.from({ length: 184 }, () => base.clone());
  const observed = new ObservedDrowsyExpression();
  Object.assign(s, {
    drowsyExpression: observed, drowsySuppressed: false, drowsyPendingSettings: 0, finalEyeClosure: 0,
    modelGeneration: 1, settingsGeneration: 0, motionGeneration: 0,
    pendingModel: Promise.resolve(), pendingMotion: Promise.resolve(), motionClips: new Map(),
    chatGestureClips: new Map(), chatGestureIds: new Set(), defaultPoseChecks: new Map(), chatGestureGeneration: 0,
    tearsAnchors: null, tearsAnchorsProbed: true, tearsVerifiedGene: true,
    headContactProfile: null, cheekAnchors: null, bodyCameraEditing: false,
    blinkIndex: 88, smileIndex: 89, sadIndex: 68, mouthIndex: 1,
  });
  // Constructor-only inert ports omitted by the old Object.create fixture.
  s.controls.setEnabled = (enabled: boolean) => { h.events.push(`controls:${enabled}`); };
  s.controls.setCamera = () => {};
  s.localPhysics.dispose = () => { h.events.push('physics.dispose'); };
  s.settings.pet.followMouse = false; s.settings.pet.breath = 0;
  s.lastSettingsCamera = [s.settings.camera.yaw, s.settings.camera.pitch, s.settings.camera.distance,
    s.settings.camera.targetX, s.settings.camera.targetY, s.settings.camera.targetZ ?? 0, s.settings.camera.fov].join(',');
  const clips = (s.animation as unknown as { source: MotionLayerClips }).source;
  assert.ok(clips.pose && clips.gesture && clips.expression);
  s.motionClips.set(poseAsset.url, Promise.resolve(clips.pose));
  s.motionClips.set(gestureAsset.url, Promise.resolve(clips.gesture));
  s.motionClips.set(expressionAsset.url, Promise.resolve(clips.expression));
  const retained = h.actions.filter((action: AnimationAction) => !action.getClip().name.includes('manual-expression'));
  assert.equal(retained.length, 2);
  const selectMotions = async (selected: { pose: boolean; gesture: boolean; expression: boolean }) => {
    // loadMotions drops unselected cache entries. Re-select only these already
    // owned original clips; no loader/network request is part of this fixture.
    if (selected.pose) s.motionClips.set(poseAsset.url, Promise.resolve(clips.pose));
    if (selected.gesture) s.motionClips.set(gestureAsset.url, Promise.resolve(clips.gesture));
    if (selected.expression) s.motionClips.set(expressionAsset.url, Promise.resolve(clips.expression));
    const settings = { ...s.settings, model: null, motion: selected.pose ? poseAsset : null,
      motionLayers: { gesture: selected.gesture ? gestureAsset : null, expression: selected.expression ? expressionAsset : null } };
    await s.applySettings(settings);
  };
  const selectExpression = (enabled: boolean) => selectMotions({ pose: true, gesture: true, expression: enabled });
  // Actual cached selection path withdraws only the manual facial clip. The
  // existing manual pose/gesture objects keep ownership and reject head intent.
  await selectExpression(false);
  assert.equal(s.moodFaceBlocked, false); assert.equal(s.moodHeadBlocked, true);
  assert.ok(retained.every((action: AnimationAction) => h.mixer._actions.includes(action)));
  assert.equal(s.mesh.morphTargetInfluences, influences);
  s.setMood(view()); s.setSpeaking(true);
  let now = 1000;
  let checkedFirstCache = false;
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      now += 1000 / 30; s.tick(now);
      if (!checkedFirstCache) {
        const cache = object.backupBones;
        assert.ok(cache && cache.length === mesh.skeleton.bones.length * 7);
        checkedFirstCache = true;
      }
    }
  };
  const helperCalls = () => h.events.filter((event: string) => event.startsWith('helper:')).length;
  const snapshot = () => ({ time: h.mixer.time, times: retained.map((action: AnimationAction) => action.time),
    head: head.quaternion.clone(), mouth: influences[1], influence0: influences[0] });
  const assertClocksAdvance = (before: ReturnType<typeof snapshot>) => {
    const after = snapshot();
    assert.ok(after.time > before.time);
    after.times.forEach((time: number, i: number) => assert.ok(time > before.times[i]));
    assert.ok(after.head.angleTo(before.head) > 1e-5, 'the actual authored head moves');
    assert.ok(Math.abs(after.mouth - before.mouth) > 1e-5, 'actual speaking mouth continues');
    assert.ok(retained.every((action: AnimationAction) => h.mixer._actions.includes(action) && action.enabled && !action.paused && action.timeScale === 1));
    return after;
  };
  return { ...h, s, head, mesh, influences, observed, retained, tick, snapshot, helperCalls, selectExpression, selectMotions, assertClocksAdvance };
}

test('actual Stage admits the new face profile while manual head, gesture and mouth keep their real clocks', async () => {
  const h = await fixture();
  try {
    const before = h.snapshot(); h.tick(12); h.assertClocksAdvance(before);
    assert.equal(h.observed.last.headX, 0, 'manual pose/gesture keep head ownership');
    assert.ok(h.observed.last.brow > 0 && h.observed.last.eyeShape > 0);
    closeTo(h.influences[68], h.observed.last.brow, 'applied brow');
    closeTo(h.influences[95], h.observed.last.eyeShape, 'applied eye');
    assert.equal(h.helperCalls(), 12, 'one existing helper update per rendered tick');
  } finally { h.close(); }
});

test('actual Stage adds and withdraws the approved local-X head offset after explicit manual deselection', async () => {
  const h = await fixture();
  try {
    h.tick(12);
    const helper = h.s.animation.helper;
    await h.selectMotions({ pose: false, gesture: false, expression: false });
    h.tick(30);
    assert.equal(h.s.animation.helper, helper);
    assert.equal(h.s.bodyManualPose, false); assert.equal(h.s.bodyManualGesture, false); assert.equal(h.s.bodyDynamicPose, false);
    assert.equal(h.s.motionTransition?.getState().active ?? false, false);
    const headX = h.observed.last.headX;
    assert.ok(headX > 0 && headX <= .018 * .8);
    const before = h.head.quaternion.clone();
    const gaze = { ...h.s.gaze }, eyeGaze = { ...h.s.eyeGaze };
    const camera = { position: h.s.camera.position.toArray(), quaternion: h.s.camera.quaternion.toArray(), fov: h.s.camera.fov };
    const mouth = h.influences[1], mixerTime = h.mixer.time, calls = h.helperCalls(), times = h.s.animation.getLayerTimes();
    h.s.withdrawDrowsyExpression();
    assert.equal(h.observed.active, false); assert.equal(h.helperCalls(), calls);
    assert.equal(h.mixer.time, mixerTime); assert.deepEqual(h.s.animation.getLayerTimes(), times);
    const relative = h.head.quaternion.clone().normalize().invert().multiply(before.clone().normalize()).normalize();
    const expected = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), headX);
    sameQuaternionComponents(relative, expected, 'withdrawn relative local-X offset');
    assert.deepEqual(h.s.gaze, gaze); assert.deepEqual(h.s.eyeGaze, eyeGaze);
    assert.deepEqual({ position: h.s.camera.position.toArray(), quaternion: h.s.camera.quaternion.toArray(), fov: h.s.camera.fov }, camera);
    closeTo(h.influences[1], mouth, 'head withdrawal preserves mouth');
  } finally { h.close(); }
});

// R29c (was: "withdraws the profile immediately"): a contact between ticks is a
// hand-off. Nothing is rebuilt or cut at event time; from the next tick the
// brow and eye shape fade out from what is shown over DROWSY_RELEASE_SECONDS.
test('R29c: contact between ticks cuts nothing; the profile then fades out without helper updates or manual-clock resets', async () => {
  const h = await fixture();
  const transition = new MotionTransition(h.mesh);
  const chat = new ChatGesturePlayer(h.mesh);
  const behavior = new BehaviorMotionPlayer(h.mesh, { targetSupported: true,
    resolve: async () => { throw Error('No behavior resource is authorized by this contact case.'); },
    load: async () => { throw Error('No behavior clip is authorized by this contact case.'); } });
  h.s.motionTransition = transition; h.s.chatGesturePlayer = chat; h.s.behaviorMotion = behavior;
  try {
    h.tick(12); assert.ok(h.observed.active);
    const before = h.snapshot(), calls = h.helperCalls(), brow = h.influences[68], eye = h.influences[95];
    assert.ok(brow > 0 && eye > 0);
    h.s.setMoodContact({ ...EMPTY_CONTACT, contact: true });
    assert.equal(h.observed.active, true, 'no event-time withdrawal');
    assert.equal(h.influences[68], brow); assert.equal(h.influences[95], eye);
    assert.equal(h.helperCalls(), calls);
    closeTo(h.mixer.time, before.time, 'mixer time between ticks');
    h.retained.forEach((action: AnimationAction, index: number) => closeTo(action.time, before.times[index], 'manual action time'));
    sameQuaternionComponents(h.head.quaternion, before.head, 'unchanged head');
    closeTo(h.influences[1], before.mouth, 'speaking mouth is not reset');
    const shown = [h.observed.last.brow];
    const frames = Math.ceil(DROWSY_RELEASE_SECONDS * 30);
    for (let i = 0; i < frames; i++) { h.tick(); shown.push(h.observed.last.brow); }
    const stepsTaken = shown.slice(1).map((value, i) => shown[i] - value);
    assert.ok(stepsTaken.every(step => step >= 0), 'the brow only falls');
    assert.ok(Math.max(...stepsTaken) <= shown[0] * 1.5 / (DROWSY_RELEASE_SECONDS * 30) + 1e-12, `no one-frame cut (${stepsTaken.map(v => v.toFixed(4)).join(' ')})`);
    assert.equal(h.observed.active, false); assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
    h.assertClocksAdvance(before);
  } finally { transition.dispose(); behavior.dispose(); chat.dispose(); h.close(); }
});

test('hard withdrawal (hide, scope or model change) still clears at event time, outer layers first, without a helper update', async () => {
  const h = await fixture();
  const transition = new MotionTransition(h.mesh);
  const chat = new ChatGesturePlayer(h.mesh);
  const behavior = new BehaviorMotionPlayer(h.mesh, { targetSupported: true,
    resolve: async () => { throw Error('No behavior resource is authorized by this case.'); },
    load: async () => { throw Error('No behavior clip is authorized by this case.'); } });
  h.s.motionTransition = transition; h.s.chatGesturePlayer = chat; h.s.behaviorMotion = behavior;
  const order: string[] = [];
  const observeRestore = (target: { restore(): void }, label: string) => {
    const restore = target.restore.bind(target);
    target.restore = () => { order.push(label); restore(); };
  };
  observeRestore(h.s.localPhysics, 'physics'); observeRestore(transition, 'transition');
  observeRestore(behavior, 'behavior'); observeRestore(chat, 'chat');
  const restoreLayers = h.s.restoreLayers.bind(h.s);
  h.s.restoreLayers = () => { order.push('procedural'); restoreLayers(); };
  try {
    h.tick(12); assert.ok(h.observed.active);
    order.length = 0;
    const calls = h.helperCalls();
    h.s.withdrawDrowsyExpression();
    assert.equal(h.observed.active, false); assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
    assert.deepEqual(order.slice(0, 5), ['physics', 'transition', 'behavior', 'chat', 'procedural']);
    assert.equal(h.helperCalls(), calls);
  } finally { transition.dispose(); behavior.dispose(); chat.dispose(); h.close(); }
});

test('R29c: falling asleep releases the shown profile by its fade at the actual Stage (no event-time cut)', async () => {
  const h = await fixture();
  try {
    h.tick(12); assert.ok(h.observed.active);
    const brow = h.influences[68], eye = h.influences[95];
    h.s.setMood(view('falling-asleep'));
    assert.equal(h.observed.active, true, 'no event-time withdrawal');
    assert.equal(h.influences[68], brow); assert.equal(h.influences[95], eye);
    const shown = [h.observed.last.brow];
    for (let i = 0; i < Math.ceil(DROWSY_RELEASE_SECONDS * 30); i++) { h.tick(); shown.push(h.observed.last.brow); }
    const stepsTaken = shown.slice(1).map((value, i) => shown[i] - value);
    assert.ok(stepsTaken.every(step => step >= 0) && Math.max(...stepsTaken) <= shown[0] * 1.5 / (DROWSY_RELEASE_SECONDS * 30) + 1e-12,
      `the brow only falls, by the release curve (${stepsTaken.map(v => v.toFixed(4)).join(' ')})`);
    assert.equal(h.observed.active, false); assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
  } finally { h.close(); }
});

test('real scope and visibility entrypoints release old intent and never carry it into a new token', async () => {
  const h = await fixture();
  try {
    h.tick(12); const oldBrow = h.observed.last.brow;
    h.s.setMood(view('drowsy', 'r36-next-token'));
    assert.equal(h.observed.active, false); assert.equal(h.influences[68], 0);
    h.tick(); assert.ok(h.observed.last.brow > 0 && h.observed.last.brow < oldBrow);
    h.s.setVisible(false);
    assert.equal(h.observed.active, false); assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
    assert.equal(h.s.hostVisible, false);
  } finally { h.close(); }
});

// R29c (was: "takes priority before the next tick" by a cut): the pending
// settings apply releases the profile by its fade and never re-admits it; the
// selected expression then owns the face.
test('R29c: manual expression selection releases the profile by its fade and never re-admits it while pending', async () => {
  const h = await fixture();
  let releaseModel = () => {};
  let pending: Promise<void> | undefined;
  try {
    h.tick(12); const calls = h.helperCalls(), before = h.snapshot(), brow = h.influences[68];
    h.s.pendingModel = new Promise<void>(resolve => { releaseModel = resolve; });
    pending = h.selectExpression(true);
    assert.equal(h.observed.active, true, 'no event-time cut');
    assert.equal(h.influences[68], brow);
    assert.equal(h.helperCalls(), calls, 'settings apply adds no helper update');
    assert.ok(h.s.drowsyPendingSettings > 0);
    const shown = [h.observed.last.brow];
    for (let i = 0; i < 5; i++) { h.tick(); shown.push(h.observed.last.brow); }
    h.assertClocksAdvance(before);
    assert.ok(shown.slice(1).every((value, i) => value < shown[i]), 'pending settings only let it fade, never re-admit it');
    releaseModel();
    await pending;
    assert.equal(h.s.drowsyPendingSettings, 0);
    assert.equal(h.s.moodFaceBlocked, true);
    h.tick(Math.ceil(DROWSY_RELEASE_SECONDS * 30)); h.assertClocksAdvance(before);
    assert.equal(h.observed.active, false);
    assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
    assert.ok(h.influences[0] > 0, 'the selected original expression action is rendered');
  } finally { releaseModel(); if (pending) await pending; h.close(); }
});

test('invalid structure clears displayed intent on the next actual tick and clearModel releases it on event', async () => {
  const h = await fixture();
  try {
    h.tick(12); assert.ok(h.observed.active);
    const old = h.mesh.geometry.morphAttributes.position[88];
    h.mesh.geometry.morphAttributes.position[88] = new Float32BufferAttribute([0, 0, 0], 3);
    h.tick(); assert.equal(h.observed.active, false); assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
    h.mesh.geometry.morphAttributes.position[88] = old; h.tick(8); assert.ok(h.observed.active);
    h.s.clearModel();
    assert.equal(h.observed.active, false); assert.equal(h.s.mesh, null);
    assert.equal(h.influences[68], 0); assert.equal(h.influences[95], 0);
  } finally { h.close(); }
});

test('actual Stage shares its final eye closure with raw drowsy attenuation and the existing behavior sampler', async () => {
  const h = await fixture();
  try {
    h.tick(12);
    assert.ok(h.observed.last.rawEye > 0);
    closeTo(h.observed.last.eyeShape, h.observed.last.rawEye * (1 - h.s.finalEyeClosure), 'post-smoothing closure');
    closeTo(h.influences[88], h.s.finalEyeClosure, 'single applied blink budget');
    const cue: BehaviorMotionCue = { id: 'r36-synthetic-eye', kind: 'state', bindingId: 'face.smile', semantic: 'mood.content',
      at: 1000, expiresAt: 11000, strength: .4, stateKey: 'r36-eye-state' };
    const resource: BehaviorMotionResource = { cueId: cue.id, bindingId: cue.bindingId, packId: 'gene', motionId: 'smile',
      sha256: 'a'.repeat(64), durationMs: 1000, url: 'mmd-asset://r36-synthetic/eye', recipe: 'emotion-face' };
    const clip = new AnimationClip('r36-synthetic-eye', 1, [new NumberKeyframeTrack('.morphTargetInfluences[95]', [0, 1], [1, 1])]);
    const player = new BehaviorMotionPlayer(h.mesh, { targetSupported: true, now: () => 1000,
      resolve: async () => resource, load: async () => clip });
    h.s.behaviorMotion = player;
    h.s.setMood({ ...view(), behavior: { state: cue, reaction: null } });
    await new Promise<void>(resolve => setImmediate(resolve));
    // R29c: the authored face takes over by the profile's release fade, not a cut.
    h.tick(Math.ceil(DROWSY_RELEASE_SECONDS * 30));
    assert.equal(h.observed.last.brow, 0); assert.equal(h.observed.last.rawEye, 0, 'authored eye owner excludes profile');
    const state = player.getState().state, sample = state.samples.find(value => value.index === 95);
    assert.ok(state.active && state.weight > 0 && sample);
    assert.ok(h.s.finalEyeClosure > 0);
    closeTo(sample.value, sample.base + (sample.sample - sample.base) * state.weight * (1 - h.s.finalEyeClosure), 'actual sampler uses final closure');
    assert.ok(sample.value < sample.base + (sample.sample - sample.base) * state.weight);
    closeTo(h.influences[95], sample.value, 'sampler rendered value');
    player.dispose(); h.s.behaviorMotion = null;
  } finally { h.close(); }
});


test('unsupported drowsy scope returns before DOM or display owners and clears only its existing raw intent', async () => {
  const { MmdStage } = await import('../src/stage/MmdStage');
  const { Bone, BufferGeometry, MeshBasicMaterial, Skeleton, SkinnedMesh } = await import('three');
  const method = Object.getOwnPropertyDescriptor(MmdStage.prototype, 'drowsyFrame')?.value as unknown;
  assert.equal(typeof method, 'function');
  const call = method as (this: object, delta: number, smile: number, sadness: number, closure: number, residual: boolean) => DrowsyFrame;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.morphAttributes.position = Array.from({ length: 184 }, () => geometry.getAttribute('position').clone());
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  const bones = Array.from({ length: 10 }, (_, index) => { const bone = new Bone(); bone.name = index === 9 ? '頭' : 'synthetic-' + index; return bone; });
  const skeleton = new Skeleton(bones); mesh.skeleton = skeleton;
  mesh.morphTargetInfluences = Array(184).fill(0);
  mesh.morphTargetDictionary = { '困る': 68, 'じと目': 95, 'まばたき': 88, '笑い': 89 };
  const head = bones[9], foreignHead = new Bone(); foreignHead.name = '頭';
  const good = view();
  const variants: { label: string; change: Record<string, unknown>; delta?: number }[] = [
    { label: 'unset host verification', change: { tearsVerifiedGene: undefined } },
    { label: 'false host verification', change: { tearsVerifiedGene: false } },
    { label: 'absent host view', change: { moodView: null } },
    { label: 'legacy view without host scope IDs', change: { moodView: { expressions: true, fatigue: good.fatigue, snapshot: good.snapshot, parameters: good.parameters } } },
    { label: 'empty host token', change: { moodView: { ...good, token: '' } } },
    { label: 'missing fatigue scope', change: { moodView: { ...good, fatigue: undefined } } },
    { label: 'nonfinite fatigue', change: { moodView: { ...good, fatigue: { ...good.fatigue, F: NaN } } } },
    { label: 'out-of-range fatigue', change: { moodView: { ...good, fatigue: { ...good.fatigue, F: 1.01 } } } },
    { label: 'unknown fatigue phase', change: { moodView: { ...good, fatigue: { ...good.fatigue, phase: 'unsupported-phase' } } } },
    { label: 'disabled host expressions', change: { moodView: { ...good, expressions: false } } },
    { label: 'verified flag without content', change: { mesh: undefined, head: undefined } },
    { label: 'verified flag with mismatched head binding', change: { head: foreignHead } },
    { label: 'invalid render delta', change: {}, delta: NaN },
  ];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  assert.equal(Reflect.deleteProperty(globalThis, 'document'), true);
  assert.equal(Reflect.has(globalThis, 'document'), false);
  try {
    for (const { label, change, delta = .02 } of variants) for (const seeded of [false, true]) {
      const existing = seeded ? new DrowsyExpression() : undefined;
      if (existing) assert.ok(existing.frame(.1, { scope: 'previous-host-scope', verified: true, phase: 'drowsy', F: .8,
        headAllowed: true, browAllowed: true, eyeAllowed: true, finalClosure: 0 }).active);
      const forbidden: string[] = [];
      const touch = (name: string): never => { forbidden.push(name); throw new Error('unsupported drowsy scope touched ' + name); };
      const owner = Object.freeze({ restore: () => touch('layer.restore'), frame: () => touch('layer.frame'),
        getState: () => touch('layer.state'), ownsProperty: () => touch('layer.ownsProperty') });
      const animation = Object.freeze({ helper: Object.freeze({ update: () => touch('helper.update') }) });
      const boneLayers: unknown[] = [], morphLayers: unknown[] = [];
      const contact = Object.freeze({ ...EMPTY_CONTACT });
      const gaze = Object.freeze({ x: .1, y: -.2 });
      const stage = Object.assign(Object.create(MmdStage.prototype) as Record<string, unknown>, {
        tearsVerifiedGene: true, moodView: good, mesh, head, modelGeneration: 7,
        elapsed: 12.5, previousFrame: 3000, hostVisible: true, disposed: false,
        blinkIndex: 88, smileIndex: 89, sadIndex: 68, drowsySuppressed: false, drowsyPendingSettings: 0,
        drowsyExpression: existing, boneLayers, morphLayers, moodContact: contact, gaze, animation,
        localPhysics: owner, motionTransition: owner, behaviorMotion: owner, chatGesturePlayer: owner, bodyMotion: owner,
      }, change);
      Object.defineProperties(stage, {
        container: { get: () => touch('container') }, controls: { get: () => touch('controls') },
      });
      const originalView = stage.moodView, originalMesh = stage.mesh, originalHead = stage.head;
      const values = mesh.morphTargetInfluences!.slice(), rotation = head.quaternion.toArray(), position = head.position.toArray();
      const result = call.call(stage, delta, 0, 0, 0, false);
      assert.deepEqual(result, { headX: 0, brow: 0, eyeShape: 0, rawEye: 0, active: false }, label);
      assert.equal(stage.drowsyExpression, existing, label + ': unsupported input never allocates a new intent');
      if (existing) assert.equal(existing.active, false, label + ': prior real raw intent is reset');
      assert.deepEqual(forbidden, [], label);
      assert.equal(stage.elapsed, 12.5); assert.equal(stage.previousFrame, 3000); assert.equal(stage.modelGeneration, 7);
      assert.equal(stage.moodView, originalView); assert.equal(stage.mesh, originalMesh); assert.equal(stage.head, originalHead);
      assert.equal(stage.boneLayers, boneLayers); assert.equal(stage.morphLayers, morphLayers);
      assert.equal(stage.moodContact, contact); assert.equal(stage.gaze, gaze); assert.equal(stage.animation, animation);
      for (const key of ['localPhysics', 'motionTransition', 'behaviorMotion', 'chatGesturePlayer', 'bodyMotion']) assert.equal(stage[key], owner);
      assert.deepEqual(mesh.morphTargetInfluences, values); assert.deepEqual(head.quaternion.toArray(), rotation); assert.deepEqual(head.position.toArray(), position);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    geometry.dispose(); material.dispose(); skeleton.dispose();
  }
});
