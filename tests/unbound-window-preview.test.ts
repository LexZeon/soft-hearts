// I-154 batch 7 (docs/claude/2026-11-20-unbound-window-batch7.md): the window engine as the control window's preview, 试一下 and the diagnostics.
//  - the safety line: the preview gets two narrow ports (no sense, no Unbound, no companion write); the companion window gets no grants;
//  - 试一下: the old stage's gates on the window's state; the envelopes reach her lids, blush, mouth, sleep pose, wave, drowsy face, tears;
//  - the authoring previews: the host's receipts as on the old stage; a personal pose and an expression composition ease in and out on the
//    real Gene frame loop at 60 and 30 fps (measured against the same preview put on at once);
//  - the diagnostics: the glitch watch's names and kinds, the stray watch's reach widened by the props.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, PerspectiveCamera, Scene, Vector3 } from 'three';
import { createWindowStage } from '../src/unbound/window-mode';
import { announceWindowStyle, watchWindowStyle } from '../src/unbound/window-mode/window-style';
import { WindowPhysics } from '../src/unbound/window-mode/window-physics';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { WINDOW_PREVIEW_GRANT_METHODS, WINDOW_PREVIEW_HOST_METHODS, windowPreviewGrants, windowPreviewStageHost } from '../src/unbound/window-mode/preview-port';
import { WindowStageNotYet } from '../src/unbound/window-mode/not-yet';
import { WindowStagePreviews } from '../src/unbound/window-mode/window-stage-previews';
import { STAGE_SURFACE_MEMBERS } from '../src/stage/stage-surface';
import { WindowCapabilityPreviews, previewClosure, previewMouth, windowCapabilityPossible, withWave, type WindowCapabilityContext } from '../src/unbound/window-mode/window-capability';
import { EasedWeight, WindowBodyPreview, WindowVisualPreview, type WindowPreviewStage } from '../src/unbound/window-mode/window-previews';
import { bodyPreviewBlocked, visualPreviewBlocked } from '../src/unbound/window-mode/window-preview-mode';
import { VISIBLE_BONES, WindowDiagnostics, widenReach, windowActivities } from '../src/unbound/window-mode/window-diagnostics';
import { WindowMotions, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { NO_MOTION_BLOCKS, slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { WindowLiveliness } from '../src/unbound/window-mode/window-liveliness';
import { WindowReactions } from '../src/unbound/window-mode/window-reactions';
import { loadLivelinessForEngine } from '../src/stage';
import { StageModelProfile } from '../src/stage/model-profile';
import { readPoseReactionView } from '../shared/mood';
import { EXPRESSION_GENE_SHA, EXPRESSION_MASK, EXPRESSION_QUALIFICATION, type ExpressionPreview } from '../shared/actions/expression-composition';
import { VISUAL_GENE_SHA } from '../shared/stage/personalize-visual';
import type { BodyPosePreview } from '../shared/stage';
import { card, faceView, syntheticRig } from './helpers/window-face-fixture';
import { frameSteps, surprises, windowGene } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';

const REPORT = process.env.WINDOW_BATCH7_REPORT === '1';
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const memory = (initial?: string) => { const map = new Map<string, string>(); if (initial !== undefined) map.set('soft-hearts.window-engine.v1', initial); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };

// ---- the safety line ------------------------------------------------------------------------------------------------------------

/** The control window's preload as far as this matters: every sense and how it is switched, Unbound's way out, the companion's write, the grants. */
function fakeControlPreload() {
  const senses = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };
  const touched: string[] = [];
  const turnOn = () => { for (const key of Object.keys(senses) as (keyof typeof senses)[]) senses[key] = true; };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    isBehaviorModelSupported: async () => true, resolveChatGesture: async () => null, resolveHerAction: async () => null, resolveBehaviorMotion: async () => null,
    resolveHerLifeMotion: async () => null, reportHerAction: async () => {}, getBehaviorBodyPlan: async () => null, resolveBehaviorBody: async () => null,
    visualPreviewReceipt: async () => {}, resolveVisualPreview: async () => null, resolveExpressionPreview: async () => null, bodyPreviewReceipt: async () => {},
    resolveBodyPreview: async () => null, previewMotion: async () => null, getModelProfile: async () => null, saveMotionFits: async () => true,
    setRuntimeState: async () => { turnOn(); }, setPerception: async () => { turnOn(); }, setVoiceInput: async () => { senses.microphone = true; },
    startScreenShare: async () => { senses.screen = true; }, setSystemAudio: async () => { senses.listen = true; }, setFaceCheck: async () => { senses.face = true; },
    setPoseSensing: async () => { senses.camera = true; }, toggleUnbound: async () => { turnOn(); return 'entering'; }, setUnbound: async () => { turnOn(); return {}; },
    saveSettings: async () => {}, userGaze: async () => null,
  };
  const desktop = new Proxy(methods, { get(target, key) { if (typeof key === 'string') touched.push(key); return target[key as string]; } });
  return { desktop: desktop as never, senses, touched };
}

test('safety: the control window\'s preview on the window engine switches no sense and reaches only its named reads and grants, never the companion\'s write', async () => {
  const { desktop, senses, touched } = fakeControlPreload();
  const before = structuredClone(senses);
  let ports: { host: object; grants: object | null } | null = null;
  // The engine, as carelessly as code can be: every function on both ports is called.
  createWindowStage({ isPet: false, storage: memory(), desktop }, (host, _style, grants) => { // no-pet-ok: createWindowStage's isPet is the existing companion-window flag
    ports = { host, grants };
    for (const value of [...Object.values(host), ...Object.values(grants ?? {})]) if (typeof value === 'function') void Promise.resolve((value as () => unknown)()).catch(() => {});
    return null;
  });
  await settle();
  assert.ok(ports, 'the preview was made on the window engine');
  assert.deepEqual(senses, before, 'no sense was switched');
  const allowed = [...WINDOW_PREVIEW_HOST_METHODS, ...WINDOW_PREVIEW_GRANT_METHODS] as string[];
  assert.deepEqual([...new Set(touched)].filter(name => !allowed.includes(name)), [], 'nothing else of the preload was reached (not the companion\'s report, not the body plan)');
  for (const name of allowed) assert.ok(!/perception|screen|voice|audio|face|pose|unbound|runtime|gaze|settings/i.test(name.replace('BehaviorModel', '')), `${name} is not a sense or a way out`);
  await (desktop as Record<string, () => Promise<unknown>>).setRuntimeState();
  assert.notDeepEqual(senses, before, 'the fake is live (the check above can fail)');
});

test('safety: both preview ports are new frozen objects; the companion\'s write stays inside; the body plan is refused', async () => {
  const { desktop, touched } = fakeControlPreload();
  const host = windowPreviewStageHost(desktop), grants = windowPreviewGrants(desktop);
  assert.notEqual(host, desktop); assert.notEqual(grants, desktop);
  assert.ok(Object.isFrozen(host) && Object.isFrozen(grants));
  assert.deepEqual(Object.keys(grants), [...WINDOW_PREVIEW_GRANT_METHODS]);
  assert.equal(await host.isBehaviorModelSupported(), true);
  await host.reportHerAction({ cueId: 'x', status: 'played', missing: [], detail: '' } as never);
  await assert.rejects(host.getBehaviorBodyPlan('t'));
  await assert.rejects(host.resolveBehaviorBody('c', 't'));
  assert.ok(!touched.includes('reportHerAction') && !touched.includes('getBehaviorBodyPlan') && !touched.includes('resolveBehaviorBody'));
});

test('the not-yet list is empty since batch 7; the previews\' members answer the last stage surface members', () => {
  assert.deepEqual(Object.getOwnPropertyNames(WindowStageNotYet.prototype).filter(name => name !== 'constructor'), []);
  const previews = Object.getOwnPropertyNames(WindowStagePreviews.prototype).filter(name => name !== 'constructor');
  for (const name of ['previewCapability', 'previewVisual', 'cancelVisualPreview', 'previewBody', 'cancelBodyPreview', 'cancelSurprisePreview', 'captureCharacterAvatar',
    'captureCharacterStickerReference']) assert.ok(previews.includes(name), `${name} is answered by the previews' members`);
  for (const name of previews) assert.ok((STAGE_SURFACE_MEMBERS as readonly string[]).includes(name), `${name} is a stage surface member`);
});

// ---- 试一下 ------------------------------------------------------------------------------------------------------------------------

const FREE: WindowCapabilityContext = { ready: true, card: card(['closeEyes', 'blush', 'mouth', 'sleepPose', 'gesture', 'drowsyFace', 'tears']), faceBlocked: false,
  mouthBlocked: false, lids: true, mouth: true, mood: true, blush: true, head: true, headOwned: false, drowsy: true, tears: true, free: true };

test('试一下: the old stage\'s gates (card, drawn, the part owned now); asking again keeps it going; a new model or hiding drops it', () => {
  const previews = new WindowCapabilityPreviews(), owner = {};
  assert.equal(previews.start('closeEyes', owner, { ...FREE, card: card([]) }), false, 'the card has it off');
  assert.equal(previews.start('closeEyes', owner, { ...FREE, card: card(['closeEyes'], { closeEyes: 'off' }) }), false, 'the user turned it off');
  assert.equal(previews.start('closeEyes', owner, { ...FREE, ready: false }), false, 'not drawn yet');
  assert.equal(previews.start('closeEyes', null, FREE), false, 'no model');
  assert.equal(previews.start('nonsense', owner, FREE), false);
  assert.equal(previews.start('closeEyes', owner, { ...FREE, faceBlocked: true }), false, 'a picked expression owns her face');
  assert.equal(windowCapabilityPossible('mouth', { ...FREE, mouthBlocked: true }), false);
  assert.equal(windowCapabilityPossible('sleepPose', { ...FREE, headOwned: true }), false);
  assert.equal(windowCapabilityPossible('gesture', { ...FREE, free: false }), false);
  assert.equal(windowCapabilityPossible('blush', { ...FREE, mood: false }), false);
  assert.equal(windowCapabilityPossible('tears', { ...FREE, tears: false }), false);
  assert.equal(windowCapabilityPossible('drowsyFace', { ...FREE, drowsy: false }), false);
  assert.equal(previews.start('closeEyes', owner, FREE), true);
  for (let i = 0; i < 30; i++) previews.frame(1 / 60, owner);
  const mid = previews.now.closure;
  assert.equal(previews.start('closeEyes', owner, FREE), true, 'showing: true, not restarted');
  previews.frame(1 / 60, owner);
  assert.ok(previews.now.closure >= mid - 1e-9, 'asking again did not drop it to zero');
  previews.frame(1 / 60, {});
  assert.equal(previews.active, false, 'a new model drops it');
  assert.equal(previews.start('blush', owner, FREE), true); previews.clear();
  assert.equal(previews.active, false);
});

test('试一下: every envelope rises and falls smoothly to exactly 0 at 60 and 30 fps (lids, blush, mouth, tears); the wave is one cue', () => {
  for (const fps of [60, 30]) {
    const previews = new WindowCapabilityPreviews(), owner = {};
    for (const id of ['closeEyes', 'blush', 'mouth', 'tears', 'gesture', 'drowsyFace', 'sleepPose'] as const) assert.equal(previews.start(id, owner, FREE), true, id);
    const series: Record<string, number[]> = { closure: [], blush: [], mouth: [], tears: [] };
    const waves = new Set<string>();
    for (let i = 0; i < fps * 6; i++) {
      const frame = previews.frame(1 / fps, owner);
      for (const key of Object.keys(series)) series[key].push((frame as unknown as Record<string, number>)[key]);
      if (frame.wave) waves.add(frame.wave.id);
    }
    for (const [key, values] of Object.entries(series)) {
      const steps = values.slice(1).map((v, i) => Math.abs(v - values[i]));
      assert.ok(max(values) > 0.5, `${key} shows`);
      // 有口型 is a quick あ (0.12 s rise, the old stage's shape): continuous, but quicker than the rest.
      assert.ok(max(steps) < (key === 'mouth' ? (fps === 60 ? 0.16 : 0.3) : fps === 60 ? 0.11 : 0.22), `${key} ${fps} fps step ${max(steps).toFixed(3)}`);
      assert.equal(values.at(-1), 0, `${key} ends at 0`);
    }
    assert.equal(waves.size, 1, 'one wave cue');
    assert.equal(previews.active, false);
  }
});

test('试一下 on her face: 能闭眼 holds her lids, 能脸红 lifts the blush, 有口型 takes the mouth through the snack channel, 困的脸 holds the drowsy phase', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setCard(card(['closeEyes', 'blush', 'mouth', 'drowsyFace'])); face.setMood(faceView({ primary: 'calm', companion: null }));
  face.setPainted(false); // her own blush morph (the synthetic rig's), not the paint
  const previews = new WindowCapabilityPreviews(), owner = {};
  previews.start('closeEyes', owner, FREE); previews.start('blush', owner, FREE); previews.start('mouth', owner, FREE); previews.start('drowsyFace', owner, FREE);
  let lids = 0, blush = 0, mouth = 0, drowsy = false;
  for (let i = 0; i < 60; i++) {
    const cap = previews.frame(1 / 60, owner);
    const out = face.frame(1 / 60, { shown: true, adjusting: false, voiced: false, speaking: false, capability: cap });
    lids = Math.max(lids, out.lids); blush = Math.max(blush, out.blush); mouth = Math.max(mouth, out.mouth?.value ?? 0);
    drowsy ||= face.getState().drowsy === true;
  }
  assert.ok(lids > 0.9, `lids ${lids}`); assert.ok(blush > 0.5, `blush ${blush}`); assert.ok(mouth > 0.5, `mouth ${mouth}`); assert.ok(drowsy, 'the drowsy face showed');
  assert.equal(previewClosure({ closure: 0, sleepEyes: 0.8 } as never, card([])), 0, 'the sleep preview\'s eyes only when the card can close them');
  assert.equal(previewClosure({ closure: 0, sleepEyes: 0.8 } as never, card(['closeEyes'])), 0.8);
  const handed = previewMouth({ mouth: 0.35 } as never, { value: 0.1, owner: 0.2 });
  assert.deepEqual(handed, { value: 0.35, owner: 0.5 }, 'the owner follows the envelope (no jump to 1)');
  const wave = withWave({ attention: 0.4, boost: 1.2 }, { id: 'w1', at: 5 }, readPoseReactionView) as { cue: { kind: string } };
  assert.equal(wave.cue.kind, 'wave');
});

/** 试一下 on the real Gene frame loop: her face, liveliness (the sleep pose) and the pose reactions (the wave), as the stage composes them. */
async function capabilityRun(fps: number) {
  const g = await windowGene();
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
  const allOn = card(['closeEyes', 'blush', 'mouth', 'sleepPose', 'gesture', 'drowsyFace', 'tears']);
  face.setCard(allOn);
  const view = faceView({ primary: 'calm', companion: null });
  face.setMood(view);
  const lively = new WindowLiveliness(() => {}, () => 0.5), reactions = new WindowReactions(), scene = new Scene();
  scene.add(mesh);
  const lib = await loadLivelinessForEngine(); lively.life.load(lib); lively.sleep.load(lib);
  lively.sleep.attach({ mesh, profile, baseY: 0, hasNeck: true });
  const previews = new WindowCapabilityPreviews();
  const ctx = { ...FREE, card: allOn };
  const bones = VISIBLE_BONES.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: Quaternion[][] = [], lids: number[] = [];
  let reacted = false, slept = 0;
  const gates = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
  try {
    for (let i = 0; i <= fps * 14; i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      if (i === fps * 1) assert.equal(previews.start('closeEyes', mesh, ctx), true);
      if (i === fps * 3) assert.equal(previews.start('sleepPose', mesh, ctx), true);
      if (i === fps * 9) assert.equal(previews.start('gesture', mesh, ctx, 1_000_000 + t * 1000), true); // the wave cue's time on the reactions' clock
      const cap = previews.frame(dt, mesh);
      const goals = lively.frame(dt, g.body, face, { view, rig, env: { shown: true, adjusting: false, voiced: false, speaking: false, armsHeld: false, capability: cap },
        pointer: { x: 0.2, y: 0.05 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, breath: 0.5, pulled: false, handHeld: false, adjusting: false, thinking: false,
        camera: g.camera, lift: g.figure.floorUnits, width: 420, height: 640, scene,
        reactions: { activity: (base, sleepCue) => reactions.frame(dt, { owner: mesh, pose: null, yawn: null, sleepCue, gates, game: false, proxy: null, fullBody: true,
          cover: () => {}, nowMs: 1_000_000 + t * 1000, wave: cap.wave }, base), show: null, showBlocked: false, overlay: reactions.overlay() } });
      lids.push(goals.lids); reacted ||= reactions.reacting; slept = Math.max(slept, Math.abs(goals.neck?.pitch ?? 0) + Math.abs(goals.head.pitch));
      mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
    }
  } finally { g.close(); }
  const span = (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  const row = (from: number, to: number) => ({ step: +max(frameSteps(span(from, to))).toFixed(3), surprise: +max(surprises(span(from, to)).perFrame).toFixed(3) });
  return { idle: row(0.2, 0.95), eyes: row(0.95, 2.9), sleep: row(2.95, 8.9), wave: row(8.95, 13.9), lidsPeak: max(lids), lidStep: max(lids.slice(1).map((v, k) => Math.abs(v - lids[k]))), reacted, slept };
}

test('Gene, 60 / 30 fps: 试一下 on the window engine (能闭眼, 能做睡姿 then waking, 能做手势) eases on her real frame loop', async () => {
  for (const fps of [60, 30]) {
    const run = await capabilityRun(fps);
    if (REPORT) console.log(JSON.stringify({ fps, ...run }));
    assert.ok(run.lidsPeak > 0.9, `her lids closed (${run.lidsPeak})`);
    assert.ok(run.lidStep < (fps === 60 ? 0.12 : 0.24), `lids eased (${run.lidStep})`);
    assert.ok(run.slept > 0.05, `the sleep pose showed (${run.slept})`);
    assert.ok(run.reacted, 'the wave played');
    const limit = Math.max(fps === 60 ? 0.3 : 0.9, run.idle.surprise * 1.5);
    for (const key of ['eyes', 'sleep'] as const) assert.ok(run[key].surprise <= limit, `${fps} fps ${key}: ${run[key].surprise}° (limit ${limit})`);
    // The wave is the batch-5 pose reaction itself (你挥手，她挥回来: 0.358° / 1.222°, docs/claude/2026-11-20-unbound-window-batch5.md): no more than it.
    assert.ok(run.wave.surprise <= (fps === 60 ? 0.4 : 1.35), `${fps} fps wave: ${run.wave.surprise}°`);
  }
});

// ---- the authoring previews (receipts, gates) -------------------------------------------------------------------------------------

const DEG = 180 / Math.PI;
function recordingGrants(binding: unknown, expression?: unknown) {
  const receipts: string[] = [];
  return { receipts, grants: {
    visualPreviewReceipt: async (r: { phase: string }) => { receipts.push(`visual ${r.phase}`); },
    resolveVisualPreview: async () => { throw new Error('not here'); },
    resolveExpressionPreview: async () => expression as never,
    bodyPreviewReceipt: async (r: { phase: string }) => { receipts.push(`body ${r.phase}`); },
    resolveBodyPreview: async () => binding as never,
    previewMotion: async () => { throw new Error('not here'); }, getModelProfile: async () => null as never, saveMotionFits: async () => true,
  } };
}

/** A personal pose on Gene: the left arm lifted forward, the elbow bent, the head tilted (offsets from her bind pose). */
function geneBinding(mesh: import('three').SkinnedMesh) {
  const at = (name: string) => mesh.skeleton.bones.findIndex(b => b.name === name);
  const q = (x: number, y: number, z: number) => { const v = new Quaternion().setFromEuler(new Euler(x, y, z)); return [v.x, v.y, v.z, v.w] as [number, number, number, number]; };
  return { id: 'bind-1', label: 'test', targetModelSha: VISUAL_GENE_SHA, sourceSha: 'src-1', mask: 'm-1', qualifiedStrength: 0.8,
    properties: [{ boneIndex: at('左腕'), boneName: '左腕', quaternion: q(0, 0, 0.45) }, { boneIndex: at('左ひじ'), boneName: '左ひじ', quaternion: q(0, -0.5, 0) },
      { boneIndex: at('頭'), boneName: '頭', quaternion: q(0, 0, 0.14) }] };
}

async function bodyPreviewRun(fps: number, instant: boolean) {
  const g = await windowGene();
  const mesh = g.fixture.mesh;
  const rest = mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone() }));
  let now = 1_000_000, shown = true, blocked = false;
  const { receipts, grants } = recordingGrants(geneBinding(mesh));
  const stage: WindowPreviewStage = { shown: () => shown, model: () => ({ generation: 1, url: 'gene.pmx', mesh, reviewed: true, retarget: null, rest }),
    settingsUrl: () => 'gene.pmx', pendingModel: async () => {}, behavior: () => null, mood: () => null, refresh: () => {} };
  const timers = { set: () => 0, clear: () => {}, now: () => now };
  const preview = new WindowBodyPreview(grants as never, stage, timers);
  const view: BodyPosePreview = { id: 'p1', token: 'tok', sessionId: 's', revision: 1, materialId: null, sourceKind: 'fixed-preset', characterId: 'c', targetModelSha: VISUAL_GENE_SHA,
    modelUrl: 'gene.pmx', bindingId: 'bind-1', sourceSha: 'src-1', mask: 'm-1', strength: 0.8, expiresAt: now + 60_000 };
  const bones = VISIBLE_BONES.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: Quaternion[][] = [];
  let result: Promise<boolean> | null = null;
  try {
    for (let i = 0; i <= fps * 6; i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      now += dt * 1000;
      if (i === fps * 1) result = preview.start(view);
      if (i === fps * 3) blocked = true; // e.g. a window move: the old stage's gate ends it ("stop"), eased out here
      if (i === fps * 3 + 1) blocked = false;
      preview.frame(dt, blocked);
      if (instant) for (const w of ((preview as unknown as { active: { shown: { weight: EasedWeight } } | null }).active ? [(preview as never as { active: { shown: { weight: EasedWeight } } }).active.shown.weight] : [])) { w.value = 1; }
      if (instant) for (const s of (preview as unknown as { fading: { weight: EasedWeight }[] }).fading) s.weight.value = 0;
      const overlay = preview.overlay();
      g.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, overlay: overlay ? remember => overlay(remember) : null }, dt);
      preview.afterRender();
      mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      await settle(2);
      void t;
    }
  } finally { g.close(); }
  const span = (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  const row = (from: number, to: number) => ({ step: +max(frameSteps(span(from, to))).toFixed(3), surprise: +max(surprises(span(from, to)).perFrame).toFixed(3) });
  return { receipts, ok: await result, idle: row(0.2, 0.95), in: row(0.95, 2.5), out: row(2.95, 5) };
}

test('Gene, 60 / 30 fps: a personal pose preview eases in and out on the window engine (the same pose put on at once jumps); the host\'s receipts as on the old stage', async () => {
  for (const fps of [60, 30]) {
    const eased = await bodyPreviewRun(fps, false), instant = await bodyPreviewRun(fps, true);
    if (REPORT) console.log(JSON.stringify({ fps, eased, instant }));
    assert.equal(eased.ok, true, 'ready once a frame showed it');
    assert.deepEqual(eased.receipts, ['body bind', 'body ready', 'body stop']);
    const limit = Math.max(fps === 60 ? 0.3 : 0.9, eased.idle.surprise * 1.5);
    assert.ok(eased.in.surprise <= limit, `${fps} fps in: ${eased.in.surprise}° (limit ${limit})`);
    assert.ok(eased.out.surprise <= limit, `${fps} fps out: ${eased.out.surprise}° (limit ${limit})`);
    assert.ok(instant.in.surprise > limit * 3, `the measure catches a pose put on at once (${instant.in.surprise}°)`);
    assert.ok(eased.in.step > 0.2, 'the pose did show');
  }
});

test('personal pose preview: refused for another model\'s preview, a stale binding or a hidden preview; expiry ends it without a receipt; a model change drops it', async () => {
  const g = await windowGene();
  try {
    const mesh = g.fixture.mesh, rest = mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone() }));
    let now = 1_000, generation = 1, shown = true;
    const base: BodyPosePreview = { id: 'p1', token: 'tok', sessionId: 's', revision: 1, materialId: null, sourceKind: 'fixed-preset', characterId: 'c', targetModelSha: VISUAL_GENE_SHA,
      modelUrl: 'gene.pmx', bindingId: 'bind-1', sourceSha: 'src-1', mask: 'm-1', strength: 0.8, expiresAt: 61_000 };
    const make = (binding = geneBinding(mesh)) => {
      const { receipts, grants } = recordingGrants(binding);
      const stage: WindowPreviewStage = { shown: () => shown, model: () => ({ generation, url: 'gene.pmx', mesh, reviewed: true, retarget: null, rest }),
        settingsUrl: () => 'gene.pmx', pendingModel: async () => {}, behavior: () => null, mood: () => null, refresh: () => {} };
      return { receipts, preview: new WindowBodyPreview(grants as never, stage, { set: () => 0, clear: () => {}, now: () => now }) };
    };
    let p = make();
    assert.equal(await p.preview.start({ ...base, modelUrl: 'other.pmx' }), false);
    assert.equal(await p.preview.start({ ...base, targetModelSha: 'x' }), false);
    shown = false; assert.equal(await p.preview.start(base), false); shown = true;
    p = make({ ...geneBinding(mesh), qualifiedStrength: 0.5 });
    // Raced against a short wait: a preview that went on would wait for its frame (fake timers), not answer false.
    assert.equal(await Promise.race([p.preview.start(base), settle(12).then(() => 'still waiting')]), false, 'a binding that does not match the preview');
    assert.deepEqual(p.receipts, ['body bind']);
    p = make();
    const started = p.preview.start(base); await settle();
    p.preview.frame(1 / 60, false); const overlay = p.preview.overlay(); assert.ok(overlay); overlay!(() => {}); p.preview.afterRender(); await settle();
    assert.equal(await started, true);
    for (let i = 0; i < 30; i++) p.preview.frame(1 / 60, false); // half a second showing
    now = 70_000; p.preview.frame(1 / 60, false);
    assert.deepEqual(p.receipts, ['body bind', 'body ready'], 'the natural end tells nothing');
    assert.ok(p.preview.busy, 'it eases out');
    p = make(); void p.preview.start(base); await settle(); now = 1_000; p.preview.frame(1 / 60, false);
    generation = 2; p.preview.frame(1 / 60, false);
    assert.equal(p.preview.busy, false, 'a new model: dropped at once (nothing on screen to ease)');
    generation = 1;
  } finally { g.close(); }
});

test('the personal visuals pin and mask are the expressions ones (the previews compare with the public ones)', async () => {
  const visual = await import('../shared/stage/personalize-visual');
  assert.equal(visual.VISUAL_GENE_SHA, EXPRESSION_GENE_SHA); assert.equal(visual.VISUAL_MASK, EXPRESSION_MASK);
});

test('the preview gates: the old stage\'s body preview gates and the behaviour face\'s gates end a preview', () => {
  const open = { ready: true, enabled: true, visible: true, manualPose: false, manualGesture: false, manualExpression: false, manualHead: false, dynamicPose: false,
    cameraOrWindow: false, inputBlocked: false, directContact: false, music: false, speaking: false, waitingForReply: false, chatGesture: false };
  assert.equal(bodyPreviewBlocked(open), false);
  for (const key of ['manualPose', 'manualGesture', 'dynamicPose', 'cameraOrWindow', 'inputBlocked', 'directContact', 'music', 'chatGesture'] as const) assert.equal(bodyPreviewBlocked({ ...open, [key]: true }), true, key);
  assert.equal(bodyPreviewBlocked({ ...open, visible: false }), true);
  const env = { shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false, hover: false, pinch: false, pulled: false,
    asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false, thinking: false, view: faceView(), blocks: NO_MOTION_BLOCKS, showing: false,
    reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false } as WindowMotionEnv;
  assert.equal(visualPreviewBlocked(env), false);
  for (const over of [{ pat: true }, { adjusting: true }, { behaviorBlocked: true }, { shown: false }, { blocks: { ...NO_MOTION_BLOCKS, face: true } }, { view: faceView({ expressions: false }) }])
    assert.equal(visualPreviewBlocked({ ...env, ...over } as WindowMotionEnv), true, JSON.stringify(Object.keys(over)));
});

// ---- 表情预览 (an expression composition) on the real Gene, through the window's behaviour-face player ----------------------------

async function expressionPreviewRun(fps: number, instant: boolean) {
  const g = await windowGene();
  const mesh = g.fixture.mesh;
  const rest = mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone() }));
  let now = Date.now(); // the player reads the wall clock for the grant's expiry
  const view = faceView({ primary: 'calm', companion: null });
  const preview: ExpressionPreview = { id: 'e1', token: 'etok', scope: 'personalize-expression-controls', sessionId: 's', revision: 1, recipeId: 'r1', characterId: 'c',
    targetModelSha: EXPRESSION_GENE_SHA, modelUrl: 'gene.pmx', mask: EXPRESSION_MASK, expiresAt: now + 60_000 };
  const recipe = { schemaVersion: 1, id: 'semantic-text-authoring', sceneId: 'text-authoring', strategy: 'semantic-parameters', label: 'smile', targetModelSha: EXPRESSION_GENE_SHA,
    maskId: EXPRESSION_MASK, qualification: EXPRESSION_QUALIFICATION, strength: 0.6, morphs: [{ id: 'brow_raise', weight: 0.6 }, { id: 'eye_smile', weight: 0.5 }] };
  const { receipts, grants } = recordingGrants(null, { ...preview, recipe, stageGeneration: 1 });
  const env: WindowMotionEnv = { shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false, hover: false, pinch: false,
    pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false, thinking: false, view, blocks: NO_MOTION_BLOCKS, showing: false,
    reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false };
  const host = { isBehaviorModelSupported: async () => true, resolveChatGesture: async () => { throw 0; }, resolveHerAction: async () => { throw 0; }, reportHerAction: async () => {},
    getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }), resolveBehaviorBody: async () => { throw 0; }, resolveBehaviorMotion: async () => { throw 0; },
    resolveHerLifeMotion: async () => { throw 0; } } as never;
  const motions = new WindowMotions(host, () => env, () => now);
  const stage: WindowPreviewStage = { shown: () => true, model: () => ({ generation: 1, url: 'gene.pmx', mesh, reviewed: true, retarget: null, rest }),
    settingsUrl: () => 'gene.pmx', pendingModel: async () => {}, behavior: () => motions.clips?.behavior ?? null, mood: () => view, refresh: () => motions.refreshFaces() };
  const visual = new WindowVisualPreview(grants as never, stage, { set: () => 0, clear: () => {}, now: () => now });
  motions.setPreview({ plan: () => visual.plan(), resolveFor: (id, token) => visual.resolveFor(id, token), failed: () => visual.failed(), protectedMorphs: () => [] });
  motions.attach({ figure: g.figure, mesh, reviewed: true, retarget: null, transform: undefined, profile: null, standard: false });
  motions.setMood(view);
  const index = mesh.morphTargetDictionary!['上'];
  const values: number[] = [];
  let result: Promise<boolean> | null = null;
  try {
    for (let i = 0; i <= fps * 5; i++) {
      const dt = i ? 1 / fps : 0;
      now += dt * 1000;
      if (i === fps) result = visual.start(preview);
      if (i === fps * 3) visual.cancel();
      visual.frame(dt, false);
      if (instant) { const v = visual as unknown as { active: { weight: EasedWeight } | null; fading: { weight: EasedWeight } | null }; if (v.active) v.active.weight.value = 1; if (v.fading) v.fading.weight.value = 0; }
      motions.frame();
      g.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false }, dt);
      motions.afterBody(dt);
      visual.afterRender();
      values.push(mesh.morphTargetInfluences![index]);
      await settle(2);
    }
  } finally { motions.dispose(); g.close(); }
  const steps = values.slice(1).map((v, k) => Math.abs(v - values[k]));
  return { receipts, ok: await result, peak: max(values), step: max(steps), last: values.at(-1)! };
}

test('Gene, 60 / 30 fps: an expression composition preview eases in and out through the window\'s behaviour-face player (at once it jumps); receipts as on the old stage', async () => {
  for (const fps of [60, 30]) {
    const eased = await expressionPreviewRun(fps, false), instant = await expressionPreviewRun(fps, true);
    if (REPORT) console.log(JSON.stringify({ fps, eased, instant }));
    assert.equal(eased.ok, true, JSON.stringify(eased));
    assert.deepEqual(eased.receipts, ['visual bind', 'visual ready', 'visual stop']);
    assert.ok(eased.peak > 0.05, `the brow rose (${eased.peak})`);
    assert.ok(eased.step < eased.peak * (fps === 60 ? 0.25 : 0.45), `${fps} fps: largest step ${eased.step.toFixed(4)} of ${eased.peak.toFixed(4)}`);
    assert.ok(instant.step >= instant.peak * 0.9, `the measure catches it put on at once (${instant.step.toFixed(4)})`);
    assert.ok(eased.last < 0.01, 'it went back');
  }
});

// ---- the control window's own: the swap, the physics form, the fit check -----------------------------------------------------------

test('the control window applies the personal feel in place (its own slider announces it, the page that wrote it hears no storage event)', () => {
  const listeners: ((event: Event) => void)[] = [];
  const target = { addEventListener: (_: string, f: (event: Event) => void) => listeners.push(f), removeEventListener: () => {},
    dispatchEvent: (event: Event) => { listeners.forEach(f => f(event)); return true; } } as unknown as Window;
  const seen: string[] = [];
  watchWindowStyle(target, 0, value => seen.push(`style ${value}`));
  announceWindowStyle(target, 0);
  announceWindowStyle(target, 0.4);
  announceWindowStyle(target, 0.4);
  announceWindowStyle(target, 0.1);
  listeners.forEach(f => f({ key: 'other', newValue: '{"style":0.9}' } as unknown as Event));
  assert.deepEqual(seen, ['style 0.4', 'style 0.1']);
});

test('the physics form: the window engine tells the control window what the model supports, once per change; as the preview it never starts physics', async () => {
  const support = { hair: { supported: true, bones: 4, bodies: 4, reason: null }, chest: { supported: false, bones: 0, bodies: 0, reason: 'none' } };
  let loads = 0;
  const physics = new WindowPhysics({ loadAmmo: async () => { loads++; return {} as never; }, support: () => support as never, make: () => ({ configure() {} }) as never, outputBones: () => ({ hair: [], chest: [] }) });
  physics.previewOnly = true;
  const states: string[] = [];
  const report = (state: { status: string; support: { hair: { supported: boolean } } }) => states.push(`${state.status} ${state.support.hair.supported}`);
  physics.publish(report as never, false);
  await physics.attach({ mesh: {} as never, configureJelly() {}, attachPhysics() {}, hidePhysics() {} });
  physics.publish(report as never, false); physics.publish(report as never, false);
  await physics.set({ quality: 'balanced', hair: { enabled: true, strength: 0.6 }, chest: { enabled: false, strength: 0.5 } } as never);
  physics.publish(report as never, false);
  assert.deepEqual(states, ['off false', 'off true', 'ready true']);
  assert.equal(loads, 0, 'no physics in the preview');
});

test('the fit check on a model that is not the reviewed Gene: the host\'s stored scores and the view reach the control window', async () => {
  const g = await windowGene();
  try {
    const views: unknown[] = [];
    const measure = measureWindowModel(g.fixture.mesh, null, false, { cached: { modelKey: 'k', motionFits: null }, save: async () => true, changed: view => views.push(view) });
    assert.ok(measure.retarget, 'the retarget is made');
    measure.retarget!.announce();
    assert.equal(views.length, 1, 'its view went out');
  } finally { g.close(); }
});

// ---- the diagnostics -------------------------------------------------------------------------------------------------------------

test('diagnostics: what she does in the journal\'s words; the stray reach widens over the props; a visible bone\'s jump is one "guard" line', async () => {
  const env = { shown: true, speaking: true, pat: false, hover: false, feeding: false, music: false, showing: false, rps: true, give: false, hands: false, reacting: false } as WindowMotionEnv;
  assert.deepEqual(windowActivities(env, { chat: false, action: false, body: false, herLife: false, preview: true, transition: false }), ['speaking', 'expression-preview', 'rps']);
  assert.deepEqual(windowActivities({ ...env, speaking: false, rps: false } as WindowMotionEnv, { chat: false, action: false, body: false, herLife: false, preview: false, transition: false }), ['idle']);
  const camera = new PerspectiveCamera(30, 1, 0.1, 100); camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  const box = { minX: 40, maxX: 60, minY: 40, maxY: 60 };
  const wide = widenReach(box, [{ x: 2, y: -2, z: 0 }], camera, 100, 100)!;
  assert.ok(wide.maxX > 60 && wide.minY < 40, JSON.stringify(wide));
  assert.equal(widenReach(box, [], camera, 100, 100), box);
  // A visible bone that snaps 40° in one frame (her arm) is reported once as 'guard', with the bone's name.
  const g = await windowGene();
  try {
    const reports: { kind: string; name: string }[] = [];
    const diagnostics = new WindowDiagnostics(glitch => reports.push({ kind: glitch.kind, name: glitch.name }), () => false);
    const arm = g.fixture.mesh.skeleton.bones.find(b => b.name === '左腕')!;
    for (let i = 0; i < 12; i++) {
      g.frame(1 / 60);
      if (i === 8) { arm.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 40 / DEG)); g.fixture.mesh.updateMatrixWorld(true); }
      diagnostics.afterRender({ mesh: g.fixture.mesh, camera: g.camera, height: g.figure.heightUnits, gl: null as never, canvas: null as never, physicsBones: null, fps: 60,
        frameMs: 1000 / 60, grid: true, props: () => [], activities: () => ['idle'] });
    }
    assert.ok(reports.some(r => r.kind === 'guard' && r.name === '左腕'), JSON.stringify(reports));
    assert.ok(reports.length <= 3, 'rate-limited per bone');
  } finally { g.close(); }
});

