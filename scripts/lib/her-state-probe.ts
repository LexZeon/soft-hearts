// I-017 "啥都是状态"（docs/claude/2026-11-03-her-state-line.md）的真实 Claude 评测。
// Drives the app's own chat pipeline (CompanionService, MoodReplyProtocol, PersistentClaudeChat) on synthetic cards only (Gene's
// day card, the shy synthetic card "栖栖"); the perception line is the app's own function with a synthetic host state. Nothing
// starts Electron, captures sound or touches a profile.
//
//   node node_modules/tsx/dist/cli.mjs scripts/lib/her-state-probe.ts --phase <phase> [--rounds N] [--dry]
//   ab      R28's first-token rule, interleaved: A = the fixed rule and line as they were (step 1: "也听不到用户那边的声音",
//           "你看不到用户的屏幕和摄像头画面。"), B = the new fixed rule and the line with music on and her dancing
//           Run 2026-11-03: +255.5 ms paired median (12 pairs), over R28's +100 ms line, so the full sentence went to change turns only.
//   ab2     the same with what ordinary turns now carry: B = the new fixed rule and the brief line (music on, dancing)
//           Run 2026-11-03: +678.5 ms (12 pairs, 10 slower): not the length, she weighs the music in every reply. So the shipped path
//           says it in full once per conversation and switch change, briefly on a message about it, nothing otherwise.
//   ab3     not run yet (the 60-call budget ran out): the shipped ordinary turn, B = the new fixed rule with exactly the old
//           line (what an unrelated turn carries now), so it measures the fixed-rule rewording alone
//   honest  the shipped path: "你在干嘛呀" / "你在听歌吗" / "这首歌唱的什么呀" with music on and her dancing, music off (and with
//           --extra, nodding and quiet); the first turn carries the full sentence, the next two (both about it) the brief one.
//           Odd rounds use Gene's day card, even rounds the shy card 栖栖 (2 rounds = each condition once per card, 12 requests)
// Ledger: .local/her-state/ledger.json; this task's cap is 60 real requests across every phase. A failed turn stops the run.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findClaude } from '../../electron/claude';
import { claudeSessionSystemPrompt } from '../../electron/claude-session-prompt';
import { PERCEPTION_RULE, perceptionTurnLine, type PerceptionTurn } from '../../shared/perception-rule';
import { asksAboutHearing, type HerStateNow, type StageMusicState } from '../../shared/her-state';
import { GENE_DAY_CARD } from '../inner-loop-day-cards';
import { replay, type TurnRecord } from './prompt-eval-analysis';
import type { EvalScenario } from './prompt-eval-scenarios';
import { runEval, type RunOptions } from './prompt-eval-runner';
import { SHY_CARD } from './draft-leak-probe';

const root = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(root, '.local', 'her-state');
const ledgerFile = path.join(DIR, 'ledger.json');
const TASK_CAP = 84; // main session 2026-11-03: +24 for the shorter-wording round (ab3 with the 156-char rule)

const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);

/** The fixed perception fact before I-017 (识图第 1 步, 811ee9d), for arm A. */
export const OLD_PERCEPTION_RULE = '【你能感知到什么】平时你看不到用户的屏幕和摄像头画面，也听不到用户那边的声音；用户开了哪些感知、这一轮有没有附上画面，以这一轮私有上下文里的【此刻的感知】为准。只有某一轮明确附上了画面或声音资料，才算你看到、听到了。用户在不在、忙不忙，你只能从用户和你的互动（聊天、摸头、喂食）和应用告诉你的事知道，不要说成是你看见的。';
export function oldSystemPrompt(): string {
  const now = claudeSessionSystemPrompt();
  if (!now.includes(PERCEPTION_RULE)) throw new Error('现在的固定系统提示词里没有感知说明，旧路径无法重建。');
  return now.replace(PERCEPTION_RULE, OLD_PERCEPTION_RULE);
}
const SIGHT_OFF: PerceptionTurn = { screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null };
export const stateWith = (music: StageMusicState | null): HerStateNow => ({
  hearing: { source: music ? 'system-audio' : null, stage: music ? { music, always: false } : null, transcript: false }, contacts: [],
});
/** Arm A's line: the step-1 line, no hearing words (what main.ts sent before I-017). */
export const OLD_LINE = perceptionTurnLine(SIGHT_OFF);
export const lineFor = (music: StageMusicState | null, brief = false) => perceptionTurnLine(SIGHT_OFF, { ...stateWith(music), say: brief ? 'brief' : 'full' });
/**
 * What electron/her-state-host.ts gives a conversation with the switch unchanged: full on its first turn, then brief on a message
 * about it (asksAboutHearing) and nothing on the others (all three honest questions are about it).
 */
const shippedLine = (music: StageMusicState | null) => ({ index, user }: { index: number; user: string }) =>
  perceptionTurnLine(SIGHT_OFF, { ...stateWith(music), say: index === 0 ? 'full' : asksAboutHearing(user) ? 'brief' : 'none' });

/** Two ordinary messages (the timing scenario, as in the image-depth A/B). */
export const TIMING_SCENARIO: EvalScenario = { id: 'state-ordinary', title: '两条普通消息', turns: [
  { user: '今天写了一下午代码，眼睛好酸。' },
  { user: '晚上吃什么好呢？' },
] };
export const HONEST_SCENARIO: EvalScenario = { id: 'state-honest', title: '你在干嘛 / 你在听歌吗 / 这首歌唱的什么', turns: [
  { user: '你在干嘛呀？' },
  { user: '你在听歌吗？' },
  { user: '这首歌唱的什么呀？' },
] };

/** She says she is listening, or moving to it. */
export const LISTENING = /在听|听着|听歌|听音乐|音乐|节奏|旋律|跟着/u;
export const MOVING = /跳|晃|扭|摆|点头|摇/u;
/** She says she cannot make out the words (the honest answer to "唱的什么" without a transcript). */
export const NO_LYRICS = /听不懂|听不清|听不出|听不太出|没听懂|不知道.{0,6}(?:歌词|唱|讲)|只听得?到(?:节奏|旋律|调子|声音)|只听得出|歌词.{0,8}(?:不知道|听不|没听)/u;
/** She says she cannot hear (music off). */
export const CANNOT_HEAR = /听不到|听不见|没在听|没听到|没有在听|听不了/u;

interface LedgerEntry { at: string; phase: string; label: string; requests: number }
async function ledger(): Promise<LedgerEntry[]> { try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch { return []; } }
const commitOf = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const median = (values: readonly number[]): number | null => {
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
interface Sample { phase: string; arm: string; round: number; card: string; record: TurnRecord }

async function main(): Promise<void> {
  const phase = option('phase', 'ab');
  if (!['ab', 'ab2', 'ab3', 'honest'].includes(phase)) throw new Error(`未知的 --phase：${phase}`);
  const dry = flag('dry');
  const rounds = Math.max(1, Number(option('rounds', phase === 'honest' ? '2' : '6')) || 1);
  const label = option('label', `her-state-${phase}${dry ? '-dry' : ''}`);
  const extra = phase === 'honest' && flag('extra') ? 2 * HONEST_SCENARIO.turns.length : 0; // nod and quiet, once each
  const planned = phase === 'honest' ? rounds * 2 * HONEST_SCENARIO.turns.length + extra : rounds * 4;
  const entries = await ledger();
  const used = entries.reduce((sum, entry) => sum + entry.requests, 0);
  console.log(`[her-state] ${label}: 计划 ${planned} 次请求${dry ? '（假 Claude，不计额度）' : `；账本已用 ${used}，上限 ${TASK_CAP}`}`);
  if (!dry && used + planned > TASK_CAP) throw new Error(`会超过上限 ${TASK_CAP}（已用 ${used}，本次 ${planned}），没有开始。`);
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const binaryArgs = dry ? [path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')] : undefined;
  const typingMs = dry ? 50 : Number(option('typing-ms', '5000'));
  const samples: Sample[] = [];
  let taken = 0;
  let stopped: string | null = null;
  const base: Pick<RunOptions, 'model' | 'binary' | 'binaryArgs' | 'prewarmMs' | 'beforeTurn' | 'repeat'> = {
    model: '', binary, ...(binaryArgs ? { binaryArgs } : {}), prewarmMs: dry ? 100 : 3000, repeat: 1,
    beforeTurn: () => { if (!dry && used + taken + 1 > TASK_CAP) throw new Error('已到这次任务的额度上限，停止。'); taken++; },
  };
  const typing: RunOptions['prepareTurn'] = async ({ index }) => { if (index > 0) await sleep(typingMs); };
  const cards = { gene: { persona: GENE_DAY_CARD.persona, mood: GENE_DAY_CARD.parameters }, shy: { persona: SHY_CARD.persona, mood: SHY_CARD.mood } };
  const record = (arm: string, round: number, card: string) => (turn: TurnRecord) => {
    samples.push({ phase, arm, round, card, record: turn });
    const shown = replay(turn).visible.replace(/\s+/gu, ' ');
    console.log(`  [${arm}/${card}] r${round} ${turn.scenario}#${turn.turn} ${turn.process ?? ''} 首字 ${turn.chunks[0]?.[0] ?? '–'} ms\n      用户：${turn.user}\n      她：${shown.slice(0, 220)}`);
  };
  const arm = (name: string, round: number, card: 'gene' | 'shy', scenario: EvalScenario, line: string | ((turn: { index: number; user: string }) => string), old = false): RunOptions => ({
    ...base, label: `${label}:${name}`, scenarios: [scenario], card: cards[card], prepareTurn: typing,
    ...(old ? { systemPrompt: oldSystemPrompt() } : {}), hostContext: turn => typeof line === 'string' ? line : line(turn), onTurn: record(name, round, card),
  });
  try {
    if (phase === 'ab') {
      for (let round = 1; round <= rounds; round++)
        for (const name of round % 2 ? ['A', 'B'] : ['B', 'A'])
          await runEval(name === 'A' ? arm('A', round, 'gene', TIMING_SCENARIO, OLD_LINE, true) : arm('B', round, 'gene', TIMING_SCENARIO, lineFor('dance')));
    } else if (phase === 'ab2' || phase === 'ab3') {
      const shipped = phase === 'ab2' ? lineFor('dance', true) : perceptionTurnLine(SIGHT_OFF, { ...stateWith('dance'), say: 'none' });
      for (let round = 1; round <= rounds; round++)
        for (const name of round % 2 ? ['A', 'B'] : ['B', 'A'])
          await runEval(name === 'A' ? arm('A', round, 'gene', TIMING_SCENARIO, OLD_LINE, true) : arm('B', round, 'gene', TIMING_SCENARIO, shipped));
    } else {
      for (let round = 1; round <= rounds; round++) {
        const card = round % 2 ? 'gene' : 'shy';
        for (const name of round % 2 ? ['dance', 'off'] : ['off', 'dance'])
          await runEval(arm(name, round, card, HONEST_SCENARIO, shippedLine(name === 'dance' ? 'dance' : null)));
      }
      if (extra) {
        await runEval(arm('nod', 1, 'shy', HONEST_SCENARIO, shippedLine('nod')));
        await runEval(arm('silent', 1, 'gene', HONEST_SCENARIO, shippedLine('silent')));
      }
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    console.log(`[her-state] 中止：${stopped}`);
  } finally {
    await mkdir(DIR, { recursive: true });
    if (!dry) { entries.push({ at: new Date().toISOString(), phase, label, requests: taken }); await writeFile(ledgerFile, JSON.stringify(entries, null, 2), 'utf8'); }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DIR, `${stamp}-${label}.json`);
    await writeFile(file, JSON.stringify({ kind: 'her-state', phase, label, commit: commitOf(), dry, stopped, requests: taken,
      lines: { old: OLD_LINE, dance: lineFor('dance'), danceBrief: lineFor('dance', true), off: lineFor(null), offBrief: lineFor(null, true), nod: lineFor('nod'), silent: lineFor('silent') }, samples }, null, 2), 'utf8');
    console.log(`[her-state] 写入 ${path.relative(root, file)}（${samples.length} 条回复，${taken} 次请求）`);
    console.log(summary(phase, samples));
  }
}

/** First-token medians and paired differences (ab); what she said per condition and question (honest). */
export function summary(phase: string, samples: readonly Sample[]): string {
  const ok = samples.filter(sample => !sample.record.error && sample.record.chunks.length);
  const first = (sample: Sample) => sample.record.chunks[0][0];
  const lines = [`[her-state] ${phase}：${ok.length} 条可用回复`];
  if (phase === 'ab' || phase === 'ab2' || phase === 'ab3') {
    for (const name of ['A', 'B']) for (const turn of [1, 2]) {
      const group = ok.filter(sample => sample.arm === name && sample.record.turn === turn);
      if (group.length) lines.push(`  ${name} 第 ${turn} 轮：${group.length} 条，首字中位 ${median(group.map(first))} ms（${group.map(first).join(', ')}）`);
    }
    const diffs: number[] = [];
    for (const sample of ok.filter(s => s.arm === 'B')) {
      const other = ok.find(s => s.arm === 'A' && s.round === sample.round && s.record.turn === sample.record.turn);
      if (other) diffs.push(first(sample) - first(other));
    }
    const interval = pairedInterval(diffs);
    lines.push(`  B−A：${diffs.length} 对，逐对差中位 ${median(diffs)} ms，平均 ${diffs.length ? Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length) : '–'} ms，bootstrap 95% 区间 ${interval ? interval.join(' ～ ') : '–'} ms，B 更快 ${diffs.filter(d => d < 0).length} 对；逐对差 ${diffs.join(', ')}`);
    return lines.join('\n');
  }
  for (const name of [...new Set(ok.map(sample => sample.arm))]) for (const turn of [1, 2, 3]) {
    const group = ok.filter(sample => sample.arm === name && sample.record.turn === turn);
    if (!group.length) continue;
    const visible = group.map(sample => replay(sample.record).visible);
    lines.push(`  ${name} 第 ${turn} 问（${HONEST_SCENARIO.turns[turn - 1].user}）：${group.length} 条；说在听 ${visible.filter(t => LISTENING.test(t)).length}；说在动 ${visible.filter(t => MOVING.test(t)).length}`
      + `；说听不懂歌词 ${visible.filter(t => NO_LYRICS.test(t)).length}；说听不到 ${visible.filter(t => CANNOT_HEAR.test(t)).length}`);
  }
  return lines.join('\n');
}

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
