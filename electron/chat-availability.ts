import { classifyClaudeFailure } from '../shared/claude-failure';
import type { ChatAvailabilityView, ChatFailureKind, ChatOutageNotice, OutageLineKind } from '../shared/chat-availability';

/**
 * Whether the user's own Claude Code can answer chat right now, as far as the app has seen.
 *
 * Fed by the chat path only (PersistentClaudeChat reports each turn's success or failure) and by the control
 * window's "retry". Chat itself is never blocked by this state: the user's next message always tries again.
 *
 * FOR BACKGROUND MODEL CALLS (the inner loop, diary, proactive speech and the like): call `isAvailable()` before
 * making a model call and skip it when false. When the state is `unavailable` it turns true again after a
 * backoff that depends on the cause (the reset time when the failure text gave one), so exactly one call is
 * allowed through per window; report what happened with `success()` or `failure(error)`. A login or a missing
 * Claude Code never turns true on its own; only a working chat turn or a successful retry clears it.
 */
export interface ChatAvailabilityDeps {
  now?: () => number;
  /** Zone used to read a reset time that names none (default: the machine's). */
  localZone?: string;
  /** Her own line for this kind from the active card's cache, or null. `pick` varies the choice between outages. */
  line?: (kind: OutageLineKind, pick: number) => string | null;
  /** Identity of the active card: another character speaks again even if the last one already did. */
  cardKey?: () => string;
  changed?: (view: ChatAvailabilityView) => void;
  /** Chat worked (also called when nothing was wrong); the place to prepare her lines. */
  worked?: () => void;
}

interface Decided { kind: ChatFailureKind; notice?: ChatOutageNotice }

const MINUTE = 60_000;
const QUIET_LIMIT = 3;
/** How long after the last failure a background call may try once more, by cause. */
const BACKOFF: Record<ChatFailureKind, number | null> = {
  network: MINUTE, 'rate-limited': MINUTE, quota: 30 * MINUTE, other: 2 * MINUTE, 'login-expired': null, 'not-found': null, certificate: null,
};

export class ChatAvailability {
  private deps: ChatAvailabilityDeps = {};
  private state: { kind: ChatFailureKind; since: number; lastFailureAt: number; resumeAt?: number } | null = null;
  private checking = false;
  /** Quiet failures (see quietFailure) since chat last worked. */
  private quietRun = 0;
  private recovered: { line: string | null } | undefined;
  private outages = 0;
  private readonly spoken = new Set<string>();
  private readonly decided = new WeakMap<object, Decided>();
  private readonly listeners = new Set<(view: ChatAvailabilityView) => void>();
  private last: string;

  constructor(deps: ChatAvailabilityDeps = {}) { this.deps = deps; this.last = JSON.stringify(this.view()); }

  /** Late binding: the shared instance exists before the app has a profile folder or a character. */
  attach(deps: ChatAvailabilityDeps): void { this.deps = { ...this.deps, ...deps }; }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  view(): ChatAvailabilityView {
    const s = this.state;
    if (!s) return { state: 'ok', checking: this.checking, ...(this.recovered ? { recovered: this.recovered } : {}) };
    return { state: 'unavailable', kind: s.kind, since: s.since, ...(s.resumeAt !== undefined ? { resumeAt: s.resumeAt } : {}), checking: this.checking };
  }

  subscribe(listener: (view: ChatAvailabilityView) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Advisory, for work the user did not ask for. The user's own chat messages are never gated by this. */
  isAvailable(at = this.now()): boolean {
    const s = this.state;
    if (!s) return true;
    // A stated reset time wins; after it, one more try per minute at most (a failed try updates lastFailureAt).
    if (s.resumeAt !== undefined) return at >= s.resumeAt && at >= s.lastFailureAt + MINUTE;
    const backoff = BACKOFF[s.kind];
    return backoff !== null && at >= s.lastFailureAt + backoff;
  }

  /**
   * A model call failed. Records the cause; whether she speaks about it is decided later, by `notice()`, in the
   * place that actually shows the failure (so a failure shown nowhere, like a voice turn, does not use it up).
   * Safety stops and a context change are not outages and leave the state alone.
   */
  failure(error: unknown): void {
    const text = failureText(error);
    if (text === null) return;
    const at = this.now();
    const found = classifyClaudeFailure(text, at, this.deps.localZone);
    const previous = this.state;
    if (!previous) this.outages++;
    this.state = {
      kind: found.kind,
      since: previous?.since ?? at,
      lastFailureAt: at,
      // A reset time seen earlier in this outage still stands while it lies ahead; a stale one is dropped.
      ...(found.resumeAt !== undefined ? { resumeAt: found.resumeAt }
        : previous && previous.kind === found.kind && previous.resumeAt !== undefined && previous.resumeAt > at ? { resumeAt: previous.resumeAt } : {}),
    };
    this.recovered = undefined;
    if (error && typeof error === 'object') this.decided.set(error, { kind: found.kind });
    this.publish();
  }

  /**
   * The notice to put on the failed chat's error event: undefined when this error is not an outage. The first
   * failure of each kind (per character) since chat last worked gets `speak: true` and her line; later ones are
   * quiet. Idempotent for one error.
   */
  notice(error: unknown): ChatOutageNotice | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const entry = this.decided.get(error);
    if (!entry) return undefined;
    if (entry.notice) return entry.notice;
    const key = `${this.safeCardKey()}|${entry.kind}`;
    const speak = !this.spoken.has(key);
    let line: string | null = null;
    if (speak) {
      this.spoken.add(key);
      try { line = this.deps.line?.(entry.kind, Math.max(0, this.outages - 1)) ?? null; } catch { line = null; }
    }
    return (entry.notice = { kind: entry.kind, speak, line });
  }

  /**
   * A reply that came back refused, empty, or nothing but internal draft (electron/reply-draft-guard.ts) is not an outage:
   * chat stays available and nothing else changes. She still answers in her own words ("other" kind), through the same
   * `notice()` as any failed chat. Returns the error so the caller can throw it.
   *
   * Three in a row without one working reply in between stop being a one-off (something is really wrong, and the user
   * should see the "needs attention" panel): the third is recorded as an ordinary failure.
   */
  quietFailure<T extends object>(error: T): T {
    if (++this.quietRun >= QUIET_LIMIT) { this.failure(error); return error; }
    this.decided.set(error, { kind: 'other' });
    return error;
  }

  /** Chat worked: a model turn finished, or a retry got an answer. */
  success(): void {
    const wasDown = this.state !== null;
    this.quietRun = 0;
    this.state = null;
    this.spoken.clear();
    if (wasDown) {
      let line: string | null = null;
      try { line = this.deps.line?.('recovered', Math.max(0, this.outages - 1)) ?? null; } catch { line = null; }
      this.recovered = { line };
    } else this.recovered = undefined;
    this.publish();
    // The recovery notice is a one-shot: the next view does not repeat it.
    this.recovered = undefined;
    try { this.deps.worked?.(); } catch { /* Preparing lines never affects chat. */ }
  }

  /** A retry started or ended. */
  setChecking(value: boolean): void {
    if (this.checking === value) return;
    this.checking = value;
    this.publish();
  }

  private safeCardKey(): string { try { return this.deps.cardKey?.() ?? ''; } catch { return ''; } }

  private publish(): void {
    const view = this.view();
    const signature = JSON.stringify(view);
    if (signature === this.last) return;
    this.last = signature;
    for (const listener of [...this.listeners]) { try { listener(view); } catch { /* A listener never breaks chat. */ } }
    try { this.deps.changed?.(view); } catch { /* Same. */ }
  }
}

/**
 * The text to classify, or null when this failure is not an outage: a safety stop (tools, MCP or isolation
 * reported) must stay visible as itself, and "the conversation changed under this turn" is not Claude's fault.
 */
export function failureText(error: unknown): string | null {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object') return '';
  const { kind, unsafe, detail, message } = error as { kind?: unknown; unsafe?: unknown; detail?: unknown; message?: unknown };
  if (unsafe === true || kind === 'unsafe' || kind === 'closed') return null;
  if (typeof detail === 'string' && detail.trim()) return detail;
  return typeof message === 'string' ? message : '';
}

/** The app-wide instance; the inner loop and other background callers import this one. */
export const chatAvailability = new ChatAvailability();
