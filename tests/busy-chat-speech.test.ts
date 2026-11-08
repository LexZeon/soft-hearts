import test from 'node:test';
import assert from 'node:assert/strict';
import { busyChatFrequency, busyChatScale, recentChatTimes } from '../shared/behaviors/busy-chat/choose';
import { speechIntervalAfterUnanswered, unansweredSentence } from '../shared/behaviors/busy-chat/unanswered';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodAttentionCandidate, type MoodParameters, type MoodState } from '../shared/mood';
import { innerLoopPrompt } from '../electron/inner-loop/context';
import { runInnerLoopDay, type DayCard, type DayDecide } from '../scripts/lib/inner-loop-day';
import { GENE_DAY_CARD } from '../scripts/inner-loop-day-cards';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';

const MINUTE = 60_000;
const NOW = 10 * 3_600_000;
const card = (frequency: Partial<MoodParameters['frequency']> = {}): MoodParameters => ({ ...DEFAULT_MOOD_PARAMETERS, frequency: { ...DEFAULT_MOOD_PARAMETERS.frequency, ...frequency } });
const msgs = (n: number, agoMin = 5) => Array.from({ length: n }, (_, i) => NOW - agoMin * MINUTE - i * 1000);
const caps = (p: MoodParameters, times: number[], less = false) => { const f = busyChatFrequency({ card: p, chatTimes: times, now: NOW, less }); return [f.speechIntervalMs / MINUTE, f.speechPerHour]; };

test('the default card is the neutral one (scale 1), so the numbers below are the plain tiers', () => {
  assert.equal(busyChatScale(DEFAULT_MOOD_PARAMETERS), 1);
  assert.deepEqual([DEFAULT_MOOD_PARAMETERS.frequency.speechIntervalMs / MINUTE, DEFAULT_MOOD_PARAMETERS.frequency.speechPerHour, DEFAULT_MOOD_PARAMETERS.frequency.speechWithoutReply], [30, 2, 1]);
});

test('tiers: 0-2 messages the card, 3-9 interval x0.75 and +1 per hour, 10+ interval x0.5 and +2', () => {
  const p = card();
  assert.deepEqual(caps(p, []), [30, 2]);
  assert.deepEqual(caps(p, msgs(2)), [30, 2]);
  assert.deepEqual(caps(p, msgs(3)), [22.5, 3]);
  assert.deepEqual(caps(p, msgs(9)), [22.5, 3]);
  assert.deepEqual(caps(p, msgs(10)), [15, 4]);
  assert.deepEqual(caps(p, msgs(25)), [15, 4]);
});

test('no floor and no ceiling: a 20-minute card goes to 10 minutes, a 3-per-hour card to 5', () => {
  assert.deepEqual(caps(card({ speechIntervalMs: 20 * MINUTE, speechPerHour: 3 }), msgs(10)), [10, 5]);
  assert.deepEqual(caps(card({ speechIntervalMs: 8 * MINUTE }), msgs(10)), [4, 4]);
  assert.deepEqual(caps(card({ speechPerHour: 6 }), msgs(10)), [15, 8]);
});

test('messages age out after 60 minutes, and only past or present ones count', () => {
  const p = card();
  assert.deepEqual(caps(p, msgs(10, 61)), [30, 2]);
  assert.deepEqual(caps(p, msgs(10, 59)), [15, 4]);
  assert.equal(recentChatTimes([NOW + 1000, NOW - 61 * MINUTE, NOW - MINUTE], NOW).length, 1);
  // 10 messages, 8 of them old: only 2 recent -> the card.
  assert.deepEqual(caps(p, [...msgs(8, 70), ...msgs(2, 3)]), [30, 2]);
});

test('speechWithoutReply is never touched, and a card that forbids speaking on her own stays so', () => {
  for (const n of [0, 3, 10]) {
    for (const without of [0, 1, 2]) {
      const f = busyChatFrequency({ card: card({ speechWithoutReply: without }), chatTimes: msgs(n), now: NOW });
      assert.equal(f.speechWithoutReply, without);
    }
  }
  assert.deepEqual(caps(card({ speechPerHour: 0 }), msgs(10)), [30, 0]);
});

test('「少一点」 gets no boost at all', () => {
  assert.deepEqual(caps(card(), msgs(10), true), [30, 2]);
  const p = card();
  assert.equal(busyChatFrequency({ card: p, chatTimes: msgs(10), now: NOW, less: true }), p.frequency);
});

test('personality: a clingy card is boosted more, a restrained one less', () => {
  const clingy = card(); clingy.weights = { ...clingy.weights, close: 1.8 };
  const reserved = card(); reserved.intensity = { ...reserved.intensity, expression: 0 };
  assert.ok(busyChatScale(clingy) > 1 && busyChatScale(reserved) < 1);
  const base = caps(card(), msgs(10)), more = caps(clingy, msgs(10)), less = caps(reserved, msgs(10));
  assert.ok(more[0] < base[0] && more[1] >= base[1]);
  assert.ok(less[0] > base[0] && less[1] <= base[1]);
  assert.ok(less[0] < 30, 'still boosted a little');
});

test('unanswered lines stretch the interval x3 each, capped at 90 minutes; a card that is already longer keeps its own', () => {
  const ms = (min: number, unanswered: number, allowance = 1) => speechIntervalAfterUnanswered(min * MINUTE, unanswered, allowance) / MINUTE;
  assert.equal(ms(30, 0), 30);
  assert.equal(ms(30, 1), 90);
  assert.equal(ms(30, 2), 90, 'capped: it stays at 90 however many go unanswered');
  assert.equal(ms(30, 7), 90);
  assert.equal(ms(15, 1), 45);
  assert.equal(ms(15, 2), 90);
  assert.equal(ms(120, 1), 120);
  assert.equal(ms(120, 3), 120);
  assert.equal(ms(30, 1, 2), 30, 'within a card allowance of 2 nothing is stretched');
  assert.equal(ms(30, 2, 2), 90);
});

function state(over: Partial<MoodState> = {}): MoodState { return { ...createMoodState(NOW, DEFAULT_MOOD_PARAMETERS), boredom: 100, ...over }; }

test('mood gate: after one unanswered line the next one is NOT refused for good, it waits 3 x the interval (and the hour quota still counts)', () => {
  const p = card({ speechPerHour: 3 });
  const spoke = (unanswered: number, sinceMin: number, times: number[] = []) => getMoodAttentionCandidate(
    state({ unansweredSpeech: unanswered, lastSpeechAt: NOW - sinceMin * MINUTE, speechTimes: times }), NOW, p, true) === 'speech';
  assert.equal(spoke(0, 31), true);
  assert.equal(spoke(1, 31), false, 'a plain 30 minutes is no longer enough after an unanswered line');
  assert.equal(spoke(1, 89), false);
  assert.equal(spoke(1, 91), true, 'but the line is possible, not a hard stop');
  assert.equal(spoke(2, 91), true, 'capped at 90 minutes');
  assert.equal(spoke(1, 91, [NOW - 5 * MINUTE, NOW - 20 * MINUTE, NOW - 40 * MINUTE]), false, 'the hourly quota still counts');
});

test('the user answering (a chat) resets the stretch', () => {
  let s = state({ unansweredSpeech: 2, lastSpeechAt: NOW - 31 * MINUTE });
  s = applyMoodEvent(s, { type: 'chat', id: 'hello' }, NOW);
  assert.equal(s.unansweredSpeech, 0);
});

test('her prompt gets one fact and a leaning, not a rule, only when lines went unanswered', () => {
  assert.equal(unansweredSentence(0), '');
  assert.match(unansweredSentence(2), /已经主动说了 2 句，他都还没回/);
  const sources = { now: () => NOW, localMinute: () => 15 * 60, persona: () => 'p', language: () => '', mood: () => '', parameters: () => DEFAULT_MOOD_PARAMETERS,
    lastInteractionAt: () => NOW - 40 * MINUTE, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' };
  const claim = { id: 'c', kind: 'speech', at: NOW, characterId: 'x', gateScope: 's' } as never;
  const quiet = { asleep: false, drowsy: false, night: false, quiet: false };
  const without = innerLoopPrompt(sources as never, claim, true, quiet);
  const withLine = innerLoopPrompt({ ...sources, unanswered: () => 1 } as never, claim, true, quiet);
  assert.doesNotMatch(without, /他都还没回/);
  assert.match(withLine, /已经主动说了 1 句，他都还没回，多半在忙/);
  assert.match(withLine, /speak/, 'speaking stays one of the options');
  assert.doesNotMatch(innerLoopPrompt({ ...sources, unanswered: () => 1 } as never, claim, false, { ...quiet, quiet: true }), /他都还没回/);
});

// ---- day simulation: real MoodHost + inner loop, a fake model that always wants to speak ----
// A synthetic card whose boredom runs fast, so the interval and hourly caps (not boredom) are what hold her back: that is where the boost shows.
const fastParameters = structuredClone(GENE_DAY_CARD.parameters);
fastParameters.boredom = { graceMs: 0, perMinute: 20, lookAt: 10, motionAt: 20, speechAt: 30 };
const FAST_CARD = { ...GENE_DAY_CARD, id: 'fast', parameters: fastParameters };
const speak: DayDecide = async (_p, _s, info) => ({ text: info.allowSpeech ? '{"action":"speak","text":"忙完了吗？"}' : '{"action":"none"}' });
const MIDNIGHT = new Date(2026, 10, 7).getTime();
const day = (extra: Omit<Parameters<typeof runInnerLoopDay>[0], 'card' | 'decide'> & { card?: DayCard }) => runInnerLoopDay({ card: FAST_CARD, boredomTiming: new FixedBoredomTiming(),
  midnight: MIDNIGHT, decide: speak, ...extra });
const minutes = (r: { speechAt: number[] }) => r.speechAt.map(t => Math.round((t - MIDNIGHT) / MINUTE));
// A busy stretch: 10 messages 14:00-14:27 (one every 3 minutes), then she is left alone until 16:30.
const busyHour = Array.from({ length: 10 }, (_, i) => 14 * 60 + 3 * i);
const quiet = [{ startMinute: 14 * 60, idleMinutes: 150 }];
const after = (r: { speechAt: number[] }) => minutes(r).filter(m => m >= 14 * 60 + 30);

test('day: after a busy stretch of chatting she says more than with no chat; 少一点 and no chat are the old day', async () => {
  const none = await day({ blocks: quiet });
  const busy = await day({ blocks: quiet, messages: busyHour });
  const less = await day({ blocks: quiet, messages: busyHour, proactiveTalk: 'less' });
  console.log('minutes of day she spoke: no chat', JSON.stringify(minutes(none)), 'busy', JSON.stringify(minutes(busy)), 'busy+少一点', JSON.stringify(minutes(less)));
  assert.ok(busy.spoken.length > none.spoken.length, `${busy.spoken.length} vs ${none.spoken.length}`);
  assert.ok(after(busy).length > after(none).length, 'also in the quiet stretch after the chat');
  assert.ok(busy.spoken.length > less.spoken.length, `${busy.spoken.length} vs ${less.spoken.length}`);  const again = await day({ blocks: quiet });
  assert.deepEqual(again.speechAt, none.speechAt, 'same day, same numbers');
});

test('day: the user never answers: later lines are still possible, but each waits at least 90 minutes (3 x the interval, capped)', async () => {
  const result = await day({ card: GENE_DAY_CARD, blocks: [{ startMinute: 10 * 60, idleMinutes: 300 }] });
  const at = result.speechAt, gaps = at.slice(1).map((t, i) => (t - at[i]) / MINUTE);
  console.log('never answered, 300 min, Gene: lines', at.length, 'gaps(min)', gaps.map(g => Math.round(g)));
  assert.ok(at.length >= 2, 'a later line is still possible');
  assert.ok(gaps.every(g => g >= 90 && g <= 95), JSON.stringify(gaps));
  const fast = await day({ blocks: [{ startMinute: 10 * 60, idleMinutes: 300 }] });
  const fastGaps = fast.speechAt.slice(1).map((t, i) => (t - fast.speechAt[i]) / MINUTE);
  console.log('never answered, 300 min, fast card: lines', fast.speechAt.length, 'gaps(min)', fastGaps.map(g => Math.round(g)));
  assert.ok(fastGaps.every(g => g >= 90), JSON.stringify(fastGaps));
});
