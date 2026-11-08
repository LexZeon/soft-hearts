/**
 * I-013 L1: the inner loop's call rhythm (shared/behaviors/inner-rhythm/, docs/claude/2026-11-07-inner-loop-rhythm.md).
 * The user's real usage: 36 of 49 intervals were exactly 12.0 minutes, and 35 small-model calls in 8 hours of sleep.
 * Real MoodHost + InnerLoop + gate on a simulated clock; the model is a fake. No Claude call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInnerLoopDay, type DayDecide, type DayResult } from '../scripts/lib/inner-loop-day';
import { GENE_DAY_CARD, SLOW_TIRED_CARD } from '../scripts/inner-loop-day-cards';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { OpeningChoiceDirector } from '../shared/behaviors/opening-choice/choose';
import { innerRhythmDraw, innerRhythmStretch } from '../shared/behaviors/inner-rhythm/choose';
import { INNER_RHYTHM_KNOBS } from '../shared/behaviors/inner-rhythm/knobs';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { InnerLoop, type InnerLoopDependencies } from '../electron/inner-loop/inner-loop';
import { DEFAULT_MOOD_PARAMETERS, type MoodCue } from '../shared/mood';
import type { InnerLoopQuiet } from '../shared/inner-loop';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000;
const none: DayDecide = async () => ({ text: '{"action":"none"}' });
const midnight = new Date('2026-11-03T00:00:00').getTime();
const BASE_MINUTES = 10; // Gene: 2 x the 5-minute motion interval
const daytime = [{ startMinute: 9 * 60, idleMinutes: 120 }, { startMinute: 13 * 60, idleMinutes: 150 }, { startMinute: 19 * 60, idleMinutes: 150 }];
const sleep = [{ startMinute: 23 * 60, idleMinutes: 480 }];

const run = (blocks: typeof daytime, seed: number, rhythm: boolean, card = GENE_DAY_CARD, userAway?: (wall: number) => boolean) =>
  runInnerLoopDay({ card, blocks, decide: none, midnight,
    boredomTiming: new BoredomTimingDirector({ random: seeded(seed) }),
    // The app's opening choice decides who takes a speech cue (electron/inner-loop/opening-host.ts), as in the real usage.
    opening: { chooser: new OpeningChoiceDirector({ random: seeded(seed * 31 + 5) }) },
    ...(rhythm ? { rhythm: { random: seeded(seed + 100), ...(userAway ? { userAway } : {}) } } : {}) });
const calledAt = (r: DayResult) => r.diagnostics.filter(d => d.called);
const gaps = (r: DayResult) => { const at = calledAt(r).map(d => d.at); return at.slice(1).map((t, i) => (t - at[i]) / MINUTE); };
const sameAsBase = (g: readonly number[]) => g.filter(x => Math.abs(x - BASE_MINUTES) < 0.5).length;

test('a day: the gaps between her thoughts are no longer mostly the same number, and she asks no more than before', async () => {
  for (const seed of [1, 2, 3, 4]) {
    const before = await run(daytime, seed, false), after = await run(daytime, seed, true);
    const old = gaps(before), now = gaps(after);
    assert.ok(sameAsBase(old) > old.length * 0.5, `seed ${seed}: the old rhythm is the fixed ${BASE_MINUTES} minutes (${sameAsBase(old)}/${old.length})`);
    assert.ok(sameAsBase(now) < now.length / 3, `seed ${seed}: ${sameAsBase(now)} of ${now.length} gaps are still the base ${BASE_MINUTES} min: ${now.map(x => x.toFixed(1)).join(',')}`);
    assert.ok(new Set(now.map(x => Math.round(x / 2.5))).size >= 4, `seed ${seed}: many different gaps`);
    assert.ok(after.calls <= before.calls, `seed ${seed}: ${after.calls} calls vs ${before.calls}`);
    // Never earlier than today's minimum spacing: a motion call comes at least 2 x the motion interval after the call before it.
    const calls = calledAt(after);
    for (const [i, call] of calls.entries()) if (i > 0 && call.cue === 'motion') assert.ok((call.at - calls[i - 1].at) / MINUTE >= BASE_MINUTES - 0.01, `seed ${seed}: call ${i}`);
  }
});

test('eight hours of sleep: a handful of calls instead of dozens, and fewer still when the system says he is away', async () => {
  // Bound: night x3 and, after 45 min of no contact, away x1..3 on a 10-minute base is never under 30-90 minutes between calls, so about 6 in 8 hours;
  // 8 leaves room for the random draws without letting the old 35-45 back in.
  for (const card of [GENE_DAY_CARD, SLOW_TIRED_CARD]) for (const seed of [1, 2, 3]) {
    const before = await run(sleep, seed, false, card), after = await run(sleep, seed, true, card);
    // I-043 (2026-11-07): the clock sets how fast she tires, so the easily tired card is asleep for most of this night and even the old
    // rhythm calls little (7 here, not dozens). Gene still shows the dozens; for the tired card the new rhythm only has to call less.
    if (card === GENE_DAY_CARD) assert.ok(before.calls >= 15, `${card.id} seed ${seed}: the old rhythm made ${before.calls} calls`);
    else assert.ok(after.calls < before.calls, `${card.id} seed ${seed}: ${after.calls} calls vs the old ${before.calls}`);
    assert.ok(after.calls <= 8, `${card.id} seed ${seed}: ${after.calls} calls in 8 hours of sleep`);
    const locked = await run(sleep, seed, true, card, () => true);
    assert.ok(locked.calls <= after.calls, `${card.id} seed ${seed}: away reading ${locked.calls} vs ${after.calls}`);
  }
  // The first night call is not allowed to be a fixed number either.
  const spacing = new Set<number>();
  for (const seed of [1, 2, 3, 4]) for (const g of gaps(await run(sleep, seed, true))) spacing.add(Math.round(g));
  assert.ok(spacing.size >= 5, `varied night gaps: ${[...spacing].join(',')}`);
});

test('the same seed gives the same day', async () => {
  const a = await run(daytime, 7, true), b = await run(daytime, 7, true), c = await run(daytime, 8, true);
  assert.deepEqual(a.diagnostics.map(d => [d.at, d.cue, d.called]), b.diagnostics.map(d => [d.at, d.cue, d.called]));
  assert.notDeepEqual(a.diagnostics.map(d => d.at), c.diagnostics.map(d => d.at));
});

test('the draw: always at least 1, shaped by the card, not the same twice in a row; no spread means no randomness', () => {
  const random = seeded(3);
  let previous: number | null = null; const values: number[] = [];
  for (let i = 0; i < 200; i++) { const v = innerRhythmDraw(random, 1, previous); assert.ok(v >= 1 && v <= 1 + INNER_RHYTHM_KNOBS.spread * INNER_RHYTHM_KNOBS.spreadByPlayful[1]); values.push(v); previous = v; }
  assert.ok(new Set(values.map(v => v.toFixed(2))).size > 40);
  const mean = (playful: number) => { const r = seeded(9); let sum = 0; for (let i = 0; i < 500; i++) sum += innerRhythmDraw(r, playful, null); return sum / 500; };
  assert.ok(mean(1.6) < mean(1) && mean(1) < mean(0.5), 'a playful card is quicker than a quiet one');
  const flat = { ...INNER_RHYTHM_KNOBS, spread: 0 };
  assert.deepEqual([1, 2, 3].map(() => innerRhythmDraw(Math.random, 1, null, flat)), [1, 1, 1]);
  const odd = innerRhythmDraw(() => Number.NaN, Number.NaN, Number.NaN);
  assert.ok(Number.isFinite(odd) && odd >= 1, 'bad inputs still give a usable multiplier');
});

test('the stretch: nothing by day with the user near, night and long absence multiply, never below 1', () => {
  const day = { night: false, drowsy: false, awayMinutes: 10, userAway: false };
  assert.equal(innerRhythmStretch(day), 1);
  assert.equal(innerRhythmStretch({ ...day, awayMinutes: null }), 1);
  assert.equal(innerRhythmStretch({ ...day, drowsy: true }), INNER_RHYTHM_KNOBS.drowsy);
  assert.equal(innerRhythmStretch({ ...day, night: true }), INNER_RHYTHM_KNOBS.night);
  assert.equal(innerRhythmStretch({ ...day, awayMinutes: 100000 }), INNER_RHYTHM_KNOBS.awayMax);
  assert.equal(innerRhythmStretch({ ...day, userAway: true }), INNER_RHYTHM_KNOBS.awayState);
  assert.equal(innerRhythmStretch({ ...day, night: true, userAway: true, awayMinutes: 100000 }), INNER_RHYTHM_KNOBS.night * INNER_RHYTHM_KNOBS.awayMax);
  const mid = innerRhythmStretch({ ...day, awayMinutes: INNER_RHYTHM_KNOBS.awayFromMinutes + INNER_RHYTHM_KNOBS.awayRampMinutes / 2 });
  assert.ok(mid > 1 && mid < INNER_RHYTHM_KNOBS.awayMax, 'grows with the absence');
  assert.equal(innerRhythmStretch({ ...day, awayMinutes: -5, night: false }), 1);
});

// Engine level: the deep-night rest reminder (an existing one-time behavior) is not held back by the stretch.
function engine(rhythm: InnerLoopDependencies['rhythm'], quiet: InnerLoopQuiet, reminder = true) {
  const state = { now: 10_000_000, used: false };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  const prompts: boolean[] = []; let decides = 0;
  const loop = new InnerLoop({
    gate, clock: () => state.now, enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => quiet,
    prompt: (_c, allowSpeech) => { prompts.push(allowSpeech); return 'prompt'; },
    decide: async () => { decides++; return { text: '{"action":"none"}' }; },
    realize: () => {}, releaseSpeech: () => {}, offer: () => {}, present: async () => true, presentationCurrent: () => true, archive: async () => {},
    ...(rhythm ? { rhythm } : {}),
    ...(reminder ? { restReminder: { lastInteractionAt: () => state.now - 5 * MINUTE, nightKey: () => 'night-1', used: () => state.used, remember: () => { state.used = true; } } } : {}),
  });
  const cue = (kind: 'motion' | 'speech', id: string): MoodCue => ({ id, kind, at: state.now, until: state.now + 3_000 });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { loop, state, cue, prompts, decides: () => decides, flush, dispose: () => { loop.dispose(); gate.dispose(); } };
}
const nightQuiet: InnerLoopQuiet = { asleep: false, drowsy: false, night: true, quiet: true };
const heavy = { random: () => 0.99, awayMinutes: () => 600, userAway: () => true };

test('the rest reminder still gets its call in deep night, however long the stretch', async () => {
  const h = engine(heavy, nightQuiet);
  // A motion call a minute ago: the stretched spacing would hold a plain speech cue back...
  assert.equal(h.loop.offerOpportunity(h.cue('motion', 'm1')), true); await h.flush();
  h.state.now += MINUTE;
  assert.equal(h.loop.restReminderDue(), true);
  assert.equal(h.loop.offerOpportunity(h.cue('speech', 's1'), 'rest'), true, 'the reminder is taken');
  await h.flush();
  assert.equal(h.prompts.at(-1), true, 'and she may speak on it');
  h.dispose();
  // ...and with no reminder left (already used tonight) the same quiet speech cue is held back, not asked.
  const used = engine(heavy, nightQuiet); used.state.used = true;
  assert.equal(used.loop.offerOpportunity(used.cue('motion', 'm1')), true); await used.flush();
  used.state.now += MINUTE;
  assert.equal(used.loop.offerOpportunity(used.cue('speech', 's1'), 'mood'), false);
  await used.flush(); assert.equal(used.decides(), 1);
  used.dispose();
});

test('with the user near (no night, no absence) the random draw alone makes her thoughts uneven', async () => {
  // The engine alone: a motion cue every minute for 12 hours by day, the user always just there.
  const space = 2 * DEFAULT_MOOD_PARAMETERS.frequency.motionIntervalMs / MINUTE;
  const calls = async (rhythm: InnerLoopDependencies['rhythm']) => {
    const h = engine(rhythm, { asleep: false, drowsy: false, night: false, quiet: false }, false), at: number[] = [];
    for (let i = 0; i < 12 * 60; i++) {
      h.state.now += MINUTE;
      if (h.loop.offerOpportunity(h.cue('motion', `m${i}`))) { at.push(h.state.now); await h.flush(); }
    }
    h.dispose();
    return at.slice(1).map((t, i) => (t - at[i]) / MINUTE);
  };
  const old = await calls(undefined), now = await calls({ random: seeded(5), awayMinutes: () => 0, userAway: () => false });
  assert.ok(old.length > 30 && old.every(g => g === space), `old: ${old.length} calls, every gap the fixed ${space}`);
  assert.ok(now.length >= 15 && now.length < old.length, `${now.length} calls vs ${old.length}`);
  assert.ok(now.filter(g => g === space).length < now.length / 3, `gaps: ${now.join(',')}`);
  assert.ok(now.every(g => g >= space), 'never earlier than the old spacing');
  assert.ok(new Set(now).size >= 5, 'several different gaps');
});

test('without the rhythm the spacing is exactly the old one; with it, never shorter', async () => {
  const space = 2 * DEFAULT_MOOD_PARAMETERS.frequency.motionIntervalMs;
  const old = engine(undefined, { asleep: false, drowsy: false, night: false, quiet: false }, false);
  assert.equal(old.loop.offerOpportunity(old.cue('motion', 'a')), true); await old.flush();
  old.state.now += space - 1; assert.equal(old.loop.offerOpportunity(old.cue('motion', 'b')), false);
  old.state.now += 1; assert.equal(old.loop.offerOpportunity(old.cue('motion', 'c')), true);
  old.dispose();
  for (const draw of [0, 0.5, 0.99]) {
    const h = engine({ random: () => draw, awayMinutes: () => 0, userAway: () => false }, { asleep: false, drowsy: false, night: false, quiet: false }, false);
    assert.equal(h.loop.offerOpportunity(h.cue('motion', 'a')), true); await h.flush();
    h.state.now += space - 1; assert.equal(h.loop.offerOpportunity(h.cue('motion', 'b')), false, `draw ${draw}`);
    h.dispose();
  }
});
