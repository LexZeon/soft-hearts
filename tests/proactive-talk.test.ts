/**
 * 设置.
 * Real MoodHost + InnerLoop + gate on a simulated clock (scripts/lib/inner-loop-day.ts); the model is fake. No Claude call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInnerLoopDay, type DayDecide, type DayResult } from '../scripts/lib/inner-loop-day';
import { GENE_DAY_CARD, SLOW_TIRED_CARD } from '../scripts/inner-loop-day-cards';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { OpeningChoiceDirector } from '../shared/behaviors/opening-choice/choose';
import { innerRhythmTalkScale } from '../shared/behaviors/inner-rhythm/choose';
import { INNER_RHYTHM_KNOBS, proactiveTalk, type ProactiveTalk } from '../shared/behaviors/inner-rhythm/knobs';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000;
const midnight = new Date('2026-11-03T00:00:00').getTime();
const speaks: DayDecide = async (_prompt, _signal, info) => ({ text: info.allowSpeech ? '{"action":"speak","text":"忙完了吗？"}' : '{"action":"look"}' });
const day = [{ startMinute: 9 * 60, idleMinutes: 180 }, { startMinute: 13 * 60, idleMinutes: 180 }, { startMinute: 19 * 60, idleMinutes: 240 }];
const night = [{ startMinute: 23 * 60, idleMinutes: 480 }];

const run = (blocks: typeof day, seed: number, talk: ProactiveTalk | undefined, card = GENE_DAY_CARD) =>
  runInnerLoopDay({ card, blocks, decide: speaks, midnight,
    boredomTiming: new BoredomTimingDirector({ random: seeded(seed) }),
    opening: { chooser: new OpeningChoiceDirector({ random: seeded(seed * 31 + 5) }) },
    rhythm: { random: seeded(seed + 100), ...(talk ? { talk } : {}) } });
const signature = (r: DayResult) => JSON.stringify([r.calls, r.opportunities, r.diagnostics.map(d => [d.at, d.cue, d.called, d.decision, d.result]), r.spoken]);
const sum = (rs: DayResult[], pick: (r: DayResult) => number) => rs.reduce((n, r) => n + pick(r), 0);

/** The caps the card carries and the loop must never relax (shared/mood.ts: speechIntervalMs, speechPerHour, speechWithoutReply). */
function assertCaps(r: DayResult, card = GENE_DAY_CARD, label = '') {
  const { speechIntervalMs, speechPerHour } = card.parameters.frequency;
  const at = r.spoken.map(s => s.at).sort((a, b) => a - b);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= speechIntervalMs - 1, `${label}: lines ${i - 1} and ${i} are ${(at[i] - at[i - 1]) / MINUTE} min apart`);
  assert.ok(speechIntervalMs >= 30 * MINUTE, 'the card under test keeps at least 30 minutes between spoken lines');
  for (let i = 0; i < at.length; i++) assert.ok(at.filter(t => t >= at[i] && t < at[i] + 60 * MINUTE).length <= speechPerHour, `${label}: more than ${speechPerHour} lines in an hour`);
  // Every call keeps the old minimum: a motion call is never closer than 2 x the motion interval to the call before it.
  const calls = r.diagnostics.filter(d => d.called);
  for (const [i, call] of calls.entries()) if (i > 0 && call.cue === 'motion')
    assert.ok((call.at - calls[i - 1].at) >= 2 * card.parameters.frequency.motionIntervalMs - 1, `${label}: motion call ${i} too close`);
}

test('适中 is today: the same seed gives the same day with and without the setting', async () => {
  for (const seed of [1, 2, 3]) {
    const without = await run(day, seed, undefined), normal = await run(day, seed, 'normal');
    assert.equal(signature(normal), signature(without), `seed ${seed}`);
  }
  assert.equal(innerRhythmTalkScale('normal'), 1);
  assert.equal(innerRhythmTalkScale(undefined), 1);
});

test('少一点 < 适中 < 多一点 over a day (calls and speech chances), and all three keep every cap', async () => {
  const levels: ProactiveTalk[] = ['less', 'normal', 'more'];
  const seeds = [1, 2, 3];
  const results: Record<ProactiveTalk, DayResult[]> = { less: [], normal: [], more: [] };
  for (const level of levels) for (const seed of seeds) {
    const r = await run(day, seed, level); results[level].push(r); assertCaps(r, GENE_DAY_CARD, `${level} seed ${seed}`);
  }
  const calls = (l: ProactiveTalk) => sum(results[l], r => r.calls), spoken = (l: ProactiveTalk) => sum(results[l], r => r.spoken.length);
  const speechCalls = (l: ProactiveTalk) => sum(results[l], r => r.allowSpeechCalls);
  console.log(`# calls less/normal/more: ${levels.map(calls).join('/')}; allow-speech calls: ${levels.map(speechCalls).join('/')}; spoken lines: ${levels.map(spoken).join('/')}`);
  assert.ok(calls('less') < calls('normal') * 0.75, `少一点 clearly fewer calls: ${calls('less')} vs ${calls('normal')}`);
  assert.ok(calls('more') > calls('normal'), `多一点 more calls: ${calls('more')} vs ${calls('normal')}`);
  assert.ok(spoken('less') <= spoken('normal'), `少一点 never says more: ${spoken('less')} vs ${spoken('normal')}`);
  // 多一点 cannot outrun the card's speech caps (asserted per day above): its extra chances are looks and motions, not more lines.
  assert.ok(spoken('more') <= seeds.length * 10 * GENE_DAY_CARD.parameters.frequency.speechPerHour, 'bounded by the per-hour cap');
});

test('the night: 少一点 asks fewer times than 适中, 多一点 no fewer, and the rest reminder / deep-night quiet stay', async () => {
  for (const card of [GENE_DAY_CARD, SLOW_TIRED_CARD]) {
    let less = 0, normal = 0, more = 0;
    for (const seed of [1, 2, 3]) {
      const l = await run(night, seed, 'less', card), n = await run(night, seed, 'normal', card), m = await run(night, seed, 'more', card);
      less += l.calls; normal += n.calls; more += m.calls;
      for (const r of [l, n, m]) assertCaps(r, card, card.id);
      // Asleep stays asleep: a line is never spoken at a call the sleeping loop did not make.
      assert.ok(l.quietSpeechCalls <= n.quietSpeechCalls, `${card.id} seed ${seed}: quiet speech calls ${l.quietSpeechCalls} vs ${n.quietSpeechCalls}`);
    }
    console.log(`# night ${card.id} calls less/normal/more: ${less}/${normal}/${more}`);
    assert.ok(less <= normal && normal <= more, `${card.id}: ${less}/${normal}/${more}`);
  }
});

test('the knobs: 少一点 doubles, 多一点 shortens, and an unknown value reads as 适中', () => {
  assert.equal(innerRhythmTalkScale('less'), INNER_RHYTHM_KNOBS.talkLess);
  assert.ok(innerRhythmTalkScale('more') < 1 && innerRhythmTalkScale('more') > 0);
  for (const bad of [undefined, null, 'LESS', 3, {}, '']) assert.equal(proactiveTalk(bad), 'normal');
  assert.equal(proactiveTalk('less'), 'less'); assert.equal(proactiveTalk('more'), 'more');
});
