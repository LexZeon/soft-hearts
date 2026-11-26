// 松绑 (approved).
// Fakes only: a fake clock, fake mood readers, a fake presence, no model call, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { IMPULSE_KNOBS } from '../shared/behaviors/impulse/knobs';
import { impulseNow, initiativeFloor, reachChance, regulateInitiative, impulseLeans } from '../shared/behaviors/impulse/choose';
import { pickSlip, pickTopic, programFeel, slipLine, styleLine, topicLine, SLIP_KINDS, TOPIC_KINDS, type SlipKind, type TopicKind } from '../shared/behaviors/impulse/expression';
import type { FloorInput, ImpulseInput, InitiativeRow } from '../shared/behaviors/impulse/interface';
import { ImpulseHost, type ImpulseHostOptions, type ImpulseMoodRead, type OutcomeMoment } from '../electron/initiative/impulse/host';
import { buildInnerLoopPrompt, INNER_LOOP_MISSING_RULE, INNER_LOOP_QUIET_FINE, INNER_LOOP_SPEAK_FIRST, INNER_LOOP_TEXT_MAX, type InnerLoopPromptInput } from '../shared/initiative/inner-loop';
import { innerLoopExpression } from '../electron/initiative/inner-loop/context';
import { DEFAULT_MOOD_PARAMETERS, applyMoodEvent, createMoodState, type MoodValues } from '../shared/foundation/mood';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiText } from '../src/foundation/ui-language';
import { OpeningHost, type OpeningLoop } from '../electron/brain/opening-host';
import type { OpeningChoice, OpeningChoiceHost, OpeningNow, OpeningWhy } from '../shared/behaviors/opening-choice/interface';
import type { PresenceView } from '../shared/behaviors/user-activity/interface';
import { MoodHost } from '../electron/mood/mood';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import { moodValueForLevel } from '../shared/foundation/mood-presets';
import { runInnerLoopDay } from '../scripts/lib/inner-loop-day';
import { GENE_DAY_CARD } from '../scripts/inner-loop-day-cards';
import { OpeningChoiceDirector } from '../shared/behaviors/opening-choice/choose';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 12, 6, 0, 0);
const base = (): MoodValues => ({ D: 50, O: 50, E: 50, N: 50, C: 50 });
const at = (level: number, baseline = 50) => moodValueForLevel(level, baseline, 1);
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const input = (over: Partial<ImpulseInput> = {}): ImpulseInput => ({ values: base(), baseline: base(), evidence: 1, boredom: 0, longing: 0, A: 0.25, personality: {}, ignored: 0, ...over });
/** A warm afternoon: closer and happier than her baseline, a little bored, missing the user a little. */
const warm = (): Partial<ImpulseInput> => ({ values: { ...base(), O: at(70), D: at(66), N: at(58) }, boredom: 45, longing: 35 });

// ------------------------------------------------------------------------------------------------ 1. the impulse

test('impulse: calm at her baseline she does not reach out; closeness, pleasure, boredom and missing push; stress, sleepiness and being ignored hold', () => {
  const calm = impulseNow(input());
  assert.ok(calm.urge < IMPULSE_KNOBS.reach.from, `calm ${calm.urge}`);
  assert.equal(reachChance(calm.urge, 1_000), 0);
  const warmUrge = impulseNow(input(warm()));
  assert.ok(warmUrge.urge > IMPULSE_KNOBS.reach.from && warmUrge.bucket !== 'low', `warm ${warmUrge.urge}`);
  for (const [name, over] of [['O', { values: { ...base(), O: at(75) } }], ['D', { values: { ...base(), D: at(75) } }], ['N', { values: { ...base(), N: at(75) } }],
    ['B', { boredom: 80 }], ['M', { longing: 80 }]] as const) assert.ok(impulseNow(input(over as Partial<ImpulseInput>)).urge > calm.urge, name);
  const stressed = impulseNow(input({ ...warm(), values: { ...warm().values!, C: at(80) } }));
  const sleepy = impulseNow(input({ ...warm(), A: 0.8 }));
  const ignored = impulseNow(input({ ...warm(), ignored: 2 }));
  for (const [name, held] of [['C', stressed], ['A', sleepy], ['ignored', ignored]] as const) assert.ok(held.urge < warmUrge.urge && held.hold > 0, name);
  // Low stress is not a push (only stress above her baseline holds her back).
  assert.equal(impulseNow(input({ values: { ...base(), C: at(20) } })).urge, calm.urge);
});

test('impulse: relative to the card baseline, by the card personality, and each kind from the same numbers', () => {
  // A card whose resting O is 70 at O 70 is "at the baseline", like the default card at 50.
  const high = { ...base(), O: 70 };
  assert.equal(impulseNow(input({ values: high, baseline: high })).urge, impulseNow(input()).urge);
  const clingy = impulseNow(input({ ...warm(), personality: { close: 1.6 } })), shy = impulseNow(input({ ...warm(), personality: { cautious: 1.6 } }));
  const usual = impulseNow(input(warm()));
  assert.ok(clingy.urge > usual.urge && shy.urge < usual.urge, `${clingy.urge} > ${usual.urge} > ${shy.urge}`);
  const playful = impulseNow(input({ values: { ...base(), D: at(80), N: at(75) }, boredom: 60 }));
  const missing = impulseNow(input({ values: { ...base(), O: at(80) }, longing: 80 }));
  assert.ok(playful.kinds.play > missing.kinds.play, 'play leans on D, N, B');
  assert.ok(missing.kinds.leave > playful.kinds.leave, 'leaving something leans on O and M');
  assert.ok(missing.kinds.glance > playful.kinds.glance);
  // The leans the opening choice gets follow those kinds.
  const leans = impulseLeans(playful);
  assert.ok(leans.play![0].factor > leans.keepsake![0].factor);
});

// ------------------------------------------------------------------------------------------------ 2. the floor and the soft balance

const OPEN: FloorInput = { asleep: false, quiet: false, presence: 'ok', canExpress: true, unanswered: 0 };

test('floor: night, not now, a meeting, away and an unanswered line each stop talk; a glance only stops for night and not now', () => {
  assert.equal(initiativeFloor('talk', OPEN), null);
  assert.equal(initiativeFloor('talk', { ...OPEN, quiet: true }), 'night');
  assert.equal(initiativeFloor('talk', { ...OPEN, canExpress: false }), 'not-now');
  assert.equal(initiativeFloor('talk', { ...OPEN, presence: 'meeting' }), 'meeting');
  assert.equal(initiativeFloor('talk', { ...OPEN, presence: 'no' }), 'away');
  assert.equal(initiativeFloor('talk', { ...OPEN, unanswered: 1 }), 'unanswered');
  assert.equal(initiativeFloor('glance', { ...OPEN, quiet: true }), 'night');
  assert.equal(initiativeFloor('glance', { ...OPEN, canExpress: false }), 'not-now');
  assert.equal(initiativeFloor('glance', { ...OPEN, presence: 'meeting', unanswered: 3 }), null);
  // Through the whole regulation: whatever she rolls, a blocked talk is never chosen.
  const strong = impulseNow(input({ ...warm(), values: { ...base(), O: at(95), D: at(90) }, longing: 95 }));
  for (const floor of [{ ...OPEN, quiet: true }, { ...OPEN, canExpress: false }, { ...OPEN, presence: 'meeting' as const }, { ...OPEN, presence: 'no' as const }, { ...OPEN, unanswered: 1 }]) {
    const random = seeded(7);
    for (let i = 0; i < 300; i++) {
      const decision = regulateInitiative({ impulse: strong, floor, balance: 1, busy: false, humOffered: true }, random);
      assert.notEqual(decision.kind, 'talk', JSON.stringify(floor));
      if (decision.kind === 'none') assert.equal(decision.why, 'floor');
    }
  }
});

test('soft balance: little room presses talk (why "balance"); she can still choose not even when everything allows it', () => {
  const urge = impulseNow(input(warm()));
  const random = seeded(3);
  const counts = { talk: 0, none: 0, balance: 0, choseNot: 0 };
  for (let i = 0; i < 2_000; i++) {
    const d = regulateInitiative({ impulse: urge, floor: OPEN, balance: 0.1, busy: false, humOffered: false }, random);
    if (d.kind === 'talk') counts.talk++;
    if (d.why === 'balance') counts.balance++;
  }
  const open = { talk: 0, none: 0 };
  for (let i = 0; i < 2_000; i++) {
    const d = regulateInitiative({ impulse: urge, floor: OPEN, balance: 1, busy: false, humOffered: false }, random);
    if (d.kind === 'talk') open.talk++;
    if (d.kind === 'none') { open.none++; assert.equal(d.why, 'chose-not'); }
  }
  assert.ok(counts.talk < open.talk / 4 && counts.balance > 0, JSON.stringify({ counts, open }));
  // "可以不说": with everything open she still lets some pass, and speaks on most (measured, never 0 and never all).
  const share = open.none / 2_000;
  assert.ok(share > 0.1 && share < 0.6, `chose not ${share}`);
  assert.ok(open.talk / 2_000 > 0.3, `talk ${open.talk / 2_000}`);
});

// ------------------------------------------------------------------------------------------------ the host: reach, floor, timing

interface Fake {
  now: number; mood: ImpulseMoodRead; asleep: boolean; quiet: boolean; presence: PresenceView | null; canExpress: boolean;
  balance: number | null; talks: number[]; glances: number[]; lifts: { kind: OutcomeMoment; key: string }[]; rows: InitiativeRow[]; talkOk: boolean;
}
function fakeHost(over: Partial<Fake> = {}, seed = 11) {
  const f: Fake = {
    now: T0, mood: { characterId: 'gene', values: { ...base(), O: at(70), D: at(66), N: at(58) }, baseline: base(), evidence: 1, boredom: 45, longing: 35, A: 0.25,
      personality: {}, lastInteractionAt: T0, unanswered: 0, primary: 'happy', context: 'neutral', reason: '安静陪伴' },
    asleep: false, quiet: false, presence: { presence: 'idle', interrupt: 'yes', source: 'input' }, canExpress: true, balance: 1,
    talks: [], glances: [], lifts: [], rows: [], talkOk: true, ...over,
  };
  const options: ImpulseHostOptions = {
    clock: () => f.now, random: seeded(seed), mood: () => f.mood, quiet: () => ({ asleep: f.asleep, quiet: f.quiet }), presence: () => f.presence,
    canExpress: () => f.canExpress, balance: () => f.balance, talkNow: () => { f.talks.push(f.now); return f.talkOk; }, glanceNow: () => { f.glances.push(f.now); return true; },
    lift: (kind, _id, key) => { f.lifts.push({ kind, key }); return true; }, journal: row => { f.rows.push(row); },
  };
  const host = new ImpulseHost(options);
  const run = (ms: number) => { for (let t = 0; t < ms; t += 1_000) { f.now += 1_000; host.tick(); } };
  return { f, host, run };
}

test('host floor: asleep there is no reach at all; at night, in a meeting, away, typing or hidden, or unanswered she never asks to talk', () => {
  const asleep = fakeHost({ asleep: true });
  asleep.run(6 * HOUR);
  assert.deepEqual([asleep.f.talks.length, asleep.f.glances.length, asleep.f.rows.length], [0, 0, 0]);
  const cases: [string, Partial<Fake>][] = [
    ['night', { quiet: true }], ['meeting', { presence: { presence: 'meeting', interrupt: 'no', source: 'input', why: 'meeting' } as PresenceView }],
    ['away', { presence: { presence: 'away', interrupt: 'no', source: 'input', why: 'idle-long' } as PresenceView }], ['not-now', { canExpress: false }],
  ];
  for (const [name, over] of cases) {
    const h = fakeHost(over);
    h.run(6 * HOUR);
    assert.equal(h.f.talks.length, 0, name);
    assert.ok(h.f.rows.some(row => row.why === 'floor' && row.floor === name), `${name}: ${JSON.stringify(h.f.rows.slice(0, 3))}`);
  }
  const unanswered = fakeHost();
  unanswered.f.mood = { ...unanswered.f.mood, unanswered: 1 };
  unanswered.run(6 * HOUR);
  assert.equal(unanswered.f.talks.length, 0, 'no chasing after an unanswered line');
  assert.ok(unanswered.f.glances.length > 0, 'a glance is not chasing');
  // The same "held back" again and again is one journal row, not a stream.
  const night = fakeHost({ quiet: true });
  night.run(8 * HOUR);
  assert.ok(night.f.rows.length <= 3, `${night.f.rows.length} rows`);
});

test('host reach: she asks to talk when open, never in the quiet after you; the gaps are not a beat (程序感: no fixed rhythm)', () => {
  const gaps: number[] = [];
  let talks = 0, tooSoon = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const h = fakeHost({}, seed);
    // A day of short visits: the user interacts, then leaves her be for 40–100 minutes.
    const visits = seeded(seed + 100);
    for (let i = 0; i < 12; i++) {
      h.f.mood = { ...h.f.mood, lastInteractionAt: h.f.now };
      const start = h.f.now, before = h.f.talks.length;
      h.run((40 + 60 * visits()) * MINUTE);
      const mine = h.f.talks.slice(before);
      if (mine.length && mine[0] - start < IMPULSE_KNOBS.reach.quietAfter[0] * MINUTE) tooSoon++;
      for (let k = 1; k < mine.length; k++) gaps.push(mine[k] - mine[k - 1]);
      if (mine.length) gaps.push(mine[0] - start);
      talks += mine.length;
    }
  }
  assert.equal(tooSoon, 0, 'never inside the quiet after an interaction');
  assert.ok(talks > 40, `talks ${talks}`);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  const bins = new Map<number, number>();
  for (const gap of gaps) bins.set(Math.round(gap / MINUTE), (bins.get(Math.round(gap / MINUTE)) ?? 0) + 1);
  const crowded = Math.max(...bins.values()) / gaps.length;
  assert.ok(sd / mean > 0.35, `spread ${sd / mean}`);
  assert.ok(crowded < 0.15, `the most common minute holds ${crowded}`);
});

test('host: a refused talk (the mood clock\'s interval or cap) is "cooldown"; little room is "balance"; her own pass is "chose-not"', () => {
  const refused = fakeHost({ talkOk: false });
  refused.run(4 * HOUR);
  assert.ok(refused.f.rows.some(row => row.kind === 'none' && row.why === 'cooldown'));
  const tight = fakeHost({ balance: 0 });
  tight.run(4 * HOUR);
  assert.equal(tight.f.talks.length, 0);
  assert.ok(tight.f.rows.some(row => row.why === 'balance'));
  const open = fakeHost();
  open.run(40 * HOUR);
  const summary = open.f.rows.map(row => `${row.kind}:${row.why ?? ""}`).join(","); assert.ok(open.f.rows.some(row => row.why === "chose-not") && open.f.rows.some(row => row.kind === "talk"), summary);
  for (const row of open.f.rows) assert.ok(buildJournalEntry({ type: 'initiative', ...row }, T0), JSON.stringify(row));
});

// ------------------------------------------------------------------------------------------------ 4. outcomes back to her mood

test('outcomes: you answered → spoke-answered; nobody answered → spoke-unanswered and that topic rests; "next time" → invite-declined and fewer invites', () => {
  const h = fakeHost();
  h.host.expression('gene', ['doing', 'time']);
  h.host.spoke('诶，你看我刚才哼的这首', 'line-1');
  h.f.now += 3 * MINUTE; h.f.mood = { ...h.f.mood, lastInteractionAt: h.f.now };
  h.host.tick();
  assert.deepEqual(h.f.lifts, [{ kind: 'spoke-answered', key: 'line-1' }]);
  // Unanswered: after the window, the dip; the topic she used is not given again for a few hours.
  const quietH = fakeHost();
  const random = seeded(9);
  let topic: TopicKind | null = null;
  for (let i = 0; i < 20 && !topic; i++) topic = quietH.host.expression('gene', ['doing']).topic;
  assert.equal(topic, 'doing');
  quietH.host.spoke('刚才我一直在想事情', 'line-2');
  quietH.run(IMPULSE_KNOBS.outcome.answerMinutes * MINUTE + 2_000);
  assert.deepEqual(quietH.f.lifts.map(l => l.kind), ['spoke-unanswered']);
  for (let i = 0; i < 50; i++) assert.notEqual(quietH.host.expression('gene', ['doing']).topic, 'doing');
  quietH.f.now += IMPULSE_KNOBS.topic.quietHours * HOUR + MINUTE;
  let back = false;
  for (let i = 0; i < 50; i++) back ||= quietH.host.expression('gene', ['doing']).topic === 'doing';
  assert.ok(back, 'after the quiet hours the topic may come back');
  void random;
  // Declined: the dip, the invite candidate pressed hard for a while, and the urge holds a little.
  const d = fakeHost();
  const before = d.host.leans('gene')!.play!;
  d.host.inviteAnswered('gene', false, 'inv-1');
  assert.deepEqual(d.f.lifts, [{ kind: 'invite-declined', key: 'inv-1' }]);
  const after = d.host.leans('gene')!.play!;
  assert.ok(after.length === before.length + 1 && after.at(-1)!.factor < 0.5);
  // A rest reminder (the quiet hours) waits for no answer.
  const night = fakeHost();
  night.f.quiet = true;
  night.host.spoke('早点睡', 'line-3');
  night.run(20 * MINUTE);
  assert.deepEqual(night.f.lifts, []);
});

test('outcomes reach her mood: spoke-answered lifts O and D; unanswered and declined dip a little and keep her reason; each has a cooldown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-loosen-'));
  const clock = { now: T0 };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  try {
    await host.load();
    host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    const v0 = { ...host.get().snapshot.values }, reason0 = host.get().snapshot.reason;
    assert.equal(host.moments.note('spoke-unanswered', 'gene', 'a'), true);
    const v1 = { ...host.get().snapshot.values };
    assert.ok(v1.D < v0.D && v1.C > v0.C, JSON.stringify([v0, v1]));
    assert.equal(host.get().snapshot.reason, reason0, 'keeps her reason (never something to bring up)');
    assert.equal(host.moments.note('spoke-unanswered', 'gene', 'b'), false, 'cooldown');
    clock.now += 2 * MINUTE;
    assert.equal(host.moments.note('spoke-answered', 'gene', 'c'), true);
    const v2 = { ...host.get().snapshot.values };
    assert.ok(v2.O > v1.O && v2.D > v1.D);
    assert.equal(host.moments.note('invite-declined', 'gene', 'd'), true);
    assert.ok(host.get().snapshot.values.D < v2.D);
    assert.equal(host.moments.note('invite-declined', 'gene', 'e'), false, 'cooldown');
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ 3. expression

const GUILT = /内疚|愧疚|难过死|不理我|都不理|你走了|要是在乎|冷落|晾着|丢下|抛下|怪你|你去哪|孤单|寂寞|害我|你应该|你必须|多出去|找朋友|去社交|想开点/u;

test('expression lines: no guilt, no lecturing, no template sentence to copy; the topic line says only where to look', () => {
  const lines = [INNER_LOOP_SPEAK_FIRST, styleLine([]), styleLine(['诶，', '你在']),
    ...SLIP_KINDS.map(kind => slipLine(kind)), ...TOPIC_KINDS.map(kind => topicLine(kind, { doing: '轻轻哼歌（没出声）', event: '跳完一段舞', time: '傍晚', plan: '他说过周五有「面试」，时间已经过去了' }))];
  for (const line of lines) {
    assert.ok(line.length > 0);
    assert.doesNotMatch(line, GUILT, line);
  }
  for (const kind of TOPIC_KINDS) {
    const line = topicLine(kind, { doing: '发呆', event: '听完一首喜欢的歌', time: '上午', plan: '他说过周五有「面试」，时间已经过去了' });
    assert.match(line, /只说真有的/u);
    assert.doesNotMatch(line, /\d/u, 'no numbers in a topic');
  }
  // A kind without its real data is never written.
  assert.equal(topicLine('doing', {}), ''); assert.equal(topicLine('event', {}), ''); assert.equal(topicLine(null, { doing: 'x' }), '');
});

test('topics: only from what is available, the same one less often, none sometimes (not forced), and a rested one stays out', () => {
  const random = seeded(5), seen = new Map<string, number>();
  let previous: TopicKind | null = null, repeats = 0, picks = 0;
  const recent: TopicKind[] = [];
  for (let i = 0; i < 3_000; i++) {
    const topic = pickTopic(['doing', 'time', 'mood'], { recent, quietUntil: { mood: T0 + HOUR } }, T0, random);
    seen.set(String(topic), (seen.get(String(topic)) ?? 0) + 1);
    assert.ok(topic === null || topic === 'doing' || topic === 'time', String(topic));
    if (topic) { picks++; if (topic === previous) repeats++; recent.unshift(topic); recent.splice(3); }
    previous = topic;
  }
  assert.ok((seen.get('null') ?? 0) > 100, 'sometimes no topic at all');
  assert.ok(repeats / picks < 0.5, `repeats ${repeats / picks}`);
  assert.equal(pickTopic([], { recent: [], quietUntil: {} }, T0, random), null);
});

test('slips: rare, never the same kind twice in a row, and a cooldown after each (程序感)', () => {
  const h = fakeHost({}, 21);
  const slips: { at: number; kind: SlipKind }[] = [];
  for (let i = 0; i < 3_000; i++) {
    h.f.now += 7 * MINUTE;
    const { slip } = h.host.expression('gene', ['time', 'mood']);
    if (slip) slips.push({ at: h.f.now, kind: slip });
  }
  const rate = slips.length / 3_000;
  assert.ok(rate > 0.005 && rate < 0.12, `rate ${rate}`);
  for (let i = 1; i < slips.length; i++) {
    assert.notEqual(slips[i].kind, slips[i - 1].kind, 'never the same slip twice in a row');
    assert.ok(slips[i].at - slips[i - 1].at >= IMPULSE_KNOBS.slip.cooldownMinutes[0] * MINUTE, 'cooldown');
  }
  assert.ok(new Set(slips.map(s => s.kind)).size === 3, 'all three kinds happen');
  // The pure picker: inside the cooldown nothing; the last kind is skipped.
  const mood = { values: { ...base(), N: at(90) }, baseline: base(), A: 0.2, personality: { playful: 1.5 } };
  assert.equal(pickSlip(mood, { last: null, until: T0 + 1 }, T0, () => 0), null);
  assert.notEqual(pickSlip(mood, { last: 'change-mind', until: 0 }, T0, () => 0), 'change-mind');
});

test('程序感 counter: number reports and repeated openings are counted', () => {
  assert.deepEqual(programFeel(['你去好久了诶', '我注意到你已经离开了 32 分钟', '诶，你回来啦', '诶，我刚在发呆']), { numberReports: 1, sameOpenings: 1, lines: 4 });
  assert.match(styleLine(['诶，']), /不要报具体的分钟数/u);
});

// ------------------------------------------------------------------------------------------------ the prompt

const promptInput = (over: Partial<InnerLoopPromptInput> = {}): InnerLoopPromptInput => ({
  persona: '你是 Gene。', mood: '当前角色内在状态：平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
  localMinute: 15 * 60, minutesSinceInteraction: 35, cue: 'speech', allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false },
  topic: topicLine('doing', { doing: '发呆' }), style: styleLine(['诶，']), slip: slipLine('distracted'), ...over,
});

test('prompt: where she may speak on her own, speak comes first, "doing nothing is fine" is gone, one line up to 30, a real topic; principle 6 stays', () => {
  const prompt = buildInnerLoopPrompt(promptInput());
  assert.equal(INNER_LOOP_TEXT_MAX, 30);
  assert.match(prompt, /可选：speak（说一句话）、look/u);
  assert.ok(!prompt.includes(INNER_LOOP_QUIET_FINE) && prompt.includes(INNER_LOOP_SPEAK_FIRST));
  assert.match(prompt, /不超过 30 个字/u);
  assert.ok(prompt.includes('你刚才自己在做的事——发呆') && prompt.includes('走神') && prompt.includes('换个开头'));
  assert.ok(prompt.includes(INNER_LOOP_MISSING_RULE), 'principle 6 (关于愧疚) is still there');
  // Quiet, the rest reminder, no speech, invite-only: as before (no topic, no slip, none first, the old sentence).
  for (const over of [{ quiet: { asleep: false, drowsy: false, night: true, quiet: true } }, { quiet: { asleep: false, drowsy: true, night: false, quiet: true, restReminder: true } },
    { allowSpeech: false }, { play: true, inviteOnly: true }] as Partial<InnerLoopPromptInput>[]) {
    const p = buildInnerLoopPrompt(promptInput(over));
    assert.ok(p.includes(INNER_LOOP_QUIET_FINE), JSON.stringify(over));
    assert.ok(!p.includes('话头') && !p.includes('小毛病') && !p.includes('换个开头'), JSON.stringify(over));
    assert.doesNotMatch(p, /可选：speak/u);
  }
});

test('context: a topic is offered only when its source is real and only where she may speak on her own', () => {
  const claim = { id: 'c1', kind: 'speech' as const, at: T0, characterId: 'gene' };
  const awake = { asleep: false, drowsy: false, night: false, quiet: false };
  const offered: TopicKind[][] = [];
  const sources = { expression: (_id: string, available: readonly TopicKind[]) => { offered.push([...available]); return { topic: available[0] ?? null, slip: null, openings: [] }; },
    recentEvent: () => '' };
  innerLoopExpression(sources, claim, true, awake, 'mood', { activity: null, profile: '', diary: '', localMinute: 900 });
  assert.deepEqual(offered.at(-1), ['time', 'mood']);
  innerLoopExpression({ ...sources, recentEvent: () => '跳完一段舞' }, claim, true, awake, undefined,
    { activity: { current: 'humming', minutes: 3 }, profile: '- 下周面试', diary: '- 一起看了雨', localMinute: 900 });
  assert.deepEqual(offered.at(-1), ['doing', 'event', 'you', 'diary', 'time', 'mood']);
  const before = offered.length;
  for (const focus of ['play', 'rest', 'keepsake', 'give'] as const) assert.deepEqual(innerLoopExpression(sources, claim, true, awake, focus, { activity: null, profile: '', diary: '', localMinute: 900 }), {});
  assert.deepEqual(innerLoopExpression(sources, claim, true, { ...awake, night: true, quiet: true }, 'mood', { activity: null, profile: '', diary: '', localMinute: 900 }), {});
  assert.deepEqual(innerLoopExpression(sources, claim, false, awake, 'mood', { activity: null, profile: '', diary: '', localMinute: 900 }), {});
  assert.deepEqual(innerLoopExpression(sources, { ...claim, kind: 'motion' }, true, awake, undefined, { activity: null, profile: '', diary: '', localMinute: 900 }), {});
  assert.equal(offered.length, before, 'not even asked');
  // Only a warm recent reason is a topic (a let-down never is).
  const h = fakeHost();
  h.f.mood = { ...h.f.mood, context: 'disappointment', reason: '一个人待了一会儿，有点低落' };
  assert.equal(h.host.recentEvent(), '');
  h.f.mood = { ...h.f.mood, context: 'positive', reason: '跳完一段舞' };
  assert.equal(h.host.recentEvent(), '跳完一段舞');
});

// ------------------------------------------------------------------------------------------------ wiring into the opening choice and the mood clock

function openingHarness(leans: OpeningNow['leans'] | null) {
  const seen: OpeningNow[] = [];
  const chooser: OpeningChoiceHost = {
    choose: (_id, now) => { seen.push(now); return { id: 'quiet', label: '这次不说', why: [], weights: '' } as OpeningChoice; },
    settle: () => {}, last: () => null, note: () => {}, recent: () => [] as OpeningWhy[],
  };
  const loop: OpeningLoop = { offerOpportunity: () => true, canTake: () => true, claims: () => false, asleep: () => false, silence: () => false, restReminderDue: () => false,
    quietNow: () => ({ asleep: false, drowsy: false, night: false, quiet: false }) };
  let rolls = 0;
  const opening = new OpeningHost({ loop, chooser, innerOn: () => true, developerMode: () => false, releaseSpeech: () => {}, clock: () => T0, random: () => 0.5,
    budget: { room: () => { rolls++; return { factor: 0, words: '没余额' }; }, spend: () => {}, refund: () => {} }, leans: () => leans });
  const view = { characterId: 'gene', snapshot: { primary: 'happy', companion: null, boredom: 80, lastInteractionAt: T0 - HOUR } as never, parameters: DEFAULT_MOOD_PARAMETERS };
  let n = 0;
  const claim = () => opening.claim({ id: `cue${++n}`, kind: 'speech', at: T0, until: T0 + 30_000 }, {}, view);
  return { opening, seen, claim, rolls: () => rolls };
}

test('opening choice: her urge leans each candidate; an opportunity her impulse asked for is not pressed by the budget twice', () => {
  const h = openingHarness({ mood: [{ text: '冲动：很想说话', factor: 1.7 }], quiet: [{ text: '没什么收着的', factor: 0.7 }] });
  h.opening.expectReach();
  assert.equal(h.claim(), 'quiet', 'the fake chooser picks quiet');
  assert.equal(h.rolls(), 0, 'the reach already rolled the budget');
  assert.deepEqual(h.seen[0].leans?.mood, [{ text: '冲动：很想说话', factor: 1.7 }]);
  // The next, ordinary cue rolls the budget as before (and with no room stays quiet before choosing).
  assert.equal(h.claim(), 'quiet');
  assert.equal(h.rolls(), 1);
  assert.equal(h.seen.length, 1);
  // Without leans: exactly as before (no leans field).
  const bare = openingHarness(null);
  bare.opening.expectReach(); bare.claim();
  assert.equal(bare.seen[0].leans, undefined);
});

test('mood clock: a welcome look skips the boredom threshold but keeps its interval; a welcome motion is refused', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  let state = createMoodState(T0, p);
  state = applyMoodEvent(state, { type: 'attention', id: 'g1', kind: 'look', welcome: true }, T0 + 1_000, p);
  assert.equal(state.cue?.id, 'g1');
  state = { ...state, cue: null };
  state = applyMoodEvent(state, { type: 'attention', id: 'g2', kind: 'look', welcome: true }, T0 + 2 * MINUTE, p);
  assert.equal(state.cue, null, 'inside the motion interval');
  const plain = applyMoodEvent(createMoodState(T0, p), { type: 'attention', id: 'g3', kind: 'look' }, T0 + 1_000, p);
  assert.equal(plain.cue, null, 'without the welcome, boredom still decides');
  assert.throws(() => applyMoodEvent(createMoodState(T0, p), { type: 'attention', id: 'g4', kind: 'motion', welcome: true }, T0 + 1_000, p));
});

// ------------------------------------------------------------------------------------------------ a day on the real mood clock (before / after)

test('day: on the real mood clock, with her urge on, she speaks first more often in short visits and warm ones; never inside the quiet after you', async () => {
  const visits = (from: number, n: number, idle: number) => Array.from({ length: n }, (_, i) => ({ startMinute: from + i * 60, idleMinutes: idle }));
  const scenarios: [string, { blocks: { startMinute: number; idleMinutes: number }[]; blockLift?: Partial<MoodValues> }][] = [
    ['8 short visits (35 min quiet each)', { blocks: visits(10 * 60, 8, 35) }],
    ['8 warm short visits', { blocks: visits(10 * 60, 8, 35), blockLift: { O: 8, D: 8 } }],
    ['3 long quiets (110 min)', { blocks: [{ startMinute: 9 * 60, idleMinutes: 110 }, { startMinute: 12 * 60, idleMinutes: 110 }, { startMinute: 15 * 60, idleMinutes: 110 }] }],
  ];
  const table: string[] = [];
  let gained = 0;
  for (const [name, scenario] of scenarios) {
    const count = { before: 0, after: 0, reaches: 0, chose: 0, early: 0 };
    for (const seed of [1, 2, 3, 4]) {
      // A fake model that speaks about half the time it may (and otherwise does nothing): no real call. A fresh one per run (same draws).
      const fake = () => {
        const say = seeded(seed + 50);
        return async (_prompt: string, _signal: AbortSignal, info: { allowSpeech: boolean }) =>
          ({ text: info.allowSpeech && say() < 0.5 ? '{"action":"speak","text":"在想你刚才说的事"}' : '{"action":"none"}' });
      };
      const common = { card: GENE_DAY_CARD, midnight: new Date(2026, 10, 12).getTime(), ...scenario };
      const before = await runInnerLoopDay({ ...common, decide: fake(), opening: { chooser: new OpeningChoiceDirector({ random: seeded(seed) }) } });
      const rows: InitiativeRow[] = [];
      const after = await runInnerLoopDay({ ...common, decide: fake(), opening: { chooser: new OpeningChoiceDirector({ random: seeded(seed) }) }, impulse: { random: seeded(seed + 9), rows } });
      count.before += before.spoken.length; count.after += after.spoken.length;
      count.reaches += rows.length; count.chose += rows.filter(row => row.why === 'chose-not').length;
      if (process.env.LOOSEN_TABLE) console.log(name, seed, before.spoken.length, after.spoken.length, rows.map(row => `${row.kind}${row.why ? ':' + row.why : ''}`).join(','));
      // Never a line inside the first minutes after the user's chat (the quiet she keeps).
      for (const line of after.spoken) {
        const block = scenario.blocks.find(b => line.at >= common.midnight + b.startMinute * MINUTE && line.at < common.midnight + (b.startMinute + b.idleMinutes) * MINUTE);
        if (block && line.at - (common.midnight + block.startMinute * MINUTE) < IMPULSE_KNOBS.reach.quietAfter[0] * MINUTE) count.early++;
      }
    }
    assert.equal(count.early, 0, name);
    assert.ok(count.after >= count.before - 1, `${name}: ${JSON.stringify(count)}`); // the random draws part ways after the first difference
    if (count.after > count.before) gained++;
    table.push(`| ${name} | ${count.before} | ${count.after} | ${count.reaches} | ${count.chose} |`);
  }
  assert.ok(gained >= 1, table.join('\n'));
  console.log(['| 情景（4 个种子合计，假模型约一半时候开口） | 改前她先开口 | 改后 | 想起你 | 其中她选了不说 |', ...table].join('\n'));
});

// ------------------------------------------------------------------------------------------------ the journal row

test('journal: the initiative row is closed values only, in both languages', () => {
  const ok = [{ bucket: 'high', kind: 'talk' }, { bucket: 'mid', kind: 'none', why: 'chose-not' }, { bucket: 'low', kind: 'none', why: 'floor', floor: 'unanswered' },
    { bucket: 'mid', kind: 'glance' }, { bucket: 'mid', kind: 'hum' }, { bucket: 'mid', kind: 'none', why: 'cooldown' }, { bucket: 'mid', kind: 'none', why: 'balance' }];
  for (const row of ok) assert.ok(buildJournalEntry({ type: 'initiative', characterId: 'gene', ...row }, T0), JSON.stringify(row));
  for (const bad of [{ bucket: 'huge', kind: 'talk' }, { bucket: 'mid', kind: 'talk', why: 'floor' }, { bucket: 'mid', kind: 'none' }, { bucket: 'mid', kind: 'none', why: 'floor' },
    { bucket: 'mid', kind: 'none', why: 'chose-not', floor: 'night' }, { bucket: 'mid', kind: '想你了' }]) assert.equal(buildJournalEntry({ type: 'initiative', characterId: 'gene', ...bad }, T0), null, JSON.stringify(bad));
  assert.equal(buildJournalEntry({ type: 'initiative', characterId: null, bucket: 'mid', kind: 'talk' }, T0), null);
  const smuggled = buildJournalEntry({ type: 'initiative', characterId: 'gene', bucket: 'mid', kind: 'talk', text: '我想你了' }, T0)!;
  assert.ok(!JSON.stringify(smuggled).includes('我想你了'));
  const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
  assert.match(describeJournalEntry(buildJournalEntry({ type: 'initiative', characterId: 'gene', bucket: 'low', kind: 'none', why: 'floor', floor: 'meeting' }, T0)!, plain), /她想起你，这次没做什么（冲动弱，底线拦下，你在开会）/u);
  try {
    setUiLanguage('en');
    for (const row of ok) {
      const english = describeJournalEntry(buildJournalEntry({ type: 'initiative', characterId: 'gene', ...row }, T0)!, uiText);
      assert.ok(!/[一-鿿]/u.test(english), english);
    }
    for (const floor of ['night', 'meeting', 'away', 'not-now', 'unanswered']) {
      const english = describeJournalEntry(buildJournalEntry({ type: 'initiative', characterId: 'gene', bucket: 'mid', kind: 'none', why: 'floor', floor }, T0)!, uiText);
      assert.ok(!/[一-鿿]/u.test(english), english);
    }
    for (const kind of ['spoke-answered', 'spoke-unanswered', 'invite-declined']) {
      const english = describeJournalEntry(buildJournalEntry({ type: 'mood-event', characterId: 'gene', source: `moment-${kind}`, before: base(), after: { ...base(), D: 51 },
        labelBefore: 'calm', labelAfter: 'calm' }, T0)!, uiText);
      assert.ok(!/[一-鿿]/u.test(english), english);
    }
  } finally { setUiLanguage('zh-CN'); }
});
