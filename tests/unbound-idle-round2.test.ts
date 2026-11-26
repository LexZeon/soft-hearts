// Motion-model spike round 2 (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」): the hips and arms as residuals about her
// body axes (a turn asked for is the turn Gene makes, whatever her rest pose), the left-right mirror, the event layer (people's
// quick moves laid over the slow idle: they start and end at zero, fire about as often as asked, never jump), the learned prior,
// and the small API for the lapwing showcase (falls back to the procedural idle without weights; layers onto other targets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Euler, Quaternion, Vector3, type SkinnedMesh } from 'three';
import { LimbResidual } from '../src/unbound/limb-residual';
import { IDLE_DIM, IDLE_MIRROR_SIGN, idleTargets, mirrorFrame, type IdleSource } from '../src/unbound/motion/idle-channels';
import { IdleEvents, eventRatePerMinute, type IdleEventLibrary } from '../src/unbound/motion/idle-events';
import { IdleModel, ModelIdle, type IdleModelWeights } from '../src/unbound/motion/idle-model';
import { createLearnedIdle, layerIdle } from '../src/unbound/motion/learned-idle';
import { REST_TARGETS, ZERO_ROT, type PoseTargets } from '../src/unbound/motion/generator';
import { runGene, plantedDrift, surpriseAngles, TRACKED } from './helpers/unbound-gene';
import { UNITS_PER_M } from '../src/unbound/figure';

class Still implements IdleSource { readonly id = 'still'; reset(): void {} next(): Float32Array { return new Float32Array(IDLE_DIM); } }

test('a limb turn is about her body axes, whatever the parent and the bone are already turned by', () => {
  // A chain: 上半身 turned 50° about Z (a lean), 左腕 posed 70° about Z (an A-pose arm hanging) and 20° about X.
  const upper = new Bone(), arm = new Bone();
  upper.name = '上半身'; arm.name = '左腕';
  upper.add(arm);
  upper.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 50 * Math.PI / 180);
  arm.quaternion.setFromEuler(new Euler(20 * Math.PI / 180, 0, 70 * Math.PI / 180));
  upper.updateMatrixWorld(true);
  const before = arm.getWorldQuaternion(new Quaternion());
  const limbs = new LimbResidual({ skeleton: { bones: [upper, arm] } } as unknown as SkinnedMesh);
  const yaw = 0.3;
  limbs.set({ armRot: { left: { upper: { pitch: 0, yaw, roll: 0 }, elbow: ZERO_ROT }, right: { upper: ZERO_ROT, elbow: ZERO_ROT } } });
  for (let i = 0; i < 120 * 10; i++) limbs.advance(1 / 120); // long enough for the springs to arrive
  limbs.apply((bone, r) => bone.quaternion.multiply(r));
  upper.updateMatrixWorld(true);
  const after = arm.getWorldQuaternion(new Quaternion());
  const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).multiply(before); // W · before, W about her up
  assert.ok(after.angleTo(expected) < 1e-3, `off by ${(after.angleTo(expected) * 180 / Math.PI).toFixed(3)}°`);
});

test('the mirror flips lateral, yaws and rolls, swaps the arms, and twice is nothing', () => {
  const f = Float32Array.from({ length: IDLE_DIM }, (_, c) => c + 1), m = mirrorFrame(f);
  assert.equal(m[0], -1); assert.equal(m[3], 4); assert.equal(m[4], -5); assert.equal(m[5], -6);
  assert.equal(m[15], 22, 'left upper-arm pitch takes the right one'); assert.equal(m[22], -17, 'right upper-arm yaw takes the left one, flipped');
  assert.deepEqual(Array.from(mirrorFrame(m)), Array.from(f));
  assert.equal(IDLE_MIRROR_SIGN.length, IDLE_DIM);
});

test('idle frames carry hips and arms; limbs: false leaves them to the body', () => {
  const f = new Float32Array(IDLE_DIM); f[12] = 0.05; f[15] = -0.2; f[24] = 0.1;
  const t = idleTargets(f, { heightM: 1.6 });
  assert.equal(t.hips?.pitch, f[12]);
  assert.equal(t.armRot?.left.upper.pitch, f[15]);
  assert.equal(t.armRot?.right.elbow.pitch, f[24]);
  const off = idleTargets(f, { heightM: 1.6, limbs: false });
  assert.equal(off.hips, undefined); assert.equal(off.armRot, undefined);
});

/** One event: a bump on head yaw (channel 10) over 12 frames, zero at both ends. */
const BUMP: IdleEventLibrary = (() => {
  const frames = 12, events = new Float32Array(frames * IDLE_DIM);
  for (let k = 0; k < frames; k++) events[k * IDLE_DIM + 10] = 0.1 * Math.sin(Math.PI * k / (frames - 1)) ** 2;
  return { events, frames, perMinuteByActivityFifth: [0, 0, 6, 12, 24] };
})();

test('events: as often as the people at that liveliness, each starting and ending at zero, none at a calm knob', () => {
  assert.equal(eventRatePerMinute(BUMP, 0.5), 6);
  assert.equal(eventRatePerMinute(BUMP, 0.1), 0);
  const run = (activity: number) => {
    const layer = new IdleEvents(new Still(), BUMP, { seed: 3 }), ys: number[] = [];
    for (let i = 0; i < 30 * 600; i++) ys.push(layer.next(activity)[10]);
    return { fired: layer.fired, ys };
  };
  const calm = run(0.1), lively = run(0.9);
  assert.equal(calm.fired, 0);
  // 24 a minute at 0.9 (interpolated ~20.4), minus the busy time and the gaps: within a wide band over 10 minutes.
  assert.ok(lively.fired > 120 && lively.fired < 260, `fired ${lively.fired}`);
  const steps = lively.ys.slice(1).map((v, i) => Math.abs(v - lively.ys[i]));
  assert.ok(Math.max(...steps) < 0.03, `largest step ${Math.max(...steps)} (the bump is 0.1 high, 12 frames long)`);
  // The mirror flips the yaw of half of them.
  assert.ok(lively.ys.some(v => v < -0.05) && lively.ys.some(v => v > 0.05));
});

/** A tiny model with a learned prior whose mean is `priorMu` for every z (decoder: offsets = z[0] on every channel). */
function priorModel(priorMu: number): IdleModelWeights {
  const H = 2, Z = 2, input = Z + H * IDLE_DIM + 1;
  const decoderRow = (o: number) => Array.from({ length: input }, (_, i) => (i === 0 ? 1 : 0) * (o >= 0 ? 1 : 0));
  return { kind: 'idle-ar-cvae', history: H, chunk: 1, latent: Z, hidden: 1, dim: IDLE_DIM, std: new Array(IDLE_DIM).fill(0.1), gain: new Array(IDLE_DIM).fill(2),
    layers: [{ weight: [decoderRow(0)], bias: [0] }, { weight: Array.from({ length: IDLE_DIM }, () => [1]), bias: new Array(IDLE_DIM).fill(0) }],
    prior: [{ weight: [new Array(H * IDLE_DIM + 1).fill(0)], bias: [0] }, { weight: Array.from({ length: 2 * Z }, () => [0]), bias: [priorMu, priorMu, -8, -8] }] };
}

test('the learned prior steers z, the calibration gain scales only what is shown', () => {
  const model = new IdleModel(priorModel(0.05));
  assert.ok(model.hasPrior);
  const source = new ModelIdle(model, { seed: 1, zScale: 0, leashS: 0 }), raw = new ModelIdle(model, { seed: 1, zScale: 0, calibrated: false, leashS: 0 });
  let a = 0, b = 0;
  for (let i = 0; i < 4; i++) { a = source.next(0.5)[3]; b = raw.next(0.5)[3]; }
  // z = 0.05 (the prior's mean; no noise): the history climbs 0.05 std a frame (ELU(0.05) through a weight of 1), shown ×0.1 std × gain 2.
  assert.ok(Math.abs(b - 4 * 0.05 * 0.1) < 1e-6, `raw ${b}`);
  assert.ok(Math.abs(a - 2 * b) < 1e-6, `calibrated ${a} = 2 × raw ${b}`);
  assert.throws(() => new IdleModel({ ...priorModel(0), prior: [{ weight: [[0]], bias: [0] }, { weight: [[0]], bias: [0] }] }), /prior shapes/);
});

test('createLearnedIdle: procedural without weights (or with weights for other channels), the model with them; layerIdle adds', () => {
  const plain = createLearnedIdle({ heightM: 1.6 });
  assert.equal(plain.learned, false); assert.equal(plain.id, 'procedural');
  const wrong = createLearnedIdle({ heightM: 1.6, weights: { ...priorModel(0), dim: 12 } });
  assert.equal(wrong.learned, false);
  const learned = createLearnedIdle({ heightM: 1.6, weights: priorModel(0.02), events: BUMP, activation: 0.9, seed: 4 });
  assert.equal(learned.learned, true); assert.equal(learned.id, 'model+events');
  let t: PoseTargets = REST_TARGETS;
  for (let i = 0; i < 30; i++) t = learned.frame(1 / 60);
  assert.ok(t.torso.pitch !== 0 && t.armRot && t.hips);
  const base: PoseTargets = { ...REST_TARGETS, head: { pitch: 0.2, yaw: 0, roll: 0 }, eyes: { yaw: 0.1, pitch: 0 } };
  assert.equal(layerIdle(base, t, 0), base);
  const layered = layerIdle(base, t, 1);
  assert.ok(Math.abs(layered.head.pitch - (0.2 + t.head.pitch)) < 1e-12);
  assert.deepEqual(layered.eyes, base.eyes, 'eyes stay the caller\'s');
  assert.ok(Math.abs(layerIdle(base, t, 0.5).torso.yaw - t.torso.yaw * 0.5) < 1e-12);
});

const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
for (const fps of [60, 30]) {
  test(`hips and arms in Gene's real frame loop at ${fps} fps: a forward swing asked for brings her left hand forward, her feet stay put`, async () => {
    const hand = new Vector3(), shoulder = new Vector3();
    const seen: { start: Vector3 | null; end: Vector3 | null } = { start: null, end: null };
    const swing: PoseTargets = { ...REST_TARGETS, hips: { pitch: 0, yaw: 0.06, roll: 0.03 },
      armRot: { left: { upper: { pitch: -0.35, yaw: 0, roll: 0 }, elbow: { pitch: -0.2, yaw: 0, roll: 0 } }, right: { upper: ZERO_ROT, elbow: ZERO_ROT } } };
    const { frames } = await runGene(fps, 4, (t, figure) => {
      const bones = figure.mesh.skeleton.bones, at = (name: string, v: Vector3) => figure.mesh.worldToLocal(bones.find(b => b.name === name)!.getWorldPosition(v));
      if (t > 0.9 && t < 1.0 && !seen.start) { seen.start = at('左手首', hand).sub(at('左腕', shoulder)).clone(); }
      if (t >= 1) figure.setPoseTargets(swing);
      if (t > 3.9 && !seen.end) seen.end = at('左手首', hand).sub(at('左腕', shoulder)).clone();
    });
    const { start, end } = seen;
    assert.ok(start && end);
    // Her model frame: +Z forward (the figure's own arm swing uses the same axes).
    assert.ok(end!.z - start!.z > 0.03 * UNITS_PER_M, `left hand forward by ${((end!.z - start!.z) / UNITS_PER_M * 100).toFixed(1)} cm`)
    const restAnkleY = (frames[0].feet[0].ankle.y + frames[0].feet[1].ankle.y) / 2;
    const drift = plantedDrift(frames.slice(fps), restAnkleY);
    assert.ok(drift.drift < 0.3 && drift.toeDrift < 0.3, `feet planted (${drift.drift.toFixed(3)} / ${drift.toeDrift.toFixed(3)} cm) with the hips turned`);
    const jolt = Math.max(...surpriseAngles(frames, fps, UPPER));
    assert.ok(jolt < 0.25 * (60 / fps) ** 2, `a step change of targets eases in (largest unexpected step ${jolt.toFixed(4)}°)`);
  });
}

test('the leash keeps a drifting model near her stand pose; off, the same model walks to the guard', () => {
  // A decoder that always adds 0.02 std per frame (a slow, endless drift).
  const H = 2, Z = 2, input = Z + H * IDLE_DIM + 1;
  const drift: IdleModelWeights = { kind: 'idle-ar-cvae', history: H, chunk: 1, latent: Z, hidden: 1, dim: IDLE_DIM, std: new Array(IDLE_DIM).fill(1),
    layers: [{ weight: [new Array(input).fill(0)], bias: [0] }, { weight: Array.from({ length: IDLE_DIM }, () => [0]), bias: new Array(IDLE_DIM).fill(0.02) }] };
  const run = (leashS: number) => { const s = new ModelIdle(new IdleModel(drift), { seed: 1, leashS, calibrated: false }); let v = 0; for (let i = 0; i < 30 * 120; i++) v = s.next(0.5)[9]; return v; };
  // With a 2 s leash the drift settles where pull and push balance: v = (v + 0.02)·k, k = e^(−1/60), so v = 0.02·k / (1 − k) ≈ 1.19 std.
  const k = Math.exp(-1 / 60);
  assert.ok(Math.abs(run(2) - 0.02 * k / (1 - k)) < 0.01, `leashed ${run(2)}`);
  assert.equal(run(0), 4, 'no leash: held only by the guard');
});
