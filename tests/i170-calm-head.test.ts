// I-170 (docs/claude/2026-11-21-i170-calm-head-talking.md). On 2026-11-21 the idle model made her head sway while she talked; plan A, then the question whether it would lock looking at the user and at the mouse — no: only the idle's own head motion
// calms (the learned idle's head and neck, procedural life's drift and casual tilt) to about 0.3 while you talk; looking at you, the mouse,
// away, her reply's nods and tilts, touch reactions, breathing and the body's sway are untouched. Eased in and out, at 60 and 30 fps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, type Bone, type SkinnedMesh } from 'three';
import { TalkCalm, talkSignal } from '../shared/behaviors/talk-calm/talk-calm';
import { TALK_CALM_KNOBS } from '../shared/behaviors/talk-calm/knobs';
import { layerIdle } from '../src/unbound/motion/learned-idle';
import { REST_TARGETS, type PoseTargets } from '../src/unbound/motion/generator';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { UnboundFigure } from '../src/unbound/figure';
import { WindowBody } from '../src/unbound/window-mode/window-body';
import { HerOutFace } from '../src/unbound/her/out-face';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { ProceduralLife, type LifeGates, type LifeInput } from '../src/stage/procedural-life';
import { ANCHOR_LEVELS } from '../src/mood/mood-face/anchors';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { standClip, TRACKED } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { faceView } from './helpers/window-face-fixture';
import { steps } from './helpers/frame-stats';

const DEG = 180 / Math.PI;
const R29 = { 60: 0.12, 30: 0.4 } as Record<number, number>;

// ---- the calm itself --------------------------------------------------------------------------------------------------------------
function calmCurve(fps: number, talkFrom: number, talkTo: number, seconds: number) {
  const calm = new TalkCalm(), values: number[] = [];
  for (let i = 0; i <= fps * seconds; i++) { const t = i / fps; values.push(calm.frame(i ? 1 / fps : 0, t >= talkFrom && t < talkTo)); }
  return values;
}

test('the calm eases to the knob while talking, holds for the linger, eases back: the same curve at 60 and 30 fps, no jump', () => {
  const K = TALK_CALM_KNOBS;
  const a = calmCurve(60, 2, 4, 30), b = calmCurve(30, 2, 4, 30);
  // The same curve at either rate (a signal is seen at the frame it arrives: at most one frame's offset, 1/30 s).
  const offset = Math.max(...b.map((v, i) => Math.abs(v - a[i * 2]!)));
  console.log(`talk calm: largest difference between 60 and 30 fps ${offset.toFixed(4)}`);
  assert.ok(offset < 0.03, `the same curve (${offset.toFixed(4)})`);
  assert.equal(a[60 * 1], 1, 'not talking: all of the idle head');
  assert.ok(Math.abs(a[60 * 4]! - K.head) < 0.02, `calm within 2 s (${a[60 * 4]!.toFixed(3)})`);
  assert.ok(Math.abs(a[60 * 18]! - K.head) < 1e-6, 'held through the linger (15 s after the last signal)');
  assert.ok(a[60 * 19 + 30]! > K.head + 0.05 && a[60 * 30]! > 0.999, 'then back to all of it');
  assert.ok(a.every(v => v >= K.head - 1e-9 && v <= 1 + 1e-9), 'never past either end (critically damped)');
  for (const [fps, curve] of [[60, a], [30, b]] as const) {
    const steps = curve.slice(1).map((v, i) => v - curve[i]!), accel = steps.slice(1).map((s, i) => Math.abs(s - steps[i]!));
    console.log(`talk calm ${fps} fps: largest change ${(Math.max(...steps.map(Math.abs)) * fps).toFixed(2)}/s, largest change of change ${Math.max(...accel).toFixed(4)}`);
    assert.ok(Math.max(...steps.map(Math.abs)) * fps < 1.2, 'eased, not switched');
  }
  assert.equal(talkSignal({}), false);
  for (const key of ['typing', 'thinking', 'preparing', 'speaking', 'waiting', 'reply'] as const) assert.equal(talkSignal({ [key]: true }), true, key);
});

test('the learned idle layer calms only its head and neck; her torso and hips sway as before', () => {
  const idle: PoseTargets = { ...REST_TARGETS, torso: { pitch: 0.1, yaw: 0.05, roll: 0.02 }, neck: { pitch: 0.04, yaw: 0.06, roll: 0.01 }, head: { pitch: 0.08, yaw: -0.1, roll: 0.03 },
    pelvis: { lateral: 0.01, forward: 0, vertical: 0.002 } };
  const full = layerIdle(REST_TARGETS, idle, 1), calm = layerIdle(REST_TARGETS, idle, 1, 0.3);
  assert.deepEqual(calm.torso, full.torso); assert.deepEqual(calm.pelvis, full.pelvis);
  assert.ok(Math.abs(calm.head.yaw - 0.3 * full.head.yaw) < 1e-9 && Math.abs(calm.neck.pitch - 0.3 * full.neck.pitch) < 1e-9);
  assert.deepEqual(layerIdle(REST_TARGETS, idle, 1, 1), full, 'no talk: exactly as before');
  // Her reply's nod or tilt (a speech beat), a touch reaction's head, her look: the owners' targets, kept whole under the calmed idle.
  const nod: PoseTargets = { ...REST_TARGETS, head: { pitch: 0.12, yaw: 0, roll: -0.05 }, eyes: { yaw: 0.2, pitch: -0.1 } };
  const withNod = layerIdle(nod, idle, 1, 0.3);
  assert.ok(Math.abs(withNod.head.pitch - (0.12 + 0.3 * idle.head.pitch)) < 1e-9 && Math.abs(withNod.head.roll - (-0.05 + 0.3 * idle.head.roll)) < 1e-9, 'the nod is all there');
  assert.deepEqual(withNod.eyes, nod.eyes, "where she looks is the owner's");
});

// ---- procedural life (the old stage, and the window's and full-screen's procedural life) ----------------------------------------------
const lifeGates = (patch: Partial<LifeGates> = {}): LifeGates => ({ expressive: true, contact: false, manualPose: false, manualGesture: false, manualHead: false,
  manualExpression: false, manualMouth: false, chatGesture: false, music: false, bodyMotion: false, headOwned: false, authoredFace: false,
  preview: false, adjusting: false, speaking: false, gazeAllowed: true, ...patch });
const calmMood = { primary: 'calm', companion: null, values: { D: 50, O: 50, E: 50, N: 50, C: 50, ...ANCHOR_LEVELS.calm.levels }, longing: 0,
  intensity: { expression: 50, gaze: 50, posture: 50 } } as LifeInput<Bone>['mood'];
function lifeHeads(talking: boolean, beat: { headX: number; headZ: number; bodyZ: number } | null) {
  const life = new ProceduralLife<Bone>(), owner = {}, heads: number[][] = [];
  for (let i = 0; i < 60 * 40; i++) {
    life.frame(1 / 60, { enabled: true, owner, seedKey: 'calm-card', rig: null, mood: calmMood, fatigue: null, pointerX: 0, pointerY: 0, breathStrength: 0.5,
      hasEyes: true, beat, gates: lifeGates({ talking }) });
    if (i >= 60 * 5) heads.push([life.out.headX, life.out.headY, life.out.headZ, life.out.gazeX, life.out.gazeY, life.out.swayZ]);
  }
  return heads;
}
const spread = (values: number[]) => { const mean = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length); };

test('procedural life: its head drift and casual tilts calm to about 0.3 while talking; her gaze, body sway and a music nod do not', () => {
  const quiet = lifeHeads(false, null), talk = lifeHeads(true, null);
  for (const [axis, k] of [['x', 0], ['y', 1], ['z', 2]] as const) {
    const ratio = spread(talk.map(h => h[k]!)) / spread(quiet.map(h => h[k]!));
    console.log(`procedural life head ${axis}: spread while talking / quiet = ${ratio.toFixed(3)}`);
    assert.ok(Math.abs(ratio - TALK_CALM_KNOBS.head) < 0.03, `${axis}: ${ratio.toFixed(3)}`);
  }
  for (const k of [3, 4, 5]) assert.deepEqual(talk.map(h => h[k]), quiet.map(h => h[k]), 'gaze and body sway exactly the same');
  // A nod on top (the music's; her reply's speaking nod and her own life ride the same way, outside the calmed part) stays whole.
  const beat = { headX: 0.03, headZ: -0.02, bodyZ: 0 };
  const nodTalk = lifeHeads(true, beat), mean = (rows: number[][], k: number) => rows.reduce((a, r) => a + r[k]!, 0) / rows.length;
  assert.ok(Math.abs((mean(nodTalk, 0) - mean(talk, 0)) - beat.headX) < 0.002, 'the nod is all there while talking');
});

// ---- Unbound's engine: the window body and full-screen --------------------------------------------------------------------------------
/** Head against her upper body (deg) over t = from..to: the spread of its angle from its own mean. */
function headSpread(rel: Quaternion[]): number {
  const mean = rel.reduce((s, q) => { const c = q.clone(); if (s.dot(c) < 0) c.set(-c.x, -c.y, -c.z, -c.w); return s.set(s.x + c.x, s.y + c.y, s.z + c.z, s.w + c.w); }, new Quaternion(0, 0, 0, 0)).normalize();
  return Math.sqrt(rel.reduce((a, q) => a + (q.angleTo(mean) * DEG) ** 2, 0) / rel.length);
}
const relHead = (mesh: SkinnedMesh) => {
  const find = (name: string) => mesh.skeleton.bones.find(b => b.name === name)!, chest = find('上半身2'), head = find('頭');
  return () => chest.getWorldQuaternion(new Quaternion()).invert().multiply(head.getWorldQuaternion(new Quaternion()));
};

/** The window body (window-body.ts) on the public Gene with the shipped idle: `talk(t)` is the talk signal; `pointer`: the cursor, followed. */
async function windowRun(fps: number, seconds: number, talk: (t: number) => boolean, pointer: { x: number; y: number } | null = null) {
  const fixture = await loadPublicGeneForTargets();
  try {
    const figure = new UnboundFigure(fixture.mesh, { xM: 0, depthM: 0 });
    figure.setClips({ pose: await standClip(fixture.mesh), gesture: null, expression: null }, false);
    const idle = await shippedIdle();
    let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random, null);
    await new Promise(resolve => setImmediate(resolve));
    const rel = relHead(fixture.mesh), bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const frames: { t: number; rel: Quaternion; rotations: Quaternion[]; look: { yaw: number; pitch: number } }[] = [];
    let look = { yaw: 0, pitch: 0 };
    const set = figure.setPoseTargets.bind(figure);
    figure.setPoseTargets = targets => { look = { ...targets.eyes }; set(targets); }; // where she looks, as the idle layer hands it to her body
    for (let i = 0; i <= fps * seconds; i++) {
      const t = i / fps;
      body.frame(i ? 1 / fps : 0, { pointer: pointer ?? { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: pointer !== null, pat: false, talking: talk(t) });
      fixture.mesh.updateMatrixWorld(true);
      frames.push({ t, rel: rel(), rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), look });
    }
    body.dispose();
    return { frames, headCalm: body.idle.headCalm };
  } finally { fixture.close(); }
}
const between = <T extends { t: number }>(frames: T[], from: number, to: number) => frames.filter(f => f.t >= from && f.t <= to);
function r29(frames: { t: number; rotations: Quaternion[] }[], from: number, to: number) {
  const at = between(frames, from, to), step = (i: number) => at[i]!.rotations.map((q, b) => q.angleTo(at[i - 1]!.rotations[b]!) * DEG);
  const maxStep = Math.max(...at.slice(1).map((_, i) => Math.max(...step(i + 1))));
  const surprise = Math.max(...at.slice(2).map((_, i) => { const s = step(i + 2), p = step(i + 1); return Math.max(...s.map((v, b) => Math.abs(v - p[b]!))); }));
  return { maxStep, surprise };
}

test('the window: the idle head against her upper body calms to about a third while talking (60 and 30 fps), eased in and out', async () => {
  for (const fps of [60, 30]) {
    const quiet = await windowRun(fps, 30, () => false), talk = await windowRun(fps, 24, () => true);
    const q = headSpread(between(quiet.frames, 6, 24).map(f => f.rel)), k = headSpread(between(talk.frames, 6, 24).map(f => f.rel));
    console.log(`window ${fps} fps: idle head spread quiet ${q.toFixed(2)}°, talking ${k.toFixed(2)}° (×${(k / q).toFixed(2)})`);
    assert.ok(k / q < 0.5 && k / q > 0.15, `about a third (${(k / q).toFixed(2)})`);
    // Talk from 6 s to 8 s: calm comes in, holds the linger, goes back out (t ≈ 23 s): every step as smooth as without it.
    const toggled = await windowRun(fps, 30, t => t >= 6 && t < 8);
    const base = r29(quiet.frames, 5, 30), on = r29(toggled.frames, 5, 30);
    console.log(`window ${fps} fps talk on/off: largest step ${on.maxStep.toFixed(2)}°/frame (quiet ${base.maxStep.toFixed(2)}), unexpected step ${on.surprise.toFixed(3)}° (quiet ${base.surprise.toFixed(3)})`);
    assert.ok(on.surprise <= Math.max(base.surprise * 1.25, R29[fps]!), `no jump (${on.surprise.toFixed(3)}°)`);
    assert.ok(toggled.headCalm > 0.99, 'back to all of it after the linger');
    // The calm coming in (6..9 s) and going out (21..27 s), against the same stretches without talk.
    for (const [from, to] of [[5.5, 9], [21, 27]] as const) {
      const head = (frames: typeof quiet.frames) => frames.map(f => ({ t: f.t, rotations: [f.rel] })); // her head against her upper body only
      const was = r29(head(quiet.frames), from, to), now = r29(head(toggled.frames), from, to);
      console.log(`window ${fps} fps head ${from}..${to} s: unexpected step ${now.surprise.toFixed(3)}° (no talk ${was.surprise.toFixed(3)}°), largest step ${now.maxStep.toFixed(2)}°/frame (${was.maxStep.toFixed(2)})`);
      assert.ok(now.surprise <= Math.max(was.surprise * 1.25, R29[fps]!) && now.maxStep <= was.maxStep * 1.25 + 0.05, 'eased');
    }
  }
});

test('the window: where she looks (the mouse, you) is exactly the same while talking; only the idle wobble under it is smaller', async () => {
  for (const pointer of [{ x: 0.7, y: 0.25 }, { x: -0.5, y: 0.7 }]) {
    const quiet = await windowRun(60, 16, () => false, pointer), talk = await windowRun(60, 16, () => true, pointer);
    const diff = Math.max(...quiet.frames.map((f, i) => Math.hypot(f.look.yaw - talk.frames[i]!.look.yaw, f.look.pitch - talk.frames[i]!.look.pitch) * DEG));
    const aimed = Math.max(...quiet.frames.map(f => Math.hypot(f.look.yaw, f.look.pitch) * DEG));
    console.log(`window look at (${pointer.x}, ${pointer.y}): largest difference talking or not ${diff.toFixed(3)}° (the look itself up to ${aimed.toFixed(1)}°)`);
    assert.ok(diff < 0.01, 'the same look, frame by frame');
  }
});

/** Full-screen (her/out-face.ts over the idle layer, as src/unbound/main.ts), the public Gene; `talking`: the page's talk signal. */
async function fullRun(talking: (t: number) => boolean) {
  const fixture = await loadPublicGeneForTargets(), mesh = fixture.mesh;
  const measured = measureWindowModel(mesh, null, true);
  const figure = new UnboundFigure(mesh, { xM: 0, depthM: 3 });
  figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false);
  figure.faceToward({ x: 0, z: 0.55 });
  const idleLayer = new UnboundIdleLayer(async heightM => createBundledIdle(heightM, await shippedIdle(), 11));
  idleLayer.attach(figure, figure.heightM);
  await new Promise(resolve => setTimeout(resolve, 0));
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const her = new HerOutFace(random);
  her.attach({ body: figure, mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
  her.setMood(faceView({ primary: 'calm', companion: null }));
  const rel = relHead(mesh), rels: { t: number; rel: Quaternion }[] = [], looks: { t: number; yaw: number; pitch: number }[] = [];
  const recorder = idleLayer.wrap(figure);
  const seen = { get sense() { return recorder.sense; }, get intentIdle() { return recorder.intentIdle; },
    setPoseTargets: (targets: PoseTargets) => { looks.push({ t: now, yaw: targets.eyes.yaw, pitch: targets.eyes.pitch }); recorder.setPoseTargets(targets); } };
  let now = 0;
  try {
    for (let i = 0; i <= 60 * 20; i++) {
      now = i / 60;
      const faced = her.frame(i ? 1 / 60 : 0, seen, { shown: true, adjusting: false, voiced: false, speaking: false, walking: figure.walking, nowMs: 1_000_000 + now * 1000, talking: talking(now) });
      idleLayer.frame(i ? 1 / 60 : 0, idleWanted({ performing: faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }));
      figure.frame(i ? 1 / 60 : 0);
      mesh.updateMatrixWorld(true);
      rels.push({ t: now, rel: rel() });
    }
  } finally { her.attach(null); figure.dispose(); fixture.close(); }
  return { rels, looks, headCalm: idleLayer.headCalm };
}

test('full-screen: the same calm (her idle head about a third while talking); where she looks is unchanged', async () => {
  const quiet = await fullRun(() => false), talk = await fullRun(() => true);
  const q = headSpread(between(quiet.rels, 6, 20).map(f => f.rel)), k = headSpread(between(talk.rels, 6, 20).map(f => f.rel));
  console.log(`full-screen 60 fps: idle head spread quiet ${q.toFixed(2)}°, talking ${k.toFixed(2)}° (×${(k / q).toFixed(2)}); calm ${talk.headCalm.toFixed(2)}`);
  assert.ok(k / q < 0.55, `calmer (${(k / q).toFixed(2)})`);
  const lookDiff = Math.max(...between(quiet.looks, 1, 20).map((l, i) => { const m = between(talk.looks, 1, 20)[i]!; return Math.hypot(l.yaw - m.yaw, l.pitch - m.pitch) * DEG; }));
  console.log(`full-screen: largest difference in where she looks, talking or not: ${lookDiff.toFixed(2)}°`);
  assert.ok(lookDiff < 2, 'the look (to you, away, the chooser) is the same');
});
