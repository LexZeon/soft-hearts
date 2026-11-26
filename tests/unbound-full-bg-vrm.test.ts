/**
 * I-154 follow-up, batches B and G (docs/claude/2026-11-21-unbound-full-BG.md) on a VRM: the synthetic full-face VRM (nothing from a real
 * model) on the full-screen page's own HerOut, through the laptop's world camera, at 60 and 30 fps. She is handed a snack (B: the window's
 * offer performer, her arm through the engine's reach on the standard skeleton, the prop in her hand), then falls asleep where she stands far
 * back (G: the sleep body on the standard skeleton, planned from the world camera, her pillow or desk beside her), sleeps, gets up. What is
 * drawn is the VRM's own bones (standard.present()). "Before": the same script on today's page (no games, no sleep layers).
 * FULL_BG_VRM_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { UNITS_PER_M, UnboundFigure } from '../src/unbound/figure';
import { applyWorldCamera } from '../src/unbound/camera';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { HerOut } from '../src/unbound/her/out-page';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { loadLivelinessForEngine } from '../src/stage';
import type { FatiguePhase } from '../shared/mood/fatigue';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { LAPTOP, laptopView } from './helpers/unbound-peek';
import { surprises, frameSteps } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';
import { faceView } from './helpers/window-face-fixture';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { syntheticStandardBody, trackedBones } from './helpers/unbound-vrm';

const REPORT = process.env.FULL_BG_VRM_REPORT === '1';
const DIP = { width: LAPTOP.workArea.width / LAPTOP.scaleFactor, height: LAPTOP.workArea.height / LAPTOP.scaleFactor };
Object.assign(globalThis, { innerWidth: Math.round(DIP.width), innerHeight: Math.round(DIP.height) }); // HerOut reads the window's size, as the page does
const HOME = { xM: 0.3, depthM: 9.5 };
const SECONDS = 46;
const phaseAt = (t: number): FatiguePhase => t < 8 ? 'awake' : t < 24 ? 'falling-asleep' : t < 32 ? 'asleep' : 'awake';
const SEGMENTS: [string, number, number][] = [['offer', 0.5, 7], ['going down', 8, 24], ['asleep', 24, 32], ['getting up', 32, SECONDS]];

function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, camera = new PerspectiveCamera(30, DIP.width / DIP.height, 0.05 * U, 400 * U);
  applyWorldCamera(camera, { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical',
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: HOME } as never, 0.05);
  return camera;
}

async function run(fps: number, after: boolean) {
  const standard = await syntheticStandardBody('1.0', syntheticVrm({ face: 'full' }));
  const measure = measureWindowModel(standard.mesh, standard, false);
  const figure = new UnboundFigure(standard.mesh, HOME);
  figure.faceToward({ x: 0, z: 0.55 });
  const shipped = await shippedIdle();
  const idle = new UnboundIdleLayer(async h => createBundledIdle(h, shipped, 7));
  idle.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const camera = laptopCamera(), world = new Scene();
  world.add(standard.mesh);
  const her = new HerOut({} as HTMLElement, null, { camera, pixels: () => 0, canTouch: () => true, scene: world, home: () => HOME }, random);
  her.attach(figure, measure, { reviewed: false, url: 'vrm' }, standard);
  if (after) her.sleep.load(await loadLivelinessForEngine());
  else her.sleep.attach(null); // before: no sleep layers out here
  const bones = trackedBones(standard), wrist = figure.mesh.skeleton.bones.find(b => b.name === '右手首')!;
  const frames: Quaternion[][] = [], times: number[] = [], roots: Vector3[] = [], progress: number[] = [], props: number[] = [], snack: number[] = [], log: string[] = [];
  let choice: string | null = null;
  try {
    for (let i = 0; i <= Math.round(fps * SECONDS); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      if (after && Math.abs(t - 1) < 0.5 / fps) her.games.stage.startGive({ id: 'g1', stage: 'hand', prop: 'snack', playful: false, picture: null, waitMs: 8000 }, (id, outcome) => log.push(`${id} ${outcome}`));
      if (after && Math.abs(t - 4) < 0.5 / fps) her.games.stage.takeGive();
      const view = faceView({ primary: 'calm', companion: null, phase: phaseAt(t), F: phaseAt(t) === 'awake' ? 0.2 : 0.9 });
      (her as unknown as { view: unknown }).view = view; her.face.setMood(view);
      const faced = her.frame(dt, idle.wrap(figure), { shown: true, adjusting: false, voiced: false, speaking: false, walking: figure.walking, breath: 0.5, pointer: null });
      idle.frame(dt, idleWanted({ performing: faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }));
      figure.frame(dt);
      standard.present();
      her.after(DIP.width, DIP.height);
      standard.mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion()))); times.push(t); roots.push(standard.mesh.position.clone().multiplyScalar(1 / UNITS_PER_M));
      const state = her.sleep.sleep.getState() as { progress?: number; weight?: number; props?: { pillow: number; desk: number } | null; choice?: string } | null;
      progress.push((state?.progress ?? 0) * (state?.weight ?? 0)); props.push(Math.max(state?.props?.pillow ?? 0, state?.props?.desk ?? 0));
      if (state?.choice && state.choice !== 'stand') choice = state.choice;
      const prop = world.getObjectByName('give-props')?.children[0];
      snack.push(prop?.visible ? prop.getWorldPosition(new Vector3()).distanceTo(wrist.getWorldPosition(new Vector3())) / (figure.heightM * UNITS_PER_M) : -1);
    }
  } finally { her.dispose(); figure.dispose(); standard.dispose(); }
  const span = (from: number, to: number) => frames.filter((_, i) => times[i] >= from && times[i] <= to);
  const row = (from: number, to: number) => ({ step: max(frameSteps(span(from, to))), surprise: max(surprises(span(from, to)).perFrame) });
  return { frames, times, roots, progress, props, snack, log, choice, row };
}

for (const fps of [60, 30]) {
  test(`full-screen VRM, ${fps} fps: a snack handed over, then asleep far back with her pillow or desk, up again; every frame eased, she never slides`, async () => {
    const before = await run(fps, false), after = await run(fps, true);
    const at = (t: number) => after.times.findIndex(x => x >= t);
    assert.deepEqual(after.log, ['g1 taken'], 'the offer ended taken');
    assert.ok(after.snack.some(d => d >= 0 && d < 0.12), `the snack in her hand (${Math.min(...after.snack.filter(d => d >= 0)).toFixed(3)} of her height)`);
    assert.ok(after.progress[at(31)] > 0.5, `asleep in her pose (${after.progress[at(31)].toFixed(2)}, ${after.choice})`);
    assert.ok(after.progress.at(-1)! < 0.1, 'up again');
    assert.ok(max(after.props) > 0.9, `her ${after.choice} shows`);
    assert.equal(max(before.progress), 0);
    const drift = max(after.roots.map(p => p.distanceTo(after.roots[0]) * 100));
    assert.ok(drift < 3, `she stays at her place throughout (${drift.toFixed(2)} cm)`);
    assert.ok(after.frames.every(f => f.every(q => Number.isFinite(q.x) && Number.isFinite(q.w))), 'no broken bone');
    const limit = fps === 60 ? 0.5 : 1.0;
    const rows = SEGMENTS.map(([name, from, to]) => ({ name, before: before.row(from, to), after: after.row(from, to) }));
    for (const r of rows) assert.ok(r.after.surprise < Math.max(limit, r.before.surprise * 1.5), `${r.name}: unexpected step ${r.after.surprise.toFixed(3)}° (before ${r.before.surprise.toFixed(3)}°)`);
    const line = `  full VRM ${fps} fps · ` + rows.map(r => `${r.name} step ${r.before.step.toFixed(3)}→${r.after.step.toFixed(3)}° surprise ${r.before.surprise.toFixed(3)}→${r.after.surprise.toFixed(3)}°`).join(' · ')
      + ` · choice ${after.choice} · props ${max(after.props).toFixed(2)} · root drift ${drift.toFixed(2)} cm`;
    console.log(REPORT ? line : line.slice(0, 400));
  });
}
