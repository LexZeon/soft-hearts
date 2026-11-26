// Unbound U2 experiment E2 (docs/claude/2026-11-14-unbound-night-e2-autonomy.md): her own movement's read-write loop, pure.
// READ: each mood drive gives the acts it should; sleepy, stressed and afraid hold her back; you busy or talking keeps it small;
// thresholds, cooldowns, hourly caps, the shared gap and "never three times running". WRITE: each write row through the fake
// port, gated and scaled like the mood moments, never O/B/M. The closed loop over five synthetic days stays in its bounds.
// Also the hop's path (hop.ts) and the gait's hop (feet leave and land on the same places).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTS, AUTONOMY_ACTS, AUTONOMY_KNOBS, AutonomyPlanner, judge, type AutonomyAct, type AutonomySituation } from '../shared/unbound/autonomy/choose';
import { AUTONOMY_WRITES, AutonomyWriter } from '../shared/unbound/autonomy/writeback';
import { FakeMoodPort } from '../shared/unbound/autonomy/fake-mood';
import { SYNTHETIC_DAYS, seeded, simulateDay } from '../shared/unbound/autonomy/day-sim';
import { NEUTRAL_MOOD, type MoodReading } from '../shared/unbound/director';
import { hopAt, planHop, hopDuration } from '../src/unbound/hop';
import { Gait, type GaitBody } from '../src/unbound/gait';

const MIN = 60_000, T0 = new Date(2026, 10, 14, 10).getTime();
const mood = (patch: Partial<MoodReading>): MoodReading => ({ ...NEUTRAL_MOOD, ...patch });
const EXCITED = mood({ D: 78, N: 74, E: 55 }), SOOTHED = mood({ E: 76 }), BORED = mood({ B: 85 }), CLOSE = mood({ O: 80, M: 40 });
const situation = (patch: Partial<AutonomySituation> = {}): AutonomySituation => ({ shown: true, fullscreen: false, asleep: false, inCall: false, cue: { speaking: false, userTalking: false }, idleSeconds: 120, mood: NEUTRAL_MOOD, active: false, ...patch });
const eligible = (j: ReturnType<typeof judge>) => AUTONOMY_ACTS.filter(a => !j.blocked[a]);

// ---- READ ------------------------------------------------------------------------------------------------------------------------

test('read: excited (D and N up) → hop, spin, dance; soothed (E) → sway, stretch; bored (B) → fidget, wander; neutral → nothing but stillness', () => {
  assert.deepEqual(eligible(judge(situation({ mood: EXCITED }), 0)).filter(a => ACTS[a].family === 'excited').sort(), ['dance', 'hop', 'spin']);
  assert.deepEqual(eligible(judge(situation({ mood: SOOTHED }), 0)).sort(), ['stretch', 'sway']);
  assert.deepEqual(eligible(judge(situation({ mood: BORED }), 0)).sort(), ['fidget', 'wander']);
  assert.deepEqual(eligible(judge(situation(), 0)), [], 'at her baseline nothing calls her to move');
  // A long stillness brings a small movement by itself, never a big one.
  assert.deepEqual(eligible(judge(situation(), 90)).sort(), ['fidget', 'sway']);
  // D alone (no N) is not excitement.
  assert.equal(judge(situation({ mood: mood({ D: 85 }) }), 0).wants.hop, 0);
});

test('read: close (O, M) scores show-off, but the planner leaves it to the peek director', () => {
  const j = judge(situation({ mood: CLOSE }), 0);
  assert.ok(j.wants['show-off'] > ACTS['show-off'].threshold);
  const planner = new AutonomyPlanner(T0), r = seeded(3);
  for (let i = 0; i < 2000; i++) { const tick = planner.tick(T0 + i * 5000, 5, situation({ mood: CLOSE }), r); assert.notEqual(tick.decision?.act, 'show-off'); if (tick.decision) assert.ok(true); }
  assert.equal(planner.tick(T0, 5, situation({ mood: CLOSE }), r).blocked['show-off'], 'delegated');
});

test('read: sleepy — less of anything big as A rises, nothing big or excited from A 0.7, curling up instead', () => {
  const at = (A: number) => judge(situation({ mood: { ...EXCITED, A } }), 0);
  assert.ok(at(0.55).wants.hop < at(0.2).wants.hop * 0.6);
  const sleepy = at(0.75);
  for (const act of AUTONOMY_ACTS) if (ACTS[act].family === 'excited' || ACTS[act].size === 'big') assert.equal(sleepy.blocked[act], 'sleepy', act);
  assert.ok(sleepy.wants['curl-up'] > ACTS['curl-up'].threshold && !sleepy.blocked['curl-up']);
  assert.ok(sleepy.liveliness < at(0.2).liveliness);
});

test('read: stressed (C) — smaller movements, big ones less wanted, no showing off', () => {
  const calm = judge(situation({ mood: { ...EXCITED, O: 80 } }), 0), stressed = judge(situation({ mood: { ...EXCITED, O: 80, C: 72 } }), 0);
  assert.equal(calm.amplitude, 1);
  assert.ok(stressed.amplitude < 0.75 && stressed.amplitude >= 0.5);
  assert.ok(stressed.wants.hop < calm.wants.hop);
  assert.equal(stressed.blocked['show-off'], 'stressed');
});

test('read: afraid (N and C both high) — she holds still: nothing starts, the planner says freeze', () => {
  const afraid = mood({ D: 80, N: 80, C: 80, E: 80, B: 90 });
  const j = judge(situation({ mood: afraid }), 120);
  assert.equal(j.freeze, true);
  for (const act of AUTONOMY_ACTS) assert.equal(j.blocked[act], 'afraid');
  const planner = new AutonomyPlanner(T0), r = seeded(5);
  for (let i = 0; i < 720; i++) { const tick = planner.tick(T0 + i * 5000, 5, situation({ mood: afraid }), r); assert.equal(tick.decision, null); assert.equal(tick.freeze, true); }
});

test('read: you busy, either of you talking, a call → small acts only; away → nothing big; not shown / full screen / asleep → nothing', () => {
  const hyper = mood({ D: 80, N: 76, E: 76, B: 85 });
  const at = (patch: Partial<AutonomySituation>) => judge(situation({ mood: hyper, ...patch }), 0);
  for (const patch of [{ idleSeconds: 5 }, { idleSeconds: null }, { cue: { speaking: true, userTalking: false } }, { cue: { speaking: false, userTalking: true } }, { inCall: true }]) {
    const j = at(patch);
    for (const act of AUTONOMY_ACTS) if (ACTS[act].size !== 'small') assert.ok(j.blocked[act] === 'busy' || j.blocked[act] === 'talking', `${act} ${JSON.stringify(patch)}`);
    assert.ok(!j.blocked.sway && !j.blocked.fidget, 'small ones may still come');
  }
  const halfIdle = at({ idleSeconds: 30 });
  assert.ok(!halfIdle.blocked.stretch, 'a medium act once you have paused');
  assert.equal(halfIdle.blocked.hop, 'busy', 'a big act waits for a longer pause');
  const away = at({ idleSeconds: 1800 });
  for (const act of AUTONOMY_ACTS) if (ACTS[act].size === 'big') assert.equal(away.blocked[act], 'away');
  assert.equal(at({ shown: false }).blocked.sway, 'not-shown');
  assert.equal(at({ fullscreen: true }).blocked.sway, 'fullscreen');
  assert.equal(at({ asleep: true }).blocked.sway, 'asleep');
});

// ---- the planner: thresholds, cooldowns, caps, gap, no repeats, no fixed beat ---------------------------------------------------

/** Ticks every 5 s for `minutes` with a fixed situation; returns the decisions. */
function run(planner: AutonomyPlanner, s: AutonomySituation, minutes: number, seed = 1, from = T0) {
  const r = seeded(seed), out: { at: number; act: AutonomyAct }[] = [];
  for (let t = from; t < from + minutes * MIN; t += 5000) { const tick = planner.tick(t, 5, s, r); if (tick.decision) out.push({ at: t, act: tick.decision.act }); }
  return out;
}

test('planner: below the threshold never; over it, by chance at a rate (no fixed beat)', () => {
  const mild = run(new AutonomyPlanner(T0), situation({ mood: mood({ D: 58, N: 58 }) }), 120);
  assert.equal(mild.filter(a => ACTS[a.act].family === 'excited').length, 0, 'mildly up is not enough to hop (only stillness brings a small act)');
  assert.ok(mild.every(a => ACTS[a.act].size === 'small'));
  const acts = run(new AutonomyPlanner(T0), situation({ mood: EXCITED }), 300, 2);
  assert.ok(acts.length >= 8, `excited for 5 h: ${acts.length}`);
  const gaps = acts.slice(1).map((a, i) => (a.at - acts[i].at) / MIN), mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  assert.ok(sd > 1, `intervals vary (sd ${sd.toFixed(1)} min)`);
});

test('planner: each act\'s cooldown and hourly cap, all acts\' hourly cap, the shared gap, never three times running', () => {
  for (const seed of [1, 2, 3, 4]) {
    const acts = run(new AutonomyPlanner(T0), situation({ mood: mood({ D: 85, N: 82, E: 80, B: 90 }) }), 600, seed);
    assert.ok(acts.length > 20);
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i], spec = ACTS[a.act];
      const prevSame = acts.slice(0, i).reverse().find(b => b.act === a.act);
      if (prevSame) assert.ok(a.at - prevSame.at >= spec.cooldownMinutes * MIN, `${a.act} cooldown`);
      assert.ok(acts.filter(b => b.act === a.act && b.at <= a.at && a.at - b.at < 60 * MIN).length <= spec.perHour, `${a.act} per hour`);
      assert.ok(acts.filter(b => b.at <= a.at && a.at - b.at < 60 * MIN).length <= AUTONOMY_KNOBS.perHour, 'all per hour');
      if (i) assert.ok(a.at - acts[i - 1].at >= AUTONOMY_KNOBS.minGapSeconds * 1000, 'gap');
      if (i >= 2) assert.ok(!(acts[i - 1].act === a.act && acts[i - 2].act === a.act), 'never three times running');
    }
  }
});

test('planner: nothing starts while an act or a peek is playing', () => {
  assert.equal(run(new AutonomyPlanner(T0), situation({ mood: EXCITED, active: true }), 120).length, 0);
});

// ---- WRITE -----------------------------------------------------------------------------------------------------------------------

function writer(reading: MoodReading = NEUTRAL_MOOD) {
  const port = new FakeMoodPort(() => reading, T0);
  return { port, w: new AutonomyWriter(port) };
}

test('write: moving hard brings N up at the start (scaled by exertion); a sway or a fidget writes nothing', () => {
  const { port, w } = writer();
  w.started('sway', T0); w.started('fidget', T0);
  assert.equal(port.writes.length, 0);
  w.started('hop', T0);
  assert.deepEqual(port.writes.map(x => [x.kind, x.delta]), [['act-exert', { N: 2.5 * ACTS.hop.exertion }]]);
});

test('write: afterwards E slowly (60–120 s later, not before), a little A on the fake port only; landed → D; nearly fell → N up, C a little', () => {
  const { port, w } = writer(), r = seeded(9);
  w.ended({ act: 'hop', completed: true, wobble: false }, T0, r);
  assert.deepEqual(port.writes.map(x => x.kind), ['act-done', 'sleep-pressure']);
  assert.deepEqual(port.writes[0].delta, { D: 1 });
  assert.ok(Math.abs(port.writes[1].delta.A! - 0.01 * ACTS.hop.exertion) < 1e-12);
  w.advance(T0 + 59_000);
  assert.equal(port.writes.length, 2, 'not yet');
  w.advance(T0 + 121_000);
  assert.equal(port.writes.at(-1)!.kind, 'act-afterglow');
  assert.ok(Math.abs(port.writes.at(-1)!.delta.E! - 2 * ACTS.hop.exertion) < 1e-9);
  const b = writer();
  b.w.ended({ act: 'hop', completed: true, wobble: true }, T0, r);
  assert.deepEqual(b.port.writes[0], { at: T0, kind: 'act-wobble', delta: { N: 3, C: 1 } });
  assert.ok(!b.port.writes.some(x => x.kind === 'act-done'), 'a wobbly landing is not a success');
  const c = writer();
  c.w.ended({ act: 'hop', completed: false, wobble: false }, T0, r);
  assert.ok(!c.port.writes.some(x => x.kind === 'act-done'), 'cancelled: no D');
  c.w.ended({ act: 'stretch', completed: true, wobble: false }, T0 + 30 * MIN, r);
  assert.ok(!c.port.writes.some(x => x.kind === 'act-done'), 'a stretch is not an achievement');
});

test('write: each family has the mood moments\' cooldown and day count; a channel already high gets less, then nothing', () => {
  const { port, w } = writer();
  w.started('hop', T0); w.started('dance', T0 + 5 * MIN);
  assert.equal(port.writes.length, 1, 'one exertion lift per 10 minutes');
  w.started('dance', T0 + 11 * MIN);
  assert.equal(port.writes.length, 2);
  for (let i = 0; i < 30; i++) w.started('hop', T0 + (20 + i * 11) * MIN);
  assert.equal(port.writes.filter(x => x.kind === 'act-exert').length, AUTONOMY_WRITES['act-exert'].perDay, 'day count');
  const high = writer(mood({ N: 90, D: 70 }));
  high.w.started('hop', T0);
  high.w.ended({ act: 'hop', completed: true, wobble: false }, T0 + MIN, seeded(1));
  assert.equal(high.port.writes.filter(x => x.kind === 'act-exert').length, 0, 'N past the hard line: nothing');
  assert.ok(high.port.writes.find(x => x.kind === 'act-done')!.delta.D! < 1, 'D past the soft line: less');
});

test('write: never O, B or M; A only through the fake port\'s nudge, at most 0.05 a day', () => {
  const { port, w } = writer(), r = seeded(2);
  for (let i = 0; i < 40; i++) { const at = T0 + i * 25 * MIN; w.started('dance', at); w.ended({ act: 'dance', completed: true, wobble: i % 7 === 0 }, at + 20_000, r); w.advance(at + 3 * MIN); }
  for (const x of port.writes) for (const key of Object.keys(x.delta)) assert.ok(['D', 'E', 'N', 'C', 'A'].includes(key), key);
  const today = port.writes.filter(x => x.kind === 'sleep-pressure' && new Date(x.at).getDate() === new Date(T0).getDate());
  assert.ok(today.reduce((s, x) => s + x.delta.A!, 0) <= 0.05 + 1e-12);
});

// ---- the closed loop over a day ------------------------------------------------------------------------------------------------

test('the closed loop over five synthetic days stays in bounds (no flooding, quiet when sleepy, still when afraid, no runaway)', () => {
  for (const day of SYNTHETIC_DAYS) for (const seed of [1, 2, 3]) {
    const r = simulateDay(day, seed), tag = `${day.id}#${seed}`;
    assert.ok(r.max10 <= 3, `${tag}: at most 3 in any 10 minutes (${r.max10})`);
    assert.ok(r.max60 <= AUTONOMY_KNOBS.perHour, `${tag}: hourly cap`);
    assert.ok(r.maxRun <= 2, `${tag}: never three in a row`);
    assert.equal(r.bigWhileSleepy, 0, `${tag}: nothing big when sleepy`);
    assert.equal(r.whileAfraid, 0, `${tag}: nothing while afraid`);
    assert.equal(r.bigWhileBusyOrTalking, 0, `${tag}: nothing beyond small while you are busy or talking`);
    for (const key of ['D', 'E', 'N', 'C'] as const) assert.ok(r.peakOffset[key] < 5, `${tag}: her movement adds at most a few points of ${key} (${r.peakOffset[key].toFixed(2)})`);
    assert.ok(r.perWakingHour < 2.5, `${tag}: ${r.perWakingHour.toFixed(2)} an hour`);
  }
  const by = Object.fromEntries(SYNTHETIC_DAYS.map(d => [d.id, simulateDay(d, 1)]));
  const excited = (id: string) => by[id].acts.filter(a => ACTS[a.act].family === 'excited').length;
  assert.ok(excited('happy') >= 2, 'a happy day has some hops or spins');
  for (const id of ['bored', 'sleepy', 'tense', 'ordinary']) assert.equal(excited(id), 0, `${id}: no excited acts`);
  assert.ok(by.bored.counts.fidget + by.bored.counts.wander >= 10, 'a bored afternoon fidgets and wanders');
  assert.ok(by.tense.freezeMinutes > 30 && by.tense.acts.every(a => a.amplitude < 0.8), 'a tense day: frozen at the peaks, small otherwise');
  const night = by.sleepy.acts.filter(a => a.A >= 0.7);
  assert.ok(night.length >= 1 && night.every(a => a.act === 'curl-up'), 'up late and sleepy: she only curls up');
  assert.ok(by.ordinary.acts.length >= 6 && by.ordinary.acts.length <= 20, 'an ordinary day: a handful of small things');
});

// ---- the hop's path and the gait's hop --------------------------------------------------------------------------------------------

test('hop path: crouch, monotone push, C² take-off at −g, the flight parabola, a landing that dips by its depth and settles', () => {
  const plan = planHop({ crouchM: 0.055, heightM: 0.07, gravity: 6.5 }, 0.04);
  const at = (t: number) => hopAt(plan, t), e = 1e-7;
  const tc = plan.crouchS, tp = tc + plan.pushS, tf = tp + plan.flightS;
  for (const [t, label] of [[tc, 'crouch→push'], [tp, 'take-off'], [tf, 'touch-down']] as const) {
    const a = at(t - e), b = at(t + e);
    assert.ok(Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.v - b.v) < 1e-5, `${label}: position and speed continue`);
  }
  assert.ok(Math.abs(at(tc - e).a - at(tc + e).a) < 1e-3, 'crouch→push: acceleration too');
  assert.ok(Math.abs(at(tp - e).a + 6.5) < 1e-3 && Math.abs(at(tp + e).a + 6.5) < 1e-9, 'take-off: −g on both sides');
  for (let t = tc; t < tp; t += 0.002) assert.ok(at(t).v >= -1e-9, 'the push only rises');
  const apex = at(tp + plan.flightS / 2).y;
  assert.ok(Math.abs(apex - (0.04 + 0.07)) < 1e-9, 'apex = take-off + height');
  let dip = 0; for (let t = tf; t < hopDuration(plan); t += 0.002) dip = Math.min(dip, at(t).y);
  assert.ok(Math.abs(-dip - plan.landDepthM) < 1e-4, 'the knees take the planned depth');
  assert.ok(planHop({ crouchM: 0.055, heightM: 0.12, gravity: 6.5 }, 0.04).landDepthM > plan.landDepthM, 'a higher hop lands deeper');
  assert.equal(at(hopDuration(plan) + 0.01).phase, 'done');
  assert.ok(Math.abs(at(hopDuration(plan) - 1e-6).y) < 2e-4, 'settled back to standing before it ends');
});

const BODY: GaitBody = { home: [{ x: 0.08, z: 0 }, { x: -0.08, z: 0 }], ankleHeight: 0.08, legLength: 0.78, hipHeight: 0.86, foot: { heel: 0.04, toe: 0.13, halfWidth: 0.04 }, toe: { forward: 0.12, drop: 0.07 } };
test('gait hop: both feet leave together and land on the very places they left; refused while walking; the same id is one hop', () => {
  const gait = new Gait(BODY, { x: 0, z: 0, heading: 0 });
  for (let i = 0; i < 120; i++) gait.step(1 / 60);
  const start = gait.footStates.map(f => ({ x: f.x, z: f.z }));
  assert.equal(gait.hop({ id: 1, crouchM: 0.05, heightM: 0.07, gravity: 6.5 }), true);
  assert.equal(gait.hop({ id: 1, crouchM: 0.05, heightM: 0.07, gravity: 6.5 }), false, 'same id');
  let air = 0, minLift = Infinity;
  while (gait.hopPhase) {
    gait.step(1 / 60);
    if (gait.footStates.every(f => f.phase === 'air')) air++;
    if (gait.hopPhase === 'flight') minLift = Math.min(minLift, ...gait.footStates.map(f => f.lift));
    assert.equal(gait.stepCount, 0, 'no stepping during a hop');
  }
  assert.ok(air > 10 && minLift > 0, 'in the air together');
  for (const [i, f] of gait.footStates.entries()) { assert.equal(f.phase, 'planted'); assert.ok(Math.hypot(f.x - start[i].x, f.z - start[i].z) < 1e-9, 'landed where it left'); }
  assert.equal(gait.hopsDone, 1);
  gait.setGoal(2, 0);
  for (let i = 0; i < 60; i++) gait.step(1 / 60);
  assert.equal(gait.walking, true);
  assert.equal(gait.hop({ id: 2, crouchM: 0.05, heightM: 0.07, gravity: 6.5 }), false, 'not while walking');
});
