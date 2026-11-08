// R28: evaluate the prompts the app actually sends, on real Claude Code.
//
//   node node_modules/tsx/dist/cli.mjs scripts/prompt-eval.ts --models haiku,default --label baseline
//   ... --dry                          offline fake Claude Code (no model calls, not counted)
//   ... --scenarios sad,multi          subset (see scripts/lib/prompt-eval-scenarios.ts)
//   ... --repeat 2                     run every scenario twice per model
//   ... --turns 4                      keep only the first 4 turns of each scenario
//   ... --ab-strip "<exact text>"      interleaved A/B: each scenario runs without, then with, that prompt text
//   ... --summarize a.json b.json      re-analyse recorded runs with the current protocol code (no calls)
// A failed turn (429, quota, login, safety stop) ends the run; nothing is retried.
//
//   ... --suite fidelity [--dry] [--model sonnet] [--cards gene,momo,atang] [--scenarios betrayed,lonely] [--label name]
//       the "像不像她" suite: 3 cards × 14 situations, hard rules + a scoring model; report in .local/fidelity/
//       (own ledger, 650 requests in total, at most 100 per run). See scripts/lib/fidelity-cli.ts and
//       docs/claude/2026-11-02-fidelity-test.md.
//
//   ... --suite pace [--groups short,vent,ask] [--cards gene] [--no-judge] [--label name] [--dry]
//       F7 说话节奏: does Claude already follow the user's length (very short / pouring out / asking)? Counted by program,
//       outpourings optionally scored; counts against the fidelity ledger. See scripts/lib/pace-probe.ts.
//
//   ... --suite leak-probe --pairs 12 [--label name] [--dry]
//       default model vs `--model opus`, interleaved, on the situation that triggers leaked drafts; records content-block kinds
//       (counts against the fidelity ledger, at most 30 requests per run). See scripts/lib/leak-probe.ts and
//       docs/claude/2026-11-02-leaked-drafts.md.
//
//   ... --suite draft-leak --phase scan|ab [--rounds 2] [--pairs 12] [--dry]
//       drafts leaking into the bubble on the RPS request turn with F2's judgment held (one-sentence and full card);
//       counts against the fidelity ledger, at most 80 requests for that task. See scripts/lib/draft-leak-probe.ts and
//       docs/claude/2026-11-03-draft-leak-fix.md.
//
// Every real turn is one model request. The ledger in .local/prompt-eval/ledger.json
// counts them across runs; a run that would take the total past --cap (default 200)
// does not start. Output (JSON + Markdown, synthetic text only) goes to .local/prompt-eval/.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../electron/claude';
import { markdownReport, summarize, summaryTable, type TurnRecord } from './lib/prompt-eval-analysis';
import { selectScenarios } from './lib/prompt-eval-scenarios';
import { runEval } from './lib/prompt-eval-runner';
import { runFidelityCli } from './lib/fidelity-cli';
import { runLeakProbeCli } from './lib/leak-probe';
import { runPaceProbeCli } from './lib/pace-probe';
import { runDraftLeakCli } from './lib/draft-leak-probe';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.local', 'prompt-eval');
const ledgerFile = path.join(outDir, 'ledger.json');

function option(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface LedgerEntry { at: string; label: string; model: string; turns: number }
async function ledger(): Promise<LedgerEntry[]> {
  try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; }
}

async function summarizeFiles(files: string[]): Promise<void> {
  const records: TurnRecord[] = [];
  for (const file of files) records.push(...(JSON.parse(await readFile(file, 'utf8')).records as TurnRecord[]));
  console.log(summaryTable(summarize(records)));
  const out = option('out');
  if (out) await writeFile(out, markdownReport('R28 提示词评测（回放）', records, [`来源：${files.map(file => path.basename(file)).join('、')}`, '用当前协议代码重新分析录下的原始输出，没有新的模型请求。']), 'utf8');
}

async function main(): Promise<void> {
  if (option('suite') === 'fidelity') { await runFidelityCli(); return; }
  if (option('suite') === 'leak-probe') { await runLeakProbeCli(); return; }
  if (option('suite') === 'pace') { await runPaceProbeCli(); return; }
  if (option('suite') === 'draft-leak') { await runDraftLeakCli(); return; }
  if (option('suite')) throw new Error(`未知的 --suite：${option('suite')}（fidelity、leak-probe、pace、draft-leak）`);
  if (flag('summarize')) {
    await summarizeFiles(process.argv.slice(process.argv.indexOf('--summarize') + 1).filter(value => !value.startsWith('--') && value.endsWith('.json')));
    return;
  }
  const dry = flag('dry');
  const models = option('models', 'haiku').split(',').map(value => value.trim()).map(value => value === 'default' ? '' : value);
  const ids = option('scenarios').split(',').map(value => value.trim()).filter(Boolean);
  const scenarios = selectScenarios(ids);
  if (!scenarios.length) throw new Error(`未知场景：${ids.join(',')}`);
  const repeat = Math.max(1, Number(option('repeat', '1')) || 1);
  const label = option('label', dry ? 'dry' : 'run');
  const cap = Number(option('cap', '200'));
  const maxTurns = option('turns') ? Math.max(1, Number(option('turns'))) : undefined;
  // --ab-strip <text>: interleaved A/B of one sentence that is in the code, in one time window.
  // Variant A removes the exact text on its way to stdin; B sends the prompt unchanged.
  const strip = option('ab-strip');
  const variants = strip ? [
    { label: `${label}-without`, rewrite: (prompt: string) => {
      if (!prompt.includes(strip)) throw new Error('--ab-strip 的文字不在本轮提示词里，A/B 无效。');
      return prompt.split(strip).join('');
    } },
    { label: `${label}-with` },
  ] : undefined;
  const estimate = scenarios.reduce((sum, scenario) => sum + Math.min(scenario.turns.length, maxTurns ?? Infinity), 0)
    * models.length * repeat * (variants?.length ?? 1);
  const used = (await ledger()).reduce((sum, entry) => sum + entry.turns, 0);
  console.log(`[prompt-eval] ${label}: ${scenarios.length} 个场景 × ${models.map(model => model || 'default').join('/')} × ${repeat} 次 = ${estimate} 轮${dry ? '（假 Claude，不计额度）' : `；已用 ${used} 轮，上限 ${cap}`}`);
  if (!dry && used + estimate > cap) throw new Error(`会超过 ${cap} 轮上限（已用 ${used}，本次 ${estimate}），没有开始。`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const records: TurnRecord[] = [];
  let real = 0;
  const entries = await ledger();
  const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } })();
  const dirty = (() => { try { return execFileSync('git', ['status', '--porcelain', '--', 'electron', 'shared'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return -1; } })();
  try {
    for (let round = 1; round <= repeat; round++) {
      for (const model of models) {
        let turns = 0;
        try {
          await runEval({
            label, model, repeat: round, scenarios, binary, binaryArgs, perMessage: flag('per-message'), maxTurns, variants,
            prewarmMs: Number(option('prewarm-ms', dry ? '200' : '3000')),
            beforeTurn: () => { if (!dry && used + real + 1 > cap) throw new Error('已到额度上限，停止。'); turns++; real += dry ? 0 : 1; },
            onTurn: record => {
              records.push(record);
              console.log(`  ${model || 'default'} r${round} ${record.scenario}#${record.turn} ${record.process ?? ''} 首字 ${record.chunks[0]?.[0] ?? '–'} ms ${record.error ? `错误：${record.error}` : ''}`);
            },
          });
        } finally {
          if (!dry) entries.push({ at: new Date().toISOString(), label, model: model || 'default', turns });
        }
      }
    }
  } finally {
    if (!dry) await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8');
    const base = path.join(outDir, `${stamp}-${label}`);
    const notes = [`代码：${commit}${dirty ? `（electron/shared 有 ${dirty} 个未提交改动）` : ''}`, `模型：${models.map(model => model || 'default').join('、')}；每个场景 ${repeat} 次`,
      dry ? '假 Claude Code，不代表真实效果。' : `本次真实调用 ${real} 轮；累计 ${used + real} 轮。`];
    await writeFile(`${base}.json`, JSON.stringify({ label, commit, dirty, dry, at: new Date().toISOString(), records }, null, 2), 'utf8');
    await writeFile(`${base}.md`, markdownReport(`R28 提示词评测：${label}`, records, notes), 'utf8');
    console.log(summaryTable(summarize(records)));
    console.log(`[prompt-eval] 写入 ${path.relative(root, base)}.json / .md`);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
