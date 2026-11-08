// First-token A/B for I-037 新的反应方式 (docs/claude/2026-11-06-i037-reactions.md):
//   A = the switch off (no haiku beside her reply),
//   B = on: the app's own ReactionHost.userTurn right before the turn, and firstChar on her first delta (as electron/main.ts).
// Same card (Gene), the same ten single-turn messages (praise ×4, good news, coaxing, care, three ordinary ones), interleaved, who goes
// first swapped every pair. B also records what the real haiku picked (only ids, levels, the class and its mood numbers).
// Hard cap on real requests (Opus turns + haiku calls); any failed Opus turn stops the run, nothing is retried. Every turn runs in the
// runner's own temp data folder: nothing of the user's profile, chats or diary is read. Run it through the heavy gate:
//   node scripts/dev/heavy.mjs --label reactions-ab -- node node_modules/tsx/dist/cli.mjs scripts/lib/reactions-ab.ts --pairs 10 --out <dir> [--dry]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { FIDELITY_CARDS } from './fidelity-scenarios';
import { findClaude } from '../../electron/claude';
import { quickLineWithClaude } from '../../electron/inner-loop/model';
import { ReactionHost, type ReactionJournalInput } from '../../electron/reactions/host';
import { deriveDispositions } from '../../shared/behaviors/reactions/dispositions';
import { FakeReactionJudge } from '../../shared/behaviors/reactions/fake';
import type { ReactionPerformer } from '../../shared/behaviors/reactions/interface';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const out = path.resolve(option('out', '.local/reactions-ab'));
const cap = Math.max(1, Math.min(40, Number(option('cap', '36')) || 36));

const MESSAGES: EvalScenario[] = [
  { id: 'praise-cute', title: '被夸·可爱', turns: [{ user: '你今天真的太可爱了吧' }] },
  { id: 'praise-smart', title: '被夸·厉害', turns: [{ user: '你好厉害啊，什么都懂' }] },
  { id: 'praise-pretty', title: '被夸·好看', turns: [{ user: '你今天的样子好好看' }] },
  { id: 'praise-love', title: '被夸·喜欢', turns: [{ user: '我真的好喜欢你说话的样子' }] },
  { id: 'good-news', title: '报喜', turns: [{ user: '我考试过了！！！' }] },
  { id: 'coax', title: '撒娇', turns: [{ user: '抱抱嘛，陪我一会儿好不好' }] },
  { id: 'care', title: '被关心', turns: [{ user: '你今天累不累呀，要不要休息一下' }] },
  { id: 'plain-weather', title: '普通·天气', turns: [{ user: '今天外面下雨了' }] },
  { id: 'plain-lunch', title: '普通·午饭', turns: [{ user: '中午吃了一碗面' }] },
  { id: 'plain-question', title: '普通·问题', turns: [{ user: '你觉得周末去爬山怎么样' }] },
];

interface Pick { scenario: string; event: string; picks: string; delta: string; haiku: string | null; ms: number | null; fromSend: number; haikuStartFromSend: number | null }
let sentAt = 0, reactedAt = 0;

async function main(): Promise<void> {
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const dispositions = deriveDispositions(card.mood);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(process.cwd(), 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  let used = 0;
  const records: TurnRecord[] = [];
  const picks: Pick[] = [];
  let stopped: string | null = null;
  const fake = new FakeReactionJudge(JSON.stringify({ event: 'praise', reactions: [{ id: 'blush', level: 'mid' }], delta: { O: 2 }, confidence: 0.9 }));
  const store = { enabled: true, calls: 0, today: () => 0, noteCall: () => ++store.calls, chatsToday: () => 0, noteChat: () => 0 };
  const record = (id: string): ReactionPerformer => ({ stage: false, gate: () => null, perform: () => { current.played.push(id); return { done: true }; } });
  let current: { scenario: string; played: string[]; journal: ReactionJournalInput | null; settled: Promise<void>; resolve: () => void; startedAt: number } =
    { scenario: '', played: [], journal: null, settled: Promise.resolve(), resolve: () => {}, startedAt: 0 };
  const host = new ReactionHost({
    ask: async (prompt, system, signal) => {
      if (++used > cap) throw new Error(`real request cap ${cap} reached`);
      current.startedAt = performance.now();
      return dry ? fake.ask(prompt, system, signal) : (await quickLineWithClaude(prompt, system, signal)).text;
    },
    store, now: () => ({ characterId: 'gene', dispositions, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: card.persona.slice(0, 400) }),
    quiet: () => null, performers: { blush: record('blush'), shy: record('shy'), happy: record('happy'), action: { ...record('action'), perform: (row) => { current.played.push(String(row.arg)); return { done: true }; } } },
    lift: lift => { current.played.push(`mood ${JSON.stringify(lift.delta)}`); },
    journal: entry => { current.journal = entry; reactedAt = performance.now(); current.resolve(); },
  });
  const run = async (label: 'A' | 'B', scenario: EvalScenario) => {
    let resolve!: () => void;
    current = { scenario: scenario.id, played: [], journal: null, settled: new Promise<void>(done => { resolve = done; }), resolve: () => resolve(), startedAt: 0 };
    await runEval({
      label, model: '', repeat: 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
      prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood },
      beforeTurn: () => { if (++used > cap) throw new Error(`real request cap ${cap} reached`); },
      // As electron/main.ts: the reaction host hears the message right before her turn starts (haiku after startDelayMs, never awaited).
      prepareTurn: ({ index }) => { sentAt = performance.now(); if (label === 'B') host.userTurn(`ab-${scenario.id}-${index}`, scenario.turns[index].user); },
      // As electron/main.ts: haiku starts after her first character.
      onFirstDelta: () => { if (label === 'B') host.firstChar(`ab-${scenario.id}-0`); },
      onTurn: async turn => {
        records.push(turn);
        if (label === 'B') {
          // Her tail (warm or not) as the app would pass it, then wait for haiku (at most its timeout) before the next turn.
          await Promise.race([current.settled, new Promise(done => setTimeout(done, 12_000))]);
          const j = current.journal as ReactionJournalInput | null;
          picks.push({ scenario: scenario.id, event: j?.event ?? '—', picks: j?.picks.map(p => `${p.id}(${p.level}${p.done ? '' : `:${p.why}`})`).join(' ') || '—',
            delta: current.played.filter(p => p.startsWith('mood')).join(' ') || '—', haiku: j?.haiku ?? null, ms: current.startedAt ? Math.round(reactedAt - current.startedAt) : null, fromSend: Math.round(reactedAt - sentAt), haikuStartFromSend: current.startedAt ? Math.round(current.startedAt - sentAt) : null });
        }
        console.log(`${label} ${scenario.id} 首字 ${turn.chunks[0]?.[0] ?? '–'} ms${turn.error ? ` 错误：${turn.error}` : ''}`);
        if (turn.error) throw new Error(`turn failed: ${turn.error}`);
      },
    });
  };
  await mkdir(out, { recursive: true });
  const only = option('only', '').split(',').filter(Boolean);
  const chosen = only.length ? MESSAGES.filter(m => only.includes(m.id)) : MESSAGES;
  const pairs = Math.max(1, Math.min(chosen.length, Number(option('pairs', '10')) || 10));
  try {
    for (const [round, scenario] of chosen.slice(0, pairs).entries()) for (const label of round % 2 === 0 ? ['A', 'B'] as const : ['B', 'A'] as const) await run(label, scenario);
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  host.dispose();
  const first = (label: string) => records.filter(r => r.label === label && !r.error && r.chunks.length).map(r => r.chunks[0][0]);
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pairsDone = chosen.slice(0, pairs).map(s => ({ id: s.id, a: records.find(r => r.scenario === s.id && r.label === 'A' && !r.error)?.chunks[0]?.[0] ?? null,
    b: records.find(r => r.scenario === s.id && r.label === 'B' && !r.error)?.chunks[0]?.[0] ?? null })).filter(p => p.a !== null && p.b !== null) as { id: string; a: number; b: number }[];
  const diffs = pairsDone.map(p => p.b - p.a);
  const result = { dry, requests: used, haikuCalls: store.calls, pairs: pairsDone.length, medianA: median(first('A')), medianB: median(first('B')), medianPairDiff: median(diffs),
    slowerPairs: diffs.filter(d => d > 0).length, stopped, pairsDone, picks };
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.medianPairDiff >= 300 && result.slowerPairs > diffs.length / 2 ? 'B 明显变慢（中位慢 300 ms 以上且多数对变慢）' : 'B 没有明显变慢';
  await writeFile(path.join(out, 'reactions-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
