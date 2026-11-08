// L1 inner loop: one synthetic visible-and-idle day on the real Claude Code (haiku), for Gene and the
// synthetic slower, more easily tired "Momo" (scripts/inner-loop-day-cards.ts).
//
//   node node_modules/tsx/dist/cli.mjs scripts/inner-loop-day.ts            real calls (uses your quota)
//   node node_modules/tsx/dist/cli.mjs scripts/inner-loop-day.ts --dry      fake answers, no calls
//
// Every real call is one model request. .local/inner-loop-day/ledger.json counts them across runs; a run
// that could take the total past 40 does not start. A 429/quota/login failure stops the run (no retry).
// Output (synthetic text only) goes to .local/inner-loop-day/.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decideWithClaude } from '../electron/inner-loop/model';
import { runInnerLoopDay, type DayDecide, type DayResult } from './lib/inner-loop-day';
import { DAY_BLOCKS, GENE_DAY_CARD, SLOW_TIRED_CARD } from './inner-loop-day-cards';

const LIMIT = 40;
// --latency N: only Gene's first stretch, at most N calls (a short timing/cost check).
const latencyIndex = process.argv.indexOf('--latency');
const latencyCalls = latencyIndex >= 0 ? Math.max(1, Math.min(10, Number(process.argv[latencyIndex + 1]) || 5)) : 0;
const CAPS: Record<string, number> = latencyCalls ? { gene: latencyCalls } : { gene: 24, momo: 14 };
const blocks = latencyCalls ? DAY_BLOCKS.slice(0, 1) : DAY_BLOCKS;
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.local', 'inner-loop-day');
const ledgerFile = path.join(outDir, 'ledger.json');
const dry = process.argv.includes('--dry');

async function ledger(): Promise<{ calls: number; runs: string[] }> {
  try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return { calls: 0, runs: [] }; }
}

const fatal = (error: unknown) => /429|rate limit|usage limit|limit reached|额度|繁忙|overloaded|529|未登录|log ?in|credential/i
  .test(String(error instanceof Error ? error.message : error));

await mkdir(outDir, { recursive: true });
const before = await ledger();
const planned = Object.values(CAPS).reduce((sum, n) => sum + n, 0);
if (!dry && before.calls + planned > LIMIT) {
  console.error(`Ledger has ${before.calls} real calls; this run may add ${planned} (limit ${LIMIT}). Not starting.`);
  process.exit(1);
}
const raw: { card: string; info: string; text: string; error?: string }[] = [];
const results: DayResult[] = [];
const label = new Date().toISOString().replace(/[:.]/g, '-');
let stopped: string | null = null;
for (const card of [GENE_DAY_CARD, SLOW_TIRED_CARD].filter(card => CAPS[card.id] !== undefined)) {
  if (stopped) break;
  const decide: DayDecide = async (prompt, signal, info) => {
    const tag = `${info.cue}${info.allowSpeech ? '+speak' : ''}${info.quiet.quiet ? ' quiet' : ''}`;
    if (dry) {
      const text = info.allowSpeech ? '{"action":"speak","text":"忙完了吗？"}' : '{"action":"look"}';
      raw.push({ card: card.id, info: tag, text }); return { text };
    }
    try {
      const answer = await decideWithClaude(prompt, signal);
      raw.push({ card: card.id, info: tag, text: answer.text });
      return answer;
    } catch (error) {
      raw.push({ card: card.id, info: tag, text: '', error: String(error instanceof Error ? error.message : error).slice(0, 200) });
      throw error;
    }
  };
  const result = await runInnerLoopDay({ card, blocks, decide, maxCalls: CAPS[card.id], stopOn: fatal });
  results.push(result);
  stopped = result.stoppedByError;
  console.log(`${card.id}: calls ${result.calls}, decisions ${JSON.stringify(result.decisions)}, results ${JSON.stringify(result.results)}, spoken ${result.spoken.length}, cost $${result.costUsd.toFixed(4)}`);
}
const calls = results.reduce((sum, r) => sum + r.calls, 0);
if (!dry) await writeFile(ledgerFile, JSON.stringify({ calls: before.calls + calls, runs: [...before.runs, `${label}:${calls}`] }, null, 2));
const ms = results.flatMap(r => r.ms).sort((a, b) => a - b);
const pct = (q: number) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : null;
const summary = {
  label, dry, ledgerBefore: before.calls, calls, stopped,
  blocks,
  cards: results.map(r => ({ card: r.card, idleMinutes: r.idleMinutes, opportunities: r.opportunities, calls: r.calls, allowSpeechCalls: r.allowSpeechCalls,
    quietSpeechCalls: r.quietSpeechCalls, decisions: r.decisions, results: r.results, spoken: r.spoken.map(s => ({ at: new Date(s.at).toTimeString().slice(0, 5), text: s.text })),
    costUsd: Number(r.costUsd.toFixed(6)), inputTokens: r.inputTokens, outputTokens: r.outputTokens,
    timeline: r.diagnostics.map(d => `${new Date(d.at).toTimeString().slice(0, 5)} ${d.cue} ${d.called ? 'ask' : '-'} ${d.decision} ${d.result}${d.quiet ? ' quiet' : ''}`) })),
  latencyMs: { min: ms[0] ?? null, p50: pct(0.5), p90: pct(0.9), max: ms.at(-1) ?? null },
  costUsd: Number(results.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
  raw,
};
const file = path.join(outDir, `${label}${dry ? '-dry' : ''}.json`);
await writeFile(file, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, raw: undefined, cards: summary.cards.map(c => ({ ...c, timeline: undefined })) }, null, 2));
console.log(`Saved ${file}`);
