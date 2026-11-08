// First-character A/B for I-040 看一眼、听一下 (docs/claude/2026-11-07-sense-router.md):
//   A = today's path: the reaction judge on a warm haiku, asked beside her reply (knobs.warmParallel), no senses question, no hint;
//   B = the router on: the same warm haiku call carries the 【感知】 block, and her turn carries the one local hint sentence.
// What the router does after her reply (one look, haiku's facts, her short line) is by construction after her first character and
// is not run here: capture returns nothing (no camera, no screen, no private data), so B costs exactly what A costs plus the block.
// Same card (Gene), the same single-turn messages, interleaved, who goes first swapped every pair. Reports her first character, when
// haiku answered, and which senses haiku named in B (ids only). Hard cap on real requests; any failed Opus turn stops the run. Every
// turn runs in the runner's own temp data folder: nothing of the user's profile, chats or diary is read. Run it through the heavy gate:
//   node scripts/dev/heavy.mjs --label sense-router-ab -- node node_modules/tsx/dist/cli.mjs scripts/lib/sense-router-ab.ts --pairs 20 --out <dir> [--dry]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runEval } from './prompt-eval-runner';
import type { TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { FIDELITY_CARDS } from './fidelity-scenarios';
import { findClaude } from '../../electron/claude';
import { quickLineWithClaude } from '../../electron/inner-loop/model';
import { WarmLine } from '../../electron/inner-loop/warm-line';
import { ReactionHost, type ReactionJournalInput, type ReactionSensePort } from '../../electron/reactions/host';
import { SenseRouterHost } from '../../electron/sense-router/host';
import { deriveDispositions } from '../../shared/behaviors/reactions/dispositions';
import { FakeReactionJudge } from '../../shared/behaviors/reactions/fake';
import type { ReactionPerformer } from '../../shared/behaviors/reactions/interface';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const out = path.resolve(option('out', '.local/sense-router-ab'));
const cap = Math.max(1, Math.min(90, Number(option('cap', '84')) || 84));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

const MESSAGES: EvalScenario[] = [
  { id: 'cam-clothes', title: '摄像头·衣服', turns: [{ user: '我今天这件衣服怎么样' }] },
  { id: 'plain-rain', title: '普通·下雨', turns: [{ user: '今天外面下雨了' }] },
  { id: 'screen-error', title: '屏幕·报错', turns: [{ user: '你看我屏幕上这个报错是什么意思' }] },
  { id: 'praise-cute', title: '被夸·可爱', turns: [{ user: '你今天真的太可爱了吧' }] },
  { id: 'cam-face', title: '摄像头·气色', turns: [{ user: '你觉得我今天气色怎么样' }] },
  { id: 'heard-guest', title: '转写·嘉宾', turns: [{ user: '刚才视频里说的那个人是谁来着' }] },
  { id: 'plain-lunch', title: '普通·午饭', turns: [{ user: '中午吃了一碗面' }] },
  { id: 'cam-cup', title: '摄像头·杯子', turns: [{ user: '猜猜我手里拿的是什么' }] },
  { id: 'screen-page', title: '屏幕·网页', turns: [{ user: '这个网页好看吗' }] },
  { id: 'care', title: '被关心', turns: [{ user: '你今天累不累呀，要不要休息一下' }] },
  { id: 'heard-song', title: '转写·歌', turns: [{ user: '刚刚那段话你听懂了吗' }] },
  { id: 'plain-weekend', title: '普通·周末', turns: [{ user: '你觉得周末去爬山怎么样' }] },
  { id: 'cam-hair', title: '摄像头·发型', turns: [{ user: '我剪了头发，你发现了吗' }] },
  { id: 'good-news', title: '报喜', turns: [{ user: '我考试过了！！！' }] },
  { id: 'screen-game', title: '屏幕·游戏', turns: [{ user: '你看我这局打得怎么样' }] },
  { id: 'coax', title: '撒娇', turns: [{ user: '抱抱嘛，陪我一会儿好不好' }] },
  { id: 'cam-cat', title: '摄像头·猫', turns: [{ user: '我家猫跳到桌子上了哈哈' }] },
  { id: 'plain-tired', title: '普通·累', turns: [{ user: '今天上班好累' }] },
  { id: 'heard-news', title: '转写·新闻', turns: [{ user: '刚才新闻里说的那件事你怎么看' }] },
  { id: 'praise-love', title: '被夸·喜欢', turns: [{ user: '我真的好喜欢你说话的样子' }] },
];

interface Row {
  label: 'A' | 'B'; scenario: string; first: number | null; haikuStartFromSend: number | null; haikuMs: number | null;
  reactedFromSend: number | null; senses: string | null; hint: boolean;
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
  const fake = new FakeReactionJudge(JSON.stringify({ event: 'praise', reactions: [{ id: 'blush', level: 'mid' }], delta: { O: 2 }, confidence: 0.9, senses: ['camera'] }));
  const store = { enabled: true, calls: 0, today: () => 0, noteCall: () => ++store.calls, chatsToday: () => 0, noteChat: () => 0 };
  const record = (): ReactionPerformer => ({ stage: false, gate: () => null, perform: () => ({ done: true }) });
  const performers = { blush: record(), shy: record(), happy: record(), action: record() };
  let current = { sentAt: 0, haikuStart: 0, haikuEnd: 0, reactedAt: 0, journal: null as ReactionJournalInput | null, senses: null as string | null, hint: false,
    settled: Promise.resolve(), resolve: () => {} };
  const oneShot = async (prompt: string, system: string, signal: AbortSignal) => dry ? fake.ask(prompt, system, signal) : (await quickLineWithClaude(prompt, system, signal)).text;
  const now = () => ({ characterId: 'gene', dispositions, mood: 'calm' as const, moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: card.persona.slice(0, 400) });
  // B's router: every sense "on" (so the block and the hint are as large as they get), nothing ever captured or read.
  const router = new SenseRouterHost({
    enabled: () => true, on: () => ({ camera: true, screen: true, transcript: true }), identity: () => 'ab', conversation: () => 'ab',
    capture: async () => null, heard: () => null, ask: async () => '看不清', line: () => null,
    character: () => ({ id: 'gene', persona: '', language: '' }), mood: () => '', free: () => false, publish: () => false, speechStyle: () => {},
    archive: async () => {}, log: () => {}, knobs: { firstLineHint: !process.argv.includes('--no-hint') }, // --no-hint: the block only
  });
  const senses: ReactionSensePort = { block: id => router.port.block(id), answer: (id, named, taken) => { current.senses = named === null ? (taken ? 'unread' : 'not-asked') : named.join('+') || 'none'; router.port.answer(id, named, taken); } };
  let warmSystem = '';
  const warm = new WarmLine({ systemPrompt: () => warmSystem, allowed: () => true, busy: () => busy, binary: async () => binary,
    ...(binaryArgs ? { binaryArgs } : {}), retryMs: 500, log: line => console.log(`[warm] ${line}`) });
  const timedAsk = async (prompt: string, system: string, signal: AbortSignal) => {
    count();
    current.haikuStart = performance.now();
    try { return warm.alive && system === warmSystem ? await warm.ask(prompt, signal) : await oneShot(prompt, system, signal); } finally { current.haikuEnd = performance.now(); }
  };
  const base = {
    store, performers, quiet: () => null, lift: () => {}, now, warm: () => warm.ready, knobs: { warmParallel: true }, ask: timedAsk,
    journal: (entry: ReactionJournalInput) => { current.journal = entry; current.reactedAt = performance.now(); current.resolve(); },
  };
  const hostA = new ReactionHost({ ...base });
  const hostB = new ReactionHost({ ...base, senses });
  // Both arms share one warm haiku with one system prompt (the same text: the senses rule is in it for both, as in the app).
  warmSystem = hostB.systemPrompt;
  if (hostA.systemPrompt !== hostB.systemPrompt) throw new Error('system prompts differ');
  const quiet = async () => {
    busy = false;
    warm.want(0);
    const deadline = Date.now() + 20_000;
    while (!warm.ready && Date.now() < deadline) { await sleep(200); }
    busy = true;
  };
  const run = async (label: 'A' | 'B', scenario: EvalScenario) => {
    const host = label === 'A' ? hostA : hostB;
    let resolve!: () => void;
    current = { sentAt: 0, haikuStart: 0, haikuEnd: 0, reactedAt: 0, journal: null, senses: null, hint: false, settled: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    const id = `ab-${label}-${scenario.id}`;
    let hint = '';
    await runEval({
      label, model: '', repeat: 1, scenarios: [scenario], binary, ...(binaryArgs ? { binaryArgs } : {}),
      prewarmMs: dry ? 100 : 3000, card: { persona: card.persona, mood: card.mood },
      beforeTurn: count,
      prepareTurn: () => {
        current.sentAt = performance.now();
        host.userTurn(id, scenario.turns[0].user);
        if (label === 'B') { router.userTurn(id, scenario.turns[0].user, { merged: host.asking(id) }); hint = router.firstLineHint(id); current.hint = !!hint; }
      },
      hostContext: () => label === 'B' && hint ? hint : null,
      onFirstDelta: () => { host.firstChar(id); if (label === 'B') router.firstChar(id); },
      onTurn: async turn => {
        records.push(turn);
        await Promise.race([current.settled, (async () => { while (!current.haikuEnd) await sleep(50); await sleep(100); })(), sleep(15_000)]);
        if (label === 'B') router.replyDone(id, !turn.error, '');
        const rel = (at: number) => at ? Math.round(at - current.sentAt) : null;
        rows.push({ label, scenario: scenario.id, first: turn.chunks[0]?.[0] ?? null, haikuStartFromSend: rel(current.haikuStart),
          haikuMs: current.haikuStart && current.haikuEnd ? Math.round(current.haikuEnd - current.haikuStart) : null,
          reactedFromSend: rel(current.reactedAt), senses: label === 'B' ? current.senses : null, hint: current.hint });
        const row = rows.at(-1)!;
        console.log(`${label} ${scenario.id} 首字 ${row.first ?? '–'} ms，haiku 起 ${row.haikuStartFromSend ?? '–'} ms，用时 ${row.haikuMs ?? '–'} ms${label === 'B' ? `，感知 ${row.senses ?? '–'}` : ''}${turn.error ? ` 错误：${turn.error}` : ''}`);
        if (turn.error) throw new Error(`turn failed: ${turn.error}`);
      },
    });
    await quiet();
  };
  await mkdir(out, { recursive: true });
  const pairs = Math.max(1, Math.min(MESSAGES.length, Number(option('pairs', '20')) || 20));
  try {
    await quiet();
    for (const [round, scenario] of MESSAGES.slice(0, pairs).entries()) for (const label of round % 2 === 0 ? ['A', 'B'] as const : ['B', 'A'] as const) await run(label, scenario);
  } catch (error) { stopped = error instanceof Error ? error.message : String(error); }
  hostA.dispose(); hostB.dispose(); router.dispose(); warm.dispose();
  const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const of = (label: string, key: keyof Row) => rows.filter(r => r.label === label && typeof r[key] === 'number').map(r => r[key] as number);
  const pairsDone = MESSAGES.slice(0, pairs).map(s => ({ id: s.id, a: rows.find(r => r.scenario === s.id && r.label === 'A')?.first ?? null,
    b: rows.find(r => r.scenario === s.id && r.label === 'B')?.first ?? null, senses: rows.find(r => r.scenario === s.id && r.label === 'B')?.senses ?? null }))
    .filter(p => p.a !== null && p.b !== null) as { id: string; a: number; b: number; senses: string | null }[];
  const diffs = pairsDone.map(p => p.b - p.a);
  const result = {
    dry, requests: used, haikuCalls: store.calls, warm: warm.stats, pairs: pairsDone.length,
    firstA: median(of('A', 'first')), firstB: median(of('B', 'first')), medianPairDiff: median(diffs), slowerPairs: diffs.filter(d => d > 0).length,
    haikuMsA: median(of('A', 'haikuMs')), haikuMsB: median(of('B', 'haikuMs')), reactedA: median(of('A', 'reactedFromSend')), reactedB: median(of('B', 'reactedFromSend')),
    stopped, pairsDone, rows,
  };
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.medianPairDiff > 150 ? 'B 变慢（逐对中位慢 150 ms 以上）：默认关' : 'B 没有慢过 150 ms：可以默认开';
  await writeFile(path.join(out, 'sense-router-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, rows: undefined, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
