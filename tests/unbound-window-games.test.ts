/**
 * I-154 batch 4 (docs/claude/2026-11-20-unbound-window-batch4.md): rows 26 猜拳, 27 递东西, 28 牵手、拉钩、击掌 and 慢慢眨眼 on the window
 * engine. The gates (as on the old stage), the arm layering, the slow blink, and each scene on the real Gene frame loop at 60 and 30 fps,
 * measured against the same scene on the old stage's real frame loop (tests/helpers/gene-stage-harness.ts): per-frame step and
 * unexpected step (R29c) of her arm, hand, fingers and upper body. WINDOW_BATCH4_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Scene, Vector3 } from 'three';
import { RPS_TIMING as T, type RpsHand, type RpsPhase, type RpsView } from '../shared/initiative/rps';
import { NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import { WindowGames, stack } from '../src/unbound/window-mode/window-games';
import { WindowOwnLife } from '../src/unbound/window-mode/window-own-life';
import { withGames } from '../src/unbound/window-mode/window-liveliness';
import { WindowStageGames } from '../src/unbound/window-mode/window-stage-games';
import { SLOW_BLINK, slowBlinkAt, WindowBeats } from '../src/unbound/window-mode/window-beats';
import { WindowLife } from '../src/unbound/window-mode/window-life';
import type { WindowFaceFrame } from '../src/unbound/window-mode/window-face';
import type { PerformerArmAim } from '../src/initiative';
import { blinkCurve } from '../src/unbound/motion/own-moves';
import { surprises, frameSteps, windowGene, WINDOW } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';

const REPORT = process.env.WINDOW_BATCH4_REPORT === '1';
const DEG = 180 / Math.PI;
const Z = { pitch: 0, yaw: 0, roll: 0 };
const NEUTRAL_FACE: WindowFaceFrame = { expr: {}, exprNamed: {}, head: Z, torso: Z, hands: null, lids: 0, softLids: 0, ownsPat: false,
  blush: 0, blushPath: 'none', blushSize: 50, gaze: { pull: 1, x: 0, y: 0, strength: 1, allowed: true, eyeYaw: 0, eyePitch: 0 } };

function view(phase: RpsPhase, round: number, extra: Partial<RpsView> = {}): RpsView {
  return { id: 'm1', revision: 1, phase, round, score: { her: 0, user: 0 }, firstTo: 2, accepting: phase === 'ready' || phase === 'count' || phase === 'wait',
    commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'nervous', tease: null, beatMs: T.beatMs,
    phaseMs: 0, elapsedMs: 0, result: null, ...extra } as RpsView;
}
const revealed = (hand: RpsHand) => ({ hand, intent: 'fair' as const, nonce: 'n' });
const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z).normalize();
const aim = (side: 'left' | 'right', weight: number, upper: Vector3): PerformerArmAim => ({ side, weight, upper, fore: v3(0, 1, 0.2), hand: v3(0, 1, 0), palm: v3(0, 0, 1), fingers: null });

// ---- the gates and the layering (pure) ---------------------------------------------------------------------------------------
test('stack: one arm is its own target; a later one is laid over the earlier by its own weight (the old stage\'s write order), never a jump', () => {
  assert.equal(stack([]), null);
  assert.equal(stack([aim('right', 0, v3(0, -1, 0))]), null, 'a zero weight is nothing');
  const one = stack([aim('right', 0.4, v3(0, -1, 0))])!;
  assert.equal(one.pose, 'aim'); assert.equal(one.weight, 0.4); assert.ok(Math.abs(one.aim!.upper.y + 1) < 1e-9);
  const both = stack([aim('right', 0.5, v3(0, -1, 0)), aim('right', 0.5, v3(1, 0, 0))])!;
  assert.ok(Math.abs(both.weight - 0.75) < 1e-9, 'W = 1 − (1 − ½)(1 − ½)');
  // The upper's share is w₂ / W = 2/3: the direction is between, nearer the later arm.
  assert.ok(both.aim!.upper.x > -both.aim!.upper.y && both.aim!.upper.y < 0, `between, nearer the later (${JSON.stringify(both.aim!.upper)})`);
  const under = stack([aim('right', 1, v3(0, -1, 0)), aim('right', 0.001, v3(1, 0, 0))])!;
  assert.ok(under.aim!.upper.y < -0.99, 'a later arm just starting barely moves it');
});

test('games gates (the old stage\'s): no reach for your mouse while the game or an offer holds her arm; her arms count as held', () => {
  const games = new WindowGames(new Scene());
  assert.equal(games.busy, false); assert.equal(games.armsHeld(false), false); assert.equal(games.armsHeld(true), true, 'a pull');
  games.setRps(view('ready', 1));
  assert.equal(games.busy, true); assert.equal(games.armsHeld(false), true, 'the game holds her arm: a beat\'s hand does not start');
  assert.equal(games.startHands({ use: 'hold', style: NEUTRAL_HAND_STYLE }), false, 'not during the game');
  assert.equal(games.handsNear(null), false);
  games.setRps(null);
  for (let i = 0; i < 400; i++) games.frame(1 / 60, { mesh: null, pointer: { x: 0, y: 0 }, follow: true, camera: null });
  assert.equal(games.busy, false, 'the game eased out');
  games.startGive({ id: 'g1', stage: 'hand', prop: 'snack', playful: false, picture: null, waitMs: 5000 });
  assert.equal(games.startHands({ use: 'hold', style: NEUTRAL_HAND_STYLE }), false, 'not during an offer');
  games.withdrawGive('interrupted');
  for (let i = 0; i < 400; i++) games.frame(1 / 60, { mesh: null, pointer: { x: 0, y: 0 }, follow: true, camera: null });
  assert.equal(games.startHands({ use: 'hold', style: NEUTRAL_HAND_STYLE }), true, 'free again');
  assert.equal(games.armsHeld(false), true, 'her reach holds her arm');
  games.dispose();
});

test('withGames: the games\' arm replaces a beat\'s hand on its side only; the reach\'s lean adds to her upper body', () => {
  const beat = { weight: 1, pose: 'vsign' as const, wave: 0 }, game = stack([aim('right', 0.6, v3(0, -1, 0))])!;
  const face = { ...NEUTRAL_FACE, hands: { left: beat, right: beat }, torso: { pitch: 0.1, yaw: 0, roll: 0 } };
  const out = withGames(face, { hands: { left: null, right: game }, activity: null, torso: { pitch: 0.02, yaw: -0.03, roll: 0 }, head: false });
  assert.equal(out.hands!.left, beat); assert.equal(out.hands!.right, game);
  assert.ok(Math.abs(out.torso.pitch - 0.12) < 1e-9 && Math.abs(out.torso.yaw + 0.03) < 1e-9);
  assert.equal(withGames(face, null), face, 'no games: unchanged');
});

test('her picture for an offer is never taken while she is hidden (the model is not even asked)', () => {
  let asked = 0;
  class Probe extends WindowStageGames {
    protected readonly games = new WindowGames(null);
    shown = false;
    protected gameView() { return { camera: null as never, width: 420, height: 640, shown: this.shown }; }
    protected pictureParts() { asked++; return null; }
    protected readonly ownLife = new WindowOwnLife({ face: () => null as never, hasFace: () => false }); // batch 6: the music members sit under the games'
    protected musicView() { return null; }
    // Batch 7: the previews' members sit under the music's (window-stage-previews.ts).
    protected startCapability() { return false; }
    protected authoring() { return null; }
    protected async captureParts() { return null; }
    protected modelGenerationNow() { return 0; }
    protected previewWake() {}
  }
  const probe = new Probe();
  assert.equal(probe.captureGivePicture(), null);
  assert.equal(asked, 0, 'hidden: not rendered');
  probe.shown = true;
  assert.equal(probe.captureGivePicture(), null);
  assert.equal(asked, 1, 'shown: rendered (no model here, so none)');
});

// ---- 慢慢眨眼 ----------------------------------------------------------------------------------------------------------------
test('slow blink: one slow, soft blink, gentler than a natural one, then soft lids for the beat; refused asleep or hidden; no natural blink over it', () => {
  for (const fps of [60, 30]) {
    const d = 1 / fps, curve: number[] = [], natural: number[] = [];
    for (let i = 0; i <= fps; i++) { curve.push(slowBlinkAt(i * d)); natural.push(blinkCurve(i * d, 0)); }
    assert.ok(max(curve) > 0.99, 'it closes');
    assert.ok(max(frameStepsOf(curve)) < max(frameStepsOf(natural)) * 0.7, `slower than a natural blink (${max(frameStepsOf(curve)).toFixed(3)} vs ${max(frameStepsOf(natural)).toFixed(3)} per frame)`);
    assert.equal(curve.at(-1), 0, 'and opens again');
  }
  const beats = new WindowBeats();
  assert.equal(beats.play('blink-slow', { shown: true, asleep: true, armsHeld: false }), false, 'asleep: none');
  assert.equal(beats.play('blink-slow', { shown: false, asleep: false, armsHeld: false }), false, 'hidden: none');
  assert.equal(beats.play('blink-slow', { shown: true, asleep: false, armsHeld: false }, true), true);
  const frames = Array.from({ length: 180 }, () => beats.frame(1 / 60, { armsHeld: false }));
  assert.ok(max(frames.map(f => f.blink)) > 0.99 && frames[50].blink === 0, 'the blink, early');
  assert.ok(Math.abs(frames[150].softLids - SLOW_BLINK.soft) < 1e-6, 'held soft lids while she speaks');
  assert.ok(max(frameStepsOf(frames.map(f => f.softLids))) < 0.015, 'eased in');
  beats.releaseSpan();
  const after = Array.from({ length: 120 }, () => beats.frame(1 / 60, { armsHeld: false }));
  assert.ok(after[0].softLids > 0.1 && after.at(-1)!.softLids === 0 && max(frameStepsOf(after.map(f => f.softLids))) < 0.01, 'falls when her speaking ends');
  // The window's lids: shown over the natural one; no natural blink starts on top of it.
  const life = new WindowLife(() => 0.5);
  const lids: number[] = [];
  for (let i = 0; i < 600; i++) {
    const performed = i >= 120 && i < 160 ? slowBlinkAt((i - 120) / 60) : 0;
    lids.push(life.frame({ dt: 1 / 60, pointer: null, eyes: null, follow: false, pat: false, face: { lids: 0, softLids: 0, ownsPat: false, blink: performed,
      gaze: { pull: 1, x: 0, y: 0, strength: 1, allowed: true, eyeYaw: 0, eyePitch: 0 } } }).blink);
  }
  assert.ok(max(lids.slice(120, 160)) > 0.99, 'shown');
  const rises = lids.map((v, i) => i > 0 && v > 0.5 && lids[i - 1] <= 0.5 ? i : -1).filter(i => i >= 0);
  assert.ok(rises.filter(i => i >= 120 && i < 160 + 60 * 3.2 * 0.5).length === 1, `only the slow blink itself: no natural one on it or right after (${rises.join(", ")})`);
});
const frameStepsOf = (values: readonly number[]) => values.slice(1).map((v, i) => Math.abs(v - values[i]));

// ---- the scenes on the real Gene, window engine vs the old stage -------------------------------------------------------------
type Port = Pick<WindowGames, 'setRps' | 'startGive' | 'takeGive' | 'withdrawGive' | 'startHands' | 'handsCommand' | 'handsState'>;
interface Scene_ { seconds: number; pointer(t: number): { x: number; y: number }; script(port: Port, t: number, log: string[]): void }
/** Her arm, hand, fingers and upper body (the right hand is the one the games use on Gene). */
const ARM = ['右肩', '右腕', '右ひじ', '右手首'], FINGERS = ['右人指１', '右人指２', '右中指１', '右中指２', '右小指１'], BODY = ['上半身', '上半身2', '首', '頭'];
const MEASURED = [...BODY, ...ARM, ...FINGERS];

const once = (fn: (port: Port, log: string[]) => void) => { let done = false; return (port: Port, t: number, log: string[], at: number) => { if (!done && t >= at) { done = true; fn(port, log); } }; };
function rpsScene(): Scene_ {
  const reveal = 2.8 + (T.leadMs + 2 * T.beatMs) / 1000;
  const steps = [once(p => p.setRps(view('ready', 1, { phaseMs: T.readyMs }))), once(p => p.setRps(view('count', 1))),
    once(p => p.setRps(view('reveal', 1, { revealed: revealed('paper'), userHand: 'rock', outcome: 'her', face: 'smug' }))),
    once(p => p.setRps(view('end', 1, { revealed: revealed('paper'), face: 'happy' }))), once(p => p.setRps(null))];
  const at = [1, 2.8, reveal, reveal + T.reactMs / 1000, reveal + T.reactMs / 1000 + 2.4];
  return { seconds: 11, pointer: () => ({ x: 0, y: 0.1 }), script: (port, t, log) => steps.forEach((step, i) => step(port, t, log, at[i])) };
}
function giveScene(): Scene_ {
  const start = once((p, log) => p.startGive({ id: 'g1', stage: 'hand', prop: 'snack', playful: false, picture: null, waitMs: 8000 }, (id, outcome) => log.push(`${id} ${outcome}`)));
  const take = once(p => { p.takeGive(); });
  return { seconds: 8, pointer: () => ({ x: 0, y: 0.1 }), script: (port, t, log) => { start(port, t, log, 1); take(port, t, log, 4); } };
}
function handsScene(): Scene_ {
  const start = once(p => { p.startHands({ use: 'hold', style: { ...NEUTRAL_HAND_STYLE, swing: 0.6 } }); });
  const hold = once(p => p.handsCommand('hold')), squeeze = once(p => p.handsCommand('squeeze')), release = once(p => p.handsCommand('release'));
  return { seconds: 9, pointer: t => t < 5 ? { x: -0.35, y: -0.2 } : { x: -0.35 + 0.2 * Math.sin((t - 5) * 1.1), y: -0.2 + 0.15 * Math.sin((t - 5) * 0.7) },
    script: (port, t, log) => { start(port, t, log, 1); hold(port, t, log, 3.5); squeeze(port, t, log, 5); release(port, t, log, 6.5); const s = port.handsState(); if (s && log.at(-1) !== s.phase) log.push(s.phase); } };
}

interface Run { near: boolean[]; frames: Quaternion[][]; times: number[]; log: string[]; wristY: number[]; chestY: number[]; anchors: ({ x: number; y: number } | null)[]; wristScreen: { x: number; y: number }[]; prop: number[] }

async function windowRun(fps: number, scene: Scene_ | null, extra?: (g: Awaited<ReturnType<typeof windowGene>>, t: number) => void): Promise<Run> {
  const g = await windowGene();
  const stageScene = new Scene();
  const games = new WindowGames(stageScene);
  const bones = MEASURED.map(name => g.fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const wrist = g.fixture.mesh.skeleton.bones.find(b => b.name === '右手首')!, chest = g.fixture.mesh.skeleton.bones.find(b => b.name === '上半身2')!;
  const run: Run = { near: [], frames: [], times: [], log: [], wristY: [], chestY: [], anchors: [], wristScreen: [], prop: [] };
  try {
    let pointer = { x: 0, y: 0 }, nextRead = 0;
    for (let i = 0; i <= Math.round(fps * (scene?.seconds ?? 9)); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      if (scene && t >= nextRead) { pointer = scene.pointer(t); nextRead = t + 0.1; }
      if (scene) scene.script(games, t, run.log);
      extra?.(g, t);
      const frame = games.frame(dt, { mesh: g.figure.mesh, pointer, follow: true, camera: g.camera });
      g.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: withGames(NEUTRAL_FACE, frame) });
      games.after(g.camera);
      g.fixture.mesh.updateMatrixWorld(true);
      run.frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion()))); run.times.push(t);
      run.wristY.push(wrist.getWorldPosition(new Vector3()).y); run.chestY.push(chest.getWorldPosition(new Vector3()).y);
      run.anchors.push(games.handsAnchor(g.camera, WINDOW.width, WINDOW.height) ?? games.giveAnchor(g.camera, WINDOW.width, WINDOW.height));
      run.wristScreen.push(g.screenOf('右手首'));
      run.near.push(games.handsNear(g.camera));
      const prop = stageScene.getObjectByName('give-props')?.children[0];
      run.prop.push(prop?.visible ? prop.getWorldPosition(new Vector3()).distanceTo(wrist.getWorldPosition(new Vector3())) / g.figure.heightUnits : -1);
    }
  } finally { games.dispose(); g.close(); }
  return run;
}

/** Largest step and unexpected step (°) over [from, to] s, for a bone set (indices into MEASURED). */
function measure(run: Run, set: readonly string[], from = 0.5, to = Infinity) {
  const index = set.map(name => MEASURED.indexOf(name));
  const frames = run.frames.filter((_, i) => run.times[i] >= from && run.times[i] <= to).map(f => index.map(k => f[k]));
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
    test(`Gene, ${fps} fps, ${name}: the window engine's arm, hand and body ease (step and unexpected step, against the same run without the game)`, async () => {
      const win = await windowRun(fps, make()), idle = await windowRun(fps, null);
      const rows = ([['arm+body', [...ARM, ...BODY]], ['fingers', FINGERS]] as const).map(([label, set]) => ({ label,
        win: measure(win, set), winIdle: measure(idle, set) }));
      const line = `  ${name} ${fps} fps · ` + rows.map(r => `${r.label}: window step ${fmt(r.win.step)}° surprise ${fmt(r.win.surprise)}° (idle ${fmt(r.winIdle.surprise)}°)`).join(' · ');
      console.log(REPORT ? line : line.slice(0, 400));
      for (const r of rows) {
        const floor = r.label === 'fingers' ? (fps === 60 ? 1.5 : 5) : (fps === 60 ? 0.5 : 1.0);
        assert.ok(r.win.surprise <= Math.max(floor, OLD_STAGE_SURPRISE[fps][name as 'rps' | 'give' | 'hands'][r.label as 'arm+body' | 'fingers'] * 1.25, r.winIdle.surprise * 1.5), `${r.label}: unexpected step ${fmt(r.win.surprise)}° (idle ${fmt(r.winIdle.surprise)}°)`);
      }
      const at = (t: number) => win.times.findIndex(x => x >= t);
      if (name === 'rps') {
        const reveal = 2.8 + (T.leadMs + 2 * T.beatMs) / 1000;
        assert.ok(win.wristY[at(4)] - win.chestY[at(4)] > idle.wristY[at(4)] - idle.chestY[at(4)] + 3, 'her hand is up (model units above where it hangs)');
        const index2 = MEASURED.indexOf('右人指２'), local = (run: Run, t: number) => {
          const i = at(t), f = run.frames[i], parent = run.frames[i][MEASURED.indexOf('右人指１')];
          return f[index2].clone().premultiply(parent.clone().invert()).angleTo(new Quaternion()) * DEG;
        };
        assert.ok(local(win, reveal - 0.05) > 60, `a fist through the count (${local(win, reveal - 0.05).toFixed(1)}°)`);
        assert.ok(local(win, reveal + 0.08) > 40, `the hand opens only once the reveal comes (${local(win, reveal + 0.08).toFixed(1)}°)`);
        assert.ok(local(win, reveal + 1.2) < 20, `布: open (${local(win, reveal + 1.2).toFixed(1)}°)`);
        assert.ok(Math.abs(win.wristY.at(-1)! - idle.wristY.at(-1)!) < 1, 'and down again at the end');
        assert.equal(win.near[at(0.8)], true, 'before the game your mouse there is within her reach');
        assert.equal(win.near[at(4)], false, 'during the game it is not ("the mouse rests near her" waits)');
      } else if (name === 'give') {
        assert.deepEqual(win.log, ['g1 taken'], 'taken once');
        const held = win.prop.slice(at(2.8), at(3.9));
        assert.ok(held.every(d => d >= 0 && d < 0.1), `the snack in her hand while she holds it out (${fmt(Math.max(...held))} of her height)`);
        assert.ok(win.anchors[at(3.5)], 'a click target on it');
        assert.equal(win.prop.at(-1), -1, 'gone after the take');
      } else {
        assert.ok(win.log.includes('out') && win.log.includes('held') && win.log.at(-1) === 'idle', win.log.join(' → '));
        const a = win.anchors[at(4.5)], w = win.wristScreen[at(4.5)];
        assert.ok(a && Math.hypot(a.x - w.x, a.y - w.y) < 45, `the click target is on her hand (${a ? Math.hypot(a.x - w.x, a.y - w.y).toFixed(1) : 'none'} px from the wrist)`);
        assert.ok(w.x < WINDOW.width / 2, 'reaching toward your mouse on her right');
      }
    });
  }
}

test('Gene, 60 fps: your pull on her hand wins over the game\'s raised arm (the pull is written after the reach)', async () => {
  const pulled = await windowRun(60, rpsScene(), (g, t) => {
    if (Math.abs(t - 3.6) < 1 / 120) { const w = g.screenOf('右手首'); const hit = g.figure.pullHit(g.view(), w.x, w.y); assert.ok(hit && g.figure.pullStart(hit, g.view()), 'her hand is under your pointer'); }
    if (t > 3.6 && t < 4.4) g.figure.pullTo(g.view(), 150, 330); // dragged toward the window's middle
    if (Math.abs(t - 4.4) < 1 / 120) g.figure.pullEnd();
  });
  const plain = await windowRun(60, rpsScene());
  const at = (t: number) => pulled.times.findIndex(x => x >= t);
  const moved = Math.hypot(pulled.wristScreen[at(4.3)].x - plain.wristScreen[at(4.3)].x, pulled.wristScreen[at(4.3)].y - plain.wristScreen[at(4.3)].y);
  assert.ok(moved > 10, `her hand follows your pull (${moved.toFixed(1)} px off the game's pose)`);
  const s = measure(pulled, [...ARM, ...BODY], 3, 6).surprise;
  assert.ok(s < 1.0, `and the pull and its release ease (${fmt(s)}°)`);
});

test('Gene, 30 fps: a beat\'s V on her right hand, then the game: the hand goes down first, then up for the game (no jump)', async () => {
  /** `v`: a beat's V on her right hand from 0.3 to 4 s; `game`: the game's ready from 2 s. Arm and body, from 1.5 s. */
  const scene = async (v: boolean, game: boolean) => {
    const g = await windowGene();
    const games = new WindowGames(new Scene());
    const bones = [...ARM, ...BODY].map(name => g.fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const frames: Quaternion[][] = [];
    try {
      for (let i = 0; i <= 30 * 7; i++) {
        const t = i / 30, dt = i ? 1 / 30 : 0;
        if (game && Math.abs(t - 2) < 1 / 60) games.setRps(view('ready', 1, { phaseMs: T.readyMs }));
        const beat = v && t >= 0.3 && t < 4 ? { left: null, right: { weight: 1, pose: 'vsign' as const, wave: 0 } } : null;
        const frame = games.frame(dt, { mesh: g.figure.mesh, pointer: { x: 0, y: 0 }, follow: true, camera: g.camera });
        g.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: withGames({ ...NEUTRAL_FACE, hands: beat }, frame) });
        g.fixture.mesh.updateMatrixWorld(true);
        if (t >= 1.5) frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      }
    } finally { games.dispose(); g.close(); }
    return { step: max(frameSteps(frames)), surprise: max(surprises(frames).perFrame), raised: frames.at(-1)! };
  };
  const both = await scene(true, true), onlyV = await scene(true, false), onlyGame = await scene(false, true);
  console.log(`  V then the game, 30 fps: arm+body step ${fmt(both.step)}° unexpected step ${fmt(both.surprise)}° (the V alone ${fmt(onlyV.step)}° / ${fmt(onlyV.surprise)}°, the game alone ${fmt(onlyGame.step)}° / ${fmt(onlyGame.surprise)}°)`);
  // The game's arm comes up from the motion's at the usual pace after the V is down (not tracked at once from where the game already is).
  assert.ok(both.step <= 1.1 * Math.max(onlyV.step, onlyGame.step), `no faster than the V or the game alone (${fmt(both.step)}° per frame)`);
  assert.ok(both.surprise <= Math.max(1.0, 1.25 * Math.max(onlyV.surprise, onlyGame.surprise)), `the hand-over eases (${fmt(both.surprise)}°)`);
  const end = Math.max(...both.raised.map((q, i) => q.angleTo(onlyGame.raised[i]) * DEG));
  assert.ok(end < 2, `and ends in the game's pose (${end.toFixed(2)}° off)`);
});
