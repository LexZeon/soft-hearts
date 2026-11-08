// Leaked-draft probe (docs/claude/2026-11-02-leaked-drafts.md): does the default chat model (no --model) leak
// internal drafts into the reply more often than `--model opus`? One situation known to trigger it (the interview
// one, a fresh conversation every time), default and opus interleaved, order swapped pair by pair, on two cards.
// Counts against the fidelity ledger (.local/fidelity/ledger.json); a failed request ends the run, nothing is retried.
//   node node_modules/tsx/dist/cli.mjs scripts/prompt-eval.ts --suite leak-probe --pairs 12 [--label leakprobe] [--dry]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import type { TurnRecord } from './prompt-eval-analysis';
import { replay } from './prompt-eval-analysis';
import { runEval } from './prompt-eval-runner';
import { FIDELITY_CARDS, scenarioById, toEvalScenarios } from './fidelity-scenarios';

const root = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(root, '.local', 'fidelity');
const ledgerFile = path.join(DIR, 'ledger.json');
/** Total of the fidelity ledger (see fidelity-cli.ts) and this probe's own per-run limit. */
const TOTAL_CAP = 650;
const RUN_CAP = 30;

function option(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export interface ProbeSample { pair: number; model: 'default' | 'opus'; card: string; record: TurnRecord }

/** The first line of the visible reply as it is now shown (live), for reading by eye. */
export const headOf = (record: TurnRecord, n = 60): string => record.liveVisible.replace(/\s+/g, ' ').slice(0, n);

export async function runLeakProbeCli(): Promise<void> {
  const dry = flag('dry');
  const pairs = Math.max(1, Number(option('pairs', '12')) || 12);
  const label = option('label', dry ? 'leakprobe-dry' : 'leakprobe');
  const calls = pairs * 2;
  let entries: Array<{ at: string; label: string; kind: string; model: string; replies: number; judges: number }> = [];
  try { entries = JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { /* No ledger yet. */ }
  const used = entries.reduce((sum, entry) => sum + entry.replies + entry.judges, 0);
  console.log(`[leak-probe] ${label}: ${pairs} 对（默认 / opus 交错，顺序逐对对调）= ${calls} 次请求${dry ? '（假 Claude，不计额度）' : `；已用 ${used}，总上限 ${TOTAL_CAP}，单次上限 ${RUN_CAP}`}`);
  if (!dry && calls > RUN_CAP) throw new Error(`单次不能超过 ${RUN_CAP} 次（本次 ${calls}），没有开始。`);
  if (!dry && used + calls > TOTAL_CAP) throw new Error(`会超过总上限 ${TOTAL_CAP}（已用 ${used}，本次 ${calls}），没有开始。`);
  const scenario = scenarioById('interview')!;
  const cards = ['momo', 'gene'].map(id => FIDELITY_CARDS.find(card => card.id === id)!);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const samples: ProbeSample[] = [];
  let taken = 0;
  let stopped: string | null = null;
  try {
    for (let pair = 0; pair < pairs; pair++) {
      const card = cards[pair % cards.length];
      const order: Array<'default' | 'opus'> = pair % 2 === 0 ? ['default', 'opus'] : ['opus', 'default'];
      for (const which of order) {
        await runEval({
          label: `${label}:${which}`, model: which === 'opus' ? 'opus' : '', repeat: pair + 1, scenarios: toEvalScenarios([scenario]),
          binary, ...(binaryArgs ? { binaryArgs } : {}), card: { persona: card.persona, mood: card.mood }, prewarmMs: Number(option('prewarm-ms', dry ? '100' : '3000')),
          beforeTurn: () => { taken++; },
          onTurn: record => {
            samples.push({ pair: pair + 1, model: which, card: card.id, record });
            const blocks = record.blocks?.join(',') ?? '–';
            console.log(`  对 ${pair + 1} ${which.padEnd(7)} ${card.id.padEnd(4)} 首字 ${record.chunks[0]?.[0] ?? '–'} ms 块 ${blocks} 思考 ${record.thinking?.length ?? 0} 字 | ${headOf(record)}`);
          },
        });
      }
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    console.log(`[leak-probe] 中止：${stopped}`);
  } finally {
    if (!dry) {
      entries.push({ at: new Date().toISOString(), label, kind: 'run', model: 'default+opus', replies: taken, judges: 0 });
      await mkdir(DIR, { recursive: true });
      await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8');
    }
    const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } })();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DIR, `${stamp}-${label}.json`);
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ kind: 'leak-probe', label, commit, dry, stopped, requests: taken, samples }, null, 2), 'utf8');
    console.log(`[leak-probe] 写入 ${path.relative(root, file)}（${samples.length} 条回复，${taken} 次请求）`);
    // Visible text under the current protocol code, so the table reflects the filter in the tree.
    for (const which of ['default', 'opus'] as const) {
      const mine = samples.filter(sample => sample.model === which);
      const changed = mine.filter(sample => replay(sample.record).visible !== sample.record.liveVisible).length;
      console.log(`  ${which}: ${mine.length} 条；用当前协议代码回放后与当时显示不同的：${changed}`);
    }
  }
}
