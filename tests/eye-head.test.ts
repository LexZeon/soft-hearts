// E1 eye-head coordination (docs/claude/2026-11-14-eye-head-fix.md, src/stage/eye-head.ts): the rules on their own, with the head
// moved by the same eased 1.6 Hz spring the Unbound figure uses, at the figure's 1/120 s sub-steps. The real frame loops (Gene in
// Unbound and on the companion) are in eye-head-gene.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EYE_HEAD_DEFAULTS, EyeHeadCoordinator, EyePoseLimiter, eyeLimitsAlong, kneeLimit, type EyeHeadOutput, type EyeHeadParams, type Look } from '../src/stage/eye-head';
import { MOTION_GROUPS, Spring } from '../src/unbound/dynamics';

const RAD = Math.PI / 180, DEG = 180 / Math.PI, H = 1 / 120;
interface Sample { t: number; out: EyeHeadOutput; headNow: Look }

/** Runs the coordinator for `seconds` with targets from `target(t)`; the head (and chest) follow its goals through springs. */
function run(seconds: number, target: (t: number) => Look | null, fallback: (t: number) => Look = () => ({ yaw: 0, pitch: 0 }), params: Partial<EyeHeadParams> = {}): Sample[] {
  const coordinator = new EyeHeadCoordinator(params);
  const spec = { ...MOTION_GROUPS.head, eased: true }, chestSpec = { ...MOTION_GROUPS.chest, eased: true };
  const yaw = new Spring(spec), pitch = new Spring(spec), chest = new Spring(chestSpec);
  const samples: Sample[] = [];
  for (let i = 0; i < Math.round(seconds / H); i++) {
    const t = i * H, headNow = { yaw: yaw.value + chest.value, pitch: pitch.value };
    const out = coordinator.step(H, { target: target(t), fallback: fallback(t), headNow });
    yaw.target = out.head.yaw; pitch.target = out.head.pitch; chest.target = out.chestYaw;
    yaw.advance(H); pitch.advance(H); chest.advance(H);
    samples.push({ t, out, headNow });
  }
  return samples;
}
const at = (samples: Sample[], t: number) => samples[Math.min(samples.length - 1, Math.round(t / H))];
const deg = (rad: number) => rad * DEG;

test('a small look is eyes only at first; a big one keeps the eyes within the limits and never long past the soft one', () => {
  const small = run(1.5, t => ({ yaw: t >= 0.5 ? 8 * RAD : 0, pitch: 0 }));
  assert.ok(small.filter(s => s.t < 0.5 + EYE_HEAD_DEFAULTS.headDelayS).every(s => s.out.head.yaw === 0), 'under 12°: no head at first');
  assert.ok(Math.abs(deg(at(small, 0.55).out.eyes.yaw) - 8) < 1e-9, 'the eyes take all of it');
  assert.ok(deg(at(small, 1.5).out.head.yaw) < 0.9 * 4 + 1e-9, 'held, the head comes only a little (90% past 4°)');

  const big = run(3, () => ({ yaw: 60 * RAD, pitch: -25 * RAD }));
  const soft = EYE_HEAD_DEFAULTS.eyeSoft, hard = EYE_HEAD_DEFAULTS.eyeHard;
  for (const s of big) {
    assert.ok(Math.abs(deg(s.out.eyes.yaw)) <= hard.yaw + 1e-9 && deg(s.out.eyes.pitch) >= -hard.up - 1e-9, `within the hard limits at ${s.t.toFixed(3)} s`);
  }
  // Past soft + 1° only in the first ~0.15 s after the look starts (an eye dart), then at most at the soft limit while the head
  // comes; near the hard limit (within 2°) under 0.05 s.
  const past = big.filter(s => Math.abs(deg(s.out.eyes.yaw)) > soft.yaw + 1 || -deg(s.out.eyes.pitch) > soft.up + 1);
  assert.ok(past.length > 0, 'the eyes do lead past the soft limit for a moment');
  assert.ok(past.every(s => s.t < 0.15), `past soft only briefly (last at ${past.at(-1)?.t.toFixed(3)} s)`);
  const edge = big.filter(s => Math.abs(deg(s.out.eyes.yaw)) > hard.yaw - 2 || -deg(s.out.eyes.pitch) > hard.up - 2);
  assert.ok(edge.every(s => s.t < 0.05), `near the edge only for a moment (last at ${edge.at(-1)?.t.toFixed(3)} s)`);
});

test('the head starts after the eyes, takes about 60% (at least the overflow) of a 35° look, then more while the eyes come back toward the middle', () => {
  const samples = run(4, t => ({ yaw: t >= 0.5 ? 35 * RAD : 0, pitch: 0 }));
  // Delay: the head's goal stays at rest for headDelayS after the eyes have moved.
  const eyesMove = samples.find(s => s.out.eyes.yaw > 1e-6)!, headMoves = samples.find(s => s.out.head.yaw > 1e-6)!;
  assert.ok(Math.abs(eyesMove.t - 0.5) < 1e-9, 'eyes at once');
  assert.ok(Math.abs(headMoves.t - eyesMove.t - EYE_HEAD_DEFAULTS.headDelayS) < 2 * H, `head ${((headMoves.t - eyesMove.t) * 1000).toFixed(0)} ms after the eyes`);
  // First share: max(overflow 23°, 60% of 23°) = 23°; the research's 35° → ~21° (to within a few degrees).
  const first = deg(at(samples, 0.5 + EYE_HEAD_DEFAULTS.headDelayS + 2 * H).out.head.yaw);
  assert.ok(first > 20 && first < 26, `first head goal ${first.toFixed(1)}°`);
  // Held: the head goes on to ~90% of the look past 4° and the eyes come back toward the middle.
  const end = at(samples, 4);
  assert.ok(deg(end.out.head.yaw) > 27, `held head goal ${deg(end.out.head.yaw).toFixed(1)}°`);
  assert.ok(Math.abs(deg(end.out.eyes.yaw)) < 8.5, `eyes back toward the middle: ${deg(end.out.eyes.yaw).toFixed(1)}°`);
  assert.ok(Math.abs(deg(at(samples, 0.9).out.eyes.yaw)) > 11, 'while the head was still on its way the eyes held the look');
  // The look itself is kept: eyes + head as shown ≈ the target once settled.
  assert.ok(Math.abs(deg(end.out.eyes.yaw + end.headNow.yaw) - 35) < 1, 'still looking at it');
});

test('a target behind her is let go: she looks where she is going, and a target sweeping round as she turns hands over without a jump', () => {
  const behind = run(3, () => ({ yaw: 160 * RAD, pitch: 0 }), () => ({ yaw: 10 * RAD, pitch: 0 }));
  const end = at(behind, 3);
  assert.ok(end.out.released, 'released');
  assert.ok(Math.abs(deg(end.out.gaze.yaw) - 10) < 0.5, `looks where she is going (${deg(end.out.gaze.yaw).toFixed(1)}°)`);
  assert.ok(Math.abs(deg(end.headNow.yaw)) < 12, 'the head is not twisted round toward the target');
  // She turns away at 120°/s: the target sweeps from in front past 180° (it wraps to −180° there) while she walks to the other side.
  const sweep = run(3, t => ({ yaw: Math.min(200, t * 120) * RAD, pitch: 0 }), () => ({ yaw: -30 * RAD, pitch: 0 }));
  let jump = 0, headJump = 0;
  for (let i = 1; i < sweep.length; i++) {
    jump = Math.max(jump, Math.abs(sweep[i].out.gaze.yaw - sweep[i - 1].out.gaze.yaw) * DEG);
    headJump = Math.max(headJump, Math.abs(sweep[i].out.head.yaw - sweep[i - 1].out.head.yaw) * DEG);
  }
  assert.ok(jump < 3, `the look moves at most ${jump.toFixed(2)}° per 1/120 s (no flip at the wrap)`);
  assert.ok(headJump < 2.5, `the head goal moves at most ${headJump.toFixed(2)}° per 1/120 s`);
  assert.ok(Math.abs(deg(at(sweep, 3).out.gaze.yaw) + 30) < 1, 'ends looking where she is going');
});

test('no target: she looks where she is going, followed at a head\'s pace (a new walk does not snap her look)', () => {
  const samples = run(2, () => null, t => ({ yaw: t >= 0.2 ? 40 * RAD : 0, pitch: 0 }));
  let step = 0;
  for (let i = 1; i < samples.length; i++) step = Math.max(step, Math.abs(samples[i].out.gaze.yaw - samples[i - 1].out.gaze.yaw) * DEG);
  assert.ok(step < 1.5, `the look moves at most ${step.toFixed(2)}° per 1/120 s`);
  assert.ok(Math.abs(deg(at(samples, 2).out.gaze.yaw) - 40) < 1);
});

test('the knee: continuous, at the soft limit when its allowance is gone, never past the hard limit', () => {
  const soft = 12 * RAD, hard = 18 * RAD;
  assert.equal(kneeLimit(0.1, soft, hard), 0.1);
  assert.ok(Math.abs(kneeLimit(soft + 1e-9, soft, hard) - soft) < 1e-8);
  assert.ok(kneeLimit(2, soft, hard) < hard && kneeLimit(2, soft, hard) > 17.9 * RAD);
  assert.equal(kneeLimit(-2, soft, hard, 0), -soft);
});

test('the pet\'s eye guard: untouched under the soft limit (exactly), held within the limits above it, back to soft within ~0.25 s', () => {
  const limiter = new EyePoseLimiter();
  for (let i = 0; i < 60; i++) assert.equal(limiter.limit(10 * RAD, 5 * RAD, 1 / 60), null);
  const shown: Look[] = [];
  for (let i = 0; i < 30; i++) shown.push(limiter.limit(30 * RAD, -20 * RAD, 1 / 60)!);
  assert.ok(shown.every(s => Math.abs(s.yaw) <= 18 * RAD + 1e-9 && -s.pitch <= 14 * RAD + 1e-9));
  // The companion keeps the per-axis box (round 8 moved only the coordinator to the ellipse: the I-038 pins hold the companion's shy show).
  assert.ok(Math.abs(shown[14].yaw * DEG - 12) < 0.5 && Math.abs(-shown[14].pitch * DEG - 9) < 0.5, `after 250 ms: ${shown[14].yaw * DEG}°, ${shown[14].pitch * DEG}°`);
});

test('round 8: the limits join along an ellipse — straight across, up and down as before; a diagonal look never leaves the pupils past ~15°', () => {
  const D = EYE_HEAD_DEFAULTS;
  // Along the axes: exactly the per-axis numbers.
  assert.ok(Math.abs(eyeLimitsAlong(D, 1, 0).soft * DEG - 12) < 1e-9 && Math.abs(eyeLimitsAlong(D, 0, 1).soft * DEG - 14) < 1e-9 && Math.abs(eyeLimitsAlong(D, 0, -1).soft * DEG - 9) < 1e-9);
  // Down and to the side at 45°: 1/hypot(cos/12, sin/14) ≈ 12.9° (the box allowed hypot(12, 14) ≈ 18.4°).
  assert.ok(Math.abs(eyeLimitsAlong(D, 1, 1).soft * DEG - 12.89) < 0.02, `diagonal soft ${eyeLimitsAlong(D, 1, 1).soft * DEG}`);
  // The coordinator on a held look down and to the side (40° across, 25° down): the eyes' combined angle stays near the ellipse
  // (past 15° only for the first instant of the dart) and is back under its soft limit once the head has come.
  const held = run(3, () => ({ yaw: 40 * RAD, pitch: 25 * RAD }));
  const combined = held.map(s => Math.hypot(s.out.eyes.yaw, s.out.eyes.pitch) * DEG);
  const over = held.filter((_, i) => combined[i] > 15);
  assert.ok(over.every(s => s.t < 0.1), `past 15° only in the first 0.1 s (${over.length} samples, last at ${over.at(-1)?.t.toFixed(3)} s)`);
  assert.ok(combined.filter((_, i) => held[i].t > 0.4).every(c => c <= 12.9 + 1e-6), `settled inside the diagonal soft limit (max ${Math.max(...combined.filter((_, i) => held[i].t > 0.4)).toFixed(2)}°)`);
  const sorted = [...combined].sort((a, b) => a - b);
  assert.ok(sorted[Math.floor(0.95 * (sorted.length - 1))] <= 15, 'p95 ≤ 15°');
  // The gaze still gets there: the head takes what the eyes cannot (within 1° of the target by 1.5 s).
  const s = at(held, 1.5), gaze = { yaw: s.out.eyes.yaw + s.headNow.yaw, pitch: s.out.eyes.pitch + s.headNow.pitch };
  assert.ok(Math.hypot(gaze.yaw - 40 * RAD, gaze.pitch - 25 * RAD) * DEG < 1, `on target by 1.5 s (${(Math.hypot(gaze.yaw - 40 * RAD, gaze.pitch - 25 * RAD) * DEG).toFixed(2)}° off)`);
});
