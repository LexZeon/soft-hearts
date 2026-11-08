// First-character A/B for I-047 陪看要及时 (docs/claude/2026-11-07-watch-timely.md):
//   A = today's path: no heard block on her turn, the reaction judge as before.
//   B = I-047 on: her turn carries the watch block (synthetic 90-second transcript, ~600 characters, and a synthetic summary) and the
//       judgment call carries the last three exchanges.
// Synthetic text only: no private data. Same card (Gene), the same single-turn messages, interleaved, who goes first swapped every pair.
// Every turn runs in the runner's own temp data folder. Hard cap on real requests; any failed Opus turn stops the run. Run it through the
// heavy gate:
//   node scripts/dev/heavy.mjs --label watch-timely-ab -- node node_modules/tsx/dist/cli.mjs scripts/lib/watch-timely-ab.ts --pairs 10 --out <dir> [--dry]
// --arm timeline (I-048 step 2): A = the I-047 block (300 characters of heard words and one summary), B = the rendered watch timeline
// (heard, seen, summary in time order, within its character budget). Both arms run the same sense-router path; only the block differs.
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
import { WATCH_TIMELY_KNOBS, recentExchanges, timelineBlock, watchBlock } from '../../shared/watch-timely';
import { WatchTimeline } from '../../shared/behaviors/watch-timeline/timeline';
import { WATCH_TIMELINE_KNOBS } from '../../shared/behaviors/watch-timeline/knobs';
import { deriveDispositions } from '../../shared/behaviors/reactions/dispositions';
import { FakeReactionJudge } from '../../shared/behaviors/reactions/fake';
import type { ReactionPerformer } from '../../shared/behaviors/reactions/interface';

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const dry = process.argv.includes('--dry');
const out = path.resolve(option('out', '.local/watch-timely-ab'));
const cap = Math.max(1, Math.min(90, Number(option('cap', '84')) || 84));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

const MESSAGES: EvalScenario[] = [
  { id: 'then', title: '接着聊·后来', turns: [{ user: '那他后来呢' }] },
  { id: 'why-cry', title: '接着聊·为什么', turns: [{ user: '他为什么要哭啊' }] },
  { id: 'funny', title: '感想·好笑', turns: [{ user: '哈哈这段好好笑' }] },
  { id: 'suspect', title: '感想·可疑', turns: [{ user: '我觉得那个孩子有点可疑' }] },
  { id: 'next', title: '接着聊·后面', turns: [{ user: '后面呢，他打开了吗' }] },
  { id: 'who', title: '接着聊·是谁', turns: [{ user: '写这句话的是谁来着' }] },
  { id: 'sad', title: '感想·难过', turns: [{ user: '这里有点难过' }] },
  { id: 'guess', title: '猜测·结局', turns: [{ user: '你猜他最后会原谅吗' }] },
  { id: 'line', title: '台词·刚才', turns: [{ user: '刚才那句话什么意思' }] },
  { id: 'rain', title: '感想·雨', turns: [{ user: '这个下雨的镜头好有感觉' }] },
];
const HEARD = '合成台词：很久以前这座城里住着一位修钟表的老人，他每天清晨都会擦一遍橱窗。后来来了一个迷路的孩子，把一只坏掉的怀表放在柜台上就跑开了。老人没有追，只是把怀表放在灯下，慢慢拧开了后盖。里面没有齿轮，只有一张折得很小的纸，上面写着：谢谢你，在我最冷的那个冬天，替我留了一盏灯。老人愣了很久，窗外的雨一直没有停。他想起年轻时写给远方朋友的那封信，信里也有这样一句话。孩子在街角回头看了一眼，又跑进了雨里。';
const SUMMARY = '一个修钟表的老人收到迷路孩子留下的坏怀表，打开后发现里面有一张写着感谢的纸条，让他想起年轻时写给远方朋友的信。';
// --heard-chars N: the size of the carried transcript (default: the shipped knob); the block is cut exactly as the app cuts it.
const HEARD_CHARS = Math.max(1, Number(option('heard-chars', String(WATCH_TIMELY_KNOBS.heardChars))) || WATCH_TIMELY_KNOBS.heardChars);
const WATCH_TURN_BLOCK = watchBlock({ heard: HEARD, summary: SUMMARY }, { heardChars: HEARD_CHARS });
const ARM = option('arm', 'timely') === 'timeline' ? 'timeline' : 'timely';
// A synthetic timeline as the app would have it a few minutes into a show: an older stretch already a summary, then 90 seconds of
// heard lines with three frame descriptions between them (all made up). --block-chars N: the timeline's character budget.
const BLOCK_CHARS = Math.max(100, Number(option('block-chars', String(WATCH_TIMELINE_KNOBS.timeline.blockChars))) || WATCH_TIMELINE_KNOBS.timeline.blockChars);
function syntheticTimelineBlock(): string {
  const t = new WatchTimeline({ ...WATCH_TIMELINE_KNOBS.timeline, blockChars: BLOCK_CHARS });
  const now = 10_000_000;
  for (let i = 0; i < 7; i++) t.addHeard(`合成的早先台词 ${i}：老人在橱窗前擦玻璃，街上有人经过`, now - 400_000 + i * 5_000);
  const plan = t.compactPlan(now);
  if (plan) t.applySummary(plan, SUMMARY, now);
  const sentences = HEARD.split('。').filter(Boolean).map(line => line + '。');
  const heard = [now - 85_000, now - 70_000, now - 55_000, now - 40_000, now - 25_000, now - 10_000];
  heard.forEach((at, index) => t.addHeard(sentences[index % sentences.length], at));
  const seen: [number, string][] = [[now - 78_000, '昏暗的钟表店内，一位白发老人站在柜台后，柜台上放着一只旧怀表'], [now - 47_000, '特写：怀表后盖被拧开，里面露出一张折得很小的纸'],
    [now - 20_000, '窗外下着雨，一个小孩的背影跑进雨里，街灯亮着']];
  for (const [at, text] of seen) t.fillSeen(t.reserveSeen(at), text, now);
  return timelineBlock(t.render(now).text);
}
const TIMELINE_TURN_BLOCK = syntheticTimelineBlock();
const EXCHANGES = recentExchanges([
  { role: 'user', content: '这个视频讲了什么' }, { role: 'assistant', content: '一个修钟表的老人，好像有人给他送了块怀表。' },
  { role: 'user', content: '他是不是认识那个孩子' }, { role: 'assistant', content: '看起来不认识，但他好像想起了什么。' },
  { role: 'user', content: '嗯，我也觉得' }, { role: 'assistant', content: '我也在等后面怎么说。' },
  { role: 'user', content: 'x' },
]);

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
    archive: async () => {}, log: () => {}, knobs: { firstLineHint: false },
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
    const routed = label === 'B' || ARM === 'timeline';
    const host = routed ? hostB : hostA;
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
        if (routed) { router.userTurn(id, scenario.turns[0].user, { merged: host.asking(id), context: EXCHANGES }); }
        if (ARM === 'timeline') { hint = label === 'B' ? TIMELINE_TURN_BLOCK : WATCH_TURN_BLOCK; current.hint = true; }
        else if (label === 'B') { hint = WATCH_TURN_BLOCK; current.hint = true; }
      },
      hostContext: () => hint ? hint : null,
      onFirstDelta: () => { host.firstChar(id); if (routed) router.firstChar(id); },
      onTurn: async turn => {
        records.push(turn);
        await Promise.race([current.settled, (async () => { while (!current.haikuEnd) await sleep(50); await sleep(100); })(), sleep(15_000)]);
        if (routed) router.replyDone(id, !turn.error, '');
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
    dry, arm: ARM, blockChars: ARM === 'timeline' ? BLOCK_CHARS : null, aChars: WATCH_TURN_BLOCK.length, bChars: ARM === 'timeline' ? TIMELINE_TURN_BLOCK.length : null, requests: used, haikuCalls: store.calls, warm: warm.stats, pairs: pairsDone.length,
    firstA: median(of('A', 'first')), firstB: median(of('B', 'first')), medianPairDiff: median(diffs), slowerPairs: diffs.filter(d => d > 0).length,
    haikuMsA: median(of('A', 'haikuMs')), haikuMsB: median(of('B', 'haikuMs')), reactedA: median(of('A', 'reactedFromSend')), reactedB: median(of('B', 'reactedFromSend')),
    stopped, pairsDone, rows,
  };
  const verdict = result.medianPairDiff === null ? '没有完成的配对'
    : result.medianPairDiff > 150 ? 'B 变慢（逐对中位慢 150 ms 以上）：默认关' : 'B 没有慢过 150 ms：可以默认开';
  await writeFile(path.join(out, 'watch-timely-ab.json'), JSON.stringify({ ...result, verdict }, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, rows: undefined, verdict }, null, 2));
}
main().catch(error => { console.error(error); process.exit(1); });
