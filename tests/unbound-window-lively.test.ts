/**
 * I-154 batch 3, rows 15 程序生命, 16 姿势识别里看向你 and 35 睡姿、睡着的身体、梦话 on the window engine
 * (docs/claude/2026-11-20-unbound-window-batch3.md): the gates (pose sensing's reading only as the host gives it, fresh 3 s, checked;
 * procedural life's switch and owners; the sleep layers only with the card's 能做睡姿 and the companion's owners), and the real Gene frame
 * loop at 60 and 30 fps through WindowLiveliness (the code the stage runs): falling asleep, lying down, sleeping, waking and getting up;
 * procedural life on; turning to you. WINDOW_BATCH3_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Scene } from 'three';
import { WindowGaze, USER_GAZE_FRESH_S } from '../src/unbound/window-mode/window-gaze';
import { WindowLife } from '../src/unbound/window-mode/window-life';
import { NO_LIFE, WindowProceduralLife } from '../src/unbound/window-mode/window-proc-life';
import { WindowSleep } from '../src/unbound/window-mode/window-sleep';
import { WindowLiveliness } from '../src/unbound/window-mode/window-liveliness';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { loadLivelinessForEngine } from '../src/stage';
import { StageModelProfile } from '../src/stage/model-profile';
import type { UserGazeReading } from '../shared/behaviors/gaze-attention/interface';
import type { FatiguePhase } from '../shared/mood/fatigue';
import { card, faceView, syntheticRig } from './helpers/window-face-fixture';
import { frameSteps, surprises, windowGene, WINDOW } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';

const REPORT = process.env.WINDOW_BATCH3_REPORT === '1';
/** You, facing her, up and to the left of her window (tests/i081-gaze-stage.test.ts). */
const YOU: UserGazeReading = { present: true, facing: 'toward', energy: 0.1, point: { x: -3.2, y: 2.6, dx: 9.6, dy: 6.9 }, screen: null };
function seeded(seed = 5): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const gazeInput = (over: Partial<Parameters<WindowGaze['frame']>[1]> = {}) => ({ follow: true, allowed: true, pointer: { x: 0.3, y: 0 }, eyes: { x: 0, y: 0.3 },
  thinking: false, speaking: false, mood: faceView(), ...over });

// ---- row 16: pose sensing's reading ------------------------------------------------------------------------------------------------

test('gaze: without a reading (pose sensing off, nothing fresh) nothing of it shows; a malformed one is dropped', () => {
  const gaze = new WindowGaze(() => {}, seeded());
  for (let i = 0; i < 120; i++) assert.equal(gaze.frame(1 / 60, gazeInput()), null);
  gaze.set({ present: 'yes', facing: 'toward' }); gaze.set(42); gaze.set(null);
  for (let i = 0; i < 120; i++) assert.equal(gaze.frame(1 / 60, gazeInput()), null, 'still the cursor exactly');
  gaze.set({ ...YOU, point: { x: 99, y: 0, dx: 1, dy: 1 } }); // out of range: not a reading
  assert.equal(gaze.fresh, false);
});

test('gaze: a reading where you are draws her look toward you; it lives 3 s, then she goes back to the cursor; hidden forgets at once', () => {
  const gaze = new WindowGaze(() => {}, seeded());
  let out = null as ReturnType<WindowGaze['frame']>;
  for (let i = 0; i < 60 * 6; i++) { if (i % 6 === 0) gaze.set(YOU); out = gaze.frame(1 / 60, gazeInput()); }
  assert.ok(out && out.user.x < 0 && out.user.y > 0, `she knows where you are (${out?.user.x.toFixed(2)}, ${out?.user.y.toFixed(2)})`);
  assert.ok(out!.aim.x < 0.3, `her aim leaves the cursor (on your right) for you (aim ${out!.aim.x.toFixed(2)})`);
  // No new reading: fresh for 3 s, then the chooser lets go and she looks as before.
  let back = -1;
  for (let i = 0; i < 60 * 20; i++) { if (gaze.frame(1 / 60, gazeInput()) === null) { back = i / 60; break; } }
  assert.ok(back > USER_GAZE_FRESH_S - 0.1, `the reading was used for ${USER_GAZE_FRESH_S} s (${back.toFixed(1)})`);
  assert.ok(back > 0 && back < 15, `then exactly the cursor again (${back.toFixed(1)} s)`);
  gaze.set(YOU); assert.equal(gaze.fresh, true); gaze.forget(); assert.equal(gaze.fresh, false, 'hidden: forgotten');
});

test('the look: pose sensing\'s aim replaces the cursor while engaged; asleep, no aim at all', () => {
  const life = new WindowLife(() => 0.5), base = { pointer: { x: 0.6, y: 0 }, eyes: { x: 0, y: 0 }, follow: true, pat: false };
  const cursor = life.frame({ ...base, dt: 1 / 60 }).eyes.yaw;
  const aimed = new WindowLife(() => 0.5).frame({ ...base, dt: 1 / 60, aim: { x: -0.5, y: 0 } }).eyes.yaw;
  assert.ok(cursor > 0 && aimed < 0, 'the aim, not the cursor');
  const gaze = { pull: 1, x: 0, y: 0, strength: 1, allowed: false, eyeYaw: 0, eyePitch: 0 };
  const asleep = new WindowLife(() => 0.5).frame({ ...base, dt: 1 / 60, aim: { x: -0.5, y: 0 }, face: { lids: 0, softLids: 0, ownsPat: false, gaze } }).eyes;
  assert.deepEqual([asleep.yaw, asleep.pitch], [0, 0]);
});

// ---- row 15: procedural life ------------------------------------------------------------------------------------------------------

const lifeInput = (over: Partial<Parameters<WindowProceduralLife['frame']>[1]> = {}) => ({ owner: OWNER, rig: syntheticRig(), view: faceView(), pointer: { x: 0, y: 0 },
  breath: 0.5, hasEyes: true, mouthBusy: false, gates: { contact: false, face: false, head: false, mouth: false, adjusting: false, speaking: false, gazeAllowed: true, fatigueFace: false }, ...over });
const OWNER = {};

test('procedural life: nothing until its code is loaded; on by default, its drift and tilt show; the switch fades it out; a touch makes it yield', async () => {
  const empty = new WindowProceduralLife();
  assert.equal(empty.frame(1 / 60, lifeInput()), NO_LIFE);
  const lib = await loadLivelinessForEngine();
  const life = new WindowProceduralLife(lib);
  assert.equal(life.on, true, 'on by default, as on the old stage');
  let out = NO_LIFE as ReturnType<WindowProceduralLife['frame']>, moved = 0;
  for (let i = 0; i < 60 * 8; i++) { out = life.frame(1 / 60, lifeInput()); moved = Math.max(moved, Math.abs(out.head.yaw) + Math.abs(out.head.roll) + Math.abs(out.gaze.x)); }
  assert.ok(out.active && moved > 0.005, `her head and gaze drift (${moved.toFixed(4)})`);
  for (let i = 0; i < 60; i++) life.frame(1 / 60, lifeInput({ gates: { ...lifeInput().gates, contact: true } }));
  const yielding = (life.getState() as { primitives: { tilt: { yielding: string[] } } }).primitives.tilt.yielding;
  assert.ok(yielding.includes('contact'), `a touch: the tilt yields (${yielding})`);
  life.set(false);
  let off = -1;
  for (let i = 0; i < 60 * 3; i++) { if (!life.frame(1 / 60, lifeInput()).active) { off = i / 60; break; } }
  assert.ok(off > 0.1 && off < 2, `switched off: it fades out (gone after ${off.toFixed(2)} s, not at once)`);
  // Her closed smile and small "o" step aside while speech or a snack owns her mouth.
  const busy = new WindowProceduralLife(lib);
  for (let i = 0; i < 60 * 5; i++) { const f = busy.frame(1 / 60, lifeInput({ mouthBusy: true, view: faceView({ primary: 'happy' }) })); assert.equal(f.expr.mouthSmile, undefined); assert.equal(f.expr.o, undefined); }
});

// ---- row 35: the sleep layers' gates ----------------------------------------------------------------------------------------------

test('sleep pose: with 能做睡姿 her chin goes down slowly when she falls asleep; without it, or while her head is held, nothing', async () => {
  const run = (capable: boolean, headOwned: boolean) => {
    const sleep = new WindowSleep(null);
    sleep.attach({ mesh: {} as never, profile: null, baseY: 0, hasNeck: true });
    const pitches: number[] = [];
    for (let i = 0; i < 60 * 6; i++) {
      const f = sleep.frame(1 / 60, { view: faceView({ phase: 'asleep', F: 0.95 }), capable, headOwned, yielding: false, busy: false, touched: false,
        camera: null as never, lift: 0, width: 420, height: 640, scene: new Scene() });
      pitches.push(f.neck.pitch + f.head.pitch);
    }
    return pitches;
  };
  const shown = run(true, false);
  assert.ok(shown.at(-1)! > 0.15, `asleep: chin down (${shown.at(-1)!.toFixed(3)} rad)`);
  assert.ok(shown[1] < 0.01 && max(shown.slice(1).map((v, i) => Math.abs(v - shown[i]))) < 0.01, 'eased: never a jump');
  assert.ok(max(run(false, false)) === 0, 'the card has 能做睡姿 off: nothing');
  assert.ok(max(run(true, true)) === 0, 'a picked head motion holds her head: nothing');
  const habit = new WindowSleep(); habit.setHabit(80); assert.equal(habit.sleepHabit, 80); habit.setHabit('x'); assert.equal(habit.sleepHabit, undefined);
});

// ---- the real Gene frame loop ------------------------------------------------------------------------------------------------------

type Script = (t: number) => { phase?: FatiguePhase; gaze?: boolean; life?: boolean };
async function livelyRun(fps: number, seconds: number, script: Script, options: { sleepCard: boolean; lib: boolean }) {
  const g = await windowGene();
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
  face.setCard(card(options.sleepCard ? ['closeEyes', 'blush', 'mouth', 'sleepPose', 'drowsyFace'] : ['closeEyes', 'blush', 'mouth', 'drowsyFace']));
  const lively = new WindowLiveliness(() => {}, seeded(9)), scene = new Scene();
  scene.add(mesh);
  if (options.lib) { const lib = await loadLivelinessForEngine(); lively.life.load(lib); lively.sleep.load(lib); }
  lively.sleep.attach({ mesh, profile, baseY: 0, hasNeck: true });
  const frames: Quaternion[][] = [], roots: number[] = [], progress: number[] = [], props: number[] = [];
  let murmurs = 0;
  try {
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0, s = script(t);
      lively.life.set(s.life ?? false);
      if (s.gaze && i % Math.max(1, Math.round(fps / 10)) === 0) lively.gaze.set(YOU);
      face.setMood(faceView({ primary: 'calm', companion: null, phase: s.phase ?? 'awake', F: s.phase === 'awake' || !s.phase ? 0.2 : 0.9 }));
      lively.frame(dt, g.body, face, { view: faceView({ primary: 'calm', companion: null, phase: s.phase ?? 'awake', F: s.phase === 'awake' || !s.phase ? 0.2 : 0.9 }),
        rig, env: { shown: true, adjusting: false, voiced: false, speaking: false }, pointer: { x: 0.4, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false,
        breath: 0.5, pulled: false, handHeld: false, adjusting: false, thinking: false, camera: g.camera, lift: g.figure.floorUnits, width: WINDOW.width, height: WINDOW.height, scene });
      murmurs += lively.takeMurmurs().length;
      frames.push(g.rotations()); roots.push(Math.hypot(g.figure.placement.xM, g.figure.placement.depthM));
      const state = lively.sleep.getState() as { progress?: number; weight?: number; props?: { pillow: number; desk: number } | null } | null;
      progress.push((state?.progress ?? 0) * (state?.weight ?? 0)); props.push(Math.max(state?.props?.pillow ?? 0, state?.props?.desk ?? 0)); // what shows: progress × yield weight
    }
  } finally { g.close(); }
  const span = (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  const row = (from: number, to: number) => ({ step: max(frameSteps(span(from, to))), surprise: max(surprises(span(from, to)).perFrame) });
  return { frames, roots, progress, props, murmurs, row, span, choice: lively.sleep.getState() };
}

const SLEEP: Script = t => ({ phase: t < 3 ? 'awake' : t < 6 ? 'drowsy' : t < 22 ? 'falling-asleep' : t < 32 ? 'asleep' : 'awake' });
const SLEEP_SEGMENTS: [string, number, number][] = [['awake', 0.5, 3], ['drowsy', 3, 6], ['going down', 6, 22], ['asleep', 22, 32], ['getting up', 32, 46]];

for (const fps of [60, 30]) {
  test(`Gene, ${fps} fps: she falls asleep, lies down, sleeps and gets up again, every frame eased; she never walks`, async () => {
    const off = await livelyRun(fps, 46, SLEEP, { sleepCard: false, lib: true }), on = await livelyRun(fps, 46, SLEEP, { sleepCard: true, lib: true });
    const at = (t: number) => Math.round(t * fps);
    assert.ok(max(on.roots) < 1e-9, 'she never walks');
    assert.ok(on.progress[at(31)] > 1.5, `asleep: down in her sleep pose (progress ${on.progress[at(31)]})`);
    assert.ok(on.progress.at(-1)! < 0.1, `awake again: up (progress ${on.progress.at(-1)})`);
    assert.ok(max(off.progress) === 0, 'without 能做睡姿 she does not lie down');
    const idle = max(surprises(off.span(0.5, 46)).perFrame);
    const limit = fps === 60 ? 0.5 : 1.0;
    const rows = SLEEP_SEGMENTS.map(([name, from, to]) => ({ name, off: off.row(from, to), on: on.row(from, to) }));
    for (const r of rows) assert.ok(r.on.surprise < Math.max(limit, idle * 1.5), `${r.name}: unexpected step ${r.on.surprise.toFixed(3)}° (without the sleep layers ${r.off.surprise.toFixed(3)}°)`);
    const line = `  sleep ${fps} fps · ` + rows.map(r => `${r.name} step ${r.off.step.toFixed(3)}→${r.on.step.toFixed(3)}° surprise ${r.off.surprise.toFixed(3)}→${r.on.surprise.toFixed(3)}°`).join(' · ')
      + ` · props ${max(on.props).toFixed(2)} · choice ${JSON.stringify((on.choice as { choice?: unknown })?.choice ?? null)} · murmurs ${on.murmurs}`;
    if (REPORT) console.log(line); else console.log(line.slice(0, 300));
  });

  test(`Gene, ${fps} fps: procedural life on, and turning to you with pose sensing, ease like her idle`, async () => {
    const script: Script = t => ({ life: t >= 2, gaze: t >= 8 && t < 14 });
    const off = await livelyRun(fps, 18, () => ({}), { sleepCard: false, lib: true }), on = await livelyRun(fps, 18, script, { sleepCard: false, lib: true });
    const limit = fps === 60 ? 0.5 : 1.0, idle = max(surprises(off.frames).perFrame), HEAD = 4, at = (t: number) => Math.round(t * fps);
    const apart = (from: number, to: number) => max(on.frames.slice(at(from), at(to)).map((f, i) => f[HEAD].angleTo(off.frames[at(from) + i][HEAD]) * 180 / Math.PI));
    assert.ok(apart(4, 8) > 0.05, `procedural life moves her head (${apart(4, 8).toFixed(3)}°)`);
    assert.ok(apart(11, 14) > apart(4, 8) + 0.3, `pose sensing turns her head toward you (${apart(11, 14).toFixed(3)}°)`);
    const segments: [string, number, number][] = [['life fades in', 1.9, 4], ['life', 4, 8], ['turning to you', 8, 14], ['back to the cursor', 14, 18]];
    const rows = segments.map(([name, from, to]) => ({ name, off: off.row(from, to), on: on.row(from, to) }));
    for (const r of rows) assert.ok(r.on.surprise < Math.max(limit, idle * 1.5), `${r.name}: unexpected step ${r.on.surprise.toFixed(3)}° (plain ${r.off.surprise.toFixed(3)}°)`);
    const line = `  lively ${fps} fps · ` + rows.map(r => `${r.name} step ${r.off.step.toFixed(3)}→${r.on.step.toFixed(3)}° surprise ${r.off.surprise.toFixed(3)}→${r.on.surprise.toFixed(3)}°`).join(' · ')
      + ` · head apart: life ${apart(4, 8).toFixed(3)}°, toward you ${apart(11, 14).toFixed(3)}°`;
    if (REPORT) console.log(line); else console.log(line.slice(0, 300));
  });
}
