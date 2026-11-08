// 熟悉度 evaluation: does the real model carry out the one-time nickname question, and does a plain "好呀" then
// reach the host as a saved nickname? Two turns per card through the app's own chat path (no scoring request):
// the first message arrives when she has already talked with the user twice today (so she may ask), the second
// is a plain yes. Whether she asked is read from her reply; whether the host took the yes is read from the
// second turn's prompt, which reopens with the nickname line only when the host saved it.
import { NICKNAME_ASK_INSTRUCTION } from '../../shared/relationship';
import { runEval, type EvalRelationship } from './prompt-eval-runner';
import type { EvalScenario } from './prompt-eval-scenarios';
import type { TurnRecord } from './prompt-eval-analysis';
import type { CallBudget } from './fidelity-run';
import type { FidelityCard } from './fidelity-scenarios';

export const NICKNAME_PROBE: EvalScenario = {
  id: 'nickname-probe', title: '昵称：她问一次，点头才算',
  turns: [{ user: '吃完饭了，我想下楼散散步。' }, { user: '好呀' }],
};
export const PROBE_RELATIONSHIP: EvalRelationship = { slowWarmUp: false, dayNumber: 3, togetherDays: 2, todayRounds: 2 };

const QUESTION = /叫你|称呼|喊你|叫你什么|怎么叫|叫.{0,6}好不好|叫.{0,6}可以吗|叫.{0,6}行吗/u;
const SAVED_LINE = /用户同意你这样称呼用户：“([^”]+)”/u;

export interface ProbeResult {
  card: string;
  /** Her first reply, visible text. */
  first: string;
  /** Her reply to the yes. */
  second: string;
  /** The first reply is a question about what to call the user. */
  asked: boolean;
  /** The nickname the host saved after the yes (read from the second turn's prompt), or null. */
  saved: string | null;
  /** The question instruction was on the first turn and not on the second. */
  instructionOnlyOnce: boolean;
  error: string | null;
}

export function readProbe(card: string, turns: readonly TurnRecord[], error: string | null): ProbeResult {
  const [one, two] = turns;
  const first = one?.liveVisible.trim() ?? '', second = two?.liveVisible.trim() ?? '';
  return {
    card, first, second, asked: QUESTION.test(first) && /[？?]/u.test(first),
    saved: two?.prompt ? SAVED_LINE.exec(two.prompt)?.[1] ?? null : null,
    instructionOnlyOnce: !!one?.prompt?.includes(NICKNAME_ASK_INSTRUCTION) && !!two?.prompt && !two.prompt.includes(NICKNAME_ASK_INSTRUCTION), error,
  };
}

/** One card at a time; the first failed request (429, quota, login) ends the probe and is reported, never retried. */
export async function probeNickname(options: { cards: readonly FidelityCard[]; model: string; binary: string; binaryArgs?: readonly string[]; prewarmMs: number; budget: CallBudget; log?: (line: string) => void }): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const card of options.cards) {
    const turns: TurnRecord[] = [];
    let error: string | null = null;
    try {
      await runEval({
        label: `probe:${card.id}`, model: options.model, repeat: 1, scenarios: [NICKNAME_PROBE], binary: options.binary, ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}),
        prewarmMs: options.prewarmMs, card: { persona: card.persona, mood: card.mood, relationship: PROBE_RELATIONSHIP }, beforeTurn: () => options.budget.take('reply'),
        onTurn: record => { turns.push(record); },
      });
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const result = readProbe(card.id, turns, error);
    results.push(result);
    options.log?.(`${card.id}: ${result.error ? `出错 ${result.error.slice(0, 120)}` : `问了=${result.asked} 保存=${result.saved ?? '否'} 只问一次=${result.instructionOnlyOnce}`}`);
    if (error) break;
  }
  return results;
}

export function probeMarkdown(label: string, results: readonly ProbeResult[], notes: readonly string[]): string {
  const cell = (value: unknown) => String(value ?? '–').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '⏎');
  return [
    `# 昵称探针：${label}`, '', ...notes.map(note => `- ${note}`), '',
    '| 卡 | 她问了吗 | 点头后保存的称呼 | 问题只出现一次 | 出错 |', '|---|---|---|---|---|',
    ...results.map(item => `| ${item.card} | ${item.asked ? '问了' : '没问'} | ${item.saved ?? '没保存'} | ${item.instructionOnlyOnce ? '是' : '否'} | ${cell(item.error ?? '')} |`), '',
    '## 回复原文（合成数据）', '',
    ...results.flatMap(item => [`### ${item.card}`, `用户：吃完饭了，我想下楼散散步。`, '', `**第一轮**：${cell(item.first)}`, '', `用户：好呀`, '', `**第二轮**：${cell(item.second)}`, '']),
  ].join('\n');
}
