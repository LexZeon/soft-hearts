/**
 * I-167 (docs/claude/2026-11-21-gaze-at-user.md): she looks at you more quickly and accurately from pose sensing.
 *
 * Synthetic only: heads in front of a virtual camera (tests/helpers/gaze-pipeline-sim.ts), no camera, no model, no window.
 * GAZE_REPORT=1 prints the pipeline numbers recorded in the doc.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { FOCAL_PX, FRAME_H, FRAME_W, keypointsOf, reachTime, seeded, simulateGazePipeline, tremble, type Head } from './helpers/gaze-pipeline-sim';
import { OneEuroFilter } from '../shared/behaviors/gaze-attention/one-euro';
import { headPoseOf } from '../shared/behaviors/gaze-attention/head-pose';
import { angleToward, userAim, userGazePoint, userTurn, viewingDistanceM } from '../shared/behaviors/gaze-attention/geometry';
import { LookingAtHer, lookOffset, turnTowardWindow } from '../shared/behaviors/gaze-attention/looking';
import { GAZE_ATTENTION_KNOBS } from '../shared/behaviors/gaze-attention/knobs';
import { GazeAttention, NEUTRAL_GAZE_MOOD, type GazeAttentionInput } from '../shared/behaviors/gaze-attention/choose';
import { parseUserGazeReading, type UserGazeReading } from '../shared/behaviors/gaze-attention/interface';
import { PoseFeatureTracker } from '../electron/senses/pose/features';
import { poseEmitDue, POSE_EMIT } from '../electron/senses/pose/emit-gate';
import { attendRate, LADDER } from '../electron/senses/pose/route';
import { UserGazeHost } from '../electron/senses/user-gaze';
import { StageGazeAttention } from '../src/senses/gaze-attention-stage';
import { HerOutGaze, halfWidthM } from '../src/unbound/her/out-gaze';
import { UNITS_PER_M } from '../src/unbound/figure';
import { EMPTY_POSE_SIGNAL, parsePoseSignal, type PoseSignal } from '../shared/senses/pose-signals';

const REPORT = !!process.env.GAZE_REPORT;
const DEG = 180 / Math.PI;
const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const HER_WINDOW = { x: 1480, y: 480, width: 400, height: 560 };
const sample = (head: Head, t: number, noise = 0, random = seeded()) => {
  const { kpts, scores } = keypointsOf(head, noise, random);
  return { t, detected: true, detScore: 0.9, kpts, scores, width: FRAME_W, height: FRAME_H };
};

// ---------------------------------------------------------------- 1. distance from face size, head direction

test('head pose from five keypoints: distance within 6 %, yaw within 5°, pitch within 7° on synthetic heads (off-centre, turned, nodding)', () => {
  const heads: Head[] = [
    { x: 0, y: 0.2, z: 0.6, yaw: 0, pitch: 0 }, { x: 0, y: 0.2, z: 0.6, yaw: 0.3, pitch: 0 }, { x: 0, y: 0.2, z: 0.6, yaw: -0.3, pitch: 0.2 },
    { x: 0.2, y: 0.2, z: 0.6, yaw: 0, pitch: 0 }, { x: 0, y: 0.2, z: 0.6, yaw: 0, pitch: 0.4 }, { x: 0, y: 0.1, z: 1, yaw: 0.5, pitch: -0.2 },
    { x: 0.15, y: 0.25, z: 0.5, yaw: -0.2, pitch: 0.3 }, { x: -0.2, y: 0.3, z: 0.7, yaw: 0.3, pitch: 0.45 }, { x: 0, y: 0.15, z: 0.4, yaw: 0, pitch: 0.1 },
  ];
  for (const head of heads) {
    const { kpts, scores } = keypointsOf(head, 0, seeded());
    const pose = headPoseOf(kpts, scores, FRAME_W, FRAME_H, 0.4, 60)!;
    const label = JSON.stringify(head);
    assert.ok(Math.abs(pose.distance / Math.hypot(head.x, head.y, head.z) - 1) < 0.06, `${label}: distance ${pose.distance.toFixed(3)}`);
    assert.ok(Math.abs((pose.yaw - head.yaw) * DEG) < 5, `${label}: yaw ${(pose.yaw * DEG).toFixed(1)}°`);
    assert.ok(Math.abs((pose.pitch - head.pitch) * DEG) < 7, `${label}: pitch ${(pose.pitch * DEG).toFixed(1)}°`);
  }
  // Not mirrored: turning toward the screen's right (as the user sees it) is yaw +, whichever side of the camera the head is on.
  for (const x of [-0.2, 0, 0.2]) {
    const right = keypointsOf({ x, y: 0.2, z: 0.6, yaw: 0.35, pitch: 0 }, 0, seeded()), left = keypointsOf({ x, y: 0.2, z: 0.6, yaw: -0.35, pitch: 0 }, 0, seeded());
    assert.ok(headPoseOf(right.kpts, right.scores, FRAME_W, FRAME_H, 0.4, 60)!.yaw > 0.2 && headPoseOf(left.kpts, left.scores, FRAME_W, FRAME_H, 0.4, 60)!.yaw < -0.2);
  }
  // The nose or an eye not seen: nothing (never a guess).
  const { kpts, scores } = keypointsOf(heads[0], 0, seeded());
  for (const hidden of [0, 1, 2]) { const s = scores.slice(); s[hidden] = 0.1; assert.equal(headPoseOf(kpts, s, FRAME_W, FRAME_H, 0.4, 60), null); }
  assert.equal(headPoseOf(kpts, scores, 0, FRAME_H, 0.4, 60), null);
});

test('distance from face size through the pose process: near and far heads give the measured distance, smoothed; the stage aim follows it', () => {
  const measured: number[] = [];
  for (const z of [0.42, 0.6, 0.95]) {
    const tracker = new PoseFeatureTracker(), random = seeded(4);
    let signal: PoseSignal = EMPTY_POSE_SIGNAL;
    for (let i = 0; i < 40; i++) { tracker.push(sample({ x: 0.05, y: 0.2, z, yaw: 0, pitch: 0.2 }, 1000 + i * 100, 1, random)); signal = tracker.signal(); }
    assert.ok(signal.head, 'a head reading');
    assert.deepEqual(parsePoseSignal(JSON.parse(JSON.stringify(signal))), signal, 'passes the host check as it is');
    const truth = Math.hypot(0.05, 0.2, z);
    assert.ok(Math.abs(signal.head!.distance / truth - 1) < 0.08, `z ${z}: ${signal.head!.distance} vs ${truth.toFixed(3)}`);
    measured.push(signal.head!.distance);
  }
  // The same face position, nearer: a shorter viewing distance in her units, so the same offset is a wider angle.
  const face = { x: 0.3, y: 0.5 };
  const near = userGazePoint(face, DISPLAY, HER_WINDOW, undefined, { distance: measured[0] })!, far = userGazePoint(face, DISPLAY, HER_WINDOW, undefined, { distance: measured[2] })!;
  assert.ok(near.dx < far.dx * 0.6, `nearer is nearer (${near.dx} vs ${far.dx})`);
  // A sane prior and clamp: no reading → the prior; absurd readings are kept between near and far.
  const k = GAZE_ATTENTION_KNOBS.camera;
  assert.equal(viewingDistanceM(null), k.distance);
  assert.equal(viewingDistanceM({ distance: 0.05 }), k.near);
  assert.equal(viewingDistanceM({ distance: 4 }), k.far);
});

test('geometry with known positions: a head at a known place in front of the screen lands where it is, in her window\'s units', () => {
  // The camera at the top middle of a 1920 × 1080 screen (0.25 mm per pixel: 480 mm across); the head 0.12 m right, 0.2 m down, 0.6 m out.
  const head: Head = { x: 0.12, y: 0.2, z: 0.6, yaw: 0, pitch: 0 };
  const u = FRAME_W / 2 - FOCAL_PX * head.x / head.z, v = FRAME_H / 2 + FOCAL_PX * head.y / head.z;
  // The knobs' vfov is 45° (the picture's height read with it); the sim's pixels are square, so give the matching vfov here.
  const camera = { ...GAZE_ATTENTION_KNOBS.camera, vfov: 2 * Math.atan(FRAME_H / 2 / FOCAL_PX) * DEG };
  const point = userGazePoint({ x: u / FRAME_W, y: v / FRAME_H }, DISPLAY, HER_WINDOW, camera, { distance: Math.hypot(head.x, head.y, head.z) })!;
  const px = 1 / (camera.mmPerPx / 1000); // pixels per metre
  const expectX = (DISPLAY.width / 2 + head.x * px - (HER_WINDOW.x + HER_WINDOW.width / 2)) / (HER_WINDOW.width / 2);
  const expectY = -(head.y * px - (HER_WINDOW.y + HER_WINDOW.height / 2)) / (HER_WINDOW.height / 2);
  assert.ok(Math.abs(point.x - expectX) < 0.02 && Math.abs(point.y - expectY) < 0.02, `${JSON.stringify(point)} vs ${expectX.toFixed(2)}, ${expectY.toFixed(2)}`);
  assert.ok(Math.abs(point.dx - head.z * px / (HER_WINDOW.width / 2)) < 0.03, `distance ${point.dx}`);
  // Her aim is the line from her eyes to that head: straight at it with aim 1, `aim` of the way by default.
  const full = userAim(point, 0, 0.4, 1), part = userAim(point, 0, 0.4);
  const yaw = Math.atan2(point.x - 0, point.dx);
  assert.ok(Math.abs(full.x * 0.48 - yaw) < 1e-9);
  assert.ok(Math.abs(part.x - full.x * GAZE_ATTENTION_KNOBS.camera.aim) < 1e-9);
  // The head's direction for the reading: degrees, y up (pitch down is y −).
  assert.deepEqual(userTurn({ yaw: 12.4, pitch: 20 }), { x: 12, y: -20 });
  assert.equal(userTurn(null), null);
});

// ---------------------------------------------------------------- 2. faster and steadier

test('One-Euro filter: holds still against noise, follows a fast move with little lag (vs a plain smoother as steady at rest)', () => {
  const settings = GAZE_ATTENTION_KNOBS.filter.position, random = seeded(6);
  const noise = () => (random() - 0.5) * 0.02; // ±0.01 of the frame
  const filter = new OneEuroFilter(settings);
  // At rest, 10 frames a second for 10 s: the spread of what comes out against what went in.
  let rawSpread = 0, outSpread = 0, n = 0;
  for (let i = 0; i < 100; i++) { const x = 0.5 + noise(), y = filter.next(x, i / 10); if (i > 20) { rawSpread += (x - 0.5) ** 2; outSpread += (y - 0.5) ** 2; n++; } }
  const quiet = Math.sqrt(outSpread / n) / Math.sqrt(rawSpread / n);
  assert.ok(quiet < 0.5, `noise at rest reduced to ${(quiet * 100).toFixed(0)} %`);
  // A step of 0.2 (a quick lean): how many frames until 90 % — against a plain smoother tuned to the same quiet at rest.
  const step = (next: (x: number, t: number) => number) => { for (let i = 0; i < 20; i++) next(0.5, i / 10); let i = 0; while (next(0.7, (20 + i) / 10) < 0.68 && i < 50) i++; return i + 1; };
  const alpha = 1 / (1 + 1 / (2 * Math.PI * settings.minCutoff * 0.1));
  let plain = 0.5;
  const euroFrames = step((x, t) => new OneEuroFilter(settings) && filter.next(x, t + 100)), plainFrames = step(x => (plain += alpha * (x - plain)));
  assert.ok(euroFrames <= 3 && euroFrames < plainFrames, `90 % after ${euroFrames} frames (plain smoother: ${plainFrames})`);
  // Not finite or not later: nothing changes.
  const f = new OneEuroFilter(settings); f.next(1, 1);
  assert.equal(f.next(NaN, 2), 1); assert.equal(f.next(5, 1), 1);
});

test('the pipeline end to end: her look moves sooner after your head moves, and holds still while you sit still (60 and 30 fps)', () => {
  const rest: Head = { x: 0, y: 0.22, z: 0.6, yaw: 0, pitch: 0.3 };
  const report: Record<string, unknown>[] = [];
  for (const fps of [60, 30]) {
    const poseFps = attendRate(LADDER[0], [30, 30, 30, 30, 30], false)!; // a computer where frames are cheap: the attending rate
    assert.equal(poseFps, 10);
    const step = simulateGazePipeline({ fps, poseFps, seconds: 8, head: t => ({ ...rest, x: t >= 4 ? 0.2 : 0 }) });
    const still = simulateGazePipeline({ fps, poseFps, seconds: 20, head: () => rest });
    const noisy = simulateGazePipeline({ fps, poseFps, seconds: 20, noisePx: 2, head: () => rest });
    const slow = simulateGazePipeline({ fps, poseFps: 5, seconds: 8, head: t => ({ ...rest, x: t >= 4 ? 0.2 : 0 }) });
    const row = { fps, poseFps, start: reachTime(step, 4, 'yawDeg', 0.1), half: reachTime(step, 4, 'yawDeg', 0.5), most: reachTime(step, 4, 'yawDeg', 0.9),
      fullHalf: reachTime(step, 4, 'fullYawDeg', 0.5), slowHalf: reachTime(slow, 4, 'yawDeg', 0.5), rest: tremble(still, 6, 20, 'yawDeg'), restPitch: tremble(still, 6, 20, 'pitchDeg'),
      noisy: tremble(noisy, 6, 20, 'yawDeg'), fullRest: tremble(still, 6, 20, 'fullYawDeg') };
    report.push(row);
    // Before I-167 (measured with the same simulation on main 807840c0): 10 % at 0.37 s, 50 % at 0.73 s, 90 % at 1.55 s; full-screen 50 % 0.60 s.
    assert.ok(row.half <= 0.4, `half the turn within 0.4 s (${row.half.toFixed(3)} s)`);
    assert.ok(row.most <= 0.75, `most of it within 0.75 s (${row.most.toFixed(3)} s)`);
    assert.ok(row.fullHalf <= 0.3, `full-screen: half within 0.3 s (${row.fullHalf.toFixed(3)} s)`);
    assert.ok(row.slowHalf <= 0.45, `a slower computer (5 pose frames a second) is quicker than before too (${row.slowHalf.toFixed(3)} s)`);
    // Before: 0.001° spread (the old 3 % send threshold held it still, at the cost of the lag above). Now: a tremble nobody sees.
    assert.ok(row.rest.sd < 0.03 && row.rest.speed < 0.05, `at rest: sd ${row.rest.sd.toFixed(4)}°, ${row.rest.speed.toFixed(4)}°/s`);
    assert.ok(row.restPitch.sd < 0.1, `at rest, up / down: sd ${row.restPitch.sd.toFixed(4)}° (before 0.089°)`);
    assert.ok(row.noisy.sd < 0.05 && row.noisy.speed < 0.05, `twice the keypoint noise: sd ${row.noisy.sd.toFixed(4)}°, ${row.noisy.speed.toFixed(4)}°/s`);
  }
  if (REPORT) console.log(JSON.stringify(report));
});

test('the pose rate while you face the screen: 10 when frames are cheap, 8 when only that fits, as before otherwise (battery, lower steps, too few frames)', () => {
  const top = LADDER[0];
  assert.equal(attendRate(top, [20, 22, 25, 21, 24], false), 10);
  assert.equal(attendRate(top, [55, 58, 60, 52, 57], false), 8, '60 ms fits 8 (62.5 ms), not 10 (50 ms)');
  assert.equal(attendRate(top, [80, 85, 90, 82, 88], false), null, 'only the old 5 fits');
  assert.equal(attendRate(top, [20, 22, 25, 21, 24], true), null, 'on battery: never');
  assert.equal(attendRate(top, [20, 22], false), null, 'too few frames measured');
  for (const lower of LADDER.slice(1)) assert.equal(attendRate(lower, [5, 5, 5, 5, 5], false), null, `${lower.level}: never`);
});

test('the send rule: while you face the screen a small move or a head turn goes at once (every 80 ms at most); otherwise the old rule', () => {
  const face = { x: 0.5, y: 0.4 }, head = { yaw: 0, pitch: 10, distance: 0.6 };
  const signal = (over: Partial<PoseSignal>): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, facing: 'toward', face, head, ...over });
  const base = { t: 1000, lastEmit: 1000 - 100, lastFace: face, lastHead: head, lastPresent: true };
  const moved = signal({ face: { x: 0.51, y: 0.4 } });
  assert.equal(poseEmitDue({ ...base, attending: true }, moved), true, 'one rounding step, attending');
  assert.equal(poseEmitDue({ ...base, attending: false }, moved), false, 'not attending: needs 3 %');
  assert.equal(poseEmitDue({ ...base, lastEmit: 1000 - 50, attending: true }, moved), false, 'no sooner than 80 ms');
  assert.equal(poseEmitDue({ ...base, attending: true }, signal({ head: { ...head, yaw: 3 } })), true, 'a head turn of 2° or more');
  assert.equal(poseEmitDue({ ...base, attending: true }, signal({ head: { ...head, yaw: 1 } })), false);
  assert.equal(poseEmitDue({ ...base, lastEmit: 1000 - POSE_EMIT.presentMs, attending: false }, signal({})), true, 'the half-second rhythm stays');
});

// ---------------------------------------------------------------- 3. eye contact from head orientation

test('looking at her, with two edges and a hold: in the window to start, well past it to stop, a flicker at the edge changes nothing', () => {
  const point = { x: -3, y: 2.5, dx: 10, dy: 7 }, her = { x: 0, y: 0.4 };
  const toward = angleToward(point, her.x, her.y), k = GAZE_ATTENTION_KNOBS.looking;
  const turn = (dx: number, dy = 0) => ({ x: Math.round(toward.x + dx), y: Math.round(toward.y + dy) });
  assert.ok(lookOffset(turn(0), toward) < 0.1);
  const looking = new LookingAtHer();
  assert.equal(looking.frame(1 / 60, point, null, her.x, her.y), null, 'no head direction: not known');
  assert.equal(looking.frame(1 / 60, point, turn(0), her.x, her.y), true, 'pointing at her');
  // Just past the first edge, but inside the leaving edge: still looking.
  for (let i = 0; i < 120; i++) assert.equal(looking.frame(1 / 60, point, turn(k.yaw * 1.3), her.x, her.y), true);
  // Well past it, but only briefly: still looking; held: not.
  for (let i = 0; i < Math.floor(k.holdS * 60) - 2; i++) looking.frame(1 / 60, point, turn(k.yaw * 2.2), her.x, her.y);
  assert.equal(looking.looking, true, 'a moment past the edge is not turning away');
  for (let i = 0; i < 10; i++) looking.frame(1 / 60, point, turn(k.yaw * 2.2), her.x, her.y);
  assert.equal(looking.looking, false, 'held past the leaving edge: looking elsewhere');
  // Back inside the leaving edge but not the first: still not looking (no flicker).
  for (let i = 0; i < 120; i++) assert.equal(looking.frame(1 / 60, point, turn(k.yaw * 1.3), her.x, her.y), false);
  for (let i = 0; i < 30; i++) looking.frame(1 / 60, point, turn(2, -3), her.x, her.y);
  assert.equal(looking.looking, true);
  // Up / down too: her below, your head toward the screen's top.
  for (let i = 0; i < 60; i++) looking.frame(1 / 60, point, turn(0, k.pitch * 2.5), her.x, her.y);
  assert.equal(looking.looking, false);
});

test('eye contact and the shy look-away need your head toward her; facing the screen elsewhere does not count (unknown: as before)', () => {
  const run = (looking: boolean | null | undefined, shy: number) => {
    const chooser = new GazeAttention(seeded(5));
    const events: string[] = [];
    for (let i = 0; i < 60 * 60; i++) {
      const user = { present: true, facing: 'toward' as const, energy: 0.1, ...(looking === undefined ? {} : { looking }) };
      const input: GazeAttentionInput = { dt: 1 / 60, user, mouse: true, allowed: true, mood: { ...NEUTRAL_GAZE_MOOD, shy } };
      chooser.frame(input);
      events.push(...chooser.takeEvents().map(e => e.kind));
    }
    return events;
  };
  assert.ok(run(true, 0).includes('eye-contact') && run(undefined, 0).includes('eye-contact') && run(null, 0).includes('eye-contact'));
  assert.ok(run(true, 1).includes('shy'));
  const elsewhere = run(false, 1);
  assert.ok(elsewhere.includes('start'), 'she still looks at you (you are here, facing the screen)');
  assert.ok(!elsewhere.includes('eye-contact') && !elsewhere.includes('shy'), 'but no eye contact and no shy look-away');
});

test('the host counts an eye contact toward her mood only while your head points at her window (unknown direction: as before)', () => {
  let now = 10_000;
  const host = new UserGazeHost(() => now), ports = { moment: () => true, record: () => {} };
  const signal = (head: PoseSignal['head']): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, confidence: 0.9, facing: 'toward', face: { x: 0.5, y: 0.45 }, head });
  // Her window at the bottom right; your head turned toward it.
  host.note(signal({ yaw: 22, pitch: 22, distance: 0.6 }));
  const reading = host.read(HER_WINDOW, DISPLAY)!;
  assert.ok(reading.turn && turnTowardWindow(reading.point!, reading.turn), JSON.stringify(reading));
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), true);
  // Turned to the far left of the screen: facing the screen, not her.
  host.note(signal({ yaw: -45, pitch: 5, distance: 0.6 }));
  host.read(HER_WINDOW, DISPLAY);
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), false);
  // No head direction (nose not seen): facing decides, as before.
  host.note(signal(null));
  host.read(HER_WINDOW, DISPLAY);
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), true);
  // Sensing off forgets it all.
  host.note(signal({ yaw: -45, pitch: 5, distance: 0.6 })); host.read(HER_WINDOW, DISPLAY); host.sensing(false);
  assert.equal(host.read(HER_WINDOW, DISPLAY), null);
  now += 1;
  host.note(signal(null));
  assert.equal(host.fact({ kind: 'eye-contact' }, ports), true, 'nothing of the old direction is kept');
});

test('the reading carries the head direction only with a position, checked; anything off is no reading', () => {
  const base = { present: true, facing: 'toward', energy: 0.1, point: { x: -2, y: 1, dx: 9, dy: 6 }, screen: null };
  assert.deepEqual(parseUserGazeReading({ ...base, turn: { x: 10, y: -12 } })!.turn, { x: 10, y: -12 });
  assert.equal(parseUserGazeReading({ ...base, turn: null })!.turn, undefined);
  for (const turn of [{ x: 200, y: 0 }, { x: '1', y: 0 }, [1, 2], { x: 1 }])
    assert.equal(parseUserGazeReading({ ...base, turn }), null, JSON.stringify(turn));
  assert.equal(parseUserGazeReading({ ...base, point: null, turn: { x: 1, y: 1 } }), null, 'a direction without a position');
});

// ---------------------------------------------------------------- 4. the head-to-head line, weighted like the mouse, both surfaces

test('weighted like the mouse follow: you nearly straight ahead of her moves her eyes only; you far to the side brings her head in', () => {
  const split = (point: { x: number; y: number }) => {
    const stage = new StageGazeAttention(() => 0);
    const reading: UserGazeReading = { present: true, facing: 'toward', energy: 0, screen: null, point: { ...point, dx: 9.6, dy: 6.9 } };
    for (let i = 0; i < 240; i++) stage.frame({ delta: 1 / 60, follow: false, allowed: true, mouseX: 0, mouseY: 0, originX: 0, originY: 0.4, reading, mood: null });
    return stage.frame({ delta: 1 / 60, follow: false, allowed: true, mouseX: 0, mouseY: 0, originX: 0, originY: 0.4, reading, mood: null }).targets(1, 0, 0, 0, true);
  };
  const near = split({ x: 0.4, y: 0.9 }), far = split({ x: -7, y: 4 });
  assert.ok(near.headWeight < 0.2 && Math.abs(near.eyeX) > Math.abs(near.headX), `near: head share ${near.headWeight.toFixed(2)}`);
  assert.ok(far.headWeight > 0.5 && Math.abs(far.headX) > Math.abs(far.eyeX), `far: head share ${far.headWeight.toFixed(2)}`);
});

function fullCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(48, 16 / 9, 0.05 * UNITS_PER_M, 400 * UNITS_PER_M);
  camera.position.set(0, 1.2 * UNITS_PER_M, 0.6 * UNITS_PER_M); camera.updateMatrixWorld(true);
  return camera;
}

test('full screen: your head left / right and up / down and its distance move her look; fullAim 0 is the viewer\'s eye; nothing jumps', () => {
  const camera = fullCamera(), head = { x: 0.3, y: 1.4, z: -1 };
  assert.ok((halfWidthM(camera) ?? 0) > 0.2);
  const look = (point: { x: number; y: number; dx: number }, aim = 1) => {
    const gaze = new HerOutGaze(() => {}, () => 0.5, { ...GAZE_ATTENTION_KNOBS, camera: { ...GAZE_ATTENTION_KNOBS.camera, fullAim: aim } });
    let out = null as ReturnType<HerOutGaze['frame']>;
    for (let i = 0; i < 120; i++) {
      if (i % 6 === 0) gaze.set({ present: true, facing: 'toward', energy: 0.1, screen: null, point: { ...point, dy: point.dx * 16 / 9 } });
      out = gaze.frame({ dt: 1 / 60, allowed: true, thinking: false, speaking: false, mood: null, head, heading: 0, camera });
    }
    return out!.toUser;
  };
  const centre = look({ x: 0, y: 0.6, dx: 2.2 }), high = look({ x: 0, y: 0.95, dx: 2.2 }), right = look({ x: 0.5, y: 0.6, dx: 2.2 });
  const centreFar = look({ x: 0, y: 0.6, dx: 4 }), rightFar = look({ x: 0.5, y: 0.6, dx: 4 });
  assert.ok(high.pitch < centre.pitch - 0.02, `higher head: she looks further up (${high.pitch.toFixed(3)} vs ${centre.pitch.toFixed(3)})`);
  // She faces you (heading 0): her left (yaw +) is the screen's right as you see it.
  assert.ok(right.yaw > centre.yaw + 0.05, `your head to the right: ${right.yaw.toFixed(3)} vs ${centre.yaw.toFixed(3)}`);
  assert.ok(rightFar.yaw - centreFar.yaw < right.yaw - centre.yaw, 'further away, the same sideways shift is a smaller turn');
  const eye = look({ x: 0.5, y: 0.95, dx: 4 }, 0), none = new HerOutGaze().frame({ dt: 1 / 60, allowed: true, thinking: false, speaking: false, mood: null, head, heading: 0, camera })!.toUser;
  assert.ok(Math.abs(eye.yaw - none.yaw) < 1e-9 && Math.abs(eye.pitch - none.pitch) < 1e-9, 'fullAim 0: the viewer\'s eye, as without a reading');
  // Tracking starts, the head moves, sensing stops: the look changes by small steps every frame (60 fps).
  const gaze = new HerOutGaze(() => {}, () => 0.5);
  let last = null as { yaw: number; pitch: number } | null, largest = 0;
  for (let i = 0; i < 60 * 6; i++) {
    if (i % 6 === 0) gaze.set(i < 60 * 4 ? { present: true, facing: 'toward', energy: 0.1, screen: null, point: { x: i < 120 ? -0.4 : 0.6, y: 0.7, dx: 2.4, dy: 4.3 } } : null);
    const f = gaze.frame({ dt: 1 / 60, allowed: true, thinking: false, speaking: false, mood: null, head, heading: 0, camera })!.toUser;
    if (last) largest = Math.max(largest, Math.abs(f.yaw - last.yaw), Math.abs(f.pitch - last.pitch));
    last = f;
  }
  assert.ok(largest * DEG < 1.5, `largest per-frame change of her look toward you: ${(largest * DEG).toFixed(2)}°`);
});

test('privacy unchanged: nothing of your head is kept after sensing goes off; the head reading is only numbers, only with a face', () => {
  const tracker = new PoseFeatureTracker();
  for (let i = 0; i < 20; i++) tracker.push(sample({ x: 0, y: 0.2, z: 0.6, yaw: 0, pitch: 0.2 }, 1000 + i * 100));
  const signal = tracker.signal();
  assert.deepEqual(Object.keys(signal.head!).sort(), ['distance', 'pitch', 'yaw']);
  assert.ok(Object.values(signal.head!).every(v => typeof v === 'number' && Number.isFinite(v)));
  assert.equal(tracker.signal('presence-only').head, null);
  tracker.reset();
  assert.equal(tracker.signal().head, null);
  const host = new UserGazeHost(() => 5_000);
  host.note(signal);
  assert.ok(host.read(HER_WINDOW, DISPLAY)?.turn);
  host.sensing(false);
  assert.equal(host.read(HER_WINDOW, DISPLAY), null, '"别看" / sensing off: forgotten at once');
});
