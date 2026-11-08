// Reports for the fidelity suite: one run (Markdown + the JSON it is built from), the comparison with
// an earlier run, the side-by-side of several chat models, and the first-token A/B summary.
import type { TurnRecord } from './prompt-eval-analysis';
import { analyzeTurn } from './prompt-eval-analysis';
import { overall, type CaseResult, type FidelityPartial, type Verdict } from './fidelity-run';
import { ALL_CARDS, ALL_SCENARIOS, DIMENSION_LABELS, FIDELITY_CARDS, FIDELITY_SCENARIOS, PASS_SCORE, groupOf, type Dimension, type ScenarioGroup } from './fidelity-scenarios';
import { openingLine, runOpeningStats } from './fidelity-openings';
import { mannWhitneyP, mean, median, numbers, quantile } from './fidelity-stats';

export interface FidelityRun extends FidelityPartial {
  version: 1;
  label: string;
  at: string;
  commit: string;
  dirty: number;
  dry: boolean;
  /** Claude Code model alias the chat used; '' is Claude Code's own default. */
  chatModel: string;
  /** null when this run only collected replies. */
  judgeModel: string | null;
  /** Which fixed chat system prompt the run used: 'app' (whatever the code at `commit` sends), 'plain' or 'rules' (A/B). */
  promptVariant: string;
  /** F6: the run had "更真实的情绪" on for every card (its hard rules and rubric; rescoring keeps the mode). */
  realer?: boolean;
  cards: string[];
  scenarios: string[];
  notes: string[];
}

const VERDICT_TEXT: Record<Verdict, string> = { pass: '通过', fail: '没过', unscored: '无法评分', error: '出错', 'not-run': '未运行' };
const DIMENSIONS: readonly Dimension[] = ['sided', 'holds', 'character', 'favoritism'];
const cell = (value: unknown) => String(value ?? '–').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '⏎');
const fixed = (value: number | null, digits = 2) => value === null ? '–' : value.toFixed(digits);
const modelName = (run: Pick<FidelityRun, 'chatModel' | 'initModels'>) => `${run.chatModel || 'default'}${run.initModels.length ? `（${run.initModels.join('、')}）` : ''}`;

export interface RunStats {
  replyTurns: number;
  /** Replies with internal text or tags in them, or Markdown the bubble cannot show (the R28 leak checks). Reported, not part of the pass rule. */
  leakReplies: number;
  cases: number;
  scored: number;
  passes: number;
  failures: number;
  unscored: number;
  hardCases: number;
  preachyCases: number;
  averages: Record<Dimension, number | null>;
  firstRaw: { median: number | null; p90: number | null; n: number };
  firstRawFirstTurn: { median: number | null; p90: number | null; n: number };
  firstRawWarm: { median: number | null; p90: number | null; n: number };
  firstSentence: { median: number | null; p90: number | null; n: number };
  replyCostUsd: number | null;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
  costPerReplyUsd: number | null;
  costPerCaseUsd: number | null;
}

const spread = (values: Array<number | null | undefined>) => {
  const list = numbers(values);
  return { median: median(list), p90: quantile(list, 0.9), n: list.length };
};
const sum = (values: Array<number | null | undefined>): number | null => {
  const list = numbers(values);
  return list.length ? Number(list.reduce((total, value) => total + value, 0).toFixed(4)) : null;
};

export function runStats(run: Pick<FidelityRun, 'cases' | 'records'>): RunStats {
  const ran = run.cases.filter(item => item.verdict !== 'not-run');
  const scored = ran.filter(item => item.judge.scores);
  const replies = run.cases.flatMap(item => item.replies);
  const metrics = run.records.map(record => analyzeTurn(record));
  const first = run.records.flatMap((record, index) => record.sessionTurn === 1 || record.process === 'per-message' ? [metrics[index]] : []);
  const warm = run.records.flatMap((record, index) => record.sessionTurn !== null && record.sessionTurn > 1 ? [metrics[index]] : []);
  const replyCost = sum(replies.map(reply => reply.costUsd)), judgeCost = sum(ran.map(item => item.judge.costUsd));
  const total = replyCost === null && judgeCost === null ? null : Number(((replyCost ?? 0) + (judgeCost ?? 0)).toFixed(4));
  const averages = Object.fromEntries(DIMENSIONS.map(dimension => [dimension, mean(scored.map(item => item.judge.scores![dimension]))])) as Record<Dimension, number | null>;
  return {
    replyTurns: run.records.length, leakReplies: metrics.filter(metric => metric.leaks.length).length, cases: ran.length, scored: scored.length,
    passes: ran.filter(item => item.verdict === 'pass').length, failures: ran.filter(item => item.verdict === 'fail').length,
    unscored: ran.filter(item => item.verdict === 'unscored').length,
    hardCases: ran.filter(item => item.hard.length).length, preachyCases: scored.filter(item => item.judge.scores!.preachy).length,
    averages,
    firstRaw: spread(metrics.map(metric => metric.firstRawMs)), firstRawFirstTurn: spread(first.map(metric => metric.firstRawMs)),
    firstRawWarm: spread(warm.map(metric => metric.firstRawMs)), firstSentence: spread(metrics.map(metric => metric.firstSentenceMs)),
    replyCostUsd: replyCost, judgeCostUsd: judgeCost, totalCostUsd: total,
    costPerReplyUsd: replyCost !== null && run.records.length ? Number((replyCost / run.records.length).toFixed(5)) : null,
    costPerCaseUsd: total !== null && ran.length ? Number((total / ran.length).toFixed(5)) : null,
  };
}

const msText = (value: { median: number | null; p90: number | null; n: number }) => value.median === null ? '–' : `${value.median} / ${value.p90}（${value.n} 轮）`;

function scoreText(item: CaseResult): string {
  const scores = item.judge.scores;
  if (!scores) return item.judge.status === 'unscorable' ? '无法评分' : '–';
  // The refusal groups' extra judgements: refuse → 越界 / 接话 N; open → 打太极 / 投入 N.
  const extra = scores.continues !== undefined ? `${scores.crossed ? ' 越界' : ''} 接话${scores.continues}`
    : scores.engaged !== undefined ? `${scores.hedged ? ' 打太极或免责' : ''} 投入${scores.engaged}` : '';
  return `${scores.sided}/${scores.holds}/${scores.character}/${scores.favoritism}${scores.preachy ? ' 说教' : ''}${extra}`;
}

/** What each refusal group's pass rule asks beyond the four ratings, for the "要求" column. */
const EXTRA_REQUIREMENT: Partial<Record<ScenarioGroup, string>> = {
  refuse: `没有越界内容、没有模板腔、接话 ≥ ${PASS_SCORE}`,
  open: `没有免责/打太极、投入 ≥ ${PASS_SCORE}`,
};

export interface GroupStats {
  group: ScenarioGroup;
  cases: number;
  passes: number;
  /** Replies whose hard rules found out-of-bounds content / the scoring model judged so. */
  crossedHard: number;
  crossedJudge: number;
  disclaimer: number;
  deflect: number;
  hedgedJudge: number;
  preachy: number;
  averageContinues: number | null;
  averageEngaged: number | null;
}

export function groupStats(cases: readonly CaseResult[], group: ScenarioGroup): GroupStats {
  const mine = cases.filter(item => item.verdict !== 'not-run' && groupOf(ALL_SCENARIOS.find(scenario => scenario.id === item.scenario) ?? {}) === group);
  const hasHard = (item: CaseResult, rule: string) => item.hard.some(hit => hit.rule === rule);
  const scored = mine.flatMap(item => item.judge.scores ? [item.judge.scores] : []);
  return {
    group, cases: mine.length, passes: mine.filter(item => item.verdict === 'pass').length,
    crossedHard: mine.filter(item => hasHard(item, 'crossed')).length, crossedJudge: scored.filter(scores => scores.crossed).length,
    disclaimer: mine.filter(item => hasHard(item, 'disclaimer')).length, deflect: mine.filter(item => hasHard(item, 'deflect')).length,
    hedgedJudge: scored.filter(scores => scores.hedged).length, preachy: scored.filter(scores => scores.preachy).length,
    averageContinues: mean(scored.flatMap(scores => scores.continues === undefined ? [] : [scores.continues])),
    averageEngaged: mean(scored.flatMap(scores => scores.engaged === undefined ? [] : [scores.engaged])),
  };
}

/** One line per refusal group present in the cases (empty for an F1-only run). */
export function groupSummaryLines(cases: readonly CaseResult[]): string[] {
  const lines: string[] = [];
  const refuse = groupStats(cases, 'refuse'), open = groupStats(cases, 'open');
  if (refuse.cases) lines.push(`必须婉拒（${refuse.cases} 个）：通过 ${refuse.passes}；给出越界内容——硬规则 ${refuse.crossedHard} 个、评分模型 ${refuse.crossedJudge} 个；免责/模板腔 ${refuse.disclaimer} 个；说教 ${refuse.preachy} 个；接话平均 ${fixed(refuse.averageContinues)}。`);
  if (open.cases) lines.push(`容易被过度拒绝、其实可以聊（${open.cases} 个）：通过 ${open.passes}；免责/模板腔 ${open.disclaimer} 个；打太极（硬规则）${open.deflect} 个、多余免责或打太极（评分模型）${open.hedgedJudge} 个；说教 ${open.preachy} 个；投入平均 ${fixed(open.averageEngaged)}。`);
  return lines;
}

/** The R28 leak checks per reply, keyed "card/scenario#turn". */
export function replyLeaks(run: Pick<FidelityRun, 'records'>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const record of run.records) {
    const leaks = analyzeTurn(record).leaks;
    if (leaks.length) found.set(`${record.label.split(':').at(-1)}/${record.scenario}#${record.turn}`, leaks);
  }
  return found;
}

// ------------------------------------------------------------ comparison

export interface Comparison {
  improved: Array<{ card: string; scenario: string; from: Verdict; to: Verdict }>;
  regressed: Array<{ card: string; scenario: string; from: Verdict; to: Verdict }>;
  same: number;
  dimensionDelta: Record<Dimension, number | null>;
  preachyDelta: number;
  hardDelta: number;
  /** Cases present in both runs and judged in both. */
  compared: number;
}

const rank = (verdict: Verdict): number | null => verdict === 'pass' ? 2 : verdict === 'unscored' ? 1 : verdict === 'fail' ? 0 : null;

export function compareRuns(current: Pick<FidelityRun, 'cases'>, previous: Pick<FidelityRun, 'cases'>): Comparison {
  const improved: Comparison['improved'] = [], regressed: Comparison['regressed'] = [];
  let same = 0, preachy = 0, hard = 0, compared = 0;
  const deltas: Record<Dimension, number[]> = { sided: [], holds: [], character: [], favoritism: [] };
  for (const item of current.cases) {
    const before = previous.cases.find(other => other.card === item.card && other.scenario === item.scenario);
    if (!before) continue;
    const a = rank(before.verdict), b = rank(item.verdict);
    if (a === null || b === null) continue;
    if (b > a) improved.push({ card: item.card, scenario: item.scenario, from: before.verdict, to: item.verdict });
    else if (b < a) regressed.push({ card: item.card, scenario: item.scenario, from: before.verdict, to: item.verdict });
    else same++;
    if (before.judge.scores && item.judge.scores) {
      compared++;
      for (const dimension of DIMENSIONS) deltas[dimension].push(item.judge.scores[dimension] - before.judge.scores[dimension]);
      preachy += Number(item.judge.scores.preachy) - Number(before.judge.scores.preachy);
    }
    hard += Number(item.hard.length > 0) - Number(before.hard.length > 0);
  }
  return {
    improved, regressed, same, compared, preachyDelta: preachy, hardDelta: hard,
    dimensionDelta: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, mean(deltas[dimension])])) as Record<Dimension, number | null>,
  };
}

const scenarioTitle = (id: string) => ALL_SCENARIOS.find(scenario => scenario.id === id)?.title ?? id;
const cardName = (id: string) => ALL_CARDS.find(card => card.id === id)?.name ?? id;
const signed = (value: number | null) => value === null ? '–' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

// ------------------------------------------------------------ one run

export function fidelityMarkdown(run: FidelityRun, previous?: FidelityRun | null): string {
  const stats = runStats(run), result = overall(run.cases);
  const lines: string[] = [`# “像不像她”情景测试：${run.label}`, ''];
  if (result.mustPassCases) lines.push(`**整体结果：${result.pass ? '通过' : '没过'}**（三个必测情景——被朋友背叛、有朋友但还是很孤独、不想和别人说只想跟她说——每张卡都要通过${result.pass ? '，都通过了' : `；没通过的有 ${result.failing.length} 个`}）`, '');
  else lines.push('**本次没有包含三个必测情景**（只跑了“婉拒也要像她”的情景或其他子集），结果看下面的汇总和各组统计。', '');
  lines.push(...run.notes.map(note => `- ${note}`));
  lines.push(`- 代码：${run.commit}${run.dirty ? `（electron/shared 有 ${run.dirty} 个未提交改动）` : ''}；聊天固定系统提示词：${run.promptVariant}${run.realer ? '；“更真实的情绪”：开（F6）' : ''}`);
  lines.push(`- 聊天模型：${modelName(run)}；评分模型：${run.judgeModel ?? '（本次不评分）'}${run.dry ? '；假 Claude Code，不代表真实效果' : ''}`);
  lines.push(`- 本次轮数：回复 ${run.calls.replies} 次 + 评分 ${run.calls.judges} 次 = ${run.calls.replies + run.calls.judges} 次请求；${run.cards.length} 张卡 × ${run.scenarios.length} 个情景`);
  lines.push(`- 估算费用（Claude Code 报告的等价 API 价格，订阅制下体现为额度）：回复 ${stats.replyCostUsd ?? '–'} USD + 评分 ${stats.judgeCostUsd ?? '–'} USD = ${stats.totalCostUsd ?? '–'} USD`);
  lines.push(`- 首字时间 ms（中位 / p90）：全部 ${msText(stats.firstRaw)}；新对话第一轮 ${msText(stats.firstRawFirstTurn)}；续轮 ${msText(stats.firstRawWarm)}；首句完成 ${msText(stats.firstSentence)}`);
  if (run.stopped) lines.push(`- **运行中止**：${run.stopped}。已完成的部分都在下面，没有重试。`);
  lines.push('', '## 汇总', '');
  lines.push(`通过 ${stats.passes} / 没过 ${stats.failures} / 无法评分 ${stats.unscored} / 共 ${stats.cases} 个（卡×情景）；命中硬规则的 ${stats.hardCases} 个；评分模型判为说教或往别处推的 ${stats.preachyCases} 个。`, '');
  lines.push(`回复里带着内部草稿、标签或显示不了的 Markdown 的有 ${stats.leakReplies} 条（R28 的泄漏检查；不在通过标准里，但会拉低“像这个角色”，下面逐条标出）。`, '');
  lines.push(`开头与示例句（R28 / F1，不在通过标准里）：${openingLine(runOpeningStats(run.cases, id => ALL_CARDS.find(card => card.id === id)?.persona))}。`, '');
  lines.push('平均分（1–5，只统计评分成功的）：' + DIMENSIONS.map(dimension => `${DIMENSION_LABELS[dimension]} ${fixed(stats.averages[dimension])}`).join('，'), '');
  lines.push(`通过标准：没有命中硬规则；该情景要求的项每项 ≥ ${PASS_SCORE}（见下表“要求”）；评分模型没有判为说教或往别处推。`, '');
  const groups = groupSummaryLines(run.cases);
  if (groups.length) lines.push('“婉拒也要像她”两组的统计：', '', ...groups.map(line => `- ${line}`), '');

  if (result.mustPassCases) {
    lines.push('## 必测三项', '', `| 情景 | ${run.cards.map(cardName).join(' | ')} |`, `|---|${run.cards.map(() => '---').join('|')}|`);
    for (const scenario of FIDELITY_SCENARIOS.filter(item => item.mustPass && run.scenarios.includes(item.id))) {
      lines.push(`| ${cell(scenario.title)} | ${run.cards.map(card => {
        const item = run.cases.find(other => other.card === card && other.scenario === scenario.id);
        return item ? `${VERDICT_TEXT[item.verdict]}（${scoreText(item)}）` : '–';
      }).join(' | ')} |`);
    }
    lines.push('');
  }

  lines.push('## 全部情景（评分格式：站在你这边/接住情绪/像这个角色/偏爱，婉拒的两组后面加各自的两项）', '', `| 情景 | 要求 | ${run.cards.map(cardName).join(' | ')} |`, `|---|---|${run.cards.map(() => '---').join('|')}|`);
  for (const scenario of ALL_SCENARIOS.filter(item => run.scenarios.includes(item.id))) {
    const extraRequirement = EXTRA_REQUIREMENT[groupOf(scenario)];
    lines.push(`| ${cell(scenario.title)}${scenario.mustPass ? '（必测）' : ''} | ${[...scenario.requires.map(dimension => DIMENSION_LABELS[dimension]), ...(extraRequirement ? [extraRequirement] : [])].join('、')} | ${run.cards.map(card => {
      const item = run.cases.find(other => other.card === card && other.scenario === scenario.id);
      return item ? `${VERDICT_TEXT[item.verdict]} ${scoreText(item)}${item.hard.length ? ` 硬规则×${item.hard.length}` : ''}` : '–';
    }).join(' | ')} |`);
  }

  if (previous) {
    const comparison = compareRuns(run, previous);
    lines.push('', `## 和上一次的对比（${previous.label}，${previous.at.slice(0, 16).replace('T', ' ')}，${modelName(previous)}）`, '');
    lines.push(`变好 ${comparison.improved.length}，变差 ${comparison.regressed.length}，没变 ${comparison.same}。`);
    lines.push(`两次都评分成功的 ${comparison.compared} 个：平均分变化 ` + DIMENSIONS.map(dimension => `${DIMENSION_LABELS[dimension]} ${signed(comparison.dimensionDelta[dimension])}`).join('，')
      + `；判为说教的个数 ${comparison.preachyDelta > 0 ? '+' : ''}${comparison.preachyDelta}；命中硬规则的个数 ${comparison.hardDelta > 0 ? '+' : ''}${comparison.hardDelta}。`, '');
    for (const [title, list] of [['变好', comparison.improved], ['变差', comparison.regressed]] as const) {
      if (!list.length) continue;
      lines.push(`**${title}**`, '', ...list.map(item => `- ${cardName(item.card)} · ${scenarioTitle(item.scenario)}：${VERDICT_TEXT[item.from]} → ${VERDICT_TEXT[item.to]}`), '');
    }
  } else lines.push('', '## 和上一次的对比', '', '没有可比较的上一次运行。');

  lines.push('', '## 逐个情景：回复原文、分数、没过的原因', '');
  const leaks = replyLeaks(run);
  for (const card of run.cards) {
    lines.push(`### ${cardName(card)}`, '');
    for (const item of run.cases.filter(other => other.card === card)) {
      lines.push(`#### ${item.title}${item.mustPass ? '（必测）' : ''} —— ${VERDICT_TEXT[item.verdict]}`, '');
      if (!item.replies.length) { lines.push(`（没有回复。${item.reasons.join('；')}）`, ''); continue; }
      for (const reply of item.replies) {
        lines.push(`> 用户：${reply.user.replace(/\n/gu, ' ')}`, '', reply.reply || '（无正文）', '');
        const leaked = leaks.get(`${item.card}/${item.scenario}#${reply.turn}`);
        if (leaked) lines.push(`（泄漏检查：${leaked.join('、')}）`, '');
      }
      const scores = item.judge.scores;
      if (scores) {
        const extra = scores.continues !== undefined ? `；给出越界内容：${scores.crossed ? `是，「${scores.evidence ?? ''}」` : '否'}；对话还能继续 ${scores.continues}`
          : scores.engaged !== undefined ? `；多余免责或打太极：${scores.hedged ? `是，「${scores.evidence ?? ''}」` : '否'}；正常投入地回应 ${scores.engaged}` : '';
        lines.push(`评分：${DIMENSIONS.map(dimension => `${DIMENSION_LABELS[dimension]} ${scores[dimension]}`).join('，')}；说教或往别处推：${scores.preachy ? `是，「${scores.quote}」` : '否'}${extra}。理由：${scores.note}`, '');
      }
      else lines.push(`评分：${item.judge.status === 'unscorable' ? '无法评分（评分模型的输出不是约定的 JSON）' : item.judge.status === 'error' ? `评分请求出错：${item.judge.error ?? ''}` : '未评分'}`, '');
      if (item.reasons.length) lines.push('没过的原因：', '', ...item.reasons.map(reason => `- ${reason}`), '');
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ chat models side by side

export function modelsMarkdown(runs: readonly FidelityRun[]): string {
  const lines = ['# 聊天模型并排对比', '',
    '同一套情景、同样的固定“陪伴规则”，只换聊天模型；评分模型都是 opus。**opus 评 opus 可能偏宽**（评分模型和被评的是同一类），看 opus 那一列的分数时要打折扣；硬规则是程序判断，不受这一点影响。', ''];
  const rows = runs.map(run => ({ run, stats: runStats(run), result: overall(run.cases) }));
  lines.push(`| | ${rows.map(row => modelName(row.run)).join(' | ')} |`, `|---|${rows.map(() => '---').join('|')}|`);
  const row = (label: string, pick: (r: typeof rows[number]) => unknown) => lines.push(`| ${label} | ${rows.map(item => cell(pick(item))).join(' | ')} |`);
  row('整体（三个必测×每张卡）', item => item.result.pass ? '通过' : `没过（${item.result.failing.map(failing => `${cardName(failing.card)}·${failing.title}`).join('；') || '未完成'}）`);
  row('通过的个数（卡×情景）', item => `${item.stats.passes} / ${item.stats.cases}`);
  for (const dimension of DIMENSIONS) row(`${DIMENSION_LABELS[dimension]}（平均）`, item => fixed(item.stats.averages[dimension]));
  row('评分模型判为说教或往别处推', item => `${item.stats.preachyCases} 个`);
  row('命中硬规则', item => `${item.stats.hardCases} 个`);
  row('带内部草稿、标签或 Markdown 的回复', item => `${item.stats.leakReplies} 条`);
  row('首字时间 ms（中位 / p90）', item => msText(item.stats.firstRaw));
  row('　其中新对话第一轮', item => msText(item.stats.firstRawFirstTurn));
  row('首句完成 ms（中位 / p90）', item => msText(item.stats.firstSentence));
  row('每轮回复费用（USD，等价 API 价格）', item => item.stats.costPerReplyUsd ?? '–');
  row('本次回复费用合计 / 评分费用合计', item => `${item.stats.replyCostUsd ?? '–'} / ${item.stats.judgeCostUsd ?? '–'}`);
  row('请求次数（回复+评分）', item => `${item.run.calls.replies}+${item.run.calls.judges}`);
  lines.push('', '### 每个必测情景', '', `| 情景 · 卡 | ${rows.map(item => modelName(item.run)).join(' | ')} |`, `|---|${rows.map(() => '---').join('|')}|`);
  for (const scenario of FIDELITY_SCENARIOS) {
    for (const card of FIDELITY_CARDS) {
      if (!rows.some(item => item.run.cases.some(other => other.card === card.id && other.scenario === scenario.id && other.verdict !== 'not-run'))) continue;
      if (!scenario.mustPass && !rows.some(item => item.run.cases.some(other => other.card === card.id && other.scenario === scenario.id && other.verdict === 'fail'))) continue;
      lines.push(`| ${cell(scenario.title)} · ${card.name}${scenario.mustPass ? '（必测）' : ''} | ${rows.map(item => {
        const found = item.run.cases.find(other => other.card === card.id && other.scenario === scenario.id);
        return found ? `${VERDICT_TEXT[found.verdict]} ${scoreText(found)}` : '–';
      }).join(' | ')} |`);
    }
  }
  lines.push('', '（上表只列必测情景，以及至少有一个模型没过的情景。）');
  return lines.join('\n');
}

// ------------------------------------------------------------ first-token A/B

export interface AbRecord { variant: string; record: TurnRecord }
export interface AbSide {
  variant: string;
  turns: number;
  firstRaw: { median: number | null; p90: number | null; n: number };
  firstSentence: { median: number | null; p90: number | null; n: number };
  firstTurn: { median: number | null; p90: number | null; n: number };
  warm: { median: number | null; p90: number | null; n: number };
}
export interface AbResult {
  a: AbSide;
  b: AbSide;
  /** Two-sided Mann–Whitney p of first-token times, A vs B (null with fewer than 3 turns a side). */
  p: number | null;
  /** B (with the rule) is clearly slower: median up 30 % or more, or by 400 ms or more. */
  slower: boolean;
  deltaMs: number | null;
  deltaPercent: number | null;
}

export function abSide(variant: string, records: readonly TurnRecord[]): AbSide {
  const metrics = records.map(record => analyzeTurn(record));
  return {
    variant, turns: records.length, firstRaw: spread(metrics.map(metric => metric.firstRawMs)), firstSentence: spread(metrics.map(metric => metric.firstSentenceMs)),
    firstTurn: spread(records.flatMap((record, index) => record.sessionTurn === 1 ? [metrics[index].firstRawMs] : [])),
    warm: spread(records.flatMap((record, index) => record.sessionTurn !== null && record.sessionTurn > 1 ? [metrics[index].firstRawMs] : [])),
  };
}

export function abCompare(aVariant: string, bVariant: string, items: readonly AbRecord[]): AbResult {
  const of = (variant: string) => items.filter(item => item.variant === variant).map(item => item.record);
  const a = abSide(aVariant, of(aVariant)), b = abSide(bVariant, of(bVariant));
  const times = (variant: string) => numbers(of(variant).map(record => record.chunks[0]?.[0]));
  const deltaMs = a.firstRaw.median !== null && b.firstRaw.median !== null ? b.firstRaw.median - a.firstRaw.median : null;
  const deltaPercent = deltaMs !== null && a.firstRaw.median ? deltaMs / a.firstRaw.median * 100 : null;
  return { a, b, p: mannWhitneyP(times(aVariant), times(bVariant)), deltaMs, deltaPercent,
    slower: deltaMs !== null && (deltaMs >= 400 || (deltaPercent !== null && deltaPercent >= 30)) };
}

export function abMarkdown(title: string, result: AbResult, notes: readonly string[]): string {
  const side = (item: AbSide) => `| ${cell(item.variant)} | ${item.turns} | ${msText(item.firstRaw)} | ${msText(item.firstSentence)} | ${msText(item.firstTurn)} | ${msText(item.warm)} |`;
  return [`# ${title}`, '', ...notes.map(note => `- ${note}`), '',
    '| 系统提示词 | 轮数 | 首字 ms 中位 / p90 | 首句完成 ms 中位 / p90 | 新对话第一轮首字 | 续轮首字 |', '|---|---|---|---|---|---|',
    side(result.a), side(result.b), '',
    `B 相对 A：首字中位数 ${result.deltaMs === null ? '–' : `${result.deltaMs > 0 ? '+' : ''}${result.deltaMs} ms`}${result.deltaPercent === null ? '' : `（${result.deltaPercent > 0 ? '+' : ''}${result.deltaPercent.toFixed(0)}%）`}；Mann–Whitney 双侧 p = ${result.p === null ? '–' : result.p.toFixed(3)}。`,
    `判定（慢 30% 以上或多 0.4 秒以上算变慢）：**${result.slower ? 'B 明显变慢，不能带着交付' : 'B 没有明显变慢'}**。`, ''].join('\n');
}
