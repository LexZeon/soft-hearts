import assert from 'node:assert/strict';
import test from 'node:test';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/fatigue';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';
import { fatigueStageFixture } from './helpers/fatigue-stage-fixture';

import { AnimationClip, Euler, Quaternion, QuaternionKeyframeTrack } from 'three';
import { NEUTRAL_FATIGUE_FRAME } from '../src/stage/fatigue-presentation';
import { ChatGesturePlayer } from '../src/stage/chat-gesture';
import { MotionTransition, captureMotionPose } from '../src/stage/motion-transition';
const fixture = fatigueStageFixture;
const setView = (h: any, token = 'old-synthetic-scope') => {
  const s = h.stage;
  s.chatGestureGeneration ??= 0; s.chatGestureIds ??= new Set(); s.chatGestureClips ??= new Map();
  s.tearsVerifiedGene = true; // Synthetic face qualification port, no real Gene admission.
  if (s.mesh.morphTargetInfluences.length === 1) s.mesh.morphTargetInfluences.push(0);
  s.blinkIndex = 1; s.moodFaceBlocked = false;
  s.setMood({ characterId: 'synthetic', token, revision: 1, developerMode: false,
    expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS), snapshot: getMoodSnapshot(createMoodState(0)), gesture: null,
    fatigue: { ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: .9, F: .8, phase: 'asleep' })), sleepEntryReady: true } });
};
const retained = (h: any) => ({ time: h.mixer.time, layers: h.stage.animation.getLayerTimes(),
  actions: h.actions.map((a: any) => ({ ref: a, time: a.time, enabled: a.enabled, paused: a.paused,
    scale: a.timeScale, loop: a.loop, repetitions: a.repetitions, weight: a.weight })) });

test('scope loss clears old sleep/contact between ticks while real manual actions retain phase and keep moving', () => {
  const h = fixture();
  try {
    setView(h); h.advance();
    assert.ok(h.stage.mesh.morphTargetInfluences[1] > .1);
    h.stage.setMoodContact({ ...EMPTY_CONTACT, contact: true });
    h.stage.speaking = true;
    const before = retained(h), view = h.stage.moodView, oldFatigue = structuredClone(view.fatigue);
    const settings = structuredClone(h.stage.settings), camera = h.stage.camera.matrixWorld.toArray();
    const renderCount = h.renders(), rafCount = h.raf();
    h.stage.invalidateMoodScope();
    assert.equal(h.stage.moodView, null); assert.deepEqual(h.stage.moodContact, EMPTY_CONTACT);
    assert.deepEqual(h.stage.fatigueFrame, NEUTRAL_FATIGUE_FRAME);
    assert.equal(h.stage.mesh.morphTargetInfluences[1], 0, 'The old closed-eyelid display is removed at dt=0.');
    assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.fatigue).phase, 'inactive');
    assert.deepEqual(retained(h), before); assert.deepEqual(view.fatigue, oldFatigue);
    assert.equal(h.stage.speaking, true); assert.deepEqual(h.stage.settings, settings);
    assert.deepEqual(h.stage.camera.matrixWorld.toArray(), camera);
    assert.equal(h.renders(), renderCount); assert.equal(h.raf(), rafCount);
    h.advance();
  } finally { h.close(); }
});

test('real outer transition and gesture unwind in order even if body cancellation reattaches physics', () => {
  const h = fixture(); let originalBody: any;
  try {
    h.stage.settings.pet.breath = 0;
    setView(h); h.advance(); h.stage.restoreLayers();
    // Neck is deliberately excluded from chat gestures; use an admitted chest.
    const s = h.stage, neck = s.mesh.skeleton.bones.find((b: any) => b.name === '上半身');
    const manual = neck.quaternion.clone(), before = retained(h);
    const player = new ChatGesturePlayer(s.mesh); s.chatGesturePlayer = player;
    const q = new Quaternion().setFromEuler(new Euler(.6, .1, 0));
    assert.equal(player.play({ id: 'old-role-overlay', strength: 1, fadeInMs: 0, fadeOutMs: 0,
      clip: new AnimationClip('old-gesture', 2, [new QuaternionKeyframeTrack(`.bones[${neck.name}].quaternion`, [0, 2], [...q.toArray(), ...q.toArray()])]) }), true);
    player.frame(.2, { blocked: false });
    const overlay = neck.quaternion.clone(); neck.quaternion.setFromEuler(new Euler(-.4, .3, 0));
    const captured = captureMotionPose(s.mesh); neck.quaternion.copy(overlay);
    const transition = new MotionTransition(s.mesh); s.motionTransition = transition;
    transition.start(captured, [`.bones[${neck.name}].quaternion`], 300); transition.frame(0);
    assert.ok(neck.quaternion.angleTo(manual) > .1);
    let attached = true; const order: string[] = [];
    s.localPhysics.restore = () => { attached = false; order.push('outer-restore'); };
    s.localPhysics.frame = (dt: number) => { assert.equal(dt, 0); attached = true; order.push('outer-frame'); };
    const cancel = player.cancel.bind(player);
    player.cancel = (options: any) => { assert.equal(attached, false); assert.equal(s.motionTransition, null); order.push('gesture-cancel'); cancel(options); };
    s.behaviorMotion = { restore() {}, stop() { assert.equal(attached, false); order.push('face-stop'); } };
    originalBody = s.bodyMotion;
    s.bodyMotion = { cancel() { assert.equal(attached, false); order.push('body-cancel'); s.localPhysics.frame(0); },
      getState: () => ({ active: false, pending: false, mode: 'closed' }), ownsProperty: () => false };
    s.invalidateMoodScope();
    assert.deepEqual(order, ['outer-restore', 'body-cancel', 'outer-frame', 'outer-restore', 'gesture-cancel', 'face-stop', 'outer-frame']);
    assert.equal(player.getState().active, false); assert.equal(transition.getState().active, false);
    assert.ok(neck.quaternion.angleTo(manual) < 1e-7, 'No old-role outer pose or gesture survives the dt=0 reconstruction.');
    assert.deepEqual(retained(h), before);
    s.behaviorMotion = null; s.bodyMotion = originalBody; player.cancel = cancel; player.dispose();
  } finally { if (originalBody) h.stage.bodyMotion = originalBody; h.close(); }
});

test('scope invalidation rejects an in-flight real gesture resolver and repeated/hidden/no-model calls remain inert', async () => {
  const h = fixture();
  try {
    setView(h); h.advance();
    const s = h.stage, cue = { id: 'late-old-role', at: Date.now(), expiresAt: Date.now() + 10_000, strength: 1 };
    s.chatGesturePlayer = new ChatGesturePlayer(s.mesh); s.chatGestureBlocked = false;
    s.moodView.snapshot.intensity.posture = 1; s.moodView.gesture = cue;
    let resolve!: (value: any) => void, requests = 0, resourceReads = 0;
    (globalThis as any).window.desktop.resolveChatGesture = () => { requests++; return new Promise(r => { resolve = r; }); };
    const pending = s.playChatGesture(cue, s.moodView.token);
    assert.equal(requests, 1);
    s.invalidateMoodScope(); const before = retained(h);
    s.hostVisible = false; s.invalidateMoodScope(); s.invalidateMoodScope();
    resolve({ get sha256() { resourceReads++; throw Error('Late resource must not be read or loaded.'); } });
    await pending;
    assert.equal(resourceReads, 0); assert.equal(s.chatGesturePlayer.getState().active, false);
    assert.deepEqual(retained(h), before); assert.equal(s.chatGestureIds.has(cue.id), true);
    s.hostVisible = true; setView(h, 'new-synthetic-scope');
    s.moodView.gesture = cue; await s.playChatGesture(cue, 'new-synthetic-scope');
    assert.equal(requests, 1, 'A consumed old cue cannot replay under the replacement scope.');
    s.moodView.gesture = null; h.advance();
    const mesh = s.mesh, animation = s.animation;
    s.mesh = null; s.animation = null; s.invalidateMoodScope(); assert.equal(s.moodView, null);
    s.mesh = mesh; s.animation = animation;
    s.disposed = true; const serial = s.chatGestureGeneration; s.invalidateMoodScope(); assert.equal(s.chatGestureGeneration, serial);
    s.chatGesturePlayer.dispose();
  } finally { h.close(); }
});
