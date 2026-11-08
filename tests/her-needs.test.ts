/**
 * 她也会需要你 (L4): the pure rules in shared/her-needs.ts. docs/claude/2026-11-03-she-needs-you.md; the loop it belongs to is
 * docs/claude/2026-11-03-mood-loop-design.md (everything starts from character and mood and returns to them).
 *
 * What is pinned: each kind wants to begin under its own conditions (a WANT from mood and character, 0..1); how often is a soft
 * pressure (one replaceable function) that a strong want can climb over, except the reluctance about a kind nobody answered; the few
 * hard rules are about not chasing; a need only gets weaker; an unanswered one leaves 低落 that piles up (capped) and turns into 释然
 * the moment the user does anything; soothing works, also for a kind she was reluctant about; and the words she is given are small
 * 撒娇 inside the user's "big line" (never a punishment, a pile-on, an old account, or a reason to be afraid to leave).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BIG_LINE_WORDS, HER_NEED_DEJECTION, HER_NEED_GLOW, HER_NEED_IDS, HER_NEED_LIMIT_DEFAULTS, HER_NEED_LOW, HER_NEED_OVERRIDE_FROM, HER_NEED_SPEAK_MIN_STRENGTH,
  HER_NEED_TABLE, HER_NEED_TOUCH_MS_PER_INTERACTION, WELCOME_BACK_LINE, createHerNeedState, formatHerNeedLine, herNeedChatLine, herNeedDip, herNeedGlowStrength,
  herNeedLimitInput, herNeedLimits, herNeedPressure, herNeedRelief, herNeedSensitivity, herNeedSpeechLine, herNeedStartRate, herNeedStrength, herNeedTotalMs,
  herNeedTriggers, herNeedView, herNeedWakeChance, noteHerNeedInteraction, readHerNeedSaved, restoreHerNeedState, scaledHerNeedPresentation, serializeHerNeedState,
  stepHerNeed, takeHerNeedChatLine, takeHerNeedSpeech, welcomeBackLine,
  type HerNeedId, type HerNeedLimitFn, type HerNeedLimitInput, type HerNeedSignals, type HerNeedState, type HerNeedStepInput,
} from '../shared/her-needs';
import { HER_LIFE_NEUTRAL_PRESENTATION } from '../shared/her-life';

const SECOND = 1_000, MIN = 60_000, HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 3, 6, 0, 0);
const DAY = '2026-11-03';
const flat = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const always = () => 0;
const noon = START + 6 * HOUR;
/** A small seeded generator with good low bits (a plain LCG correlates between nearby draws, which matters for rates this small). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function signals(over: Partial<HerNeedSignals> = {}): HerNeedSignals {
  return { now: noon, localMinute: 15 * 60, night: false, fatiguePhase: 'awake', fatigueF: 0.45, boredom: 80, longing: 0, ignoredMs: 90 * MIN, mood: 'calm',
    channels: { ...flat }, baseline: { ...flat }, weights: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, wake: null, ...over };
}
function input(now: number, over: Partial<HerNeedStepInput> = {}, sig: Partial<HerNeedSignals> = {}): HerNeedStepInput {
  return { now, day: DAY, expressions: true, idle: true, startedAt: START, signals: signals({ now, ...sig }), ...over };
}
/** Steps once a second from `from` for `seconds`, with the same conditions. */
function run(state: HerNeedState, from: number, seconds: number, random: () => number, over: Partial<HerNeedStepInput> = {}, sig: Partial<HerNeedSignals> = {}) {
  let current = state;
  const events: string[] = [];
  for (let i = 0; i <= seconds; i++) {
    const result = stepHerNeed(current, input(from + i * SECOND, over, sig), random);
    current = result.state;
    for (const event of result.events) events.push(`${event.type}:${event.id}`);
  }
  return { state: current, events };
}
/** How pressed down a kind is for this state at this moment (the default limit function). */
function verdictFor(state: HerNeedState, id: HerNeedId, now = noon, over: Partial<{ night: boolean; startedAt: number }> = {}) {
  return herNeedLimits(herNeedLimitInput(state, { now, startedAt: over.startedAt ?? START, night: over.night ?? false, balance: null }), id);
}
/** A state with lonely begun and left unanswered `agoMs` before `now`, and `interactions` counted since. */
function snubbedLonely(now: number, agoMs: number, interactions = 0): HerNeedState {
  const at = now - agoMs;
  return { ...createHerNeedState(DAY), snubs: { lonely: { at, interactions: 10 } }, interactions: 10 + interactions, used: ['lonely'], lastStartAt: at - 20 * MIN,
    lastStartInteractions: 10, kindStartInteractions: { lonely: 10 }, dejection: 0.35, lowKind: 'lonely' };
}

// ---------------------------------------------------------------- the default wants: each kind, and what it is not

test('wants: each need wants to begin under its own conditions (0..1) and not under any one counter-example', () => {
  const on = (over: Partial<HerNeedSignals>) => herNeedTriggers(signals(over));
  // 有点闷
  assert.ok((on({}).lonely ?? 0) > 0, 'ignored 40+ min, bored, closeness at its baseline');
  for (const [name, over] of Object.entries({
    'not ignored long enough': { ignoredMs: 39 * MIN }, 'not bored enough': { boredom: 59 }, 'closeness still warm': { channels: { ...flat, O: 55 } },
    'worried': { mood: 'concerned' }, 'missing the user': { mood: 'longing' }, 'sad': { mood: 'sad' }, 'she is missing the user (days away)': { longing: 40 },
  } as Record<string, Partial<HerNeedSignals>>)) assert.ok(!on(over).lonely, `lonely must not want: ${name}`);
  assert.ok((on({ channels: { ...flat, O: 54 } }).lonely ?? 0) > 0, 'warmth +4 is still "at the baseline"');
  assert.ok(on({ boredom: 95 }).lonely! > on({ boredom: 65 }).lonely!, 'the more bored, the more she wants it');
  assert.ok(on({ channels: { ...flat, O: 44 } }).lonely! > on({}).lonely!, 'and the colder (closeness under its baseline), the more');
  assert.ok(on({ weights: { close: 1.6 } }).lonely! > on({ weights: { close: 0.5 } }).lonely!, 'a close-leaning card wants it more');
  // 无聊得想找人说话
  assert.ok((on({}).chatty ?? 0) > 0);
  for (const [name, over] of Object.entries({
    'not bored enough': { boredom: 74 }, 'worried': { mood: 'concerned' }, 'not ignored': { ignoredMs: 10 * MIN }, 'upset': { mood: 'upset' }, 'days away': { longing: 12 },
  } as Record<string, Partial<HerNeedSignals>>)) assert.ok(!on(over).chatty, `chatty must not want: ${name}`);
  assert.ok(on({ weights: { playful: 1.6 } }).chatty! > on({ weights: { playful: 0.5 } }).chatty!);
  assert.ok(on({ channels: { ...flat, D: 62, E: 60 } }).chatty! > on({}).chatty!, 'a livelier her wants to talk more');
  // 做了个不开心的梦
  const wake = (sleptMs: number, agoMs = MIN) => ({ at: noon - agoMs, sleptMs });
  assert.ok(on({ wake: wake(11 * MIN) }).dream! > 0);
  for (const [name, over] of Object.entries({
    'a nap': { wake: wake(9 * MIN) }, 'long ago': { wake: wake(2 * HOUR, 4 * MIN) }, 'no waking': { wake: null },
  } as Record<string, Partial<HerNeedSignals>>)) assert.ok(!on(over).dream, `dream must not want: ${name}`);
  assert.ok(on({ wake: wake(8 * HOUR) }).dream! > on({ wake: wake(20 * MIN) }).dream!, 'a long sleep dreams more');
  // 今天有点没精神
  assert.ok((on({ fatiguePhase: 'light-drowsy' }).lowEnergy ?? 0) >= 0.4);
  for (const [name, over] of Object.entries({
    awake: { fatiguePhase: 'awake' }, 'drowsy is her own 犯困': { fatiguePhase: 'drowsy' }, 'before 11:00': { fatiguePhase: 'light-drowsy', localMinute: 10 * 60 + 59 },
    'from 22:00': { fatiguePhase: 'light-drowsy', localMinute: 22 * 60 },
  } as Record<string, Partial<HerNeedSignals>>)) assert.ok(!on(over).lowEnergy, `lowEnergy must not want: ${name}`);
  assert.ok(on({ fatiguePhase: 'light-drowsy', fatigueF: 0.56 }).lowEnergy! > on({ fatiguePhase: 'light-drowsy', fatigueF: 0.39 }).lowEnergy!, 'the nearer to drowsy, the more');
  for (const value of Object.values(on({ fatiguePhase: 'light-drowsy', boredom: 100, wake: wake(9 * HOUR), channels: { ...flat, O: 40, D: 70, E: 70 }, weights: { close: 2, playful: 2, cautious: 2 } })))
    assert.ok(value! >= 0 && value! <= 1, 'a want is always 0..1');
});

test('wants: the raw mood channels are in the signals, and the whole function can be swapped (T-106)', () => {
  const seen: HerNeedSignals[] = [];
  const swapped = (s: HerNeedSignals) => { seen.push(s); return { chatty: 1 }; };
  const result = run(createHerNeedState(DAY), noon, 600, always, { trigger: swapped });
  assert.ok(result.events.includes('started:chatty'), 'the swapped function decides');
  assert.deepEqual(Object.keys(seen[0].channels).sort(), ['C', 'D', 'E', 'N', 'O']);
  assert.deepEqual(Object.keys(seen[0].baseline).sort(), ['C', 'D', 'E', 'N', 'O']);
});

// ---------------------------------------------------------------- starting: the hard gates

test('start: given the wants and a lucky roll she starts one, and the first tick never does (no elapsed time yet)', () => {
  const first = stepHerNeed(createHerNeedState(DAY), input(noon), always);
  assert.equal(first.state.active, null);
  const result = run(createHerNeedState(DAY), noon, 5, always);
  assert.equal(result.state.active?.id, 'lonely', 'lonely has the higher rate among the two that want it');
  assert.deepEqual(result.state.used, ['lonely']);
  assert.equal(result.state.lastStartAt !== null, true);
  assert.equal(result.state.lastStartInteractions, 0);
});

test('start: the rate is low (a bad roll never starts anything)', () => {
  const result = run(createHerNeedState(DAY), noon, 3_600, () => 0.9999);
  assert.equal(result.state.active, null);
  assert.deepEqual(result.events, []);
});

test('hard gates: 自动表现 off, someone touching or chatting, one at a time, and a need that faded unanswered: each alone stops a start', () => {
  const base = createHerNeedState(DAY);
  const blocked = (state: HerNeedState, over: Partial<HerNeedStepInput> = {}, sig: Partial<HerNeedSignals> = {}) => run(state, noon, 5, always, over, sig).state.active === null;
  assert.ok(!blocked(base), 'the control starts');
  assert.ok(blocked(base, { expressions: false }), '自动表现 off');
  assert.ok(blocked(base, { idle: false }), 'someone is touching or chatting with her');
  assert.ok(blocked({ ...base, armed: false }), 'the last one faded unanswered: nothing until the user has interacted');
  assert.ok(blocked({ ...base, glow: { id: 'chatty', since: noon, via: 'chat', told: false } }), 'the glow after being soothed');
  for (const fatiguePhase of ['falling-asleep', 'asleep', 'micro-awake'] as const) assert.ok(blocked(base, {}, { fatiguePhase }), `${fatiguePhase}`);
  // Drowsy is her own 犯困: no small need while she is drowsy (a bad dream on waking aside).
  assert.ok(blocked(base, {}, { fatiguePhase: 'drowsy' }));
});

// ---------------------------------------------------------------- how often: soft, from her mood, climbed over by a strong want

test('the limit function: smooth pressure from what already happened, never an N-a-day cut; nothing happened means no pressure', () => {
  const fresh = createHerNeedState(DAY), c = HER_NEED_LIMIT_DEFAULTS;
  const long = START - 10 * HOUR;
  assert.deepEqual(verdictFor(fresh, 'lonely', noon, { startedAt: long }), { soft: 1, reluctance: 1 });
  // How many began today: one is nearly free, a second still likely, then it falls away fast but smoothly (no step anywhere).
  const soft = (n: number) => verdictFor({ ...fresh, used: Array.from({ length: n }, (_, i) => HER_NEED_IDS[i % 4]) }, 'chatty', noon, { startedAt: long }).soft;
  const curve = [0, 1, 2, 3, 4, 5].map(soft);
  assert.ok(curve[1] > 0.75 && curve[1] < 0.9 && curve[2] > 0.04 && curve[2] < 0.12 && curve[3] < 0.02 && curve[5] < 0.002, `about two a day: ${curve.map(v => v.toFixed(2))}`);
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i] < curve[i - 1] && curve[i] > 0, 'strictly smaller, never zero: no hard cut');
  assert.equal(c.perDay, 1.3);
  // The same kind again: much less likely the same day, and by interactions since it last began.
  const sameKind = (extra: Partial<HerNeedState>) => verdictFor({ ...fresh, ...extra }, 'lonely', noon, { startedAt: long }).soft;
  const began = { lastStartAt: noon - 5 * HOUR, lastStartInteractions: 0 };
  const byInteractions = [0, 2, 4, 8, 16].map(n => sameKind({ ...began, interactions: n, kindStartInteractions: { lonely: 0 } }));
  for (let i = 1; i < byInteractions.length; i++) assert.ok(byInteractions[i] >= byInteractions[i - 1], 'more interactions since, less pressure');
  assert.ok(byInteractions[0] < 0.25 && byInteractions[4] > 0.95, `${byInteractions.map(v => v.toFixed(2))}`);
  assert.ok(sameKind({ ...began, used: ['lonely'], interactions: 16, kindStartInteractions: { lonely: 0 } }) < 0.2, 'the same kind twice in a day is much less likely whatever happened');
  // Any two starts: the user's interactions count most; time is a weaker second way.
  const gap = (interactions: number, hoursAgo: number) => sameKind({ lastStartAt: noon - hoursAgo * HOUR, lastStartInteractions: 0, interactions });
  assert.ok(gap(0, 0.2) < 0.1 && gap(4, 0.2) > 0.9, 'four interactions open the gap at once');
  assert.ok(gap(0, 6) > 0.45 && gap(0, 6) < 0.55, 'a long quiet stretch opens it halfway by time alone');
  assert.ok(gap(2, 0.2) > gap(0, 0.2) && gap(3, 0.2) > gap(2, 0.2));
  // The run just began: a ramp, not a wall. The night is quieter (the dream aside).
  assert.equal(verdictFor(fresh, 'lonely', START, { startedAt: START }).soft, 0);
  assert.ok(Math.abs(verdictFor(fresh, 'lonely', START + 7.5 * MIN, { startedAt: START }).soft - 0.5) < 1e-9);
  assert.equal(verdictFor(fresh, 'lonely', noon, { startedAt: long }).soft, 1);
  assert.ok(Math.abs(verdictFor(fresh, 'lonely', noon, { startedAt: long, night: true }).soft - c.night) < 1e-12);
  assert.equal(verdictFor(fresh, 'dream', noon, { startedAt: long, night: true }).soft, 1);
  // 低落 makes her quieter.
  assert.ok(Math.abs(verdictFor({ ...fresh, dejection: 1 }, 'lonely', noon, { startedAt: long }).soft - (1 - c.dejectionQuiet)) < 1e-12);
});

test('a strong want climbs over the soft pressure, a weak one does not; the rate follows the want; and the whole function is swappable (the interaction balance)', () => {
  const pressed = { soft: 0.1, reluctance: 1 };
  assert.equal(herNeedPressure(0.5, pressed), 0.1);
  assert.equal(herNeedPressure(HER_NEED_OVERRIDE_FROM, pressed), 0.1, 'below the line nothing changes');
  assert.ok(herNeedPressure(0.95, pressed) > 0.1 && herNeedPressure(0.95, pressed) < 1);
  assert.equal(herNeedPressure(1, pressed), 1, 'a feeling this strong ignores the soft pressure');
  for (let want = 0.1; want < 1; want += 0.1) assert.ok(herNeedPressure(want + 0.1, pressed) >= herNeedPressure(want, pressed), 'the stronger, the higher');
  // The rate follows the want (a want of 0.5 runs at the table's own rate) and the pressure.
  const free = { soft: 1, reluctance: 1 };
  assert.ok(Math.abs(herNeedStartRate('lonely', 0.5, free) - 1 / 120) < 1e-12);
  assert.ok(herNeedStartRate('lonely', 0.8, free) > herNeedStartRate('lonely', 0.4, free));
  assert.ok(herNeedStartRate('lonely', 0.5, pressed) < herNeedStartRate('lonely', 0.5, free) * 0.11);
  assert.equal(herNeedStartRate('dream', 0.9, free), 0, 'a bad dream begins on waking, not by rate');
  const chance = (HER_NEED_TABLE.dream.onset as { chanceOnWake: number }).chanceOnWake;
  assert.ok(Math.abs(herNeedWakeChance(0.5, free) - chance) < 1e-12);
  // Swappable: the step takes any limit function; the input carries the interaction counts, the day's starts, the kinds left unanswered and a balance slot.
  const seen: HerNeedLimitInput[] = [];
  const closed: HerNeedLimitFn = limitInput => { seen.push(limitInput); return { soft: 0, reluctance: 1 }; };
  const open: HerNeedLimitFn = () => ({ soft: 1, reluctance: 1 });
  const state = { ...createHerNeedState(DAY), interactions: 7, interactionsToday: 3, used: ['dream' as const] };
  assert.equal(run(state, noon, 600, always, { limits: closed, balance: 4.5 }, { boredom: 70 }).state.active, null, 'a swapped function that closes the door closes it (the want is under the line)');
  assert.ok(seen.length > 0);
  const last = seen.at(-1)!;
  assert.equal(last.interactionsToday, 3); assert.deepEqual(last.startsToday, ['dream']); assert.equal(last.balance, 4.5);
  assert.deepEqual(Object.keys(last).sort(), ['balance', 'dejection', 'interactionsSinceKind', 'interactionsSinceLastStart', 'interactionsToday', 'lastStartAt', 'night', 'now', 'runMs', 'snubbed', 'startsToday']);
  assert.ok(run(state, noon, 5, always, { limits: open }).state.active, 'and one that opens it opens it');
});

test('night: quieter by pressure (a replacement trigger that forgot the night is still pressed), and a bad dream on waking has no pressure for it', () => {
  const night = { night: true, localMinute: 2 * 60 };
  // The step's own pressure: a lucky roll that would pass in the day (rate) is far less likely at night.
  const day = herNeedStartRate('lonely', 0.5, verdictFor(createHerNeedState(DAY), 'lonely', noon, { startedAt: START - 10 * HOUR }));
  const dark = herNeedStartRate('lonely', 0.5, verdictFor(createHerNeedState(DAY), 'lonely', noon, { startedAt: START - 10 * HOUR, night: true }));
  assert.ok(Math.abs(dark / day - HER_NEED_LIMIT_DEFAULTS.night) < 1e-9);
  // A roll that is lucky enough for the daytime rate but not the night's: nothing starts at night.
  const odds = 0.5 * (1 - Math.exp(-day / 60));
  assert.ok(run(createHerNeedState(DAY), noon, 5, () => odds, { startedAt: START - 10 * HOUR }, { night: false }).state.active, 'by day it starts');
  assert.equal(run(createHerNeedState(DAY), noon, 5, () => odds, { startedAt: START - 10 * HOUR }, night).state.active, null, 'at night the same roll does not');
  // The dream: awake at three in the morning with a bad dream (a look only).
  const wake = { at: noon, sleptMs: 3 * HOUR };
  let state = stepHerNeed(createHerNeedState(DAY), input(noon - SECOND, {}, { ...night, wake: null }), always).state;
  assert.equal(run(state, noon, 5, always, {}, { ...night, wake }).state.active?.id, 'dream');
});

// ---------------------------------------------------------------- the bad dream

test('dream: one roll per waking at the stated chance; it starts when she is free within three minutes; drowsy from waking is fine', () => {
  const wake = { at: noon, sleptMs: 2 * HOUR };
  const base = createHerNeedState(DAY);
  // Unlucky roll: no dream, and the same waking is never rolled again (a second try with luck does not help).
  let state = stepHerNeed(base, input(noon, {}, { wake, fatiguePhase: 'awake' }), () => 0.99).state;
  assert.equal(state.dreamUntil, null);
  assert.equal(state.wokeRolled, noon);
  state = run(state, noon + SECOND, 120, always, { idle: true }, { wake, fatiguePhase: 'awake', boredom: 0, ignoredMs: 0 }).state;
  assert.equal(state.active, null, 'the roll was spent');
  // Lucky roll while she is busy (being patted): it waits for her to be free, for three minutes.
  state = stepHerNeed(base, input(noon, { idle: false }, { wake, fatiguePhase: 'drowsy' }), () => 0.1).state;
  assert.equal(state.dreamUntil, noon + 3 * MIN);
  assert.equal(state.active, null);
  const free = stepHerNeed(state, input(noon + 40 * SECOND, { idle: true }, { wake, fatiguePhase: 'drowsy', boredom: 0, ignoredMs: 0 }), always);
  assert.equal(free.state.active?.id, 'dream', 'still drowsy from waking: a dream may be told');
  assert.equal(free.state.dreamUntil, null);
  // Too late: the window closed.
  const late = stepHerNeed(state, input(noon + 3 * MIN + SECOND, { idle: true }, { wake, boredom: 0, ignoredMs: 0 }), always);
  assert.equal(late.state.active, null);
  // The chance is the want's (0.18 at a want of 0.5, more after a long sleep): a roll at exactly the chance does not pass, just under it does.
  const chance = herNeedWakeChance(herNeedTriggers(signals({ wake })).dream!, { soft: 1, reluctance: 1 });
  assert.ok(chance > 0.18 && chance < 0.4);
  assert.equal(stepHerNeed(base, input(noon, {}, { wake }), () => chance).state.active, null);
  assert.equal(stepHerNeed(base, input(noon, {}, { wake }), () => chance - 1e-9).state.active?.id, 'dream', 'free at the moment of waking: it starts at once');
  // Left unanswered before, she is less willing to have it again (the reluctance, which no want climbs over).
  const snubbed = { ...base, snubs: { dream: { at: noon - 10 * MIN, interactions: 0 } }, interactions: 1 };
  assert.ok(herNeedWakeChance(1, verdictFor(snubbed, 'dream')) < herNeedWakeChance(1, verdictFor(base, 'dream')) * 0.2);
});

// ---------------------------------------------------------------- it only gets weaker

test('strength: full while it holds, then a straight fade to nothing; being soothed halfway only makes it weaker', () => {
  for (const id of HER_NEED_IDS) {
    const spec = HER_NEED_TABLE[id], since = noon;
    const at = (ms: number, progress = 0) => herNeedStrength({ id, since, progress }, since + ms);
    assert.equal(at(0), 1); assert.equal(at(spec.holdMs), 1);
    assert.ok(Math.abs(at(spec.holdMs + spec.fadeMs / 2) - 0.5) < 1e-9, `${id} halfway through the fade`);
    assert.equal(at(spec.holdMs + spec.fadeMs), 0);
    assert.equal(at(herNeedTotalMs(id) + 10 * MIN), 0);
    assert.ok(Math.abs(at(0, 1) - 0.5) < 1e-9 && at(0, 0.4) < 1 && at(0, 0.4) > at(0, 1));
    let last = 2;
    for (let ms = 0; ms <= herNeedTotalMs(id); ms += 15 * SECOND) { const value = at(ms); assert.ok(value <= last + 1e-12, `${id} never rises`); last = value; }
  }
  assert.ok(Object.values(HER_NEED_TABLE).every(spec => spec.holdMs + spec.fadeMs <= 30 * MIN), 'a need is over within half an hour');
});

// ---------------------------------------------------------------- nobody answers: 被晾过, 低落, and no chasing

test('nobody answers: it fades by itself, is remembered as unanswered, leaves 低落 and a small dip, and nothing new begins until the user interacts (no chasing)', () => {
  const started = run(createHerNeedState(DAY), noon, 5, always).state;
  assert.equal(started.active?.id, 'lonely');
  const since = started.active!.since;
  // A day and a half of wants that would start anything, never a word from the user, a lucky roll every time.
  const result = run(started, since + SECOND, 36 * 3_600, always, { startedAt: START }, { fatiguePhase: 'light-drowsy' });
  assert.deepEqual(result.events.filter(event => event.startsWith('started:')), [], 'no second need without an interaction in between');
  assert.ok(result.events.includes('faded:lonely'));
  assert.equal(result.state.active, null);
  assert.equal(result.state.armed, false);
  assert.ok(result.state.snubs.lonely, 'she remembers lonely went unanswered');
  assert.ok(result.state.used.length === 1, 'and that was the only one that day');
  // What it left, exactly once: 低落 by the table's gain and the card's sensitivity, and the dip in the event.
  const faded = stepHerNeed({ ...started, dejection: 0 }, input(since + herNeedTotalMs('lonely') + SECOND), always);
  const event = faded.events.find(e => e.type === 'faded')!;
  assert.equal(event.snubbed, true);
  assert.ok(Math.abs(faded.state.dejection - HER_NEED_TABLE.lonely.dejection) < 1e-9);
  assert.equal(faded.state.lowKind, 'lonely');
  assert.deepEqual(event.dip, herNeedDip(faded.state.dejection, 1));
  assert.ok(event.dip!.D! < 0 && event.dip!.O! < 0);
});

test('a need the user mostly answered is not a snub: half-soothed fades without 低落, a dip or a memory', () => {
  const started = run(createHerNeedState(DAY), noon, 5, always).state;
  const half = noteHerNeedInteraction(started, 'touch', HER_NEED_TABLE.lonely.soothe.touchMs * 0.6, noon + MIN).state;
  assert.ok(half.active && half.active.progress >= 0.5);
  const faded = stepHerNeed(half, input(noon + herNeedTotalMs('lonely') + MIN), always);
  assert.equal(faded.state.active, null);
  assert.deepEqual(faded.state.snubs, {}); assert.equal(faded.state.dejection, 0);
  assert.equal(faded.events.find(e => e.type === 'faded')?.snubbed, undefined);
  // …and a little patting that was not enough is still "unanswered" (less than half).
  const little = noteHerNeedInteraction(started, 'touch', HER_NEED_TABLE.lonely.soothe.touchMs * 0.2, noon + MIN).state;
  const left = stepHerNeed(little, input(noon + herNeedTotalMs('lonely') + MIN), always);
  assert.ok(left.state.snubs.lonely && left.state.dejection > 0);
});

test('被晾过: a kind that went unanswered is much less willing to show again, less so as time and the user\'s interactions go by; other kinds are not affected', () => {
  const now = noon;
  const rate = (state: HerNeedState, id: HerNeedId = 'lonely') => herNeedStartRate(id, 0.6, verdictFor(state, id, now, { startedAt: START - 10 * HOUR }));
  const fresh = createHerNeedState(DAY);
  const gone = (agoMs: number, interactions = 0) => ({ ...snubbedLonely(now, agoMs, interactions), dejection: 0, lowKind: null, used: [] as HerNeedId[], lastStartAt: null, lastStartInteractions: null, kindStartInteractions: {} });
  const base = rate(fresh);
  // Right after, nearly shut; a little later with a few interactions, still low; the next day, back mostly; after days, gone.
  assert.ok(rate(gone(5 * MIN, 1)) < base * 0.2, 'right after (and the one interaction that let her start again): she would rather not');
  assert.ok(rate(gone(5 * MIN, 0)) < base * 0.1);
  assert.ok(rate(gone(3 * HOUR, 3)) < base * 0.6);
  assert.ok(rate(gone(24 * HOUR, 12)) > base * 0.9);
  assert.ok(rate(gone(3 * 24 * HOUR, 0)) > base * 0.9, 'days later it has faded by time alone');
  assert.ok(rate(gone(6 * HOUR, 20)) > rate(gone(6 * HOUR, 2)), 'more interactions since, less reluctant');
  assert.ok(rate(gone(10 * HOUR, 4)) > rate(gone(1 * HOUR, 4)), 'more time since, less reluctant');
  // Only that kind.
  assert.equal(rate(gone(5 * MIN, 1), 'chatty'), rate(fresh, 'chatty'));
  // No want climbs over it: even the strongest want leaves the reluctance in place.
  const verdict = verdictFor(gone(5 * MIN, 1), 'lonely', now, { startedAt: START - 10 * HOUR });
  assert.ok(verdict.reluctance < 0.2);
  assert.ok(herNeedStartRate('lonely', 1, verdict) < herNeedStartRate('lonely', 1, { soft: 1, reluctance: 1 }) * verdict.reluctance * 1.0001);
  assert.ok(herNeedStartRate('lonely', 1, { soft: 0, reluctance: verdict.reluctance }) <= herNeedStartRate('lonely', 1, { soft: 1, reluctance: 1 }) * verdict.reluctance * 1.0001);
  // "Short term she does not bring it up again", in a long simulation: with the same luck, hours after the user came by, lonely rarely comes back,
  // while a never-snubbed her does.
  const trials = (state: HerNeedState) => {
    let count = 0;
    for (let seed = 1; seed <= 40; seed++) {
      let s = seed * 104729;
      const random = mulberry32(s);
      let current = state;
      for (let i = 0; i < 3_600; i += 2) {
        const result = stepHerNeed(current, input(now + i * SECOND, { startedAt: START - 10 * HOUR, trigger: () => ({ lonely: 0.6 }) }), random);
        current = result.state;
        if (result.events.some(e => e.type === 'started')) { count++; break; }
      }
    }
    return count;
  };
  const aftermath = { ...gone(10 * MIN, 1), armed: true };
  assert.ok(trials(aftermath) * 3 < trials({ ...fresh }), `snubbed ${trials(aftermath)} of 40 vs fresh ${trials({ ...fresh })} of 40 in the next hour`);
});

test('the user comes by herself: she is soothed as usual, the old snub is let go, and nothing is said about it', () => {
  // Her reluctance is real, but a lucky draw still lets lonely show; the user pats; she is soothed and the memory is gone.
  const snubbed = { ...snubbedLonely(noon, 30 * MIN, 2), dejection: 0, lowKind: null as HerNeedId | null, armed: true };
  const started = run(snubbed, noon, 5, always, { startedAt: START - 10 * HOUR, trigger: () => ({ lonely: 0.6 }) }).state;
  assert.equal(started.active?.id, 'lonely');
  const patted = noteHerNeedInteraction(started, 'touch', HER_NEED_TABLE.lonely.soothe.touchMs, noon + MIN);
  assert.equal(patted.soothed, 'lonely');
  assert.equal(patted.state.snubs.lonely, undefined, 'she is no longer reluctant about it');
  assert.equal(patted.state.glow?.id, 'lonely');
  // The words about it are the same with or without the history: nothing is said about having been left.
  assert.equal(herNeedSpeechLine('lonely'), herNeedSpeechLine('lonely'));
  assert.doesNotMatch(herNeedChatLine('soothed', 'lonely'), /之前没|没理|晾/);
  assert.doesNotMatch(herNeedChatLine('need', 'lonely'), /之前没|刚才没|没理|晾|上次/);
});

// ---------------------------------------------------------------- 低落 and 释然

test('低落 piles up with each unanswered need, is capped, is larger for a sensitive card, and settles by itself', () => {
  const fade = (state: HerNeedState, id: HerNeedId, weights = {}) => {
    const active = { ...state, active: { id, since: noon, progress: 0, spoke: false, told: false }, armed: true };
    return stepHerNeed(active, input(noon + herNeedTotalMs(id) + SECOND, {}, { weights: { playful: 1, close: 1, comfortable: 1, cautious: 1, ...weights } }), always).state;
  };
  let state = createHerNeedState(DAY);
  const levels: number[] = [];
  for (const id of ['lonely', 'chatty', 'dream', 'lonely', 'lonely', 'lonely'] as HerNeedId[]) { state = fade(state, id); levels.push(state.dejection); }
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1], 'more unanswered, more of it');
  assert.ok(levels[0] > 0.3 && levels[2] > levels[0], `${levels.map(v => v.toFixed(2))}`);
  assert.equal(levels.at(-1), HER_NEED_DEJECTION.cap, 'capped');
  assert.ok(levels.every(v => v <= HER_NEED_DEJECTION.cap));
  // The dip into the mood grows with it, and is bounded.
  const dips = [0, 0.25, 0.5, 0.75, 1].map(v => herNeedDip(v, 1).D!);
  for (let i = 1; i < dips.length; i++) assert.ok(dips[i] < dips[i - 1], 'a bigger dip the more has piled up');
  assert.ok(dips.at(-1)! >= -(HER_NEED_DEJECTION.dipBase + HER_NEED_DEJECTION.dipGain) - 1e-12);
  // The card: a close, cautious one feels it more, a carefree one less.
  assert.ok(herNeedSensitivity({ close: 1.8, cautious: 1.6 }) > 1.3 && herNeedSensitivity({ close: 0.4, cautious: 0.4 }) < 0.7 && herNeedSensitivity({}) === 1);
  const feelings = (weights: Record<string, number>) => fade(createHerNeedState(DAY), 'lonely', weights).dejection;
  assert.ok(feelings({ close: 1.8, cautious: 1.6 }) > feelings({}) && feelings({}) > feelings({ close: 0.4, cautious: 0.4 }));
  assert.ok(herNeedDip(0.5, 1.4).D! < herNeedDip(0.5, 0.6).D!);
  // It settles by itself (half-life 6 h; a sensitive card holds on longer) and is gone below the floor.
  const sad = { ...createHerNeedState(DAY), dejection: 0.8, lowKind: 'lonely' as const };
  // Nobody is "free" in these runs (no new need can begin), so only the settling is measured.
  const after = (ms: number, weights = {}) => run(sad, noon, ms / SECOND, always, { idle: false }, { weights: { playful: 1, close: 1, comfortable: 1, cautious: 1, ...weights } }).state.dejection;
  assert.ok(Math.abs(after(6 * HOUR) - 0.4) < 0.02, `${after(6 * HOUR)}`);
  assert.ok(after(6 * HOUR, { close: 1.8, cautious: 1.6 }) > after(6 * HOUR) && after(6 * HOUR, { close: 0.4, cautious: 0.4 }) < after(6 * HOUR));
  assert.equal(after(60 * HOUR), 0); assert.equal(run(sad, noon, 60 * 3600, always, { idle: false }).state.lowKind, null);
});

test('低落 shows as the `low` view (scaled by it) until it settles; it never blocks a new need; the needs view takes priority', () => {
  const sad = { ...createHerNeedState(DAY), dejection: 0.6, lowKind: 'lonely' as const, snubs: { lonely: { at: noon - 40 * MIN, interactions: 0 } } };
  const view = herNeedView(sad, noon)!;
  assert.equal(view.mode, 'low'); assert.equal(view.id, 'lonely'); assert.equal(view.strength, 0.6);
  assert.equal(herNeedView({ ...sad, dejection: 0.04 }, noon), null);
  assert.equal(herNeedView({ ...sad, active: { id: 'chatty', since: noon, progress: 0, spoke: false, told: false } }, noon)?.mode, 'need');
  assert.equal(herNeedView({ ...sad, glow: { id: 'chatty', since: noon, via: 'chat', told: false } }, noon)?.mode, 'glow');
  const scaled = scaledHerNeedPresentation({ id: 'lonely', mode: 'low' }, 1);
  for (const key of Object.keys(HER_NEED_LOW.presentation) as (keyof typeof scaled)[]) assert.ok(Math.abs(scaled[key] - HER_NEED_LOW.presentation[key]) < 1e-12, key);
  assert.deepEqual(scaledHerNeedPresentation({ id: 'lonely', mode: 'low' }, 0), HER_LIFE_NEUTRAL_PRESENTATION);
  assert.match(formatHerNeedLine(view, noon + 5 * MIN), /有点低落/);
  // Quiet, not a performance: a few degrees, lids a little down, no smile, no mouth.
  const p = HER_NEED_LOW.presentation;
  assert.ok(Math.abs(p.headX) <= 0.04 && Math.abs(p.headZ) <= 0.04 && p.lidSoft <= 0.2 && p.smileEyes === 0 && p.mouthSmile === 0 && p.sway < 1);
});

test('the user\'s first move ends 低落 as 释然, as much as had piled up, once; nothing piled up means no relief', () => {
  const sad = { ...createHerNeedState(DAY), dejection: 0.8, lowKind: 'lonely' as const, armed: false, snubs: { lonely: { at: noon - HOUR, interactions: 0 } } };
  const first = noteHerNeedInteraction(sad, 'chat', 1, noon);
  assert.equal(first.relieved, 0.8);
  assert.equal(first.state.dejection, 0); assert.equal(first.state.lowKind, null); assert.equal(first.state.armed, true);
  assert.equal(noteHerNeedInteraction(first.state, 'chat', 1, noon + MIN).relieved, null, 'once');
  assert.equal(noteHerNeedInteraction({ ...sad, dejection: 0.04 }, 'touch', 800, noon).relieved, null, 'below the floor is nothing to be relieved of');
  assert.equal(noteHerNeedInteraction(sad, 'touch', 0, noon).relieved, null, 'a touch of nothing is not the user coming');
  // More piled up, bigger relief; bounded.
  const lift = (d: number) => herNeedRelief(d);
  assert.ok(lift(1).D! > lift(0.3).D! && lift(1).D! <= 20 && lift(0.3).D! >= HER_NEED_DEJECTION.reliefBase);
  assert.ok(lift(1).C! < 0, 'the stress goes down');
  // The user's pat counts for the soothing of a need too (both can happen on one touch).
  const needing = { ...sad, dejection: 0.5, active: { id: 'chatty' as const, since: noon, progress: 0, spoke: false, told: false }, armed: true };
  const both = noteHerNeedInteraction(needing, 'chat', 2, noon);
  assert.equal(both.soothed, 'chatty'); assert.equal(both.relieved, 0.5);
});

test('property: she never spirals: with every want open and nobody there she has at most one need in three days and 低落 never passes its cap; with a user who comes by she is bounded', () => {
  for (let seed = 1; seed <= 10; seed++) {
    let s = seed * 7919;
    const random = mulberry32(s);
    // Nobody ever: 3 days, a hot trigger, a free limit function.
    let state = createHerNeedState(DAY);
    let started = 0, maxDejection = 0;
    for (let i = 0; i < 3 * 24 * 3_600; i += 5) {
      const now = START + i * SECOND;
      const result = stepHerNeed(state, { ...input(now, { trigger: () => ({ lonely: 1, chatty: 1, lowEnergy: 1 }), limits: () => ({ soft: 1, reluctance: 1 }) }), day: new Date(now).toISOString().slice(0, 10) }, random);
      started += result.events.filter(e => e.type === 'started').length; state = result.state; maxDejection = Math.max(maxDejection, state.dejection);
    }
    assert.ok(started <= 1, `seed ${seed}: ${started} needs with nobody there`);
    assert.ok(maxDejection <= HER_NEED_DEJECTION.cap);
  }
  // A user who comes by every `everyHours` hours (`interactionsEach` interactions each time) over 6 days, the default wants and limits. Boredom and
  // "ignored" run the way the mood model runs them (boredom +2 a minute after 5 quiet minutes, back to nothing when the user comes). Nothing
  // hard-caps a day, yet: never two at once, never a new one after an unanswered one with nobody in between, 低落 within its cap, and a rare
  // thing overall that is livelier on the days the user spends more with her.
  const simulate = (everyHours: number, interactionsEach: number, seeds: number) => {
    let total = 0, days = 0, worstDay = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      let s = seed * 15485863;
      const random = mulberry32(s);
      let state = createHerNeedState('2026-11-03'), unansweredSince = false, lastPop = 0;
      const perDayCounts = new Map<string, number>();
      const t0 = Date.UTC(2026, 10, 3, 0, 0, 0);
      for (let i = 0; i < 6 * 24 * 3_600; i += 5) {
        const now = t0 + i * SECOND, minute = Math.floor((i % 86_400) / 60), day = new Date(now).toISOString().slice(0, 10);
        const popBy = i % Math.round(everyHours * 3_600) === 0 && i > 0;
        if (popBy) { state = noteHerNeedInteraction(state, 'touch', interactionsEach * HER_NEED_TOUCH_MS_PER_INTERACTION, now).state; unansweredSince = false; lastPop = i; }
        const night = minute < 6 * 60 || minute >= 22 * 60 + 30, quietMs = (i - lastPop) * SECOND;
        const result = stepHerNeed(state, { now, day, expressions: true, idle: !popBy, startedAt: t0,
          signals: signals({ now, localMinute: minute, night, boredom: Math.min(100, Math.max(0, (quietMs - 5 * MIN) / MIN * 2)), ignoredMs: quietMs,
            fatiguePhase: minute > 14 * 60 && !night ? 'light-drowsy' : 'awake' }) }, random);
        for (const event of result.events) {
          if (event.type === 'started') {
            assert.equal(state.active, null, 'two at once');
            assert.ok(!unansweredSince, `seed ${seed}: a new need after an unanswered one with nobody in between`);
            perDayCounts.set(day, (perDayCounts.get(day) ?? 0) + 1);
          }
          if (event.type === 'faded') unansweredSince = true;
        }
        state = result.state;
        assert.ok(state.dejection <= HER_NEED_DEJECTION.cap + 1e-12);
      }
      for (const n of perDayCounts.values()) { total += n; worstDay = Math.max(worstDay, n); }
      days += 6;
    }
    return { perDay: total / days, worstDay };
  };
  const engaged = simulate(3, 5, 6), light = simulate(10, 1, 6);
  assert.ok(engaged.perDay > 0, 'with a user who comes by she does have needs');
  assert.ok(engaged.perDay <= 3, `a rare thing, about two a day softly (${engaged.perDay.toFixed(2)} a day on average with a user who comes by every 3 hours)`);
  assert.ok(engaged.worstDay <= 6, `even the busiest day stays small (${engaged.worstDay})`);
  assert.ok(engaged.perDay >= light.perDay, `livelier when the user spends more with her (${engaged.perDay.toFixed(2)} vs ${light.perDay.toFixed(2)} a day)`);
  if (process.env.HER_NEED_REPORT) console.log(`simulated needs a day: engaged ${engaged.perDay.toFixed(2)} (busiest ${engaged.worstDay}), light ${light.perDay.toFixed(2)} (busiest ${light.worstDay})`);
});

// ---------------------------------------------------------------- soothing and the warmth after

test('soothing: a pat, a snack or a few words; they add up; a few words are not enough for a worse day', () => {
  const started = (id: HerNeedId) => ({ ...createHerNeedState(DAY), active: { id, since: noon, progress: 0, spoke: false, told: false }, used: [id] });
  for (const id of HER_NEED_IDS) {
    const need = HER_NEED_TABLE[id].soothe;
    assert.equal(noteHerNeedInteraction(started(id), 'touch', need.touchMs, noon + MIN).soothed, id, `${id}: enough patting`);
    assert.equal(noteHerNeedInteraction(started(id), 'touch', need.touchMs - 1, noon + MIN).soothed, null);
    assert.equal(noteHerNeedInteraction(started(id), 'food', need.foods, noon + MIN).soothed, id);
    assert.equal(noteHerNeedInteraction(started(id), 'chat', need.chatTurns, noon + MIN).soothed, id);
    assert.equal(noteHerNeedInteraction(started(id), 'chat', need.chatTurns - 1, noon + MIN).soothed, null);
    // Half of one and half of another.
    const state = noteHerNeedInteraction(started(id), 'touch', need.touchMs / 2, noon + MIN).state;
    assert.ok(Math.abs(state.active!.progress - 0.5) < 1e-9);
    const result = noteHerNeedInteraction(state, 'food', need.foods / 2, noon + 2 * MIN);
    assert.equal(result.soothed, id, `${id}: the halves add up`);
    assert.equal(result.state.active, null);
    assert.equal(result.state.glow?.id, id);
    assert.equal(result.state.glow?.since, noon + 2 * MIN);
    assert.equal(result.state.armed, true);
  }
  assert.equal(noteHerNeedInteraction(started('lowEnergy'), 'food', 1, noon).soothed, 'lowEnergy');
  assert.equal(noteHerNeedInteraction(started('lonely'), 'food', 1, noon).soothed, null, 'one snack is half of what the lonely one wants');
});

test('soothing: every interaction is counted for the limit function (a message, a snack, five seconds of patting each); garbage amounts are ignored', () => {
  const base = createHerNeedState(DAY);
  const after = (kind: 'touch' | 'food' | 'chat', amount: number) => noteHerNeedInteraction(base, kind, amount, noon).state;
  assert.equal(after('chat', 1).interactions, 1); assert.equal(after('food', 1).interactions, 1);
  assert.equal(after('touch', HER_NEED_TOUCH_MS_PER_INTERACTION).interactions, 1);
  assert.ok(Math.abs(after('touch', 500).interactions - 0.1) < 1e-12);
  assert.equal(after('chat', 1).interactionsToday, 1);
  for (const amount of [0, -5, NaN, Infinity]) { assert.equal(after('chat', amount).interactions, 0, `${amount}`); assert.equal(noteHerNeedInteraction(base, 'chat', amount, noon).state.armed, true); }
  // Nothing to soothe changes nothing but counts and arms her (the user is here); the input state is never changed.
  const idle = { ...base, armed: false };
  const result = noteHerNeedInteraction(idle, 'chat', 1, noon);
  assert.equal(result.soothed, null); assert.equal(result.state.armed, true); assert.equal(result.state.glow, null);
  assert.equal(idle.interactions, 0); assert.equal(idle.armed, false);
  const active = { ...base, active: { id: 'lonely' as const, since: noon, progress: 0.2, spoke: false, told: false } };
  assert.equal(noteHerNeedInteraction(active, 'touch', 1, noon).state.active?.progress, 0.2 + 1 / 5_000, 'the input state is never changed');
  assert.equal(active.active.progress, 0.2);
});

test('the glow: plainly happy for a while, then fades away and ends; it blocks a new need while it lasts', () => {
  let state = noteHerNeedInteraction({ ...createHerNeedState(DAY), active: { id: 'chatty', since: noon, progress: 0, spoke: false, told: false } }, 'chat', 2, noon + MIN).state;
  assert.equal(herNeedView(state, noon + MIN)?.mode, 'glow');
  assert.equal(herNeedGlowStrength(state.glow!, noon + MIN + HER_NEED_GLOW.holdMs), 1);
  assert.ok(Math.abs(herNeedGlowStrength(state.glow!, noon + MIN + HER_NEED_GLOW.holdMs + HER_NEED_GLOW.fadeMs / 2) - 0.5) < 1e-9);
  const during = run(state, noon + MIN, 5 * 60, always, {}, { fatiguePhase: 'light-drowsy' });
  assert.equal(during.state.active, null);
  assert.equal(during.state.glow?.id, 'chatty');
  const after = run(during.state, noon + 6 * MIN, 12 * 60, () => 0.9999);
  assert.equal(after.state.glow, null);
  assert.ok(after.events.includes('glow-ended:chatty'));
  assert.equal(herNeedView(after.state, noon + 20 * MIN), null);
});

test('away or off: 自动表现 off or falling asleep puts everything away at once, and that is no snub', () => {
  const active = run(createHerNeedState(DAY), noon, 5, always).state;
  const off = stepHerNeed(active, input(noon + 10 * SECOND, { expressions: false }), always);
  assert.equal(off.state.active, null); assert.deepEqual(off.events, [{ type: 'cleared', id: 'lonely' }]);
  assert.deepEqual(off.state.used, ['lonely'], 'it still began today: nothing is refunded');
  assert.deepEqual(off.state.snubs, {}); assert.equal(off.state.dejection, 0);
  const asleep = stepHerNeed(active, input(noon + 10 * SECOND, {}, { fatiguePhase: 'falling-asleep' }), always);
  assert.equal(asleep.state.active, null); assert.deepEqual(asleep.state.snubs, {});
  const glowing = noteHerNeedInteraction(active, 'chat', 2, noon + 20 * SECOND).state;
  assert.equal(stepHerNeed(glowing, input(noon + 30 * SECOND, { expressions: false }), always).state.glow, null);
});

// ---------------------------------------------------------------- what she says and what the model is told (the user's big line)

/** What none of her lines may carry, even as a joke: a lever on the user. */
const LEVER = /你走了|难过死|别去|在乎我就|离不开|没有你|少了你|必须|应该来|该来|多陪|欠我|活该/u;
/** Phrases that state the big line itself (so the checks look at what is left). */
const BIG_LINE_PHRASES = new RegExp([BIG_LINE_WORDS, '不要求用户[^；。，]*', '也不要越说越委屈', '不要用户道歉或补偿', '不让用户不敢再离开', '不撒娇抱怨', '不惩罚、不加码、不翻旧账'].join('|'), 'gu');

test('words: every line she is given is a small 撒娇 inside the big line: light, no lever on the user, she makes up first, a sad user comes first', () => {
  for (const id of HER_NEED_IDS) {
    const speech = herNeedSpeechLine(id), need = herNeedChatLine('need', id), soothed = herNeedChatLine('soothed', id), relief = herNeedChatLine('relief');
    // The speech chance: a very short cute thing; a small sulk is allowed (the user's correction), a lever is not.
    assert.match(speech, /很短、很可爱/); assert.match(speech, /小小地撒个娇、别扭一下/); assert.match(speech, /不要求用户做什么/);
    assert.ok(speech.includes(BIG_LINE_WORDS), 'the big line is in the speech chance'); assert.match(speech, /不想说就选别的/);
    // The chat lines.
    assert.match(need, /小小地撒个娇、别扭一下/); assert.ok(need.includes(BIG_LINE_WORDS)); assert.match(need, /你先和好/); assert.match(need, /难过的事，先陪着用户/);
    assert.match(relief, /松了口气/); assert.match(relief, /由你先给台阶、先和好/); assert.ok(relief.includes(BIG_LINE_WORDS)); assert.match(relief, /难过的事，先陪着用户/);
    assert.match(soothed, /被用户哄好了/); assert.match(soothed, /很开心/); assert.match(soothed, /不翻之前的不开心/);
    for (const line of [speech, need, soothed, relief]) {
      assert.doesNotMatch(line.replace(BIG_LINE_PHRASES, ''), LEVER, `a lever in: ${line}`);
      assert.doesNotMatch(line, /他|她(?!自己)/u, '指用户时用「用户」，不用他 / 她');
      assert.ok(line.length <= 170, `short: ${line.length}`);
    }
    for (const word of [HER_NEED_TABLE[id].speak, HER_NEED_TABLE[id].chat, HER_NEED_TABLE[id].label]) assert.doesNotMatch(word, LEVER, `${id}: ${word}`);
  }
  assert.equal(herNeedSpeechLine('nope' as HerNeedId), '');
  assert.equal(herNeedChatLine('need', 'nope' as HerNeedId), '');
});

test('chat line: told once per state and a message counts as a few words; the message that soothes her gets the happy one; the user coming after being left gets the relief one', () => {
  const lonely = { ...createHerNeedState(DAY), active: { id: 'lonely' as const, since: noon, progress: 0, spoke: false, told: false } };
  const first = takeHerNeedChatLine(lonely, null, null, noon + MIN);
  assert.equal(first.line, herNeedChatLine('need', 'lonely'));
  assert.equal(takeHerNeedChatLine(first.state, null, null, noon + 2 * MIN).line, '');
  const soothing = noteHerNeedInteraction(lonely, 'chat', 2, noon + MIN);
  const happy = takeHerNeedChatLine(soothing.state, soothing.soothed, soothing.relieved, noon + MIN);
  assert.equal(happy.line, herNeedChatLine('soothed', 'lonely'));
  assert.equal(takeHerNeedChatLine(happy.state, null, null, noon + 2 * MIN).line, '', 'the glow is told once');
  const patted = noteHerNeedInteraction(lonely, 'touch', 5_000, noon + MIN).state;
  assert.equal(takeHerNeedChatLine(patted, null, null, noon + 2 * MIN).line, herNeedChatLine('soothed', 'lonely'));
  assert.equal(takeHerNeedChatLine(createHerNeedState(DAY), null, null, noon).line, '');
  assert.equal(takeHerNeedChatLine(patted, null, null, noon + HOUR).line, '');
  assert.equal(takeHerNeedChatLine({ ...lonely, active: { ...lonely.active, since: noon - HOUR } }, null, null, noon).line, '');
  // The user came after she was left unanswered: the relief line, once, and the soothing line wins when this very message soothed a need.
  const sad = { ...createHerNeedState(DAY), dejection: 0.7, lowKind: 'lonely' as const, armed: false };
  const came = noteHerNeedInteraction(sad, 'chat', 1, noon);
  assert.equal(takeHerNeedChatLine(came.state, came.soothed, came.relieved, noon).line, herNeedChatLine('relief'));
  assert.equal(takeHerNeedChatLine(came.state, null, null, noon + MIN).line, '', 'and only that once');
  const both = noteHerNeedInteraction({ ...sad, armed: true, active: { id: 'chatty', since: noon, progress: 0, spoke: false, told: false } }, 'chat', 2, noon);
  assert.equal(takeHerNeedChatLine(both.state, both.soothed, both.relieved, noon).line, herNeedChatLine('soothed', 'chatty'));
});

test('speech chance: one per need, only while it is still clearly there, never after she is soothed', () => {
  const lonely = { ...createHerNeedState(DAY), active: { id: 'lonely' as const, since: noon, progress: 0, spoke: false, told: false } };
  const first = takeHerNeedSpeech(lonely, noon + MIN);
  assert.equal(first.id, 'lonely');
  assert.equal(takeHerNeedSpeech(first.state, noon + 2 * MIN).id, null, 'no second chance');
  const spec = HER_NEED_TABLE.lonely;
  const weak = noon + spec.holdMs + spec.fadeMs * (1 - HER_NEED_SPEAK_MIN_STRENGTH) + 1_000;
  assert.equal(takeHerNeedSpeech(lonely, weak).id, null, 'nearly faded: she lets it go');
  assert.equal(takeHerNeedSpeech(createHerNeedState(DAY), noon).id, null);
  assert.equal(takeHerNeedSpeech(noteHerNeedInteraction(lonely, 'touch', 5_000, noon).state, noon + MIN).id, null, 'soothed');
  // 低落 is never spoken: no speech chance comes from it.
  assert.equal(takeHerNeedSpeech({ ...createHerNeedState(DAY), dejection: 1, lowKind: 'lonely' }, noon).id, null);
});

test('welcome back: after a long absence and at the moment of reunion the line is glad, small 撒娇 allowed, no lever; a sad user comes first', () => {
  const longing = { longingAt: 30, lastInteractionAt: START };
  for (const [name, args, expected] of [
    ['gone three days', { ...longing, longing: 90, reunion: false }, true], ['gone two days', { ...longing, longing: 42, reunion: false }, true],
    ['the reunion itself', { ...longing, longing: 0, reunion: true }, true], ['gone a few hours', { ...longing, longing: 0, reunion: false }, false],
    ['just below the line', { ...longing, longing: 29.9, reunion: false }, false], ['never talked', { longing: 80, longingAt: 30, lastInteractionAt: null, reunion: false }, false],
  ] as const) assert.equal(welcomeBackLine(args) !== '', expected, name);
  assert.match(WELCOME_BACK_LINE, /很想用户/); assert.match(WELCOME_BACK_LINE, /非常开心/); assert.match(WELCOME_BACK_LINE, /撒娇/);
  assert.match(WELCOME_BACK_LINE, /不惩罚、不加码、不翻旧账/); assert.match(WELCOME_BACK_LINE, /先给台阶、先和好/);
  assert.match(WELCOME_BACK_LINE, /难过的事，先陪着用户/);
  assert.doesNotMatch(WELCOME_BACK_LINE.replace(BIG_LINE_PHRASES, ''), LEVER);
  assert.doesNotMatch(WELCOME_BACK_LINE, /伤感|失落|委屈|孤单|寂寞|冷落|等了|他|她(?!自己)/u);
});

// ---------------------------------------------------------------- views and storage

test('view: names, times and one strength; scaled presentation runs from the neutral life to the table', () => {
  const state = { ...createHerNeedState(DAY), used: ['lonely' as const], active: { id: 'lonely' as const, since: noon, progress: 0, spoke: false, told: false } };
  const view = herNeedView(state, noon + 10 * MIN)!;
  assert.deepEqual(Object.keys(view).sort(), ['id', 'mode', 'since', 'strength', 'usedToday']);
  assert.equal(view.mode, 'need'); assert.equal(view.usedToday, 1);
  assert.ok(view.strength < 1 && view.strength > 0.7);
  assert.equal(herNeedView(state, noon + herNeedTotalMs('lonely')), null, 'a faded need has no view');
  assert.deepEqual(scaledHerNeedPresentation({ id: 'lonely', mode: 'need' }, 0), HER_LIFE_NEUTRAL_PRESENTATION);
  assert.deepEqual(scaledHerNeedPresentation({ id: 'lonely', mode: 'need' }, 1), HER_NEED_TABLE.lonely.presentation);
  const half = scaledHerNeedPresentation({ id: 'chatty', mode: 'need' }, 0.5);
  assert.ok(Math.abs(half.lookAtUser - (1 + (HER_NEED_TABLE.chatty.presentation.lookAtUser - 1) / 2)) < 1e-12);
  assert.deepEqual(scaledHerNeedPresentation({ id: 'chatty', mode: 'glow' }, 1), HER_NEED_GLOW.presentation);
  assert.match(formatHerNeedLine(view, noon + 10 * MIN), /有点闷 · 已经 10 分钟 · 强度 \d+% · 今天第 1 次/);
  assert.equal(formatHerNeedLine(null), '她的小情绪：没有');
  assert.match(formatHerNeedLine({ ...view, mode: 'glow' }, noon + 10 * MIN), /被哄好了/);
});

test('table: every presentation is a few degrees, never an open mouth or a big move; the glow is the happiest', () => {
  for (const [id, spec] of Object.entries(HER_NEED_TABLE)) {
    const p = spec.presentation;
    assert.ok(Math.abs(p.headX) <= 0.04 && Math.abs(p.headY) <= 0.04 && Math.abs(p.headZ) <= 0.04, `${id} head`);
    assert.ok(Math.abs(p.gazeX) <= 0.15 && Math.abs(p.gazeY) <= 0.15, `${id} gaze`);
    assert.ok(p.lidSoft <= 0.3 && p.smileEyes <= 0.5 && p.mouthSmile <= 0.35, `${id} face`);
    assert.equal(p.beatHz, 0, `${id} has no rhythm`);
    assert.ok(spec.dejection > 0 && spec.dejection <= 0.5, `${id}: one unanswered need is a small dip, not a collapse`);
  }
  assert.ok(HER_NEED_GLOW.presentation.smileEyes > Math.max(...Object.values(HER_NEED_TABLE).map(spec => spec.presentation.smileEyes)), 'the glow is the happiest');
});

test('storage: today\'s starts, the interaction counts and 被晾过 survive a restart; a showing need and 低落 do not; garbage is refused', () => {
  const state = { ...createHerNeedState(DAY), used: ['lonely' as const, 'dream' as const], lastStartAt: noon, active: { id: 'lonely' as const, since: noon, progress: 0.3, spoke: true, told: true }, armed: false,
    interactions: 12.5, interactionsToday: 3, lastStartInteractions: 10, kindStartInteractions: { lonely: 10, dream: 11 }, snubs: { lonely: { at: noon - HOUR, interactions: 9 } }, dejection: 0.7, lowKind: 'lonely' as const };
  const saved = serializeHerNeedState(state);
  assert.deepEqual(saved, { day: DAY, used: ['lonely', 'dream'], lastStartAt: noon, interactions: 12.5, interactionsToday: 3, lastStartInteractions: 10,
    kindStartInteractions: { lonely: 10, dream: 11 }, snubs: { lonely: { at: noon - HOUR, interactions: 9 } } });
  const restored = restoreHerNeedState(readHerNeedSaved(JSON.parse(JSON.stringify(saved)))!);
  assert.deepEqual(restored.used, ['lonely', 'dream']); assert.equal(restored.lastStartAt, noon); assert.equal(restored.interactions, 12.5);
  assert.deepEqual(restored.snubs, state.snubs); assert.deepEqual(restored.kindStartInteractions, state.kindStartInteractions);
  assert.equal(restored.active, null, 'a restart is the user being back: no need carries over'); assert.equal(restored.armed, true);
  assert.equal(restored.dejection, 0, '低落 is not carried over a restart (a long absence never punishes)');
  // A file from before the counts existed is read; wrong counts are refused.
  assert.deepEqual(readHerNeedSaved({ day: DAY, used: ['lonely'], lastStartAt: null }), { day: DAY, used: ['lonely'], lastStartAt: null, interactions: 0, interactionsToday: 0, lastStartInteractions: null, kindStartInteractions: {}, snubs: {} });
  for (const bad of [null, [], 'x', { day: 'today', used: [], lastStartAt: null }, { day: DAY, used: ['nope'], lastStartAt: null }, { day: DAY, used: [], lastStartAt: -1 },
    { day: DAY, used: [], lastStartAt: 1.5 }, { day: DAY, used: Array(17).fill('lonely'), lastStartAt: null },
    { day: DAY, used: [], lastStartAt: null, interactions: -1 }, { day: DAY, used: [], lastStartAt: null, interactions: NaN },
    { day: DAY, used: [], lastStartAt: null, kindStartInteractions: { nope: 1 } }, { day: DAY, used: [], lastStartAt: null, snubs: { lonely: { at: -1, interactions: 1 } } },
    { day: DAY, used: [], lastStartAt: null, snubs: [] }]) assert.equal(readHerNeedSaved(bad), null, JSON.stringify(bad));
});

test('an invalid amount (0, negative, NaN, Infinity) is no interaction at all: the state comes back untouched, not re-armed (T-112 round-007)', () => {
  const unanswered = { ...createHerNeedState(DAY), dejection: 0.8, lowKind: 'lonely' as const, armed: false, interactions: 3, interactionsToday: 2,
    snubs: { lonely: { at: noon - HOUR, interactions: 0 } }, active: { id: 'chatty' as const, since: noon, progress: 0.2, spoke: false, told: false } };
  for (const kind of ['touch', 'food', 'chat'] as const) for (const amount of [0, -1, -0.5, NaN, Infinity, -Infinity]) {
    const result = noteHerNeedInteraction(unanswered, kind, amount, noon + MIN);
    assert.equal(result.state.armed, false, `${kind} ${amount}: not re-armed`);
    assert.deepEqual(result.state, unanswered, `${kind} ${amount}: nothing changed`);
    assert.equal(result.soothed, null); assert.equal(result.relieved, null);
  }
  // A real one still re-arms (the contract is unchanged for valid amounts).
  assert.equal(noteHerNeedInteraction(unanswered, 'touch', 1, noon + MIN).state.armed, true);
});
