/**
 * #11 "动一动""看你一眼"（shared/behaviors/idle-gesture/）：
 *  - 守约测试：主机一侧（IdleGestureHost）和舞台一侧（IdleGestureStage）的约定，真实现和假实现跑同一组；
 *  - 验收：同一个场景（她闲着、到了"动一动"的时机）跑 20 次，数出现几种样子和表情、有没有连着重复；
 *  - "为什么挑这个"是从此刻来的真实理由；
 *  - 一个旋钮：改一个值，只有它管的那一处变，别处逐位不变；
 *  - 舞台曲线：每种样子从静止开始、回到静止，速度连续、不冲过头；演完为止；不可以动时平滑让开。
 * IDLE_GESTURE_REPORT=1 打印 20 次的序列和数字。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoodState, getMoodSnapshot, type MoodCue, type MoodLabel, type MoodSnapshot } from '../shared/mood';
import { IDLE_GESTURE_KNOBS, IDLE_SHAPE_IDS, type IdleGestureKnobs } from '../shared/behaviors/idle-gesture/knobs';
import { chooseIdleGesture, IdleGestureDirector, idleGestureNow, type IdleGestureNowInput } from '../shared/behaviors/idle-gesture/choose';
import { IDLE_GESTURE_TIMELINES, IdleGesturePerformer, readIdleGesture, sampleIdleGesture, sampleIdleKeys } from '../shared/behaviors/idle-gesture/perform';
import { FakeIdleGestureHost, FakeIdleGestureStage } from '../shared/behaviors/idle-gesture/fake';
import type { IdleGestureHost, IdleGestureNow, IdleGestureStage, IdleGestureView } from '../shared/behaviors/idle-gesture/interface';
import { EMPTY_CONTACT, MoodFeedback, type StageMoodState } from '../src/stage/mood-feedback';
import { formatIdleGestureLines } from '../src/ui/MoodPanel';
import { seeded } from './helpers/seeded';

const report = !!process.env.IDLE_GESTURE_REPORT;
const snapshot = (primary: MoodLabel = 'calm', extra: Partial<MoodSnapshot> = {}): MoodSnapshot =>
  ({ ...getMoodSnapshot(createMoodState(0), 0), primary, boredom: 60, ...extra });
const cue = (id: string, kind: MoodCue['kind'] = 'motion', at = 1_000): MoodCue => ({ id, kind, at, until: at + 3_000 });
const nowFor = (s: MoodSnapshot, extra: Partial<IdleGestureNowInput> = {}) => (kind: 'look' | 'motion') => (source: IdleGestureNow['source']) =>
  idleGestureNow({ kind, source, snapshot: s, personality: null, contacts: [], fatiguePhase: null, now: 1_000, ...extra });

// ---------------------------------------------------------------- 守约：主机一侧

const hosts: [string, () => IdleGestureHost][] = [
  ['real', () => new IdleGestureDirector({ random: seeded(7), clock: () => 1_000 })],
  ['fake', () => new FakeIdleGestureHost([{ shape: 'nod', bindingId: 'face.smile' }, { shape: 'tilt', bindingId: null }])],
];
for (const [name, make] of hosts) {
  test(`${name} host contract: only look and motion cues, one answer per cue, "此刻" read once`, () => {
    const host = make(), s = snapshot();
    let reads = 0;
    const now = (kind: 'look' | 'motion') => (source: IdleGestureNow['source']) => { reads++; return nowFor(s)(kind)(source); };
    for (const kind of ['satisfied', 'reunion', 'speech'] as const) assert.equal(host.present('gene', cue(`x-${kind}`, kind), now('motion')), null, kind);
    assert.equal(host.present('gene', null, now('motion')), null);
    assert.equal(reads, 0);
    const first = host.present('gene', cue('m1'), now('motion'))!;
    assert.ok(first && readIdleGesture(first.view), 'a stage-readable view');
    assert.equal(first.view.cueId, 'm1'); assert.equal(first.view.kind, 'motion');
    assert.deepEqual(host.present('gene', cue('m1'), now('motion')), first, 'the same cue, the same answer');
    assert.equal(reads, 1, '此刻 read only the first time');
    const look = host.present('gene', cue('l1', 'look'), now('look'))!;
    assert.equal(look.view.kind, 'look');
  });

  test(`${name} host contract: a hidden cue is never remembered; settle remembers a shown one once, newest first, per character`, () => {
    const host = make(), s = snapshot();
    host.present('gene', cue('hidden'), nowFor(s)('motion'));
    host.hide('hidden');
    host.settle();
    assert.equal(host.present('gene', cue('hidden'), nowFor(s)('motion')), null, 'hidden stays hidden');
    assert.deepEqual(host.recent('gene'), [], 'not in the why');
    host.note('shown', 'inner');
    host.present('gene', cue('shown'), nowFor(s)('motion'));
    host.settle(); host.settle();
    host.hide('shown'); // too late: it was shown
    host.present('gene', cue('look', 'look', 2_000), nowFor(s)('look'));
    host.settle();
    const recent = host.recent('gene');
    assert.equal(recent.length, 2);
    assert.deepEqual(recent.map(entry => [entry.kind, entry.source]), [['look', 'rule'], ['motion', 'inner']]);
    assert.ok(recent.every(entry => entry.why.length > 0 && typeof entry.shape === 'string' && typeof entry.face === 'string'));
    assert.deepEqual(host.recent('other-card'), []);
  });
}

// ---------------------------------------------------------------- 守约：舞台一侧

const stages: [string, () => IdleGestureStage][] = [['real', () => new IdleGesturePerformer()], ['fake', () => new FakeIdleGestureStage()]];
const view = (shape: IdleGestureView['shape'], extra: Partial<IdleGestureView> = {}): IdleGestureView =>
  ({ cueId: `cue-${shape}`, kind: 'motion', shape, side: 1, amplitude: 0.06, eyes: 1, pace: 1, smile: 0.8, ...extra });
for (const [name, make] of stages) {
  test(`${name} stage contract: nothing given → at rest and not owning; something invalid → the same; a gesture → owns it`, () => {
    const stage = make();
    const rest = stage.frame(1 / 60, undefined, true);
    assert.deepEqual([rest.x, rest.y, rest.z, rest.eyeYaw, rest.eyePitch, rest.smile, rest.owns], [0, 0, 0, 0, 0, 1, false]);
    for (const bad of [null, 1, 'tilt', { ...view('tilt'), shape: 'dance' }, { ...view('tilt'), amplitude: 1 }, { ...view('tilt'), cueId: '../x' }, { ...view('tilt'), side: 0 }])
      assert.equal(stage.frame(1 / 60, bad, true).owns, false, JSON.stringify(bad));
    const on = stage.frame(1 / 60, view('nod'), true);
    assert.equal(on.owns, true); assert.equal(on.smile, 0.8);
    stage.reset();
  });
}

// ---------------------------------------------------------------- 验收：20 次同一个场景

function run(times: number, director: IdleGestureDirector, s: MoodSnapshot, kind: 'look' | 'motion' = 'motion', extra: Partial<IdleGestureNowInput> = {}) {
  const shapes: string[] = [], faces: string[] = [], views: IdleGestureView[] = [];
  for (let i = 0; i < times; i++) {
    const p = director.present('gene', cue(`c${i}`, kind, 1_000 + i * 300_000), nowFor(s, extra)(kind))!;
    director.settle();
    shapes.push(p.view.shape); faces.push(String(p.bindingId)); views.push(p.view);
  }
  const repeats = (values: string[]) => values.filter((value, i) => i > 0 && value === values[i - 1]).length;
  const pairs = shapes.map((shape, i) => `${shape}+${faces[i]}`);
  return { shapes, faces, views, why: director.recent('gene'), kinds: new Set(shapes).size, faceKinds: new Set(faces).size, pairKinds: new Set(pairs).size,
    shapeRepeats: repeats(shapes), faceRepeats: repeats(faces), pairRepeats: repeats(pairs) };
}

test('acceptance: the same idle "动一动" moment 20 times gives several shapes and faces, and is never the same two in a row for long', () => {
  const rows: string[] = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = run(20, new IdleGestureDirector({ random: seeded(seed), clock: () => 1_000 }), snapshot('calm'));
    rows.push(`seed ${seed}: ${r.kinds} shapes, ${r.faceKinds} faces, ${r.pairKinds} combinations; repeats in a row: shape ${r.shapeRepeats}, face ${r.faceRepeats}, both ${r.pairRepeats}`);
    if (report && seed === 1) console.log(`[idle-gesture 20x calm motion]\n  ${r.shapes.join(' ')}\n  ${r.faces.join(' ')}`);
    assert.ok(r.kinds >= 5, rows.at(-1)); assert.ok(r.faceKinds >= 4, rows.at(-1));
    // Done last time is lowered (× 0.2), not ruled out: a repeat now and then, never a run of them.
    assert.ok(r.shapeRepeats <= 3 && r.pairRepeats <= 2, rows.at(-1));
    assert.ok(!r.shapes.some((shape, i) => i > 1 && shape === r.shapes[i - 1] && shape === r.shapes[i - 2]), 'never three in a row');
  }
  if (report) console.log(`[idle-gesture 20x calm motion]\n  ${rows.join('\n  ')}`);
  // The old rule: one shape (the light sway) and one face (face.convinced), 19 repeats in 20.
});

test('"why" is what is true now: the timing first, then the moment\'s reasons that raised it, then what she did last time', () => {
  // A playful tendency that is really there (a bare companion label over baseline tendencies would be the 1e-10 kind, not counted).
  const s = snapshot('happy', { companion: 'playful', tendencies: { playful: 1, close: 0, comfortable: 0, cautious: 0 } });
  const director = new IdleGestureDirector({ random: seeded(11), clock: () => 1_000 });
  const extra = { personality: { playful: 1.6, close: 1, comfortable: 1, cautious: 1 }, contacts: [{ kind: 'pat' as const, at: 1_000 - 120_000 }] };
  const r = run(12, director, s, 'motion', extra);
  const tilts = r.why.filter(entry => entry.shape === '歪头');
  assert.ok(tilts.length > 0, 'a happy, playful, just-patted moment picks the tilt sometimes');
  for (const entry of r.why) assert.equal(entry.why[0], '闲着到了动一动的时候');
  for (const entry of tilts) {
    // Every reason the tilt has in this moment raises it: all are written, and only true ones.
    for (const reason of ['心情：愉快', '这会儿有点调皮', '性格：爱玩', '不久前被摸过头']) assert.ok(entry.why.includes(reason), `${reason} in ${entry.why.join('；')}`);
  }
  const all = r.why.flatMap(entry => entry.why).join('；');
  assert.ok(!/伤感|困|闲了很久|捏过脸|吃过点心/.test(all), `nothing that is not true now: ${all}`);
  assert.ok(r.why.some(entry => entry.why.some(line => /^上次是.+，这次降低它$/.test(line))), 'what she did last time is said');
  assert.ok(r.why.every(entry => entry.why.some(line => line.startsWith('表情：'))), 'the face has its reason too');
  assert.ok(r.why.every(entry => /歪头 \d/.test(entry.weights)), 'the weights come along');
  if (report) for (const entry of r.why.slice(0, 4)) console.log(`[why] ${entry.shape} · ${entry.face}｜${entry.why.join('；')}（${entry.weights}）`);
  // Her own decision (the inner loop chose a motion) says so.
  const own = new IdleGestureDirector({ random: seeded(3) });
  own.note('inner-1', 'inner');
  own.present('gene', cue('inner-1'), nowFor(s)('motion')); own.settle();
  assert.equal(own.recent('gene')[0].why[0], '她自己决定动一动');
  assert.equal(own.recent('gene')[0].source, 'inner');
});

test('a heavy heart never smiles: sad, worried or offended moments pick only "心情写在脸上" (the old face) or none', () => {
  for (const [primary, context] of [['sad', 'neutral'], ['concerned', 'concern'], ['happy', 'offense'], ['longing', 'neutral']] as const) {
    const r = run(30, new IdleGestureDirector({ random: seeded(5) }), snapshot(primary, { context }));
    const allowed = new Set(['null', idleGestureNow({ kind: 'motion', source: 'rule', snapshot: snapshot(primary, { context }), personality: null, contacts: [], fatiguePhase: null, now: 0 }).moodFace]);
    assert.ok(r.faces.every(face => allowed.has(face)), `${primary}/${context}: ${[...new Set(r.faces)]}`);
    assert.ok(r.views.every(v => v.smile === 0 || v.smile === 0.35), 'no smile factor above "只是看着"');
  }
});

// ---------------------------------------------------------------- 一个旋钮

const knobs = (patch: (k: IdleGestureKnobs) => IdleGestureKnobs) => patch(structuredClone(IDLE_GESTURE_KNOBS) as IdleGestureKnobs);
const sequence = (k: IdleGestureKnobs, seed = 21) => run(20, new IdleGestureDirector({ knobs: k, random: seeded(seed), clock: () => 1_000 }), snapshot('content'));

test('one knob: "她动来动去太多了" → size 0.5 halves every movement; shapes, faces, sides, pace and the why are bit for bit the same', () => {
  const before = sequence(IDLE_GESTURE_KNOBS), after = sequence(knobs(k => ({ ...k, size: 0.5 })));
  assert.deepEqual(after.shapes, before.shapes); assert.deepEqual(after.faces, before.faces);
  assert.deepEqual(after.why, before.why);
  for (let i = 0; i < 20; i++) {
    const a = before.views[i], b = after.views[i];
    assert.deepEqual({ ...b, amplitude: 0, eyes: 0 }, { ...a, amplitude: 0, eyes: 0 });
    assert.ok(Math.abs(b.amplitude - a.amplitude / 2) < 2e-5, `${i}: ${a.amplitude} → ${b.amplitude}`);
    assert.equal(b.eyes, 0.5);
    // And on the stage: the same curve at half the height.
    for (const t of [0.3, 0.8, 1.4]) {
      const x = sampleIdleGesture(a, t), y = sampleIdleGesture(b, t);
      assert.ok(Math.abs(y.z - x.z * b.amplitude / a.amplitude) < 1e-9 && Math.abs(y.eyePitch - x.eyePitch / 2) < 1e-12);
    }
  }
});

test('one knob: "她老是歪头" → tilt\'s base 0 means no tilt; the faces she picks are exactly the same', () => {
  const before = sequence(IDLE_GESTURE_KNOBS);
  assert.ok(before.shapes.includes('tilt'), 'the default tilts sometimes');
  const after = sequence(knobs(k => ({ ...k, shapes: { ...k.shapes, tilt: { ...k.shapes.tilt, base: { look: 0, motion: 0 } } } })));
  assert.ok(!after.shapes.includes('tilt'));
  assert.deepEqual(after.faces, before.faces, 'faces are a separate choice with their own history');
  // Where she did not tilt before, sides, pace and amplitude draws stay where they were (the random stream is not shifted).
  for (let i = 0; i < 20; i++) assert.equal(after.views[i].side, before.views[i].side);
});

test('one knob: "她老重复" → recent [1, 1, 1] turns the not-repeating off; the default lowers repeats', () => {
  let off = 0, on = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    off += sequence(knobs(k => ({ ...k, recent: [1, 1, 1] })), seed).shapeRepeats;
    on += sequence(IDLE_GESTURE_KNOBS, seed).shapeRepeats;
  }
  assert.ok(on < off, `repeats with the knob ${on}, without ${off}`);
});

test('the choice draws exactly five random numbers, so one knob never shifts another draw', () => {
  let calls = 0;
  const random = () => { calls++; return 0.42; };
  const now = nowFor(snapshot())('motion')('rule');
  chooseIdleGesture(now, { shapes: [], faces: [] }, random);
  assert.equal(calls, 5);
  calls = 0;
  chooseIdleGesture(now, { shapes: [], faces: [] }, random, knobs(k => ({ ...k, shapes: Object.fromEntries(Object.entries(k.shapes).map(([id, s]) => [id, { ...s, base: { look: 0, motion: 0 } }])) as IdleGestureKnobs['shapes'] })));
  assert.equal(calls, 5, 'also when nothing is in range');
});

// ---------------------------------------------------------------- 舞台曲线

test('every shape starts and ends at rest with zero speed, has continuous speed and never overshoots its keys', () => {
  for (const [shape, line] of Object.entries(IDLE_GESTURE_TIMELINES)) {
    for (const channel of ['x', 'y', 'z', 'eyeYaw', 'eyePitch'] as const) {
      const keys = line[channel];
      if (!keys) continue;
      const end = keys[keys.length - 1][0], low = Math.min(...keys.map(k => k[1])), high = Math.max(...keys.map(k => k[1]));
      assert.equal(keys[0][1], 0, `${shape}.${channel} starts at rest`); assert.equal(keys[keys.length - 1][1], 0, `${shape}.${channel} ends at rest`);
      assert.ok(end <= line.duration, `${shape}.${channel} ends within the shape`);
      for (let t = 0; t <= end; t += 0.002) { const v = sampleIdleKeys(keys, t); assert.ok(v >= low - 1e-9 && v <= high + 1e-9, `${shape}.${channel} overshoots at ${t}`); }
      const e = 1e-6, slope = (a: number, b: number) => (sampleIdleKeys(keys, b) - sampleIdleKeys(keys, a)) / (b - a);
      for (const [t] of keys.slice(1, -1)) {
        const left = slope(t - 2 * e, t - e), right = slope(t + e, t + 2 * e);
        assert.ok(Math.abs(left - right) < 1e-3 * Math.max(1, Math.abs(left)), `${shape}.${channel}: kink at ${t}`);
      }
      assert.ok(Math.abs(slope(0, 1e-4)) < 0.01 && Math.abs(slope(end - 1e-4, end)) < 0.01, `${shape}.${channel}: zero speed at both ends`);
    }
  }
  assert.deepEqual(Object.keys(IDLE_GESTURE_TIMELINES).sort(), [...IDLE_SHAPE_IDS].sort());
});

test('the performer plays a gesture to its end even after its cue is gone, and gives way smoothly when the head is not free', () => {
  const stage = new IdleGesturePerformer();
  for (let i = 0; i < 60; i++) stage.frame(1 / 60, undefined, true); // the gate settles at "free"
  const z: number[] = [];
  z.push(stage.frame(1 / 60, view('tilt', { amplitude: 0.08 }), true).z);
  for (let i = 0; i < 30; i++) z.push(stage.frame(1 / 60, view('tilt', { amplitude: 0.08 }), true).z);
  // The cue ends at 0.5 s (no gesture in the view any more): the tilt keeps going.
  for (let i = 0; i < 200; i++) z.push(stage.frame(1 / 60, undefined, true).z);
  const peak = Math.max(...z);
  assert.ok(peak > 0.07 && peak <= 0.08 + 1e-9, `peak ${peak}`);
  assert.equal(z.at(-1), 0, 'back at rest and done');
  assert.equal(stage.frame(1 / 60, undefined, true).owns, false);
  // Not free half way (a body motion takes the head at 0.4 s, at the glance's fastest): it eases out from where it is,
  // no step larger than the glance's own and no sudden change of speed (no cut).
  const glance = (free: (i: number) => boolean) => {
    const g = new IdleGesturePerformer(), out: number[] = [];
    for (let i = 0; i < 60; i++) g.frame(1 / 60, undefined, true);
    for (let i = 0; i < 160; i++) out.push(g.frame(1 / 60, i < 50 ? view('glance', { amplitude: 0.1 }) : undefined, free(i)).y);
    const steps = out.slice(1).map((v, i) => v - out[i]);
    return { out, step: Math.max(...steps.map(Math.abs)), jerk: Math.max(...steps.slice(1).map((v, i) => Math.abs(v - steps[i]))) };
  };
  const free = glance(() => true), taken = glance(i => i < 24);
  assert.ok(taken.step <= free.step + 1e-9, `largest step ${taken.step} (the glance's own ${free.step})`);
  assert.ok(taken.jerk < 0.0025, `largest change of speed per frame ${taken.jerk} (the glance's own ${free.jerk})`);
  assert.ok(Math.abs(taken.out.at(-1)!) < 1e-6);
});

test('MoodFeedback: with a picked gesture the old light sway steps aside and the shape plays through the same spring', () => {
  const state = (gesture?: IdleGestureView): StageMoodState => ({ mood: 'calm', phase: 'idle', expressive: true, face: 50, posture: 50, playful: 0,
    responding: true, attention: true, ...(gesture ? { gesture } : {}) });
  const peaks = (gesture?: IdleGestureView) => {
    const layer = new MoodFeedback();
    let x = 0, z = 0, eye = 0;
    for (let i = 0; i < 180; i++) { const f = layer.frame(1 / 60, EMPTY_CONTACT, state(gesture)); x = Math.max(x, f.headX); z = Math.max(z, Math.abs(f.headZ)); eye = Math.min(eye, f.eyePitch); }
    return { x, z, eye };
  };
  const old = peaks(), nod = peaks(view('nod', { amplitude: 0.06 }));
  assert.ok(old.z > 0.003 && old.z < 0.0065 && old.x < 1e-9, `old sway ${JSON.stringify(old)}`);
  assert.ok(nod.x > 0.045 && nod.z < 1e-9, `nod ${JSON.stringify(nod)}`);
  // A contract fake stands in for the stage side: MoodFeedback hands it the gesture only while the cue shows.
  const fake = new FakeIdleGestureStage(), layer = new MoodFeedback(fake);
  layer.frame(1 / 60, EMPTY_CONTACT, { ...state(view('lift')), attention: false });
  layer.frame(1 / 60, EMPTY_CONTACT, state(view('lift')));
  assert.deepEqual(fake.received, ['cue-lift:lift']);
});

test('the developer panel line: the last three, newest first, each with its reasons and weights; nothing yet says so', () => {
  assert.equal(formatIdleGestureLines(undefined), '小动作：暂无');
  assert.equal(formatIdleGestureLines([]), '小动作：暂无');
  const r = run(5, new IdleGestureDirector({ random: seeded(2), clock: () => 1_000 }), snapshot('content'));
  const lines = formatIdleGestureLines(r.why).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.startsWith('小动作：') && line.includes(' 动一动 → ') && line.includes('闲着到了动一动的时候') && line.includes('（分量：')));
  assert.ok(lines[0].includes(`${r.why[0].shape} · ${r.why[0].face}`), 'newest first');
});
