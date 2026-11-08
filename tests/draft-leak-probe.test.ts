// The draft-leak probe (scripts/lib/draft-leak-probe.ts): the RPS wording A/B (docs/claude/2026-11-03-rps-five-fixes.md)
// must differ only in the game's accept line, and a prompt without the app's line must void the run instead of comparing
// two identical prompts. The F2 candidate (docs/claude/2026-11-03-draft-leak-fix.md) keeps its own rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rpsChatContext } from '../shared/rps-personality';
import { userStateChatLine } from '../shared/user-state';
import { DRAFT_LEAK_CANDIDATE_WORDING, RPS_ACCEPT_OLD, toCandidateUserStateLine, toOldRpsWording } from '../scripts/lib/draft-leak-old-wording';
import { abSummary, callsCount, draftSigns } from '../scripts/lib/draft-leak-probe';
import { compareOutcomes, quantile, type Baseline } from '../scripts/lib/draft-leak-corpus';

const MIN = 60_000;

test('arm A puts the old accept line back and changes nothing else; the F2 candidate swaps only F2\'s line', () => {
  const line = userStateChatLine({ state: 'low', confidence: 0.85, reason: '论文被导师打回', at: 0 }, 20 * MIN);
  const prompt = `开头\n\n${line}\n\n回复节奏……\n\n${rpsChatContext('accept')}\n\n以下JSON……`;
  assert.equal(toOldRpsWording(prompt), `开头\n\n${line}\n\n回复节奏……\n\n${RPS_ACCEPT_OLD}\n\n以下JSON……`);
  assert.throws(() => toOldRpsWording('没有猜拳那一行'), /A\/B 无效/u);
  assert.equal(toCandidateUserStateLine(prompt), `开头\n\n你先前觉得用户低落（约20分钟前，论文被导师打回）。这份感觉只让你说话更体贴，不用提起，不说教，也不劝用户去找别人；用户现在怎样，以这轮的话为准。\n\n回复节奏……\n\n${rpsChatContext('accept')}\n\n以下JSON……`);
  assert.throws(() => toCandidateUserStateLine(rpsChatContext('accept')), /A\/B 无效/u);
  assert.ok(DRAFT_LEAK_CANDIDATE_WORDING.userStateLine.includes('{label}'));
});

test('the new accept line is shorter than the old one, keeps what she needs to know, and has no rule list or "you call it"', () => {
  const now = rpsChatContext('accept');
  assert.ok([...now].length < [...RPS_ACCEPT_OLD].length, `${[...now].length} < ${[...RPS_ACCEPT_OLD].length}`);
  for (const piece of ['三局两胜', '三个按钮', '口令', '出拳', '输赢', '说完后']) assert.ok(now.includes(piece), piece);
  assert.doesNotMatch(now, /不要|不用|简短|一两句|这一轮|由你来喊|"/u);
  assert.match(RPS_ACCEPT_OLD, /由你来喊/u, 'the old one, kept for arm A');
});

test('report helpers: signs of a draft in a visible reply, calling the count herself, and the A/B medians and pairs', () => {
  assert.deepEqual(draftSigns('好呀，三局两胜！'), []);
  assert.ok(draftSigns('Keep it short, the user wants to play. 好呀').includes('english'));
  assert.ok(draftSigns('用户想玩，答应就好。').includes('third-person-user'));
  assert.equal(callsCount('好呀！石头——剪刀——布！'), true); assert.equal(callsCount('石头、剪刀、布'), true);
  assert.equal(callsCount('好呀，三个按钮出来了就开始'), false);
  const sample = (variant: string, ms: number, round: number) => ({ phase: 'ab', variant, round, card: 'gene' as const,
    record: { chunks: [[ms, '好']], error: null, scenario: 'rps-open', turn: 1 } as never });
  const summary = abSummary([sample('A', 1000, 1), sample('A', 2000, 2), sample('B', 1100, 1), sample('B', 1900, 2)], () => 0.5);
  assert.match(summary, /A（旧措辞）2 条，中位 1500 ms；B（应用现在的措辞）2 条，中位 1500 ms；差 0 ms/u);
  assert.match(summary, /配对 2 对，配对差中位 0 ms，B 更快 1 对/u);
});

test('corpus before/after: first-character delay over every reply, the affected share, and changed replies', () => {
  const before: Baseline = {};
  const after: Baseline = {};
  for (let i = 0; i < 20; i++) {
    before[`r${i}`] = { visible: '好呀', first: 1000, emptied: false };
    after[`r${i}`] = { visible: '好呀', first: i < 2 ? 1300 + i * 100 : 1000, emptied: false };
  }
  before.plan = { visible: '这一轮回复短些。', first: 900, emptied: false };
  after.plan = { visible: '', first: null, emptied: true };
  const result = compareOutcomes(before, after);
  assert.equal(result.compared, 20, 'only replies that showed something both times');
  assert.deepEqual(result.changed, ['plan']);
  assert.equal(result.median, 0);
  assert.equal(result.p90, 0, 'two of twenty later: the 90th percentile is still unchanged');
  assert.deepEqual(result.affected, [300, 400]);
  assert.equal(result.affectedMax, 400);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([5, 1, 3], 0.5), 3);
});
