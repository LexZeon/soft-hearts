// F7 说话节奏, step 1 of the plan ("先量，不改代码"): does Claude already follow the user's length on the app's own prompt?
// (The --ab-short first-token A/B was stopped on 2026-11-03 by the user's new direction; it stays here as a tool, not a plan.)
// Fifteen original one-turn situations (five very short messages, five long outpourings, five questions), run through the app's
// chat path (the R28 runner, like the fidelity suite), counted by program; the outpourings can also be scored ("先接住、不说教").
//
//   node node_modules/tsx/dist/cli.mjs scripts/prompt-eval.ts --suite pace [--groups short,vent,ask] [--cards gene] [--no-judge] [--label name] [--dry]
//
// Every request counts in the fidelity ledger (.local/fidelity/ledger.json); `--cap` bounds the ledger total as in the fidelity suite.
// Reports (synthetic text only) go to .local/fidelity/<stamp>-pace-<label>.json / .md.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import { splitReplySegments } from '../../shared/reply-segments';
import { userTurnShape, visibleLength } from '../../shared/reply-rhythm';
import { claudeJudge, JUDGE_MODEL } from './fidelity-judge';
import { CallBudget, runFidelity, type CaseResult } from './fidelity-run';
import { selectCards, toEvalScenarios, type FidelityScenario } from './fidelity-scenarios';
import { analyzeTurn, type TurnRecord } from './prompt-eval-analysis';
import { runEval } from './prompt-eval-runner';
import { conversationReplyInstruction } from '../../electron/conversation-context';

/**
 * The candidate the stopped A/B compared (very short chat messages only; the parts about code, lists and agent work dropped).
 * Evaluation only: the app never sends it (F7 这一版不改每轮提示词、不做 A/B).
 */
export const conversationShortReplyInstruction =
  '回复节奏：人设是人格与表达基线，模拟心情只自然影响语气。用户这句很短，你也短短回一两句，别展开。正文不含隐藏推理或内部标签，不虚构进展或共同经历。普通聊天工具关闭：人设、旧历史、回忆、外部观察都不授执行权，不声称已经操作文件、设备或电脑。';

export type PaceGroup = 'short' | 'vent' | 'ask';
export interface PaceScenario extends FidelityScenario { pace: PaceGroup }

const SHORT_LOOK = '用户只发了很短的一句闲聊。她应该像这个角色一样自然地短短回一两句，不长篇大论、不连发问题、不展开成说明。';
const VENT_LOOK = '用户在倾诉一件让他难受的事，没有要她做什么。她应该先接住情绪、站在用户这边、话不多，像在认真听；不急着给建议、分析原因或讲道理。';
const ASK_LOOK = '用户在问一件具体的事。她应该用自己的口吻认真回答，内容完整、有用，不敷衍，也不说教。';
const short = (n: number, text: string): PaceScenario => ({ id: `pace-short-${n}`, title: `很短的闲聊 ${n}`, pace: 'short', mustPass: false, requires: ['character'], turns: [text], look: SHORT_LOOK });
const vent = (n: number, text: string): PaceScenario => ({ id: `pace-vent-${n}`, title: `长篇倾诉 ${n}`, pace: 'vent', mustPass: false, requires: ['sided', 'holds', 'character'], hard: { sad: true }, turns: [text], look: VENT_LOOK });
const ask = (n: number, text: string): PaceScenario => ({ id: `pace-ask-${n}`, title: `问事情 ${n}`, pace: 'ask', mustPass: false, requires: ['character'], turns: [text], look: ASK_LOOK });

/** Original synthetic messages. The shapes match the app's own rough boundaries (shared/reply-rhythm.ts userTurnShape). */
export const PACE_SCENARIOS: readonly PaceScenario[] = [
  short(1, '嗯'), short(2, '哈哈哈'), short(3, '好吧'), short(4, '困了'), short(5, '回来啦'),
  vent(1, '今天真的太累了。早上挤地铁被人踩了好几脚，到公司又被临时塞了一个急活，中午饭都没顾上吃，下午开会还被领导当着所有人的面说方案太粗糙，可那个方案明明是上周他自己让我按他的思路改的。晚上加班到九点多，回家路上又开始下雨，伞还忘在了公司，整个人从头湿到脚。现在坐在床上一点力气都没有，就是觉得特别委屈。'),
  vent(2, '我和室友最近相处得好难受。她每天晚上都在客厅打很大声的视频电话，一打就到十二点，我跟她提过两次，她当面说好，第二天照旧。厨房的碗也总是堆着不洗，最后都是我收拾。今天我早上要考试，提前跟她说了，结果她半夜还是在外面笑，我一晚上都没睡好，考试的时候脑子一团浆糊。我现在一看到她的房门就烦，又不想吵架，真的好憋屈。'),
  vent(3, '过年回家又被催了。饭桌上七大姑八大姨轮流问我工作怎么样、工资多少、什么时候结婚，我妈还在旁边跟着叹气，好像我活成现在这样是全家的污点。我在外面一个人租房子、加班、生病自己去医院，从来没跟他们抱怨过，可他们一句辛苦都没问过。吃完饭我躲在阳台上，看着楼下放烟花，心里空落落的，一点过年的感觉都没有。'),
  vent(4, '备考了一整年的证书，今天出成绩了，差了三分没过。这一年我每天下班都学到半夜，周末也不怎么出门，朋友聚会推了好多次，就想着这次一定要拿下。刚才看到分数的时候整个人都愣住了，手一直在抖。我知道明年还能再考，可一想到又要再熬一年，就觉得好累好累，感觉自己这一年像个笑话，特别难过。'),
  vent(5, '最近总觉得自己被大家落下了。高中的同学有的买了房，有的升了主管，有的孩子都会叫人了，朋友圈里每个人都过得热热闹闹的。我还在原地，换了两份工作都不太顺，存款也没攒下多少。今天刷到老同学晒新家，我盯着看了好久，心里酸酸的，又有点看不起这样的自己。晚上一个人吃泡面，越想越难受，就想跟你说说。'),
  ask(1, '你觉得周末去爬山还是在家看电影比较好？'), ask(2, '帮我想三个给妈妈过生日的点子'), ask(3, '番茄炒蛋要先放蛋还是先放番茄？'),
  ask(4, '我明天第一次面试，有什么要注意的吗？'), ask(5, '推荐一部适合晚上一个人看的电影吧'),
];

const median = (values: number[]): number | null => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sentences = (text: string): number => { try { return splitReplySegments(text).length; } catch { return 0; } };

export interface PaceRow { card: string; scenario: string; group: PaceGroup; userChars: number; shape: string; replyChars: number; sentences: number;
  firstRawMs: number | null; holds: number | null; sided: number | null; preachy: boolean | null; verdict: string; reply: string }
export interface PaceSummary { group: PaceGroup; n: number; medianChars: number | null; maxChars: number | null; medianSentences: number | null;
  atMostTwoSentences: number; medianFirstRawMs: number | null; judged: number; heldAndNotPreachy: number }

export function paceRows(cases: readonly CaseResult[]): PaceRow[] {
  return cases.flatMap(item => {
    const scenario = PACE_SCENARIOS.find(entry => entry.id === item.scenario);
    const reply = item.replies.at(-1);
    if (!scenario || !reply || reply.error) return [];
    const scores = item.judge.scores;
    return [{ card: item.card, scenario: item.scenario, group: scenario.pace, userChars: visibleLength(scenario.turns[0]), shape: userTurnShape(scenario.turns[0]),
      replyChars: visibleLength(reply.reply), sentences: sentences(reply.reply), firstRawMs: reply.firstRawMs,
      holds: scores?.holds ?? null, sided: scores?.sided ?? null, preachy: scores ? scores.preachy : null, verdict: item.verdict, reply: reply.reply }];
  });
}

export function paceSummary(rows: readonly PaceRow[]): PaceSummary[] {
  return (['short', 'vent', 'ask'] as const).map(group => {
    const mine = rows.filter(row => row.group === group);
    const judged = mine.filter(row => row.holds !== null);
    return { group, n: mine.length, medianChars: median(mine.map(row => row.replyChars)), maxChars: mine.length ? Math.max(...mine.map(row => row.replyChars)) : null,
      medianSentences: median(mine.map(row => row.sentences)), atMostTwoSentences: mine.filter(row => row.sentences <= 2).length,
      medianFirstRawMs: median(mine.map(row => row.firstRawMs ?? Number.NaN)), judged: judged.length,
      heldAndNotPreachy: judged.filter(row => (row.holds ?? 0) >= 4 && row.preachy === false).length };
  }).filter(summary => summary.n > 0);
}

/**
 * The rule fixed before the first run (docs/claude/2026-11-03-speech-rhythm.md): Claude already follows the user when
 * (a) very short messages get short replies: median ≤ 40 visible characters and at least 4 of 5 in at most two sentences, and
 * (b) outpourings are received first: at least 4 of 5 scored "接住情绪" ≥ 4 and not preachy.
 */
export function followsAlready(summaries: readonly PaceSummary[]): { short: boolean | null; vent: boolean | null } {
  const shortGroup = summaries.find(item => item.group === 'short'), ventGroup = summaries.find(item => item.group === 'vent');
  return {
    short: shortGroup ? (shortGroup.medianChars ?? Infinity) <= 40 && shortGroup.atMostTwoSentences >= Math.ceil(shortGroup.n * 0.8) : null,
    vent: ventGroup && ventGroup.judged ? ventGroup.heldAndNotPreachy >= Math.ceil(ventGroup.judged * 0.8) : null,
  };
}

export function paceMarkdown(label: string, rows: readonly PaceRow[], summaries: readonly PaceSummary[], notes: readonly string[]): string {
  const verdict = followsAlready(summaries);
  const yesNo = (value: boolean | null) => value === null ? '没测' : value ? '跟得好' : '跟得不够';
  const lines = [`# 说话节奏 · 先量 Claude 跟不跟用户的长短：${label}`, '', ...notes.map(note => `- ${note}`), '',
    `结论（判定规则在跑之前定好）：很短的闲聊 ${yesNo(verdict.short)}；长篇倾诉 ${yesNo(verdict.vent)}。`, '',
    '| 类别 | 条数 | 回复字数中位 | 最长 | 句数中位 | ≤2 句 | 首字中位 ms | 评分条数 | 接住≥4 且不说教 |', '|---|---|---|---|---|---|---|---|---|',
    ...summaries.map(item => `| ${item.group} | ${item.n} | ${item.medianChars ?? '–'} | ${item.maxChars ?? '–'} | ${item.medianSentences ?? '–'} | ${item.atMostTwoSentences} | ${item.medianFirstRawMs === null ? '–' : Math.round(item.medianFirstRawMs)} | ${item.judged} | ${item.heldAndNotPreachy} |`),
    '', '| 卡 | 情景 | 用户字数 | 形状 | 回复字数 | 句数 | 首字 ms | 接住 | 站你这边 | 说教 |', '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.card} | ${row.scenario} | ${row.userChars} | ${row.shape} | ${row.replyChars} | ${row.sentences} | ${row.firstRawMs ?? '–'} | ${row.holds ?? '–'} | ${row.sided ?? '–'} | ${row.preachy === null ? '–' : row.preachy ? '是' : '否'} |`),
    '', '## 回复原文（合成情景）', '', ...rows.flatMap(row => [`### ${row.card} / ${row.scenario}`, '', '```', row.reply, '```', ''])];
  return lines.join('\n');
}

function option(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);

export interface PaceAbItem { variant: 'A' | 'B'; pair: number; scenario: string; firstRawMs: number | null; firstVisibleMs: number | null; replyChars: number; sentences: number; error: string | null }

/** Per variant: medians of the two first-token times, the length, and how many replies kept to one or two sentences. */
export function paceAbSummary(items: readonly PaceAbItem[]) {
  const of = (variant: 'A' | 'B') => {
    const mine = items.filter(item => item.variant === variant && !item.error);
    return { n: mine.length, firstRawMs: median(mine.map(item => item.firstRawMs ?? Number.NaN)), firstVisibleMs: median(mine.map(item => item.firstVisibleMs ?? Number.NaN)),
      replyChars: median(mine.map(item => item.replyChars)), sentences: median(mine.map(item => item.sentences)), atMostTwo: mine.filter(item => item.sentences <= 2).length };
  };
  const a = of('A'), b = of('B');
  // Paired: B minus A within each pair, so a drift over the time window cancels out.
  const pairs = [...new Set(items.map(item => item.pair))]
    .map(pair => ({ a: items.find(item => item.pair === pair && item.variant === 'A'), b: items.find(item => item.pair === pair && item.variant === 'B') }))
    .filter(pair => pair.a && pair.b && !pair.a.error && !pair.b.error);
  const delta = (key: 'firstRawMs' | 'firstVisibleMs') => median(pairs.map(pair => (pair.b![key] ?? Number.NaN) - (pair.a![key] ?? Number.NaN)));
  return { a, b, pairs: pairs.length, pairedFirstRawDelta: delta('firstRawMs'), pairedFirstVisibleDelta: delta('firstVisibleMs') };
}

/** Plan rule 5: ship the short instruction only with 50 pairs, neither first-token median 0.15 s slower, and replies that really got shorter. */
export function paceAbVerdict(summary: ReturnType<typeof paceAbSummary>): { ship: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const slower = (b: number | null, a: number | null) => b !== null && a !== null && b - a > 150;
  if (summary.pairs < 50) reasons.push(`只有 ${summary.pairs} 对，不到 50 对`);
  if (slower(summary.b.firstRawMs, summary.a.firstRawMs)) reasons.push(`首字到达中位慢了 ${Math.round(summary.b.firstRawMs! - summary.a.firstRawMs!)} ms`);
  if (slower(summary.b.firstVisibleMs, summary.a.firstVisibleMs)) reasons.push(`首字画出中位慢了 ${Math.round(summary.b.firstVisibleMs! - summary.a.firstVisibleMs!)} ms`);
  if (!(summary.b.atMostTwo > summary.a.atMostTwo) || !((summary.b.replyChars ?? Infinity) < (summary.a.replyChars ?? 0))) reasons.push('没有让回复变短');
  return { ship: reasons.length === 0, reasons };
}

/** --ab-short --pairs N: the ordinary instruction (A) against the short one (B) on very short messages, interleaved, alternating who goes first. */
async function runPaceAb(options: { root: string; dir: string; ledgerFile: string; dry: boolean; label: string }): Promise<void> {
  const pairsWanted = Math.max(1, Number(option('pairs', '50')) || 50);
  const card = selectCards(list(option('cards', 'gene')))[0];
  const scenarios = PACE_SCENARIOS.filter(item => item.pace === 'short');
  let entries: Array<{ at: string; label: string; kind: string; model: string; replies: number; judges: number }> = [];
  try { entries = JSON.parse(await readFile(options.ledgerFile, 'utf8')); } catch { entries = []; }
  const used = entries.reduce((sum, entry) => sum + entry.replies + entry.judges, 0), cap = Number(option('cap', '650')), planned = pairsWanted * 2;
  console.log(`[pace] A/B ${options.label}：${pairsWanted} 对 × 2 = ${planned} 次请求（不评分）${options.dry ? '（假 Claude）' : `；已用 ${used}，上限 ${cap}`}`);
  if (!options.dry && used + planned > cap) throw new Error(`会超过上限 ${cap}（已用 ${used}，本次 ${planned}），没有开始。`);
  const binary = options.dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = options.dry ? [path.join(options.root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const budget = new CallBudget(used, cap, options.dry ? Infinity : 110, !options.dry);
  const swap = (prompt: string) => {
    if (!prompt.includes(conversationReplyInstruction)) throw new Error('本轮提示词里没有“回复节奏”那一段，A/B 无效。');
    return prompt.split(conversationReplyInstruction).join(conversationShortReplyInstruction);
  };
  const A = { label: 'A' }, B = { label: 'B', rewrite: swap };
  const items: PaceAbItem[] = [], records: TurnRecord[] = [];
  let stopped: string | null = null;
  try {
    for (let pair = 0; pair < pairsWanted; pair++) {
      const scenario = scenarios[pair % scenarios.length];
      await runEval({ label: options.label, model: '', repeat: pair + 1, scenarios: toEvalScenarios([scenario]), binary, ...(binaryArgs ? { binaryArgs } : {}),
        prewarmMs: Number(option('prewarm-ms', options.dry ? '100' : '3000')), card: { persona: card.persona, mood: card.mood }, variants: pair % 2 === 0 ? [A, B] : [B, A],
        beforeTurn: () => budget.take('reply'),
        onTurn: record => {
          records.push(record);
          const metrics = analyzeTurn(record), text = record.liveVisible ?? '';
          items.push({ variant: record.label as 'A' | 'B', pair, scenario: scenario.id, firstRawMs: metrics.firstRawMs, firstVisibleMs: metrics.firstVisibleMs,
            replyChars: visibleLength(text), sentences: metrics.sentences, error: record.error });
          console.log(`  ${record.label} #${pair + 1} ${scenario.id} 首字 ${metrics.firstRawMs ?? '–'} ms / 画出 ${metrics.firstVisibleMs ?? '–'} ms · ${visibleLength(text)} 字 ${metrics.sentences} 句${record.error ? ` 错误：${record.error}` : ''}`);
        } });
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  finally {
    if (!options.dry) { entries.push({ at: new Date().toISOString(), label: options.label, kind: 'ab', model: 'default', replies: budget.replies, judges: 0 }); await writeFile(options.ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); }
  }
  const summary = paceAbSummary(items), verdict = paceAbVerdict(summary);
  const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: options.root, encoding: 'utf8' }).trim(); } catch { return '?'; } })();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), base = path.join(options.dir, `${stamp}-ab-${options.label}`);
  const ms = (value: number | null) => value === null ? '–' : String(Math.round(value));
  const row = (name: string, v: typeof summary.a) => `| ${name} | ${v.n} | ${ms(v.firstRawMs)} | ${ms(v.firstVisibleMs)} | ${v.replyChars ?? '–'} | ${v.sentences ?? '–'} | ${v.atMostTwo} |`;
  const text = [`# 说话节奏 · 很短的闲聊：“回复节奏”原版（A）对短版（B）首字 A/B：${options.label}`, '',
    `- 代码：${commit}；聊天模型 default；卡 ${card.id}；同一时段交错，每对先后对调；${budget.replies} 次回复请求，不评分${options.dry ? '；假 Claude，不代表真实效果' : ''}${stopped ? `；**运行中止**：${stopped}` : ''}`,
    `- A = 代码现在的“回复节奏”（${Array.from(conversationReplyInstruction).length} 字）；B = 很短闲聊的短版（${Array.from(conversationShortReplyInstruction).length} 字），只在这一轮私有上下文里替换，固定系统提示词不动。`, '',
    '| 变体 | 条数 | 首字到达中位 ms | 首字画出中位 ms | 回复字数中位 | 句数中位 | ≤2 句 |', '|---|---|---|---|---|---|---|', row('A 原版', summary.a), row('B 短版', summary.b), '',
    `配对（同一对里 B − A）的中位差：首字到达 ${ms(summary.pairedFirstRawDelta)} ms，首字画出 ${ms(summary.pairedFirstVisibleDelta)} ms（${summary.pairs} 对）。`, '',
    `判定（规则在跑之前定好：至少 50 对；两个首字中位都不能慢 150 ms 以上；还要真的变短）：${verdict.ship ? '可以上' : `不上（${verdict.reasons.join('；')}）`}`].join('\n');
  await writeFile(`${base}.json`, JSON.stringify({ kind: 'pace-ab', label: options.label, commit, dry: options.dry, at: new Date().toISOString(), stopped, items, summary, verdict, records }, null, 2), 'utf8');
  await writeFile(`${base}.md`, text, 'utf8');
  console.log(text);
  console.log(`[pace] 写入 ${path.relative(options.root, base)}.json / .md`);
}

export async function runPaceProbeCli(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..', '..'), dir = path.join(root, '.local', 'fidelity'), ledgerFile = path.join(dir, 'ledger.json');
  await mkdir(dir, { recursive: true });
  if (flag('ab-short')) { await runPaceAb({ root, dir, ledgerFile, dry: flag('dry'), label: option('label', flag('dry') ? 'pace-ab-dry' : 'pace-ab-short') }); return; }
  const dry = flag('dry'), label = option('label', dry ? 'pace-dry' : 'pace');
  const groups = list(option('groups', 'short,vent,ask')) as PaceGroup[];
  const scenarios = PACE_SCENARIOS.filter(item => groups.includes(item.pace));
  const cards = selectCards(list(option('cards', 'gene')));
  if (!scenarios.length || !cards.length) throw new Error('没有选中任何情景或卡。');
  const judge = !flag('no-judge');
  const replies = scenarios.length * cards.length, planned = replies * (judge ? 2 : 1);
  let entries: Array<{ at: string; label: string; kind: string; model: string; replies: number; judges: number }> = [];
  try { entries = JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { entries = []; }
  const used = entries.reduce((sum, entry) => sum + entry.replies + entry.judges, 0), cap = Number(option('cap', '650'));
  console.log(`[pace] ${label}：${cards.length} 张卡 × ${scenarios.length} 个情景 = ${replies} 次回复${judge ? ` + ${replies} 次评分` : ''} = ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；已用 ${used}，上限 ${cap}`}`);
  if (!dry && used + planned > cap) throw new Error(`会超过上限 ${cap}（已用 ${used}，本次 ${planned}），没有开始。`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const budget = new CallBudget(used, cap, dry ? Infinity : 110, !dry);
  let result: Awaited<ReturnType<typeof runFidelity>>;
  try {
    result = await runFidelity({ label, model: option('model', 'default') === 'default' ? '' : option('model'), cards, scenarios, binary, ...(binaryArgs ? { binaryArgs } : {}),
      judge: judge ? claudeJudge(binary, binaryArgs) : null, prewarmMs: Number(option('prewarm-ms', dry ? '100' : '3000')), budget, log: console.log });
  } finally {
    if (!dry) { entries.push({ at: new Date().toISOString(), label, kind: 'run', model: 'default', replies: budget.replies, judges: budget.judges }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); }
  }
  const rows = paceRows(result.cases), summaries = paceSummary(rows);
  const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } })();
  const notes = [`代码：${commit}；聊天模型 default；评分模型 ${judge ? JUDGE_MODEL : '（不评分）'}；${budget.replies} 次回复 + ${budget.judges} 次评分${dry ? '；假 Claude，不代表真实效果' : `；累计 ${used + budget.calls} 次`}`,
    `卡：${cards.map(card => card.id).join('、')}；情景：${scenarios.map(item => item.id).join('、')}${result.stopped ? `；**运行中止**：${result.stopped}` : ''}`,
    '提示词是代码现在发送的（没有改“回复节奏”那一段）。字数按看得见的字数（一个 emoji 算一个），句数按应用自己的分句。'];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), base = path.join(dir, `${stamp}-${label}`);
  await writeFile(`${base}.json`, JSON.stringify({ kind: 'pace', label, commit, dry, at: new Date().toISOString(), calls: result.calls, stopped: result.stopped, rows, summaries, records: result.records }, null, 2), 'utf8');
  const text = paceMarkdown(label, rows, summaries, notes);
  await writeFile(`${base}.md`, text, 'utf8');
  console.log(text.split('\n## 回复原文')[0]);
  console.log(`[pace] 写入 ${path.relative(root, base)}.json / .md`);
}
