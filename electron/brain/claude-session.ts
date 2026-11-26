import { createHash } from 'node:crypto';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { StreamEvent } from '../../shared/brain/stream-event';
import type { MemoryScope } from '../../shared/memory';
import { claudeChatSystemPrompt, claudeInput, findClaude, simulatedClaudeFailure, streamClaude, type ClaudeTask } from './claude';
import { ClaudeChatProcess, ClaudeTurnError, type ClaudeProcessOptions } from './claude-process';
import { claudeSessionSystemPrompt, composePreparedOpening, composeSessionPrompt, explainDivergence, planSessionTurn, sessionText } from './claude-session-prompt';
import { sessionIdleRule } from './claude-session-idle';
import type { FirstCharReuse, SpareWhy } from '../../shared/brain/journal-entries';
import { VOICE_CALL_KNOBS } from '../../shared/voice';
import type { LongChatKnobs } from '../../shared/behaviors/long-chat/knobs';
import { PREWARM_DELAY_MS, PREWARM_TIMEOUT_MS, warmOpening, type SessionRestartEntry } from './long-chat/prewarm';
import { RestartTelemetry } from './long-chat/restart-telemetry';
import { StartWarmer, type StartOpeningInput } from './long-chat/start-warm';
import { planOnceLines, type OnceLine, type OpeningMemory, type RelaxedChat } from './i139-chat';
import { callGlanceKnobs, glancesMustGo, glanceTag, HeldGlances, keepsGlances, pastGlancesLine, readGlanceMark, type CallGlanceKnobs } from './call-glances';
import { continuable, extendReply, forgetReplyOutput, recordTurn, regroupTurns, settleShownTurns, type SessionLogTurn } from './claude-session-log';

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
/** Shorter limit while the companion window is hidden or minimised. */
export const CLAUDE_SESSION_HIDDEN_IDLE_MS = 3 * 60_000;
/**
 * A session is retired (and a fresh process pre-spawned) after this many turns
 * or characters, keeping each turn's input near today's 24-message window
 * instead of growing without bound.
 */
export const CLAUDE_SESSION_MAX_TURNS = 12;
export const CLAUDE_SESSION_MAX_CHARS = 60_000;
/**
 * I-091 step 4: while a call holds the process warm (holdWarm) it is retired after this many turns instead, so turn 13 of a call
 * does not pay a new process (~0.7 s, docs/claude/2026-11-12-i091-experiment-1.md). The character budget and every other
 * retire rule stay; after the call the ordinary cap applies again from the next check. Same number as the knob in
 * shared/behaviors/voice-call/knobs.ts (session.maxTurns), which tests and tuning change.
 */
export const CLAUDE_CALL_SESSION_MAX_TURNS = VOICE_CALL_KNOBS.session.maxTurns;

import type { ClaudeTimingInfo, ClaudeTimingObserver, ClaudeTurnControl, ClaudeTurnOutcome, CompanionClaudeTask, CompanionSessionInput } from './claude-session-types';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';
import { chatModelTurn } from './chat-model-fallback';
export type { ClaudeTimingInfo, ClaudeTimingObserver, ClaudeTurnControl, ClaudeTurnOutcome, CompanionClaudeTask, CompanionSessionInput, RefusalFallback } from './claude-session-types';

export interface PersistentClaudeOptions {
  enabled?: boolean;
  /** Current provider, for pre-warming and for closing when it is no longer Claude. */
  provider?: () => { kind: string; model: string } | null | undefined;
  /** Whether this user has chatted before; pre-warming only happens then. */
  chattedBefore?: () => boolean;
  /** Free prewarm (docs/claude/2026-11-22-prewarm-free.md): a spare is spawned whenever asked, without the chattedBefore gate (the pool's slots; a plain build keeps it). */
  prewarmAlways?: boolean;
  /** Told once for each spare a prewarm trigger spawned and kept (a closed word, no text); not for the spares after a turn or a restart. */
  onSpare?: (why: SpareWhy) => void;
  timing?: ClaudeTimingObserver;
  /**
   * Told how each chat turn ended, for the "chat is not available" state (electron/brain/chat-availability.ts).
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
  /** She is on screen though her companion window is hidden (out in full-screen Unbound): the idle limit stays idleMs (claude-session-idle.ts). */
  seenElsewhere?: () => boolean;
  interruptGraceMs?: number;
  turnTimeoutMs?: number;
  /** X2: see ClaudeProcessOptions.firstResponseTimeoutMs. */
  firstResponseTimeoutMs?: number;
  maxTurns?: number;
  /** I-091 step 4: the cap while a call holds the process warm (default CLAUDE_CALL_SESSION_MAX_TURNS). */
  callMaxTurns?: number;
  maxChars?: number;
  /**
   * I-134 new chat (shared/behaviors/long-chat/knobs.ts), resolved by the app; unset or `enabled: false` is today's behaviour. On:
   * ordinary chat has no turn cap (a call keeps callMaxTurns), a session retires at `sessionMaxChars` instead of maxChars and the
   * next turn reopens with the host's window, a refusal or an empty answer keeps the warm session, and a task's refusalFallback runs.
   */
  longChat?: LongChatKnobs | null;
  /**
   * Prewarm (docs/claude/2026-11-15-prewarm-restart.md), used only while longChat is on and longChat.restartPrepareAt > 0: her
   * archive's window at this moment (what the next turn's window would hold before its own message), read while she is idle to
   * prepare the replacement session's opening. Unset: no preparation, the restart is cold as before.
   */
  openingWindow?: () => readonly ChatMessage[] | null | undefined;
  /** I-139 A3: the opening memory as it is now, read when a replacement's opening is assembled (so a handoff's newer pick is used). Unset: the last turn's. */
  openingMemory?: () => { date: string; text: string } | null | undefined;
  /** I-139 A3: a new Claude process for her chat was created (cold start, prepared replacement installed). Fire and forget; never awaited. */
  onNewProcess?: () => void;
  /** Prewarm dev telemetry: one entry per restart for the budget (numbers and closed words only). */
  restartLog?: (entry: SessionRestartEntry) => void;
  /**
   * The paid prewarm step (docs/claude/2026-11-23-prewarm-paid.md, longChat on and longChat.startWarmMinGapMs > 0): the opening for the character on stage as it is
   * now (persona, relationship lines, her note, her archive's window), read when a spare comes up for 'start' or 'switch'. Unset: no warm.
   */
  startOpening?: () => StartOpeningInput | null | undefined;
  /** Test seams: wait after her reply before preparing (PREWARM_DELAY_MS), the hidden request's limit (PREWARM_TIMEOUT_MS), the clock. */
  prepareDelayMs?: number;
  warmTimeoutMs?: number;
  now?: () => number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?: (line: string) => void;
  /** I-161 A (electron/brain/call-glances.ts): whether a call's small frames stay in the process, and how many. Default: CALL_LOOK. */
  callGlances?: CallGlanceKnobs;
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
  log: SessionLogTurn[];
  turns: number;
  chars: number;
  /** Prewarm: the fixed parts of the latest turn's input, for a replacement's opening (I-139: and its layers, while the switch is on). */
  opening?: { basePersona: string; openingContext: string | null; openingKey?: string; openingNote: string | null; relaxed?: RelaxedChat | null; openingMemory?: OpeningMemory };
  /** I-139: what this process has been told of the once-lines (key → its stable part); a new Session starts empty. */
  told?: Map<string, string>;
  /** Prewarm: a replacement for this session was prepared (or tried): at most once, so at most one hidden request per restart. */
  prepareTried?: boolean;
  /** Prewarm: an installed replacement that has not been written to yet; its prepared opening goes in front of the first turn. */
  preface?: string;
  /** Prewarm: an installed replacement's first turn reports this process kind and reuse reason (ClaudeTimingInfo). */
  fresh?: FirstCharReuse;
  /** I-161 A: the small 「发图片」 frames of a call this process holds (a count and checks, no picture). */
  glances?: HeldGlances;
  /** The relationship tag (CompanionSessionInput.openingKey) whose lines this process heard last; a follow-up under another tag carries them once. */
  relationTag?: string;
}

/**
 * Prewarm: a replacement for `replaces`, prepared while she was idle: a blank process (`ready`), the opening built from her archive at
 * that moment (`opening`, holding `known`), and the hidden request that cached it (`warm`). Installed by switchTo (idle, after a
 * reply, once warmed) or takePrepared (the next turn, after the old session retired anyway); dropped by close() and anything stale.
 */
interface Prepared {
  generation: number;
  key: string;
  model: string;
  replaces: Session;
  known: ChatMessage[];
  opening: string;
  ready: Promise<ClaudeChatProcess | null>;
  process: ClaudeChatProcess | null;
  warmer: ClaudeChatProcess | null;
  warm: SessionRestartEntry['warm'];
  dropped: boolean;
  relationTag?: string;
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
 * - Long sessions, and picture turns whose frames may not stay (call-glances.ts:
 *   I-161 A / I-166 / I-168), retire the session afterwards; a fresh process is
 *   spawned right away so the next turn is still warm.
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
  private lastActivity = 0;
  private idleTimer: unknown = null;
  private disposed = false;
  /** I-091: a call is on (holdWarm). */
  private held = false;
  /** I-161 A: bumped by every call that starts (held small frames belong to one call only). */
  private call = 0;
  /** Why the last conversation process ended, until the next one starts (ClaudeTimingInfo.reuse). */
  private lastEnded: FirstCharReuse | null = null;
  /** Bumped by every close(): a turn that started before it belongs to the old context. */
  private generation = 0;
  /** Prewarm (see Prepared). */
  private prepared: Prepared | null = null;
  private prepareTimer: unknown = null;
  private readonly telemetry: RestartTelemetry<Session>;
  /** The paid prewarm step (see StartWarmer); null without a startOpening. */
  private readonly startWarm: StartWarmer | null = null;
  private readonly timers: NonNullable<PersistentClaudeOptions['timers']>;
  private readonly enabled: boolean;

  constructor(private readonly options: PersistentClaudeOptions = {}) {
    this.timers = options.timers ?? defaultTimers;
    this.lastActivity = this.now();
    this.enabled = options.enabled ?? persistentClaudeEnabled();
    this.telemetry = new RestartTelemetry({ log: () => options.restartLog, enabled: () => options.longChat?.enabled === true, now: () => this.now() });
    if (options.startOpening) this.startWarm = new StartWarmer({ input: options.startOpening, minGapMs: () => (options.longChat?.enabled ? options.longChat.startWarmMinGapMs : 0),
      startWarmer: (model, directory) => this.start(model, directory), blocked: () => this.running || this.held || this.disposed || !this.active, now: () => this.now(),
      timers: this.timers, ...(options.warmTimeoutMs !== undefined ? { timeoutMs: options.warmTimeoutMs } : {}), log: line => this.log(line) });
  }

  /** Whether the next ordinary chat turn would use a persistent process. */
  get active(): boolean { return this.enabled && !this.degraded && !this.disposed; }
  /** I-186 (session-pool/pool.ts): it holds a process (its conversation's, a spare, one starting, a prepared replacement); the cap counts it. */
  get warm(): boolean { return !!(this.session?.process.alive || this.spare?.alive || this.spareStarting || this.prepared); }
  /** 2026-11-26: the model id Claude Code reported for the process holding her conversation (diagnostic; null before any turn ran on it, or when none). */
  get reportedModel(): string | null { return this.session?.process.reportedModel ?? this.spare?.reportedModel ?? null; }
  /** I-186: a turn is running on it (the cap never closes it). */
  get busy(): boolean { return this.running; }

  async stream(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    try {
      const simulated = simulatedClaudeFailure();
      if (simulated) throw simulated; // Trial seam (electron/brain/claude.ts); never set in normal use.
      const outcome = await chatModelTurn(task.model, signal, emit, () => this.routeWithFallback(task, signal, emit, control), () => this.close('model')); // I-222
      try { this.options.availability?.success(); } catch { /* Reporting never affects the turn. */ }
      this.idleSwitch(); // Prewarm: right after her reply, while the cache the hidden request made is fresh.
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

  /**
   * I-134 step 4. Off (no longChat, or no refusalFallback on the task): route() exactly as before. On, a refusal or an empty answer:
   *  - the window already shows some of the reply: keep it; the turn completes with that text and no "she failed" line;
   *  - nothing shown yet, the turn still current: one immediate per-message retry with the short window, into the same turn;
   *  - anything else (stopped, another conversation, another kind of failure, the retry failing too): the error, as before.
   * Archive-once and reward-once stay with the host's turn (CompanionService), which still finishes exactly once.
   */
  private async routeWithFallback(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    const fallback = this.options.longChat?.enabled ? task.refusalFallback : undefined;
    if (!fallback) return this.route(task, signal, emit, control);
    let emitted = '';
    const tracked: Emit = (type, text) => { if (type === 'delta') emitted += text; emit(type, text); };
    try { return await this.route(task, signal, tracked, control); }
    catch (error) {
      const incident = error && typeof error === 'object' ? (error as { incident?: unknown }).incident : undefined;
      if (signal.aborted || (incident !== 'refusal' && incident !== 'empty')) throw error;
      let visible: boolean;
      try { visible = fallback.visible ? fallback.visible() : !!sessionText(emitted); } catch { visible = !!sessionText(emitted); }
      if (visible) {
        try { fallback.noted?.('refusal-kept'); } catch { /* The log never changes the turn. */ }
        return { superseded: false, output: emitted };
      }
      let current = false;
      try { current = fallback.current(); } catch { current = false; }
      if (!current) throw error;
      // The session keeps the refused turn's user message; the reply she gives now reaches it with the next turn's new history.
      this.forgetReply(task.replyId);
      try { fallback.noted?.('refusal-fallback'); } catch { /* Same. */ }
      const short = Object.create(task, {
        prompt: { get: () => fallback.prompt(), enumerable: true },
        session: { value: undefined, enumerable: true },
        replyId: { value: undefined, enumerable: true }, // the latency hooks measured this turn once already
      }) as CompanionClaudeTask;
      return await this.perMessage(short, signal, emit);
    }
  }

  /** The refused turn's partial reply (never shown) leaves the session's record, so the reply that replaces it is sent as new. */
  private forgetReply(replyId: string | undefined): void { forgetReplyOutput(this.session, replyId); }

  private async route(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit, control?: ClaudeTurnControl): Promise<ClaudeTurnOutcome> {
    if (!task.session || !this.active || this.running) return this.perMessage(task, signal, emit);
    this.running = true;
    this.chatted = true;
    this.clearIdle();
    try { return await this.persistent(task, task.session, signal, emit, control); }
    finally { this.running = false; this.touch(); }
  }

  /** Spawn a spare process now, if this user chats with Claude and none is ready (`why` goes in the journal row of a spare it spawns). */
  prewarm(why: SpareWhy = 'context'): void {
    if (!this.active || this.session?.process.alive || this.prepared) return;
    if (this.spare?.alive) { this.startWarm?.begin(why, this.spare); return; } // a spare is up: 'start' / 'switch' may warm it (StartWarmer)
    if (this.spareStarting) return;
    let provider: ReturnType<NonNullable<PersistentClaudeOptions['provider']>>;
    try { provider = this.options.provider?.(); } catch { return; }
    if (!provider || provider.kind !== 'claude') return;
    let before = this.chatted || this.options.prewarmAlways === true;
    try { before ||= this.options.chattedBefore?.() === true; } catch { /* Not ready yet. */ }
    if (!before) return;
    void this.startSpare(provider.model.trim().slice(0, 160), why);
  }

  /** Companion window shown/restored (true) or hidden/minimised (false). I-186 `fromNow`: switched away, not seen from this moment on. */
  noteVisible(visible: boolean, fromNow = false, why: SpareWhy = 'visible'): void {
    if (this.disposed) return;
    this.visible = visible;
    if (fromNow) this.lastActivity = this.now();
    if (fromNow && !visible) this.startWarm?.cancel(true); // switched away: a warm still pending is dropped (a newer trigger is for the new character)
    if (visible) this.prewarm(why);
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
    this.clearPrepareTimer();
    this.startWarm?.cancel(); // the warmed opening holds her window: any close forgets it (a deleted chat stays nowhere)
    // A prepared replacement belongs to the old context; its blank process may still serve as the spare on a context change.
    this.dropPrepared(reason === 'context');
    this.closeSession(reason);
    this.telemetry.flush();
    if (reason !== 'context') { this.closeSpare(); this.clearIdle(); return; }
    let provider: ReturnType<NonNullable<PersistentClaudeOptions['provider']>>;
    try { provider = this.options.provider?.(); } catch { provider = null; }
    if (this.spare && (provider?.kind !== 'claude' || this.spare.model !== provider.model.trim().slice(0, 160))) this.closeSpare();
    this.prewarm('context');
    if (!this.running) this.scheduleIdle();
  }

  dispose(): void {
    this.close('quit');
    this.disposed = true;
  }

  /**
   * R33: the turns `replyIds` (one voice utterance, in order) are shown in chat
   * as `shown` = one user message with the whole utterance, then each reply
   * that showed text (shared/voice/voice-conversation.ts voiceUtteranceMessages),
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
    return !!session && !this.running && regroupTurns(session, replyIds, shown);
  }

  private record(session: Session, replyId: string | undefined, history: readonly ChatMessage[], current: ChatMessage, output: string,
    shown?: CompanionSessionInput['shown']): void { recordTurn(session, replyId, history, current, output, shown); }

  /** The replies as the app showed them (claude-session-log.ts settleShownTurns). */
  private settleShown(session: Session): void { settleShownTurns(session); }

  /**
   * I-166 (docs/claude/2026-11-21-i166-see-and-say.md): her closer look. Right after the turn `task.replyId` ended, one more message (the
   * private note and the clear picture, both read here, where it is written) goes to the same warm process and its reply streams into
   * the same turn: the record stays one turn and one reply (the host archives it once). Null when there is nothing to continue: no warm
   * process, another turn since, a process busy or closed, or small frames it holds that may no longer be seen. Never the per-message
   * path, never a retry, never the availability state (a failed continuation is not an outage). Its picture stays like a kept frame when its
   * mark says so (I-168), else retires the process (call-glances.ts); a stopped one is recorded like any stopped turn.
   */
  async continueReply(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit): Promise<ClaudeTurnOutcome | null> {
    const session = this.session;
    if (!this.active || this.running || !session || !session.process.alive || session.process.busy || !continuable(session, task.replyId)
      || glancesMustGo(session.glances, this.held, this.call)) return null;
    if (task.kind !== 'chat' || task.writable) throw new Error(`${ASSISTANT_NAME} 聊天通道只支持无工具的普通聊天。`);
    signal.throwIfAborted();
    const images = task.imageDataUrls ?? [], prompt = task.prompt, glance = images.length ? readGlanceMark(task.callGlance) : null;
    const line = claudeInput({ prompt, imageDataUrls: images });
    this.running = true;
    this.clearIdle();
    let delivered = '', kept = false;
    try {
      const running = session.process.runTurn(line, signal, (type, text) => { if (type === 'delta') delivered += text; emit(type, text); });
      kept = !!glance && this.keepGlances(session, glance, images.length);
      const { output, superseded } = await running;
      extendReply(session, task.replyId, output);
      session.turns++;
      session.chars += prompt.length + output.length;
      if ((images.length && !kept) || glancesMustGo(session.glances, this.held, this.call)) this.retire(session, 'image', session.process.model);
      return { superseded, output };
    } catch (error) {
      if (this.session === session) {
        if (signal.aborted && session.process.alive) { extendReply(session, task.replyId, delivered); session.turns++; if (images.length && !kept) this.closeSession('image'); }
        else if (!signal.aborted) this.closeSession('failure:continue');
      }
      throw error;
    } finally { this.running = false; this.touch(); }
  }

  private log(line: string): void {
    try { (this.options.log ?? (value => console.info(`[soft hearts] ${ASSISTANT_NAME} session`, value)))(line); } catch { /* Best effort. */ }
  }

  private async binary(): Promise<string> { return this.options.binary ? this.options.binary() : findClaude(); }

  private async perMessage(task: CompanionClaudeTask, signal: AbortSignal, emit: Emit): Promise<ClaudeTurnOutcome> {
    // The task's own fields (and its prompt getter, read by the per-message adapter at dispatch)
    // pass through untouched. Only the system prompt is added, so ordinary chat carries the same
    // companion rules here as in the persistent process's fixed system prompt.
    const chatTask: ClaudeTask = task.systemPrompt === undefined
      ? Object.create(task, { systemPrompt: { value: claudeChatSystemPrompt(), enumerable: true } }) : task;
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
    if (task.kind !== 'chat' || task.writable) throw new Error(`${ASSISTANT_NAME} 聊天通道只支持无工具的普通聊天。`);
    const current = input.messages.at(-1);
    if (!current || current.role !== 'user') throw new Error('最后一条消息必须来自用户。');
    const history = input.messages.slice(0, -1);
    let images = task.imageDataUrls ?? [];
    claudeInput({ prompt: '.', imageDataUrls: images }); // Validate attachments before any process work.
    const model = (this.options.selectModel?.(task) ?? task.model).trim().slice(0, 160);
    // 2026-11-25 (docs/claude/2026-11-25-first-turn-empty.md): the relationship tag is not in the key. Since I-210 the stage moves on the 3rd round
    // of a crossing day (day 1 included), and that restarted her process mid-chat; the new lines now ride on the next follow-up instead (below).
    const key = createHash('sha256').update(JSON.stringify([input.key, input.basePersona, model])).digest('hex');
    const generation = this.generation;
    signal.throwIfAborted();
    // A cancelled or superseded turn may still be draining; the next message waits for it.
    await this.session?.process.settled();
    signal.throwIfAborted();
    let supersedeAsked = false;
    for (let attempt = 0; ; attempt++) {
      let session = this.session;
      // I-161 A: small frames held from earlier sentences that may no longer be seen (hang-up, "别看", a switch off): a new process first.
      if (session && glancesMustGo(session.glances, this.held, this.call)) session = this.closeSession('image');
      if (session && (session.key !== key || !session.process.alive || session.process.busy))
        session = this.closeSession(session.key !== key ? 'context' : 'restart');
      // The previous replies as the app showed them, so a draft the protocol cut does not make the window look different.
      if (session) this.settleShown(session);
      // Prewarm: the session closed (budget, failure, ...) while a replacement was prepared for it: the replacement takes this turn.
      if (!session && this.prepared) {
        session = await this.takePrepared(key, model);
        signal.throwIfAborted();
        if (generation !== this.generation) throw new ClaudeTurnError('这轮聊天所属的角色或对话已改变。', 'closed');
      }
      let plan = session ? planSessionTurn(session.known, history) : null;
      if (session && !plan && session.preface !== undefined && !session.process.turnsStarted) {
        // A prepared opening that does not line up with this window: the blank process opens the usual way instead (nothing lost).
        this.log('prepared opening did not line up; opening with the whole window');
        session.preface = undefined;
        session.known = [];
        plan = planSessionTurn(null, history);
      }
      if (session && !plan) session = this.closeSession('diverged', `diverged-${explainDivergence(session.known, history)}`);
      let processKind: ClaudeTimingInfo['process'] = 'warm';
      let reuse: FirstCharReuse = 'warm';
      let openingContext: string | null | undefined = input.openingContext;
      if (session?.fresh) { processKind = 'prewarmed'; reuse = session.fresh; delete session.fresh; }
      if (session && session.relationTag !== undefined && session.relationTag !== (input.openingKey ?? '')) openingContext = null;
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
        reuse = this.lastEnded ?? 'first';
        this.lastEnded = null;
        plan = planSessionTurn(null, history);
        // The paid prewarm step: this spare was warmed (or the user wrote first): a warmed one opens with the cached opening as block 1.
        const warm = this.startWarm?.adopt(acquired.process, input, history);
        if (warm) {
          this.telemetry.noteStartWarm(warm.why, warm.status);
          if (warm.use) { session.known = warm.use.known; session.preface = warm.use.opening; plan = warm.use.plan; openingContext = warm.use.openingContext; }
        }
        this.noteNewProcess();
      }
      // I-139: the persona first, then its once-lines (read right after it, so they describe the same frames); a line this process
      // was told already, unchanged, on a turn without a picture, is left out (electron/brain/i139-chat.ts planOnceLines).
      // I-161 A: a process holding earlier small frames hears which picture is now (the voice host's line, in her language).
      const pictured = (task.imageDataUrls ?? []).length > 0;
      const turnPersona = input.persona + pastGlancesLine(session.glances, task.callGlance, pictured);
      let onceLines: readonly OnceLine[] = [];
      if (input.onceLines) { try { onceLines = input.onceLines() ?? []; } catch { onceLines = []; } }
      const once = onceLines.length ? planOnceLines(session.told ?? new Map(), onceLines, pictured) : null;
      const prompt = composeSessionPrompt({ plan: plan!, basePersona: input.basePersona, turnPersona, openingContext,
        current, profileContext: input.data?.(), language: input.language, ...(input.openingNote ? { openingNote: input.openingNote } : {}),
        ...(input.relaxed ? { relaxed: input.relaxed, openingMemory: input.openingMemory ?? null } : {}), ...(once?.swaps.length ? { onceSwaps: once.swaps } : {}) });
      // 关掉之后的旧帧: the frames (and `input.persona` above) are read again here, where the message is written, after a process
      // start or a previous turn's drain: electron/main.ts drops a shared frame whose sharing was turned off meanwhile.
      images = task.imageDataUrls ?? [];
      const glance = images.length ? readGlanceMark(task.callGlance) : null; // I-161 A: read with the frames
      // Prewarm: a prepared session's first message carries its opening as a separate first block (the cached prefix), then this turn.
      const preface = session.preface;
      const line = claudeInput({ prompt, imageDataUrls: images, ...(preface ? { preface } : {}) });
      signal.throwIfAborted();
      let delivered = '';
      let first = true;
      const sent = prompt.length + (preface?.length ?? 0);
      const restart = this.telemetry.forSession(session, preface !== undefined);
      let kept = false;
      if (task.replyId) this.options.timing?.dispatched(task.replyId, { mode: 'persistent', process: processKind, sessionTurn: session.turns + 1, inputChars: sent, sessionChars: session.chars, reuse, image: images.length > 0 });
      try {
        const chatProcess = session.process;
        const running = chatProcess.runTurn(line, signal, (type, text) => {
          if (type === 'delta') {
            if (first && task.replyId) { first = false; this.options.timing?.firstDelta(task.replyId, chatProcess.reportedModel ?? undefined); }
            if (restart && restart.firstCharMs === null && restart.dispatchedAt !== null) restart.firstCharMs = Math.max(0, this.now() - restart.dispatchedAt);
            delivered += text;
          }
          emit(type, text);
        });
        session.preface = undefined; // Written: from now on the process knows its opening.
        session.relationTag = input.openingKey ?? ''; // and these relationship lines (the opening, or a follow-up that carried them)
        kept = !!glance && this.keepGlances(session, glance, images.length); // I-161 A: small frames of a call stay; any other picture retires
        if (once?.tell.length) { const told = session.told ??= new Map(); for (const [key, stable] of once.tell) told.set(key, stable); } // I-139: and these lines
        if (control?.started) {
          try { control.started(() => { supersedeAsked = true; return chatProcess.supersede(); }); }
          catch { /* A hook failure never affects the turn. */ }
        }
        const { output, superseded } = await running;
        // A superseded turn stays in Claude Code's context with what it streamed
        // (possibly nothing) and "[Request interrupted by user]".
        this.record(session, task.replyId, plan!.history, current, output, input.shown);
        session.turns++;
        session.chars += sent + output.length;
        this.failures = 0;
        if (restart) this.telemetry.flush(session);
        const { maxTurns, maxChars } = this.budget();
        const pictures = (images.length > 0 && !kept) || glancesMustGo(session.glances, this.held, this.call);
        if (pictures || session.turns >= maxTurns || session.chars >= maxChars) this.retire(session, pictures ? 'image' : 'budget', model);
        else this.afterTurn(session, input);
        return { superseded, output };
      } catch (error) {
        if (restart) this.telemetry.flush(session);
        if (signal.aborted) {
          // Claude Code keeps the interrupted message and what it streamed so
          // far; record what the user saw so the next window can line up.
          if (this.session === session && session.process.alive) {
            this.record(session, task.replyId, plan!.history, current, delivered, input.shown);
            session.turns++;
            if ((images.length && !kept) || glancesMustGo(session.glances, this.held, this.call)) this.closeSession('image');
          }
          throw error;
        }
        const kind = error instanceof ClaudeTurnError ? error.kind : 'failed';
        // I-134 step 4: a refusal or an empty answer is about this one reply, not the process: the warm session stays, with the
        // turn recorded as Claude Code keeps it (the user message and whatever it streamed), so the next window still lines up.
        const incident = error instanceof ClaudeTurnError ? error.incident : undefined;
        if (this.options.longChat?.enabled && (incident === 'refusal' || incident === 'empty') && this.session === session && session.process.alive) {
          this.record(session, task.replyId, plan!.history, current, delivered, input.shown);
          session.turns++;
          session.chars += sent + delivered.length;
          const pictures = (images.length > 0 && !kept) || glancesMustGo(session.glances, this.held, this.call);
          if (pictures || session.chars >= this.budget().maxChars) this.retire(session, pictures ? 'image' : 'budget', model);
          throw error;
        }
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

  /**
   * When a session retires after a turn. Today: maxTurns (12) or maxChars (60 000), and during a call at least callMaxTurns.
   * I-134 new chat on: no turn cap for ordinary chat (a call still retires at callMaxTurns) and longChat.sessionMaxChars.
   */
  private budget(): { maxTurns: number; maxChars: number } {
    const long = this.options.longChat?.enabled ? this.options.longChat : null;
    const call = this.options.callMaxTurns ?? CLAUDE_CALL_SESSION_MAX_TURNS;
    if (long) return { maxTurns: this.held ? call : Infinity, maxChars: long.sessionMaxChars };
    const ordinaryTurns = this.options.maxTurns ?? CLAUDE_SESSION_MAX_TURNS;
    return { maxTurns: this.held ? Math.max(ordinaryTurns, call) : ordinaryTurns, maxChars: this.options.maxChars ?? CLAUDE_SESSION_MAX_CHARS };
  }

  /** I-139 A3: tell the host a new process exists (it decides whether to look at her opening memory; it never blocks this). */
  private noteNewProcess(): void {
    const tell = this.options.onNewProcess;
    if (!tell) return;
    try { tell(); } catch { /* The host's business; never the chat's. */ }
  }

  private now(): number { return this.options.now ? this.options.now() : Date.now(); }

  /** Prewarm is on: new chat on, a preparation share above 0, and the host can give her archive's window. */
  private prewarmOn(): boolean {
    const long = this.options.longChat;
    return !!long?.enabled && long.restartPrepareAt > 0 && !!this.options.openingWindow;
  }

  /**
   * A session retires after a turn (the budget, or a picture). Prewarm: a replacement prepared for it takes the next turn (takePrepared),
   * so no spare is started; otherwise a spare is started as before. A budget restart opens the telemetry line.
   */
  private retire(session: Session, reason: 'budget' | 'image', model: string): void {
    const prepared = this.prepared;
    const usable = !!prepared && prepared.replaces === session && prepared.generation === this.generation && !prepared.dropped;
    if (reason === 'budget') this.telemetry.note('budget', session, usable ? prepared : null);
    this.closeSession(reason);
    if (usable) return;
    this.dropPrepared();
    void this.startSpare(model);
  }

  /**
   * Prewarm, right after one of her replies (the session goes on): remember the session's fixed opening parts; switch to a warmed
   * replacement now (she is idle: no reply streaming, no call); or, past restartPrepareAt of the budget, prepare one shortly.
   */
  private afterTurn(session: Session, input: CompanionSessionInput): void {
    if (!this.prewarmOn()) return;
    session.opening = { basePersona: input.basePersona, openingContext: input.openingContext ?? null, openingKey: input.openingKey ?? '', openingNote: input.openingNote ?? null,
      ...(input.relaxed ? { relaxed: input.relaxed, openingMemory: input.openingMemory ?? null } : {}) };
    if (this.prepared?.replaces === session) return; // stream() switches to it once this turn has ended (idleSwitch)
    const { maxChars } = this.budget();
    if (session.prepareTried || this.held || session.chars < maxChars * this.options.longChat!.restartPrepareAt) return;
    this.clearPrepareTimer();
    let tries = 0;
    const run = () => {
      this.prepareTimer = null;
      if (this.disposed || this.session !== session || session.prepareTried || this.prepared) return;
      // Busy again (a new message, a call): the next reply tries again.
      if (this.running || this.held) return;
      this.settleShown(session);
      // The host has not finished her reply yet (so her archive may not hold it): wait a little more.
      if (session.log.at(-1)?.shown && ++tries < 4) { this.prepareTimer = this.timers.set(run, this.options.prepareDelayMs ?? PREWARM_DELAY_MS); return; }
      void this.prepare(session);
    };
    this.prepareTimer = this.timers.set(run, this.options.prepareDelayMs ?? PREWARM_DELAY_MS);
  }

  /**
   * Prewarm: build the replacement for `session` (at most once per session): read her archive's window now, compose the opening
   * from it, start a blank process, then send the opening once as the hidden request (warmOpening) from a throwaway process in the
   * blank process's folder. Switches when that is done and she is idle; otherwise the next reply or the end of a call switches.
   */
  private async prepare(session: Session): Promise<void> {
    session.prepareTried = true;
    let window: readonly ChatMessage[] | null | undefined;
    try { window = this.options.openingWindow?.(); } catch { window = null; }
    if (!window?.length || !session.opening) return;
    const known = window.map(message => ({ role: message.role, content: message.content }));
    let opening: string;
    // I-139 A3: whatever the store holds now (a handoff may have moved it since the last turn); the prepare itself waits for nothing.
    let memory = session.opening.openingMemory;
    try { if (this.options.openingMemory) memory = this.options.openingMemory() ?? null; } catch { /* Keep the last turn's. */ }
    try { opening = composePreparedOpening({ ...session.opening, ...(memory ? { openingMemory: memory } : {}), history: known }); claudeInput({ prompt: opening }); }
    catch { return; } // Too long or not a window: the restart stays cold.
    const model = session.process.model;
    const prepared: Prepared = { generation: this.generation, key: session.key, model, replaces: session, known, opening,
      ready: Promise.resolve(null), process: null, warmer: null, warm: 'none', dropped: false, relationTag: session.opening.openingKey };
    prepared.ready = this.start(model).then(process => {
      if (prepared.dropped || this.disposed || !this.active) { process.close(); return null; }
      prepared.process = process;
      return process;
    }, () => null);
    this.prepared = prepared;
    this.log('preparing a replacement session');
    const process = await prepared.ready;
    if (!process || prepared.dropped) { if (this.prepared === prepared) this.prepared = null; return; }
    let warmer: ClaudeChatProcess | null = null;
    try { warmer = await this.start(model, process.folder); } catch { warmer = null; }
    if (!warmer || prepared.dropped) { warmer?.close(); prepared.warm = 'failed'; return; }
    prepared.warm = 'warming';
    prepared.warmer = warmer;
    const warmed = await warmOpening(warmer, opening, this.timers, this.options.warmTimeoutMs ?? PREWARM_TIMEOUT_MS);
    prepared.warmer = null;
    prepared.warm = warmed ? 'warmed' : 'failed';
    if (warmed && this.prepared === prepared) this.switchTo(prepared); // only if she is idle now; else after the reply (idleSwitch)
  }

  /** Prewarm: a warmed replacement switches in right after a reply has fully ended (stream(), the end of a call, the hidden request). */
  private idleSwitch(): void {
    if (this.prepared?.warm === 'warmed') this.switchTo(this.prepared);
  }

  /** Prewarm: install a warmed replacement in place of the session it was prepared for, only while she is idle. */
  private switchTo(prepared: Prepared): void {
    if (this.running || this.held || this.disposed) return; // the next reply, or the end of the call, switches
    const old = this.session;
    if (this.prepared !== prepared || prepared.dropped || prepared.generation !== this.generation || !old || old !== prepared.replaces
      || !prepared.process?.alive || prepared.process.busy || prepared.process.turnsStarted) return;
    this.telemetry.note('prepared', old, prepared);
    this.closeSession('budget');
    this.install(prepared);
    this.log('switched to the prepared session');
  }

  private install(prepared: Prepared): Session {
    this.prepared = null;
    this.lastEnded = null;
    const session: Session = { key: prepared.key, process: prepared.process!, known: [...prepared.known], log: [], turns: 0, chars: 0, preface: prepared.opening, fresh: 'budget', relationTag: prepared.relationTag };
    this.session = session;
    this.touch();
    this.noteNewProcess();
    return session;
  }

  /** Prewarm: this turn has no session and a replacement was prepared: install it when it fits this turn (else drop it). */
  private async takePrepared(key: string, model: string): Promise<Session | null> {
    const prepared = this.prepared;
    if (!prepared) return null;
    if (prepared.generation !== this.generation || prepared.key !== key || prepared.model !== model || this.session) { this.dropPrepared(true); return null; }
    const process = await prepared.ready; // a spawn at most, normally already done
    if (this.prepared !== prepared || this.session) return null;
    if (!process?.alive || process.busy || process.turnsStarted) { this.dropPrepared(); return null; }
    return this.install(prepared);
  }

  /** Prewarm: forget the prepared replacement: its hidden request is stopped; its blank process kept as the spare (`keep`) or closed. */
  private dropPrepared(keep = false): void {
    const prepared = this.prepared;
    if (!prepared) return;
    this.prepared = null;
    prepared.dropped = true;
    prepared.warmer?.close('closed');
    prepared.warmer = null;
    if (prepared.process) { if (keep) this.keepBlank(prepared.process); else prepared.process.close(); }
  }

  private clearPrepareTimer(): void {
    if (this.prepareTimer !== null) this.timers.clear(this.prepareTimer);
    this.prepareTimer = null;
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

  /** `directory`: prewarm's hidden request runs in the replacement's folder (ClaudeProcessOptions.directory); otherwise a new one. */
  private async start(model: string, directory?: string): Promise<ClaudeChatProcess> {
    const binary = await this.binary();
    const options: ClaudeProcessOptions = { binary, model, systemPrompt: this.options.systemPrompt ?? claudeSessionSystemPrompt(),
      ...(directory ? { directory } : {}),
      ...(this.options.binaryArgs ? { binaryArgs: this.options.binaryArgs } : {}),
      ...(this.options.interruptGraceMs !== undefined ? { interruptGraceMs: this.options.interruptGraceMs } : {}),
      ...(this.options.turnTimeoutMs !== undefined ? { turnTimeoutMs: this.options.turnTimeoutMs } : {}),
      ...(this.options.firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs: this.options.firstResponseTimeoutMs } : {}),
      ...(this.options.timers ? { timers: this.options.timers } : {}) };
    return (this.options.startProcess ?? ClaudeChatProcess.start)(options);
  }

  private startSpare(model: string, why?: SpareWhy): Promise<ClaudeChatProcess | null> {
    if (this.spareStarting) return this.spareStarting;
    const starting = this.start(model).then(process => {
      if (this.spareStarting === starting) this.spareStarting = null;
      if (this.disposed || !this.active) { process.close(); return null; }
      this.keepSpare(process);
      if (why) { try { this.options.onSpare?.(why); } catch { /* A journal row never affects the chat. */ } }
      this.startWarm?.begin(why, process);
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

  private closeSession(reason: string, ended?: FirstCharReuse): null {
    const session = this.session;
    this.session = null;
    if (session) {
      this.lastEnded = ended ?? (['context', 'restart', 'image', 'budget', 'idle', 'hidden', 'cap'].includes(reason) ? reason as FirstCharReuse
        : reason.startsWith('failure') ? 'failure' : 'other');
      session.process.close('closed');
      this.log(`closed (${reason}) after ${session.turns} turn(s)`);
    }
    return null;
  }

  private closeSpare(): void {
    this.startWarm?.cancel();
    this.spare?.close();
    this.spare = null;
    // A spare still starting closes itself once it sees there is no use for it.
    if (this.spareStarting) void this.spareStarting.then(process => { if (process && this.spare === process && !this.session) { process.close(); this.spare = null; } });
  }

  private touch(): void {
    this.lastActivity = this.now();
    this.scheduleIdle();
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
    this.idleTimer = null;
  }

  /** I-161 A (a switch off, a cleared vision context, hang-up): the held frames go: idle, the process is replaced now; in a turn, when it ends. */
  forgetFrames(): void {
    const session = this.session;
    if (!session?.glances?.count) return;
    session.glances.forget();
    if (!this.running) this.retire(session, 'image', session.process.model);
  }

  /** I-161 A: this turn's small frames stay in the process when keepsGlances says so (then they are counted with their check). */
  private keepGlances(session: Session, glance: { only: boolean; still: () => boolean }, frames: number): boolean {
    if (!keepsGlances({ frames, glanceOnly: glance.only, inCall: this.held, held: session.glances, call: this.call, knobs: this.options.callGlances ?? callGlanceKnobs() })) return false;
    const tag = glanceTag(this.held, this.call); // I-166: frames of no call carry OUTSIDE_CALL
    (session.glances ??= new HeldGlances(tag)).add(frames, glance.still, tag);
    return true;
  }

  /**
   * I-091: a voice call is on: the conversation's process (or the spare) is never closed for idling meanwhile, and one is
   * started now if none is ready, so every turn of the call starts on a warm process. Off: the idle clock runs again.
   */
  holdWarm(on: boolean): void {
    if (this.disposed || this.held === on) return;
    this.held = on;
    if (on) { this.call++; this.clearIdle(); this.prewarm('call'); }
    else this.forgetFrames(); // I-161 A: hang-up: the call's small frames go (now, or when the running turn ends)
    if (!on && !this.running) {
      this.scheduleIdle();
      this.idleSwitch(); // Prewarm: a replacement warmed during the call switches now that she is idle again.
    }
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.held) return;
    if (this.disposed || (!this.session && !this.spare && !this.spareStarting && !this.prepared)) return;
    const set = this.idleRule(), wait = Math.max(0, this.lastActivity + set.ms - this.now());
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = null;
      if (this.running) return;
      const rule = this.idleRule(); // read again: she may have gone out to full-screen since (hidden window, still seen): the longer limit
      if (set.reason === 'hidden' && rule.reason === 'idle') { this.scheduleIdle(); return; }
      this.close(rule.reason);
    }, wait);
  }
  private idleRule() {
    return sessionIdleRule({ visible: this.visible, seenElsewhere: this.options.seenElsewhere, idleMs: this.options.idleMs ?? CLAUDE_SESSION_IDLE_MS, hiddenIdleMs: this.options.hiddenIdleMs ?? CLAUDE_SESSION_HIDDEN_IDLE_MS });
  }
}
