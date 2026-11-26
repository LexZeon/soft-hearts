// I-138 restart-drift experiment: the conversation engine and the run. A Conversation is one long-chat session built the way the app builds it
// (the host's window from her archive, today + 60 earlier within windowMaxChars, her note in the opening message, the per-turn private content
// from CompanionService, the app's PersistentClaudeChat with the long-chat knobs). The warm conversation is copied into the four arms:
//   W  the same live process goes on
//   R  a fresh process, rebuilt from the archive copy (today + 60 + note), the app's way after a restart
//   R0 like R without the note
//   C  a forked copy of the warm Claude Code session, compacted once with /compact, then continued
// Everything private (message text) stays in memory and in the files written to --out; console lines carry ids, counts and timings only.
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { ProviderConfig } from '../../shared/foundation/settings';
import type { MoodParameters } from '../../shared/foundation/mood';
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import { LONG_CHAT_KNOBS, type LongChatKnobs } from '../../shared/behaviors/long-chat/knobs';
import { CompanionService, memoryProviderScope } from '../../electron/brain/companion';
import { MemoryStore } from '../../electron/memory/memory';
import { ChatSettingProposals } from '../../electron/brain/chat-settings';
import { buildCodexChatPrompt } from '../../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo } from '../../electron/brain/claude-session';
import { claudeSessionSystemPrompt, CLAUDE_FOLLOW_UP_HEADER } from '../../electron/brain/claude-session-prompt';
import { FOLLOW_UP_HEADER } from '../../shared/foundation/i139-texts';
import { APP_REPLY_OPENING } from '../../electron/brain/reply-opening';
import { ClaudeChatProcess, ClaudeTurnError } from '../../electron/brain/claude-process';
import { CLAUDE_REFUSED_MESSAGE, claudeInput, streamClaude } from '../../electron/brain/claude';
import { buildLongChatWindow, type LongChatSourceMessage } from '../../electron/brain/long-chat/window';
import { markTimes, type Timed } from '../../electron/brain/long-chat/history';
import { FIRST_NOTE_INSTRUCTION, buildFirstNotePrompt } from '../../electron/memory/her-note/prompt';
import { localDateKey } from '../../electron/memory/diary/diary-dates';
import { setPromptSwitches } from '../../shared/brain/prompt-switches';
import { evalRelationshipData } from './prompt-eval-runner';
import type { TurnUsage } from './prompt-eval-analysis';
import type { FidelityCard } from './fidelity-scenarios';
import { buildSeedRecords, dayStartMs, locatePoint, moodAt, scopeKeyOf, togetherDaysBefore, dayNumberAt, weightsAt, type PointSpec, type Snapshot } from './i134-replay';
import { CallCap, DRIFT_ARMS, type DriftArm } from './i138-plan';
import { REVIEW_INSTRUCTION, buildReviewPrompt, extractJokes, parseReview, shuffleSegments, styleProfile, type Line, type ParsedReview, type StyleProfile } from './i138-analysis';

// ---- records -----------------------------------------------------------------------------------------------------------------------

export interface TurnRec {
  /** The real user line (private). */
  user: string;
  /** Her reply as the app showed it (private). */
  text: string;
  chars: number;
  error: string | null;
  refused: boolean;
  firstCharMs: number | null; endMs: number | null; dispatchMs: number | null;
  usage: TurnUsage | null;
  promptChars: number | null;
  /** The turn opened a session (full window) rather than being a follow-up. */
  opening: boolean;
  sessionTurn: number | null;
  /** Why the turn did or did not continue the process before it (claude-session.ts ClaudeTimingInfo.reuse): first, warm, diverged-user, budget ... */
  reuse: string | null;
}
export interface MomentState {
  id: string; at: number;
  note: string;
  jokes: string[];
  /** Her usual words, taken from her real earlier lines (private); the style numbers count these. */
  profile: StyleProfile;
  warm: TurnRec[];
  arms: Partial<Record<DriftArm, TurnRec[]>>;
  compaction: { ok: boolean; ms: number | null; usage: TurnUsage | null; note: string } | null;
  review: { key: Record<string, DriftArm>; promptChars: number; prompt: string; answer: ParsedReview | null; error: string | null } | null;
  done: boolean;
}

// ---- the process tap: usage, session id, the prompt that went out, argument variants -----------------------------------------------------

export type ProcessMode = 'plain' | 'persisted' | 'fork';
/**
 * Wraps spawn for one conversation: observes what the process writes and reads (never changes it, except the argument variants below).
 *  plain      the app's exact arguments;
 *  persisted  without `--no-session-persistence`, so the transcript exists and the session can be forked (warm conversation only);
 *  fork       persisted, slash commands on (for /compact), and `--resume <id> --fork-session`.
 */
export class ProcessTap {
  usage: TurnUsage | null = null;
  sessionId: string | null = null;
  prompt: string | null = null;
  /** Working folders of the processes started (for deleting their saved transcripts afterwards). */
  readonly cwds: string[] = [];
  constructor(private readonly mode: ProcessMode, private readonly forkFrom: string | null = null) {}

  variantArguments(args: readonly string[]): string[] {
    if (this.mode === 'plain') return [...args];
    const drop = new Set(['--no-session-persistence', ...(this.mode === 'fork' ? ['--disable-slash-commands'] : [])]);
    const out = args.filter(arg => !drop.has(arg));
    if (this.mode === 'fork') {
      if (!this.forkFrom) throw new Error('fork 需要热身会话的 session id（热身进程没有报出来）。');
      out.push('--resume', this.forkFrom, '--fork-session');
    }
    return out;
  }

  readonly spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    if (typeof options.cwd === 'string') this.cwds.push(options.cwd);
    const child = spawn(command, this.variantArguments(args), options);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') this.sessionId = event.session_id;
        if (event.type === 'result') {
          const usage = event.usage ?? {};
          this.usage = {
            inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0),
            cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0), cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null, apiMs: typeof event.duration_api_ms === 'number' ? event.duration_api_ms : null,
          };
        }
      }
    });
    const stdin = child.stdin;
    if (stdin) {
      const write = stdin.write.bind(stdin) as (...values: unknown[]) => boolean;
      (stdin as unknown as { write: (...values: unknown[]) => boolean }).write = (...values: unknown[]) => {
        try {
          const event = JSON.parse(String(values[0]));
          if (event?.type === 'user') this.prompt = event.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
        } catch { /* Control messages and partial writes are not prompts. */ }
        return write(...values);
      };
    }
    return child;
  }) as unknown as typeof spawn;

  take(): { usage: TurnUsage | null; prompt: string | null } {
    const taken = { usage: this.usage, prompt: this.prompt };
    this.usage = null; this.prompt = null;
    return taken;
  }
}

// ---- the session state (the one place that looks inside PersistentClaudeChat) ---------------------------------------------------------------

interface SessionShape { key: string; process: ClaudeChatProcess; known: ChatMessage[]; log: Record<string, unknown>[]; turns: number; chars: number }
/** The chat's live session, checked for the fields the fork needs. Throws when electron/brain/claude-session.ts changed shape. */
export function peekSession(chat: PersistentClaudeChat): SessionShape {
  const session = (chat as unknown as { session: SessionShape | null }).session;
  if (!session || typeof session.key !== 'string' || !Array.isArray(session.known) || !Array.isArray(session.log) || !session.process) throw new Error('热身会话还没有开始，或 PersistentClaudeChat 的内部结构变了（claude-session.ts Session）。');
  return session;
}
/** Puts a copy of `from` into `chat` as its session, on `process`: the app's own alignment (planSessionTurn) then treats the next turn as a follow-up. */
export function adoptSession(chat: PersistentClaudeChat, from: SessionShape, process: ClaudeChatProcess): void {
  const copy: SessionShape = { key: from.key, process, known: from.known.map(message => ({ ...message })), log: from.log.map(entry => ({ ...entry })), turns: from.turns, chars: from.chars };
  (chat as unknown as { session: SessionShape }).session = copy;
}

// ---- the engine ----------------------------------------------------------------------------------------------------------------------

export interface EngineOptions {
  snapshot: Snapshot;
  card: FidelityCard & { slowWarmUp?: boolean };
  model: string;
  binary: string;
  binaryArgs?: readonly string[];
  cap: CallCap;
  knobs?: Pick<LongChatKnobs, 'beforeDay' | 'dayStartHour' | 'windowMaxChars' | 'sessionMaxChars'>;
  prewarmMs?: number;
  log?: (line: string) => void;
  /** Receives every full prompt (private chat text) for --dump-prompts; private folder only. */
  promptDump?: (name: string, prompt: string) => Promise<void>;
  /** Where Claude Code keeps saved transcripts (default ~/.claude); the persisted warm and forked sessions' folders are removed from it at the end. */
  claudeHome?: string;
  /** Collects the working folders of the persisted processes (see removeTranscripts). */
  cwds?: string[];
}

interface ConversationSetup {
  point: PointSpec;
  index: number;
  note: string | null;
  mode: ProcessMode;
  forkFrom?: string | null;
  /** Archive the conversation starts with (a copy, for the branches). */
  archive?: LongChatSourceMessage[];
  directory?: string;
  characterId?: string;
  todayRounds?: number;
  label: string;
}

const REPLY_GAP_MS = 1;

export class Conversation {
  readonly tap: ProcessTap;
  /** Her archive beyond the real chat before the point: the user lines and replies of this conversation so far, as the host stores them. */
  archive: LongChatSourceMessage[];
  turnsDone = 0;
  private constructor(
    private readonly engine: EngineOptions, private readonly setup: ConversationSetup, readonly directory: string, readonly characterId: string,
    private readonly provider: ProviderConfig, private readonly companion: CompanionService, readonly chat: PersistentClaudeChat,
    private readonly settings: ChatSettingProposals, tap: ProcessTap, private readonly persona: string, private readonly mood: MoodParameters,
  ) { this.tap = tap; this.archive = setup.archive ?? []; }

  get note(): string | null { return this.setup.note; }

  static async open(engine: EngineOptions, setup: ConversationSetup): Promise<Conversation> {
    const directory = setup.directory ?? await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i138-'));
    const characterId = setup.characterId ?? randomUUID();
    const provider: ProviderConfig = { ...DEFAULT_SETTINGS.provider, model: engine.model };
    const card = engine.card;
    const persona = card.persona, mood = card.mood;
    if (!setup.directory) {
      // The archive as it stood before the point (for her recall), like the i134 replay: records strictly before the moment.
      const scope = { characterId, providerScope: memoryProviderScope(provider) };
      const records = buildSeedRecords(engine.snapshot.cache, weightsAt(engine.snapshot.store, engine.snapshot.scope, setup.point.at), setup.point.at, scopeKeyOf(scope));
      const target = new MemoryStore(directory);
      await target.load();
      await target.restoreRecords(records, scope);
      await target.flush();
    }
    const companion = new CompanionService(directory, () => {});
    companion.setReplyOpening(APP_REPLY_OPENING);
    await companion.load();
    await companion.context(characterId, provider, persona, mood);
    const first = engine.snapshot.messages[0]!.createdAt;
    companion.relationship.setCardSource(() => ({ slowWarmUp: card.slowWarmUp ?? false, tendencies: { ...mood.weights } }));
    await companion.relationship.prepare(companion.currentScope(), () => ({ first: null, rounds: new Map() }));
    await companion.relationship.seed(characterId, evalRelationshipData({ slowWarmUp: card.slowWarmUp ?? false, dayNumber: dayNumberAt(first, setup.point.at),
      togetherDays: togetherDaysBefore(engine.snapshot.messages, setup.index), todayRounds: setup.todayRounds ?? 0 }));
    const settings = new ChatSettingProposals({ settings: () => structuredClone(DEFAULT_SETTINGS), send: () => {} });
    settings.connect(async () => ({ ok: false, error: { code: 'failed', message: 'evaluation only' } }) as never);
    const tap = new ProcessTap(setup.mode, setup.forkFrom ?? null);
    const knobs: LongChatKnobs = Object.freeze({ ...LONG_CHAT_KNOBS, ...(engine.knobs ?? {}), enabled: true });
    let conversation: Conversation | null = null;
    const chat = new PersistentClaudeChat({
      enabled: true, provider: () => provider, chattedBefore: () => true, binary: async () => engine.binary,
      ...(engine.binaryArgs ? { binaryArgs: engine.binaryArgs } : {}),
      systemPrompt: claudeSessionSystemPrompt({ opening: APP_REPLY_OPENING === 'fixed' }),
      startProcess: options => ClaudeChatProcess.start({ ...options, spawn: tap.spawn }),
      longChat: knobs,
      timing: { dispatched: (_id, info) => conversation?.dispatched(info), firstDelta: () => {} },
      log: () => {},
    });
    conversation = new Conversation(engine, setup, directory, characterId, provider, companion, chat, settings, tap, persona, mood);
    return conversation;
  }

  private lastInfo: ClaudeTimingInfo | null = null;
  private dispatchedAt: number | null = null;
  private t0 = 0;
  private dispatched(info: ClaudeTimingInfo): void { this.lastInfo = info; this.dispatchedAt = Math.round(performance.now() - this.t0); }

  /** One real user line, answered live through the app's pipeline; the line and her reply go into this conversation's archive. */
  async turn(line: { text: string; createdAt: number }): Promise<TurnRec> {
    const { engine, companion, settings } = this;
    engine.cap.take('reply');
    const mood = moodAt(engine.snapshot.moods, line.createdAt);
    if (mood) { companion.mood.setDeveloperMode(true); companion.mood.setTestMood(mood); }
    setPromptSwitches({ why: false, situation: false });
    const id = `i138-${this.setup.label}-${this.turnsDone + 1}-${randomUUID().slice(0, 8)}`;
    const settingTurn = settings.beginTurn(line.text);
    let liveVisible = '';
    const turn = await companion.begin(id, line.text, this.persona, (type, text) => { if (type === 'delta') liveVisible += text; }, { settingProposal: settingTurn });
    // The host's window from her archive: the real chat before the point plus this conversation's own turns, today + beforeDay, within windowMaxChars.
    const knobs = { ...LONG_CHAT_KNOBS, ...(engine.knobs ?? {}) };
    const window = buildLongChatWindow({ messages: [...engine.snapshot.messages.filter(message => message.createdAt < this.setup.point.at), ...this.archive],
      current: { content: line.text, createdAt: line.createdAt }, now: line.createdAt, knobs });
    const messages: ChatMessage[] = [...window.history, window.current!];
    this.lastInfo = null; this.dispatchedAt = null; this.t0 = performance.now();
    const t0 = this.t0;
    let firstChar: number | null = null, error: string | null = null;
    try {
      await this.chat.stream({
        kind: 'chat', model: engine.model, workingDirectory: this.directory, writable: false,
        get prompt() { return buildCodexChatPrompt(turn.persona, messages, null); },
        imageDataUrls: [], replyId: id,
        session: { key: companion.currentSpeechScope(), basePersona: this.persona, persona: turn.persona, openingContext: turn.relationshipOpening, openingKey: turn.relationshipTag,
          messages, language: null, data: () => null, shown: () => turn.shownReply?.() ?? null, ...(this.setup.note ? { openingNote: this.setup.note } : {}) },
      }, new AbortController().signal, (type, text) => {
        if (type === 'delta' && firstChar === null) firstChar = Math.round(performance.now() - t0);
        turn.push(type, text);
      });
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const endMs = Math.round(performance.now() - t0);
    await turn.finish(error ? 'error' : 'complete');
    if (!error) settings.offer(settingTurn.ticket, 1, id, turn.settingProposal?.());
    const text = liveVisible.trim();
    this.archive.push({ role: 'user', content: line.text, createdAt: line.createdAt });
    if (text) this.archive.push({ role: 'assistant', content: text, createdAt: line.createdAt + REPLY_GAP_MS });
    this.turnsDone++;
    const { usage, prompt } = this.tap.take();
    if (prompt && engine.promptDump) await engine.promptDump(`${this.setup.label}-${this.turnsDone}`, prompt);
    return {
      user: line.text, text, chars: Array.from(text).length, error, refused: error === CLAUDE_REFUSED_MESSAGE, firstCharMs: firstChar, endMs, dispatchMs: this.dispatchedAt,
      usage, promptChars: prompt?.length ?? null, opening: prompt ? ![CLAUDE_FOLLOW_UP_HEADER, FOLLOW_UP_HEADER.zh, FOLLOW_UP_HEADER.en].some(header => prompt.startsWith(header)) : false, sessionTurn: (this.lastInfo as ClaudeTimingInfo | null)?.sessionTurn ?? null, reuse: (this.lastInfo as ClaudeTimingInfo | null)?.reuse ?? null,
    };
  }

  /**
   * A copy for a branch: the same archive and the same host state (mood, memory, relationship: the folder is copied after a flush), a fresh
   * PersistentClaudeChat (no process yet). `mode` and `note` say how its process starts and what its opening carries.
   */
  async copy(options: { label: string; mode: ProcessMode; note: string | null; forkFrom?: string | null }): Promise<Conversation> {
    await this.companion.flush();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i138-'));
    await cp(this.directory, directory, { recursive: true });
    const copy = await Conversation.open(this.engine, { ...this.setup, directory, characterId: this.characterId, label: options.label, mode: options.mode, note: options.note,
      forkFrom: options.forkFrom ?? null, archive: this.archive.map(message => ({ ...message })), todayRounds: this.turnsDone });
    copy.turnsDone = this.turnsDone;
    copy.adoptIdentity(this);
    return copy;
  }

  /**
   * The copy is the same conversation as far as the chat session is concerned (its key is built from the companion's conversation id and
   * context generation): without this, a forked session adopted by the copy would be closed as "another context" on its first turn.
   * Since the switch lock (2026-11-23) the generation lives in the companion's ContextLock (electron/brain/context-lock.ts).
   */
  private adoptIdentity(from: Conversation): void {
    type Lock = { bumped?: unknown; committed?: unknown };
    const mine = this.companion as unknown as { conversation?: unknown; lock?: Lock };
    const theirs = from.companion as unknown as { conversation?: unknown; lock?: Lock };
    if (typeof theirs.conversation !== 'string' || typeof theirs.lock?.bumped !== 'number' || typeof theirs.lock.committed !== 'number' || !mine.lock)
      throw new Error('CompanionService 的内部结构变了（conversation / lock）。');
    mine.conversation = theirs.conversation; mine.lock.bumped = theirs.lock.bumped; mine.lock.committed = theirs.lock.committed;
  }

  async dispose(): Promise<void> {
    this.chat.dispose();
    await this.companion.flush().catch(() => {});
    await rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * C: a forked copy of the warm conversation, compacted once. The warm session was started with persistence on; this starts a second process
 * with `--resume <warm session id> --fork-session` and slash commands on, sends `/compact`, and hands the process to the copy's chat as its session
 * (same `known` messages, so the next turn is a follow-up the app's way). Returns the copy and what the compaction cost.
 */
export async function forkCompacted(engine: EngineOptions, warm: Conversation, label: string): Promise<{ conversation: Conversation; compaction: NonNullable<MomentState['compaction']> }> {
  const sessionId = warm.tap.sessionId;
  const session = peekSession(warm.chat);
  const conversation = await warm.copy({ label, mode: 'fork', note: warm.note, forkFrom: sessionId });
  engine.cap.take('compact');
  const started = performance.now();
  let ok = true, note = '';
  const process = await ClaudeChatProcess.start({ binary: engine.binary, ...(engine.binaryArgs ? { binaryArgs: engine.binaryArgs } : {}), model: engine.model,
    systemPrompt: claudeSessionSystemPrompt({ opening: APP_REPLY_OPENING === 'fixed' }), spawn: conversation.tap.spawn });
  try { await process.runTurn(claudeInput({ prompt: '/compact' }), new AbortController().signal, () => {}); }
  catch (error) {
    // Unverified for the real command: it may stream no text at all (an "empty answer"). That still means it ran; anything else does not.
    if (error instanceof ClaudeTurnError && error.incident === 'empty') note = '压缩命令没有输出文字（按已执行处理，待首次真实运行核对）';
    else { ok = false; note = error instanceof Error ? error.message.slice(0, 200) : String(error); }
  }
  const ms = Math.round(performance.now() - started);
  const taken = conversation.tap.take();
  if (!ok) { process.close('closed'); throw new Error(`C 组压缩失败：${note}`); }
  adoptSession(conversation.chat, session, process);
  return { conversation, compaction: { ok, ms, usage: taken.usage, note } };
}

// ---- notes and the reviewer -------------------------------------------------------------------------------------------------------------

export type Ask = (input: { system: string; prompt: string }) => Promise<string>;
/** The real tool-free call (the app's note writer path: streamClaude in a temp folder). Counts against the cap. */
export function claudeAsk(engine: Pick<EngineOptions, 'model' | 'binary' | 'binaryArgs' | 'cap'>, kind: string): Ask {
  return async ({ system, prompt }) => {
    engine.cap.take(kind);
    let text = '';
    await streamClaude({ kind: 'chat', model: engine.model, workingDirectory: os.tmpdir(), writable: false, prompt, systemPrompt: system },
      new AbortController().signal, (type, delta) => { if (type === 'delta') text += delta; }, engine.binary, engine.binaryArgs ?? []);
    if (!text.trim()) throw new Error(`${kind}调用没有返回文字。`);
    return text.trim();
  };
}
/** Offline note and review answers; they still count against the cap so a fake run proves the call counts. */
export function fakeAsk(cap: CallCap, kind: string, answer: (input: { system: string; prompt: string }) => string): Ask {
  return async input => { cap.take(kind); return answer(input); };
}

/** Her note as the app writes it: the first note, from all of the chat before the moment's day (the day starts at dayStartHour), in her voice. */
export async function writeNote(snapshot: Snapshot, point: PointSpec, persona: string, ask: Ask, dayStartHour = LONG_CHAT_KNOBS.dayStartHour): Promise<string> {
  const day = localDateKey(point.at - dayStartHour * 3_600_000);
  const cut = dayStartMs(day) + dayStartHour * 3_600_000;
  const before = markTimes(snapshot.messages.filter(message => message.createdAt < cut));
  if (before.length < 10) throw new Error(`点 ${point.id}：之前的聊天不足 10 条，写不了笔记。`);
  return ask({ system: FIRST_NOTE_INSTRUCTION, prompt: buildFirstNotePrompt(before, persona) });
}

// ---- one moment --------------------------------------------------------------------------------------------------------------------

export interface MomentOptions {
  settings: { warmup: number; next: number; review: boolean };
  seed: number;
  arms: readonly DriftArm[];
  askNote: Ask;
  askReview: Ask;
  /** Called whenever the moment's state changed (the caller writes it to disk so an interrupted run keeps what finished). */
  save?: (state: MomentState) => Promise<void>;
}

/** The warm-up user lines and the continuation lines of a moment: the point's own message and the next real user messages. */
export function momentLines(messages: readonly Timed[], index: number, warmup: number, next: number): { warm: Timed[]; next: Timed[] } {
  const users = messages.slice(index).filter(message => message.role === 'user');
  if (users.length < warmup + next) throw new Error(`这个时刻之后只有 ${users.length} 条用户消息，需要 ${warmup + next} 条。`);
  return { warm: users.slice(0, warmup), next: users.slice(warmup, warmup + next) };
}

const asLines = (recs: readonly TurnRec[]): Line[] => recs.map(rec => ({ user: rec.user, assistant: rec.text }));

export async function runMoment(engine: EngineOptions, point: PointSpec, options: MomentOptions): Promise<MomentState> {
  const { snapshot } = engine;
  const index = locatePoint(snapshot.messages, point);
  const lines = momentLines(snapshot.messages, index, options.settings.warmup, options.settings.next);
  const state: MomentState = { id: point.id, at: point.at, note: '', jokes: [], profile: { catchphrases: [], addresses: [] }, warm: [], arms: {}, compaction: null, review: null, done: false };
  const save = async () => { await options.save?.(state); };
  const log = engine.log ?? (() => {});
  const conversations: Conversation[] = [];
  try {
    state.note = await writeNote(snapshot, point, engine.card.persona, options.askNote);
    log(`  ${point.id} 笔记 ${Array.from(state.note).length} 字`);
    await save();
    const warm = await Conversation.open(engine, { point, index, note: state.note, mode: 'persisted', label: `${point.id}-warm` });
    conversations.push(warm);
    for (const line of lines.warm) {
      const rec = await warm.turn({ text: line.content, createdAt: line.createdAt });
      state.warm.push(rec);
      log(`  ${point.id} 热身 ${state.warm.length}/${lines.warm.length} ${rec.chars} 字 首字 ${rec.firstCharMs ?? '-'}ms${rec.error ? (rec.refused ? ' 被拒' : ' 出错') : ''}`);
      if (rec.error && !rec.refused) throw new Error(`热身出错：${rec.error}`);
      await save();
    }
    const earlier = snapshot.messages.filter(message => message.createdAt < point.at);
    state.jokes = extractJokes(asLines(state.warm), earlier.map(message => message.content));
    state.profile = styleProfile(earlier.filter(message => message.role === 'assistant').map(message => message.content));
    // All four arms branch from this one point. The branches are copied before any arm talks, so none sees another's turns.
    const branches = new Map<DriftArm, Conversation>();
    for (const arm of options.arms) {
      if (arm === 'W') continue;
      if (arm === 'C') {
        const forked = await forkCompacted(engine, warm, `${point.id}-C`);
        state.compaction = forked.compaction;
        branches.set('C', forked.conversation);
        log(`  ${point.id} C 压缩 ${forked.compaction.ms}ms${forked.compaction.note ? '（' + forked.compaction.note + '）' : ''}`);
      } else branches.set(arm, await warm.copy({ label: `${point.id}-${arm}`, mode: 'plain', note: arm === 'R' ? state.note : null }));
    }
    if (options.arms.includes('W')) branches.set('W', warm);
    conversations.push(...branches.values());
    await save();
    for (const arm of DRIFT_ARMS) {
      const conversation = branches.get(arm);
      if (!conversation) continue;
      const recs: TurnRec[] = state.arms[arm] = [];
      for (const line of lines.next) {
        const rec = await conversation.turn({ text: line.content, createdAt: line.createdAt });
        recs.push(rec);
        log(`  ${point.id} ${arm} ${recs.length}/${lines.next.length} ${rec.chars} 字 首字 ${rec.firstCharMs ?? '-'}ms${rec.opening ? ' 开场' : ''}${rec.error ? (rec.refused ? ' 被拒' : ' 出错') : ''}`);
        if (rec.error && !rec.refused) throw new Error(`${arm} 组出错：${rec.error}`);
        await save();
      }
    }
    if (options.settings.review) {
      const key = shuffleSegments(options.arms, options.seed ^ point.at);
      const segments = Object.fromEntries(Object.entries(key).map(([label, arm]) => [label, asLines(state.arms[arm] ?? [])]));
      const prompt = buildReviewPrompt({ persona: engine.card.persona, warm: asLines(state.warm.slice(-6)), segments });
      state.review = { key, promptChars: prompt.length, prompt, answer: null, error: null };
      try { state.review.answer = parseReview(await options.askReview({ system: REVIEW_INSTRUCTION, prompt })); }
      catch (error) { state.review.error = error instanceof Error ? error.message : String(error); }
      if (state.review.error && /调用上限|429|额度/u.test(state.review.error)) throw new Error(state.review.error);
      log(`  ${point.id} 第一道关：${state.review.answer ? state.review.answer.segments.filter(item => item.changed).length + ' 段有明显变化' : '回答解析失败'}`);
    }
    state.done = true;
    await save();
    return state;
  } finally {
    for (const conversation of new Set(conversations)) { engine.cwds?.push(...conversation.tap.cwds); await conversation.dispose(); }
  }
}

/** Saved transcripts of the persisted sessions (warm and forked): their Claude Code project folders, only those that match the experiment's own temp folders. */
export async function removeTranscripts(cwds: readonly string[], claudeHome: string): Promise<number> {
  const projects = path.join(claudeHome, 'projects');
  const present = new Set(await readdir(projects).catch(() => [] as string[]));
  let removed = 0;
  for (const cwd of cwds) {
    if (!/claude-chat[\\/]session-/u.test(cwd)) continue; // only the app-style throwaway session folders
    const name = path.resolve(cwd).replace(/[^A-Za-z0-9]/gu, '-');
    if (present.has(name)) { await rm(path.join(projects, name), { recursive: true, force: true }); removed++; }
  }
  return removed;
}
