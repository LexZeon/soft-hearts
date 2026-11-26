// I-202 (docs/claude/2026-11-23-claude-login-race.md): one gate in the main process for every Claude Code process the app starts.
//
// Why: on 2026-11-23 19:22, after the machine had been off ~7.5 hours, the app started several Claude Code processes at once (the spare,
// the paid prewarm's hidden request, the chat, background haiku calls) and at that moment ~/.claude/.credentials.json was rewritten with
// empty tokens; the user had to log in again. Suspected (not proven): the access token had expired, several processes refreshed it at
// once, refresh tokens rotate, and a loser cleared the stored login. The app never reads the credentials, so it cannot see the expiry;
// it can only avoid the burst at the moments an expired token is likely.
//
// The rule:
// - COLD (after the app starts, and after `freshMs` without a successful Claude answer): only one process may be starting or making
//   its first request. Everyone else waits until that one has produced its first answer (answered: the gate turns warm and all waiters
//   go at once) or failed / ended (released: the next waiter goes, alone, since it is still cold). A holder that says nothing is let go
//   after `holdMs` (a process that will make no model request, such as a spare or `claude mcp`, after its own shorter limit), so
//   nothing waits forever.
// - WARM (a success within `freshMs`): no waiting at all; concurrency is exactly as before. Every success keeps it warm.
// - LOGIN LOST (a failure whose text says the login is gone; shared/brain/claude-failure.ts 'login-expired'): no new process starts for
//   `loginPauseMs` (callers get the same failure text, so the user sees today's outage line), and the gate is cold again afterwards.
//   The user's own "Retry" lifts the pause (resume()). One journal row per lost login, through the observer.
//
// Pure and clock-injectable: tests drive it with a manual clock. The app uses the one shared instance `claudeStartGate`.
import { classifyClaudeFailure } from '../../shared/brain/claude-failure';
import type { ClaudeGateEvent } from '../../shared/brain/journal-entries';
import { ASSISTANT_CLI_NAME } from '../../shared/foundation/assistant-name';

export const CLAUDE_START_GATE = Object.freeze({
  /**
   * How long after the last successful Claude answer the gate stays open. 30 minutes: the idle rules close every warm chat process
   * after 3-10 minutes (CLAUDE_SESSION_IDLE_MS / CLAUDE_SESSION_HIDDEN_IDLE_MS), so after half an hour of quiet the next activity is a
   * burst of fresh processes again, the same shape as the app's start; Claude Code refreshes its access token only when it is close to
   * expiry, and the tokens live hours, so while the user is chatting a refresh is rare and is left alone (no first-char cost there).
   */
  freshMs: 30 * 60_000,
  /** A cold holder that has neither answered nor failed by then lets the next one go (the first-response window is 30 s). */
  holdMs: 45_000,
  /**
   * A process that will make no model request yet (a spare, a warm haiku, `claude mcp`) holds a cold gate at most this long: its own
   * start-up. 4 s is the start-up time this app already counts on for a Claude Code process that is told nothing (I-037's warm haiku is
   * "ready" 4 s after it starts). At a cold start the paid prewarm's hidden request waits that long behind the spare; a reply that goes to
   * the spare itself does not wait (the spare holds the gate and its first turn keeps it).
   */
  idleHoldMs: 4_000,
  /** After a lost login, how long no new Claude Code process starts (one try per minute at most, instead of one per caller). */
  loginPauseMs: 60_000,
});

export type { ClaudeGateEvent } from '../../shared/brain/journal-entries';

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };

export interface ClaudeStartGateOptions {
  now?: () => number;
  timers?: Timers;
  freshMs?: number;
  holdMs?: number;
  loginPauseMs?: number;
}

/** Thrown instead of starting a process while the login-lost pause runs. `detail`: the failure text that started it (for classification). */
export class ClaudeStartPausedError extends Error {
  readonly kind = 'failed' as const;
  constructor(readonly detail: string) { super(`${ASSISTANT_CLI_NAME} 未登录或登录已失效。请在终端运行 claude 完成登录后重试。`); this.name = 'ClaudeStartPausedError'; }
}

/** One caller's permission to start a process (or make its first request). */
export interface ClaudeGatePass {
  /** This pass is the one cold-start holder right now (everyone else waits for it). */
  readonly holding: boolean;
  /** The process produced its first answer: the login works. The gate turns warm and lets everyone go. */
  answered(): void;
  /** The process failed; `detail` is the raw failure text (a lost login starts the pause). Releases the hold. */
  failed(detail?: string): void;
  /** The process ended (or was stopped) without either: the next waiter may go. Idempotent. */
  release(): void;
  /** Still the holder: the hold limit starts again at its full length (a first turn begins on a process that held the gate while idle). */
  renew(): void;
}

interface Waiter { resolve(pass: ClaudeGatePass): void; reject(error: unknown): void; holdMs: number; abort?: () => void }

const defaultTimers: Timers = {
  set: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** True when a Claude Code failure text says the login is gone (not logged in, invalid key, expired or revoked OAuth token, 401). */
export function loginLost(detail: unknown): boolean {
  return typeof detail === 'string' && !!detail.trim() && classifyClaudeFailure(detail).kind === 'login-expired';
}

/**
 * Claude Code's stream-json line for a streaming API event (`{"type":"stream_event",...}`): the API accepted the request, so the login
 * worked. For callers that do not parse lines themselves (the Claude assistant, tasks); cheap, it looks at the head only.
 */
export function apiStreamLine(line: string): boolean {
  return /^\s*\{\s*"type"\s*:\s*"stream_event"/.test(line.slice(0, 64));
}

/**
 * For a caller that reads Claude Code's stream-json lines itself (the Claude assistant, tasks): answers the pass at the first streaming
 * event, keeps a failed result's raw text, and on the end hands the pass its verdict. Bounded: only the head of a result line is kept.
 */
export class ClaudeGateWatch {
  private seen = false;
  private ended = false;
  private detail = '';
  constructor(private readonly pass: ClaudeGatePass) {}
  line(line: string): void {
    if (!this.seen && apiStreamLine(line)) { this.seen = true; this.pass.answered(); return; }
    if (!/^\s*\{\s*"type"\s*:\s*"result"/.test(line.slice(0, 64)) || line.length > 200_000) return;
    try {
      const event = JSON.parse(line) as { is_error?: unknown; subtype?: unknown; result?: unknown; errors?: unknown };
      if (event.is_error !== true && event.subtype === 'success') return;
      this.detail = (typeof event.result === 'string' ? event.result : Array.isArray(event.errors) ? event.errors.join('; ') : '').slice(0, 2000);
    } catch { /* Not a line this watch reads. */ }
  }
  /** The process ended. `failed`: the caller's turn failed; the raw text seen (a failed result, else `stderr`) goes to the gate. */
  end(failed: boolean, stderr = ''): void {
    if (this.ended) return;
    this.ended = true;
    if (failed) this.pass.failed(this.detail || stderr);
    this.pass.release();
  }
}

export class ClaudeStartGate {
  private lastSuccessAt: number | null = null;
  private holder: Pass | null = null;
  private holdTimer: unknown = null;
  private readonly queue: Waiter[] = [];
  private pausedUntil = 0;
  private pauseDetail = '';
  /** A lost login was journaled and no success came since (one row per lost login). */
  private lost = false;
  private observer: ((event: ClaudeGateEvent) => void) | null = null;
  private readonly timers: Timers;

  constructor(private readonly options: ClaudeStartGateOptions = {}) { this.timers = options.timers ?? defaultTimers; }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private get freshMs(): number { return this.options.freshMs ?? CLAUDE_START_GATE.freshMs; }

  /** A success within freshMs: nobody waits. */
  get warm(): boolean { return this.lastSuccessAt !== null && this.now() - this.lastSuccessAt <= this.freshMs; }
  get paused(): boolean { return this.now() < this.pausedUntil; }
  /** Numbers only, for diagnostics and tests. */
  snapshot(): { state: 'warm' | 'cold' | 'paused'; holding: boolean; waiting: number } {
    return { state: this.paused ? 'paused' : this.warm ? 'warm' : 'cold', holding: !!this.holder, waiting: this.queue.length };
  }

  /** The app's journal hook (electron/wiring/brain-wiring.ts); null removes it. */
  observe(observer: ((event: ClaudeGateEvent) => void) | null): void { this.observer = observer; }

  /**
   * A pass right now, or null when the caller must wait (cold, and someone else holds the gate). Throws ClaudeStartPausedError while
   * the login-lost pause runs. Synchronous, so a warm caller goes exactly as before.
   */
  enterNow(options: { holdMs?: number } = {}): ClaudeGatePass | null {
    if (this.paused) throw new ClaudeStartPausedError(this.pauseDetail);
    if (this.warm) return new Pass(this, false);
    if (this.holder || this.queue.length) return null;
    return this.hold(options.holdMs);
  }

  /** Waits for a pass (see the rule at the top). Rejects with the signal's reason when aborted while waiting, or ClaudeStartPausedError. */
  enter(options: { signal?: AbortSignal; holdMs?: number } = {}): Promise<ClaudeGatePass> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('已停止。'));
    let now: ClaudeGatePass | null;
    try { now = this.enterNow(options); } catch (error) { return Promise.reject(error); }
    if (now) return Promise.resolve(now);
    return new Promise<ClaudeGatePass>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, holdMs: options.holdMs ?? this.options.holdMs ?? CLAUDE_START_GATE.holdMs };
      if (signal) {
        const onAbort = () => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('已停止。'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.abort = () => signal.removeEventListener('abort', onAbort);
      }
      this.queue.push(waiter);
    });
  }

  /** The user pressed "Retry" (or logged in again): the pause ends now; the gate stays cold, so the next try goes alone. */
  resume(): void {
    this.pausedUntil = 0;
    this.pauseDetail = '';
    this.next();
  }

  /** @internal Pass → gate. */
  noteAnswered(): void {
    this.lastSuccessAt = this.now();
    this.lost = false;
    this.pausedUntil = 0;
    this.pauseDetail = '';
    this.next();
  }

  /** @internal Pass → gate. */
  noteFailed(detail: string): void {
    if (!loginLost(detail)) return;
    this.lastSuccessAt = null;
    this.pausedUntil = this.now() + (this.options.loginPauseMs ?? CLAUDE_START_GATE.loginPauseMs);
    this.pauseDetail = detail.slice(0, 2000);
    if (!this.lost) {
      this.lost = true;
      try { this.observer?.('login-lost'); } catch { /* A journal row never affects the gate. */ }
    }
  }

  /** @internal Pass → gate: the holder lets go. */
  unhold(pass: Pass): void {
    if (this.holder !== pass) return;
    this.holder = null;
    this.timers.clear(this.holdTimer);
    this.holdTimer = null;
    this.next();
  }

  /** @internal */
  isHolder(pass: Pass): boolean { return this.holder === pass; }

  /** @internal */
  renewHold(pass: Pass): void {
    if (this.holder !== pass) return;
    this.startHoldTimer(pass, this.options.holdMs ?? CLAUDE_START_GATE.holdMs);
  }

  private hold(holdMs?: number): Pass {
    const pass = new Pass(this, true);
    this.holder = pass;
    this.startHoldTimer(pass, holdMs ?? this.options.holdMs ?? CLAUDE_START_GATE.holdMs);
    return pass;
  }

  private startHoldTimer(pass: Pass, ms: number): void {
    this.timers.clear(this.holdTimer);
    this.holdTimer = this.timers.set(() => { if (this.holder === pass) this.unhold(pass); }, Math.max(0, ms));
  }

  /** Who goes next: during the pause nobody (all waiters get the login failure); warm, everybody; cold, the first in line alone. */
  private next(): void {
    if (this.paused) {
      const error = new ClaudeStartPausedError(this.pauseDetail);
      for (const waiter of this.queue.splice(0)) { waiter.abort?.(); waiter.reject(error); }
      return;
    }
    if (this.warm) {
      for (const waiter of this.queue.splice(0)) { waiter.abort?.(); waiter.resolve(new Pass(this, false)); }
      return;
    }
    if (this.holder) return;
    const waiter = this.queue.shift();
    if (!waiter) return;
    waiter.abort?.();
    waiter.resolve(this.hold(waiter.holdMs));
  }
}

class Pass implements ClaudeGatePass {
  constructor(private readonly gate: ClaudeStartGate, private readonly wasHolder: boolean) {}
  get holding(): boolean { return this.wasHolder && this.gate.isHolder(this); }
  // Warm first, then let go: every waiter goes at once instead of the next one alone.
  answered(): void { this.gate.noteAnswered(); this.gate.unhold(this); }
  failed(detail = ''): void { this.gate.noteFailed(detail); this.gate.unhold(this); }
  release(): void { this.gate.unhold(this); }
  renew(): void { this.gate.renewHold(this); }
}

/** The app's one gate: every Claude Code process the main process starts goes through it (the list is in the I-202 record). */
export const claudeStartGate = new ClaudeStartGate();
