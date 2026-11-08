/**
 * #8 你不理她时多久看你、动一下、想开口 (shared/behaviors/boredom-timing/): the draw, the safety line (never an earlier small
 * motion or speech than the card, for any leftover boredom and a mid-round 在场 relief), the contract both implementations keep,
 * the real reasons in "why", and "one knob changes only what it governs". BOREDOM_TIMING_REPORT=1 prints the 20-round spread.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceMood, createMoodState, DEFAULT_MOOD_PARAMETERS, validateMoodParameters, type MoodLabel, type MoodParameters } from '../shared/mood';
import { applyMoodPresence } from '../shared/mood-presence';
import { BoredomTimingDirector, boredomHoldMinutes, boredomMinute, boredomRulesNoEarlier, boredomTimingNow, drawBoredomRound, EMPTY_BOREDOM_HISTORY,
  type BoredomHistory } from '../shared/behaviors/boredom-timing/choose';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { BOREDOM_TIMING_KNOBS, type BoredomTimingKnobs } from '../shared/behaviors/boredom-timing/knobs';
import type { BoredomKind, BoredomRules, BoredomTimingHost, BoredomTimingNow } from '../shared/behaviors/boredom-timing/interface';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000;
const report = !!process.env.BOREDOM_TIMING_REPORT;
const CARD: BoredomRules = { ...DEFAULT_MOOD_PARAMETERS.boredom };
const MOODS: readonly MoodLabel[] = ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'];
const calm = (personality: Partial<Record<string, number>> = {}, mood: MoodLabel = 'calm', fatiguePhase: 'awake' | 'light-drowsy' | 'drowsy' = 'awake'): BoredomTimingNow =>
  boredomTimingNow({ snapshot: { primary: mood, companion: null }, personality, fatiguePhase });
const knobs = (change: (k: BoredomTimingKnobs) => unknown): BoredomTimingKnobs => { const k = structuredClone(BOREDOM_TIMING_KNOBS) as BoredomTimingKnobs; change(k); return k; };
const counted = (random: () => number) => { let calls = 0; return { random: () => { calls++; return random(); }, calls: () => calls }; };
const plusHistory = (history: BoredomHistory, tempo: BoredomHistory['tempos'][number], plan: Record<BoredomKind, number | null>): BoredomHistory => ({
  tempos: [tempo, ...history.tempos].slice(0, 2),
  minutes: { look: [plan.look!, ...history.minutes.look].slice(0, 3), motion: [plan.motion!, ...history.minutes.motion].slice(0, 3), speech: [plan.speech!, ...history.minutes.speech].slice(0, 3) },
});

function randomCard(random: () => number): BoredomRules {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const level = () => pick([0, 100, Math.round(random() * 100), Math.round(random() * 1000) / 10]);
  const [lookAt, motionAt, speechAt] = [level(), level(), level()].sort((a, b) => a - b);
  return { graceMs: pick([0, 5 * MINUTE, Math.round(random() * 120 * MINUTE)]), perMinute: pick([0, 20, 2, Math.round(random() * 2000) / 100]), lookAt, motionAt, speechAt };
}
function randomNow(random: () => number): BoredomTimingNow {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  return boredomTimingNow({ snapshot: { primary: pick(MOODS), companion: pick([null, 'playful', 'close', 'comfortable', 'cautious', 'wistful'] as const) },
    personality: { playful: random() * 4, close: random() * 4, comfortable: random() * 4, cautious: random() * 4 },
    fatiguePhase: pick(['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep'] as const) });
}

test('the safety line catches a rule set that would bring a small motion or speech earlier than the card', () => {
  const hold = boredomHoldMinutes(DEFAULT_MOOD_PARAMETERS.interaction.attentionMs);
  assert.equal(boredomRulesNoEarlier(CARD, CARD, hold), true);
  assert.equal(boredomRulesNoEarlier(CARD, { ...CARD, graceMs: 6 * MINUTE, perMinute: 1.5, motionAt: 56, speechAt: 90 }, hold), true, 'later is fine');
  assert.equal(boredomRulesNoEarlier(CARD, { ...CARD, lookAt: 10, motionAt: 56, speechAt: 76 }, hold), true, 'an early look is fine; motion and speech a little later');
  for (const [name, rules] of [
    ['shorter grace', { ...CARD, graceMs: 4 * MINUTE, speechAt: 80 }],
    ['lower speech threshold', { ...CARD, speechAt: 74, graceMs: 9 * MINUTE }],
    ['lower motion threshold', { ...CARD, motionAt: 54, graceMs: 9 * MINUTE }],
    ['faster with the same thresholds', { ...CARD, perMinute: 2.2 }],
    ['faster, speech threshold a little higher but still earlier', { ...CARD, perMinute: 2.6, speechAt: 90 }],
    // T-207 3B / 3D: from zero these moments are the card's or later, but her boredom would run ahead of the card's: a chat
    // carries more of it into the next round, and a card edit after both grace periods leaves only the faster rate.
    ['faster, every moment from zero kept', { ...CARD, lookAt: 10, perMinute: 2.4, motionAt: 66, speechAt: 90 }],
    // T-207 3A: the card's own look prompt holds its motion back for one prompt; a threshold less than that above the card's is not enough.
    ['thresholds above the card by less than one prompt', { ...CARD, graceMs: 6 * MINUTE, motionAt: 55.1, speechAt: 75.1 }],
    ['the card with only the look moved', { ...CARD, lookAt: 20 }],
    ['out of the card range', { ...CARD, perMinute: 25, motionAt: 100, speechAt: 100 }],
    ['thresholds out of order', { ...CARD, lookAt: 60 }],
  ] as const) assert.equal(boredomRulesNoEarlier(CARD, rules, hold), false, name);
  assert.equal(boredomRulesNoEarlier(CARD, { ...CARD, graceMs: 6 * MINUTE, motionAt: 55.1, speechAt: 75.1 }), true, 'with no hold given, any threshold not below the card\'s is enough');
  const still = { ...CARD, perMinute: 0 };
  assert.equal(boredomRulesNoEarlier(still, { ...still, perMinute: 0.5, speechAt: 100, motionAt: 100 }), false, 'a card that is never bored stays never bored');
});

test('every draw keeps the safety line for any card, mood, card personality, leftover boredom and history; five random numbers each', () => {
  const random = seeded(8), cases = 3000;
  let earlierLooks = 0;
  for (let i = 0; i < cases; i++) {
    const card = randomCard(random), now = randomNow(random);
    const b0 = random() < 0.5 ? 0 : random() * 100, idleMinutes = random() < 0.7 ? 0 : random() * 90;
    const history: BoredomHistory = { tempos: random() < 0.5 ? [] : ['eager', 'unhurried'],
      minutes: { look: random() < 0.5 ? [] : [random() * 60], motion: random() < 0.5 ? [] : [random() * 80], speech: random() < 0.5 ? [] : [random() * 100] } };
    const draw = counted(seeded(i + 1));
    const hold = boredomHoldMinutes(random() < 0.5 ? DEFAULT_MOOD_PARAMETERS.interaction.attentionMs : random() * 120_000);
    const round = drawBoredomRound(card, random() < 0.05 ? null : now, { boredom: b0, idleMinutes, holdMinutes: hold }, history, draw.random);
    assert.equal(draw.calls(), 5, 'tempo, grace, rate, look, how much later');
    assert.ok(boredomRulesNoEarlier(card, round.rules, hold), JSON.stringify({ card, rules: round.rules, why: round.why }));
    assert.ok(round.rules.perMinute <= card.perMinute && round.rules.graceMs >= card.graceMs, 'her boredom never runs ahead of the card\'s');
    // Motion and speech move together: the gap between them is the card's, the motion one second later at most (so the inner
    // loop is woken no more often; see MOTION_LAG_MINUTES).
    const gapBefore = [boredomMinute(card, card.motionAt), boredomMinute(card, card.speechAt)], gapAfter = [boredomMinute(round.rules, round.rules.motionAt), boredomMinute(round.rules, round.rules.speechAt)];
    if (card.motionAt > 0 && card.perMinute > 0 && !round.why.some(line => line.includes('兜底'))) {
      const change = (gapAfter[1]! - gapAfter[0]!) - (gapBefore[1]! - gapBefore[0]!);
      assert.ok(change <= 1e-6 && change >= -1 / 60 - 1e-6, `gap changed by ${change} (${JSON.stringify({ card, rules: round.rules, b0 })})`);
    }
    assert.doesNotThrow(() => validateMoodParameters({ ...structuredClone(DEFAULT_MOOD_PARAMETERS), boredom: round.rules }), 'a valid card value set');
    for (const leftover of [0, 1, 10, 25, 40, 55, 70, 74.99, 75, 85, 99.9, 100, card.motionAt - 0.01, card.speechAt - 0.01, card.speechAt]) {
      if (!(leftover >= 0 && leftover <= 100)) continue;
      for (const key of ['motionAt', 'speechAt'] as const) {
        const before = boredomMinute(card, card[key], leftover), after = boredomMinute(round.rules, round.rules[key], leftover);
        if (before === null) assert.equal(after, null, `${key} never comes when the card never does`);
        else assert.ok(after === null || after >= before - 1e-6, `${key} with ${leftover} left over: ${after} < ${before} (${JSON.stringify({ card, rules: round.rules })})`);
      }
    }
    const lookBefore = boredomMinute(card, card.lookAt), lookAfter = boredomMinute(round.rules, round.rules.lookAt);
    if (lookBefore !== null && lookAfter !== null && lookAfter < lookBefore - 0.5) earlierLooks++;
  }
  assert.ok(earlierLooks > 0, `a look (no words, no model call) may come earlier: ${earlierLooks}`);
});

/** Pure mood model, card vs this round's rules, with 在场 reliefs mid-round; the first minute boredom reached a threshold. */
function firstCrossings(card: MoodParameters, host: BoredomTimingHost | null, leftover: number, reliefs: readonly { at: number; amount: number }[], minutes: number) {
  const start = 1_000_000_000;
  let state = createMoodState(start, card);
  state.boredom = leftover;
  const crossed: Partial<Record<'motionAt' | 'speechAt', number>> = {};
  let id = 0;
  const rules = () => host ? { ...card, boredom: { ...host.rules('c', card.boredom, { idleMs: state.onlineIdleMs, boredom: state.boredom, at: state.updatedAt }, () => calm()) } } : card;
  const p0 = rules();
  for (let t = 20_000; t <= minutes * MINUTE; t += 20_000) {
    const p = rules();
    state = advanceMood(state, start + t, { online: true }, p);
    for (const relief of reliefs) if (relief.at === t) {
      state = applyMoodPresence(state, { id: `presence-${id++}`, relief: relief.amount }, start + t, p);
      host?.relieved('c');
    }
    for (const key of ['motionAt', 'speechAt'] as const) if (crossed[key] === undefined && state.boredom >= rules().boredom[key]) crossed[key] = t / MINUTE;
  }
  return { crossed, rules: p0.boredom };
}

test('a mid-round 在场 relief never brings a motion or speech earlier, even when the pace knob is above 1 (and the check would catch a faster round)', () => {
  const random = seeded(31);
  let fasterEarlier = 0;
  // The eager tempo only, its pace knob above 1 (1.08～1.2): the rate stays the card's, only the look comes earlier.
  const eager = knobs(k => { (k.tempos.usual as { base: number }).base = 0; (k.tempos.unhurried as { base: number }).base = 0; });
  for (let i = 0; i < 60; i++) {
    const card = { ...structuredClone(DEFAULT_MOOD_PARAMETERS), boredom: { ...CARD, graceMs: Math.round(random() * 8) * MINUTE, perMinute: 1 + random() * 3 } };
    const leftover = random() < 0.5 ? 0 : random() * 40;
    const reliefs = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ at: (1 + Math.floor(random() * 300)) * 20_000, amount: 5 + random() * 25 }));
    const before = firstCrossings(card, null, leftover, reliefs, 150).crossed;
    const drawn = firstCrossings(card, new BoredomTimingDirector({ random: seeded(i + 100), knobs: eager }), leftover, reliefs, 150);
    assert.ok(drawn.rules.perMinute <= card.boredom.perMinute, 'never faster than the card');
    for (const key of ['motionAt', 'speechAt'] as const) {
      if (before[key] === undefined) continue;
      assert.ok(drawn.crossed[key] === undefined || drawn.crossed[key]! >= before[key]! - 1e-9, `${key}: ${drawn.crossed[key]} < ${before[key]} (${JSON.stringify({ card: card.boredom, leftover, reliefs })})`);
    }
    // Control: a round that rises 1.2× faster with thresholds raised so every moment from zero is the card's (what the old
    // safety line let through, T-207 3B/3C/3D). The same relief lets it cross earlier: this test sees that failure.
    const b = card.boredom, fast = { ...b, perMinute: b.perMinute * 1.2, lookAt: Math.min(100, b.lookAt * 1.2), motionAt: Math.min(100, b.motionAt * 1.2), speechAt: Math.min(100, b.speechAt * 1.2) };
    const faster: BoredomTimingHost = { rules: () => fast, happened: () => {}, relieved: () => {}, recent: () => [] };
    const loose = firstCrossings(card, faster, leftover, reliefs, 150).crossed;
    if (before.speechAt !== undefined && loose.speechAt !== undefined && loose.speechAt < before.speechAt - 1e-9) fasterEarlier++;
  }
  assert.ok(fasterEarlier > 0, 'a faster round would cross earlier after a relief: the test sees that failure');
});

test('20 rounds of the same scene: the minutes vary, no kind lands at the same moment twice in a row, motion and speech never before the card', () => {
  const fixed = new FixedBoredomTiming();
  const runs = (host: BoredomTimingHost) => {
    const out: Record<BoredomKind, number[]> = { look: [], motion: [], speech: [] };
    for (let round = 0; round < 20; round++) {
      const start = 10_000_000 + round * 4 * 60 * MINUTE;
      host.rules('gene', CARD, { idleMs: 0, boredom: 0, at: start }, () => calm());
      const plan = host.recent('gene')[0].plan;
      for (const kind of ['look', 'motion', 'speech'] as const) { out[kind].push(plan[kind]!); host.happened('gene', kind, start + plan[kind]! * MINUTE); }
      host.rules('gene', CARD, { idleMs: 50 * MINUTE, boredom: 100, at: start + 50 * MINUTE }, () => calm());
    }
    return out;
  };
  const before = runs(fixed);
  assert.deepEqual([...new Set(before.look)], [20]); assert.deepEqual([...new Set(before.motion)], [32.5]); assert.deepEqual([...new Set(before.speech)], [42.5]);
  for (const seed of [1, 2, 3, 4, 5]) {
    const after = runs(new BoredomTimingDirector({ random: seeded(seed) }));
    if (report) console.log(`seed ${seed}`, JSON.stringify(after));
    for (const kind of ['look', 'motion', 'speech'] as const) {
      const minutes = after[kind];
      assert.ok(new Set(minutes).size >= 15, `${kind}: ${minutes.join(', ')}`);
      for (let i = 1; i < minutes.length; i++) assert.ok(Math.abs(minutes[i] - minutes[i - 1]) >= BOREDOM_TIMING_KNOBS.apartMinutes - 0.051, `${kind} ${minutes[i - 1]} → ${minutes[i]}`);
    }
    assert.ok(after.motion.every(m => m >= 32.5) && after.speech.every(m => m >= 42.5), 'never before the card');
    assert.ok(Math.min(...after.look) < 20 && Math.max(...after.look) > 20, `the look moves both ways around the card: ${after.look.join(', ')}`);
    assert.ok(Math.max(...after.speech) <= 42.5 * 1.45 + 3 && Math.max(...after.motion) <= 32.5 * 1.4 + 8, 'and stays near it');
  }
});

test('her mood, card and tiredness lean the tempo; the why names only what is true', () => {
  const sample = (now: BoredomTimingNow, n = 400) => {
    const random = seeded(77), out = { eager: 0, unhurried: 0, speech: 0, look: 0, why: new Set<string>() };
    for (let i = 0; i < n; i++) {
      const round = drawBoredomRound(CARD, now, { boredom: 0, idleMinutes: 0 }, EMPTY_BOREDOM_HISTORY, random);
      if (round.tempo === 'eager') out.eager++;
      if (round.tempo === 'unhurried') out.unhurried++;
      out.speech += round.plan.speech! / n; out.look += round.plan.look! / n;
      for (const line of round.why) out.why.add(line);
    }
    return out;
  };
  const plain = sample(calm()), clingy = sample(calm({ close: 2 }, 'happy')), sulky = sample(calm({ cautious: 2 }, 'upset')), sleepy = sample(calm({}, 'calm', 'drowsy'));
  assert.ok(clingy.eager > plain.eager * 1.6 && clingy.look < plain.look - 1 && clingy.speech < plain.speech - 1, `clingy and happy: sooner (${clingy.look.toFixed(1)}/${plain.look.toFixed(1)})`);
  assert.ok(sulky.unhurried > plain.unhurried * 1.6 && sulky.speech > plain.speech + 1, 'upset and slow to warm: later');
  assert.ok(sleepy.unhurried > plain.unhurried * 1.5 && sleepy.speech > plain.speech + 1, 'drowsy: later');
  const all = (s: { why: Set<string> }) => [...s.why].join('\n');
  assert.match(all(clingy), /性格：黏人/); assert.match(all(clingy), /心情：愉快/);
  assert.match(all(sulky), /性格：慢热/); assert.match(all(sulky), /心情：不满/);
  assert.match(all(sleepy), /困了/);
  for (const absent of ['性格：', '心情：愉快', '心情：不满', '困了', '有点累', '剩下的无聊', '上次看你', '上次动一下', '上次开口', '兜底'])
    assert.doesNotMatch(all(plain), new RegExp(absent), `the plain card at baseline never says "${absent}"`);
  assert.doesNotMatch(all(clingy), /慢热|不满|困了/);
  // Leftover boredom and a separation are said only when they happened.
  const leftover = drawBoredomRound(CARD, calm(), { boredom: 40, idleMinutes: 0 }, EMPTY_BOREDOM_HISTORY, seeded(1));
  assert.ok(leftover.why.some(line => line.includes('上一轮剩下的无聊还有 40')) && leftover.plan.look === 0, 'already over the look threshold: at once');
});

test('the why of a separation names the last moment that really happened, and only rounds where something happened are remembered', () => {
  // Every round wants the same minutes, so only the separation can move them.
  const flat = knobs(k => {
    (k as { look: readonly number[] }).look = [1, 1];
    for (const t of Object.values(k.tempos)) Object.assign(t, { grace: [1, 1], pace: [1, 1], later: [0, 0] });
  });
  const director = new BoredomTimingDirector({ random: seeded(5), knobs: flat });
  const start = 50_000_000;
  /** A round: the idle clock runs a while, then goes back to 0 (she was answered). */
  const newRound = (at: number) => {
    director.rules('gene', CARD, { idleMs: 60_000, boredom: 0, at: at - 1 }, () => calm());
    director.rules('gene', CARD, { idleMs: 0, boredom: 0, at }, () => calm());
  };
  director.rules('gene', CARD, { idleMs: 0, boredom: 0, at: start }, () => calm());
  assert.deepEqual(director.recent('gene')[0].plan, { look: 20, motion: 32.5, speech: 42.5 });
  // A round that ends before anything happened: nothing to avoid next time.
  newRound(start + 10 * MINUTE);
  assert.deepEqual(director.recent('gene')[0].plan, { look: 20, motion: 32.5, speech: 42.5 });
  assert.equal(director.recent('gene').length, 1, 'the empty round is not kept');
  assert.ok(!director.recent('gene')[0].why.some(line => line.includes('上次')));
  const second = start + 10 * MINUTE;
  director.happened('gene', 'look', second + 20 * MINUTE);
  director.happened('gene', 'look', second + 25 * MINUTE); // only the first look of a round counts
  director.happened('gene', 'speech', second + 42.5 * MINUTE);
  newRound(second + 60 * MINUTE);
  const [now, previous] = director.recent('gene');
  assert.equal(now.current, true); assert.equal(previous.current, false);
  assert.deepEqual(previous.happened, { look: 20, speech: 42.5 });
  assert.ok(now.why.includes('上次看你在第 20 分钟，这次避开（第 21.5 分钟）') || now.why.includes('上次看你在第 20 分钟，这次避开（第 18.5 分钟）'), now.why.join('；'));
  assert.ok(now.why.includes('上次开口在第 42.5 分钟，这次避开（第 44 分钟）'), 'speech can only move later: the card moment is its floor');
  assert.equal(now.plan.speech, 44);
  assert.ok(!now.why.some(line => line.includes('上次动一下')), 'motion never happened, so nothing to avoid');
});

test('one knob changes only what it governs', () => {
  const draws = (k: BoredomTimingKnobs, history = EMPTY_BOREDOM_HISTORY, n = 40) => {
    const random = seeded(12), out = [];
    for (let i = 0; i < n; i++) out.push(drawBoredomRound(CARD, calm({ close: 1.6 }, MOODS[i % MOODS.length]), { boredom: 0, idleMinutes: 0 }, history, random, k));
    return out;
  };
  const base = draws(BOREDOM_TIMING_KNOBS);
  // look: only the look threshold.
  const look = draws(knobs(k => { (k as { look: readonly number[] }).look = [0.5, 0.5]; }));
  look.forEach((round, i) => {
    const b = base[i];
    assert.equal(round.tempo, b.tempo);
    assert.deepEqual({ ...round.rules, lookAt: 0 }, { ...b.rules, lookAt: 0 });
    // × 0.5, and ÷ the pace knob where it is above 1 (that round's look comes earlier instead of rising faster).
    assert.ok(round.rules.lookAt <= CARD.lookAt * 0.5 + 1e-9 && round.rules.lookAt >= CARD.lookAt * 0.5 / 1.2 - 1e-9, `${round.rules.lookAt}`);
  });
  // tempos.unhurried.later: only the motion and speech thresholds of the unhurried rounds, and they keep the card's gap.
  const later = draws(knobs(k => { (k.tempos.unhurried as { later: readonly number[] }).later = [0.5, 0.55]; }));
  let changed = 0;
  later.forEach((round, i) => {
    const b = base[i];
    assert.equal(round.tempo, b.tempo);
    if (b.tempo !== 'unhurried') { assert.deepEqual(round.rules, b.rules); return; }
    assert.deepEqual({ ...round.rules, motionAt: 0, speechAt: 0 }, { ...b.rules, motionAt: 0, speechAt: 0 });
    if (round.rules.speechAt !== b.rules.speechAt) changed++;
    assert.ok(round.plan.speech! - round.plan.motion! - (b.plan.speech! - b.plan.motion!) < 0.11, 'same gap');
  });
  assert.ok(changed > 0, `the unhurried rounds did change (${changed})`);
  // apartMinutes 0: the history no longer matters.
  let history: BoredomHistory = EMPTY_BOREDOM_HISTORY;
  const noApart = knobs(k => { (k as { apartMinutes: number }).apartMinutes = 0; });
  for (let i = 0; i < 30; i++) {
    const withHistory = drawBoredomRound(CARD, calm(), { boredom: 0, idleMinutes: 0 }, history, seeded(500 + i), noApart);
    const without = drawBoredomRound(CARD, calm(), { boredom: 0, idleMinutes: 0 }, { ...history, minutes: EMPTY_BOREDOM_HISTORY.minutes }, seeded(500 + i), noApart);
    assert.deepEqual(withHistory.rules, without.rules);
    assert.ok(!withHistory.why.some(line => line.includes('避开')));
    history = plusHistory(history, withHistory.tempo, withHistory.plan);
  }
  // tempos.eager.base 0: never eager.
  assert.ok(draws(knobs(k => { (k.tempos.eager as { base: number }).base = 0; })).every(round => round.tempo !== 'eager'));
});

for (const [name, make] of [['real', () => new BoredomTimingDirector({ random: seeded(4) })], ['fake', () => new FixedBoredomTiming()]] as const) {
  test(`contract (${name}): one set per round, a new round when the idle clock goes back or the card changes, never earlier than the card, memory-only why`, () => {
    const host: BoredomTimingHost = make();
    let reads = 0;
    const now = () => { reads++; return calm(); };
    const at = 7_000_000;
    const first = host.rules('a', CARD, { idleMs: 0, boredom: 0, at }, now);
    assert.equal(reads, name === 'real' ? 1 : 0);
    assert.ok(boredomRulesNoEarlier(CARD, first));
    assert.equal(host.rules('a', CARD, { idleMs: 60_000, boredom: 0, at: at + 60_000 }, now), first, 'same round, same set');
    assert.equal(host.rules('a', CARD, { idleMs: 10 * MINUTE, boredom: 10, at: at + 10 * MINUTE }, now), first);
    assert.equal(reads, name === 'real' ? 1 : 0, '"此刻" is read only when a round begins');
    host.happened('a', 'look', at + 21 * MINUTE);
    host.happened('a', 'look', at + 26 * MINUTE);
    const entry = host.recent('a')[0];
    assert.equal(entry.current, true); assert.equal(entry.happened.look, 21, 'only the first look of the round');
    assert.deepEqual(JSON.parse(JSON.stringify(host.recent('a'))), host.recent('a'), 'plain data');
    (host.recent('a')[0].why as string[]).push('changed outside'); (host.recent('a')[0].happened as Record<string, number>).motion = 1;
    assert.ok(!host.recent('a')[0].why.includes('changed outside') && host.recent('a')[0].happened.motion === undefined, 'copies');
    const next = host.rules('a', CARD, { idleMs: 0, boredom: 0, at: at + 40 * MINUTE }, now);
    assert.notEqual(next, first, 'the idle clock went back: a new round');
    const card = { ...CARD, speechAt: 80 };
    const changed = host.rules('a', card, { idleMs: 60_000, boredom: 0, at: at + 41 * MINUTE }, now);
    assert.notEqual(changed, next, 'the card changed: a new round');
    assert.ok(boredomRulesNoEarlier(card, changed));
    if (name === 'fake') assert.deepEqual({ ...changed }, card);
    assert.deepEqual(host.recent('other'), []);
    host.happened('other', 'speech', at); host.relieved('other');
    assert.deepEqual(host.recent('other'), [], 'nothing for a character never seen');
  });
}
