// First-token A/B for the warm haiku of I-037 新的反应方式 (docs/claude/2026-11-07-reactions-warm-haiku.md):
//   A = the way before: the switch on, haiku asked after her first character, one `claude -p` per call (quickLineWithClaude);
//   B = a warm haiku (electron/inner-loop/warm-line.ts, started and booted while nothing runs) asked knobs.startDelayMs after the
//       message, beside her reply (knobs.warmParallel).
//   C (--arms C, its own run): the same warm haiku, asked after her first character (knobs.warmParallel false).
// Both arms run the app's own ReactionHost (userTurn right before her turn, firstChar on her first delta, as electron/main.ts).
// Same card (Gene), the same single-turn messages, interleaved, who goes first swapped every pair. Reports her first character, the
// time from sending to the reaction being decided (the journal line), and what haiku picked (ids and levels only).
// Hard cap on real requests (Opus turns + haiku calls, both arms); any failed Opus turn stops the run, nothing is retried. Every turn
// runs in the runner's own temp data folder: nothing of the user's profile, chats or diary is read. Run it through the heavy gate:
//   node scripts/dev/heavy.mjs --label reactions-warm-ab -- node node_modules/tsx/dist/cli.mjs scripts/lib/reactions-warm-ab.ts --pairs 10 --out <dir> [--dry]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { FIDELITY_CARDS } from './fidelity-scenarios';
import { findClaude } from '../../electron/claude';
import { quickLineWithClaude } from '../../electron/inner-loop/model';
import { WarmLine } from '../../electron/inner-loop/warm-line';
import { ReactionHost, type ReactionJournalInput } from '../../electron/reactions/host';
import { deriveDispositions } from '../../shared/behaviors/reactions/dispositions';
import { FakeReactionJudge } from '../../shared/behaviors/reactions/fake';
import type { ReactionPerformer } from '../../shared/behaviors/reactions/interface';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const out = path.resolve(option('out', '.local/reactions-warm-ab'));
const cap = Math.max(1, Math.min(45, Number(option('cap', '42')) || 42));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

const MESSAGES: EvalScenario[] = [
  { id: 'praise-cute', title: '被夸·可爱', turns: [{ user: '你今天真的太可爱了吧' }] },
  { id: 'good-news', title: '报喜', turns: [{ user: '我考试过了！！！' }] },
  { id: 'coax', title: '撒娇', turns: [{ user: '抱抱嘛，陪我一会儿好不好' }] },
  { id: 'care', title: '被关心', turns: [{ user: '你今天累不累呀，要不要休息一下' }] },
  { id: 'plain-weather', title: '普通·天气', turns: [{ user: '今天外面下雨了' }] },
  { id: 'praise-smart', title: '被夸·厉害', turns: [{ user: '你好厉害啊，什么都懂' }] },
  { id: 'plain-lunch', title: '普通·午饭', turns: [{ user: '中午吃了一碗面' }] },
  { id: 'praise-pretty', title: '被夸·好看', turns: [{ user: '你今天的样子好好看' }] },
  { id: 'plain-question', title: '普通·问题', turns: [{ user: '你觉得周末去爬山怎么样' }] },
  { id: 'praise-love', title: '被夸·喜欢', turns: [{ user: '我真的好喜欢你说话的样子' }] },
];

interface Row {
  label: 'A' | 'B' | 'C'; scenario: string; first: number | null; mode: string; haikuStartFromSend: number | null; haikuMs: number | null;
  reactedFromSend: number | null; warmTurn: number | null; event: string; picks: string; haiku: string | null;
}

async function main(): Promise<void> {
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const dispositions = deriveDispositions(card.mood);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(process.cwd(), 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  let used = 0, busy = true;
  const count = () => { if (++used > cap) throw new Error(`real request cap ${cap} reached`); };
  const records: TurnRecord[] = [];
  const rows: Row[] = [];
  let stopped: string | null = null;
  const fake = new FakeReactionJudge(JSON.stringify({ event: 'praise', reactions: [{ id: 'blush', level: 'mid' }], delta: { O: 2 }, confidence: 0.9 }));
  const store = { enabled: true, calls: 0, today: () => 0, noteCall: () => ++store.calls, chatsToday: () => 0, noteChat: () => 0 };
  const record = (): ReactionPerformer => ({ stage: false, gate: () => null, perform: () => ({ done: true }) });
  const performers = { blush: record(), shy: record(), happy: record(), action: record() };
  let current = { sentAt: 0, haikuStart: 0, haikuEnd: 0, reactedAt: 0, parallelBefore: 0, warmTurn: null as number | null, journal: null as ReactionJournalInput | null,
    settled: Promise.resolve(), resolve: () => {} };
  const oneShot = async (prompt: string, system: string, signal: AbortSignal) => dry ? fake.ask(prompt, system, signal) : (await quickLineWithClaude(prompt, system, signal)).text;
  const timed = (call: (prompt: string, system: string, signal: AbortSignal) => Promise<string>) => async (prompt: string, system: string, signal: AbortSignal) => {
    count();
    current.haikuStart = performance.now();
    try { return await call(prompt, system, signal); } finally { current.haikuEnd = performance.now(); }
  };
  const base = {
    store, performers, quiet: () => null, lift: () => {},
    now: () => ({ characterId: 'gene', dispositions, mood: 'calm' as const, moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: card.persona.slice(0, 400) }),
    journal: (entry: ReactionJournalInput) => { current.journal = entry; current.reactedAt = performance.now(); current.resolve(); },
  };
  let hostB!: ReactionHost;
  const warm = new WarmLine({ systemPrompt: () => hostB.systemPrompt, allowed: () => true, busy: () => busy, binary: async () => binary,
    ...(binaryArgs ? { binaryArgs } : {}), retryMs: 500, log: line => console.log(`[warm] ${line}`) });
  const hostA = new ReactionHost({ ...base, ask: timed(oneShot) });
  const warmAsk = timed((prompt, system, signal) => { if (warm.alive) { current.warmTurn = warm.heldTurns + 1; return warm.ask(prompt, signal); } return oneShot(prompt, system, signal); });
  const hostC = new ReactionHost({ ...base, warm: () => warm.ready, knobs: { warmParallel: false }, ask: warmAsk });
  hostB = new ReactionHost({ ...base, warm: () => warm.ready, knobs: { warmParallel: true },
    ask: timed((prompt, system, signal) => { if (warm.alive) { current.warmTurn = warm.heldTurns + 1; return warm.ask(prompt, signal); } return oneShot(prompt, system, signal); }) });
  /** Between turns (nothing runs): let the warm haiku start or be rebuilt, and wait until it has booted. */
  const quiet = async () => {
    busy = false;
    warm.want(0);
    const deadline = Date.now() + 20_000;
    while (!warm.ready && Date.now() < deadline) { await sleep(200); }
    busy = true;
  };
  const run = async (label: 'A' | 'B' | 'C', scenario: EvalScenario) => {
    const host = label === 'A' ? hostA : label === 'B' ? hostB : hostC;
    let resolve!: () => void;
    current = { sentAt: 0, haikuStart: 0, haikuEnd: 0, reactedAt: 0, parallelBefore: host.stats.parallel, warmTurn: null, journal: null, settled: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    const id = `ab-${label}-${scenario.id}`;
    await runEval({
      label, model: '', repeat: 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
      prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood },
      beforeTurn: count,
      prepareTurn: () => { current.sentAt = performance.now(); host.userTurn(id, scenario.turns[0].user); },
      onFirstDelta: () => { host.firstChar(id); },
      onTurn: async turn => {
        records.push(turn);
        // The reaction decided (journal), or haiku's call ended without one (failed / invalid: her tail is not simulated here).
        await Promise.race([current.settled, (async () => { while (!current.haikuEnd) await sleep(50); await sleep(100); })(), sleep(15_000)]);
        const j = current.journal;
        const rel = (at: number) => at ? Math.round(at - current.sentAt) : null;
        rows.push({ label, scenario: scenario.id, first: turn.chunks[0]?.[0] ?? null, mode: host.stats.parallel > current.parallelBefore ? 'parallel' : 'first-char',
          haikuStartFromSend: rel(current.haikuStart), haikuMs: current.haikuStart && current.haikuEnd ? Math.round(current.haikuEnd - current.haikuStart) : null,
          reactedFromSend: rel(current.reactedAt), warmTurn: current.warmTurn, event: j?.event ?? '—',
          picks: j?.picks.map(p => `${p.id}(${p.level}${p.done ? '' : `:${p.why}`})`).join(' ') || '—', haiku: j?.haiku ?? null });
        const row = rows.at(-1)!;
        console.log(`${label} ${scenario.id} 首字 ${row.first ?? '–'} ms，haiku 起 ${row.haikuStartFromSend ?? '–'} ms（${row.mode}${row.warmTurn ? `，待命进程第 ${row.warmTurn} 次` : ''}），用时 ${row.haikuMs ?? '–'} ms，反应 ${row.reactedFromSend ?? '–'} ms：${row.event} ${row.picks}${turn.error ? ` 错误：${turn.error}` : ''}`);
        if (turn.error) throw new Error(`turn failed: ${turn.error}`);
      },
    });
    await quiet();
  };
  await mkdir(out, { recursive: true });
  const pairs = Math.max(1, Math.min(MESSAGES.length, Number(option('pairs', '10')) || 10));
  try {
    await quiet();
    const arms = option('arms', 'AB');
    if (arms === 'C') for (const scenario of MESSAGES.slice(0, pairs)) await run('C', scenario);
    else for (const [round, scenario] of MESSAGES.slice(0, pairs).entries()) for (const label of round % 2 === 0 ? ['A', 'B'] as const : ['B', 'A'] as const) await run(label, scenario);
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  hostA.dispose(); hostB.dispose(); hostC.dispose(); warm.dispose();
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const of = (label: string, key: keyof Row) => rows.filter(r => r.label === label && typeof r[key] === 'number').map(r => r[key] as number);
  const pairsDone = MESSAGES.slice(0, pairs).map(s => ({ id: s.id, a: rows.find(r => r.scenario === s.id && r.label === 'A')?.first ?? null,
    b: rows.find(r => r.scenario === s.id && r.label === 'B')?.first ?? null })).filter(p => p.a !== null && p.b !== null) as { id: string; a: number; b: number }[];
  const diffs = pairsDone.map(p => p.b - p.a);
  const result = {
    dry, requests: used, haikuCalls: store.calls, warm: warm.stats, pairs: pairsDone.length,
    firstA: median(of('A', 'first')), firstB: median(of('B', 'first')), medianPairDiff: median(diffs), slowerPairs: diffs.filter(d => d > 0).length,
    reactedA: median(of('A', 'reactedFromSend')), reactedB: median(of('B', 'reactedFromSend')), firstC: median(of('C', 'first')), reactedC: median(of('C', 'reactedFromSend')),
    haikuMsC: median(of('C', 'haikuMs')),
    haikuMsA: median(of('A', 'haikuMs')), haikuMsB: median(of('B', 'haikuMs')),
    haikuStartA: median(of('A', 'haikuStartFromSend')), haikuStartB: median(of('B', 'haikuStartFromSend')),
    parallelB: rows.filter(r => r.label === 'B' && r.mode === 'parallel').length, stopped, pairsDone, rows,
  };
  const bRows = rows.filter(r => r.label === 'B').length;
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.parallelB < bRows ? `B 组有 ${bRows - result.parallelB} 次没走并行：这轮不算数`
    : result.medianPairDiff >= 150 && result.slowerPairs > diffs.length / 2 ? 'B 变慢（逐对中位慢 150 ms 以上且多数对变慢）：不切换默认' : 'B 没有变慢到门槛：可以切换默认';
  await writeFile(path.join(out, 'reactions-warm-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, rows: undefined, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
