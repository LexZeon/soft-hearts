// Motion-model spike (docs/claude/2026-11-14-motion-model-spike.md): the idle sources as layer-2 targets. Resampling shows one
// curve at 60 and 30 fps; motion matching's jumps never show (inertialization: continuous value and velocity); the model streams,
// stays bounded and only ever hands targets; the 'idle' intent falls back to the quiet rest for the procedural generator; and in
// Gene's real Unbound frame loop an idle keeps her feet planted with no step and no jolt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_DIM, IdleGenerator, Resampled30, idleTargets, type IdleSource } from '../src/unbound/motion/idle-channels';
import { ProceduralIdle } from '../src/unbound/motion/idle-procedural';
import { MatchingIdle, type IdleDatabase } from '../src/unbound/motion/idle-matching';
import { IdleModel, ModelIdle, type IdleModelWeights } from '../src/unbound/motion/idle-model';
import { GeneratorChain, REST_TARGETS, type BodySense, type MotionRequest } from '../src/unbound/motion/generator';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { runGene, surpriseAngles, plantedDrift, TRACKED } from './helpers/unbound-gene';

const SENSE = { root: { x: 0, z: 0, heading: 0 }, moving: false, eyes: { left: null, right: null }, head: null, frame: null, offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: null, tiptoeRise: 0 } as BodySense;
const idleRequest = (dt: number, activity = 0.5): MotionRequest => ({ intent: { kind: 'idle', activity }, t: 0, dt, sense: SENSE });

/** A 30 Hz source that plays a sine (channel c at frequency 0.3 + 0.05c Hz). */
class SineSource implements IdleSource {
  readonly id = 'sine';
  private n = 0;
  reset(): void { this.n = 0; }
  next(): Float32Array { const t = this.n++ / 30; return Float32Array.from({ length: IDLE_DIM }, (_, c) => 0.05 * Math.sin(2 * Math.PI * (0.3 + 0.05 * c) * t)); }
}

test('Resampled30 shows the same curve at 60 and 30 fps, without kinks between source frames', () => {
  const sample = (fps: number, seconds: number) => { const r = new Resampled30(new SineSource()), out: number[] = []; for (let i = 0; i < fps * seconds; i++) out.push(r.sample(i ? 1 / fps : 0, 0.5)[3]); return out; };
  const at60 = sample(60, 6), at30 = sample(30, 6);
  for (let i = 0; i < at30.length; i++) assert.ok(Math.abs(at30[i] - at60[2 * i]) < 1e-6, `same value at the same time (${i})`);
  // The second difference of a smooth sine at 60 fps stays near (2π f)² A dt²; a linear interpolation would kink every other frame.
  const f = 0.3 + 0.05 * 3, ideal = (2 * Math.PI * f) ** 2 * 0.05 / 3600;
  const kinks = at60.slice(2).map((v, i) => Math.abs(v - 2 * at60[i + 1] + at60[i]));
  assert.ok(Math.max(...kinks.slice(10)) < ideal * 1.6, `second difference ${Math.max(...kinks)} vs ${ideal}`);
});

test("idleTargets maps channels onto PoseTargets and keeps garbage out", () => {
  const frame = new Float32Array(IDLE_DIM); frame[0] = 0.01; frame[4] = 0.1; frame[11] = Number.NaN;
  const t = idleTargets(frame, { heightM: 1.6 });
  assert.ok(Math.abs(t.pelvis.lateral - 0.016) < 1e-9);
  assert.equal(t.torso.yaw, frame[4]);
  assert.equal(t.head.roll, 0);
  assert.deepEqual({ eyes: t.eyes, face: t.face, place: t.place, tiptoe: t.tiptoe }, { eyes: REST_TARGETS.eyes, face: REST_TARGETS.face, place: null, tiptoe: 0 });
  assert.equal(idleTargets(Float32Array.from({ length: IDLE_DIM }, () => 50), { heightM: 1.6 }).torso.pitch, 1, 'clamped to 1 rad');
});

test("only the idle source answers 'idle'; everything else (and idle without one) falls to the procedural generator", () => {
  const chain = new GeneratorChain([new IdleGenerator(new ProceduralIdle(1), { heightM: 1.6 }), new ProceduralGenerator()]);
  const idle = chain.generate(idleRequest(1 / 60));
  assert.ok(idle.torso.pitch !== 0 || idle.pelvis.lateral !== 0, 'the idle source moved her');
  assert.deepEqual(new ProceduralGenerator().generate(idleRequest(1 / 60)), { ...REST_TARGETS }, 'procedural fallback: quiet rest');
  assert.deepEqual(chain.generate({ intent: { kind: 'rest' }, t: 0, dt: 1 / 60, sense: SENSE }), { ...REST_TARGETS });
});

test('ProceduralIdle is a function of time and seed, and moves more with the liveliness knob', () => {
  const a = new ProceduralIdle(4), b = new ProceduralIdle(4);
  assert.deepEqual(Array.from(a.at(12.3, 0.5)), Array.from(b.at(12.3, 0.5)));
  const spread = (activity: number) => { const s = new ProceduralIdle(4); let sum = 0; for (let i = 0; i < 1800; i++) sum += s.at(i / 30, activity)[10] ** 2; return Math.sqrt(sum / 1800); };
  assert.ok(spread(0.9) > spread(0.1) * 1.8);
});

/** Two stretches far apart in pose (one around +0.1, calm; one around −0.1, lively): a jump between them would show. */
function farApartDatabase(): IdleDatabase {
  const n = 600, frames = new Float32Array(2 * n * IDLE_DIM), activity = new Float32Array(2 * n);
  for (let s = 0; s < 2; s++) for (let i = 0; i < n; i++) for (let c = 0; c < IDLE_DIM; c++)
    frames[(s * n + i) * IDLE_DIM + c] = (s ? -0.1 : 0.1) + 0.02 * Math.sin(2 * Math.PI * (i / 30) * (0.2 + 0.03 * c) + s);
  activity.fill(0.2, 0, n); activity.fill(0.8, n);
  return { frames, activity, segments: [{ start: 0, length: n }, { start: n, length: n }], std: new Array(IDLE_DIM).fill(0.05) };
}
const worstJolt = (halfLife: number) => {
  // The knob goes from calm to lively and back every 10 s: each change sends her to the other stretch.
  const m = new MatchingIdle(farApartDatabase(), { halfLife, searchEvery: 0.5, velocityWeight: 0, activityWeight: 1000, seed: 3 });
  const xs: number[] = [];
  for (let i = 0; i < 30 * 40; i++) xs.push(m.next(Math.floor(i / 300) % 2 ? 0.8 : 0.2)[0]);
  const steps = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
  const jolts = xs.slice(2).map((v, i) => Math.abs(v - 2 * xs[i + 1] + xs[i]));
  return { jumps: m.jumps, step: Math.max(...steps), jolt: Math.max(...jolts) };
};

test('motion matching jumps between takes but never shows it (inertialization); without it the jump would show', () => {
  const smooth = worstJolt(0.25);
  assert.ok(smooth.jumps >= 10, `it searched and jumped (${smooth.jumps})`);
  // The data's own step at 30 Hz is ≤ 0.02·2π·0.53/30 ≈ 0.0022; a jump between the stretches is 0.2.
  assert.ok(smooth.step < 0.02, `largest step ${smooth.step}`);
  assert.ok(smooth.jolt < 0.008, `largest change of step ${smooth.jolt}`); // a hard cut: 0.2 (the whole gap in one frame)
  const raw = worstJolt(1e-4); // the offset dies at once: the jump shows
  assert.ok(raw.step > 0.1, `a hard cut shows (${raw.step})`);
});

/** A tiny decoder: one hidden unit, then frame k of the chunk = last + bias·(k+1) on every channel (std units): a steady drift. */
function tinyModel(bias: number, chunk = 1): IdleModelWeights {
  const H = 2, Z = 2, input = Z + H * IDLE_DIM + 1, n = chunk * IDLE_DIM;
  return { kind: 'idle-ar-cvae', history: H, chunk, latent: Z, hidden: 1, dim: IDLE_DIM, std: new Array(IDLE_DIM).fill(0.1),
    layers: [{ weight: [new Array(input).fill(0)], bias: [0] }, { weight: Array.from({ length: n }, () => [0]), bias: Array.from({ length: n }, (_, i) => bias * (Math.floor(i / IDLE_DIM) + 1)) }] };
}

test('a chunked model decodes once per chunk and streams the frames one by one, continuing from the last', () => {
  const source = new ModelIdle(new IdleModel(tinyModel(0.01, 3)), { seed: 2, leashS: 0 });
  const xs: number[] = [];
  for (let i = 0; i < 9; i++) xs.push(source.next(0.5)[4]);
  assert.equal(source.calls, 3);
  // A steady 0.01 std (= 0.001) per frame across chunk boundaries: no restart, no jump.
  xs.forEach((v, i) => assert.ok(Math.abs(v - 0.001 * (i + 1)) < 1e-6, `frame ${i}: ${v}`));
  assert.throws(() => new IdleModel({ ...tinyModel(0, 3), chunk: 2 }), /shapes/);
});

test('the model streams one frame per call, stays inside its guard and is reproducible per seed', () => {
  const runaway = new ModelIdle(new IdleModel(tinyModel(0.5)), { seed: 2 });
  let last = new Float32Array(IDLE_DIM);
  for (let i = 0; i < 100; i++) last = Float32Array.from(runaway.next(0.5));
  assert.ok(Math.abs(last[0] - 0.4) < 1e-6, 'held at 4 spreads');
  assert.ok(runaway.guarded > 0);
  assert.throws(() => new IdleModel({ ...tinyModel(0), dim: 3 }), /channels/);
  const parity = new IdleModel(tinyModel(0.01)).delta(new Float32Array(2), new Float32Array(2 * IDLE_DIM), 0.5);
  assert.ok(Array.from(parity).every(v => Math.abs(v - 0.01) < 1e-7));
});

const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
for (const fps of [60, 30]) {
  test(`an idle in Gene's real Unbound frame loop at ${fps} fps: she moves, her feet stay planted, no step, no jolt`, async () => {
    let generator: IdleGenerator | null = null;
    const { frames } = await runGene(fps, 12, (t, figure) => {
      if (generator) figure.setPoseTargets(generator.generate(idleRequest(t === 0 ? 0 : 1 / fps, 0.7)));
    }, { setup: figure => { generator = new IdleGenerator(new ProceduralIdle(5), { heightM: figure.heightM }); } });
    const warm = 2 * fps, shown = frames.slice(warm);
    const headTurn = Math.max(...shown.map(f => f.rotations[TRACKED.indexOf('頭')].angleTo(shown[0].rotations[TRACKED.indexOf('頭')]))) * 180 / Math.PI;
    assert.ok(headTurn > 1, `she is not frozen (head moved ${headTurn.toFixed(2)}°)`);
    const restAnkleY = (frames[0].feet[0].ankle.y + frames[0].feet[1].ankle.y) / 2;
    const drift = plantedDrift(shown, restAnkleY);
    assert.ok(drift.drift < 0.3 && drift.toeDrift < 0.3, `feet planted (${drift.drift.toFixed(3)} / ${drift.toeDrift.toFixed(3)} cm)`);
    assert.equal(frames.at(-1)!.steps, frames[warm].steps, 'no step');
    const jolt = Math.max(...surpriseAngles(frames, warm, UPPER));
    // The unexpected step of a smooth curve grows with the frame time squared: 0.1° at 60 fps is 0.4° at 30 fps.
    assert.ok(jolt < 0.1 * (60 / fps) ** 2, `largest unexpected step ${jolt.toFixed(4)}°`);
  });
}
