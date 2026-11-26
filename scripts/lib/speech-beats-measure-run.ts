// 边说边演第 5 步的量法：把一场场合成对话交给应用自己的常驻聊天（PersistentClaudeChat，同样的启动参数、同样的系统提示词），
// 回复走应用同一条链：先过标记过滤器，再进回复协议（开头标记、草稿拦截、心情尾注）。她以前的话按应用的做法还给她（开关开着带标记）。
// 请求数上限由 scripts/lib/speech-beats-measure-tee.mjs 在 stdin 一侧硬挡（账本里已有 cap 条就不转发），这里再数一遍。
// 合成的人设和台词；不读任何真实配置、聊天或模型。原文（合成台词 + Claude 的回答）只写到调用者给的 rawDir（不在仓库里）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '../../shared/foundation/chat';
import { SpeechBeatFilter, speechBeatSentence } from '../../shared/behaviors/speech-beats/choose';
import { speechBeatHistoryText } from '../../shared/behaviors/speech-beats/history';
import { buildCodexChatPrompt, buildCompanionPersona } from '../../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask } from '../../electron/brain/claude-session';
import { MoodReplyProtocol } from '../../electron/mood/mood-chat';
import { analyseReply, ledgerRequests, looksLikeQuota, parseLedger, plannedRequests, summarise, type MeasureRow, type MeasureSummary, type PlannedConversation } from './speech-beats-measure';

/** 合成的人设：一个原创的桌宠角色，不是任何真实角色卡。 */
export const MEASURE_PERSONA = '你是小桃，一个住在用户电脑里的原创桌宠角色。你说话温柔、有点害羞，喜欢用短句，偶尔撒娇。你关心用户的作息和心情，记得你们聊过的小事。你不会假装能做做不到的事；不知道的就照实说。';
const MOOD_LINE = '当前心情：平静。';
export const TEE_PATH = path.join(import.meta.dirname,'speech-beats-measure-tee.mjs');

export interface MeasureOptions {
  /** 真的 Claude Code 的路径，或 node（假的，再加 commandArgs）。 */
  command: string;
  commandArgs?: readonly string[];
  ledger: string;
  /** 请求数硬上限（整个账本里；真实跑时跨多次运行）。 */
  cap: number;
  model?: string;
  gapMs?: number;
  plan: readonly PlannedConversation[];
  /** 原文存到这里（不在仓库里）；不给就不存。 */
  rawDir?: string;
  real: boolean;
  log?: (line: string) => void;
}
export interface MeasureResult { rows: MeasureRow[]; summary: MeasureSummary; requestsMade: number; stoppedBy: string | null; rawFile: string | null }

export async function runMeasure(options: MeasureOptions): Promise<MeasureResult> {
  const log = options.log ?? (() => {});
  const planned = plannedRequests(options.plan);
  const before = existsSync(options.ledger) ? ledgerRequests(parseLedger(readFileSync(options.ledger, 'utf8'))) : 0;
  if (before + planned > options.cap) throw new Error(`refusing to start: ${before} requests already made + ${planned} planned is over the cap ${options.cap}`);
  const binaryArgs = [TEE_PATH, '--ledger', options.ledger, '--cap', String(options.cap), '--', options.command, ...(options.commandArgs ?? [])];
  const rows: MeasureRow[] = [];
  const rawTurns: Record<string, unknown>[] = [];
  let rawFile: string | null = null;
  if (options.rawDir) { mkdirSync(options.rawDir, { recursive: true }); rawFile = path.join(options.rawDir, `run-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`); }
  const saveRaw = () => { if (rawFile) writeFileSync(rawFile, JSON.stringify({ persona: MEASURE_PERSONA, sentence: speechBeatSentence(), model: options.model || 'default', turns: rawTurns }, null, 1)); };
  let stoppedBy: string | null = null;
  const ledgerResults = () => parseLedger(existsSync(options.ledger) ? readFileSync(options.ledger, 'utf8') : '').filter(row => row.kind === 'result');

  for (const conversation of options.plan) {
    if (stoppedBy) break;
    const timings = new Map<string, { at: number; firstRaw: number | null }>();
    const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs, provider: () => ({ kind: 'claude', model: options.model ?? '' }), chattedBefore: () => true, log: () => {},
      timing: { dispatched: (id: string, _info: ClaudeTimingInfo) => { timings.set(id, { at: performance.now(), firstRaw: null }); }, firstDelta: (id: string) => { const row = timings.get(id); if (row && row.firstRaw === null) row.firstRaw = performance.now() - row.at; } } });
    const history: ChatMessage[] = [];
    try {
      for (let turn = 0; turn < conversation.lines.length; turn++) {
        const line = conversation.lines[turn];
        const id = `${conversation.name}-${turn}`;
        if (ledgerRequests(parseLedger(existsSync(options.ledger) ? readFileSync(options.ledger, 'utf8') : '')) >= options.cap) { stoppedBy = 'request cap reached'; break; }
        history.push({ role: 'user', content: line.text });
        const messages = history.slice(-24);
        const startedAt = performance.now();
        let firstVisible: number | null = null, shown = '', raw = '', moodTail = false, error: string | undefined;
        const protocol = new MoodReplyProtocol(delta => { shown += delta; if (firstVisible === null && /\S/u.test(delta)) firstVisible = performance.now() - (timings.get(id)?.at ?? startedAt); },
          { speakers: ['小桃'], chineseChat: true, opening: 'fixed', userText: line.text, moodNow: '' });
        const filter = new SpeechBeatFilter();
        const persona = buildCompanionPersona({ persona: MEASURE_PERSONA, stateContext: MOOD_LINE, memories: [], protocolInstruction: protocol.instruction() }) + (conversation.on ? '\n\n' + speechBeatSentence() : '');
        const ledgerBefore = ledgerResults().length;
        const task: CompanionClaudeTask = { kind: 'chat', model: options.model ?? '', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); }, imageDataUrls: [], replyId: id,
          session: { key: 'measure-' + conversation.name, basePersona: MEASURE_PERSONA, persona, messages, data: () => null, shown: () => historyAfter } };
        let historyAfter: string | null = null;
        try {
          await chat.stream(task, new AbortController().signal, (type: string, text: string) => {
            if (type !== 'delta') return;
            raw += text;
            const chunk = filter.push(text);
            if (chunk.text) protocol.push(chunk.text);
          });
          const rest = filter.end();
          if (rest.text) protocol.push(rest.text);
          moodTail = protocol.finish() !== null;
        } catch (caught) { error = String((caught as Error)?.message ?? caught); }
        const summary = filter.summary();
        const performanceOnly = summary.beats.length > 0 && !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(shown);
        historyAfter = speechBeatHistoryText({ text: shown, beats: summary.beats, performanceOnly, on: conversation.on });
        history.push({ role: 'assistant', content: historyAfter ?? '' });
        const usage = ledgerResults().slice(ledgerBefore).at(-1);
        const row: MeasureRow = { conversation: conversation.name, on: conversation.on, turn: turn + 1, lineId: line.id, kind: line.kind, first: turn === 0, ok: !error,
          ...(error ? { error: error.slice(0, 200) } : {}), firstVisibleMs: firstVisible === null ? null : Math.round(firstVisible), firstRawMs: timings.get(id)?.firstRaw == null ? null : Math.round(timings.get(id)!.firstRaw!),
          facts: error ? null : analyseReply(raw, shown), moodTail, outputTokens: usage?.outputTokens ?? null, inputTokens: usage?.inputTokens ?? null, cacheRead: usage?.cacheRead ?? null, cacheCreation: usage?.cacheCreation ?? null, model: usage?.model ?? '' };
        rows.push(row);
        rawTurns.push({ conversation: conversation.name, on: conversation.on, turn: turn + 1, line: line.text, raw, shown, historyKept: historyAfter, error });
        saveRaw();
        appendFileSync(options.ledger + '.rows.jsonl', JSON.stringify(row) + '\n');
        log(JSON.stringify({ id, on: conversation.on, kind: line.kind, ok: row.ok, firstVisibleMs: row.firstVisibleMs, beats: row.facts?.beats.length ?? null, leaked: row.facts?.leaked ?? null, tokens: row.outputTokens, error: row.error }));
        if (error && looksLikeQuota(error)) { stoppedBy = 'quota or rate-limit error: stopped, not retried'; break; }
        if (error && /request cap/iu.test(error)) { stoppedBy = 'request cap reached'; break; }
        await new Promise(resolve => setTimeout(resolve, options.gapMs ?? 2500));
      }
    } finally { chat.dispose(); }
  }
  const requestsMade = ledgerRequests(parseLedger(existsSync(options.ledger) ? readFileSync(options.ledger, 'utf8') : ''));
  return { rows, summary: summarise(rows), requestsMade, stoppedBy, rawFile };
}
