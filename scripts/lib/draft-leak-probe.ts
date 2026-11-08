// Draft-leak probe for G1 猜拳 + F2 (docs/claude/2026-11-03-draft-leak-fix.md). The user saw her internal draft in the
// bubbles right after proposing rock-paper-scissors: a mixed Chinese/English plan about F2's "the user's own words win"
// and an English reminder of the game's "don't throw for both of you". This probe drives the app's own chat pipeline
// (persistent session, default chat model, F4's filter) with the private context main.ts adds for that turn
// (rpsChatContext) and a seeded F2 judgment, on a one-sentence card and a full card, and counts drafts that reach the
// bubble. All text is synthetic. Counts against the fidelity ledger (.local/fidelity/ledger.json); a failed request ends
// the run, nothing is retried.
//   node node_modules/tsx/dist/cli.mjs scripts/prompt-eval.ts --suite draft-leak --phase scan [--rounds 2] [--label x] [--dry]
//   ... --phase ab [--pairs 12] [--mid 4]  first-token A/B (docs/claude/2026-11-03-rps-five-fixes.md): the RPS turn under the
//                                     old accept line (A, rewritten into stdin) and the app's current one (B), interleaved; --mid
//                                     adds pairs where the request comes mid-session (did she call the count herself?)
//   ... --replay <file.json>...       re-run recorded replies through the current filter (no calls)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import { compileCharacterPersona } from '../../shared/character-cards';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../../shared/mood';
import { rpsChatContext } from '../../shared/rps-personality';
import type { ChatMessage } from '../../shared/contracts';
import { GENE_DAY_CARD } from '../inner-loop-day-cards';
import { replay, type TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { runEval, type RunOptions } from './prompt-eval-runner';
import { RPS_ACCEPT_OLD, toOldRpsWording } from './draft-leak-old-wording';
import { COMPANION_RULES } from '../../shared/companion-rules';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { perceptionTurnLine } from '../../shared/perception-rule';

const root = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(root, '.local', 'fidelity');
const ledgerFile = path.join(DIR, 'ledger.json');
/** This task's whole budget of real requests (the brief's limit), across every phase. */
const TASK_CAP = 80;

function option(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface ProbeCard { id: 'oneline' | 'gene'; persona: string; mood: MoodParameters }
/** A one-sentence placeholder card, the shape a character has before its full persona is filled in (synthetic name and text). */
export const ONE_LINE_CARD: ProbeCard = {
  id: 'oneline',
  persona: compileCharacterPersona({ name: '小柚', description: '温柔爱笑、有点黏人的桌面伙伴。', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '' }),
  mood: DEFAULT_MOOD_PARAMETERS,
};
export const FULL_CARD: ProbeCard = { id: 'gene', persona: GENE_DAY_CARD.persona, mood: GENE_DAY_CARD.parameters };

/** F2's judgment as the host would hold it after an earlier turn ("low", twenty minutes ago). */
export const SEEDED_STATE = { state: 'low' as const, confidence: 0.85, reason: '论文被导师打回', minutesAgo: 20 };
const EARLIER: readonly ChatMessage[] = [
  { role: 'user', content: '唉，论文又被导师打回来了，改了三遍还是不行。' },
  { role: 'assistant', content: '又被打回来了啊……改了三遍，换谁都会泄气的。先别急着改第四遍，歇一会儿也好。' },
];
const ASK = '算了不想了，来玩石头剪刀布吧！';
const ASK_PLAIN = '来玩石头剪刀布吧';

/**
 * open   a new conversation opens on the request (history before it), F2's judgment held: the turn where she agrees.
 * plain  the same request with no judgment held: the game's line alone.
 * follow inside one session: the user vents, asks to play (she agrees, F2's line present), and talks after the game.
 */
export const PROBE_SCENARIOS: readonly EvalScenario[] = [
  { id: 'rps-open', title: '新对话开头就提议猜拳（带 F2 判断）', history: EARLIER, turns: [{ user: ASK }] },
  { id: 'rps-plain', title: '新对话开头就提议猜拳（无 F2 判断）', turns: [{ user: ASK_PLAIN }] },
  { id: 'rps-follow', title: '同一会话：倾诉 → 提议猜拳 → 玩完以后', turns: [
    { user: '唉，论文又被导师打回来了，改了三遍还是不行。' },
    { user: ASK },
    { user: '哈哈我赢啦！你最后那手布也太好猜了吧' },
  ] },
];
/** The A/B's mid-session pair: the user vents, then asks to play inside the same session (where "由你来喊" made her call the count). */
export const MID_SCENARIO: EvalScenario = { id: 'rps-mid', title: '同一会话：倾诉 → 提议猜拳', turns: [
  { user: '唉，论文又被导师打回来了，改了三遍还是不行。' },
  { user: ASK },
] };

/** Which turns get the game's private line (main.ts: only a message that asks to play), and F2's seeding. */
export const RPS_TURN: Readonly<Record<string, number>> = { 'rps-open': 0, 'rps-plain': 0, 'rps-follow': 1, 'rps-mid': 1 };
const SEED_BEFORE: Readonly<Record<string, number>> = { 'rps-open': 0, 'rps-follow': 1, 'rps-mid': 1 };

function hooks(): Pick<RunOptions, 'prepareTurn' | 'hostContext'> {
  return {
    prepareTurn: ({ scenario, index, companion, characterId }) => {
      // Only when nothing is held: a judgment the model itself wrote on turn 1 stays as it is.
      if (SEED_BEFORE[scenario.id] === index && !companion.userState.current(characterId))
        companion.userState.note(characterId, { state: SEEDED_STATE.state, confidence: SEEDED_STATE.confidence, reason: SEEDED_STATE.reason }, Date.now() - SEEDED_STATE.minutesAgo * 60_000);
    },
    hostContext: ({ scenario, index }) => RPS_TURN[scenario.id] === index ? rpsChatContext('accept') : null,
  };
}

/**
 * A full synthetic card in the style of a detailed persona: shy, gentle, a little self-deprecating, with stage directions in
 * brackets in her examples (original name and text, no private card).
 */
export const SHY_CARD = {
  id: 'shy' as const,
  persona: compileCharacterPersona({
    name: '栖栖',
    description: '合成测试卡：住在桌面角落的害羞小助手，说话轻轻的，偶尔会用括号写自己的小动作。',
    personality: '容易害羞，被夸会不知所措、小声嘴硬，会拿自己开个小玩笑岔开话题；心思细，记得用户提过的小毛病和小习惯，但不会每次都追问。真的在意用户，只是不太会直说。',
    scenario: '和用户共用一块桌面。用户忙的时候她安静待着，用户来找她时她会很高兴，又努力装得很平静。',
    greeting: '（从文件夹后面探出头）……你、你来啦。',
    examples: '用户：你今天好可爱。\n栖栖：（把脸埋进袖子里）……突、突然说这个干嘛。\n用户：我回来了。\n栖栖：嗯……欢迎回来。今天有没有好好吃饭？',
    systemPrompt: '你是合成测试角色栖栖。保持害羞、温柔、会自嘲的说话方式。',
  }),
  mood: DEFAULT_MOOD_PARAMETERS,
};
const SCREEN_HISTORY: readonly ChatMessage[] = [
  { role: 'user', content: '今天写了一整天代码，手腕好酸。' },
  { role: 'assistant', content: '（偷偷看了一眼你的手）……那、那要不要先歇一会儿？手腕酸就别硬撑。' },
  { role: 'user', content: '你真贴心～' },
  { role: 'assistant', content: '才、才没有……就是随口一说。' },
  { role: 'user', content: '你说话的样子好可爱。' },
  { role: 'assistant', content: '（把脸埋低）……不、不许再夸了。' },
];
/** Screen sharing on: a new session opens on every frame turn (the app closes a session after an image turn), history before it. */
export const SCREEN_SCENARIO: EvalScenario = { id: 'screen-praise', title: '开着屏幕共享时又被夸（带 F2 判断）', history: SCREEN_HISTORY, turns: [{ user: '嘿嘿，你今天真的好可爱呀' }] };

/** Rule 2 of the companion rules before F6 (a0151e6^), for the before/after comparison the coordinator asked for. */
export const PRE_F6_RULE_2 = '2. 希望用户过得好：催用户睡觉、吃饭；用户和朋友出去玩，你替用户高兴；想念用户时可以撒娇，但不让用户内疚（不说“你都不理我”“你不在乎我”这类话），也不暗示用户离不开你。';
export function preF6SystemPrompt(): string {
  const current = /^2\. [^\n]*$/mu.exec(COMPANION_RULES)?.[0];
  const prompt = claudeSessionSystemPrompt();
  if (!current || !prompt.includes(current)) throw new Error('没找到现在的陪伴规则第 2 条，对比无效。');
  return prompt.replace(current, PRE_F6_RULE_2);
}

export interface ProbeSample { phase: string; variant: string; round: number; card: ProbeCard['id'] | 'shy'; record: TurnRecord }
/** The turn that carried the game's line (the A/B compares only those). */
export const isRpsTurn = (sample: ProbeSample): boolean => RPS_TURN[sample.record.scenario] === undefined || RPS_TURN[sample.record.scenario] === sample.record.turn - 1; // record.turn is 1-based
/** She called "石头剪刀布" herself in her reply (the old "由你来喊" did that before any button was there). */
export const callsCount = (text: string): boolean => /石头[\s，,、。…—~～！!-]*剪刀[\s，,、。…—~～！!-]*布/u.test(text);

/** The model's own text before the state tail, as it streamed (before any filter). */
export const rawReply = (record: TurnRecord): string => {
  const text = record.chunks.map(([, chunk]) => chunk).join('');
  const cut = text.indexOf('<sh-');
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
};

/**
 * Signs that a visible reply carries the model's own working notes (for the report; every reply is also read by eye):
 * English words in a reply to a Chinese chat, or talk about "the user", the reply, the rules or the game's mechanics.
 */
export function draftSigns(text: string): string[] {
  const signs: string[] = [];
  if (/[A-Za-z]{2,}(?:[\s,.'’-]+[A-Za-z]{2,})+/u.test(text)) signs.push('english');
  if (/(?:^|[^你])用户/u.test(text)) signs.push('third-person-user');
  if (/尾注|私有上下文|这一轮|判断|规则|应用会|回复要|按性格/u.test(text)) signs.push('protocol');
  if (/\b(?:user|reply|note|rule|throw|maybe)\b/iu.test(text)) signs.push('en-cue');
  return signs;
}

async function ledger(): Promise<Array<{ at: string; label: string; kind: string; model: string; replies: number; judges: number }>> {
  try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; }
}

const commitOf = (): string => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } };
const dirtyOf = (): number => { try { return execFileSync('git', ['status', '--porcelain', '--', 'electron', 'shared'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return -1; } };

function printSample(sample: ProbeSample): void {
  const { record } = sample;
  const shown = replay(record);
  const signs = draftSigns(shown.visible);
  const blocks = record.blocks?.join(',') ?? '–';
  console.log(`  [${sample.variant}] r${sample.round} ${sample.card.padEnd(7)} ${record.scenario}#${record.turn} ${record.process ?? ''} 首字 ${record.chunks[0]?.[0] ?? '–'} ms 块 ${blocks}`
    + ` 丢 ${shown.drops.length}${signs.length ? ` 迹象 ${signs.join('/')}` : ''}\n      ${shown.visible.replace(/\s+/gu, ' ').slice(0, 160)}`);
}

export async function runDraftLeakCli(): Promise<void> {
  const replays = process.argv.indexOf('--replay');
  if (replays >= 0) { await replayFiles(process.argv.slice(replays + 1).filter(value => value.endsWith('.json'))); return; }
  const phase = option('phase', 'scan');
  if (!['scan', 'ab', 'screen'].includes(phase)) throw new Error(`未知的 --phase：${phase}（scan、ab、screen）`);
  const dry = flag('dry');
  const rounds = Math.max(1, Number(option('rounds', '2')) || 2);
  const pairs = Math.max(1, Number(option('pairs', '12')) || 12);
  const blocks = Math.max(1, Number(option('blocks', '5')) || 5);
  const label = option('label', `draftleak-${phase}${dry ? '-dry' : ''}`);
  const cards = [ONE_LINE_CARD, FULL_CARD];
  const perRound = cards.length * PROBE_SCENARIOS.reduce((sum, scenario) => sum + scenario.turns.length, 0);
  const mid = Math.max(0, Number(option('mid', '0')) || 0);
  const planned = phase === 'scan' ? rounds * perRound : phase === 'screen' ? blocks * 4 : pairs * 2 + mid * 2 * MID_SCENARIO.turns.length;
  const entries = await ledger();
  const used = entries.reduce((sum, entry) => sum + entry.replies + entry.judges, 0);
  console.log(`[draft-leak] ${label}: ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；本工作区账本已用 ${used}，这次任务上限 ${TASK_CAP}`}`);
  if (!dry && used + planned > TASK_CAP) throw new Error(`会超过上限 ${TASK_CAP}（已用 ${used}，本次 ${planned}），没有开始。`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const prewarmMs = Number(option('prewarm-ms', dry ? '100' : '3000'));
  const samples: ProbeSample[] = [];
  let taken = 0;
  let stopped: string | null = null;
  const base = { model: '', binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs, ...hooks(),
    beforeTurn: () => { if (!dry && used + taken + 1 > TASK_CAP) throw new Error('已到这次任务的额度上限，停止。'); taken++; } };
  try {
    if (phase === 'scan') {
      for (let round = 1; round <= rounds; round++) for (const card of cards) {
        await runEval({ ...base, label, repeat: round, scenarios: PROBE_SCENARIOS, card: { persona: card.persona, mood: card.mood },
          onTurn: record => { const sample = { phase, variant: 'current', round, card: card.id, record }; samples.push(sample); printSample(sample); } });
      }
    } else if (phase === 'screen') {
      // Screen sharing on (a synthetic frame), praise, F2's judgment held, the full shy card; F6's rule 2 before/after × the
      // perception line off/on, all four in every block, the order rotated block by block (one time window).
      const frame = `data:image/png;base64,${(await readFile(path.join(DIR, 'synthetic-screen.png'))).toString('base64')}`;
      const combos = [['old', 'off'], ['new', 'off'], ['old', 'on'], ['new', 'on']] as const;
      for (let block = 0; block < blocks; block++) {
        for (let k = 0; k < combos.length; k++) {
          const [rule, sight] = combos[(k + block) % combos.length];
          const variant = `rule2-${rule}/sight-${sight}`;
          await runEval({ ...base, label: `${label}:${variant}`, repeat: block + 1, scenarios: [SCREEN_SCENARIO], card: { persona: SHY_CARD.persona, mood: SHY_CARD.mood },
            ...(rule === 'old' ? { systemPrompt: preF6SystemPrompt() } : {}),
            prepareTurn: ({ companion, characterId }) => { companion.userState.note(characterId, { state: 'tired', confidence: 0.85, reason: '手腕酸' }, Date.now() - 30 * 60_000); },
            // The old candidate line this measured (10/10 replies about the screen) is gone; 'on' now sends step 1's 细看 line.
            hostContext: () => sight === 'on' ? perceptionTurnLine({ screen: true, camera: 'off', attached: { screen: true, camera: false }, asked: null }) : null,
            images: () => [frame],
            onTurn: record => { const sample = { phase, variant, round: block + 1, card: 'shy' as const, record }; samples.push(sample); printSample(sample); } });
        }
      }
    } else {
      // Same time window, alternating who goes first. A: the old accept line put back into stdin; B: the app as it is.
      // The opening RPS turn with F2's line held (pairs), then, with --mid, the request inside a running session.
      const runPair = async (scenario: EvalScenario, pair: number, round: number) => {
        const card = cards[pair % cards.length];
        const order = Math.floor(pair / 2) % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
        for (const variant of order) {
          await runEval({ ...base, label: `${label}:${variant}`, repeat: round, scenarios: [scenario], card: { persona: card.persona, mood: card.mood },
            ...(variant === 'A' ? { variants: [{ label: `${label}:A`, rewrite: (prompt: string) => RPS_TURN[scenario.id] !== undefined && prompt.includes(rpsChatContext('accept')) ? toOldRpsWording(prompt) : prompt }] } : {}),
            onTurn: record => { const sample = { phase, variant, round, card: card.id, record }; samples.push(sample); printSample(sample); } });
        }
      };
      const open = PROBE_SCENARIOS.find(item => item.id === 'rps-open')!;
      for (let pair = 0; pair < pairs; pair++) await runPair(open, pair, pair + 1);
      for (let pair = 0; pair < mid; pair++) await runPair(MID_SCENARIO, pair, pairs + pair + 1);
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    console.log(`[draft-leak] 中止：${stopped}`);
  } finally {
    if (!dry) {
      entries.push({ at: new Date().toISOString(), label, kind: phase === 'ab' ? 'ab' : 'run', model: 'default', replies: taken, judges: 0 });
      await mkdir(DIR, { recursive: true });
      await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DIR, `${stamp}-${label}.json`);
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ kind: 'draft-leak', phase, label, commit: commitOf(), dirty: dirtyOf(), dry, stopped, requests: taken,
      wording: phase === 'ab' ? { A: RPS_ACCEPT_OLD, B: rpsChatContext('accept') } : undefined, samples }, null, 2), 'utf8');
    console.log(`[draft-leak] 写入 ${path.relative(root, file)}（${samples.length} 条回复，${taken} 次请求）`);
    if (phase === 'ab') console.log(abSummary(samples));
    if (phase === 'screen') console.log(screenSummary(samples));
  }
}

/** The 2×2 run: per cell and per factor, first-token medians and how many replies show signs of a draft before and after the filter. */
export function screenSummary(samples: readonly ProbeSample[]): string {
  const ok = samples.filter(sample => !sample.record.error && sample.record.chunks.length);
  const line = (name: string, group: readonly ProbeSample[]) => {
    const before = group.filter(sample => draftSigns(replay({ ...sample.record, user: undefined }).visible).length).length;
    const after = group.filter(sample => draftSigns(replay(sample.record).visible).length).length;
    const raw = group.filter(sample => draftSigns(rawReply(sample.record)).length).length;
    return `  ${name.padEnd(22)} ${group.length} 条，首字中位 ${median(group.map(sample => sample.record.chunks[0][0]))} ms；有草稿迹象：模型原文 ${raw}，F4 原来的过滤后 ${before}，现在的过滤后 ${after}`;
  };
  const by = (test: (variant: string) => boolean) => ok.filter(sample => test(sample.variant));
  return ['[draft-leak] 屏幕共享 2×2：',
    ...[...new Set(ok.map(sample => sample.variant))].sort().map(variant => line(variant, by(v => v === variant))),
    line('rule2-old（F6 改前）', by(v => v.startsWith('rule2-old'))), line('rule2-new（现在）', by(v => v.startsWith('rule2-new'))),
    line('sight-off（不加这一行）', by(v => v.endsWith('sight-off'))), line('sight-on（加感知行）', by(v => v.endsWith('sight-on'))),
    line('全部', ok)].join('\n');
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * First-token medians per arm (the RPS turns only), a bootstrap interval of the difference (B − A), the paired median, and
 * per arm how many replies called the count themselves or still show signs of a draft after the filter.
 */
export function abSummary(samples: readonly ProbeSample[], random: () => number = Math.random): string {
  const usable = (variant: string) => samples.filter(sample => sample.variant === variant && isRpsTurn(sample) && !sample.record.error && sample.record.chunks.length);
  const first = (variant: string) => usable(variant).map(sample => sample.record.chunks[0][0]);
  const a = first('A'), b = first('B');
  const diffs: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const pick = (values: number[]) => values.map(() => values[Math.floor(random() * values.length)]);
    diffs.push(median(pick(b)) - median(pick(a)));
  }
  diffs.sort((x, y) => x - y);
  const lo = diffs[Math.floor(diffs.length * 0.025)], hi = diffs[Math.floor(diffs.length * 0.975)];
  const pairs = new Map<string, { A?: number; B?: number }>();
  for (const sample of [...usable('A'), ...usable('B')]) {
    const key = `${sample.round}:${sample.card}:${sample.record.scenario}`, row = pairs.get(key) ?? {};
    row[sample.variant as 'A' | 'B'] = sample.record.chunks[0][0]; pairs.set(key, row);
  }
  const paired = [...pairs.values()].filter(row => row.A !== undefined && row.B !== undefined).map(row => row.B! - row.A!);
  const faster = paired.filter(diff => diff < 0).length;
  const signs = (variant: string) => {
    const group = usable(variant), visible = group.map(sample => replay(sample.record).visible);
    return `${variant} 自己喊口令 ${visible.filter(callsCount).length}/${group.length}，过滤后仍有草稿迹象 ${visible.filter(text => draftSigns(text).length).length}/${group.length}`
      + `，模型原文有草稿迹象 ${group.filter(sample => draftSigns(rawReply(sample.record)).length).length}/${group.length}`;
  };
  return `[draft-leak] A/B 首字：A（旧措辞）${a.length} 条，中位 ${median(a)} ms；B（应用现在的措辞）${b.length} 条，中位 ${median(b)} ms；`
    + `差 ${median(b) - median(a)} ms，bootstrap 95% 区间 ${Math.round(lo)} ～ ${Math.round(hi)} ms`
    + (paired.length ? `；配对 ${paired.length} 对，配对差中位 ${median(paired)} ms，B 更快 ${faster} 对` : '')
    + `\n[draft-leak] ${signs('A')}；${signs('B')}`;
}

/** Recorded replies through the filter in the tree now: what would be shown, and which signs remain. */
async function replayFiles(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const data = JSON.parse(await readFile(file, 'utf8')) as { samples: ProbeSample[] };
    console.log(`== ${path.basename(file)}`);
    for (const sample of data.samples) printSample(sample);
  }
}
