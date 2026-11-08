/**
 * #10 频率（方案第 7 节）：现成的"一天"模拟（scripts/lib/inner-loop-day.ts，真 MoodHost + 真内心循环 + 真闸门）和"一起听一晚"模拟
 * （scripts/lib/listen-night.ts，真笔记核心 + 真停顿点开口 + 真心情配额），同一组随机种子新旧各跑一遍（scripts/opening-choice-compare.ts）。
 * 模型都是假的，不调用真实 Claude。
 *  - 她挑不会多出开口时机：两边结局一样时（假模型从不说话），说话时机一模一样多；
 *  - 说出口的次数、聊天模型的调用都不比原来多；两次之间仍然至少隔 30 分钟、一小时最多 2 次；
 *  - 她选"这次不说"时退回次数（和内心循环自己选"不做"一直以来一样），所以假模型总说话的那一组里，后面可能还有时机，记录里如实写了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDay, compareNight } from '../scripts/opening-choice-compare';
import type { DayDecide } from '../scripts/lib/inner-loop-day';

const none: DayDecide = async () => ({ text: '{"action":"none"}' });
const speak: DayDecide = async (_prompt, _signal, info) => ({ text: info.allowSpeech ? '{"action":"speak","text":"忙完了吗？"}' : '{"action":"look"}' });
const MINUTE = 60_000;
const spacing = (times: readonly number[]) => times.slice(1).map((at, i) => at - times[i]);

test('a day, nothing ever said on either side: exactly the same speech opportunities; fewer small-model calls on them, never more in all', async () => {
  for (const seed of [1, 2]) {
    const { old, choice } = await compareDay(seed, none);
    assert.equal(choice.opportunities.speech, old.opportunities.speech, `seed ${seed}`);
    assert.deepEqual(choice.speechAt, old.speechAt, `seed ${seed}: at the same moments`);
    assert.equal(choice.spoken.length, 0);
    const speechCalls = (r: typeof old) => r.diagnostics.filter(d => d.cue === 'speech' && d.called).length;
    assert.ok(speechCalls(choice) <= speechCalls(old), `seed ${seed}: ${speechCalls(choice)} vs ${speechCalls(old)}`);
    assert.ok(choice.calls <= old.calls, `seed ${seed}: ${choice.calls} vs ${old.calls} small-model calls`);
    assert.equal(choice.opportunities.speech, (choice.owners.inner ?? 0) + (choice.owners.quiet ?? 0), `seed ${seed}: every opportunity had one owner`);
  }
});

test('a day where every line she tries is said: never more lines, still 30 minutes apart and at most 2 an hour', async () => {
  for (const seed of [1, 2, 4]) {
    const { old, choice } = await compareDay(seed, speak);
    assert.ok(choice.spoken.length <= old.spoken.length, `seed ${seed}: ${choice.spoken.length} vs ${old.spoken.length} lines`);
    assert.ok(choice.calls <= old.calls, `seed ${seed}: small-model calls ${choice.calls} vs ${old.calls}`);
    for (const gap of spacing(choice.speechAt)) assert.ok(gap >= 30 * MINUTE, `seed ${seed}: ${gap / MINUTE} min`);
    for (const at of choice.speechAt) assert.ok(choice.speechAt.filter(t => t > at - 60 * MINUTE && t <= at).length <= 2, `seed ${seed}`);
  }
});

test('an evening of 一起听: the same pause-point opportunities, never more lines, never more chat-model calls', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { old, choice } = await compareNight(seed);
    assert.equal(choice.pauses, old.pauses, `seed ${seed}: the same evening`);
    assert.equal(choice.cues, old.cues, `seed ${seed}: the same opportunities`);
    assert.ok(choice.spoken <= old.spoken, `seed ${seed}: ${choice.spoken} vs ${old.spoken}`);
    assert.ok(choice.chatCalls <= old.chatCalls, `seed ${seed}: chat model ${choice.chatCalls} vs ${old.chatCalls}`);
    assert.equal(choice.haikuCalls, old.haikuCalls, `seed ${seed}: the notes cost the same`);
    for (const gap of spacing(choice.spokenTimes)) assert.ok(gap >= 30, `seed ${seed}: ${gap} min apart`);
  }
});
