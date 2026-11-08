/**
 * #21 摸头、捏脸、喂点心让她心情好多少 (shared/behaviors/touch-feed-effect/): the safety line (one dose never gives more than the
 * old fixed amount, measured in the real mood model), every draw keeps it, 20 times the same scene, her mood and card lean it,
 * the why names only what is true, one knob changes only what it governs, and the contract both implementations keep.
 * TOUCH_FEED_REPORT=1 prints the 20 draws and the dose-by-dose sequences.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, validateMoodParameters, type MoodLabel, type MoodParameters, type MoodTendency } from '../shared/mood';
import { MOOD_LABELS } from '../shared/mood-runtime';
import { drawTouchFeed, freshnessDepth, freshnessLeft, tireFactor, tiredFreshness, touchFeedEffectSafe, touchFeedNow, TouchFeedEffectDirector } from '../shared/behaviors/touch-feed-effect/choose';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { withTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/perform';
import { TOUCH_FEED_EFFECT_KNOBS, TOUCH_FEED_LANDING_IDS, type TouchFeedEffectKnobs, type TouchFeedKind, type TouchFeedLandingId } from '../shared/behaviors/touch-feed-effect/knobs';
import type { TouchFeedEffectHost, TouchFeedEvent, TouchFeedNow } from '../shared/behaviors/touch-feed-effect/interface';
import { seeded } from './helpers/seeded';

const report = !!process.env.TOUCH_FEED_REPORT;
const MOODS = Object.keys(MOOD_LABELS) as MoodLabel[];
const TENDENCIES: MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
const card = DEFAULT_MOOD_PARAMETERS.freshness;
const plainPersonality = { playful: 1, close: 1, comfortable: 1, cautious: 1 };
const calm: TouchFeedNow = { mood: 'calm', tendency: null, personality: plainPersonality, moments: [] };
const withPersonality = (patch: Partial<Record<MoodTendency, number>>, mood: MoodLabel = 'calm'): TouchFeedNow => ({ ...calm, mood, personality: { ...plainPersonality, ...patch } });
const counting = (random: () => number) => { const wrapped = () => { wrapped.calls++; return random(); }; wrapped.calls = 0; return wrapped; };
const event = (kind: TouchFeedKind, sessionId: string, taken = 0, doses = kind === 'food' ? 1 : 1): TouchFeedEvent =>
  ({ kind, contact: kind === 'food' ? 'food' : 'pat', sessionId, doses, taken, at: 1_000 });

/** A card whose O, D and E sit far below a high baseline: every gain is linear, so the model's applied amount is exactly what was asked. */
function linearCard(freshness: Partial<MoodParameters['freshness']> = {}, sensitivity: Partial<MoodParameters['sensitivity']> = {}): MoodParameters {
  return validateMoodParameters({ ...structuredClone(DEFAULT_MOOD_PARAMETERS), baseline: { D: 95, O: 95, E: 95, N: 50, C: 50 },
    freshness: { ...DEFAULT_MOOD_PARAMETERS.freshness, ...freshness }, sensitivity: { ...DEFAULT_MOOD_PARAMETERS.sensitivity, ...sensitivity } });
}
function lowState(p: MoodParameters, now: number) {
  const state = createMoodState(now, p);
  state.values = { D: 5, O: 5, E: 5, N: 50, C: 50 };
  return state;
}
const applied = (state: ReturnType<typeof createMoodState>, id: string) => [...state.trend].reverse().find(sample => sample.id === id)!.delta;

test('the safety line catches a stronger dose, an illegal or too-deep tiredness, and lets the card itself through', () => {
  assert.ok(touchFeedEffectSafe(card, { scale: 1, retention: card.retention, floor: card.floor }));
  assert.ok(touchFeedEffectSafe(card, { scale: 0.6, retention: 0.72, floor: 0.44 }));
  for (const bad of [{ scale: 1.01, retention: 0.6, floor: 0.2 }, { scale: -0.1, retention: 0.6, floor: 0.2 }, { scale: Number.NaN, retention: 0.6, floor: 0.2 },
    { scale: 1, retention: 1.2, floor: 0.2 }, { scale: 1, retention: 0.6, floor: 0.01 }, { scale: 1, retention: 0.9, floor: 0.05 } /* 29 doses deep, 4 on the card */])
    assert.equal(touchFeedEffectSafe(card, bad), false, JSON.stringify(bad));
  assert.equal(touchFeedEffectSafe(card, null), false);
  // The depth formula is the mood model's: after many quick doses the saved count stops at it.
  for (const f of [card, { ...card, retention: 0.48, floor: 0.05 }, { ...card, retention: 0.72, floor: 0.44 }]) {
    const p = { ...linearCard(), freshness: { ...card, ...f } };
    let state = lowState(p, 0);
    for (let i = 0; i < 12; i++) state = applyMoodEvent(state, { type: 'rua', id: `r${i}`, effectiveMs: 5_000 }, i, p);
    assert.ok(Math.abs(state.freshness.rua.doses - freshnessDepth(f)) < 1e-9, `${JSON.stringify(f)}: ${state.freshness.rua.doses} vs ${freshnessDepth(f)}`);
    assert.equal(freshnessLeft(f, 0), 1);
  }
});

test('in the real mood model no dose of a pat, pinch or snack ever gives more than the old fixed amount, for any card, mood, card personality and run', () => {
  const random = seeded(21);
  let checked = 0;
  for (let trial = 0; trial < 300; trial++) {
    const retention = Math.round(random() * 100) / 100, floor = Math.round(random() * 100) / 100;
    const sensitivity = { O: 0.2 + random() * 1.8, D: 0.2 + random() * 1.8, E: 0.2 + random() * 1.8 };
    const p = linearCard({ retention, floor }, sensitivity);
    const director = new TouchFeedEffectDirector({ random: seeded(trial) });
    const personality = Object.fromEntries(TENDENCIES.map(t => [t, Math.round(random() * 40) / 10])) as Record<MoodTendency, number>;
    const now: TouchFeedNow = { mood: MOODS[Math.floor(random() * MOODS.length)], tendency: random() < 0.3 ? 'close' : null, personality,
      moments: random() < 0.2 ? ['sleepy'] : random() < 0.2 ? ['tired'] : [] };
    let state = lowState(p, 0), t = 0, session = 0;
    for (let step = 0; step < 14; step++) {
      t += random() < 0.3 ? 10 * 60_000 : 300 + Math.floor(random() * 4_000);
      if (random() < 0.4) session++;
      const kind: TouchFeedKind = random() < 0.65 ? 'touch' : 'food';
      const ms = kind === 'touch' ? 100 + Math.floor(random() * 4_900) : 0;
      const doses = kind === 'touch' ? ms / p.interaction.ruaDoseMs : 1;
      const source = kind === 'touch' ? 'rua' : 'food';
      const taken = state.freshness[source]?.doses ?? 0; // updatedAt advanced below; recovery happens inside the model either way
      const effect = director.effect('gene', { kind, contact: kind === 'food' ? 'food' : 'pat', sessionId: `${kind}-${session}`, doses, taken, at: t }, p.freshness, () => now);
      assert.ok(touchFeedEffectSafe(p.freshness, effect), JSON.stringify(effect));
      const id = `e${step}`;
      const before = state.phase;
      state = applyMoodEvent(state, kind === 'touch' ? { type: 'rua', id, effectiveMs: ms } : { type: 'food', id }, t, withTouchFeedEffect(p, kind, effect));
      if (before.startsWith('food-') && kind === 'touch') continue;
      const delta = applied(state, id);
      const [a, b] = kind === 'touch' ? [delta.O, delta.E] : [delta.D, delta.E];
      const capA = (kind === 'touch' ? 10 * sensitivity.O : 12 * sensitivity.D) * doses, capB = (kind === 'touch' ? 4 : 6) * sensitivity.E * doses;
      assert.ok(a <= capA + 1e-9 && b <= capB + 1e-9, `trial ${trial} step ${step} ${kind}: ${a} > ${capA} or ${b} > ${capB}`);
      checked++;
      state.phase = 'idle';
    }
  }
  assert.ok(checked > 3000);
});

test('every draw is safe and takes exactly two random numbers; the same interaction takes none', () => {
  const random = seeded(7);
  for (let i = 0; i < 2_000; i++) {
    const f = { ...card, retention: Math.round(random() * 100) / 100, floor: Math.round(random() * 100) / 100 };
    const personality = Object.fromEntries(TENDENCIES.map(t => [t, Math.round(random() * 40) / 10])) as Record<MoodTendency, number>;
    const now: TouchFeedNow = { mood: MOODS[i % MOODS.length], tendency: null, personality, moments: [] };
    const draws = counting(seeded(i));
    const director = new TouchFeedEffectDirector({ random: draws });
    const kind: TouchFeedKind = i % 2 ? 'food' : 'touch';
    const first = director.effect('gene', event(kind, 's1', random() * 6), f, () => now);
    assert.equal(draws.calls, 2);
    assert.ok(touchFeedEffectSafe(f, first), `${JSON.stringify(f)} ${JSON.stringify(first)}`);
    assert.ok(first.scale >= 0.6 - 1e-9 && first.scale <= 1);
    const again = director.effect('gene', event(kind, 's1', random() * 6), f, () => now);
    assert.equal(draws.calls, 2, 'the same interaction does not draw again');
    assert.equal(again.scale, first.scale);
    const k = tireFactor(TOUCH_FEED_EFFECT_KNOBS[kind].tire, personality).factor;
    assert.deepEqual({ retention: again.retention, floor: again.floor }, tiredFreshness(f, k, TOUCH_FEED_EFFECT_KNOBS[kind].tire.minFloor));
  }
});

test('20 times the same scene (a fresh 5-second pat, a snack after a long while): before always the same; now it varies, never above the old amount', () => {
  const before = new FixedTouchFeedEffect(), after = new TouchFeedEffectDirector({ random: seeded(20) });
  const old: number[] = [], now: number[] = [], landings: string[] = [], food: number[] = [];
  for (let i = 0; i < 20; i++) {
    old.push(before.effect('gene', event('touch', `pat-${i}`), card, () => calm).scale);
    now.push(after.effect('gene', event('touch', `pat-${i}`), card, () => calm).scale);
    landings.push(after.recent('gene')[0].landing);
    food.push(after.effect('gene', event('food', `snack-${i}`), card, () => calm).scale);
  }
  if (report) { console.log(`touch before: ${old.join(' ')}`); console.log(`touch after: ${now.join(' ')}`); console.log(`landings: ${landings.join(' ')}`); console.log(`food after: ${food.join(' ')}`); }
  assert.deepEqual(new Set(old), new Set([1]));
  assert.ok(new Set(now).size >= 10, now.join(' '));
  assert.ok(new Set(food).size >= 10, food.join(' '));
  assert.ok([...now, ...food].every(s => s >= 0.6 && s <= 1));
  assert.ok(new Set(landings).size >= 2, 'not the same kind of landing 20 times');
  let longest = 1, run = 1;
  for (let i = 1; i < landings.length; i++) { run = landings[i] === landings[i - 1] ? run + 1 : 1; longest = Math.max(longest, run); }
  assert.ok(longest <= 6, `the same landing ${longest} times in a row`);
  // Over many runs of 20: a long run of the same landing is rare (it lowers what she just did, never forbids it).
  let long = 0;
  for (let s = 0; s < 300; s++) {
    const random = seeded(1_000 + s), recent: TouchFeedLandingId[] = [];
    let best = 1, streak = 1;
    for (let i = 0; i < 20; i++) {
      const id = drawTouchFeed('touch', calm, recent, random).landing;
      streak = recent[0] === id ? streak + 1 : 1; best = Math.max(best, streak);
      recent.unshift(id); recent.splice(TOUCH_FEED_EFFECT_KNOBS.recent.length);
    }
    if (best > 5) long++;
  }
  assert.ok(long / 300 < 0.03, `${long} of 300 runs had the same landing six times in a row`);
});

test('tiring follows the card: four quick 5-second pats in the real model, clingy fades slower, distant faster, the first never above the old amount', () => {
  const sequences: Record<string, number[]> = {};
  for (const [name, close] of [['card', 1], ['clingy', 1.6], ['distant', 0.4]] as const) {
    const p = linearCard();
    const k = tireFactor(TOUCH_FEED_EFFECT_KNOBS.touch.tire, { ...plainPersonality, close }).factor;
    const effect = { scale: 1, ...tiredFreshness(p.freshness, k, TOUCH_FEED_EFFECT_KNOBS.touch.tire.minFloor) };
    let state = lowState(p, 0);
    const doses: number[] = [];
    for (let i = 0; i < 4; i++) {
      state = applyMoodEvent(state, { type: 'rua', id: `p${i}`, effectiveMs: 5_000 }, 1_000 + i * 1_000, withTouchFeedEffect(p, 'touch', effect));
      doses.push(Math.round(applied(state, `p${i}`).O * 100) / 100);
    }
    sequences[name] = doses;
  }
  if (report) for (const [name, doses] of Object.entries(sequences)) console.log(`${name}: ${doses.join(' ')}`);
  assert.deepEqual(sequences.card, [10, 6, 3.6, 2.16], 'the card itself: the old fixed sequence');
  for (const name of ['clingy', 'distant']) assert.equal(sequences[name][0], 10, `${name}: the first pat is the old amount`);
  for (let i = 1; i < 4; i++) {
    assert.ok(sequences.clingy[i] > sequences.card[i], `clingy dose ${i + 1}`);
    assert.ok(sequences.distant[i] < sequences.card[i], `distant dose ${i + 1}`);
  }
  assert.ok(sequences.distant[3] >= 0.5, 'tired out, still a little');
});

test('her mood and card lean it, and the why names only what is true', () => {
  const share = (kind: TouchFeedKind, now: TouchFeedNow, id: TouchFeedLandingId) => {
    const random = seeded(3);
    let n = 0;
    for (let i = 0; i < 400; i++) if (drawTouchFeed(kind, now, [], random).landing === id) n++;
    return n / 400;
  };
  assert.ok(share('touch', withPersonality({ close: 1.6 }, 'longing'), 'full') > 1.8 * share('touch', calm, 'full'), 'clingy and missing you: a pat lands');
  assert.ok(share('touch', withPersonality({}, 'upset'), 'light') > 2 * share('touch', calm, 'light'), 'upset: a pat lands lightly');
  assert.ok(share('food', withPersonality({ comfortable: 1.6 }, 'happy'), 'full') > 1.8 * share('food', calm, 'full'), 'easygoing and happy: she enjoys the snack');
  assert.ok(share('food', { ...calm, moments: ['sleepy'] }, 'light') > 1.4 * share('food', calm, 'light'), 'sleepy: not much appetite');
  const random = seeded(5);
  for (let i = 0; i < 300; i++) {
    const why = drawTouchFeed(i % 2 ? 'food' : 'touch', calm, [], random).why.join('；');
    for (const word of ['性格', '困了', '有点累', '不满', '想念', '黏着你']) assert.ok(!why.includes(word), `a plain calm card never says "${word}": ${why}`);
  }
  const director = new TouchFeedEffectDirector({ random: seeded(9) });
  director.effect('gene', event('touch', 'a', 2.3), card, () => withPersonality({ close: 1.6 }, 'longing'));
  const line = director.recent('gene')[0];
  assert.match(line.why.join('；'), /腻得慢（性格：黏人）/);
  // Two doses taken: 0.6 ^ 2 = 36 % on the card; she tires slower (retention 1 − 0.64 × 0.4 = 0.744), so this one still has 0.744 ^ 2 = 55 %.
  assert.match(line.why.join('；'), /新鲜感还剩 55%/);
  assert.equal(line.fresh.first, 55);
  director.effect('gene', event('touch', 'b', 0), card, () => calm);
  assert.ok(!director.recent('gene')[0].why.join('；').includes('新鲜感'), 'fresh: no freshness line');
});

test('one knob changes only what it governs', () => {
  const run = (knobs: TouchFeedEffectKnobs, kinds: readonly TouchFeedKind[] = ['touch', 'food']) => {
    const director = new TouchFeedEffectDirector({ random: seeded(11), knobs });
    const out: { kind: TouchFeedKind; landing: string; scale: number; retention: number; floor: number }[] = [];
    for (let i = 0; i < 60; i++) for (const kind of kinds) {
      const effect = director.effect('gene', event(kind, `${kind}-${i}`), card, () => withPersonality({ close: 1.4, comfortable: 0.7 }, MOODS[i % MOODS.length]));
      out.push({ kind, landing: director.recent('gene').find(row => row.kind === kind)!.landing, ...effect });
    }
    return out;
  };
  const base = run(TOUCH_FEED_EFFECT_KNOBS);
  const lighter = run({ ...TOUCH_FEED_EFFECT_KNOBS, touch: { ...TOUCH_FEED_EFFECT_KNOBS.touch, landings: { ...TOUCH_FEED_EFFECT_KNOBS.touch.landings,
    light: { ...TOUCH_FEED_EFFECT_KNOBS.touch.landings.light, range: [0.3, 0.4] } } } });
  let lightSeen = 0;
  base.forEach((row, i) => {
    const other = lighter[i];
    assert.equal(other.landing, row.landing);
    assert.equal(other.retention, row.retention); assert.equal(other.floor, row.floor);
    if (row.kind === 'touch' && row.landing === TOUCH_FEED_EFFECT_KNOBS.touch.landings.light.label) { lightSeen++; assert.ok(other.scale <= 0.4 && other.scale < row.scale); }
    else assert.equal(other.scale, row.scale, `${row.kind} ${row.landing}`);
  });
  assert.ok(lightSeen > 0);
  const slower = run({ ...TOUCH_FEED_EFFECT_KNOBS, food: { ...TOUCH_FEED_EFFECT_KNOBS.food, tire: { ...TOUCH_FEED_EFFECT_KNOBS.food.tire, strength: 0 } } });
  base.forEach((row, i) => {
    const other = slower[i];
    assert.equal(other.landing, row.landing); assert.equal(other.scale, row.scale);
    if (row.kind === 'touch') assert.deepEqual([other.retention, other.floor], [row.retention, row.floor]);
    else assert.deepEqual([other.retention, other.floor], [card.retention, card.floor], 'food tiring back to the card');
  });
  const neverFull = run({ ...TOUCH_FEED_EFFECT_KNOBS, touch: { ...TOUCH_FEED_EFFECT_KNOBS.touch, landings: { ...TOUCH_FEED_EFFECT_KNOBS.touch.landings,
    full: { ...TOUCH_FEED_EFFECT_KNOBS.touch.landings.full, base: 0 } } } }, ['touch']);
  assert.ok(neverFull.every(row => row.landing !== TOUCH_FEED_EFFECT_KNOBS.touch.landings.full.label));
});

for (const [name, make] of [['real', () => new TouchFeedEffectDirector({ random: seeded(4) })], ['fake', () => new FixedTouchFeedEffect()]] as const) {
  test(`contract (${name}): one effect per interaction, always safe, "此刻" read only when one begins, memory-only why`, () => {
    const host: TouchFeedEffectHost = make();
    let reads = 0;
    const now = () => { reads++; return withPersonality({ close: 1.3 }, 'happy'); };
    const first = host.effect('gene', event('touch', 'one', 0), card, now);
    const again = host.effect('gene', event('touch', 'one', 0.5), card, now);
    assert.equal(again.scale, first.scale);
    assert.ok(reads <= 1, 'read once at most');
    for (const effect of [first, again]) assert.ok(touchFeedEffectSafe(card, effect));
    const food = host.effect('gene', event('food', 'snack', 0), card, now);
    assert.ok(touchFeedEffectSafe(card, food));
    host.effect('gene', event('touch', 'two', 1), card, now);
    const random = seeded(2);
    for (let i = 0; i < 200; i++) {
      const f = { ...card, retention: random(), floor: random() };
      assert.ok(touchFeedEffectSafe(f, host.effect('gene', event(i % 2 ? 'food' : 'touch', `x${i}`, random() * 8), f, now)));
    }
    const rows = host.recent('gene');
    assert.ok(rows.length >= 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows, 'plain data');
    (rows[0].why as string[]).push('changed');
    assert.ok(!host.recent('gene')[0].why.includes('changed'), 'a copy');
    assert.deepEqual(host.recent('someone-else'), []);
    const nobody = host.effect('', event('touch', 'z'), card, now);
    assert.ok(touchFeedEffectSafe(card, nobody));
    // The card's own freshness parameters stay as they were.
    assert.deepEqual(card, DEFAULT_MOOD_PARAMETERS.freshness);
  });
}

test('"此刻" comes from the snapshot, the card and her tiredness only', () => {
  const now = touchFeedNow({ snapshot: { primary: 'longing', companion: 'close' }, personality: { close: 9, playful: -1 }, fatiguePhase: 'drowsy' });
  assert.deepEqual(now, { mood: 'longing', tendency: 'close', personality: { playful: 0, close: 4, comfortable: 1, cautious: 1 }, moments: ['sleepy'] });
  assert.deepEqual(touchFeedNow({ snapshot: { primary: 'nope' as MoodLabel, companion: null }, personality: null, fatiguePhase: 'light-drowsy' }).moments, ['tired']);
  // A tendency that is only a hair above nothing (her values drifting back to the baseline) is not "这会儿想黏着你".
  assert.equal(touchFeedNow({ snapshot: { primary: 'calm', companion: 'close', tendencies: { playful: 0, close: 1e-11, comfortable: 0, cautious: 0 } }, personality: null, fatiguePhase: null }).tendency, null);
  assert.equal(touchFeedNow({ snapshot: { primary: 'close', companion: 'close', tendencies: { playful: 0, close: 1.2, comfortable: 0, cautious: 0 } }, personality: null, fatiguePhase: null }).tendency, 'close');
  for (const id of TOUCH_FEED_LANDING_IDS) for (const kind of ['touch', 'food'] as const) {
    const [low, high] = TOUCH_FEED_EFFECT_KNOBS[kind].landings[id].range;
    assert.ok(low <= high && high <= 1 && low >= 0, `${kind}.${id} range stays within the old amount`);
  }
});
