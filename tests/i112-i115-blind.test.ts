import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  keepOnResume, replyKey,
  BLIND_VERSIONS, KIND_LABELS, SCENARIO_KINDS, SCENARIO_MOODS, buildSheet, countLeaks, externalReplies, formatReport, parseExtraReplies, runBlind, tallyPicks,
  versionStats, writeBlindOutputs, type BlindReply,
} from '../scripts/lib/i112-i115-blind';
import { runJudge, parseJudgePick } from '../scripts/lib/i112-i115-judge';
import { i115Scenarios } from '../scripts/lib/i115-scenarios';
import { FIDELITY_CARDS } from '../scripts/lib/fidelity-scenarios';
import { CallBudget } from '../scripts/lib/fidelity-run';
import { getPromptSwitches } from '../shared/brain/prompt-switches';
import { claudeSessionSystemPrompt } from '../electron/brain/claude-session-prompt';

const row = (scenario: string, sample: number, version: number, text: string): BlindReply =>
  ({ scenario, sample, title: scenario, user: 'u', version, text, leaks: countLeaks(text), error: null, chars: [...text].length });

test('blind harness: leak counts see labels, English, digits and bracketed notes', () => {
  assert.deepEqual(countLeaks('今天很好。'), { labels: 0, english: 0, digits: 0, brackets: 0 });
  const leaks = countLeaks('主感受开心 ok 3次（笑）');
  assert.ok(leaks.labels >= 1 && leaks.english === 1 && leaks.digits === 1 && leaks.brackets === 1);
});

test('blind harness: one page per situation and sample, four shuffled replies, no version names, the key tallies picks per kind', () => {
  const replies = ['betrayed', 'pudding'].flatMap(s => [1, 2].flatMap(sample => BLIND_VERSIONS.map(v => row(s, sample, v.id, `r${s}${sample}${v.id}`))));
  const { items, key } = buildSheet(replies, 3);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.page), ['betrayed#1', 'betrayed#2', 'pudding#1', 'pudding#2']);
  assert.ok(items.every(item => item.options.length === 4));
  assert.ok(!JSON.stringify(items).includes('版本'));
  const picks = Object.fromEntries(key.pages.map(entry => [entry.page, Object.keys(entry.slots).find(slot => entry.slots[slot] === 4)!]));
  const tally = tallyPicks(picks, key);
  assert.equal(tally.byVersion['4'], 4);
  assert.equal(tally.byKind.feelings.byVersion['4'], 2);
  assert.equal(tally.byKind.light.byVersion['4'], 2);
});

test('blind harness: every situation has a kind and a mood, light ones a light mood and heavy kinds a heavy one', () => {
  const ids = i115Scenarios().map(s => s.id);
  assert.equal(ids.length, 15);
  for (const id of ids) { assert.ok(SCENARIO_KINDS[id], id); assert.ok(SCENARIO_MOODS[id], id); }
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), ['boundaries', 'feelings', 'light']);
  for (const id of ids.filter(i => SCENARIO_KINDS[i] === 'feelings')) assert.ok(['sad', 'longing', 'disappointed', 'concerned', 'upset', 'afraid'].includes(SCENARIO_MOODS[id]!), id);
  for (const id of ids.filter(i => SCENARIO_KINDS[i] === 'light')) assert.ok(['calm', 'happy', 'content'].includes(SCENARIO_MOODS[id]!), id);
});

test('blind harness: version stats count leaking replies, average length and light-situation length', () => {
  const replies = [row('banter', 1, 1, '哈哈'), row('betrayed', 1, 1, '我在这。（抱）'), row('banter', 1, 2, '一二三四')];
  const stats = versionStats(replies);
  assert.equal(stats['1']!.replies, 2);
  assert.equal(stats['1']!.leakReplies, 1);
  assert.equal(stats['1']!.avgCharsLight, 2);
  assert.equal(stats['2']!.avgCharsLight, 4);
  assert.ok(formatReport({ 用户: tallyPicks({}, { seed: 1, pages: [] }) }, stats).some(line => line.includes('轻松情景平均')));
});

test('extra replies: validated strictly, one reply is reused for both samples, shown as version 5 and counted like the others', () => {
  const ok = parseExtraReplies(JSON.stringify({ label: 'external', replies: { banter: ['哼'], pudding: ['气死了', '再买一个'] } }));
  const rows = externalReplies(ok, i115Scenarios(), 2);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter(r => r.scenario === 'banter').map(r => r.text), ['哼', '哼']);
  assert.deepEqual(rows.filter(r => r.scenario === 'pudding').map(r => r.text), ['气死了', '再买一个']);
  assert.ok(rows.every(r => r.version === 5 && r.chars > 0));
  const replies = [...BLIND_VERSIONS.map(v => row('banter', 1, v.id, `x${v.id}`)), rows.find(r => r.scenario === 'banter' && r.sample === 1)!];
  assert.equal(buildSheet(replies, 1).items[0]!.options.length, 5);
  assert.throws(() => parseExtraReplies('{nope'), /JSON/u);
  assert.throws(() => parseExtraReplies('[]'), /对象/u);
  assert.throws(() => parseExtraReplies(JSON.stringify({ label: 'x', replies: { nonsense: ['a'] } })), /不认识/u);
  assert.throws(() => parseExtraReplies(JSON.stringify({ label: 'x', replies: { banter: [] } })), /1 到 2/u);
  assert.throws(() => parseExtraReplies(JSON.stringify({ label: 'x', replies: { banter: [3] } })), /字符串/u);
  assert.throws(() => parseExtraReplies(JSON.stringify({ label: 'x', replies: { banter: ['长'.repeat(1001)] } })), /超过/u);
  assert.throws(() => parseExtraReplies(JSON.stringify({ replies: {} })), /label/u);
});

test('judge: parses strict JSON with an existing slot, anything else is null; fake judge picks a slot per page', async () => {
  assert.deepEqual(parseJudgePick('{"pick":"b","why":"像"}', ['A', 'B']), { pick: 'B', why: '像' });
  assert.equal(parseJudgePick('{"pick":"E"}', ['A', 'B']), null);
  assert.equal(parseJudgePick('不错', ['A', 'B']), null);
  const items = [{ page: 'a#1', scenario: 'a', sample: 1, title: 't', user: 'u', options: [{ slot: 'A', text: 'x' }, { slot: 'B', text: 'y' }] }];
  const file = await runJudge({ persona: 'p', items, model: 'sonnet', binary: '', budget: new CallBudget(0, 0, 0, false), fake: true, seed: 2 });
  assert.ok(['A', 'B'].includes(file.picks['a#1']!));
  assert.equal(file.stopped, undefined);
});

test('blind harness --fake runs offline: four versions per situation and sample, router branches read, sheet written, switches reset after', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'soft-blind-'));
  try {
    const scenarios = i115Scenarios().filter(s => ['betrayed', 'plan-no-ask'].includes(s.id));
    const fake = path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'prompt-eval-fake-claude.mjs');
    const result = await runBlind({ card: FIDELITY_CARDS[0]!, model: '', binary: process.execPath, binaryArgs: [fake], prewarmMs: 100,
      budget: new CallBudget(0, Infinity, Infinity, false), seed: 5, scenarios, samples: 2 });
    assert.equal(result.stopped, null);
    assert.equal(result.replies.length, scenarios.length * 4 * 2);
    const routed = result.replies.filter(r => r.version === 4);
    // Heavy mood (concerned) takes the situation text; a calm mood with a plan stated without a question takes the short why and the plain mood text.
    assert.ok(routed.filter(r => r.scenario === 'betrayed').every(r => r.route?.mood === 'situation' && r.route.why === false));
    assert.ok(routed.filter(r => r.scenario === 'plan-no-ask').every(r => r.route?.mood === 'v1' && r.route.why === true));
    assert.ok(result.replies.filter(r => r.version === 1).every(r => r.route?.mood === 'v1' && !r.route.why));
    assert.ok(result.replies.filter(r => r.version === 2).every(r => r.route?.mood === 'situation'));
    const written = await writeBlindOutputs(out, result.replies, 5, { fake: true });
    assert.equal(written.sheetItems, 4);
    assert.match(await readFile(written.files.sheet, 'utf8'), /下载结果/u);
    assert.deepEqual(getPromptSwitches(), { why: false, situation: false });
    assert.equal(i115Scenarios().length * BLIND_VERSIONS.length * 2, 120);
    assert.notEqual(claudeSessionSystemPrompt({ why: 'short' }), claudeSessionSystemPrompt({ why: false }));
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('--resume keeps good replies and asks again for empty or broken ones', () => {
  const base = { title: 't', user: 'u', leaks: { labels: 0, english: 0, digits: 0, brackets: 0 }, route: null } as const;
  assert.equal(keepOnResume({ ...base, scenario: 'pudding', sample: 1, version: 4, text: '', chars: 0, error: null } as never), false, 'empty is asked again');
  assert.equal(keepOnResume({ ...base, scenario: 'pudding', sample: 2, version: 4, text: '给你留着的话的', chars: 7, error: null } as never), false, 'a 7-character fragment is asked again');
  assert.equal(keepOnResume({ ...base, scenario: 'offer', sample: 1, version: 2, text: '真的？最想去的那家！太好了，等了一个多月终于等到了。', chars: 26, error: null } as never), true);
  assert.equal(keepOnResume({ ...base, scenario: 'offer', sample: 1, version: 2, text: '真的？最想去的那家！太好了，等了一个多月终于等到了。', chars: 26, error: 'timeout' } as never), false, 'an error is asked again');
  assert.equal(replyKey('offer', 2, 3), 'offer#2#3');
});
