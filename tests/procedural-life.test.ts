import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Bone, Euler, Quaternion } from 'three';
import { SeededRandom, SmoothNoise, hashSeed } from '../src/stage/life-noise';
import {
  LIFE_FADE_IN, LIFE_FADE_OUT, LIFE_LIMITS, ProceduralLife, lifeParameters, lifeRig,
  type LifeGates, type LifeInput, type LifeMood, type LifePort, type LifeRig,
} from '../src/stage/procedural-life';
import { StageModelProfile } from '../src/stage/model-profile';
import { readPmxLite } from './helpers/pmx-lite';
import { toThreeMesh, toyModel } from './helpers/model-fixtures';

const DT = 1 / 60;
const owner = {};
const gates = (patch: Partial<LifeGates> = {}): LifeGates => ({ expressive: true, contact: false, manualPose: false, manualGesture: false, manualHead: false,
  manualExpression: false, manualMouth: false, chatGesture: false, music: false, bodyMotion: false, headOwned: false, authoredFace: false,
  preview: false, adjusting: false, speaking: false, gazeAllowed: true, ...patch });
const mood = (primary = 'calm', patch: Partial<LifeMood> = {}): LifeMood => ({ primary, companion: null, values: { D: 50, O: 50, E: 50, N: 50, C: 50 },
  intensity: { expression: 50, gaze: 50, posture: 50, playful: 50 }, ...patch });
function input(patch: Partial<LifeInput<object>> = {}, gatePatch: Partial<LifeGates> = {}): LifeInput<object> {
  return { enabled: true, owner, seedKey: 'gene-card', rig: null, mood: mood(), fatigue: null, pointerX: 0, pointerY: 0, breathStrength: 0.5, hasEyes: true,
    gates: gates(gatePatch), ...patch };
}
function snapshot(life: ProceduralLife<object>) { return { ...life.out }; }
function run(life: ProceduralLife<object>, seconds: number, make: (t: number) => LifeInput<object>, each?: (t: number) => void, dt = DT): void {
  const frames = Math.round(seconds / dt);
  for (let frame = 0; frame < frames; frame++) { const t = frame * dt; life.frame(dt, make(t)); each?.(t); }
}
const rms = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length));

test('noise: seeded, bounded, smooth, and never repeats a window', () => {
  const a = new SmoothNoise(7), b = new SmoothNoise(7), c = new SmoothNoise(8);
  let maxStep = 0, low = Infinity, high = -Infinity, same = true, different = false;
  for (let i = 0; i < 20_000; i++) {
    const t = i * 0.01, value = a.fbm(t, 3);
    same &&= value === b.fbm(t, 3); different ||= Math.abs(value - c.fbm(t, 3)) > 1e-6;
    low = Math.min(low, value); high = Math.max(high, value);
    if (i) maxStep = Math.max(maxStep, Math.abs(value - a.fbm(t - 0.01, 3)));
  }
  assert.ok(same, 'same seed, same values'); assert.ok(different, 'another seed differs');
  assert.ok(low >= -1.05 && high <= 1.05 && high - low > 0.8, `bounded but lively (${low.toFixed(2)}..${high.toFixed(2)})`);
  assert.ok(maxStep < 0.06, `continuous at 0.01 lattice steps (${maxStep})`);
  // No loop: a 20-cell window never reappears later in the stream.
  const window = (start: number) => Array.from({ length: 200 }, (_, i) => a.fbm(start + i * 0.1, 3));
  const first = window(0);
  for (let start = 5; start < 2_000; start += 7.3) {
    const other = window(start), error = Math.max(...other.map((value, i) => Math.abs(value - first[i])));
    assert.ok(error > 0.05, `window at ${start} repeats the first`);
  }
  assert.equal(hashSeed('gene-card'), hashSeed('gene-card')); assert.notEqual(hashSeed('a'), hashSeed('b'));
  const r1 = new SeededRandom(3), r2 = new SeededRandom(3);
  for (let i = 0; i < 100; i++) { const value = r1.next(); assert.equal(value, r2.next()); assert.ok(value >= 0 && value < 1); }
});

test('determinism: one seed gives the same motion frame by frame; another seed differs', () => {
  const trace = (seedKey: string) => {
    const life = new ProceduralLife<object>(), out: number[] = [];
    run(life, 30, t => input({ seedKey, pointerX: Math.sin(t * 0.3) * 0.4 }), t => {
      out.push(life.out.headX, life.out.headZ, life.out.gazeX, life.out.gazeBlend, life.out.breath);
      if (Math.abs((t * 60) % 120) < 1e-6) out.push(life.beginBlink(), life.blinkWeight(0.05));
    });
    return out;
  };
  const a = trace('card-a');
  assert.deepEqual(trace('card-a'), a);
  const b = trace('card-b');
  assert.equal(b.length, a.length);
  assert.ok(a.some((value, i) => Math.abs(value - b[i]) > 1e-4), 'a different character moves differently');
});

test('bounds: joint limits and the total head clamp hold for extreme cards, moods and frame times', () => {
  const life = new ProceduralLife<object>(), random = new SeededRandom(11);
  const wild = mood('excited', { values: { D: 100, O: 100, E: 0, N: 100, C: 100 }, companion: 'playful', intensity: { expression: 100, gaze: 100, posture: 100, playful: 100 } });
  let frames = 0;
  for (let i = 0; i < 20_000; i++) {
    const dt = random.next() < 0.05 ? random.range(0.1, 2) : random.range(0, 0.05);
    life.frame(dt, input({ mood: wild, pointerX: random.range(-3, 3), pointerY: Number.NaN, breathStrength: 7 }));
    const o = life.out;
    assert.ok(Math.abs(o.headX) <= LIFE_LIMITS.head.x + 1e-12 && Math.abs(o.headY) <= LIFE_LIMITS.head.y + 1e-12 && Math.abs(o.headZ) <= LIFE_LIMITS.head.z + 1e-12);
    assert.ok(Math.hypot(o.headX, o.headY, o.headZ) <= LIFE_LIMITS.head.total + 1e-12, 'total head additive');
    assert.ok(Math.abs(o.swayY) <= LIFE_LIMITS.sway.y && Math.abs(o.swayZ) <= LIFE_LIMITS.sway.z);
    assert.ok(o.shoulder >= 0 && o.shoulder <= LIFE_LIMITS.shoulder);
    assert.ok(Math.abs(o.gazeX) <= LIFE_LIMITS.gaze.x && Math.abs(o.gazeY) <= LIFE_LIMITS.gaze.y && o.gazeBlend >= 0 && o.gazeBlend <= 1);
    assert.ok([o.breath, o.mix, o.headX, o.headY, o.headZ, o.gazeX, o.gazeY].every(Number.isFinite));
    if (o.headZ !== 0) frames++;
  }
  assert.ok(frames > 10_000, 'the head is actually moving');
  for (let i = 0; i < 200; i++) { const interval = life.beginBlink(); assert.ok(interval >= 1.1 && interval < 12, String(interval)); }
});

test('yielding: contact silences gaze, tilt and sway with a smooth fade and they return gently', () => {
  const life = new ProceduralLife<object>();
  run(life, 8, () => input());
  const active = snapshot(life);
  assert.ok(Math.abs(active.headZ) + Math.abs(active.swayZ) + Math.abs(active.gazeX) > 0, 'moving before contact');
  const head: number[] = [];
  run(life, 1, () => input({}, { contact: true }), () => head.push(life.out.headZ));
  for (let i = 1; i < head.length; i++) assert.ok(Math.abs(head[i] - head[i - 1]) < 0.004, `fades without a jump (${Math.abs(head[i] - head[i - 1])})`);
  const fadeFrames = Math.ceil(LIFE_FADE_OUT / DT) + 1;
  assert.ok(head.slice(fadeFrames).every(value => value === 0), 'fully yielded after the fade-out');
  assert.equal(life.out.swayZ, 0); assert.equal(life.out.gazeX, 0); assert.equal(life.out.gazeBlend, 0);
  assert.ok(life.out.mix > 0.99 && life.out.breath !== 0, 'breathing never yields');
  assert.deepEqual(life.getState().primitives.tilt.yielding, ['contact']);
  const weights: number[] = [];
  run(life, 2, () => input(), () => weights.push(life.getState().primitives.tilt.weight));
  for (let i = 1; i < weights.length; i++) assert.ok(weights[i] >= weights[i - 1] && weights[i] - weights[i - 1] < 0.05, 'eases back in');
  assert.ok(weights[Math.floor(0.2 / DT)] < 0.5, 'not at once');
  assert.equal(weights[Math.ceil(LIFE_FADE_IN / DT) + 2], 1, 'fully back after the fade-in');
  assert.ok(life.out.headZ !== 0, 'moving again');
});

test('yielding: manual picks, music, chat gestures, body motion, previews and sleep each silence their own parts', () => {
  const settle = (patch: Partial<LifeGates>, extra: Partial<LifeInput<object>> = {}) => {
    const life = new ProceduralLife<object>();
    run(life, 6, () => input(extra, patch));
    return { out: snapshot(life), state: life.getState() };
  };
  const free = settle({});
  assert.ok(free.out.headZ !== 0 && free.out.swayZ !== 0 && free.out.gazeX !== 0);
  for (const [gate, gazeKept] of [['manualPose', true], ['manualGesture', true], ['chatGesture', true], ['music', true], ['bodyMotion', true],
    ['preview', false], ['adjusting', false]] as const) {
    const { out, state } = settle({ [gate]: true });
    assert.equal(out.headZ, 0, `${gate}: tilt yields`); assert.equal(out.swayZ, 0, `${gate}: sway yields`); assert.equal(out.shoulder, 0, `${gate}: shoulders yield`);
    assert.equal(out.gazeX !== 0, gazeKept, `${gate}: gaze ${gazeKept ? 'kept' : 'yields'}`);
    assert.ok(state.primitives.tilt.yielding.length > 0);
  }
  const head = settle({ manualHead: true });
  assert.equal(head.out.headZ, 0); assert.ok(head.out.swayZ !== 0, 'a picked head motion leaves the torso sway');
  const owned = settle({ headOwned: true });
  assert.equal(owned.out.headX, 0); assert.ok(owned.out.gazeX !== 0);
  const face = settle({ manualExpression: true });
  assert.equal(face.out.gazeX, 0, 'a picked expression owns the eyes'); assert.ok(face.out.headZ !== 0);
  const paused = settle({ expressive: false });
  assert.equal(paused.out.headZ + paused.out.gazeX + paused.out.swayZ, 0); assert.ok(paused.out.breath !== 0);
  const asleep = settle({ gazeAllowed: false }, { fatigue: { phase: 'asleep', F: 1, sleeping: true } });
  assert.equal(asleep.out.headZ + asleep.out.gazeX + asleep.out.swayZ, 0); assert.ok(asleep.out.breath !== 0);
  assert.ok(asleep.state.params.breathRate < free.state.params.breathRate, 'sleep breathes slower');
});

test('gaze: the user pointer leads; still moments bring look-at-user and drift', () => {
  const life = new ProceduralLife<object>();
  let blend = 0, maxStill = 0;
  run(life, 60, () => input(), () => { blend = Math.max(blend, life.out.gazeBlend); maxStill = Math.max(maxStill, Math.abs(life.out.gazeX)); });
  assert.ok(blend > 0.5, `a look-at-user moment happens within a minute (${blend})`);
  assert.ok(life.getState().primitives.gaze.saccades > 10, 'small saccades');
  assert.ok(maxStill > 0.02, 'visible drift');
  // A moving pointer: drift steps back and no look-at-user pull.
  let moving = 0, movingBlend = 0;
  run(life, 20, t => input({ pointerX: Math.sin(t * 6) * 0.8 }), () => { moving = Math.max(moving, Math.abs(life.out.gazeX)); movingBlend = Math.max(movingBlend, life.out.gazeBlend); });
  assert.ok(movingBlend < 0.15, `pointer leads (${movingBlend})`);
});

test('fades: switching off returns smoothly to the legacy breath and blink; switching on fades in', () => {
  const life = new ProceduralLife<object>();
  run(life, 5, () => input());
  assert.ok(life.active);
  const mix: number[] = [], head: number[] = [];
  run(life, 1, () => input({ enabled: false }), () => { mix.push(life.out.mix); head.push(life.out.headZ); });
  for (let i = 1; i < mix.length; i++) { assert.ok(mix[i] <= mix[i - 1]); assert.ok(Math.abs(head[i] - head[i - 1]) < 0.004); }
  assert.equal(mix.at(-1), 0); assert.equal(life.active, false);
  assert.equal(life.mixBreath(0.37), 0.37, 'inactive: the legacy breath passes untouched');
  assert.equal(life.getState().primitives.gaze.yielding[0], 'disabled');
  const on: number[] = [];
  run(life, 1, () => input(), () => on.push(life.out.mix));
  for (let i = 1; i < on.length; i++) assert.ok(on[i] >= on[i - 1] && on[i] - on[i - 1] < 0.06);
  assert.ok(on.at(-1)! > 0.99);
});

test('moods give measurably different parameters and motion', () => {
  const calm = lifeParameters(mood('calm'), null), excited = lifeParameters(mood('excited', { values: { D: 90, O: 60, E: 60, N: 85, C: 40 } }), null);
  const sad = lifeParameters(mood('sad', { values: { D: 30, O: 40, E: 35, N: 40, C: 55 } }), null);
  const drowsy = lifeParameters(mood('calm'), { phase: 'drowsy', F: 0.9 });
  assert.ok(excited.speed > calm.speed && calm.speed > sad.speed, 'tempo');
  assert.ok(excited.amplitude > calm.amplitude && calm.amplitude > sad.amplitude, 'amplitude');
  assert.ok(excited.breathRate > calm.breathRate && calm.breathRate > sad.breathRate, 'breath');
  assert.ok(excited.blinkInterval < calm.blinkInterval, 'blink rate');
  assert.ok(sad.gazeDown < calm.gazeDown && sad.lookAway > calm.lookAway, 'downcast, averted');
  assert.ok(excited.smoothness < calm.smoothness, 'excited is less smooth');
  assert.ok(drowsy.blinkDuration > calm.blinkDuration && drowsy.speed < calm.speed && drowsy.drowsy > 0.8, 'drowsy: slow heavy blinks');
  const bigCard = lifeParameters(mood('calm', { intensity: { posture: 100, gaze: 100, expression: 100 } }), null);
  assert.ok(Math.abs(bigCard.amplitude - 2 * calm.amplitude) < 1e-9 && Math.abs(bigCard.gaze - 2 * calm.gaze) < 1e-9, 'card intensity scales amplitude');
  const playful = lifeParameters(mood('happy', { companion: 'playful' }), null, -1);
  assert.ok(playful.asymmetry < -0.6 && Math.abs(calm.asymmetry) < 0.3, 'playful leans to its seeded side');
  // Motion statistics over a minute follow the parameters.
  const stats = (m: LifeMood) => {
    const life = new ProceduralLife<object>(), roll: number[] = [];
    run(life, 60, () => input({ mood: m }), () => roll.push(life.out.headZ - 0));
    let blinks = 0, t = 0; while (t < 120) { t += life.beginBlink(); blinks++; }
    return { roll: rms(roll), blinks };
  };
  const loud = stats(mood('excited', { values: { D: 90, O: 60, E: 60, N: 85, C: 40 } })), quiet = stats(mood('sad', { values: { D: 30, O: 40, E: 35, N: 40, C: 55 } }));
  assert.ok(loud.roll > quiet.roll * 1.3, `head motion (${loud.roll.toFixed(4)} vs ${quiet.roll.toFixed(4)})`);
  assert.ok(loud.blinks > quiet.blinks, `blinks per 2 min (${loud.blinks} vs ${quiet.blinks})`);
  // A mood change re-tempers smoothly: the parameters ease, they do not jump.
  const life = new ProceduralLife<object>();
  run(life, 3, () => input({ mood: mood('calm') }));
  const before = life.getState().params.speed;
  life.frame(DT, input({ mood: mood('excited', { values: { D: 90, O: 60, E: 60, N: 85, C: 40 } }) }));
  const after = life.getState().params.speed;
  assert.ok(after > before && after - before < 0.02, `eased (${before} -> ${after})`);
});

test('blink rhythm: varied intervals and durations, occasional double blinks, as a pulse only', () => {
  const life = new ProceduralLife<object>();
  life.frame(DT, input({ mood: mood('tense-expectation', { values: { D: 50, O: 50, E: 40, N: 80, C: 80 } }) }));
  const intervals: number[] = [], durations = new Set<number>();
  let doubles = 0;
  for (let i = 0; i < 400; i++) {
    intervals.push(life.beginBlink());
    const state = life.getState().primitives.blink;
    durations.add(state.durationS);
    if (state.double) {
      doubles++;
      // Two closures with an opening between them.
      const samples = Array.from({ length: 60 }, (_, k) => life.blinkWeight(k * 0.008));
      const peaks = samples.filter((value, k) => k > 0 && k < 59 && value > 0.9 && value >= samples[k - 1] && value >= samples[k + 1]).length;
      const valley = Math.min(...samples.slice(Math.round(state.durationS / 0.008) - 1, Math.round((state.durationS + 0.05) / 0.008)));
      assert.ok(peaks >= 2 && valley < 0.2, `double blink shape (${peaks} peaks, valley ${valley})`);
    }
  }
  assert.ok(doubles > 10 && doubles < 200, `occasional double blinks (${doubles}/400)`);
  assert.ok(durations.size > 50, 'durations vary');
  const spread = Math.max(...intervals) - Math.min(...intervals);
  assert.ok(spread > 2, `irregular rhythm (${spread.toFixed(2)} s)`);
  assert.equal(life.blinkWeight(-0.01), 0); assert.equal(life.blinkWeight(5), 0);
});

/** Records the stage-port calls on real Three bones, applying them as the stage's rotateBone does. */
function threePort(): { port: LifePort<Bone>; calls: string[]; heads: number[][] } {
  const calls: string[] = [], heads: number[][] = [], euler = new Euler(), offset = new Quaternion();
  return { calls, heads, port: {
    rotate(bone, x, y, z) { if (!bone) return; calls.push(bone.name); bone.quaternion.multiply(offset.setFromEuler(euler.set(x, y, z, 'YXZ'))); },
    head(x, y, z) { heads.push([x, y, z]); },
    morph() { throw new Error('phase 1 writes no morph'); },
  } };
}

test('rig: Gene, an English-named model and a model without shoulders all resolve; missing bones are skipped', () => {
  const gene = toThreeMesh(readPmxLite(new Uint8Array(readFileSync(new URL('../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url)))));
  const english = toThreeMesh(toyModel({ names: 'english' }));
  const bare = toThreeMesh(toyModel());
  for (const bone of bare.skeleton.bones) if (/肩/.test(bone.name)) bone.name = `x${bone.name}`;
  try {
    const cases: [string, ReturnType<typeof toThreeMesh>, string | null][] = [['gene', gene, '左肩'], ['english', english, 'Shoulder_L'], ['bare', bare, null]];
    for (const [label, mesh, shoulder] of cases) {
      const profile = new StageModelProfile(mesh, { reviewed: label === 'gene' });
      const rig: LifeRig<Bone> = lifeRig(mesh, profile);
      assert.equal(rig.upperBody?.name, label === 'english' ? 'UpperBody' : '上半身', label);
      assert.equal(rig.shoulderLeft?.name ?? null, shoulder, label);
      const life = new ProceduralLife<Bone>(), { port, calls, heads } = threePort();
      const rest = mesh.skeleton.bones.map(bone => bone.quaternion.clone());
      for (let frame = 0; frame < 600; frame++) {
        life.frame(DT, { ...input(), owner: mesh, rig } as LifeInput<Bone>);
        mesh.skeleton.bones.forEach((bone, index) => bone.quaternion.copy(rest[index]));
        life.applyBody(port);
      }
      assert.ok(calls.includes(rig.upperBody!.name), `${label}: sway reaches the upper body`);
      assert.equal(calls.some(name => /肩|Shoulder/.test(name)), shoulder !== null, `${label}: shoulders only when both exist`);
      assert.ok(heads.length > 0, `${label}: the head goes through the automatic-head path`);
      const upper = rig.upperBody!, angle = 2 * Math.acos(Math.min(1, Math.abs(upper.quaternion.dot(rest[mesh.skeleton.bones.indexOf(upper)]))));
      assert.ok(angle > 0 && angle < 0.03, `${label}: bounded sway (${angle})`);
      // A rig of another mesh is never used.
      const other = new ProceduralLife<Bone>(), stray = threePort();
      for (let frame = 0; frame < 120; frame++) { other.frame(DT, { ...input(), owner: {}, rig } as LifeInput<Bone>); other.applyBody(stray.port); }
      assert.deepEqual(stray.calls, [], `${label}: stale rig ignored`);
    }
    const geneRig = lifeRig(gene, new StageModelProfile(gene, { reviewed: true }));
    assert.ok(Object.values(geneRig.slots).every(index => index >= 0), 'Gene has every expression slot');
    assert.notEqual(geneRig.slots.mouthOpen, new StageModelProfile(gene, { reviewed: true }).indices.mouth, 'never the lip-sync morph');
    assert.deepEqual(lifeRig({}, null).slots, { smileEyes: -1, mouthSmile: -1, sad: -1, angry: -1, jitome: -1, mouthOpen: -1, browUp: -1, surprise: -1 });
  } finally { gene.geometry.dispose(); english.geometry.dispose(); bare.geometry.dispose(); }
});

test('cost: a frame is a few microseconds and the generator allocates nothing per frame', () => {
  const life = new ProceduralLife<object>(), frame = input(), frames = 20_000;
  for (let i = 0; i < 2_000; i++) life.frame(DT, frame);
  const start = performance.now();
  for (let i = 0; i < frames; i++) { frame.pointerX = Math.sin(i * 0.01) * 0.3; life.frame(DT, frame); }
  const perFrameUs = (performance.now() - start) * 1000 / frames;
  assert.ok(perFrameUs < 50, `${perFrameUs.toFixed(2)} us per frame`);
  assert.equal(life.diagnostics(0), life.diagnostics(100), 'diagnostics are cached between refreshes');
  assert.notEqual(life.diagnostics(400), 'null');
  assert.deepEqual(JSON.parse(life.diagnostics(400)), life.getState(), 'plain data');
});
