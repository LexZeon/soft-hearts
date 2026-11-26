// Unbound U1 part 2: the pure pieces of her body (src/unbound/dynamics.ts, balance.ts, gait.ts, body-meter.ts) and the knobs
// (shared/unbound/scene.ts). The Gene frame loop is in unbound-contact.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { EyeMovement, RotationSpring, Spring, dampSecondOrder, expMap, substeps } from '../src/unbound/dynamics';
import { dampCritical } from '../src/stage/procedural';
import { COM_SEGMENTS, centerOfMass, convexHull, footPatch, supportMargin } from '../src/unbound/balance';
import { Gait, type GaitBody } from '../src/unbound/gait';
import { BodyMeter } from '../src/unbound/body-meter';
import { UNBOUND_BODY_DEFAULTS, parseUnboundControlPatch } from '../shared/unbound/scene';

// Gene's legs, measured (contact.ts BodyRig.gaitBody on the bundled model).
const GENE: GaitBody = { home: [{ x: 0.07, z: -0.013 }, { x: -0.068, z: -0.013 }], ankleHeight: 0.106, legLength: 0.733, hipHeight: 0.839,
  foot: { heel: 0.036, toe: 0.121, halfWidth: 0.036 }, toe: { forward: 0.121, drop: 0.106 } };

test('second-order steps are exact for any damping ratio (closed form = fine numerical integration), and ζ = 1 is the stage spring', () => {
  for (const zeta of [0.6, 1.3]) {
    const omega = 2 * Math.PI * 1.5, v = { v: 0.4 };
    const exact = dampSecondOrder(0.2, 1, omega, zeta, 0.25, v);
    let x = 0.2, xv = 0.4; const h = 1e-5;
    for (let t = 0; t < 0.25 - 1e-12; t += h) { const a = -2 * zeta * omega * xv - omega * omega * (x - 1); xv += a * h; x += xv * h; }
    assert.ok(Math.abs(exact - x) < 1e-4 && Math.abs(v.v - xv) < 1e-3, `ζ=${zeta}: ${exact} vs ${x}, ${v.v} vs ${xv}`);
  }
  const a = { v: 0.3 }, b = { v: 0.3 };
  assert.equal(dampSecondOrder(0, 1, 5, 1, 1 / 60, a), dampCritical(0, 1, 5, 1 / 60, b, 'v'));
  assert.equal(a.v, b.v);
  assert.deepEqual(substeps(1 / 60), { count: 2, h: 1 / 120 });
  assert.deepEqual(substeps(1 / 30), { count: 4, h: 1 / 120 });
  assert.deepEqual(substeps(1), { count: 12, h: 0.1 / 12 }, 'a long frame is clamped to 0.1 s like every stage clock');
});

test('a spring keeps its speed when the target changes; a rotation residual at rest is exactly nothing', () => {
  const s = new Spring({ hz: 1 });
  s.target = 1; for (let i = 0; i < 30; i++) s.advance(1 / 120);
  const speed = s.velocity.v; s.target = -1;
  assert.equal(s.velocity.v, speed);
  const r = new RotationSpring({ hz: 1.6, zeta: 1.05 });
  assert.equal(r.idle, true, 'nothing written when nothing is asked');
  assert.deepEqual(r.quaternion(new Quaternion()).toArray(), [0, 0, 0, 1]);
  const q = expMap(new Vector3(0, Math.PI / 2, 0), new Quaternion());
  assert.ok(Math.abs(q.angleTo(new Quaternion()) - Math.PI / 2) < 1e-12);
});

test('eye movements: 35 ms + 3 ms per degree (35..100), end at rest, and an interruption continues from the current speed', () => {
  const eye = new EyeMovement();
  eye.look(10 * Math.PI / 180);
  let steps = 0; while (eye.velocity !== 0 || steps === 0) { eye.advance(1 / 1000); steps++; if (steps > 500) break; }
  assert.equal(steps, 65, '10° takes 65 ms');
  assert.equal(eye.value, 10 * Math.PI / 180);
  const big = new EyeMovement(); big.look(1); let n = 0; while (big.velocity !== 0 || n === 0) { big.advance(1 / 1000); n++; if (n > 500) break; }
  assert.equal(n, 100, 'capped at 100 ms');
  const mid = new EyeMovement(); mid.look(0.3);
  for (let i = 0; i < 20; i++) mid.advance(1 / 1000);
  const before = mid.velocity; mid.look(-0.2);
  const v0 = mid.velocity; mid.advance(1e-6);
  assert.equal(v0, before, 'the new look starts at the speed the eye has');
  assert.ok(Math.abs(mid.velocity - before) < Math.abs(before) * 0.01, `no speed jump: ${before} → ${mid.velocity}`);
});

test('support region, margin and the COM proxy', () => {
  const left = footPatch({ x: 0.07, z: 0 }, 0, GENE.foot), right = footPatch({ x: -0.07, z: 0 }, 0, GENE.foot);
  const both = convexHull([...left, ...right]);
  assert.ok(Math.abs(supportMargin({ x: 0, z: 0.04 }, both) - 0.076) < 1e-9, 'between the feet: 7.6 cm from the heel line (the nearest edge)');
  assert.ok(supportMargin({ x: 0.2, z: 0 }, both) < 0, 'beside her: outside');
  assert.ok(supportMargin({ x: 0, z: 0 }, convexHull(left)) < 0, 'over one foot only the patch of that foot counts');
  assert.equal(supportMargin({ x: 0, z: 0 }, []), -Infinity, 'no foot down: no support');
  const total = COM_SEGMENTS.reduce((a, s) => a + s.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares add up to the whole body (${total})`);
  const com = centerOfMass([{ a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 2, z: 0 }, share: 0.75 }, { a: { x: 4, y: 0, z: 0 }, b: { x: 4, y: 0, z: 0 }, share: 0.25 }])!;
  assert.deepEqual(com, { x: 1, y: 0.75, z: 0 });
});

interface GaitRun { root: { x: number; z: number; heading: number }[]; feet: { phase: string; x: number; z: number; lift: number; pitch: number; yaw: number }[][]; steps: number; gait: Gait }
function walk(fps: number, seconds: number, goal: { x: number; z: number }, setup: (g: Gait) => void = () => {}, each: (g: Gait, t: number) => void = () => {}): GaitRun {
  const gait = new Gait(GENE, { x: 0, z: 0, heading: 0 });
  gait.setFacingPoint({ x: 0, z: 10 });
  setup(gait);
  gait.setGoal(goal.x, goal.z);
  const out: GaitRun = { root: [], feet: [], steps: 0, gait };
  for (let f = 1; f <= fps * seconds; f++) {
    each(gait, f / fps);
    gait.step(1 / fps);
    out.root.push(gait.rootState);
    out.feet.push(gait.footStates.map(s => ({ ...s })));
  }
  out.steps = gait.stepCount;
  return out;
}
/** The toe's world point of a foot state (the contact point that stays down while the heel rolls). */
const toeOf = (f: { x: number; z: number; lift: number; pitch: number; yaw: number }) => {
  const { forward: fwd, drop } = GENE.toe, along = fwd * Math.cos(f.pitch) - drop * Math.sin(f.pitch);
  return { x: f.x + Math.sin(f.yaw) * along, z: f.z + Math.cos(f.yaw) * along, y: GENE.ankleHeight + f.lift - (drop * Math.cos(f.pitch) + fwd * Math.sin(f.pitch)) };
};

test('standing: no steps, feet still, the weight drifts slowly between the feet without a jump', () => {
  const run = walk(60, 30, { x: 0, z: 0 });
  assert.equal(run.steps, 0);
  const first = run.feet[0];
  for (const feet of run.feet) feet.forEach((f, i) => { assert.equal(f.x, first[i].x); assert.equal(f.z, first[i].z); });
  const gait = new Gait(GENE, { x: 0, z: 0, heading: 0 });
  let last = gait.pelvis.lateral, lo = 0, hi = 0, jump = 0;
  for (let i = 0; i < 60 * 30; i++) { gait.step(1 / 60); const p = gait.pelvis.lateral; jump = Math.max(jump, Math.abs(p - last)); last = p; lo = Math.min(lo, p); hi = Math.max(hi, p); }
  assert.ok(hi - lo > 0.02 && hi - lo < 0.045, `hips drift ${(lo * 100).toFixed(1)}..${(hi * 100).toFixed(1)} cm`);
  assert.ok(jump < 0.0005, `largest per-frame hip move ${(jump * 1000).toFixed(2)} mm`);
});

test('walking 6 m: the same path at 60 and 30 fps, alternating steps, planted toes never move, she arrives without overshooting', () => {
  const a = walk(60, 14, { x: 0, z: 6 }), b = walk(30, 14, { x: 0, z: 6 });
  for (let i = 1; i < b.root.length; i++) {
    const ra = a.root[2 * i + 1], rb = b.root[i];
    assert.ok(Math.abs(ra.x - rb.x) < 1e-9 && Math.abs(ra.z - rb.z) < 1e-9, `t=${(i + 1) / 30}: ${ra.z} vs ${rb.z}`);
  }
  assert.equal(a.steps, b.steps);
  const end = a.root.at(-1)!;
  assert.ok(Math.abs(end.z - 6) < 0.01 && Math.abs(end.x) < 0.01, `arrived at ${end.x.toFixed(3)}, ${end.z.toFixed(3)}`);
  assert.ok(Math.max(...a.root.map(r => r.z)) < 6.015, 'no overshoot past the goal by more than 1.5 cm');
  // Alternation while cruising: two lift-offs in a row by the same foot never happen after the first two steps.
  const liftOffs: number[] = [];
  for (let i = 1; i < a.feet.length; i++) for (const k of [0, 1]) if (a.feet[i - 1][k].phase === 'planted' && a.feet[i][k].phase === 'swing') liftOffs.push(k);
  assert.ok(liftOffs.length >= 16, `${liftOffs.length} steps for 6 m`);
  for (let i = 2; i < liftOffs.length - 2; i++) assert.notEqual(liftOffs[i], liftOffs[i - 1], `step ${i} alternates`);
  // The toe of a planted foot stays exactly put, through heel-off too.
  let drift = 0, heel = 0;
  for (const k of [0, 1]) {
    let anchor: { x: number; y: number; z: number } | null = null;
    for (const feet of a.feet) {
      const f = feet[k];
      if (f.phase !== 'planted') { anchor = null; continue; }
      const toe = toeOf(f); anchor ??= toe; heel = Math.max(heel, f.pitch);
      drift = Math.max(drift, Math.hypot(toe.x - anchor.x, toe.y - anchor.y, toe.z - anchor.z));
    }
  }
  assert.ok(drift < 1e-9, `planted toe drift ${drift}`);
  assert.ok(heel > 0.2, `the trailing heel rolls up while walking (${heel.toFixed(2)} rad)`);
});

test('round 8: a step back while facing the viewer lands flat and stays flat (no roll onto the toes); no foot\'s pitch ever jumps', () => {
  const DEG = 180 / Math.PI;
  const pitchStep = (run: GaitRun) => { let m = 0; for (let i = 1; i < run.feet.length; i++) for (const k of [0, 1]) m = Math.max(m, Math.abs(run.feet[i][k].pitch - run.feet[i - 1][k].pitch)); return m * DEG; };
  for (const fps of [60, 30]) {
    for (const back of [0.3, 0.55]) {
      const run = walk(fps, 5, { x: 0, z: -back });
      assert.ok(run.steps >= 2, `${fps} fps, ${back} m back: she stepped (${run.steps})`);
      const heel = Math.max(...run.feet.flatMap(f => f.map(s => s.phase === 'planted' ? s.pitch : 0)));
      // Before the fix a foot that landed behind her hips rolled onto its toes the instant it touched down (20.5° at the ankle
      // in one frame on Gene in the showcase; up to 3.3° of foot pitch here).
      assert.ok(heel < 1e-6, `${fps} fps, ${back} m back: planted feet stay flat (${(heel * DEG).toFixed(2)}°)`);
      assert.ok(pitchStep(run) < 0.5, `${fps} fps, ${back} m back: largest per-frame foot pitch step ${pitchStep(run).toFixed(2)}°`);
    }
    // Walking forward the trailing heel still rolls up: a steady roll of about 150°/s at most (2.5° a frame at 60 fps, 5° at 30),
    // the same speed at both rates, so a motion, not a jump.
    const forward = walk(fps, 8, { x: 0, z: 3 });
    assert.ok(Math.max(...forward.feet.flatMap(f => f.map(s => s.pitch))) > 0.2, 'heel-off while walking forward');
    assert.ok(pitchStep(forward) * fps < 160, `${fps} fps forward: fastest heel roll ${(pitchStep(forward) * fps).toFixed(0)}°/s`);
  }
});

test('walking starts and stops without a pop: the root accelerates smoothly and the first step goes as she sets off', () => {
  const run = walk(60, 14, { x: 0, z: 6 });
  const v = run.root.slice(1).map((r, i) => (r.z - run.root[i].z) * 60);
  const accel = v.slice(1).map((x, i) => (x - v[i]) * 60);
  const jerk = accel.slice(1).map((x, i) => Math.abs(x - accel[i]) * 60);
  assert.ok(Math.max(...accel.map(Math.abs)) < 1.5, `peak acceleration ${Math.max(...accel.map(Math.abs)).toFixed(2)} m/s²`);
  assert.ok(Math.max(...jerk) < 12, `peak jerk ${Math.max(...jerk).toFixed(1)} m/s³ (eased springs: acceleration never jumps)`);
  const firstLift = run.feet.findIndex(f => f.some(x => x.phase === 'swing'));
  assert.ok(run.root[firstLift].z < 0.05, `first step starts when her root has moved ${(run.root[firstLift].z * 100).toFixed(1)} cm`);
});

test('a planted foot stays within reach of its hip during a walk, and the feet never cross', () => {
  const run = walk(60, 14, { x: 0, z: 6 });
  let worst = 0, narrowest = Infinity;
  run.root.forEach((r, i) => run.feet[i].forEach((f, k) => {
    if (f.phase !== 'planted') return;
    const hx = r.x + GENE.home[k].x * Math.cos(r.heading), hz = r.z - GENE.home[k].x * Math.sin(r.heading);
    worst = Math.max(worst, Math.hypot(f.x - hx, f.z - hz));
  }));
  for (const feet of run.feet) narrowest = Math.min(narrowest, feet[0].x - feet[1].x);
  assert.ok(worst < 0.21, `farthest planted ankle from its hip ${(worst * 100).toFixed(1)} cm`);
  assert.ok(narrowest > 0.08, `her left foot stays to her left (${(narrowest * 100).toFixed(1)} cm)`);
});

test('a long way behind her: she turns (stepping as she turns), walks away, and turns back to the viewer', () => {
  const run = walk(60, 18, { x: 0.5, z: -6 });
  const headings = run.root.map(r => r.heading);
  const turned = Math.max(...headings.map(Math.abs));
  assert.ok(turned > 2.8, `faced the way she walked (${(turned * 57.3).toFixed(0)}°)`);
  let rate = 0, change = 0;
  for (let i = 2; i < headings.length; i++) {
    const a = headings[i] - headings[i - 1], b = headings[i - 1] - headings[i - 2];
    rate = Math.max(rate, Math.abs(a) * 60); change = Math.max(change, Math.abs(a - b));
  }
  assert.ok(rate < 3, `turns at most ${(rate * 57.3).toFixed(0)}°/s`);
  // Two springs in a row: the turning speed changes at most ~0.08°/frame per frame (≈ 300°/s²), it never jumps.
  assert.ok(change < 0.0025, `the turning speed never jumps (${(change * 57.3).toFixed(3)}°/frame change)`);
  const startedWalking = run.root.findIndex(r => Math.hypot(r.x, r.z) > 0.05);
  const stepsBefore = run.feet.slice(0, startedWalking).reduce((n, feet, i) => n + feet.filter((f, k) => f.phase === 'swing' && (i === 0 || run.feet[i - 1][k].phase !== 'swing')).length, 0);
  assert.ok(stepsBefore >= 2, `${stepsBefore} steps while turning on the spot`);
  const end = run.root.at(-1)!;
  assert.ok(Math.abs(end.x - 0.5) < 0.02 && Math.abs(end.z + 6) < 0.02, 'arrived');
  assert.ok(Math.abs(end.heading - Math.atan2(-0.5, 16)) < 0.05, `faces the viewer again (${(end.heading * 57.3).toFixed(1)}°)`);
});

test('a short move sideways is a side step that leads with the foot on that side', () => {
  const run = walk(60, 5, { x: 0.3, z: 0 });
  const first = run.feet.findIndex(f => f.some(x => x.phase === 'swing'));
  assert.equal(run.feet[first][0].phase, 'swing', 'moving to her left: the left foot goes first');
  assert.ok(Math.abs(run.root.at(-1)!.heading) < 0.05, 'no turning for a short move');
  assert.ok(run.steps <= 4, `${run.steps} steps for 30 cm`);
});

test('single stance: weight over the support foot first, the other foot lifted only then, and walking puts it down first', () => {
  const g = new Gait(GENE, { x: 0, z: 0, heading: 0 });
  // A COM that follows the hips (the figure feeds the measured one; here: the hips' point, enough to test the order).
  const com = () => { const p = g.pelvis; g.setCom({ x: p.lateral * 0.9, z: 0.03 }); };
  g.setStance('left');
  const states: string[] = []; let liftedAt = -1, marginAtLift = 0;
  for (let i = 0; i < 60 * 5; i++) {
    com(); g.step(1 / 60);
    if (states.at(-1) !== g.stance) states.push(g.stance);
    if (liftedAt < 0 && g.footStates[1].phase === 'swing') { liftedAt = i; marginAtLift = supportMargin({ x: g.pelvis.lateral * 0.9, z: 0.03 }, convexHull(footPatch(g.footStates[0], 0, GENE.foot))); }
  }
  assert.deepEqual(states, ['shifting', 'lifting', 'holding']);
  assert.ok(liftedAt > 30, 'not lifted at once');
  assert.ok(marginAtLift >= 0.01, `COM ${(marginAtLift * 100).toFixed(1)} cm inside the support foot when the other lifts`);
  assert.ok(Math.abs(g.footStates[1].lift - 0.07) < 1e-9, 'held 7 cm up');
  assert.equal(g.footStates[0].phase, 'planted');
  g.setGoal(0, 2);
  const after: string[] = [];
  for (let i = 0; i < 60 * 3; i++) { com(); g.step(1 / 60); if (after.at(-1) !== g.stance) after.push(g.stance); }
  assert.deepEqual(after, ['lowering', 'both'], 'puts the foot down before going anywhere');
  assert.ok(g.rootState.z > 0.1, 'then walks');
});

test('the body meter: drift over planted intervals, the largest root step and jolt, the standing COM margin', () => {
  const m = new BodyMeter();
  const toe = (x: number) => ({ x, y: 0, z: 0 });
  m.add({ root: { x: 0, y: 0, z: 0 }, standing: true, comMargin: 0.05, feet: [{ planted: true, toe: toe(0) }, { planted: true, toe: toe(1) }] });
  m.add({ root: { x: 0.01, y: 0, z: 0 }, standing: true, comMargin: 0.04, feet: [{ planted: true, toe: toe(0.002) }, { planted: false, toe: toe(1.5) }] });
  m.add({ root: { x: 0.03, y: 0, z: 0 }, standing: false, comMargin: -0.1, feet: [{ planted: true, toe: toe(0.001) }, { planted: true, toe: toe(2) }] });
  const v = m.value;
  assert.equal(v.frames, 3);
  assert.ok(Math.abs(v.driftCm - 0.2) < 1e-9 && Math.abs(v.rootStepCm - 2) < 1e-9 && Math.abs(v.rootSurpriseCm - 1) < 1e-9);
  assert.ok(Math.abs(v.standingComMarginCm! - 4) < 1e-9, 'walking frames do not count');
});

test('the walk and stance knobs: strict, in range, and defaults', () => {
  assert.deepEqual(parseUnboundControlPatch({ walkSpeedMps: 1, stepLengthM: 0.25, stance: 'left' }), { walkSpeedMps: 1, stepLengthM: 0.25, stance: 'left' });
  for (const bad of [{ walkSpeedMps: 3 }, { walkSpeedMps: '1' }, { stepLengthM: 0.05 }, { stance: 'up' }, { stance: 'left', extra: 1 }])
    assert.throws(() => parseUnboundControlPatch(bad), JSON.stringify(bad));
  assert.deepEqual({ ...UNBOUND_BODY_DEFAULTS }, { walkSpeedMps: 0.7, stepLengthM: 0.3, stance: 'both' });
});
