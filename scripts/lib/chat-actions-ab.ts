// First-token A/B and a behaviour look for her small actions (universal skeleton step 5, docs/claude/2026-11-06-skeleton-step5.md):
//   A = the tail instruction as before (no small actions offered),
//   B = the same turn with all seven offered (Gene can do all of them), through the app's own CompanionService.setChatActions.
// Same card (Gene), same single-turn situations, interleaved in one time window, who goes first swapped every pair. Hard cap on
// real requests; any failed turn (429, quota, login) stops the run, nothing is retried. Every scenario runs in the runner's own
// temp data folder: nothing of the user's profile, chats or diary is read.
//   node node_modules/tsx/dist/cli.mjs scripts/lib/chat-actions-ab.ts --mode ab --pairs 10 --out <dir> [--dry]
//   node node_modules/tsx/dist/cli.mjs scripts/lib/chat-actions-ab.ts --mode behavior --out <dir> [--dry]
//     behavior: a few lines that might invite an action, B only; records the visible reply, the tail's gesture and the pick sent.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { FIDELITY_CARDS, FIDELITY_SCENARIOS, toEvalScenarios } from './fidelity-scenarios';
import { CHAT_ACTION_WORDS, type ChatActionWord } from '../../shared/chat-actions';
import { findClaude } from '../../electron/claude';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const mode = option('mode', 'ab');
const out = path.resolve(option('out', '.local/chat-actions-ab'));
const cap = Math.max(1, Math.min(30, Number(option('cap', '20')) || 20));

interface Variant { label: 'A' | 'B'; actions: readonly ChatActionWord[] }
const A: Variant = { label: 'A', actions: [] }, B: Variant = { label: 'B', actions: [...CHAT_ACTION_WORDS] };

const BEHAVIOR: EvalScenario[] = [
  { id: 'interview-passed', title: '面试过了', turns: [{ user: '我今天面试过了！！' }] },
  { id: 'morning', title: '早上好', turns: [{ user: '早上好呀' }] },
  { id: 'drew-heart', title: '你看我画的心', turns: [{ user: '你看我给你画了一颗心♡' }] },
  { id: 'ignored', title: '刚才不理我', turns: [{ user: '哼，你刚刚都不理我' }] },
  { id: 'question', title: '问个问题', turns: [{ user: '你说周末是去爬山好还是在家睡觉好？' }] },
  { id: 'tired', title: '好累', turns: [{ user: '今天加班到现在，好累啊' }] },
  { id: 'back-home', title: '我回来啦', turns: [{ user: '我回来啦～' }] },
  { id: 'joke', title: '逗她', turns: [{ user: '你今天是不是偷偷吃了我的布丁' }] },
];

/** The tail's gesture as she wrote it (raw stream), or null. */
function rawGesture(record: TurnRecord): string | null {
  const raw = record.chunks.map(([, text]) => text).join('');
  const match = /<sh-state-[a-f0-9]+>([\s\S]*?)<\/sh-state-/u.exec(raw);
  if (!match) return null;
  try { const value = JSON.parse(match[1]) as { gesture?: unknown }; return typeof value.gesture === 'string' ? value.gesture : 'none'; } catch { return '(unreadable)'; }
}

async function main(): Promise<void> {
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(process.cwd(), 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  let used = 0;
  const records: (TurnRecord & { picks: ChatActionWord[]; offered: boolean })[] = [];
  let stopped: string | null = null;
  const run = async (variant: Variant, scenario: EvalScenario) => {
    const picks: ChatActionWord[] = [];
    await runEval({
      label: variant.label, model: '', repeat: 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
      prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood },
      // The app's own wiring: B offers the seven through the companion's port (the stage is not here; a pick is only recorded).
      prepareTurn: ({ companion }) => { companion.setChatActions(variant.actions.length ? { offered: () => variant.actions, request: word => { picks.push(word); }, cancel: () => {} } : null); },
      beforeTurn: () => { if (++used > cap) throw new Error(`real request cap ${cap} reached`); },
      onTurn: record => {
        const offered = (record.prompt ?? '').includes('/wave/nod/tilt/heart/clap/wink/pout');
        records.push({ ...record, picks, offered });
        console.log(`${variant.label} ${scenario.id} 首字 ${record.chunks[0]?.[0] ?? '–'} ms 尾注 gesture=${rawGesture(record)}${record.error ? ` 错误：${record.error}` : ''}`);
      },
    });
  };
  await mkdir(out, { recursive: true });
  if (mode === 'behavior') {
    const only = option('only', '').split(',').filter(Boolean);
    try { for (const scenario of BEHAVIOR.filter(s => !only.length || only.includes(s.id))) await run(B, scenario); }
    catch (error) { stopped = error instanceof Error ? error.message : String(error); }
    const rows = records.map(r => ({ scenario: r.scenario, user: r.user, gesture: rawGesture(r), picks: r.picks, offered: r.offered, firstMs: r.chunks[0]?.[0] ?? null, reply: r.liveVisible, error: r.error }));
    await writeFile(path.join(out, 'behavior.json'), JSON.stringify({ dry, requests: used, stopped, rows }, null, 2), 'utf8');
    for (const row of rows) console.log(`\n[${row.scenario}] gesture=${row.gesture} 发出=${row.picks.join(',') || '无'}\n${row.reply}`);
    return;
  }
  const pairs = Math.max(1, Math.min(15, Number(option('pairs', '10')) || 10));
  const scenarios = FIDELITY_SCENARIOS.filter(scenario => scenario.turns.length === 1 && !scenario.onlyCards && !scenario.away).slice(0, pairs);
  if (scenarios.length < pairs) throw new Error(`only ${scenarios.length} single-turn situations`);
  try {
    for (const [round, scenario] of scenarios.entries()) {
      for (const variant of round % 2 === 0 ? [A, B] : [B, A]) await run(variant, toEvalScenarios([scenario])[0]);
    }
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  const first = (label: string) => records.filter(record => record.label === label && !record.error && record.chunks.length).map(record => record.chunks[0][0]);
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pairsDone = scenarios.map(scenario => ({ id: scenario.id, a: records.find(r => r.scenario === scenario.id && r.label === 'A' && !r.error)?.chunks[0]?.[0] ?? null,
    b: records.find(r => r.scenario === scenario.id && r.label === 'B' && !r.error)?.chunks[0]?.[0] ?? null,
    bGesture: (() => { const r = records.find(x => x.scenario === scenario.id && x.label === 'B'); return r ? rawGesture(r) : null; })(),
    aGesture: (() => { const r = records.find(x => x.scenario === scenario.id && x.label === 'A'); return r ? rawGesture(r) : null; })() }))
    .filter(pair => pair.a !== null && pair.b !== null) as { id: string; a: number; b: number; aGesture: string | null; bGesture: string | null }[];
  const diffs = pairsDone.map(pair => pair.b - pair.a);
  const slower = diffs.filter(d => d > 0).length;
  const offeredRight = records.every(r => r.offered === (r.label === 'B'));
  const result = { dry, requests: used, pairs: pairsDone.length, medianA: median(first('A')), medianB: median(first('B')), medianPairDiff: median(diffs),
    meanPairDiff: diffs.length ? Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length) : null, slowerPairs: slower, offeredRight, stopped, pairsDone };
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.medianPairDiff >= 300 && slower > diffs.length / 2 ? 'B 明显变慢（中位慢 300 ms 以上且多数对变慢）：不开' : 'B 没有明显变慢：可以开';
  await writeFile(path.join(out, 'first-token-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
