// I-154 batch 1, row 9「你不在时少画」(docs/claude/2026-11-19-unbound-in-window.md): the old stage's frame clock and pace in the window on
// Unbound's engine (src/unbound/window-mode/window-pace.ts), on simulated 60 Hz display callbacks:
//  - present: the setting; away (or asleep) and still: min(setting, 24), never below that floor, never stopped;
//  - a move in progress (a touch or a pull, the camera, speaking, a fade, her feet, her body or her hair turning fast) keeps the full pace
//    until 1.5 s after it ends; the user back: the very next callback draws;
//  - time stays continuous: drawn less often, she does the same motion (the real Gene frame loop sampled at 24 fps matches the 60 fps run).
// `PACE_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Object3D, Quaternion } from 'three';
import { WindowPace, type WindowPaceActivity } from '../src/unbound/window-mode/window-pace';
import { AWAY_FPS } from '../src/stage/stage-pace';
import { DEG, windowGene } from './helpers/unbound-window';

const REPORT = process.env.PACE_REPORT === '1';
const VSYNC = 1000 / 60;
/** Display callback times start well after 0 (a callback never comes at time 0; the frame clock reads 0 as "none yet"). */
const BASE = 10_000;
const SHOWN = { hostVisible: true, documentHidden: false, width: 420, height: 640 };
const STILL: WindowPaceActivity = { touch: false, camera: false, speaking: false, fading: false, stepping: false, body: [], physics: [] };

/** Runs display callbacks from `from` to `to` (ms); returns the drawn frames' times and deltas. */
function drive(pace: WindowPace, from: number, to: number, opts: { setting?: number; asleep?: boolean; activity?: (now: number) => Partial<WindowPaceActivity>; surface?: (now: number) => typeof SHOWN } = {}) {
  const drawn: { now: number; delta: number; physicsDelta: number; fps: number }[] = [];
  for (let now = from; now < to; now += VSYNC) {
    const frame = pace.accept(BASE + now, opts.setting ?? 60, opts.surface?.(now) ?? SHOWN, opts.asleep === true);
    if (!frame.render) continue;
    drawn.push({ now, delta: frame.delta, physicsDelta: frame.physicsDelta, fps: pace.currentFps });
    pace.drawn(BASE + now, frame.physicsDelta, { ...STILL, ...opts.activity?.(now) });
  }
  return drawn;
}
const rate = (frames: { now: number }[], from: number, to: number) => frames.filter(f => f.now >= from && f.now < to).length / ((to - from) / 1000);

test('pace: present she draws at the setting; away and still at min(setting, 24), never below it, never stopped', () => {
  for (const setting of [60, 30, 24, 15]) {
    const present = drive(new WindowPace(), 0, 4000, { setting });
    const awayPace = new WindowPace(); awayPace.setAway(true);
    const away = drive(awayPace, 0, 4000, { setting });
    const floor = Math.min(setting, AWAY_FPS);
    if (REPORT) console.log(`[window pace] setting ${setting}: present ${rate(present, 1000, 4000).toFixed(1)} fps, away ${rate(away, 2000, 4000).toFixed(1)} fps`);
    assert.ok(Math.abs(rate(present, 1000, 4000) - setting) <= 1.5, `present at ${setting}: ${rate(present, 1000, 4000)}`);
    assert.ok(rate(away, 2000, 4000) >= floor - 1.5, `away never below ${floor} (setting ${setting}): ${rate(away, 2000, 4000)}`);
    assert.ok(rate(away, 2000, 4000) <= floor + 1.5, `away draws less (setting ${setting}): ${rate(away, 2000, 4000)}`);
    // Never stopped, time continuous: every gap is one away frame at most, and the deltas add up to the time that passed.
    const gaps = away.slice(1).map((f, i) => f.now - away[i].now);
    assert.ok(Math.max(...gaps) <= 1000 / floor + VSYNC + 1e-6, `largest gap ${Math.max(...gaps).toFixed(1)} ms`);
    const total = away.slice(1).reduce((sum, f) => sum + f.delta, 0);
    assert.ok(Math.abs(total * 1000 - (away.at(-1)!.now - away[0].now)) < 1e-6, 'no time skipped or repeated');
  }
  const asleep = drive(new WindowPace(), 0, 4000, { asleep: true });
  assert.ok(Math.abs(rate(asleep, 2000, 4000) - AWAY_FPS) <= 1.5, 'asleep: the away pace too');
});

test('pace: a move in progress keeps the full pace while away, until 1.5 s after it ends; the user back draws at once', () => {
  const pace = new WindowPace(); pace.setAway(true);
  for (const [name, part] of [['touch', { touch: true }], ['camera', { camera: true }], ['speaking', { speaking: true }], ['fade', { fading: true }], ['her feet', { stepping: true }]] as const) {
    const p = new WindowPace(); p.setAway(true);
    const frames = drive(p, 0, 6000, { activity: now => (now >= 1000 && now < 3000 ? part : {}) });
    if (REPORT) console.log(`[window pace] away + ${name}: during ${rate(frames, 1100, 3000).toFixed(1)} fps, held ${rate(frames, 3000, 4400).toFixed(1)} fps, after ${rate(frames, 4700, 6000).toFixed(1)} fps`);
    assert.ok(rate(frames, 1100, 3000) >= 58, `${name}: full pace while it lasts (${rate(frames, 1100, 3000)})`);
    assert.ok(rate(frames, 3000, 4400) >= 58, `${name}: and for 1.5 s after (${rate(frames, 3000, 4400)})`);
    assert.ok(rate(frames, 4700, 6000) <= AWAY_FPS + 1.5, `${name}: then the away pace again`);
  }
  // Her body turning fast (more than 20°/s) or her hair (more than 30°/s): full pace.
  for (const [name, key, speed] of [['body', 'body', 40], ['hair', 'physics', 60]] as const) {
    const p = new WindowPace(); p.setAway(true);
    const bone = new Object3D();
    const frames = drive(p, 0, 5000, { activity: now => {
      if (now >= 1000 && now < 2500) bone.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, (now - 1000) / 1000 * speed / DEG);
      bone.updateMatrixWorld(true);
      return { [key]: [bone] };
    } });
    assert.ok(rate(frames, 1200, 2500) >= 58, `${name} turning ${speed}°/s: full pace (${rate(frames, 1200, 2500)})`);
    assert.ok(rate(frames, 4100, 5000) <= AWAY_FPS + 1.5, `${name} still again: away pace`);
  }
  // Back: the next display callback draws at full pace (still away, it would wait for the slower schedule).
  const stays = new WindowPace(); stays.setAway(true);
  drive(pace, 0, 3000); drive(stays, 0, 3000);
  const next = BASE + 3000 + VSYNC - 1e-6;
  assert.equal(stays.accept(next, 60, SHOWN, false).render, false, 'still away: the next callback waits');
  pace.setAway(false);
  assert.equal(pace.accept(next, 60, SHOWN, false).render, true, 'the user is back: drawn at once');
  assert.equal(pace.currentFps, 60);
});

test('pace: hidden draws nothing and keeps no hold; shown again, the first frame advances her at most 0.1 s', () => {
  const pace = new WindowPace();
  const frames = drive(pace, 0, 5000, { surface: now => (now >= 1000 && now < 3000 ? { ...SHOWN, hostVisible: false } : SHOWN) });
  assert.equal(frames.filter(f => f.now >= 1000 && f.now < 3000).length, 0, 'hidden: nothing drawn');
  const first = frames.find(f => f.now >= 3000)!;
  assert.ok(first.delta <= 0.1 + 1e-9, `first frame back advances ${first.delta} s`);
});

// ---- the real Gene: drawn less often, the same motion --------------------------------------------------------------------------------

test('pace on Gene: away, she is drawn at 24 fps and does the same motion as at 60 (continuous time); a pat brings the full pace back without a jump', async t => {
  const run = async (away: boolean) => {
    const g = await windowGene(), pace = new WindowPace();
    const shots: { now: number; rotations: Quaternion[]; delta: number }[] = [];
    try {
      for (let now = 0; now < 9000; now += VSYNC) {
        if (away && now >= 1500 && !pace.userAway) pace.setAway(true);
        const pat = now >= 5000 && now < 6000;
        const frame = pace.accept(BASE + now, 60, SHOWN, false);
        if (!frame.render) continue;
        g.body.frame(shots.length ? frame.delta : 0, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat }, frame.physicsDelta);
        shots.push({ now, rotations: g.rotations(), delta: frame.delta });
        pace.drawn(BASE + now, frame.physicsDelta, { ...STILL, touch: pat, stepping: g.figure.moving, body: g.body.paceBones });
      }
      return shots;
    } finally { g.close(); }
  };
  const [full, away] = [await run(false), await run(true)];
  const at = (shots: typeof full, from: number, to: number) => shots.filter(s => s.now >= from && s.now < to);
  const awayIdle = at(away, 3200, 5000), patSpan = at(away, 5000, 6000);
  const awayRate = awayIdle.length / 1.8, patRate = patSpan.length / 1.0;
  // The same moment drawn at 24 fps and at 60 fps: how far apart (the springs step by different dt; time itself is the same).
  let apart = 0;
  for (const shot of at(away, 1500, 9000)) {
    const twin = full.find(s => Math.abs(s.now - shot.now) < 1e-6);
    if (twin) apart = Math.max(apart, ...shot.rotations.map((q, b) => q.angleTo(twin.rotations[b]) * DEG));
  }
  const speed = (shots: typeof full) => shots.slice(1).map((s, i) => Math.max(...s.rotations.map((q, b) => q.angleTo(shots[i].rotations[b]) * DEG)) / s.delta);
  const stepAway = Math.max(...awayIdle.slice(1).map((s, i) => Math.max(...s.rotations.map((q, b) => q.angleTo(awayIdle[i].rotations[b]) * DEG))));
  const fullIdle = at(full, 3200, 5000), stepFull = Math.max(...fullIdle.slice(1).map((s, i) => Math.max(...s.rotations.map((q, b) => q.angleTo(fullIdle[i].rotations[b]) * DEG))));
  const numbers = { awayFps: +awayRate.toFixed(1), patFps: +patRate.toFixed(1), stepAt24Deg: +stepAway.toFixed(3), stepAt60Deg: +stepFull.toFixed(3),
    maxSpeedAwayDegS: +Math.max(...speed(at(away, 1500, 9000))).toFixed(2), maxSpeedFullDegS: +Math.max(...speed(at(full, 1500, 9000))).toFixed(2), apartDeg: +apart.toFixed(3) };
  if (REPORT) console.log(`[window pace gene] ${JSON.stringify(numbers)}`);
  t.diagnostic(JSON.stringify(numbers));
  assert.ok(Math.abs(awayRate - AWAY_FPS) <= 1.5, `away and still: ${awayRate} fps`);
  assert.ok(patRate >= 58, `a pat: full pace (${patRate} fps)`);
  assert.ok(apart < 0.5, `the same motion, sampled less often (${apart.toFixed(3)}° apart at the same moment)`);
  assert.ok(Math.max(...speed(at(away, 1500, 9000))) <= Math.max(...speed(at(full, 1500, 9000))) * 1.2 + 1, 'never faster than at full pace (no catching up)');
});
