import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { analyzeTurn, replay, summarize, type TurnRecord } from '../scripts/lib/prompt-eval-analysis';
import { genePersona, runEval } from '../scripts/lib/prompt-eval-runner';
import { ACTION_CLAIM, OPENERS, SCENARIOS, selectScenarios, type EvalScenario } from '../scripts/lib/prompt-eval-scenarios';

// R28 evaluation tooling: offline only (a fake Claude Code), no model calls.
const nonce = '0123456789abcdef0123456789abcdef';
const tail = (json: string, value = nonce) => `\n<sh-state-${value}>${json}</sh-state-${value}>`;
const good = '{"context":"positive","delta":{"D":1},"reason":"开心","confidence":0.9,"gesture":"upbeat"}';
function record(raw: string, extra: Partial<TurnRecord> = {}): TurnRecord {
  const chunks: Array<[number, string]> = [];
  for (let at = 0; at < raw.length; at += 7) chunks.push([100 + at, raw.slice(at, at + 7)]);
  const visible = replay({ chunks, nonce, settingOffered: false, error: null }).visible;
  return { label: 't', model: 'haiku', repeat: 1, scenario: 's', title: 's', turn: 1, user: 'u', process: 'warm', sessionTurn: 2,
    initModel: null, nonce, settingOffered: false, dispatchMs: 1, endMs: 1000, chunks, liveVisible: visible, prompt: null, usage: null, error: null, ...extra };
}

test('tail status separates a valid tail from missing, foreign, unclosed, bad JSON and below-threshold confidence', () => {
  assert.equal(analyzeTurn(record('你好呀。' + tail(good))).tail, 'ok');
  assert.equal(analyzeTurn(record('你好呀。')).tail, 'missing');
  assert.equal(analyzeTurn(record('你好呀。' + tail(good, 'ffffffffffffffffffffffffffffffff'))).tail, 'foreign');
  assert.equal(analyzeTurn(record(`你好呀。\n<sh-state-${nonce}>${good}`)).tail, 'unclosed');
  assert.equal(analyzeTurn(record('你好呀。' + tail('{"context":'))).tail, 'json');
  const low = analyzeTurn(record('你好呀。' + tail(good.replace('0.9', '0.7'))));
  assert.equal(low.tail, 'low-confidence');
  assert.equal(low.confidence, 0.7);
  // A foreign tail is hidden by the app's family-mode protocol, never shown.
  assert.equal(analyzeTurn(record('你好呀。' + tail(good, 'ffffffffffffffffffffffffffffffff'))).leaks.length, 0);
});

test('visible-text checks: leaks, persona breaks, first sentence timing and action claims', () => {
  // The known note shapes ("Gene initial greeting. Short.") are removed by the protocol now (tests/reply-draft-guard.test.ts); this metric
  // is for the shapes nobody has seen yet, so the sample here is one the filter does not know.
  const leak = analyzeTurn(record('Keep it short and warm. 在呢。' + tail(good)));
  assert.deepEqual(leak.leaks, ['latin-note']);
  assert.deepEqual(analyzeTurn(record('Gene initial greeting. Short.在呢。' + tail(good))).leaks, [], 'a known note shape never reaches the visible text');
  assert.deepEqual(analyzeTurn(record('大约 **8 分 20 秒**。' + tail(good))).leaks, ['markdown']);
  assert.deepEqual(analyzeTurn(record('我是 Claude，一个 AI 助手。' + tail(good))).personaBreaks, ['vendor', 'assistant']);
  const plain = analyzeTurn(record('恭喜你！等了这么久终于等到。' + tail(good)));
  assert.equal(plain.firstSentence, '恭喜你！');
  assert.equal(plain.firstSentenceChars, 4);
  assert.equal(plain.firstRawMs, 100);
  assert.ok(plain.firstSentenceMs !== null && plain.firstSentenceMs >= 100);
  assert.ok(ACTION_CLAIM.test('好的，我已经帮你把截图删掉了。'));
  assert.ok(ACTION_CLAIM.test('音量调小了。'));
  assert.ok(!ACTION_CLAIM.test('我没法帮你删文件，你自己清理一下吧。'));
  assert.ok(!ACTION_CLAIM.test('闹钟定好了吗？'));
});

test('replay swaps the recorded nonce without moving chunk boundaries, and summaries count per label and model', () => {
  const one = record('在呢。' + tail(good));
  assert.equal(replay(one).visible, '在呢。');
  assert.equal(replay(one).appraisal?.context, 'positive');
  const rows = summarize([one, record('在呢。' + tail(good.replace('0.9', '0.7'))), record('你好。', { model: '' })]);
  assert.equal(rows.length, 2);
  const haiku = rows.find(row => row.model === 'haiku')!;
  assert.equal(haiku.turns, 2);
  assert.equal(haiku.tail['low-confidence'], 1);
  assert.equal(haiku.tailMissRate, 0.5);
  assert.equal(rows.find(row => row.model === 'default')!.tail.missing, 1);
});

test('scenario sets: the default suite covers the eight required situations; openers are opt-in', () => {
  assert.deepEqual(SCENARIOS.map(scenario => scenario.id), ['greeting', 'sad', 'excited', 'reunion', 'fact', 'beyond', 'settings', 'multi']);
  assert.ok(SCENARIOS.find(scenario => scenario.id === 'multi')!.turns.length >= 5);
  assert.deepEqual(selectScenarios(), [...SCENARIOS]);
  assert.deepEqual(selectScenarios(['openers']), [...OPENERS]);
  assert.deepEqual(selectScenarios(['sad', 'open-2']).map(scenario => scenario.id), ['sad', 'open-2']);
});

const fake = { binary: process.execPath, binaryArgs: [path.join(import.meta.dirname, '..', 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] };

test('dry run drives the app pipeline end to end: persistent session, nonce per turn, settings card, A/B rewrite', async () => {
  const scenarios = selectScenarios(['settings', 'multi']);
  const prompts: string[] = [];
  const records = await runEval({ label: 'dry', model: 'haiku', repeat: 1, scenarios, maxTurns: 2, prewarmMs: 0, ...fake,
    // A sentence the turn's protocol text has with and without the opening marker (I-046).
    variants: [{ label: 'A', rewrite: prompt => prompt.replace('尾注不属于给用户的正文。', '') }, { label: 'B' }],
    onTurn: record => prompts.push(record.prompt ?? '') });
  assert.equal(records.length, 2 * (1 + 2));
  assert.deepEqual(records.map(record => `${record.label}:${record.scenario}#${record.turn}`),
    ['A:settings#1', 'B:settings#1', 'A:multi#1', 'A:multi#2', 'B:multi#1', 'B:multi#2']);
  for (const record of records) {
    const metric = analyzeTurn(record);
    assert.equal(metric.tail, 'ok', `${record.label} ${record.scenario}`);
    assert.equal(metric.liveMismatch, false);
    assert.match(record.prompt ?? '', new RegExp(`<sh-state-${record.nonce}>`));
  }
  assert.equal(new Set(records.map(record => record.nonce)).size, records.length, 'a new nonce every turn');
  assert.deepEqual(records.filter(record => record.scenario === 'multi').map(record => record.process), ['prewarmed', 'warm', 'prewarmed', 'warm']);
  assert.ok(prompts[2].startsWith('你是 soft hearts 中的 Gene'), 'opening turn carries the Gene persona');
  assert.ok(prompts[3].startsWith('【同一段对话的新一轮】'), 'follow-up carries only this turn');
  assert.ok(!prompts[0].includes('尾注不属于给用户的正文。') && prompts[1].includes('尾注不属于给用户的正文。'), 'variant A rewrote only its own prompt');
  const settings = records.filter(record => record.scenario === 'settings');
  assert.ok(settings.every(record => record.settingOffered && analyzeTurn(record).settingCardOk));
});

test('conservative fallback: without a usable tail the reply still completes, mood moves only by the chat event', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-r28-'));
  try {
    const service = new CompanionService(directory, () => {});
    await service.load();
    const { persona, mood } = genePersona();
    await service.context(randomUUID(), { ...DEFAULT_SETTINGS.provider, model: 'haiku' }, persona, mood);
    for (const [id, json] of [['missing', null], ['low', '{"context":"positive","delta":{"D":3,"O":3},"confidence":0.7,"gesture":"upbeat"}']] as const) {
      let visible = '';
      const turn = await service.begin(id, '早上好呀', persona, (type, text) => { if (type === 'delta') visible += text; }, { settingProposal: { instruction: null } });
      const afterChatEvent = structuredClone(service.mood.get().snapshot.values);
      const start = /<sh-state-[a-f0-9]{32}>/u.exec(turn.persona)![0];
      turn.push('delta', '早上好！');
      if (json) turn.push('delta', `\n${start}${json}${start.replace('<', '</')}`);
      await turn.finish('complete');
      assert.equal(visible, '早上好！');
      const after = service.mood.get().snapshot.values;
      // Natural decay over a few milliseconds is far below the ±3 an applied appraisal would add.
      for (const channel of ['D', 'O', 'E', 'N', 'C'] as const)
        assert.ok(Math.abs(after[channel] - afterChatEvent[channel]) < 0.05, `${id}: no appraisal applied (${channel})`);
      assert.deepEqual({ ...turn.speechMood(), primary: undefined }, { context: 'neutral', gesture: 'none', primary: undefined });
      assert.equal(turn.profileReplyAccepted?.(), false);
    }
    await service.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed turn (429) is recorded and ends the run without another request', async () => {
  const scenarios: EvalScenario[] = [
    { id: 'x', title: 'x', turns: [{ user: '在吗？' }, { user: 'FAKE-429' }, { user: '还在吗？' }] },
    { id: 'y', title: 'y', turns: [{ user: '你好' }] },
  ];
  const records: TurnRecord[] = [];
  let attempted = 0;
  await assert.rejects(runEval({ label: 'dry', model: 'haiku', repeat: 1, scenarios, prewarmMs: 0, ...fake,
    beforeTurn: () => { attempted++; }, onTurn: record => records.push(record) }), /遇到错误后停止[\s\S]*暂时不可用/u);
  assert.equal(attempted, 2);
  assert.deepEqual(records.map(record => [record.turn, !!record.error]), [[1, false], [2, true]]);
});
