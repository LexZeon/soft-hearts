// I-091 experiment 1 (docs/claude/2026-11-12-voice-call-idea.md "建议的实验"; record docs/claude/2026-11-12-i091-experiment-1.md):
// in a call (warm process, short spoken turns), how much earlier does her first character come with less thinking or a faster
// model, and does she still sound like herself?
//   A  the app as it is: no --model, no --effort (Claude Code's default: Opus 5.5 at its catalog default, medium)
//   B  the same model, --effort low (one step below medium)
//   C  --model claude-sonnet-5-5 at the app's effort (no --effort)
//   D  --model claude-haiku-5-5 (no --effort)
// Fast mode is not an arm: see the record (the CLI's opt-in exists, but it draws from paid usage credits).
//
// Every arm is one conversation on its own warm process (PersistentClaudeChat with holdWarm, as a call keeps it), driven through
// the app's own pipeline: CompanionService (mood, protocol, relationship) → ChatSettingProposals → PersistentClaudeChat →
// ClaudeChatProcess (the app's isolation flags, empty temp folder, filtered environment). One warm-up turn per arm (not counted),
// then the same short spoken lines to every arm, the arms' order rotated every line. The same one-line call rule is appended to
// every arm's fixed system prompt (steps 1–2 have none of their own). Synthetic card (the fidelity suite's Gene) and lines only;
// every arm's data lives in its own temp folder, deleted afterwards; the user's profile is never read.
// Hard cap on real requests (counted lines + warm-ups); any failed turn stops the run, nothing is retried by this script.
// Run it through the heavy gate (I-030):
//   node scripts/dev/heavy.mjs --label i091-exp1 -- node node_modules/tsx/dist/cli.mjs scripts/lib/i091-call-speed-ab.ts [--lines 10] [--dry]
//   node node_modules/tsx/dist/cli.mjs scripts/lib/i091-call-speed-ab.ts --report <file.json> [--replies]   (no calls)
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { ProviderConfig } from '../../shared/foundation/settings';
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import { CompanionService } from '../../electron/brain/companion';
import { ChatSettingProposals } from '../../electron/brain/chat-settings';
import { buildCodexChatPrompt } from '../../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo } from '../../electron/brain/claude-session';
import { claudeSessionSystemPrompt } from '../../electron/brain/claude-session-prompt';
import { APP_REPLY_OPENING } from '../../electron/brain/reply-opening';
import { ClaudeChatProcess } from '../../electron/brain/claude-process';
import { findClaude } from '../../electron/brain/claude';
import { FIDELITY_CARDS } from './fidelity-scenarios';
import { checkHardRules } from './fidelity-rules';
import { evalRelationshipData } from './prompt-eval-runner';
import { speakingShape } from './reply-opening-ab';

const root = path.resolve(import.meta.dirname, '..', '..');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The one line every arm gets in its fixed system prompt (a call's spoken style; steps 1–2 add none). */
export const CALL_STYLE_RULE = '【通话】用户正在和你打语音电话，你的回复会被直接念给用户听。像打电话一样说话：短、口语化，一般一两句；不要列表、标题或其他排版。';

export const WARM_UP_LINE = '喂，听得到吗？';
/** Short things a user might say on a call (synthetic), one conversation, in this order. */
export const CALL_LINES: readonly string[] = [
  '我刚到家，今天好累啊。',
  '下午开会被领导点名批评了。',
  '你猜我晚饭吃的什么？',
  '哈哈，是麻辣烫，加了好多辣。',
  '你今天都在干嘛呀？',
  '外面好像要下雨了，好闷。',
  '周末想出去玩，你说去哪儿好？',
  '嗯……其实我今天有点想你。',
  '明天要早起，好烦哦。',
  '那我先去洗澡啦，等会儿再跟你说。',
];

export type ArmId = 'A' | 'B' | 'C' | 'D';
interface ArmSpec { id: ArmId; name: string; model: string; extraArgs: string[] }
export const ARMS: readonly ArmSpec[] = [
  { id: 'A', name: '现在的默认（Opus 5.5，默认思考深度）', model: '', extraArgs: [] },
  { id: 'B', name: 'Opus 5.5，思考低一档（low）', model: '', extraArgs: ['--effort', 'low'] },
  { id: 'C', name: 'Sonnet 5.5（默认思考深度）', model: 'claude-sonnet-5-5', extraArgs: [] },
  { id: 'D', name: 'Haiku 5.5（默认思考深度）', model: 'claude-haiku-5-5', extraArgs: [] },
];

interface Sink {
  t0: number;
  firstEventMs: number | null;
  thinkingStartMs: number | null;
  textStartMs: number | null;
  thinkingChars: number;
  blocks: string[];
  initModel: string | null;
  initInfo: Record<string, string | number | boolean> | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number | null; apiMs: number | null } | null;
}

export interface Row {
  arm: ArmId; purpose: 'warm-up' | 'line'; line: number; position: number; user: string;
  process: ClaudeTimingInfo['process'] | null; sessionTurn: number | null; inputChars: number | null;
  beginMs: number; firstEventMs: number | null; thinkingStartMs: number | null; textStartMs: number | null;
  firstDeltaMs: number | null; firstVisibleMs: number | null; endMs: number;
  raw: string; visible: string; chars: number; thinkingChars: number; blocks: string[];
  initModel: string | null; initInfo: Record<string, string | number | boolean> | null; usage: Sink['usage']; error: string | null;
}

interface Arm {
  spec: ArmSpec;
  chat: PersistentClaudeChat;
  companion: CompanionService;
  settings: ChatSettingProposals;
  directory: string;
  characterId: string;
  messages: ChatMessage[];
  sink: Sink | null;
  timing: ClaudeTimingInfo | null;
  /** User messages actually written to Claude Code's stdin (the exact request count, retries included). */
  requests: number;
}

/** Observes (never alters) one arm's process: stream events for timing, init scalars, usage; counts user messages written. */
function tapFor(arm: () => Arm) {
  return (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = spawn(command, args, options);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { continue; }
        const sink = arm().sink;
        if (!sink) continue;
        const at = Math.round(performance.now() - sink.t0);
        if (event.type === 'system' && event.subtype === 'init') {
          if (typeof event.model === 'string') sink.initModel = event.model;
          const info: Record<string, string | number | boolean> = {};
          for (const [key, value] of Object.entries(event)) {
            if (['type', 'subtype', 'session_id', 'uuid', 'cwd'].includes(key)) continue;
            if (typeof value === 'string' && value.length <= 80 && !/[\\/]/u.test(value)) info[key] = value;
            else if (typeof value === 'number' || typeof value === 'boolean') info[key] = value;
          }
          sink.initInfo = info;
        }
        if (event.type === 'stream_event') {
          const inner = event.event ?? {};
          sink.firstEventMs ??= at;
          if (inner.type === 'content_block_start' && typeof inner.content_block?.type === 'string') {
            sink.blocks.push(`${inner.index}:${inner.content_block.type}`);
            if (inner.content_block.type === 'thinking') sink.thinkingStartMs ??= at;
            if (inner.content_block.type === 'text') sink.textStartMs ??= at;
          }
          if (inner.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string')
            sink.thinkingChars += inner.delta.thinking.length;
        }
        if (event.type === 'result') {
          const usage = event.usage ?? {};
          sink.usage = {
            inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0),
            cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0), cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
            apiMs: typeof event.duration_api_ms === 'number' ? event.duration_api_ms : null,
          };
        }
      }
    });
    const stdin = child.stdin;
    if (stdin) {
      const write = stdin.write.bind(stdin) as (...values: unknown[]) => boolean;
      (stdin as unknown as { write: (...values: unknown[]) => boolean }).write = (...values: unknown[]) => {
        try { if (JSON.parse(String(values[0]))?.type === 'user') arm().requests++; } catch { /* Control messages are not requests. */ }
        return write(...values);
      };
    }
    return child;
  };
}

// ---------------------------------------------------------------- numbers

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const p90 = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
};
const nums = (rows: readonly Row[], pick: (row: Row) => number | null | undefined) => rows.map(pick).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

export function summary(rows: readonly Row[]): string {
  const lines: string[] = [];
  const counted = rows.filter(row => row.purpose === 'line' && !row.error);
  lines.push('组 | 回合 | 首个事件 中位/p90 | 首个文字增量 中位/p90 | 首个可见字 中位/p90 | 整轮 中位/p90 | 字数 中位 | 输出 token 中位 | 思考字数 中位 | 进程');
  for (const spec of ARMS) {
    const list = counted.filter(row => row.arm === spec.id);
    if (!list.length) continue;
    const pair = (pick: (row: Row) => number | null | undefined) => `${median(nums(list, pick)) ?? '–'} / ${p90(nums(list, pick)) ?? '–'}`;
    const kinds = [...new Set(list.map(row => row.process ?? '?'))].join(',');
    lines.push(`${spec.id} | ${list.length} | ${pair(row => row.firstEventMs)} | ${pair(row => row.firstDeltaMs)} | ${pair(row => row.firstVisibleMs)} | ${pair(row => row.endMs)}`
      + ` | ${median(nums(list, row => row.chars))} | ${median(nums(list, row => row.usage?.outputTokens))} | ${median(nums(list, row => row.thinkingChars))} | ${kinds}`);
  }
  // Line by line against A (same line, same time window): first visible character.
  for (const spec of ARMS.slice(1)) {
    const diffs: number[] = [];
    for (const row of counted.filter(item => item.arm === spec.id)) {
      const a = counted.find(item => item.arm === 'A' && item.line === row.line);
      if (a?.firstVisibleMs != null && row.firstVisibleMs != null) diffs.push(row.firstVisibleMs - a.firstVisibleMs);
    }
    if (diffs.length) lines.push(`${spec.id}−A 首个可见字（逐句）：中位 ${median(diffs)} ms，${diffs.filter(diff => diff < 0).length}/${diffs.length} 句更快`);
  }
  for (const spec of ARMS) {
    const list = counted.filter(row => row.arm === spec.id);
    if (!list.length) continue;
    const shapes = list.map(row => speakingShape(row.visible));
    const hard = list.map(row => checkHardRules(row.visible)).filter(hits => hits.length).length;
    lines.push(`${spec.id} 说话的样子：列表/标题/整段引号 ${shapes.filter(shape => shape.format.length).length}，书信腔 ${shapes.filter(shape => shape.letter.length).length}，`
      + `平均 ${(shapes.reduce((sum, shape) => sum + shape.paragraphs, 0) / shapes.length).toFixed(2)} 段，硬规则命中 ${hard} 条；init 模型 ${[...new Set(list.map(row => row.initModel ?? '?'))].join(',')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- the run

const commitOf = (): string => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return '?'; } };

async function main(): Promise<void> {
  const reports = process.argv.indexOf('--report');
  if (reports >= 0) {
    const rows: Row[] = [];
    for (const file of process.argv.slice(reports + 1).filter(value => value.endsWith('.json'))) rows.push(...(JSON.parse(await readFile(file, 'utf8')) as { rows: Row[] }).rows);
    console.log(summary(rows));
    if (flag('replies')) for (const row of rows) console.log(`\n[${row.arm}] ${row.purpose} #${row.line} 首字 ${row.firstVisibleMs} ms 整轮 ${row.endMs} ms\n> ${row.user}\n${row.visible}`);
    return;
  }
  const dry = flag('dry');
  const lineCount = Math.max(1, Math.min(CALL_LINES.length, Number(option('lines', '10')) || 10));
  const countedCap = Math.max(1, Math.min(40, Number(option('cap', '40')) || 40));
  const warmUpCap = 5;
  const out = path.resolve(root, option('out', path.join('.local', 'i091-exp1')));
  const binary = dry ? process.execPath : option('claude') || process.env.CLAUDE_PATH || await findClaude();
  const fake = path.join(root, 'scripts', 'lib', 'prompt-eval-fake-claude.mjs');
  const card = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const persona = card.persona, mood = card.mood;
  // A user she has known for a while (no memes): the same for every arm.
  const relationship = { slowWarmUp: false, dayNumber: 30, togetherDays: 12 };
  const opening = APP_REPLY_OPENING;
  const systemPrompt = claudeSessionSystemPrompt({ opening: opening === 'fixed' }) + '\n' + CALL_STYLE_RULE;
  const planned = ARMS.length * lineCount;
  if (planned > countedCap) throw new Error(`计划 ${planned} 轮，超过上限 ${countedCap}，没有开始。`);
  console.log(`[i091-exp1] ${ARMS.length} 组 × ${lineCount} 句 = ${planned} 轮计数 + ${ARMS.length} 轮热身${dry ? '（假 Claude，不计额度）' : ''}；版本 ${commitOf()}`);

  const arms: Arm[] = [];
  const rows: Row[] = [];
  let countedTurns = 0, warmUps = 0, stopped: string | null = null;
  try {
    for (const spec of ARMS) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i091-exp1-'));
      const characterId = randomUUID();
      const provider: ProviderConfig = { ...DEFAULT_SETTINGS.provider, model: spec.model };
      let self!: Arm;
      const chat = new PersistentClaudeChat({
        enabled: true,
        provider: () => provider,
        chattedBefore: () => true,
        binary: async () => binary,
        // The arm's own flags go in front of Claude Code's arguments (the fake takes none: it only checks the app's own).
        binaryArgs: dry ? [fake] : spec.extraArgs,
        systemPrompt,
        startProcess: processOptions => ClaudeChatProcess.start({ ...processOptions, spawn: tapFor(() => self) as typeof spawn }),
        timing: { dispatched: (_id, info) => { self.timing = info; }, firstDelta: () => {} },
        log: line => console.log(`  [${spec.id} session] ${line}`),
      });
      const companion = new CompanionService(directory, () => {});
      companion.setReplyOpening(opening);
      await companion.load();
      await companion.context(characterId, provider, persona, mood);
      companion.relationship.setCardSource(() => ({ slowWarmUp: relationship.slowWarmUp, tendencies: { ...mood.weights } }));
      await companion.relationship.prepare(companion.currentScope(), () => ({ first: null, rounds: new Map() }));
      await companion.relationship.seed(characterId, evalRelationshipData(relationship));
      const settings = new ChatSettingProposals({ settings: () => structuredClone(DEFAULT_SETTINGS), send: () => {} });
      settings.connect(async () => ({ ok: false, error: { code: 'failed', message: 'evaluation only' } }) as never);
      self = { spec, chat, companion, settings, directory, characterId, messages: [], sink: null, timing: null, requests: 0 };
      arms.push(self);
      // A call is on: the process stays warm, and a spare starts now for the first turn.
      chat.holdWarm(true);
    }
    await sleep(dry ? 300 : 4000);

    const turn = async (arm: Arm, user: string, purpose: Row['purpose'], line: number, position: number) => {
      if (purpose === 'line' && ++countedTurns > countedCap) throw new Error(`已到计数上限 ${countedCap}，停止。`);
      if (purpose === 'warm-up' && ++warmUps > warmUpCap) throw new Error(`已到热身上限 ${warmUpCap}，停止。`);
      const id = `i091-${arm.spec.id}-${line}-${randomUUID().slice(0, 8)}`;
      const t0 = performance.now();
      const since = () => Math.round(performance.now() - t0);
      const settingTurn = arm.settings.beginTurn(user);
      let visible = '', raw = '', firstVisibleMs: number | null = null, firstDeltaMs: number | null = null;
      const companionTurn = await arm.companion.begin(id, user, persona, (type, text) => {
        if (type !== 'delta') return;
        if (firstVisibleMs === null && text.trim()) firstVisibleMs = since();
        visible += text;
      }, { textMemorial: false, settingProposal: settingTurn });
      const beginMs = since();
      arm.messages.push({ role: 'user', content: user });
      const window = [...arm.messages];
      const sink: Sink = { t0, firstEventMs: null, thinkingStartMs: null, textStartMs: null, thinkingChars: 0, blocks: [], initModel: null, initInfo: null, usage: null };
      arm.sink = sink;
      arm.timing = null;
      let error: string | null = null;
      try {
        await arm.chat.stream({
          kind: 'chat', model: arm.spec.model, workingDirectory: arm.directory, writable: false,
          get prompt() { return buildCodexChatPrompt(companionTurn.persona, window, null); },
          imageDataUrls: [], replyId: id,
          session: { key: arm.companion.currentSpeechScope(), basePersona: persona, persona: companionTurn.persona, openingContext: companionTurn.relationshipOpening,
            openingKey: companionTurn.relationshipTag, messages: window, language: null, data: () => null, shown: () => companionTurn.shownReply?.() ?? null },
        }, new AbortController().signal, (type, text) => {
          if (type === 'delta') { firstDeltaMs ??= since(); raw += text; }
          companionTurn.push(type, text);
        });
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      const endMs = since();
      arm.sink = null;
      await companionTurn.finish(error ? 'error' : 'complete');
      if (!error) arm.settings.offer(settingTurn.ticket, 1, id, companionTurn.settingProposal?.());
      arm.messages.push({ role: 'assistant', content: visible });
      const row: Row = {
        arm: arm.spec.id, purpose, line, position, user, process: arm.timing?.process ?? null, sessionTurn: arm.timing?.sessionTurn ?? null,
        inputChars: arm.timing?.inputChars ?? null, beginMs, firstEventMs: sink.firstEventMs, thinkingStartMs: sink.thinkingStartMs, textStartMs: sink.textStartMs,
        firstDeltaMs, firstVisibleMs, endMs, raw, visible: visible.trim(), chars: [...visible.trim()].length, thinkingChars: sink.thinkingChars, blocks: sink.blocks,
        initModel: sink.initModel, initInfo: sink.initInfo, usage: sink.usage, error,
      };
      rows.push(row);
      console.log(`  [${row.arm}] ${purpose === 'warm-up' ? '热身' : `#${line}`} ${row.process ?? '?'}/${row.sessionTurn ?? '?'} 事件 ${row.firstEventMs ?? '–'} 增量 ${row.firstDeltaMs ?? '–'}`
        + ` 可见 ${row.firstVisibleMs ?? '–'} 整轮 ${row.endMs} ms，${row.chars} 字，思考 ${row.thinkingChars} 字 ${row.initModel ?? ''}${error ? ` 错误：${error}` : ''}\n      ${row.visible.replace(/\s+/gu, ' ').slice(0, 100)}`);
      if (error) throw new Error(`${arm.spec.id} ${purpose} #${line} 出错后停止（已完成的轮次已记录）：${error}`);
      await sleep(dry ? 20 : 400);
    };
    for (const [position, arm] of arms.entries()) await turn(arm, WARM_UP_LINE, 'warm-up', 0, position);
    for (let index = 0; index < lineCount; index++) {
      const order = arms.map((_, i) => arms[(i + index) % arms.length]);
      for (const [position, arm] of order.entries()) await turn(arm, CALL_LINES[index], 'line', index + 1, position);
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
    console.log(`[i091-exp1] 中止：${stopped}`);
  } finally {
    for (const arm of arms) {
      arm.chat.holdWarm(false);
      arm.chat.dispose();
      await arm.companion.flush().catch(() => {});
    }
    await sleep(dry ? 100 : 1500);
    for (const arm of arms) await rm(arm.directory, { recursive: true, force: true }).catch(() => {});
    const requests = Object.fromEntries(arms.map(arm => [arm.spec.id, arm.requests]));
    const totalRequests = arms.reduce((sum, arm) => sum + arm.requests, 0);
    await mkdir(out, { recursive: true });
    const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}${dry ? '-dry' : ''}.json`);
    await writeFile(file, JSON.stringify({ kind: 'i091-exp1', commit: commitOf(), dry, stopped, callRule: CALL_STYLE_RULE, arms: ARMS,
      calls: { warmUps: rows.filter(row => row.purpose === 'warm-up').length, lines: rows.filter(row => row.purpose === 'line').length, requests, totalRequests }, rows }, null, 2), 'utf8');
    console.log(`[i091-exp1] 写入 ${path.relative(root, file)}；回合：热身 ${rows.filter(row => row.purpose === 'warm-up').length}，计数 ${rows.filter(row => row.purpose === 'line').length}；`
      + `写给 Claude Code 的请求 ${totalRequests}（${JSON.stringify(requests)}）`);
    console.log(summary(rows));
  }
}
// Only when run as a script: importing this module never starts requests.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exit(1); });
