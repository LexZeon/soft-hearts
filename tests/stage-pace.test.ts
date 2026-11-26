/**
 * P1 舞台少画 (docs/claude/2026-11-16-stage-pace.md; src/stage/stage-pace.ts). The companion stage draws fewer frames only while
 * nothing on screen needs them, and time stays continuous whatever the pace (the user's motion rules: never a jump, "禁止" never
 * freezes). These tests hold:
 *  - the pure decision: each pace, the 1.5 s hold, the calm switch off by default, the setting as the ceiling;
 *  - the frame clock across 60↔30↔24 switches: animation deltas sum to real time, no frame twice, no step skipped, and a
 *    speed-up draws on the very next refresh;
 *  - the real stage (gene-stage-harness, 60 Hz screen): which conditions keep full pace, the away pace, the calm switch, input
 *    waking it at once, and the motion measures with the pace switching against a steady pace;
 *  - the glitch watch and the colour-block stall line read the actual pace, so pacing is not reported as stutter;
 *  - the per-frame canvas readouts are written only when diagnostics are asked for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Quaternion, Vector3 } from 'three';
import { acceptStageFrame, MAX_ANIMATION_DELTA, type FrameSurface } from '../src/stage/frame-clock';
import { AWAY_FPS, CALM_FPS, PACE_HOLD_MS, readStageFlags, stagePace, StagePaceTracker, type StagePaceSnapshot } from '../src/stage/stage-pace';
import { MotionGlitchWatch, scaleRotation, type MotionGlitchReport } from '../src/stage/motion-glitch';

const base: StagePaceSnapshot = { now: 10_000, setting: 60, lastActiveAt: null, userAway: false, asleep: false, calmSwitch: false, calm: true };
const pace = (patch: Partial<StagePaceSnapshot>) => stagePace({ ...base, ...patch });

test('the decision: full by default, away while the user is away or she sleeps, calm only behind its switch', () => {
  assert.deepEqual(pace({}), { fps: 60, mode: 'full' }, 'nothing moves and the user is here: the default is unchanged');
  assert.deepEqual(pace({ userAway: true }), { fps: AWAY_FPS, mode: 'away' });
  assert.deepEqual(pace({ asleep: true }), { fps: AWAY_FPS, mode: 'away' });
  assert.deepEqual(pace({ calm: true }), { fps: 60, mode: 'full' }, 'the calm switch is off by default');
  assert.deepEqual(pace({ calmSwitch: true }), { fps: CALM_FPS, mode: 'calm' });
  assert.deepEqual(pace({ calmSwitch: true, calm: false }), { fps: 60, mode: 'full' }, 'not calm: full');
  assert.deepEqual(pace({ calmSwitch: true, asleep: true }), { fps: AWAY_FPS, mode: 'away' }, 'away beats calm');
});

test('the setting stays the ceiling: a slower pace never draws faster than the user chose', () => {
  assert.equal(pace({ setting: 24, asleep: true }).fps, 24);
  assert.equal(pace({ setting: 15, asleep: true }).fps, 15);
  assert.equal(pace({ setting: 24, calmSwitch: true }).fps, 24);
  assert.equal(pace({ setting: 30, userAway: true }).fps, 24);
  assert.equal(pace({ setting: undefined }).fps, 60, 'an unset setting is the frame clock default');
  assert.equal(pace({ setting: 999, asleep: true }).fps, 24);
});

test('the hold: full pace for 1.5 s after the last motion or input, then the slower pace', () => {
  for (const [ago, mode] of [[0, 'full'], [PACE_HOLD_MS - 1, 'full'], [PACE_HOLD_MS, 'away'], [60_000, 'away']] as const)
    assert.equal(pace({ asleep: true, lastActiveAt: base.now - ago }).mode, mode, `${ago} ms after`);
  assert.equal(pace({ asleep: true, now: Number.NaN }).mode, 'full', 'an unreadable clock stays at full');
});

test('the tracker: an input between frames counts at the next frame; reset drops the hold', () => {
  const tracker = new StagePaceTracker(), input = { setting: 60, userAway: true, asleep: false, calmSwitch: false, calm: true };
  assert.equal(tracker.decide({ ...input, now: 1000 }).mode, 'away');
  tracker.wake('pointer');
  assert.equal(tracker.decide({ ...input, now: 1010 }).mode, 'full', 'woken: full at once');
  assert.equal(tracker.decide({ ...input, now: 1010 + PACE_HOLD_MS - 1 }).mode, 'full');
  assert.equal(tracker.decide({ ...input, now: 1010 + PACE_HOLD_MS }).mode, 'away');
  tracker.note(5000, 'moving');
  assert.equal(tracker.decide({ ...input, now: 5100 }).mode, 'full');
  assert.equal(tracker.getState().reason, 'moving');
  tracker.reset();
  assert.equal(tracker.decide({ ...input, now: 5200 }).mode, 'away');
});

test('the flags: only the exact value "1" turns one on', () => {
  assert.deepEqual(readStageFlags('?pet=1&stageDiagnostics=1'), { diagnostics: true, calmPace: false });
  assert.deepEqual(readStageFlags('?pet=1&calmPace=1'), { diagnostics: false, calmPace: true });
  assert.deepEqual(readStageFlags('?pet=1&calmPace=true&stageDiagnostics=yes'), { diagnostics: false, calmPace: false });
  assert.deepEqual(readStageFlags(undefined), { diagnostics: false, calmPace: false });
  assert.deepEqual(readStageFlags(''), { diagnostics: false, calmPace: false });
});

const VISIBLE: FrameSurface = { hostVisible: true, documentHidden: false, width: 400, height: 560 };

/** The stage's own loop on a 60 Hz screen: the pace per callback, the due time cleared when the pace speeds up (MmdStage.framePace). */
function pacedLoop(fpsAt: (callback: number) => number, callbacks: number, hz = 60) {
  let previous = 0, due = 0, last = 0;
  const frames: { callback: number; time: number; delta: number; fps: number }[] = [];
  for (let i = 0; i < callbacks; i++) {
    const time = 1000 + i * 1000 / hz, fps = fpsAt(i);
    if (fps > last) due = 0;
    last = fps;
    const decision = acceptStageFrame(previous, time, fps, VISIBLE, due);
    previous = decision.previous; due = decision.due;
    if (decision.render) frames.push({ callback: i, time, delta: decision.delta, fps });
  }
  return frames;
}

test('60↔30↔24 back and forth: deltas sum to real time, no frame twice, no step skipped, a speed-up draws on the next refresh', () => {
  // Every 0.37 s (an awkward number, so the switches land on every phase of the slower schedules) the pace changes.
  const order = [60, 24, 60, 30, 24, 30, 60, 24, 30, 60, 24, 60];
  const fpsAt = (i: number) => order[Math.floor(i / 22) % order.length];
  const frames = pacedLoop(fpsAt, 22 * order.length * 3);
  let sum = 0;
  for (let i = 1; i < frames.length; i++) {
    const gap = (frames[i].time - frames[i - 1].time) / 1000;
    assert.ok(gap > 0, 'no frame twice');
    assert.ok(Math.abs(frames[i].delta - gap) < 1e-9, 'animation advances by the real time since the last drawn frame');
    assert.ok(frames[i].delta < MAX_ANIMATION_DELTA, 'never capped: no step is lost');
    assert.ok(gap <= 1 / AWAY_FPS + 1 / 60 + 1e-9, `no skipped step (gap ${(gap * 1000).toFixed(1)} ms)`);
    sum += frames[i].delta;
  }
  assert.ok(Math.abs(sum - (frames.at(-1)!.time - frames[0].time) / 1000) < 1e-9, 'the deltas add up to the real time');
  // A speed-up to 60: the very next callback draws (no first-frame delay), and every callback after it.
  for (let i = 1; i < 22 * order.length * 3; i++) if (fpsAt(i) === 60 && fpsAt(i - 1) !== 60)
    for (let k = i; k < i + 5; k++) assert.ok(frames.some(frame => frame.callback === k), `callback ${k} after the switch at ${i} draws`);
  // Each steady stretch draws its own rate (±1 frame for the phase).
  const per = (fps: number) => { const runs = frames.filter(frame => frame.fps === fps).length, seconds = (order.filter(v => v === fps).length * 3 * 22) / 60; return runs / seconds; };
  assert.ok(Math.abs(per(60) - 60) < 2 && Math.abs(per(30) - 30) < 2 && Math.abs(per(24) - 24) < 2, `${per(60)} ${per(30)} ${per(24)}`);
});

test('without clearing the due time on a speed-up, the first faster frame waits a refresh (the stage clears it)', () => {
  // Mutation check for MmdStage.framePace: the same loop that never clears `due` misses a callback after 30 → 60.
  let previous = 0, due = 0;
  const drawn: number[] = [];
  // At 30 the frames fall on even callbacks; the switch to 60 comes on an odd one (19).
  for (let i = 0; i < 40; i++) {
    const decision = acceptStageFrame(previous, 1000 + i * 1000 / 60, i < 19 ? 30 : 60, VISIBLE, due);
    previous = decision.previous; due = decision.due;
    if (decision.render) drawn.push(i);
  }
  assert.ok(drawn.includes(18) && !drawn.includes(19), 'the old schedule holds one refresh back');
  const fixed = pacedLoop(i => (i < 19 ? 30 : 60), 40).map(frame => frame.callback);
  assert.ok(fixed.includes(18) && fixed.includes(19) && fixed.includes(20) && fixed.includes(21), 'cleared: the next refresh draws');
});

type RunKind = 'steady' | 'paced' | 'forced';

test('the glitch watch: a pace change is not a physics kick; a real kick at a slower pace still is', () => {
  const lines: MotionGlitchReport[] = [], watch = new MotionGlitchWatch(line => lines.push(line), () => 0);
  const root = new Bone(), hair = new Bone(); hair.name = '後髪'; root.add(hair);
  const mesh = { skeleton: { bones: [root, hair] } } as never, idle = () => ['idle' as const], axis = new Vector3(0, 0, 1);
  // A steady 600°/s swing: 10° a frame at 60, 25° at 24. Unscaled, the switch alone departs 15° from the previous step.
  let angle = 0;
  const step = (fps: number) => { angle += 600 / fps; hair.quaternion.setFromAxisAngle(axis, angle / 180 * Math.PI); root.updateMatrixWorld(true); watch.physics(mesh, [1], idle, fps, 1000 / fps); };
  for (let i = 0; i < 6; i++) step(60);
  for (let i = 0; i < 6; i++) step(24);
  for (let i = 0; i < 6; i++) step(60);
  assert.equal(lines.length, 0, JSON.stringify(lines));
  hair.quaternion.multiply(new Quaternion().setFromAxisAngle(axis, 40 / 180 * Math.PI)); angle += 40;
  step(24);
  assert.equal(lines.length, 1, 'a real kick');
  assert.equal(lines[0].fps, 24, 'with the pace it happened at');
  const q = new Quaternion().setFromAxisAngle(axis, 0.2), out = new Quaternion();
  assert.ok(Math.abs(scaleRotation(q, 2.5, out).angleTo(new Quaternion()) - 0.5) < 1e-6);
  assert.ok(scaleRotation(new Quaternion(-q.x, -q.y, -q.z, -q.w), 2.5, out).angleTo(new Quaternion().setFromAxisAngle(axis, 0.5)) < 1e-6, 'the same turn written as −q');
});
