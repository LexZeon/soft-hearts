// First-token A/B for the pretrial fixes (docs/claude/2026-11-03-pretrial-fixes-continuity.md):
//   A = the chat as before: the fixed system prompt without the perception fact, no "你刚才在：…" line;
//   B = after: the fixed system prompt with PERCEPTION_RULE, and this turn's private context carrying the her-life line
//       (worst case: every turn, as on the turn after she was interrupted).
// Same card, same situations, interleaved in one time window, who goes first swapped every pair. Only first-token times are
// measured (no scoring). Hard cap on real requests; any failed turn (429, quota, login) stops the run, nothing is retried.
// Usage: node node_modules/tsx/dist/cli.mjs scripts/lib/perception-ab.ts --pairs 10 --out <dir> [--dry]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import { FIDELITY_CARDS, FIDELITY_SCENARIOS, toEvalScenarios } from './fidelity-scenarios';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { findClaude } from '../../electron/claude';
import { herLifeChatLine } from '../../shared/her-life';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const pairs = Math.max(1, Math.min(20, Number(option('pairs', '10')) || 10));
const cap = Math.max(2, Math.min(40, Number(option('cap', String(pairs * 2))) || pairs * 2));
const out = path.resolve(option('out', '.local/perception-ab'));
const LINE = herLifeChatLine({ activity: 'daydream', minutes: 0 });
// --system-only: B differs from A by the perception fact alone (no her-life line), to tell the two changes apart.
const systemOnly = process.argv.includes('--system-only');
// Before the reply-pace instruction: exactly where buildCompanionPersona puts the her-life line (after the mood context).
const withLine = (prompt: string) => {
  const at = prompt.indexOf('回复节奏：');
  if (at < 0) throw new Error('no reply-pace instruction in the prompt');
  return prompt.slice(0, at) + LINE + '\n\n' + prompt.slice(at);
};

async function main(): Promise<void> {
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const scenarios = FIDELITY_SCENARIOS.filter(scenario => scenario.turns.length === 1 && !scenario.onlyCards && !scenario.away).slice(0, pairs);
  if (scenarios.length < pairs) throw new Error(`only ${scenarios.length} single-turn situations`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(process.cwd(), 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const a = { label: 'A', systemPrompt: claudeSessionSystemPrompt({ perception: false }) };
  const b = systemOnly ? { label: 'B', systemPrompt: claudeSessionSystemPrompt() } : { label: 'B', systemPrompt: claudeSessionSystemPrompt(), rewrite: withLine };
  let used = 0;
  const records: TurnRecord[] = [];
  let stopped: string | null = null;
  try {
    for (const [round, scenario] of scenarios.entries()) {
      for (const variant of round % 2 === 0 ? [a, b] : [b, a]) {
        await runEval({
          label: variant.label, model: '', repeat: 1, scenarios: toEvalScenarios([scenario]), binary, ...(binaryArgs ? { binaryArgs } : {}),
          prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood }, systemPrompt: variant.systemPrompt,
          ...('rewrite' in variant ? { variants: [{ label: variant.label, rewrite: variant.rewrite }] } : {}),
          beforeTurn: () => { if (++used > cap) throw new Error(`real request cap ${cap} reached`); },
          onTurn: record => { records.push(record); console.log(`${variant.label} ${scenario.id} 首字 ${record.chunks[0]?.[0] ?? '–'} ms${record.error ? ` 错误：${record.error}` : ''}`); },
        });
      }
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  const first = (label: string) => records.filter(record => record.label === label && !record.error && record.chunks.length).map(record => record.chunks[0][0]);
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pairsDone = scenarios.map(scenario => ({ id: scenario.id, a: records.find(r => r.scenario === scenario.id && r.label === 'A')?.chunks[0]?.[0] ?? null,
    b: records.find(r => r.scenario === scenario.id && r.label === 'B')?.chunks[0]?.[0] ?? null })).filter(pair => pair.a !== null && pair.b !== null) as { id: string; a: number; b: number }[];
  const diffs = pairsDone.map(pair => pair.b - pair.a);
  const result = { dry, requests: used, pairs: pairsDone.length, medianA: median(first('A')), medianB: median(first('B')), medianPairDiff: median(diffs),
    meanPairDiff: diffs.length ? Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length) : null, stopped,
    sentLine: records.some(record => record.label === 'B' && (record.prompt ?? '').includes(LINE)), pairsDone };
  const verdict = result.medianPairDiff === null ? '没有完成的配对' : result.medianPairDiff > 100 ? 'B 慢了 0.1 秒以上：不上' : 'B 没有慢 0.1 秒以上：可以上';
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'perception-ab.json'), JSON.stringify({ ...result, verdict, records: records.map(r => ({ label: r.label, scenario: r.scenario, process: r.process,
    firstMs: r.chunks[0]?.[0] ?? null, endMs: r.endMs, error: r.error, usage: r.usage })) }, null, 2), 'utf8');
  const lines = [`# 首字 A/B：感知说明${systemOnly ? '（只有它）' : ' + "你刚才在"一行'}（${dry ? '假 Claude' : '真实 Claude'}）`, '',
    systemOnly ? '- A：修改前的固定系统提示词；B：加了感知说明的固定系统提示词；两边都没有"你刚才在"'
      : `- A：修改前的固定系统提示词，没有"你刚才在"；B：加了感知说明的固定系统提示词，每一轮都带"${LINE}"`,
    `- 同一张卡（Gene）、${pairsDone.length} 个单轮情景，同一时段交错，每对先后顺序轮换；真实请求 ${used} 次${stopped ? `；中止：${stopped}` : ''}`,
    `- 首字中位数：A ${result.medianA ?? '–'} ms，B ${result.medianB ?? '–'} ms；逐对差（B−A）中位 ${result.medianPairDiff ?? '–'} ms、平均 ${result.meanPairDiff ?? '–'} ms`,
    `- B 的提示词里确实带了那一行：${result.sentLine}`, `- 判定（逐对差中位数慢 0.1 秒以上就不上）：**${verdict}**`, '',
    '| 情景 | A 首字 ms | B 首字 ms | B−A |', '|---|---|---|---|', ...pairsDone.map(pair => `| ${pair.id} | ${pair.a} | ${pair.b} | ${pair.b - pair.a} |`), ''];
  await writeFile(path.join(out, 'perception-ab.md'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
}
main().catch(error => { console.error(error); process.exit(1); });
