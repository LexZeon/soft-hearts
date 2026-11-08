import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Euler, PerspectiveCamera, Quaternion, ShaderMaterial, Skeleton, SkinnedMesh, UniformsUtils, Vector3 } from 'three';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import type { BlushAnchors } from '../src/stage/procedural-blush';
import { MmdStage } from '../src/stage/MmdStage';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/blush';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/fatigue';
import { deriveModelCapabilities, type CapabilityChoice, type ModelCapabilityId } from '../shared/model-capability';
import type { ModelProfile } from '../shared/model-profile';

/**
 * I-024 舞台: a synthetic non-Gene model (no real model, no Electron). Morph 0 = blink, 1 = あ, 2 = its own
 * blush (照れ), 3 = an unrelated morph. The card comes from the real contract (deriveModelCapabilities).
 */
const BLINK = 0, MOUTH = 1, SHY = 2, JITOME = 4, SAD = 5;
const BASE = [0, 0, 0.07, 0.3, 0, 0];
const DT = 1 / 30;

function profileOf(parts: { blink?: boolean; shy?: boolean; mouth?: boolean; neck?: boolean; drowsy?: boolean; eyes?: boolean } = {}): ModelProfile {
  const { blink = true, shy = true, mouth = true, neck = true, drowsy = false, eyes = false } = parts;
  const morphs: Record<string, { index: number; name: string; policy: string }> = {};
  if (blink) morphs.blink = { index: BLINK, name: 'まばたき', policy: 'closure' };
  if (mouth) morphs.a = { index: MOUTH, name: 'あ', policy: 'amplitude' };
  if (shy) morphs.shy = { index: SHY, name: '照れ', policy: 'overlay' };
  if (drowsy) { morphs.jitome = { index: JITOME, name: 'じと目', policy: 'closure' }; morphs.sad = { index: SAD, name: '困る', policy: 'amplitude' }; }
  const map: Record<string, { index: number; name: string }> = { head: { index: 3, name: '頭' } };
  if (neck) map.neck = { index: 2, name: '首' };
  if (eyes) { map.eyeLeft = { index: 4, name: '左目' }; map.eyeRight = { index: 5, name: '右目' }; }
  return { morphs, bones: { map } } as unknown as ModelProfile;
}
const card = (profile = profileOf(), choices: Partial<Record<ModelCapabilityId, CapabilityChoice>> = {}) => deriveModelCapabilities(profile, choices);
const fatigue = (phase: FatiguePhase) => ({ ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: .9, F: .8, phase })), sleepEntryReady: true });

function harness(options: { gene?: boolean; profile?: ModelProfile; phase?: FatiguePhase | null; mood?: boolean; noProfile?: boolean } = {}) {
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage, { surprisePending: null, surprisePreview: null });
  const names = ['センター', '上半身', '首', '頭'];
  const bones = names.map(name => { const bone = new Bone(); bone.name = name; bone.position.set(0, name === 'センター' ? 8 : 2, 0); return bone; });
  for (let i = 1; i < bones.length; i++) bones[i - 1].add(bones[i]);
  const mesh = new SkinnedMesh(); mesh.add(bones[0]); mesh.updateMatrixWorld(true);
  mesh.morphTargetInfluences = [...BASE];
  mesh.bind(new Skeleton(bones));
  const [center, chest, neck, head] = bones;
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000);
  camera.position.set(0, 10, 35); camera.lookAt(0, 10, 0); camera.updateMatrixWorld(true);
  const profile = options.profile ?? profileOf();
  const snapshot = getMoodSnapshot(createMoodState(0));
  Object.assign(stage, { mesh, head, chest, center, eyes: [], arms: [], camera, controls: { interacting: false }, hostVisible: true, disposed: false,
    hasRenderedModel: true, renderer: { domElement: { dataset: {} } }, container: { clientWidth: 400, clientHeight: 560 }, height: 20,
    settings: { pet: { breath: 0, followMouse: true } }, pointer: { x: 0, y: 0 }, gaze: { x: 0, y: 0 }, eyeGaze: { x: 0, y: 0 },
    gazeOrigin: new Vector3(), eyePoint: new Vector3(), facePoint: new Vector3(), elapsed: 0, nextBlink: Infinity, blinkStart: -10, naturalBlink: 0, mouth: 0,
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodFaceBlocked: false, moodHeadBlocked: false, moodMouthBlocked: false,
    moodView: options.mood === false ? null : { characterId: 'i024-synthetic', token: 'i024-token', expressions: true, parameters: structuredClone(DEFAULT_MOOD_PARAMETERS),
      snapshot: { ...snapshot, intensity: { ...snapshot.intensity, posture: 50, expression: 50 } },
      ...(options.phase === null ? {} : { fatigue: fatigue(options.phase ?? 'awake') }) },
    boneLayers: [], morphLayers: [], restPose: bones.map(bone => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() })),
    rotation: new Euler(), offset: new Quaternion(), speaking: false,
    blinkIndex: options.profile && !(options.profile.morphs as any).blink ? -1 : BLINK, mouthIndex: MOUTH, smileIndex: -1, sadIndex: (profile.morphs as any).sad?.index ?? -1, blushChannel: null, proceduralBlush: null,
    tearsVerifiedGene: options.gene === true, modelUrl: '', blushCalibrationModelUrl: '', blushCalibration: structuredClone(DEFAULT_BLUSH_CALIBRATION),
    modelProfile: options.noProfile ? null : { profile, scales: new Map(), links: new Map(), linkedMorphs: [], bone: (slot: string) => slot === 'neck' ? neck : slot === 'head' ? head : undefined },
  });
  const frame = (dt = DT) => { stage.restoreLayers(); stage.elapsed += dt; stage.animateIdle(dt); stage.updateTears(dt); stage.animateMood(dt); };
  const run = (seconds: number, each?: () => void) => { for (let i = 0; i < Math.round(seconds / DT); i++) { frame(); each?.(); } };
  const phase = (value: FatiguePhase) => { stage.moodView = { ...stage.moodView, fatigue: fatigue(value) }; };
  return { stage, mesh, head, neck, frame, run, phase };
}
const blink = (h: ReturnType<typeof harness>) => h.mesh.morphTargetInfluences![BLINK];
const headAngle = (h: ReturnType<typeof harness>) => h.head.quaternion.angleTo(new Quaternion());

test('非 Gene + 能闭眼: the drowsy eyelids close by phase on the profile blink morph', () => {
  const h = harness(); h.stage.setModelCapabilities(card());
  const levels: [FatiguePhase, number][] = [['light-drowsy', .10], ['drowsy', .24], ['falling-asleep', .45], ['asleep', .98], ['micro-awake', .80]];
  for (const [value, level] of levels) {
    h.phase(value); h.run(3);
    assert.ok(Math.abs(blink(h) - level) < 0.02, `${value}: ${blink(h)} ≈ ${level}`);
  }
  h.phase('awake'); h.run(3);
  assert.ok(blink(h) < 0.01, 'opens again when awake');
  assert.match(JSON.parse(h.stage.renderer.domElement.dataset.fatigue).reason, /model-card/);
});

test('疲倦眼皮 stays off with no profile and no card, with 能闭眼 off, and when the model has no blink; a touch still moves the lids', () => {
  const bare = harness({ phase: 'asleep', noProfile: true }); bare.run(3);
  assert.equal(blink(bare), 0, 'nothing known about the model: nothing new');
  const off = harness({ phase: 'asleep' }); off.stage.setModelCapabilities(card(profileOf(), { closeEyes: 'off' })); off.run(3);
  assert.equal(blink(off), 0);
  const none = harness({ phase: 'asleep', profile: profileOf({ blink: false }) }); none.stage.setModelCapabilities(card(profileOf({ blink: false })));
  none.run(3); assert.equal(none.stage.fatigueFrame.eyelids, 0);
  const touched = harness({ phase: 'asleep' }); touched.stage.setModelCapabilities(card()); touched.run(3);
  const closed = blink(touched);
  touched.stage.moodContact = { ...EMPTY_CONTACT, contact: true }; touched.run(1.5);
  assert.ok(blink(touched) < closed && closed - blink(touched) < 0.06, 'the small touched stir is kept');
});

test('with no card from outside the stage derives its own from the profile; a card set later replaces it', () => {
  const h = harness({ phase: 'asleep' }); h.run(8);
  assert.ok(blink(h) > 0.95, `eyelids close by the derived card: ${blink(h)}`);
  const lowered = headAngle(h);
  h.stage.restoreLayers();
  assert.ok(lowered > 0.1 && headAngle(h) === 0, 'the derived card shows the sleep pose too (as a restored layer)');
  h.stage.setModelCapabilities(card(profileOf(), { closeEyes: 'off', sleepPose: 'off' })); h.run(4);
  assert.ok(blink(h) < 0.01, 'the host card (the user turned it off) wins');
  h.stage.setModelCapabilities(null); h.run(4);
  assert.ok(blink(h) > 0.95, 'null: back to the derived card');
  assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.fatigue).automaticSleepPose, 'shown');
});

test('the reviewed Gene keeps its eyelids without a card; only an explicit 关 turns them off', () => {
  const gene = harness({ gene: true, phase: 'asleep' }); gene.run(3);
  assert.ok(blink(gene) > 0.95, 'unchanged reviewed behaviour');
  const enabled = harness({ gene: true, phase: 'asleep' }); enabled.stage.setModelCapabilities(card()); enabled.run(3);
  assert.ok(Math.abs(blink(enabled) - blink(gene)) < 1e-9, 'a card does not change the reviewed amounts');
  const off = harness({ gene: true, phase: 'asleep' }); off.stage.setModelCapabilities(card(profileOf(), { closeEyes: 'off' })); off.run(3);
  assert.equal(blink(off), 0);
});

test('非 Gene + 能脸红: the model\'s own blush morph (shy slot) replaces the procedural blush; Gene keeps procedural', () => {
  const blushing = (h: ReturnType<typeof harness>) => {
    h.stage.moodView.snapshot.blush = { id: 'affection', at: 0, until: 3450, strength: 1, reason: 'semantic', ageMs: 700, amount: 0.35, profile: DEFAULT_MOOD_PARAMETERS.blush };
  };
  const procedural = () => { const calls: number[] = []; return { calls, disposed: 0, update(amount: number) { calls.push(amount); }, getState: () => ({ supported: true, reason: '' }), dispose() { this.disposed++; } }; };
  const h = harness(); const fake = procedural(); h.stage.proceduralBlush = fake;
  h.stage.setModelCapabilities(card());
  assert.equal(h.stage.proceduralBlush, null, 'procedural blush is put away for the model\'s own');
  assert.equal(fake.disposed, 1);
  blushing(h); h.frame();
  assert.ok(h.mesh.morphTargetInfluences![SHY] > 0.3, `shy morph written: ${h.mesh.morphTargetInfluences![SHY]}`);
  assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.moodFeedback).blushPath, 'morph');
  h.stage.restoreLayers(); assert.equal(h.mesh.morphTargetInfluences![SHY], BASE[SHY], 'restored to its own base');
  h.stage.moodFaceBlocked = true; h.frame(); assert.equal(h.mesh.morphTargetInfluences![SHY], BASE[SHY], 'a picked expression owns the face');
  assert.match(h.stage.getMoodDegradation(), /模型自身的脸红/);

  const off = harness(); off.stage.setModelCapabilities(card(profileOf(), { blush: 'off' })); blushing(off); off.frame();
  assert.equal(off.mesh.morphTargetInfluences![SHY], BASE[SHY], '关 is off');

  const gene = harness({ gene: true }); const reviewed = procedural(); gene.stage.proceduralBlush = reviewed;
  gene.stage.setModelCapabilities(card()); blushing(gene); gene.frame();
  assert.equal(gene.stage.proceduralBlush, reviewed, 'Gene keeps the procedural blush');
  assert.ok(reviewed.calls.at(-1)! > 0.3);
  assert.equal(gene.mesh.morphTargetInfluences![SHY], BASE[SHY], 'and never the morph');
});

/** Two identical stages, one with the sleep layer: their difference is the layer alone (gaze, mood sway and lids run in both). */
function twin(phase: FatiguePhase, choices: Partial<Record<ModelCapabilityId, CapabilityChoice>> = {}) {
  const h = harness({ phase }), base = harness({ phase });
  h.stage.setModelCapabilities(card(profileOf(), choices)); base.stage.setModelCapabilities(card(profileOf(), { ...choices, sleepPose: 'off' }));
  return { h, base,
    run(seconds: number, each?: () => void) { for (let i = 0; i < Math.round(seconds / DT); i++) { h.frame(); base.frame(); each?.(); } },
    phase(value: FatiguePhase) { h.phase(value); base.phase(value); },
    set(values: Record<string, unknown>) { Object.assign(h.stage, values); Object.assign(base.stage, values); },
    head: () => h.head.quaternion.angleTo(base.head.quaternion), neck: () => h.neck.quaternion.angleTo(base.neck.quaternion) };
}

test('睡姿: a separate layer on neck and head while asleep, only with the card, giving way to a picked head motion', () => {
  const t = twin('asleep'); t.run(8);
  assert.ok(t.head() > 0.12 && t.neck() > 0.08, `head lowered over neck and head: ${t.head()} ${t.neck()}`);
  const lowered = new Euler().setFromQuaternion(t.h.head.quaternion.clone().premultiply(t.base.head.quaternion.clone().invert()), 'YXZ');
  assert.ok(lowered.x > 0.1, 'chin down');
  t.h.stage.restoreLayers();
  assert.equal(headAngle(t.h), 0, 'the PMX rest pose is untouched: the layer is restored every frame');
  const none = harness({ phase: 'asleep', noProfile: true }), bare = harness({ phase: 'asleep' });
  bare.stage.setModelCapabilities(card(profileOf(), { sleepPose: 'off' }));
  for (let i = 0; i < 240; i++) { none.frame(); bare.frame(); }
  assert.equal(none.head.quaternion.angleTo(bare.head.quaternion), 0, 'no profile and no card: nothing new');
  // A picked motion that moves the head owns it: the layer gives way smoothly.
  t.run(DT);
  let last = t.head(), step = 0;
  t.set({ moodHeadBlocked: true, bodyManualPose: true });
  t.run(3, () => { step = Math.max(step, Math.abs(t.head() - last)); last = t.head(); });
  assert.ok(t.head() < 1e-6, `given way: ${t.head()}`); assert.ok(step < 0.02, `no jump: ${step}`);
  t.set({ moodHeadBlocked: false, bodyManualPose: false }); t.run(4);
  assert.ok(t.head() > 0.12, 'and comes back');
});

test('睡姿 wakes slowly back to upright with one blink through the eyelid compositor', () => {
  const t = twin('asleep'); t.run(8);
  t.phase('awake');
  const values: number[] = []; let last = t.head(), step = 0;
  t.run(8, () => { values.push(blink(t.h)); step = Math.max(step, Math.abs(t.head() - last)); last = t.head(); });
  assert.ok(step < 0.01, `slow lift: ${step}`);
  assert.ok(t.head() < 1e-9 && t.neck() < 1e-9, 'upright again');
  // The lids open first (0.98 → 0), then one blink closes them fully and opens again.
  const rises = values.filter((value, i) => i > 0 && value > 0.5 && values[i - 1] <= 0.5).length;
  assert.equal(rises, 1, 'exactly one wake blink');
  const open = values.findIndex(value => value < 0.1);
  assert.ok(Math.max(...values.slice(open)) > 0.9, 'a full blink from open lids');
  assert.ok(values.at(-1)! < 1e-3);
});
test('previewCapability: false when the model cannot or the stage is not ready', () => {
  const h = harness();
  assert.equal(harness({ noProfile: true }).stage.previewCapability('closeEyes'), false, 'nothing known about the model yet');
  h.stage.setModelCapabilities(card(profileOf({ shy: false }), { mouth: 'off' }));
  assert.equal(h.stage.previewCapability('blush'), false, 'not detected');
  assert.equal(h.stage.previewCapability('mouth'), false, 'user turned it off');
  assert.equal(h.stage.previewCapability('gesture'), false, 'no arms on this model');
  assert.equal(h.stage.previewCapability('tears' as any), false);
  h.stage.hasRenderedModel = false; assert.equal(h.stage.previewCapability('closeEyes'), false, 'not rendered yet');
  h.stage.hasRenderedModel = true; h.stage.hostVisible = false; assert.equal(h.stage.previewCapability('closeEyes'), false, 'hidden');
  h.stage.hostVisible = true; h.stage.moodFaceBlocked = true; assert.equal(h.stage.previewCapability('closeEyes'), false, 'a picked face owns the lids');
  h.stage.moodFaceBlocked = false; h.stage.mesh = null; assert.equal(h.stage.previewCapability('closeEyes'), false, 'no model');
});

test('previewCapability shows each one once and puts everything back', () => {
  // Same stage twice; only `h` is asked to preview. At the end both must match again.
  const h = harness(), base = harness();
  h.stage.setModelCapabilities(card()); base.stage.setModelCapabilities(card());
  const run = (seconds: number, each?: () => void) => { for (let i = 0; i < Math.round(seconds / DT); i++) { h.frame(); base.frame(); each?.(); } };
  const peak = (index: number, seconds: number) => { let max = 0; run(seconds, () => { max = Math.max(max, h.mesh.morphTargetInfluences![index]); }); return max; };
  run(0.5);

  assert.equal(h.stage.previewCapability('closeEyes'), true);
  assert.equal(h.stage.previewCapability('closeEyes'), true, 'asking again while it shows is fine');
  assert.ok(peak(BLINK, 1.5) > 0.98, 'eyes closed'); run(1.5);
  assert.ok(blink(h) < 1e-3, 'and open again');

  assert.equal(h.stage.previewCapability('mouth'), true);
  assert.ok(peak(MOUTH, 0.6) > 0.5, 'あ'); run(0.5);
  assert.ok(h.mesh.morphTargetInfluences![MOUTH] < 1e-3);

  assert.equal(h.stage.previewCapability('blush'), true);
  assert.ok(peak(SHY, 2) > 0.6, 'blushes with its own morph'); run(0.3);
  assert.equal(h.mesh.morphTargetInfluences![SHY], BASE[SHY]);

  assert.equal(h.stage.previewCapability('sleepPose'), true);
  let maxHead = 0; run(3, () => { maxHead = Math.max(maxHead, h.head.quaternion.angleTo(base.head.quaternion)); });
  assert.ok(maxHead > 0.12, `sleep pose shown: ${maxHead}`);
  assert.ok(blink(h) > 0.9, 'eyes closed in the sleep pose');
  const values: number[] = []; run(8, () => values.push(blink(h)));
  assert.equal(values.filter((value, i) => i > 0 && value > 0.5 && values[i - 1] <= 0.5).length, 1, 'wakes with one blink');

  h.mesh.morphTargetInfluences!.forEach((value, i) => assert.ok(Math.abs(value - base.mesh.morphTargetInfluences![i]) < 1e-3, `morph ${i} back: ${value}`));
  assert.ok(h.head.quaternion.angleTo(base.head.quaternion) < 1e-6 && h.neck.quaternion.angleTo(base.neck.quaternion) < 1e-6, 'head and neck back');
  h.stage.restoreLayers(); assert.equal(headAngle(h), 0); assert.deepEqual(h.mesh.morphTargetInfluences, BASE, 'the model itself never changed');
});
test('degradation notes follow the card instead of "only the reviewed Gene"', () => {
  const h = harness({ phase: 'asleep', noProfile: true });
  assert.doesNotMatch(h.stage.getMoodDegradation(), /仅适配已审核 Gene/);
  assert.match(h.stage.getMoodDegradation(), /体检/);
  h.stage.setModelCapabilities(card()); h.run(1);
  assert.doesNotMatch(h.stage.getMoodDegradation(), /疲倦|睡姿/);
  h.stage.setModelCapabilities(card(profileOf(), { closeEyes: 'off', sleepPose: 'off' }));
  assert.match(h.stage.getMoodDegradation(), /关了/);
});

test('困的脸 on another model: half lids and troubled brows through its own profile slots, never Gene indices', () => {
  const profile = profileOf({ drowsy: true });
  const h = harness({ phase: 'drowsy', profile }); h.stage.setModelCapabilities(card(profile)); h.run(3);
  const influences = h.mesh.morphTargetInfluences!;
  assert.ok(influences[JITOME] > 0.03, `half lids on the jitome slot: ${influences[JITOME]}`);
  assert.ok(influences[SAD] > 0.02, `troubled brows on the sad slot: ${influences[SAD]}`);
  assert.equal(influences.length, BASE.length, 'no write to a raw Gene index (95, 68) on this model');
  assert.equal(JSON.parse(h.stage.renderer.domElement.dataset.drowsyExpression).source, 'model-card');
  h.phase('awake'); h.run(3);
  assert.ok(influences[JITOME] < 2e-3 && influences[SAD] < 2e-3, `eases back out when awake (the reviewed easing): ${influences[JITOME]} ${influences[SAD]}`);
  for (const choice of [null, 'off'] as const) {
    const off = harness({ phase: 'drowsy', profile, noProfile: choice === null });
    if (choice) off.stage.setModelCapabilities(card(profile, { drowsyFace: 'off' })); off.run(3);
    assert.equal(off.mesh.morphTargetInfluences![JITOME], 0, `${choice}: off`);
  }
  assert.match(harness({ phase: 'drowsy', profile, noProfile: true }).stage.getMoodDegradation(), /困的脸/);
});

test('试一下 困的脸 and 能流泪 show once on their own clocks', () => {
  const profile = profileOf({ drowsy: true, eyes: true });
  const h = harness({ profile }); h.stage.setModelCapabilities(card(profile));
  assert.equal(h.stage.previewCapability('tears'), false, 'no tear surface on this model yet');
  const updates: [number, number][] = [];
  h.stage.proceduralTears = { update(amount: number, ms: number) { updates.push([amount, ms]); }, getState: () => ({ supported: true, reason: 'spy', amount: 0, elapsedMs: 0 }), dispose() {} };
  assert.equal(h.stage.previewCapability('tears'), true);
  assert.equal(h.stage.previewCapability('drowsyFace'), true);
  let jitome = 0; h.run(2.4, () => { jitome = Math.max(jitome, h.mesh.morphTargetInfluences![JITOME]); });
  assert.ok(jitome > 0.05, `drowsy face shown: ${jitome}`);
  assert.ok(Math.max(...updates.map(([amount]) => amount)) > 0.8, 'tears shown');
  const clock = updates.filter(([amount]) => amount > 0).map(([, ms]) => ms);
  assert.ok(clock.every((ms, i) => i === 0 || ms > clock[i - 1]), 'the trail grows on the preview clock');
  h.run(4);
  assert.equal(updates.at(-1)![0], 0, 'tears gone'); assert.ok(h.mesh.morphTargetInfluences![JITOME] < 2e-3, 'drowsy face gone');
});
test('能流泪 on another model: placed only with the card and found face anchors; turning it off restores the material', () => {
  const anchors: BlushAnchors = {
    leftEye: [-0.5, 1, 1], rightEye: [0.5, 1, 1], mouth: [0, 0.1, 1], leftCheek: [-0.5, 0.5, 1], rightCheek: [0.5, 0.5, 1],
    leftNormal: [0, 0, 1], rightNormal: [0, 0, 1], forward: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0],
    eyeDistance: 1, boneEyeDistance: 1, eyeReference: 'main-eye-geometry', mouthEstimated: true, surfaceSource: 'named-face', materialIndices: [0],
  };
  const profile = profileOf({ shy: false, eyes: true });
  const make = (found: BlushAnchors | null, profileless = false) => {
    const stage = Object.create(MmdStage.prototype) as any, head = new Bone(); head.name = '頭';
    const material = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) });
    material.name = '顔';
    const mesh = new SkinnedMesh(undefined, material); mesh.add(head); mesh.bind(new Skeleton([head])); mesh.morphTargetInfluences = [0];
    Object.assign(stage, { mesh, head, hostVisible: true, disposed: false, renderer: { domElement: { dataset: {} } }, tearsVerifiedGene: false,
      tearsAnchorsProbed: true, tearsAnchors: found && structuredClone(found), proceduralTears: null, cryingFrame: null, modelProfile: profileless ? null : { profile } });
    return { stage, mesh, material };
  };
  const none = make(anchors, true); none.stage.rebuildTears();
  assert.equal(none.stage.proceduralTears ?? null, null, 'nothing known about the model: still the reviewed Gene only');
  assert.match(none.stage.tearsReason, /泪水.*主进程.*Gene/);
  const on = make(anchors); on.stage.rebuildTears(); // as at model load, with the card derived from its profile
  assert.equal(on.stage.proceduralTears?.getState().supported, true, on.stage.tearsReason);
  const placed = on.stage.proceduralTears;
  on.stage.setModelCapabilities(card(profile));
  assert.equal(on.stage.proceduralTears, placed, 'the same answer from the host card: nothing rebuilt');
  assert.equal(on.stage.proceduralTears.getState().attached, true);
  assert.notEqual(on.mesh.material, on.material, 'the face material is wrapped (a clone), never edited');
  assert.match(on.stage.tearsReason, /模型体检卡/);
  on.stage.setModelCapabilities(card(profile, { tears: 'off' }));
  assert.equal(on.stage.proceduralTears, null); assert.equal(on.mesh.material, on.material, '关: the original material is back');
  assert.match(on.stage.tearsReason, /关了"能流泪"/);
  const lost = make(null); lost.stage.rebuildTears();
  assert.equal(lost.stage.proceduralTears ?? null, null, 'face anchors not found: stays off');
  assert.match(lost.stage.tearsReason, /双眼展示位置/);
});