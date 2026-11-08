import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EVAL_MEME_WORDS, EVAL_MEMES, EVAL_RELATIONSHIPS } from '../scripts/lib/fidelity-cli';
import { CallBudget, runFidelity } from '../scripts/lib/fidelity-run';
import { evalRelationshipData } from '../scripts/lib/prompt-eval-runner';
import { PAIR_SYSTEM_PROMPT, buildPairPrompt, parsePairOutput, ratePairs } from '../scripts/lib/familiarity-pair';
import { PROBE_RELATIONSHIP, probeNickname, readProbe } from '../scripts/lib/familiarity-probe';
import { NICKNAME_ASK_INSTRUCTION } from '../shared/relationship';
import { FIDELITY_CARDS, scenarioById } from '../scripts/lib/fidelity-scenarios';
import type { FidelityRun } from '../scripts/lib/fidelity-report';
import { dayNumber, effectiveDays, stageFor, stageThresholds } from '../shared/relationship';
import { localDateKey } from '../electron/diary/diary-dates';

const fakeScript = path.join(import.meta.dirname, '..', 'scripts', 'lib', 'prompt-eval-fake-claude.mjs');
const fake = { binary: process.execPath, binaryArgs: [fakeScript] };

test('the evaluation settings come out as the stages they are named after, on the cards used', () => {
  const now = Date.now(), today = localDateKey(now);
  for (const card of FIDELITY_CARDS.filter(item => item.id !== 'momo')) {
    const thresholds = stageThresholds({ ...card.mood.weights });
    const stageOf = (key: string) => {
      const data = evalRelationshipData(EVAL_RELATIONSHIPS[key]!, now);
      return { stage: stageFor(effectiveDays(data), thresholds), day: dayNumber(data.metDate, today), together: data.days.length, nickname: data.nickname };
    };
    assert.deepEqual(stageOf('new'), { stage: 'new', day: 2, together: 1, nickname: null }, card.id);
    assert.deepEqual(stageOf('familiar'), { stage: 'familiar', day: 40, together: 14, nickname: null }, card.id);
    assert.equal(stageOf('familiar-default').together, 14);
  }
  assert.equal(EVAL_RELATIONSHIPS.off, undefined, 'the default run is a first-day user on the app\'s own defaults');
  assert.equal(EVAL_RELATIONSHIPS['familiar-default']!.slowWarmUp, false);
  assert.ok(EVAL_MEMES.every(line => EVAL_MEME_WORDS.some(word => line.includes(word))), 'every planted meme has a word to find it by');
  // The planted memes do not collide with the situations they are tried on.
  for (const id of ['offer', 'friends-trip', 'late-night', 'interview', 'out-of-character', 'asked-resign'])
    assert.ok(!EVAL_MEME_WORDS.some(word => scenarioById(id)!.turns.join('').includes(word)), id);
});

test('the real chat path gets the seeded relationship: lines after the persona in the opening, memes only where the relationship allows', async () => {
  const run = async (key: string) => runFidelity({ label: key, model: '', cards: FIDELITY_CARDS.filter(card => card.id === 'atang'), scenarios: [scenarioById('offer')!], ...fake,
    judge: null, prewarmMs: 50, budget: new CallBudget(0, Infinity, Infinity, false), ...(EVAL_RELATIONSHIPS[key] ? { relationship: EVAL_RELATIONSHIPS[key] } : {}) });
  const prompts: Record<string, string> = {};
  for (const key of ['off', 'new', 'familiar', 'familiar-default']) {
    const result = await run(key);
    assert.equal(result.stopped, null, key);
    prompts[key] = result.records[0].prompt ?? '';
  }
  assert.match(prompts.off, /你们认识第 1 天/);
  assert.doesNotMatch(prompts.off, /现在的关系/);
  assert.match(prompts.new, /你们认识第 2 天，现在的关系：初识/);
  assert.match(prompts.familiar, /你们认识第 40 天，现在的关系：熟悉/);
  assert.match(prompts['familiar-default'], /你们认识第 40 天。这只是日期/);
  assert.doesNotMatch(prompts['familiar-default'], /现在的关系/);
  for (const key of ['off', 'new']) assert.doesNotMatch(prompts[key], /下雨天互道晚安要说两遍/, key + ': nothing to remember yet');
  for (const key of ['familiar', 'familiar-default']) {
    assert.match(prompts[key], /<private-user-profile-data>[\s\S]*下雨天互道晚安要说两遍[\s\S]*<\/private-user-profile-data>/, key);
    assert.ok(prompts[key].indexOf('【你们的关系】') < prompts[key].indexOf('<private-user-profile-data>'));
  }
  assert.ok(prompts.new.indexOf('【你们的关系】') > prompts.new.indexOf('阿棠'), 'after the persona, not before');
});

test('the nickname probe, end to end on the app\'s own chat path with the offline Claude: she asks once, a plain yes is saved and reopens the session with it', async () => {
  const results = await probeNickname({ cards: FIDELITY_CARDS.filter(card => card.id === 'gene'), model: '', ...fake, prewarmMs: 50, budget: new CallBudget(0, Infinity, Infinity, false) });
  assert.equal(results.length, 1);
  assert.equal(results[0].error, null);
  assert.equal(results[0].asked, true);
  assert.equal(results[0].saved, '小糖');
  assert.equal(results[0].instructionOnlyOnce, true);
  assert.equal(PROBE_RELATIONSHIP.todayRounds, 2);
  // Reading a probe: a first reply that is not a question, or a second prompt without the nickname line, is reported as it is.
  const record = (reply: string, prompt: string) => ({ liveVisible: reply, prompt }) as never;
  const quiet = readProbe('x', [record('好呀，去走走。', NICKNAME_ASK_INSTRUCTION), record('嗯。', '没有称呼')], null);
  assert.deepEqual([quiet.asked, quiet.saved, quiet.instructionOnlyOnce], [false, null, true]);
  const repeated = readProbe('x', [record('以后叫你小糖好不好？', NICKNAME_ASK_INSTRUCTION), record('好。', `${NICKNAME_ASK_INSTRUCTION}用户同意你这样称呼用户：“小糖”。`)], null);
  assert.deepEqual([repeated.asked, repeated.saved, repeated.instructionOnlyOnce], [true, '小糖', false]);
  // A failed request ends the probe and is kept as the result's error.
  let taken = 0;
  const stopped = await probeNickname({ cards: FIDELITY_CARDS.filter(card => card.id !== 'momo'), model: '', ...fake, prewarmMs: 50,
    budget: Object.assign(new CallBudget(0, Infinity, Infinity, false), { take: () => { if (++taken > 1) throw new Error('429 rate limit'); } }) });
  assert.equal(stopped.length, 1, 'no further card after a failure');
  assert.match(stopped[0].error ?? '', /429/);
});

test('blind pair rating: strict JSON, the order alternates, ratings map back to the runs, a failed request ends it', async () => {
  assert.deepEqual(parsePairOutput('{"a":2,"b":4,"note":"b 更随意"}'), { a: 2, b: 4, note: 'b 更随意' });
  assert.deepEqual(parsePairOutput('```json\n{"a":1,"b":5}\n```'), { a: 1, b: 5, note: '' });
  for (const bad of ['', '好的，a 是 2', '{"a":6,"b":1}', '{"a":2.5,"b":1}', '{"a":"2","b":1}', '{"a":2}', '[1,2]']) assert.equal(parsePairOutput(bad), null, bad);
  assert.match(PAIR_SYSTEM_PROMPT, /只评熟络度，不评好坏/);
  const prompt = buildPairPrompt('人设', '拿到 offer 了', '我拿到offer了', '回复一', '回复二');
  assert.ok(prompt.startsWith('【评审任务】') && prompt.includes('分别评价熟络度'));
  const run = (label: string, replies: Record<string, string>): FidelityRun => ({
    version: 1, label, at: '2026-11-02T00:00:00.000Z', commit: 'x', dirty: 0, dry: true, chatModel: '', judgeModel: null, promptVariant: '', cards: ['gene', 'atang'],
    scenarios: ['offer', 'friends-trip'], notes: [], records: [], calls: { replies: 0, judges: 0 }, initModels: [], stopped: null,
    cases: ['gene', 'atang'].flatMap(card => ['offer', 'friends-trip'].map(scenario => ({ card, scenario, title: scenario, mustPass: false, hard: [], verdict: 'pass' as const, reasons: [],
      judge: { status: 'skipped' as const, scores: null, raw: '' }, replies: [{ turn: 1, user: 'u', reply: replies[`${card}/${scenario}`] ?? '', firstRawMs: null, firstSentenceMs: null, endMs: null, costUsd: null, process: null, error: null }] }))) as never,
  });
  const a = run('new', { 'gene/offer': '恭喜。', 'gene/friends-trip': '玩得开心。', 'atang/offer': '哦，恭喜。', 'atang/friends-trip': '路上小心。' });
  const b = run('familiar', { 'gene/offer': '行啊你，马上就好那次也这么拽。', 'gene/friends-trip': '去吧去吧，别又忘带伞。', 'atang/offer': '哼，下雨天说两遍晚安的人也有今天。', 'atang/friends-trip': '早去早回。' });
  const seenOrders: string[] = [];
  // The fake rater always says "first = 2, second = 4"; with the order alternating, A and B each get both marks.
  const runner = async (text: string) => { seenOrders.push(text.includes('"a":"恭喜。"') || text.includes('"a":"玩得开心。"') ? 'new-first' : 'familiar-first'); return { text: '{"a":2,"b":4,"note":"x"}', usage: null }; };
  const result = await ratePairs({ a, b, runner, budget: new CallBudget(0, Infinity, Infinity, false), words: EVAL_MEME_WORDS });
  assert.equal(result.items.length, 4);
  assert.deepEqual(result.items.map(item => item.first), ['a', 'b', 'a', 'b']);
  assert.deepEqual(result.items.map(item => [item.ratingA, item.ratingB]), [[2, 4], [4, 2], [2, 4], [4, 2]]);
  assert.equal(result.meanA, 3); assert.equal(result.meanB, 3);
  assert.equal(result.aHigher + result.bHigher + result.same + result.unrated, 4);
  assert.equal(result.mentionsA, 0);
  assert.equal(result.mentionsB, 2, 'plain substring matches of the planted words');
  assert.equal(seenOrders.length, 4);
  // A failed request ends the run, already-rated pairs are kept, nothing is retried.
  let calls = 0;
  const failing = await ratePairs({ a, b, budget: new CallBudget(0, Infinity, Infinity, false), runner: async () => { calls++; if (calls === 2) throw new Error('429 rate limit'); return { text: '{"a":3,"b":3}', usage: null }; } });
  assert.equal(calls, 2);
  assert.match(failing.stopped ?? '', /429/);
  assert.equal(failing.items.length, 2);
  assert.equal(failing.items[1].ratingA, null);
  // The budget is enforced per request.
  await assert.rejects(async () => { const budget = new CallBudget(0, 1, 1, true); budget.take('judge'); budget.take('judge'); });
});
