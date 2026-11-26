/**
 * I-154 follow-up, batch B (docs/claude/2026-11-21-unbound-full-BG.md): 猜拳, 递东西 and 牵手 out in full-screen Unbound, on the bundled public
 * Gene in the page's own frame order (her own life → the games' clocks → her face with the games' arms over the owners → the idle layer →
 * her frame → the games' props), through the laptop's real world camera, at 60 and 30 fps.
 *
 * "Before" is today's full-screen page (no games: the same script's game calls are not made, she keeps doing what she did); "after" is this
 * batch. Measured: her arm, hand, fingers and upper body, per-frame step and unexpected step (R29c); the root and her planted feet (no slide);
 * that a walk of hers brakes to a stop when a game starts (her own life gives way), and that what the game needs shows (the raised hand, the
 * snack in her hand, her hand toward your cursor, the click targets).
 * FULL_GAMES_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { RPS_TIMING as T, type RpsHand, type RpsPhase, type RpsView } from '../shared/initiative/rps';
import { NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import { UNITS_PER_M } from '../src/unbound/figure';
import { applyWorldCamera } from '../src/unbound/camera';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { LifePlayer } from '../src/unbound/life/player';
import { LIFE_ACTION_IDS } from '../shared/unbound/life/registry';
import type { LifePlan } from '../shared/unbound/life/types';
import { HerOutFace } from '../src/unbound/her/out-face';
import { HerOutGames, withOutGames, type GamesStage } from '../src/unbound/her/out-games';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { geneFigure, max, plantedDrift, type FootShown } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { LAPTOP, laptopLens, laptopView } from './helpers/unbound-peek';
import { surprises, frameSteps } from './helpers/unbound-window';

const REPORT = process.env.FULL_GAMES_REPORT === '1';
const DEG = 180 / Math.PI;
const DIP = { width: LAPTOP.workArea.width / LAPTOP.scaleFactor, height: LAPTOP.workArea.height / LAPTOP.scaleFactor };
const HOME = { xM: 0.3, depthM: 4 };
const ARM = ['右肩', '右腕', '右ひじ', '右手首'], FINGERS = ['右人指１', '右人指２', '右中指１', '右中指２', '右小指１'], BODY = ['上半身', '上半身2', '首', '頭'];
const MEASURED = [...BODY, ...ARM, ...FINGERS];

function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, camera = new PerspectiveCamera(30, DIP.width / DIP.height, 0.05 * U, 400 * U);
  applyWorldCamera(camera, { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical',
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: HOME } as never, 0.05);
  return camera;
}
function view(phase: RpsPhase, round: number, extra: Partial<RpsView> = {}): RpsView {
  return { id: 'm1', revision: 1, phase, round, score: { her: 0, user: 0 }, firstTo: 2, accepting: phase === 'ready' || phase === 'count' || phase === 'wait',
    commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'nervous', tease: null, beatMs: T.beatMs,
    phaseMs: 0, elapsedMs: 0, result: null, ...extra } as RpsView;
}
const revealed = (hand: RpsHand) => ({ hand, intent: 'fair' as const, nonce: 'n' });
const walkPlan = (xM: number, depthM: number): LifePlan => ({ action: 'place', level: 'place', keys: [{ t: 0 }], walk: { xM, depthM, speedMps: 0.5 }, amplitude: 1, easeS: 1, waitQuickS: 0 });

interface Scene_ { seconds: number; walk?: boolean; pointer(t: number): { x: number; y: number } | null; script(stage: GamesStage, t: number, log: string[]): void }
const once = (fn: (stage: GamesStage, log: string[]) => void) => { let done = false; return (stage: GamesStage, t: number, log: string[], at: number) => { if (!done && t >= at) { done = true; fn(stage, log); } }; };
/** She is walking across when the game starts (at 2 s): her walk brakes, then the game as on the window (the window's script, 1 s later). */
function rpsScene(): Scene_ {
  const reveal = 3.8 + (T.leadMs + 2 * T.beatMs) / 1000;
  const steps = [once(s => s.setRps(view('ready', 1, { phaseMs: T.readyMs }))), once(s => s.setRps(view('count', 1))),
    once(s => s.setRps(view('reveal', 1, { revealed: revealed('paper'), userHand: 'rock', outcome: 'her', face: 'smug' }))),
    once(s => s.setRps(view('end', 1, { revealed: revealed('paper'), face: 'happy' }))), once(s => s.setRps(null))];
  const at = [2, 3.8, reveal, reveal + T.reactMs / 1000, reveal + T.reactMs / 1000 + 2.4];
  return { seconds: 12, walk: true, pointer: () => ({ x: 0.1, y: -0.1 }), script: (stage, t, log) => steps.forEach((step, i) => step(stage, t, log, at[i])) };
}
function giveScene(): Scene_ {
  const start = once((s, log) => s.startGive({ id: 'g1', stage: 'hand', prop: 'snack', playful: false, picture: null, waitMs: 8000 }, (id, outcome) => log.push(`${id} ${outcome}`)));
  const take = once(s => { s.takeGive(); });
  return { seconds: 8, pointer: () => ({ x: 0.1, y: -0.1 }), script: (stage, t, log) => { start(stage, t, log, 1); take(stage, t, log, 4); } };
}
function handsScene(): Scene_ {
  const start = once(s => { s.startHands({ use: 'hold', style: { ...NEUTRAL_HAND_STYLE, swing: 0.6 } }); });
  const hold = once(s => s.handsCommand('hold')), squeeze = once(s => s.handsCommand('squeeze')), release = once(s => s.handsCommand('release'));
  // Your cursor near her (she stands right of centre, 4 m in): where her hand reaches.
  return { seconds: 9, pointer: t => t < 5 ? { x: 0.02, y: -0.35 } : { x: 0.02 + 0.06 * Math.sin((t - 5) * 1.1), y: -0.35 + 0.05 * Math.sin((t - 5) * 0.7) },
    script: (stage, t, log) => { start(stage, t, log, 1); hold(stage, t, log, 3.5); squeeze(stage, t, log, 5); release(stage, t, log, 6.5); const s = stage.handsState(); if (s && log.at(-1) !== s.phase) log.push(s.phase); } };
}

interface Run { times: number[]; frames: Quaternion[][]; root: Vector3[]; feet: FootShown[][]; walking: boolean[]; wristUp: number[]; anchors: boolean[]; prop: number[]; log: string[]; starts: number; stopAt: number | null }

async function run(fps: number, scene: Scene_, withGames: boolean): Promise<Run> {
  const { fixture, figure } = await geneFigure({ xM: HOME.xM, depthM: HOME.depthM });
  const mesh = fixture.mesh, measured = measureWindowModel(mesh, null, true);
  figure.faceToward({ x: 0, z: 0.55 });
  const shipped = await shippedIdle();
  const idle = new UnboundIdleLayer(async h => createBundledIdle(h, shipped, 7));
  idle.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const face = new HerOutFace(random);
  face.attach({ body: figure, mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
  const camera = laptopCamera(), lens = laptopLens(), world = new Scene();
  const games = new HerOutGames(world, () => ({ camera, width: DIP.width, height: DIP.height }));
  games.attach(mesh);
  const life = new LifePlayer(LIFE_ACTION_IDS, () => {}, () => idle.quickBusy);
  if (withGames) games.onStart = () => life.yieldNow();
  const bones = MEASURED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const wrist = mesh.skeleton.bones.find(b => b.name === '右手首')!, chest = mesh.skeleton.bones.find(b => b.name === '上半身2')!;
  const out: Run = { times: [], frames: [], root: [], feet: [], walking: [], wristUp: [], anchors: [], prop: [], log: [], starts: 0, stopAt: null };
  const m = 1 / UNITS_PER_M;
  let pointer: { x: number; y: number } | null = null, nextRead = 0;
  try {
    for (let i = 0; i <= Math.round(fps * scene.seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      if (t >= nextRead) { pointer = scene.pointer(t); nextRead = t + 0.1; }
      if (scene.walk && Math.abs(t - 1) < 0.5 / fps) life.command({ type: 'start', id: 'w', plan: walkPlan(-0.9, HOME.depthM), trial: false });
      if (withGames) scene.script(games.stage, t, out.log);
      const owners = face.wrap(idle.wrap(figure));
      life.frame(dt, { lens }, owners, { walking: figure.walking, moving: figure.moving, heightM: figure.heightM, placement: figure.placement }, false);
      const frame = withGames ? games.frame(dt, { pointer }) : null;
      const faced = face.frame(dt, idle.wrap(figure), { shown: true, adjusting: false, voiced: false, speaking: false, walking: figure.walking, nowMs: 1e6 + t * 1000 },
        (f, owner) => withOutGames(f, frame, owner));
      idle.frame(dt, idleWanted({ performing: faced.performing || games.busy, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }), life.idleRate);
      figure.frame(dt);
      if (withGames) games.after();
      mesh.updateMatrixWorld(true);
      const report = figure.report!;
      out.times.push(t); out.frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      out.root.push(mesh.position.clone().multiplyScalar(m)); out.walking.push(figure.walking);
      out.feet.push(report.feet.map(f => ({ planted: f.planted, pitch: f.pitch, ankle: f.ankle.clone().multiplyScalar(m), toe: f.toe?.clone().multiplyScalar(m) ?? null, target: f.target.clone().multiplyScalar(m), ik: f.ikWorld.clone().multiplyScalar(m) })));
      out.wristUp.push((wrist.getWorldPosition(new Vector3()).y - chest.getWorldPosition(new Vector3()).y) / figure.heightUnits);
      out.anchors.push(!!(games.stage.handsAnchor() ?? games.stage.giveAnchor()));
      const prop = world.getObjectByName('give-props')?.children[0];
      out.prop.push(prop?.visible ? prop.getWorldPosition(new Vector3()).distanceTo(wrist.getWorldPosition(new Vector3())) / figure.heightUnits : -1);
    }
    out.starts = games.starts;
    // Stopped: from here on her root stays within 0.5 cm for at least half a second (her turn back to you steps in place).
    if (scene.walk) for (let i = out.times.findIndex(t => t > 2); i >= 0 && i < out.times.length; i++) {
      const end = out.times.findIndex(t => t >= out.times[i] + 0.5);
      if (end < 0) break;
      if (out.root.slice(i, end + 1).every(p => p.distanceTo(out.root[i]) < 0.005)) { out.stopAt = out.times[i]; break; }
    }
  } finally { games.dispose(); face.attach(null); figure.dispose(); fixture.close(); }
  return out;
}

function measure(r: Pick<Run, 'times' | 'frames'>, set: readonly string[], from = 0.5, to = Infinity) {
  const index = set.map(name => MEASURED.indexOf(name));
  const frames = r.frames.filter((_, i) => r.times[i] >= from && r.times[i] <= to).map(f => index.map(k => f[k]));
  return { step: max(frameSteps(frames)), surprise: max(surprises(frames).perFrame) };
}
const fmt = (n: number) => n.toFixed(3);
/**
 * The deleted old stage's unexpected steps (degrees) for the same three scenes, as measured on its real frame loop when the window engine
 * took the games over (docs/claude/2026-11-20-unbound-window-batch4.md, the left number of each pair). The old stage is gone (I-176 step 3);
 * these stay as the reference. Per frame rate, scene and measured set.
 */
const OLD_STAGE_SURPRISE = {
  60: { rps: { 'arm+body': 0.328, fingers: 0.849 }, give: { 'arm+body': 0.106, fingers: 0.106 }, hands: { 'arm+body': 0.089, fingers: 0.364 } },
  30: { rps: { 'arm+body': 1.111, fingers: 3.362 }, give: { 'arm+body': 0.421, fingers: 0.421 }, hands: { 'arm+body': 0.363, fingers: 1.433 } },
} as const;

const SCENES: [string, () => Scene_][] = [['rps', rpsScene], ['give', giveScene], ['hands', handsScene]];

for (const fps of [60, 30] as const) {
  for (const [name, make] of SCENES) {
    test(`full-screen Gene, ${fps} fps, ${name}: her arm, hand and body ease (step and unexpected step, before and after), her feet do not slide`, async () => {
      const before = await run(fps, make(), false), after = await run(fps, make(), true);
      const rows = ([['arm+body', [...ARM, ...BODY]], ['fingers', FINGERS]] as const).map(([label, set]) => ({ label, before: measure(before, set), after: measure(after, set) }));
      // Her feet: from the moment she stands for the game (rps: after her walk braked) to the end, planted feet stay put.
      const from = name === 'rps' ? (after.stopAt ?? 99) : 0.5, fromIndex = after.times.findIndex(t => t >= from);
      const shown = after.feet.map((feet, i) => ({ feet, root: after.root[i] })).slice(fromIndex) as unknown as Parameters<typeof plantedDrift>[0];
      const drift = plantedDrift(shown, after.feet[0][0].ankle.y);
      const rootMove = max(after.root.slice(fromIndex).map(p => p.distanceTo(after.root[fromIndex]) * 100));
      const line = `  full ${name} ${fps} fps · ` + rows.map(r => `${r.label}: step ${fmt(r.before.step)}→${fmt(r.after.step)}° surprise ${fmt(r.before.surprise)}→${fmt(r.after.surprise)}° `).join(' · ')
        + ` · planted toe drift ${drift.toeDrift.toFixed(2)} cm · root after standing ${rootMove.toFixed(2)} cm` + (name === 'rps' ? ` · stopped ${after.stopAt?.toFixed(2)} s (before: walking at 3 s ${before.walking[before.times.findIndex(t => t >= 3)]})` : '');
      console.log(REPORT ? line : line.slice(0, 400));
      for (const r of rows) {
        const floor = r.label === 'fingers' ? (fps === 60 ? 1.5 : 5) : (fps === 60 ? 0.5 : 1.0);
        assert.ok(r.after.surprise <= Math.max(floor, OLD_STAGE_SURPRISE[fps][name as 'rps' | 'give' | 'hands'][r.label as 'arm+body' | 'fingers'] * 1.25, r.before.surprise * 1.5), `${r.label}: unexpected step ${fmt(r.after.surprise)}° (before ${fmt(r.before.surprise)}°)`);
      }
      assert.ok(drift.toeDrift < 1.5, `planted feet stay put (${drift.toeDrift.toFixed(2)} cm)`);
      assert.equal(after.starts, 1, 'one start told the page');
      if (name === 'rps') {
        assert.ok(after.stopAt !== null && after.stopAt < 4.5, `her walk braked to a stop when the game started (${after.stopAt})`);
        assert.ok(rootMove < 5, `she stays where she stopped: at most her turn back to you, a step in place (${rootMove.toFixed(2)} cm)`);
        assert.ok(before.walking[before.times.findIndex(t => t >= 3)], 'without the game she was still walking');
        assert.ok(max(after.wristUp.slice(after.times.findIndex(t => t >= 4.5), after.times.findIndex(t => t >= 6))) > 0.02, 'her hand is up for the count');
        assert.ok(after.wristUp.at(-1)! < 0, 'her hand is down again after the game');
      }
      if (name === 'give') {
        assert.deepEqual(after.log, ['g1 taken']);
        assert.ok(after.prop.some(d => d >= 0 && d < 0.1), 'the snack is in her hand');
        assert.ok(after.anchors.some(Boolean), 'the target on what she holds out');
      }
      if (name === 'hands') {
        assert.ok(after.log.includes('out') && after.log.includes('held'), `she held your hand (${after.log.join(' ')})`);
        assert.ok(after.anchors.some(Boolean), 'the target on her hand');
        assert.equal(after.log.at(-1), 'idle', 'let go, back to idle');
      }
    });
  }
}
