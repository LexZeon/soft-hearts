// First-token A/B for mood batch 1 (docs/claude/2026-11-11-mood-batch1.md): the reply tail's mood sentences
//   A = as before (one sentence "D表示当下奖励期待变化、O亲近、E舒适、N激活、C压力。", six contexts, no numbers),
//   B = the shared compact guide (shared/foundation/mood-guide.ts MOOD_GUIDE_COMPACT), "fright", and her numbers now / baselines,
// through the app's own CompanionService (setTailGuideBefore is the evaluation-only switch). Same card (Gene, synthetic), the same
// single-turn situations, interleaved in one time window, who goes first swapped every pair. Hard cap on real requests; any failed
// turn (429, quota, login) stops the run, nothing is retried. Every turn runs in the runner's own temp data folder: nothing of the
// user's profile, chats or diary is read. Also records the tail each side wrote (context and delta), never judged here.
//   node scripts/dev/heavy.mjs --label mood-guide-ab -- node node_modules/tsx/dist/cli.mjs scripts/lib/mood-guide-ab.ts --pairs 10 --out <dir> [--dry]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import { FIDELITY_CARDS, FIDELITY_SCENARIOS, toEvalScenarios } from './fidelity-scenarios';
import { findClaude } from '../../electron/brain/claude';
import { MOOD_GUIDE_COMPACT } from '../../shared/foundation/mood-guide';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const out = path.resolve(option('out', '.local/mood-guide-ab'));
const cap = Math.max(1, Math.min(30, Number(option('cap', '20')) || 20));

/** The tail as she wrote it (raw stream): context and delta, or null. */
function rawTail(record: TurnRecord): { context: string; delta: unknown } | null {
  const raw = record.chunks.map(([, text]) => text).join('');
  const match = /<sh-state-[a-f0-9]+>([\s\S]*?)<\/sh-state-/u.exec(raw);
  if (!match) return null;
  try { const value = JSON.parse(match[1]) as { context?: unknown; delta?: unknown }; return { context: String(value.context), delta: value.delta ?? null }; } catch { return null; }
}

async function main(): Promise<void> {
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(process.cwd(), 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  let used = 0;
  const records: (TurnRecord & { guided: boolean })[] = [];
  let stopped: string | null = null;
  const run = async (label: 'A' | 'B', scenario: ReturnType<typeof toEvalScenarios>[number]) => {
    await runEval({
      label, model: '', repeat: 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
      prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood },
      prepareTurn: ({ companion }) => { companion.setTailGuideBefore(label === 'A'); },
      beforeTurn: () => { if (++used > cap) throw new Error(`real request cap ${cap} reached`); },
      onTurn: record => {
        const guided = (record.prompt ?? '').includes(MOOD_GUIDE_COMPACT);
        records.push({ ...record, guided });
        console.log(`${label} ${scenario.id} 首字 ${record.chunks[0]?.[0] ?? '–'} ms 尾注 ${JSON.stringify(rawTail(record))}${record.error ? ` 错误：${record.error}` : ''}`);
        if (record.error) throw new Error(`turn failed: ${record.error}`);
      },
    });
  };
  await mkdir(out, { recursive: true });
  const pairs = Math.max(1, Math.min(15, Number(option('pairs', '10')) || 10));
  const scenarios = FIDELITY_SCENARIOS.filter(scenario => scenario.turns.length === 1 && !scenario.onlyCards && !scenario.away).slice(0, pairs);
  if (scenarios.length < pairs) throw new Error(`only ${scenarios.length} single-turn situations`);
  try {
    for (const [round, scenario] of scenarios.entries())
      for (const label of round % 2 === 0 ? ['A', 'B'] as const : ['B', 'A'] as const) await run(label, toEvalScenarios([scenario])[0]);
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  const first = (label: string) => records.filter(r => r.label === label && !r.error && r.chunks.length).map(r => r.chunks[0][0]);
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const find = (id: string, label: string) => records.find(r => r.scenario === id && r.label === label && !r.error);
  const pairsDone = scenarios.map(s => ({ id: s.id, a: find(s.id, 'A')?.chunks[0]?.[0] ?? null, b: find(s.id, 'B')?.chunks[0]?.[0] ?? null,
    aTail: find(s.id, 'A') ? rawTail(find(s.id, 'A')!) : null, bTail: find(s.id, 'B') ? rawTail(find(s.id, 'B')!) : null }))
    .filter(p => p.a !== null && p.b !== null) as { id: string; a: number; b: number; aTail: unknown; bTail: unknown }[];
  const diffs = pairsDone.map(p => p.b - p.a);
  const guidedRight = records.every(r => r.guided === (r.label === 'B'));
  const result = { dry, requests: used, pairs: pairsDone.length, medianA: median(first('A')), medianB: median(first('B')), medianPairDiff: median(diffs),
    meanPairDiff: diffs.length ? Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length) : null, slowerPairs: diffs.filter(d => d > 0).length, guidedRight, stopped, pairsDone };
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.medianPairDiff >= 300 && result.slowerPairs > diffs.length / 2 ? 'B 明显变慢（中位慢 300 ms 以上且多数对变慢）' : 'B 没有明显变慢';
  await writeFile(path.join(out, 'first-token-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
