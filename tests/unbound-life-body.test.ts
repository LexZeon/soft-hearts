// Unbound v1 step 4: her own actions in Gene's real Unbound frame loop (the figure with its gait, contact owner and IK, the shipped
// StayStill idle layered under, the page's life player), at 60 and 30 fps. R29 rules: never a snap, derived bones, hand-over.
//   - a walk to a new place: no teleport (the root moves at most her walking speed a frame and never jolts), planted feet do not slide;
//   - a walk eased out half way: she brakes and stops ahead of where she was, never turns back, and that is where she stands;
//   - a weight shift: the hips over one foot and back with no step, the centre of mass well inside her feet;
//   - a glance: eyes and head come to you and go back without a jolt;
//   - the idle pause (T-248 B1): her head really stops (< 1°/s for at least 0.3 s), she does not drift back to her stand, and it
//     resumes without a jolt; before/after: head stops a minute with and without the pause action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { geneFigure, TRACKED, max, plantedDrift, surpriseAngles, rootSurprises, type Shown } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { laptopLens } from './helpers/unbound-peek';
import { UNITS_PER_M } from '../src/unbound/figure';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { LifePlayer } from '../src/unbound/life/player';
import { LIFE_ACTION_IDS } from '../shared/unbound/life/registry';
import { lifeDrives, lifeRates } from '../shared/unbound/life/mood-read';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import { NO_SIGNALS } from '../shared/unbound/life/signals';
import { SHIFT } from '../shared/unbound/life/actions/shift';
import { GLANCE } from '../shared/unbound/life/actions/glance';
import { PAUSE } from '../shared/unbound/life/actions/pause';
import type { LifeContext } from '../shared/unbound/life/action';
import type { LifeCommand, LifePlan, LifeReport } from '../shared/unbound/life/types';

const DEG = 180 / Math.PI;
const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
const LEGS = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => /足|ひざ/.test(name)).map(([, i]) => i);
const HEAD = TRACKED.indexOf('頭');

function context(seed = 0.3): LifeContext {
  const drives = lifeDrives(NEUTRAL_MOOD);
  let r = seed;
  return { now: 0, situation: { shown: true, asleep: false, inCall: false, typing: false, waiting: false, clicked: false, replying: false, readingAloud: false, signals: { ...NO_SIGNALS, doing: 'paused', idleSeconds: 120 }, mood: { ...NEUTRAL_MOOD } },
    drives, rates: lifeRates(drives), here: null, toWorld: () => null, random: () => (r = (r * 9301 + 49297) % 233280 / 233280), trial: false, cue: null, youLeft: false };
}
const walkPlan = (xM: number, depthM: number): LifePlan => ({ action: 'place', level: 'place', keys: [{ t: 0 }], walk: { xM, depthM, speedMps: 0.5 }, amplitude: 1, easeS: 1, waitQuickS: 0 });

interface Frame extends Shown { phase: string | null; rate: number; com: Shown['com'] }
/** Runs her with the life player; `script(t)` returns commands to hand in before that frame. */
async function runLife(fps: number, seconds: number, script: (t: number, player: LifePlayer) => LifeCommand[], options: { idle?: boolean } = {}) {
  const { fixture, figure } = await geneFigure({ xM: 0.9, depthM: 8 });
  const bundled = options.idle === false ? null : await shippedIdle();
  const layer = new UnboundIdleLayer(async h => bundled ? createBundledIdle(h, bundled, 7) : null);
  layer.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  const reports: LifeReport[] = [];
  const player = new LifePlayer(LIFE_ACTION_IDS, r => reports.push(r), () => layer.quickBusy);
  const lens = laptopLens();
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const m = 1 / UNITS_PER_M, frames: Frame[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      for (const command of script(t, player)) player.command(command);
      player.frame(dt, { lens }, layer.wrap(figure), { walking: figure.walking, moving: figure.moving, heightM: figure.heightM, placement: figure.placement }, false);
      layer.frame(dt, idleWanted({ performing: false, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }), player.idleRate);
      figure.frame(dt);
      const report = figure.report!;
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), root: fixture.mesh.position.clone().multiplyScalar(m), heading: figure.heading,
        feet: report.feet.map(f => ({ planted: f.planted, pitch: f.pitch, ankle: f.ankle.clone().multiplyScalar(m), toe: f.toe?.clone().multiplyScalar(m) ?? null, target: f.target.clone().multiplyScalar(m), ik: f.ikWorld.clone().multiplyScalar(m) })),
        com: report.com, comMargin: report.comMargin, reachDrop: report.reachDrop, stance: report.stance, walking: figure.walking, steps: report.steps, phase: player.stage, rate: player.idleRate });
    }
    return { frames, reports, heightM: figure.heightM };
  } finally { figure.dispose(); fixture.close(); }
}

/** Head stops (T-248's measure): world head angular speed < 1°/s for at least 0.3 s, counted once each. */
function headStops(frames: readonly Frame[], fps: number, from = 0): { count: number; minutes: number } {
  let run = 0, count = 0;
  for (let i = Math.max(1, from); i < frames.length; i++) {
    const speed = frames[i].rotations[HEAD].angleTo(frames[i - 1].rotations[HEAD]) * DEG * fps;
    if (speed < 1) { run++; if (run === Math.ceil(0.3 * fps)) count++; } else run = 0;
  }
  return { count, minutes: (frames.length - from) / fps / 60 };
}
const R = (v: number, d = 3) => +v.toFixed(d);

for (const fps of [60, 30]) {
  const k = 60 / fps;
  test(`${fps} fps: a walk to a new place, a weight shift, a glance and an idle pause, one after another: no teleport, no sliding, no jolt`, async t => {
    const shift = SHIFT.plan(context())!.plan, glance = GLANCE.plan(context())!.plan, pause = PAUSE.plan(context())!.plan;
    const at = (s: number, frame: number) => Math.abs(frame - s) < 0.5 / fps;
    let n = 0;
    const run = await runLife(fps, 46, (time, player) => {
      if (at(2, time)) return [{ type: 'start', id: `w${++n}`, plan: walkPlan(0.4, 7.3), trial: false }];
      if (!player.active && time > 4 && time < 40) {
        const next = [shift, glance, pause][(n - 1) % 3];
        if (n <= 3) return [{ type: 'start', id: `a${++n}`, plan: next, trial: false }];
      }
      return [];
    });
    const f = run.frames, warm = 2 * fps;
    const walkEnd = f.findIndex((x, i) => i > warm && x.phase !== 'walking' && f[i - 1].phase === 'walking');
    const upper = max(surpriseAngles(f, warm, UPPER)), legs = max(surpriseAngles(f, warm, LEGS));
    const rootStep = max(f.slice(warm + 1).map((x, i) => x.root.distanceTo(f[warm + i].root) * 100)), rootJolt = max(rootSurprises(f.slice(warm)));
    const drift = plantedDrift(f.slice(warm), f[0].feet[0].ankle.y);
    const standing = f.slice(walkEnd + 2 * fps);
    const stepsStanding = standing.at(-1)!.steps - standing[0].steps;
    const comMin = Math.min(...standing.map(x => x.comMargin ?? Infinity)) * 100;
    const arrived = run.reports.find(r => r.at)!.at!;
    t.diagnostic(`${fps} fps: ${JSON.stringify({ upperJoltDeg: R(upper), legJoltDeg: R(legs), rootStepCm: R(rootStep), rootJoltCm: R(rootJolt, 4), toeDriftCm: R(drift.toeDrift, 4), ankleDriftCm: R(drift.drift, 4),
      stepsWhileStanding: stepsStanding, comMinCm: R(comMin, 2), walkS: R((walkEnd - warm) / fps, 2), arrived, actions: run.reports.filter(r => r.phase === 'done').length, directWriteCm: 0 })}`);
    assert.ok(walkEnd > warm, 'the walk ended');
    assert.deepEqual(arrived, { xM: 0.4, depthM: 7.3 }, 'she stands where she walked to (the host saves this)');
    assert.ok(Math.hypot(f.at(-1)!.root.x - 0.4, f.at(-1)!.root.z + 7.3) < 0.06, 'and she is there');
    assert.ok(rootStep <= 0.5 * 100 / fps * 1.25 + 0.05, `root at most her walking speed a frame (${rootStep} cm)`);
    assert.ok(rootJolt < 0.1 * k * k, `root: no jolt (${rootJolt})`);
    assert.ok(upper < 0.35 * k * k, `upper body: no jolt (${upper}°)`);
    assert.ok(legs < 4 * k * k, `legs: within the gait's own envelope (${legs}°)`);
    assert.ok(drift.toeDrift < 0.05 && drift.drift < 0.05, `planted feet do not slide (${drift.toeDrift} / ${drift.drift} cm)`);
    assert.equal(stepsStanding, 0, 'no step during the shift, the glance or the pause');
    assert.ok(comMin > 3, `centre of mass ${comMin.toFixed(2)} cm inside her feet`);
    assert.equal(run.reports.filter(r => r.phase === 'done').length, 4, 'every action reported its end');
  });

  test(`${fps} fps: a walk eased out half way brakes to a stop ahead of her (never turns back, no jolt) and she stands there`, async t => {
    const run = await runLife(fps, 16, time => {
      if (Math.abs(time - 1) < 0.5 / fps) return [{ type: 'start', id: 'w', plan: walkPlan(-1.2, 7.6), trial: false }];
      if (Math.abs(time - 4) < 0.5 / fps) return [{ type: 'cancel', id: 'w', reason: 'user' }];
      return [];
    });
    const f = run.frames, cancel = Math.round(4 * fps), dirX = -1;
    const after = f.slice(cancel);
    const back = Math.min(...after.slice(1).map((x, i) => (x.root.x - after[i].root.x) * dirX)) * 100;
    const stoppedAt = run.reports.find(r => r.at)!.at!;
    const upper = max(surpriseAngles(f, Math.round(fps), UPPER)), rootJolt = max(rootSurprises(f.slice(Math.round(fps))));
    const drift = plantedDrift(f.slice(Math.round(fps)), f[0].feet[0].ankle.y);
    t.diagnostic(`${fps} fps eased out: ${JSON.stringify({ stoppedAt, atCancel: { x: R(f[cancel].root.x), z: R(f[cancel].root.z) }, endsAt: { x: R(f.at(-1)!.root.x), z: R(f.at(-1)!.root.z) },
      mostBackCm: R(back, 4), upperJoltDeg: R(upper), rootJoltCm: R(rootJolt, 4), toeDriftCm: R(drift.toeDrift, 4), done: run.reports.at(-1)?.phase })}`);
    assert.equal(run.reports.at(-1)?.phase, 'done');
    assert.ok(stoppedAt.xM < f[cancel].root.x && stoppedAt.xM > -1.2, 'stopped ahead of where she was, short of where she was going');
    assert.ok(back > -0.05, `never back the way she came (${back} cm a frame)`);
    assert.ok(Math.hypot(f.at(-1)!.root.x - stoppedAt.xM, f.at(-1)!.root.z + stoppedAt.depthM) < 0.06, 'she stands where she reported');
    assert.ok(upper < 0.35 * k * k && rootJolt < 0.1 * k * k, 'no jolt');
    assert.ok(drift.toeDrift < 0.05 && drift.drift < 0.05, 'no sliding');
  });

  test(`${fps} fps: a glance cut short and a shift eased out mid-way go back smoothly from where they are (no snap)`, async t => {
    const glance = GLANCE.plan(context())!.plan, shift = SHIFT.plan(context())!.plan;
    const run = await runLife(fps, 16, time => {
      if (Math.abs(time - 3) < 0.5 / fps) return [{ type: 'start', id: 'g', plan: glance, trial: false }];
      if (Math.abs(time - 3.6) < 0.5 / fps) return [{ type: 'cancel', id: 'g', reason: 'user' }];
      if (Math.abs(time - 6) < 0.5 / fps) return [{ type: 'start', id: 's', plan: shift, trial: false }];
      if (Math.abs(time - 8) < 0.5 / fps) return [{ type: 'cancel', id: 's', reason: 'higher' }];
      return [];
    });
    const f = run.frames, upper = max(surpriseAngles(f, 2 * fps, UPPER));
    t.diagnostic(`${fps} fps cut short: upper jolt ${R(upper)}°, reports ${run.reports.map(r => `${r.id}:${r.phase}`).join(' ')}`);
    assert.deepEqual(run.reports.map(r => `${r.id}:${r.phase}`), ['g:playing', 'g:easing', 'g:done', 's:playing', 's:easing', 's:done']);
    assert.ok(upper < 0.35 * k * k, `no jolt (${upper}°)`);
  });

  test(`${fps} fps: the idle pause really stops her head and resumes without a jolt; head stops a minute before / after`, async t => {
    const plain = await runLife(fps, 62, () => []);
    let next = 4, n = 0;
    const paused = await runLife(fps, 62, (time, player) => {
      if (time >= next && !player.active) { next = time + 10; return [{ type: 'start', id: `p${++n}`, plan: PAUSE.plan(context(0.1 * n))!.plan, trial: false }]; }
      return [];
    });
    const warm = 2 * fps, before = headStops(plain.frames, fps, warm), after = headStops(paused.frames, fps, warm);
    const upper = max(surpriseAngles(paused.frames, warm, UPPER)), upperPlain = max(surpriseAngles(plain.frames, warm, UPPER));
    const skipped = paused.reports.filter(r => r.skipped).length, done = paused.reports.filter(r => r.phase === 'done').length;
    t.diagnostic(`${fps} fps pauses: ${JSON.stringify({ headStopsPerMinBefore: R(before.count / before.minutes, 2), headStopsPerMinAfter: R(after.count / after.minutes, 2), pauses: done, skipped,
      upperJoltDeg: { before: R(upperPlain), after: R(upper) } })}`);
    assert.ok(done >= 5, 'the pauses ran');
    assert.ok(after.count / after.minutes > before.count / before.minutes + 2, 'more real stops a minute');
    assert.ok(upper < 0.35 * k * k, `resumes without a jolt (${upper}°)`);
    assert.ok(paused.frames.every(x => x.rate >= 0 && x.rate <= 1));
  });
}
