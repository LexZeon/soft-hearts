import { createHash } from 'node:crypto';
import type { ChatMessage, StreamEvent } from '../shared/contracts';
import type { LanguageProfile } from '../shared/personalize-language';
import type { MemoryScope } from '../shared/memory';
import { CLAUDE_CHAT_SYSTEM_PROMPT, claudeInput, findClaude, simulatedClaudeFailure, streamClaude, type ClaudeTask } from './claude';
import { ClaudeChatProcess, ClaudeTurnError, type ClaudeProcessOptions } from './claude-process';
import { CLAUDE_SESSION_SYSTEM_PROMPT, composeSessionPrompt, planSessionTurn, sessionText } from './claude-session-prompt';

type Emit = (type: StreamEvent['type'], text: string) => void;

/**
 * Main switch for the conversation-scoped Claude Code process. Set to false (or
 * start the app with SOFT_HEARTS_CLAUDE_PERSISTENT=0) to go back to one
 * `claude -p` process per message, which stays fully supported and tested.
 */
export const PERSISTENT_CLAUDE_CHAT = true;
export function persistentClaudeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return PERSISTENT_CLAUDE_CHAT && env.SOFT_HEARTS_CLAUDE_PERSISTENT !== '0';
}

/** Close a session nobody has used for this long. */
export const CLAUDE_SESSION_IDLE_MS = 10 * 60_000;
/** Shorter limit while the pet window is hidden or minimised. */
export const CLAUDE_SESSION_HIDDEN_IDLE_MS = 3 * 60_000;
/**
 * A session is retired (and a fresh process pre-spawned) after this many turns
 * or characters, keeping each turn's input near today's 24-message window
 * instead of growing without bound.
 */
export const CLAUDE_SESSION_MAX_TURNS = 12;
export const CLAUDE_SESSION_MAX_CHARS = 60_000;

/** What the ordinary chat handler knows about this turn's conversation. */
export interface CompanionSessionInput {
  /** Accepted conversation identity (character, provider, conversation, generation). */
  key: string;
  /** The character persona as configured, before this turn's context was added. */
  basePersona: string;
  /** This turn's composed persona (fixed persona + mood, memories, protocol, ...). */
  persona: string;
  /** 熟悉度: the relationship lines that sit inside `persona`; sent with a session's opening message only (claude-session-prompt.ts withoutOpeningContext). */
  openingContext?: string;
  /** Changes when an open session must restart because those lines changed (switch, stage, nickname). */
  openingKey?: string;
  /** The renderer's history window; the last message is the current user message. */
  messages: readonly ChatMessage[];
  language?: LanguageProfile | null;
  /** Read once, at dispatch (user profile / visual data leases). */
  data?: () => string | null | undefined;
  /**
   * What the app showed of this turn's reply, once the turn has finished (null or undefined before): the bubble, the
   * archive and the chat window's history all keep exactly this text, after the reply protocol cut an internal draft,
   * repaired garbled text or dropped a leading "<br>" run (electron/mood-chat.ts). The session's record of the reply then
   * holds it instead of what Claude wrote, so the next window, built from what was shown, continues the same process
   * (docs/claude/2026-11-04-session-continuity-after-filter.md). Only the host that ran the turn can say it; unset, the
   * record keeps Claude's own output and a reply the protocol changed opens a fresh session, as before.
   */
  shown?: () => string | null | undefined;
}
export type CompanionClaudeTask = ClaudeTask & { replyId?: string; session?: CompanionSessionInput };

/** Optional per-turn hooks (R33 continuous voice). */
export interface ClaudeTurnControl {
  /**
   * The user message is in a conversation-scoped Claude process and its reply
   * is being generated; `supersede` asks Claude Code to stop it early (see
   * ClaudeChatProcess.supersede). Never called on the per-message path, where
   * stopping would lose the context the next message needs.
   */
  started?(supersede: () => boolean): void;
}
/** How a chat turn ended: `output` is every text delta delivered; `superseded` when supersede() stopped it early. */
export interface ClaudeTurnOutcome { superseded: boolean; output: string }

export interface ClaudeTimingInfo {
  mode: 'persistent' | 'per-message';
  /** cold: spawned for this turn; prewarmed: spawned earlier, first turn on it; warm: reused after a turn. */
  process: 'cold' | 'prewarmed' | 'warm';
  /** 1-based turn number inside this Claude process (0 for per-message). */
  sessionTurn: number;
}
/** Developer latency hooks (electron/reply-latency.ts). Never receives text. */
export interface ClaudeTimingObserver {
  dispatched(replyId: string, info: ClaudeTimingInfo): void;
  firstDelta(replyId: string): void;
}

export interface PersistentClaudeOptions {
  enabled?: boolean;
  /** Current provider, for pre-warming and for closing when it is no longer Claude. */
  provider?: () => { kind: string; model: string } | null | undefined;
  /** Whether this user has chatted before; pre-warming only happens then. */
  chattedBefore?: () => boolean;
  timing?: ClaudeTimingObserver;
  /**
   * Told how each chat turn ended, for the "chat is not available" state (electron/chat-availability.ts).
   * `success` after a turn that finished (also a superseded one); `failure` for a turn that threw, unless
   * the user stopped it. Both run for the persistent and the per-message path.
   */
  availability?: { success(): void; failure(error: unknown): void; quietFailure?<T extends object>(error: T): T };
  binary?: () => Promise<string>;
  /** Test seam only: arguments before Claude Code's own, for both paths (tests run a script through node). */
  binaryArgs?: readonly string[];
  /**
   * Model routing seam: which model serves this turn. Today it is always the
   * user's selected model; automatic routing would go here (a different model
   * means a different session).
   */
  selectModel?: (task: CompanionClaudeTask) => string;
  perMessage?: (task: ClaudeTask, signal: AbortSignal, emit: Emit, binary?: string, leadingArgs?: readonly string[]) => Promise<void>;
  /** Evaluation seam only (scripts/lib/fidelity-*.ts A/B): the persistent process's fixed system prompt. The app never sets it. */
  systemPrompt?: string;
  startProcess?: (options: ClaudeProcessOptions) => Promise<ClaudeChatProcess>;
  idleMs?: number;
  hiddenIdleMs?: number;
  interruptGraceMs?: number;
  turnTimeoutMs?: number;
  /** X2: see ClaudeProcessOptions.firstResponseTimeoutMs. */
  firstResponseTimeoutMs?: number;
  maxTurns?: number;
  maxChars?: number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?: (line: string) => void;
}

interface Session {
  key: string;
  process: ClaudeChatProcess;
  /** What Claude has been told or produced, in the renderer's terms (a reply as the app showed it, once the host said so). */
  known: ChatMessage[];
  /**
   * Each turn's place in `known`: its user message at `at`, then its reply when `output` (what Claude wrote) is not empty.
   * `shown` is the host's CompanionSessionInput.shown until it has answered; `text` is its answer, the reply in `known`.
   */
  log: { replyId?: string; at: number; user: string; output: string; shown?: () => string | null | undefined; text?: string }[];
  turns: number;
  chars: number;
}

const defaultTimers = {
  set: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** True when the current character already has saved chats (used only to decide pre-warming). */
export function companionHasHistory(companion: {
  currentScope(): MemoryScope; memory: { list(scope: MemoryScope, query: { limit: number }): { total: number } };
} | null | undefined): boolean {
  try { return !!companion && companion.memory.list(companion.currentScope(), { limit: 1 }).total > 0; }
  catch { return false; }
}

/**
 * Ordinary chat through one Claude Code process per conversation.
 *
 * - The process is reused across turns and closed on a new conversation,
 *   character/persona/model/provider change (a different key, or close()),
 *   idle timeout, app quit, or a context the session cannot line up with.
 * - A crash before any text restarts transparently once, on a fresh process
 *   that receives the whole history window again.
 * - Image turns and long sessions retire the session afterwards, so old screen
 *   frames do not stay in later turns' context; a fresh process is spawned
 *   right away so the next turn is still warm.
 * - Two process-level failures in a row switch the rest of this app run back to
 *   the per-message path.
 */
export class PersistentClaudeChat {
  private session: Session | null = null;
  private spare: ClaudeChatProcess | null = null;
  private spareStarting: Promise<ClaudeChatProcess | null> | null = null;
  private running = false;
  private degraded = false;
  private failures = 0;
  private chatted = false;
  private visible = true;
  private lastActivity = Date.now();
  private idleTimer: unknown = null;
  private disposed = false;
  /** Bumped by every close(): a turn that started before it belongs to the old context. */
  private generation = 0;
  private readonly timers: NonNullable<PersistentClaudeOptions['timers']>;
  private readonly enabled: boolean;

  constructor(private readonly options: PersistentClaudeOptions = {}) {
    this.timers = options.timers ?? defaultTimers;
    this.enabled = options.enabled ?? persistentClaudeEnabled();
  }

  /** Whether the next ordinary chat turn would use a persistent process. */
  get active(): boolean { return this.enabled && !this.degraded && !this.disposed; }

  async stream(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    try {
      const simulated = simulatedClaudeFailure();
      if (simulated) throw simulated; // Trial seam (electron/claude.ts); never set in normal use.
      const outcome = await this.route(task, signal, emit, control);
      try { this.options.availability?.success(); } catch { /* Reporting never affects the turn. */ }
      return outcome;
    } catch (error) {
      if (!signal.aborted) {
        try {
          // A refusal or an empty answer is a one-off, not an outage: she answers in her own words and chat stays available.
          const availability = this.options.availability;
          const incident = error && typeof error === 'object' ? (error as { incident?: unknown }).incident : undefined;
          if ((incident === 'refusal' || incident === 'empty') && availability?.quietFailure) availability.quietFailure(error as object);
          else availability?.failure(error);
        } catch { /* Same. */ }
      }
      throw error;
    }
  }

  private async route(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    if (!task.session || !this.active || this.running) return this.perMessage(task, signal, emit);
    this.running = true;
    this.chatted = true;
    this.clearIdle();
    try { return await this.persistent(task, task.session, signal, emit, control); }
    finally { this.running = false; this.touch(); }
  }

  /** Spawn a spare process now, if this user chats with Claude and none is ready. */
  prewarm(): void {
    if (!this.active || this.session?.process.alive || this.spare?.alive || this.spareStarting) return;
    let provider: ReturnType<NonNullable<PersistentClaudeOptions['provider']>>;
    try { provider = this.options.provider?.(); } catch { return; }
    if (!provider || provider.kind !== 'claude') return;
    let before = this.chatted;
    try { before ||= this.options.chattedBefore?.() === true; } catch { /* Not ready yet. */ }
    if (!before) return;
    void this.startSpare(provider.model.trim().slice(0, 160));
  }

  /** Pet window shown/restored (true) or hidden/minimised (false). */
  noteVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    if (visible) this.prewarm();
    if (!this.running) this.scheduleIdle();
  }

  /**
   * Close the conversation's process. On a context change (new conversation,
   * character, persona, model or provider) a spare that knows nothing is kept
   * or started for the next message when it still fits the provider; idle,
   * hidden, quit and degraded close everything.
   */
  close(reason = 'context'): void {
    this.generation++;
    this.closeSession(reason);
    if (reason !== 'context') { this.closeSpare(); this.clearIdle(); return; }
    let provider: ReturnType<NonNullable<PersistentClaudeOptions['provider']>>;
    try { provider = this.options.provider?.(); } catch { provider = null; }
    if (this.spare && (provider?.kind !== 'claude' || this.spare.model !== provider.model.trim().slice(0, 160))) this.closeSpare();
    this.prewarm();
    if (!this.running) this.scheduleIdle();
  }

  dispose(): void {
    this.close('quit');
    this.disposed = true;
  }

  /**
   * R33: the turns `replyIds` (one voice utterance, in order) are shown in chat
   * as `shown` = one user message with the whole utterance, then each reply
   * that showed text (shared/voice-conversation.ts voiceUtteranceMessages),
   * while Claude received them sentence by sentence. Rewrites this session's
   * record of exactly those turns to the shown form, so the next message (text
   * or voice), whose history window is what the app shows, lines up with the
   * warm process instead of opening a new one.
   *
   * Applied only when it is provably the same content: those turns are the
   * newest of the current session, back to back with nothing sent in between;
   * the user message is every sentence Claude received, in order; and each
   * shown reply is one Claude produced, in order. Otherwise nothing changes,
   * and a mismatch opens a fresh session exactly as before. Never by matching
   * text alone: only the host that ran these turns can ask for it.
   */
  regroup(replyIds: readonly string[], shown: readonly ChatMessage[]): boolean {
    const session = this.session;
    if (!session || this.running || !replyIds.length || shown[0]?.role !== 'user'
      || shown.slice(1).some(message => message.role !== 'assistant')) return false;
    this.settleShown(session);
    const turns = session.log.slice(-replyIds.length);
    if (turns.length !== replyIds.length || turns.some((turn, index) => !turn.replyId || turn.replyId !== replyIds[index])) return false;
    let at = turns[0].at;
    for (const turn of turns) { if (turn.at !== at) return false; at += turn.output ? 2 : 1; }
    if (at !== session.known.length) return false;
    if (shown[0].content !== turns.map(turn => turn.user).join('\n')) return false;
    const replies = turns.map(turn => sessionText(turn.text ?? turn.output)).filter(Boolean);
    const shownReplies = shown.slice(1).map(message => sessionText(message.content));
    if (shownReplies.length !== replies.length || shownReplies.some((reply, index) => reply !== replies[index])) return false;
    session.known.splice(turns[0].at, session.known.length - turns[0].at, ...shown.map(message => ({ role: message.role, content: message.content })));
    session.log.splice(session.log.length - turns.length, turns.length);
    return true;
  }

  private record(session: Session, replyId: string | undefined, history: readonly ChatMessage[], current: ChatMessage, output: string,
    shown?: CompanionSessionInput['shown']): void {
    session.known.push(...history);
    session.log.push({ ...(replyId ? { replyId } : {}), at: session.known.length, user: current.content, output, ...(shown ? { shown } : {}) });
    session.known.push(current, ...(output ? [{ role: 'assistant' as const, content: output }] : []));
  }

  /**
   * Puts each finished reply into `known` as the app showed it (CompanionSessionInput.shown), before the next window is
   * lined up or a voice utterance regrouped. Claude keeps what it wrote in its own context (a cut draft included); the app
   * never sends `known` anywhere, so a cut draft cannot come back as something she said. A turn whose host has not
   * answered yet keeps Claude's output and is asked again next time; an answer is final.
   */
  private settleShown(session: Session): void {
    for (const turn of session.log) {
      if (!turn.shown) continue;
      let text: string | null | undefined;
      try { text = turn.shown(); } catch { text = null; }
      if (typeof text !== 'string') continue;
      delete turn.shown;
      if (!turn.output) continue;
      turn.text = text;
      session.known[turn.at + 1] = { role: 'assistant', content: text };
    }
  }

  private log(line: string): void {
    try { (this.options.log ?? (value => console.info('[soft hearts] Claude session', value)))(line); } catch { /* Best effort. */ }
  }

  private async binary(): Promise<string> { return this.options.binary ? this.options.binary() : findClaude(); }

  private async perMessage(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit): Promise<ClaudeTurnOutcome> {
    // The task's own fields (and its prompt getter, read by the per-message adapter at dispatch)
    // pass through untouched. Only the system prompt is added, so ordinary chat carries the same
    // companion rules here as in the persistent process's fixed system prompt.
    const chatTask: ClaudeTask = task.systemPrompt === undefined
      ? Object.create(task, { systemPrompt: { value: CLAUDE_CHAT_SYSTEM_PROMPT, enumerable: true } }) : task;
    const replyId = task.replyId;
    let first = true, output = '';
    if (replyId) this.options.timing?.dispatched(replyId, { mode: 'per-message', process: 'cold', sessionTurn: 0 });
    const run = this.options.perMessage ?? streamClaude;
    await run(chatTask, signal, (type, text) => {
      if (type === 'delta') {
        if (first && replyId) { first = false; this.options.timing?.firstDelta(replyId); }
        output += text;
      }
      emit(type, text);
    }, this.options.binary ? await this.options.binary() : undefined, this.options.binaryArgs);
    return { superseded: false, output };
  }

  private async persistent(task: CompanionClaudeTask, input: CompanionSessionInput, signal: AbortSignal, emit: Emit,
    control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    if (task.kind !== 'chat' || task.writable) throw new Error('Claude 聊天通道只支持无工具的普通聊天。');
    const current = input.messages.at(-1);
    if (!current || current.role !== 'user') throw new Error('最后一条消息必须来自用户。');
    const history = input.messages.slice(0, -1);
    let images = task.imageDataUrls ?? [];
    claudeInput({ prompt: '.', imageDataUrls: images }); // Validate attachments before any process work.
    const model = (this.options.selectModel?.(task) ?? task.model).trim().slice(0, 160);
    const key = createHash('sha256').update(JSON.stringify(input.openingKey ? [input.key, input.basePersona, model, input.openingKey] : [input.key, input.basePersona, model])).digest('hex');
    const generation = this.generation;
    signal.throwIfAborted();
    // A cancelled or superseded turn may still be draining; the next message waits for it.
    await this.session?.process.settled();
    signal.throwIfAborted();
    let supersedeAsked = false;
    for (let attempt = 0; ; attempt++) {
      let session = this.session;
      if (session && (session.key !== key || !session.process.alive || session.process.busy))
        session = this.closeSession(session.key !== key ? 'context' : 'restart');
      // The previous replies as the app showed them, so a draft the protocol cut does not make the window look different.
      if (session) this.settleShown(session);
      let plan = session ? planSessionTurn(session.known, history) : null;
      if (session && !plan) session = this.closeSession('diverged');
      let processKind: ClaudeTimingInfo['process'] = 'warm';
      if (!session) {
        const acquired = await this.acquire(model);
        if (signal.aborted) { this.keepSpare(acquired.process); signal.throwIfAborted(); }
        // Closed (character, conversation, persona, model or provider changed) while the process was
        // starting: like a close mid-turn, this turn ends here instead of sending its old input (X-087).
        if (generation !== this.generation) {
          this.keepBlank(acquired.process);
          throw new ClaudeTurnError('这轮聊天所属的角色或对话已改变。', 'closed');
        }
        session = this.session = { key, process: acquired.process, known: [], log: [], turns: 0, chars: 0 };
        processKind = acquired.kind;
        plan = planSessionTurn(null, history);
      }
      const prompt = composeSessionPrompt({ plan: plan!, basePersona: input.basePersona, turnPersona: input.persona, openingContext: input.openingContext,
        current, profileContext: input.data?.(), language: input.language });
      // 关掉之后的旧帧: the frames (and `input.persona` above) are read again here, where the message is written, after a process
      // start or a previous turn's drain: electron/main.ts drops a shared frame whose sharing was turned off meanwhile.
      images = task.imageDataUrls ?? [];
      const line = claudeInput({ prompt, imageDataUrls: images });
      signal.throwIfAborted();
      let delivered = '';
      let first = true;
      if (task.replyId) this.options.timing?.dispatched(task.replyId, { mode: 'persistent', process: processKind, sessionTurn: session.turns + 1 });
      try {
        const chatProcess = session.process;
        const running = chatProcess.runTurn(line, signal, (type, text) => {
          if (type === 'delta') {
            if (first && task.replyId) { first = false; this.options.timing?.firstDelta(task.replyId); }
            delivered += text;
          }
          emit(type, text);
        });
        if (control?.started) {
          try { control.started(() => { supersedeAsked = true; return chatProcess.supersede(); }); }
          catch { /* A hook failure never affects the turn. */ }
        }
        const { output, superseded } = await running;
        // A superseded turn stays in Claude Code's context with what it streamed
        // (possibly nothing) and "[Request interrupted by user]".
        this.record(session, task.replyId, plan!.history, current, output, input.shown);
        session.turns++;
        session.chars += prompt.length + output.length;
        this.failures = 0;
        const maxTurns = this.options.maxTurns ?? CLAUDE_SESSION_MAX_TURNS, maxChars = this.options.maxChars ?? CLAUDE_SESSION_MAX_CHARS;
        if (images.length || session.turns >= maxTurns || session.chars >= maxChars) {
          this.closeSession(images.length ? 'image' : 'budget');
          void this.startSpare(model);
        }
        return { superseded, output };
      } catch (error) {
        if (signal.aborted) {
          // Claude Code keeps the interrupted message and what it streamed so
          // far; record what the user saw so the next window can line up.
          if (this.session === session && session.process.alive) {
            this.record(session, task.replyId, plan!.history, current, delivered, input.shown);
            session.turns++;
            if (images.length) this.closeSession('image');
          }
          throw error;
        }
        const kind = error instanceof ClaudeTurnError ? error.kind : 'failed';
        if (this.session === session) this.closeSession(`failure:${kind}`);
        // Never replay a turn the user has already added to: that would be a hidden second request.
        if (kind === 'crash' && !delivered && attempt === 0 && !supersedeAsked) continue;
        if (kind === 'crash' || kind === 'timeout') {
          if (++this.failures >= 2) {
            this.degraded = true;
            this.close('degraded');
            this.log('persistent session failed twice; using one process per message for the rest of this run');
          }
        }
        throw error;
      }
    }
  }

  private async acquire(model: string): Promise<{ process: ClaudeChatProcess; kind: 'cold' | 'prewarmed' }> {
    const starting = this.spareStarting;
    if (starting) await starting.catch(() => null);
    const spare = this.spare;
    this.spare = null;
    if (spare?.alive && !spare.busy && spare.model === model && !spare.turnsStarted) return { process: spare, kind: 'prewarmed' };
    spare?.close();
    return { process: await this.start(model), kind: 'cold' };
  }

  private async start(model: string): Promise<ClaudeChatProcess> {
    const binary = await this.binary();
    const options: ClaudeProcessOptions = { binary, model, systemPrompt: this.options.systemPrompt ?? CLAUDE_SESSION_SYSTEM_PROMPT,
      ...(this.options.binaryArgs ? { binaryArgs: this.options.binaryArgs } : {}),
      ...(this.options.interruptGraceMs !== undefined ? { interruptGraceMs: this.options.interruptGraceMs } : {}),
      ...(this.options.turnTimeoutMs !== undefined ? { turnTimeoutMs: this.options.turnTimeoutMs } : {}),
      ...(this.options.firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs: this.options.firstResponseTimeoutMs } : {}),
      ...(this.options.timers ? { timers: this.options.timers } : {}) };
    return (this.options.startProcess ?? ClaudeChatProcess.start)(options);
  }

  private startSpare(model: string): Promise<ClaudeChatProcess | null> {
    if (this.spareStarting) return this.spareStarting;
    const starting = this.start(model).then(process => {
      if (this.spareStarting === starting) this.spareStarting = null;
      if (this.disposed || !this.active) { process.close(); return null; }
      this.keepSpare(process);
      return process;
    }, () => { if (this.spareStarting === starting) this.spareStarting = null; return null; });
    this.spareStarting = starting;
    this.touch();
    return starting;
  }

  /** A process that was told nothing stays as the spare if it still fits the provider; otherwise it is closed. */
  private keepBlank(process: ClaudeChatProcess): void {
    let provider: ReturnType<NonNullable<PersistentClaudeOptions['provider']>>;
    try { provider = this.options.provider?.(); } catch { provider = null; }
    if (this.disposed || !this.active || provider?.kind !== 'claude' || process.model !== provider.model.trim().slice(0, 160) || process.turnsStarted) {
      process.close();
      return;
    }
    this.keepSpare(process);
  }

  private keepSpare(process: ClaudeChatProcess): void {
    if (this.spare && this.spare !== process) this.spare.close();
    this.spare = process;
  }

  private closeSession(reason: string): null {
    const session = this.session;
    this.session = null;
    if (session) {
      session.process.close('closed');
      this.log(`closed (${reason}) after ${session.turns} turn(s)`);
    }
    return null;
  }

  private closeSpare(): void {
    this.spare?.close();
    this.spare = null;
    // A spare still starting closes itself once it sees there is no use for it.
    if (this.spareStarting) void this.spareStarting.then(process => { if (process && this.spare === process && !this.session) { process.close(); this.spare = null; } });
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.scheduleIdle();
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.disposed || (!this.session && !this.spare && !this.spareStarting)) return;
    const limit = this.visible ? this.options.idleMs ?? CLAUDE_SESSION_IDLE_MS : this.options.hiddenIdleMs ?? CLAUDE_SESSION_HIDDEN_IDLE_MS;
    const wait = Math.max(0, this.lastActivity + limit - Date.now());
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = null;
      if (this.running) return;
      this.close(this.visible ? 'idle' : 'hidden');
    }, wait);
  }
}
