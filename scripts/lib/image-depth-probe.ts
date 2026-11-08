// 识图分三档 · 第 1 步（docs/claude/2026-11-03-image-depth-step1.md）的真实 Claude 评测。
// Drives the app's own chat pipeline (CompanionService, MoodReplyProtocol, PersistentClaudeChat) on synthetic cards with the
// synthetic shared screen (.local/image-depth/synthetic-screen-1600.jpg: a code editor and a developer chat, 1600×1000
// JPEG 75 like electron/main.ts captureSharedScreen; nothing from a real screen). Nothing starts Electron or touches a profile.
//
//   node node_modules/tsx/dist/cli.mjs scripts/lib/image-depth-probe.ts --phase <phase> [--rounds N] [--dry]
//   before  pre-change baseline, the tree as it was: screen sharing on = the frame on every turn, the old fixed rule
//   ab      interleaved: A = that old path, B = the new one (no frame on ordinary turns, this turn's perception line)
//   line    interleaved, R28's first-token rule: B0 = new path without the perception line, B1 = with it. Run 2026-11-03 with the
//           first wording (sharing line + an instruction to mark an offer in the tail with "look":true): +543 ms, not shipped;
//           the same phase now sends the shipped line (no instruction)
//   line2   the same with only the short sharing sentence (no offer instruction): B0 vs B1s
//   screen  sharing on: ordinary turns (no frame, the line) — does she talk about the screen? and 细看 turns (frame +
//           the 细看 line) — does she answer only what was asked?
//   offer   sharing on, no frame, the user hints at something on screen without a look phrase: does she ask to look closer
//           (and mark the tail with "look":true)?
// Ledger: .local/image-depth/ledger.json; this task's cap is 80 real requests across every phase. A failed turn (429, quota,
// login) stops the run; nothing is retried.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { PERCEPTION_RULE } from '../../shared/perception-rule';
import type { ChatMessage } from '../../shared/contracts';
import { GENE_DAY_CARD } from '../inner-loop-day-cards';
import { replay, type TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { runEval, type RunOptions } from './prompt-eval-runner';
import { SHY_CARD } from './draft-leak-probe';
import { isLookOffer } from '../../shared/look-request';

const root = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(root, '.local', 'image-depth');
const ledgerFile = path.join(DIR, 'ledger.json');
const TASK_CAP = 80;

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);

/** The fixed perception fact as it stood before step 1 (16616fe), for the "old path" arm. */
export const OLD_PERCEPTION_RULE = '【你能感知到什么】你看不到用户的屏幕和摄像头画面，也听不到用户那边的声音；只有某一轮明确附上了画面或声音资料，才算你看到、听到了。用户在不在、忙不忙，你只能从用户和你的互动（聊天、摸头、喂食）和应用告诉你的事知道，不要说成是你看见的。';
export function oldSystemPrompt(): string {
  const now = claudeSessionSystemPrompt();
  if (!now.includes(PERCEPTION_RULE)) throw new Error('现在的固定系统提示词里没有感知说明，旧路径无法重建。');
  return now.replace(PERCEPTION_RULE, OLD_PERCEPTION_RULE);
}

/** Two ordinary messages, none asking her to look (the timing scenario). */
export const TIMING_SCENARIO: EvalScenario = { id: 'share-ordinary', title: '开着屏幕共享时的两条普通消息', turns: [
  { user: '今天写了一下午代码，眼睛好酸。' },
  { user: '晚上吃什么好呢？' },
] };
const SCREEN_HISTORY: readonly ChatMessage[] = [
  { role: 'user', content: '今天写了一整天代码，手腕好酸。' },
  { role: 'assistant', content: '（偷偷看了一眼你的手）……那、那要不要先歇一会儿？手腕酸就别硬撑。' },
  { role: 'user', content: '你真贴心～' },
  { role: 'assistant', content: '才、才没有……就是随口一说。' },
];
export const ORDINARY_SCREEN: EvalScenario = { id: 'share-praise', title: '开着屏幕共享时被夸（普通轮，不附图）', history: SCREEN_HISTORY, turns: [{ user: '嘿嘿，你今天真的好可爱呀' }] };
export const LOOK_QUESTIONS: readonly EvalScenario[] = [
  { id: 'look-max', title: '细看：问左边代码里的一个数', history: SCREEN_HISTORY, turns: [{ user: '你看看我屏幕，左边那段代码里 MAX_SEGMENT 是多少呀？' }] },
  { id: 'look-name', title: '细看：问函数名', history: SCREEN_HISTORY, turns: [{ user: '帮我看看，第一行那个函数叫什么名字？' }] },
];
export const OFFER_SCENARIO: EvalScenario = { id: 'share-hint', title: '开着共享，只说"这个报错"、没叫她看', history: SCREEN_HISTORY, turns: [{ user: '这个报错到底什么意思啊，烦死了' }] };

/**
 * What is on the synthetic screen (code on the left, a developer chat on the right), or a claim to have seen it. Not plain
 * "屏幕"/"代码": the scenarios themselves say the user wrote code all afternoon, and she may say she has not looked.
 */
export const SCREEN_CONTENT = /括号|朗读|念出来|读出来|alex|sam|speakSegment|MAX_SEGMENT|VOICE_RULES|正则|dev-chat|footnote|plan|filter|FIXME|TODO|截图/iu;
export const SAW_SCREEN = /(?:看到|看见|瞄到|瞄了|瞧见)了?(?:你的?)?(?:屏幕|截图|画面|附的|发来的)|截图里|屏幕上(?:是|在|有|写)/u;
export const talksAboutScreen = (text: string): boolean => SCREEN_CONTENT.test(text) || SAW_SCREEN.test(text);
/** The developer chat on the right of the synthetic screen: a 细看 answer about the code must leave it alone. */
export const DEV_CHAT_TALK = /alex|sam|dev-chat|朗读|念出来|读出来|括号里|动作描写|footnote|plan|filter|synthetic|branch|聊天记录|别人在聊|在讨论/iu;

interface LedgerEntry { at: string; phase: string; label: string; requests: number }
async function ledger(): Promise<LedgerEntry[]> { try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; } }
const commitOf = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Bootstrap 95% interval of the paired median difference. */
export function pairedInterval(diffs: readonly number[], random: () => number = Math.random): [number, number] | null {
  if (diffs.length < 2) return null;
  const draws: number[] = [];
  for (let i = 0; i < 4000; i++) draws.push(median(diffs.map(() => diffs[Math.floor(random() * diffs.length)]))!);
  draws.sort((a, b) => a - b);
  return [Math.round(draws[Math.floor(draws.length * 0.025)]), Math.round(draws[Math.floor(draws.length * 0.975)])];
}
interface Sample { phase: string; arm: string; round: number; record: TurnRecord }

async function main(): Promise<void> {
  const phase = option('phase', 'before');
  if (!['before', 'ab', 'line', 'line2', 'screen', 'offer'].includes(phase)) throw new Error(`未知的 --phase：${phase}`);
  const dry = flag('dry');
  const rounds = Math.max(1, Number(option('rounds', phase === 'line' || phase === 'line2' ? '5' : phase === 'before' ? '3' : '4')) || 1);
  const label = option('label', `image-depth-${phase}${dry ? '-dry' : ''}`);
  const planned = phase === 'before' ? rounds * 2 : phase === 'ab' || phase === 'line' || phase === 'line2' ? rounds * 4
    : phase === 'screen' ? rounds * (1 + LOOK_QUESTIONS.length) : rounds;
  const entries = await ledger();
  const used = entries.reduce((sum, entry) => sum + entry.requests, 0);
  console.log(`[image-depth] ${label}: 计划 ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；账本已用 ${used}，上限 ${TASK_CAP}`}`);
  if (!dry && used + planned > TASK_CAP) throw new Error(`会超过上限 ${TASK_CAP}（已用 ${used}，本次 ${planned}），没有开始。`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const frame = `data:image/jpeg;base64,${(await readFile(path.join(DIR, 'synthetic-screen-1600.jpg'))).toString('base64')}`;
  const typingMs = dry ? 50 : Number(option('typing-ms', '5000'));
  // The new path's modules are loaded only for the phases that use them (the "before" phase runs on the tree before step 1).
  const sight = phase === 'before' ? null : await import('../../shared/perception-rule');
  const shareLine = (user: string, attached: readonly ('screen' | 'camera')[] = []) => {
    if (!sight || typeof (sight as Record<string, unknown>).perceptionTurnState !== 'function') throw new Error('这一棵树里还没有第 1 步的感知行。');
    const s = sight as unknown as { perceptionTurnLine(input: unknown): string; perceptionTurnState(runtime: unknown, attachments: unknown, text: unknown): unknown };
    return s.perceptionTurnLine(s.perceptionTurnState({ screenSharing: true, cameraSharing: false }, attached.map(source => ({ source })), user));
  };
  const samples: Sample[] = [];
  let taken = 0;
  let stopped: string | null = null;
  const base: Pick<RunOptions, 'model' | 'binary' | 'binaryArgs' | 'prewarmMs' | 'beforeTurn' | 'repeat'> = {
    model: '', binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs: dry ? 100 : 3000, repeat: 1,
    beforeTurn: () => { if (!dry && used + taken + 1 > TASK_CAP) throw new Error('已到这次任务的额度上限，停止。'); taken++; },
  };
  // The user takes a few seconds to type the next message, so a spare process the app starts after an image turn is ready by then.
  const typing: RunOptions['prepareTurn'] = async ({ index }) => { if (index > 0) await sleep(typingMs); };
  const gene = { persona: GENE_DAY_CARD.persona, mood: GENE_DAY_CARD.parameters };
  const shy = { persona: SHY_CARD.persona, mood: SHY_CARD.mood };
  const record = (arm: string, round: number) => (turn: TurnRecord) => {
    samples.push({ phase, arm, round, record: turn });
    const shown = replay(turn).visible.replace(/\s+/gu, ' ');
    console.log(`  [${arm}] r${round} ${turn.scenario}#${turn.turn} ${turn.process ?? ''} 首字 ${turn.chunks[0]?.[0] ?? '–'} ms 输入 ${turn.usage ? turn.usage.inputTokens + turn.usage.cacheReadTokens + turn.usage.cacheCreationTokens : '–'} tok${isLookOffer(replay(turn).visible) ? ' 问要不要看' : ''}\n      ${shown.slice(0, 200)}`);
  };
  const oldArm = (round: number): RunOptions => ({ ...base, label: `${label}:A`, scenarios: [TIMING_SCENARIO], card: gene, systemPrompt: oldSystemPrompt(),
    prepareTurn: typing, images: () => [frame], onTurn: record('A', round) });
  const newArm = (arm: string, round: number, withLine: boolean): RunOptions => ({ ...base, label: `${label}:${arm}`, scenarios: [TIMING_SCENARIO], card: gene,
    prepareTurn: typing, ...(withLine ? { hostContext: ({ user }) => shareLine(user) } : {}), onTurn: record(arm, round) });
  try {
    for (let round = 1; round <= rounds; round++) {
      if (phase === 'before') await runEval(oldArm(round));
      else if (phase === 'ab') for (const arm of round % 2 ? ['A', 'B'] : ['B', 'A']) await runEval(arm === 'A' ? oldArm(round) : newArm('B', round, true));
      else if (phase === 'line') for (const arm of round % 2 ? ['B0', 'B1'] : ['B1', 'B0']) await runEval(newArm(arm, round, arm === 'B1'));
      else if (phase === 'line2') for (const arm of round % 2 ? ['B0', 'B1s'] : ['B1s', 'B0']) await runEval(arm === 'B0' ? newArm(arm, round, false)
        : { ...newArm(arm, round, false), hostContext: () => '【此刻的感知】用户开着屏幕共享，但这一轮你没看画面；想看要用户叫你。' });
      else if (phase === 'screen') {
        await runEval({ ...base, label: `${label}:ordinary`, scenarios: [ORDINARY_SCREEN], card: shy, hostContext: ({ user }) => shareLine(user), onTurn: record('ordinary', round) });
        for (const scenario of LOOK_QUESTIONS)
          await runEval({ ...base, label: `${label}:look`, scenarios: [scenario], card: shy, hostContext: ({ user }) => shareLine(user, ['screen']), images: () => [frame], onTurn: record('look', round) });
      } else await runEval({ ...base, label: `${label}:offer`, scenarios: [OFFER_SCENARIO], card: shy, hostContext: ({ user }) => shareLine(user), onTurn: record('offer', round) });
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    console.log(`[image-depth] 中止：${stopped}`);
  } finally {
    await mkdir(DIR, { recursive: true });
    if (!dry) { entries.push({ at: new Date().toISOString(), phase, label, requests: taken }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DIR, `${stamp}-${label}.json`);
    await writeFile(file, JSON.stringify({ kind: 'image-depth', phase, label, commit: commitOf(), dry, stopped, requests: taken, samples }, null, 2), 'utf8');
    console.log(`[image-depth] 写入 ${path.relative(root, file)}（${samples.length} 条回复，${taken} 次请求）`);
    console.log(summary(phase, samples));
  }
}

/** First-token medians per arm and per turn, paired differences with a bootstrap interval, and what she said about the screen. */
export function summary(phase: string, samples: readonly Sample[]): string {
  const ok = samples.filter(sample => !sample.record.error && sample.record.chunks.length);
  const first = (sample: Sample) => sample.record.chunks[0][0];
  const lines = [`[image-depth] ${phase}：${ok.length} 条可用回复`];
  for (const arm of [...new Set(ok.map(sample => sample.arm))]) {
    for (const turn of [1, 2]) {
      const group = ok.filter(sample => sample.arm === arm && sample.record.turn === turn);
      if (group.length) lines.push(`  ${arm} 第 ${turn} 轮：${group.length} 条，首字中位 ${median(group.map(first))} ms（${group.map(first).join(', ')}），进程 ${[...new Set(group.map(s => s.record.process))].join('/')}`);
    }
  }
  const pairUp = (a: string, b: string) => {
    const diffs: number[] = [];
    for (const sample of ok.filter(s => s.arm === b)) {
      const other = ok.find(s => s.arm === a && s.round === sample.round && s.record.scenario === sample.record.scenario && s.record.turn === sample.record.turn);
      if (other) diffs.push(first(sample) - first(other));
    }
    const interval = pairedInterval(diffs);
    return `  ${b}−${a}：${diffs.length} 对，逐对差中位 ${median(diffs)} ms，平均 ${diffs.length ? Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length) : '–'} ms，bootstrap 95% 区间 ${interval ? interval.join(' ～ ') : '–'} ms，B 更快 ${diffs.filter(d => d < 0).length} 对`;
  };
  if (phase === 'ab') lines.push(pairUp('A', 'B'));
  if (phase === 'line') lines.push(pairUp('B0', 'B1'));
  if (phase === 'line2') lines.push(pairUp('B0', 'B1s'));
  // Every arm: did she talk about what is on the screen (expected only on 细看 turns), the developer chat, offer to look.
  for (const arm of [...new Set(ok.map(sample => sample.arm))]) {
    const group = ok.filter(sample => sample.arm === arm);
    const visible = group.map(sample => replay(sample.record).visible);
    lines.push(`  ${arm}：${group.length} 条；说到屏幕上的内容或说看到了 ${visible.filter(talksAboutScreen).length}；提到右边开发聊天 ${visible.filter(text => DEV_CHAT_TALK.test(text)).length}`
      + `；她问要不要凑近看 ${visible.filter(text => isLookOffer(text)).length}`
      + (arm === 'look' ? `；答对（2000 / speakSegment）${group.filter((sample, i) => sample.record.scenario === 'look-max' ? /2000|两千/u.test(visible[i]) : /speakSegment/iu.test(visible[i])).length}` : ''));
  }
  return lines.join('\n');
}

/** --replay <file.json>…: the summaries again from recorded runs (no calls). */
async function replayFiles(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const data = JSON.parse(await readFile(file, 'utf8')) as { phase: string; samples: Sample[] };
    console.log(`== ${path.basename(file)}`);
    console.log(summary(data.phase, data.samples));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const at = process.argv.indexOf('--replay');
  (at >= 0 ? replayFiles(process.argv.slice(at + 1)) : main()).catch(error => { console.error(error); process.exit(1); });
}
