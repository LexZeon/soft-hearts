import { claudeInput, findClaude, noteClaudeCall } from '../claude';
import { ClaudeChatProcess, type ClaudeProcessOptions, type ClaudeTurnResult } from '../claude-process';
import type { StreamEvent } from '../../shared/contracts';
import { INNER_LOOP_MODEL } from './model';

/**
 * A small, tool-less Claude call that is kept ready ("warm") for one fixed system prompt (I-037 reactions, docs/claude/
 * 2026-11-07-reactions-warm-haiku.md). Brain interface (docs/claude/brain-interface.md): the process, its arguments and the
 * model tier stay in this module.
 *
 * Why: starting `claude -p` costs about 1.2 s of CPU over ~2.5 s on the user's ARM machine; started next to her reply it made her
 * first character ~0.5 s slower (A/B 2026-11-06). A warm process pays that start while nothing else runs, so a call during her
 * reply is just a request.
 *
 * - One long-lived `claude -p --input-format stream-json` process (ClaudeChatProcess: the same isolation flags, empty folder and
 *   per-turn checks as her chat; no tools). Calls are sequential; an aborted call drains before the next one is written.
 * - It counts as ready only knobs.bootMs after it was started (Claude Code prints nothing until its first message, so the boot
 *   is timed). Not ready: the caller must not rely on it for a call made beside her reply.
 * - Starting, retiring and rebuilding happen only in check(), which runs on its own timer and does nothing while busy() (her
 *   reply is running) — never at the moment the user sends a message. want() asks for a process; nothing starts until then.
 * - Retired (closed at the next quiet check, a fresh one started) after maxTurns calls or maxChars characters, so each call's
 *   context stays short; closed after idleMs unused (and not started again until the next want()); closed after a failed call.
 * - stop(): closed and not wanted (the feature was switched off). dispose(): stopped for good (app quit).
 */
export interface WarmProcess {
  readonly alive: boolean;
  readonly busy: boolean;
  settled(): Promise<void>;
  runTurn(input: string, signal: AbortSignal, emit: (type: StreamEvent['type'], text: string) => void): Promise<ClaudeTurnResult>;
  close(kind?: 'closed'): void;
}

export interface WarmLineTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface WarmLineOptions {
  /** The fixed system prompt (read when a process starts; a different one retires the process). */
  systemPrompt(): string;
  /** May a process exist now (the feature is on, the pet is shown, Claude is reachable)? Checked before every start. */
  allowed(): boolean;
  /** Something heavier is running now (her reply): nothing starts or retires during it. */
  busy?(): boolean;
  model?: string;
  binary?(): Promise<string>;
  /** Test seam only: arguments before Claude Code's own (tests run a script through node). */
  binaryArgs?: readonly string[];
  /** Test seam: start a process (default ClaudeChatProcess.start). */
  startProcess?(options: ClaudeProcessOptions): Promise<WarmProcess>;
  bootMs?: number;
  idleMs?: number;
  maxTurns?: number;
  maxChars?: number;
  /** How often a wanted, missing (or retiring) process is checked again. */
  retryMs?: number;
  /** Failed starts or calls in a row before it stops trying until a call succeeds or want(reset) is called. */
  maxFailures?: number;
  turnTimeoutMs?: number;
  clock?(): number;
  timers?: WarmLineTimers;
  log?(line: string): void;
}

/** Defaults (knobs in docs/claude/2026-11-07-reactions-warm-haiku.md). */
export interface WarmLineLimits {
  readonly bootMs: number; readonly idleMs: number; readonly maxTurns: number; readonly maxChars: number; readonly retryMs: number;
  readonly maxFailures: number; readonly turnTimeoutMs: number; readonly maxText: number;
}
export const WARM_LINE_DEFAULTS: WarmLineLimits = Object.freeze({
  bootMs: 4_000,
  /** As her chat's own process (electron/claude-session.ts CLAUDE_SESSION_IDLE_MS). */
  idleMs: 10 * 60_000,
  maxTurns: 8,
  maxChars: 40_000,
  retryMs: 5_000,
  maxFailures: 3,
  turnTimeoutMs: 20_000,
  maxText: 2_000,
});

interface Held { process: WarmProcess; system: string; startedAt: number; lastUsed: number; turns: number; chars: number; retiring: boolean; calling: boolean }

const defaultTimers: WarmLineTimers = {
  set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class WarmLine {
  private held: Held | null = null;
  private starting: Promise<void> | null = null;
  private wanted = false;
  private failures = 0;
  private timer: unknown = null;
  private disposed = false;
  private readonly timers: WarmLineTimers;
  private readonly clock: () => number;
  private readonly limits: WarmLineLimits;
  /** Counts for tests and the resource probe. */
  readonly stats = { started: 0, closed: 0, calls: 0, failed: 0, retired: 0, idle: 0 };

  constructor(private readonly options: WarmLineOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.clock = options.clock ?? Date.now;
    this.limits = { ...WARM_LINE_DEFAULTS, ...Object.fromEntries(Object.entries({ bootMs: options.bootMs, idleMs: options.idleMs, maxTurns: options.maxTurns,
      maxChars: options.maxChars, retryMs: options.retryMs, maxFailures: options.maxFailures, turnTimeoutMs: options.turnTimeoutMs })
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /** A process is held, booted, not retiring, for this system prompt: a call now costs no process start. */
  get ready(): boolean {
    const held = this.held;
    return !!held && held.process.alive && !held.retiring && this.clock() - held.startedAt >= this.limits.bootMs
      && held.system === this.safe(() => this.options.systemPrompt(), '');
  }
  /** A process is held and alive (maybe still booting or due to retire): usable for a call that does not race her first character. */
  get alive(): boolean { const held = this.held; return !!held && held.process.alive && held.system === this.safe(() => this.options.systemPrompt(), ''); }
  /** A process exists or is starting (for tests and the quit check). */
  get holding(): boolean { return !!this.held || !!this.starting; }
  /** Calls made on the process held now (0 when none; for the A/B and the resource probe). */
  get heldTurns(): number { return this.held?.turns ?? 0; }

  /** Ask for a process: one is started at the next quiet check (delayMs later, at the earliest). `reset` forgets earlier failures. */
  want(delayMs = this.limits.retryMs, reset = false): void {
    if (this.disposed) return;
    this.wanted = true;
    if (reset) this.failures = 0;
    this.schedule(delayMs);
  }

  /** One call on the warm process. Rejects when there is none (the caller then makes its own one-off call). */
  async ask(prompt: string, signal: AbortSignal): Promise<string> {
    const held = this.held;
    if (!held || !held.process.alive || this.disposed) throw new Error('没有待命的进程。');
    // Calls are one at a time (the reactions abort the older call before the next message's call starts).
    if (held.calling) throw new Error('待命的进程正忙。');
    signal.throwIfAborted();
    held.calling = true;
    held.lastUsed = this.clock();
    const callEnded = noteClaudeCall(); // other background model calls (I-021 notes) wait while this one runs
    try {
      // A call the caller stopped may still be draining: the next one waits for it (bounded by the process's interrupt grace).
      await held.process.settled();
      signal.throwIfAborted();
      if (this.held !== held || !held.process.alive) throw new Error('待命的进程已结束。');
      const line = claudeInput({ prompt, imageDataUrls: [] });
      held.turns++;
      held.chars += prompt.length;
      this.stats.calls++;
      let text = '', overflow = false;
      const result = await held.process.runTurn(line, signal, (type, value) => {
        if (type !== 'delta' || overflow) return;
        if (text.length + value.length > WARM_LINE_DEFAULTS.maxText) { overflow = true; return; }
        text += value;
      });
      held.chars += result.output.length;
      this.failures = 0;
      return overflow ? '' : text;
    } catch (error) {
      if (!signal.aborted) {
        // Anything but the caller's own stop: this process is not trusted again; a fresh one is started when quiet.
        this.stats.failed++;
        this.failures++;
        if (this.held === held) this.drop('failed');
      }
      throw error;
    } finally {
      callEnded();
      held.calling = false;
      held.lastUsed = this.clock();
      if (this.held === held && (held.turns >= this.limits.maxTurns || held.chars >= this.limits.maxChars)) held.retiring = true;
      this.schedule(this.limits.retryMs);
    }
  }

  /** Switched off: close now, start nothing until want(). */
  stop(): void {
    this.wanted = false;
    this.clearTimer();
    this.drop('stopped');
  }

  /** App quit: closed for good. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  /** The quiet check (normally on its own timer; scripts may call it). */
  check(): void {
    this.timer = null;
    if (this.disposed) return;
    const held = this.held;
    if (held && !held.process.alive) { this.held = null; this.stats.closed++; this.failures++; }
    const now = this.clock();
    if (this.held && !this.held.calling && !this.held.process.busy && now - this.held.lastUsed >= this.limits.idleMs) {
      this.stats.idle++;
      this.drop('idle');
      this.wanted = false;
      return;
    }
    if (this.safe(() => this.options.busy?.() === true, false)) { this.schedule(this.limits.retryMs); return; }
    const current = this.held;
    if (current && !current.calling && !current.process.busy && (current.retiring || current.system !== this.safe(() => this.options.systemPrompt(), current.system))) {
      this.stats.retired++;
      this.drop('retired');
      this.wanted = true;
    }
    if (!this.held && !this.starting && this.wanted && this.failures < this.limits.maxFailures && this.safe(() => this.options.allowed(), false)) this.start();
    if (this.held || this.starting || this.wanted) this.schedule(this.held ? Math.min(this.limits.retryMs * 6, Math.max(this.limits.retryMs, this.limits.idleMs)) : this.limits.retryMs);
  }

  private start(): void {
    const system = this.safe(() => this.options.systemPrompt(), '');
    if (!system) return;
    const starting = (async () => {
      const binary = await (this.options.binary ?? findClaude)();
      const processOptions: ClaudeProcessOptions = { binary, model: this.options.model ?? INNER_LOOP_MODEL, systemPrompt: system,
        turnTimeoutMs: this.limits.turnTimeoutMs, ...(this.options.binaryArgs ? { binaryArgs: this.options.binaryArgs } : {}),
        ...(this.options.timers ? { timers: this.options.timers } : {}) };
      return (this.options.startProcess ?? ClaudeChatProcess.start)(processOptions);
    })().then(process => {
      if (this.starting === starting) this.starting = null;
      if (this.disposed || !this.wanted || this.held || !this.safe(() => this.options.allowed(), false)) { process.close('closed'); return; }
      const at = this.clock();
      this.held = { process, system, startedAt: at, lastUsed: at, turns: 0, chars: 0, retiring: false, calling: false };
      this.stats.started++;
      this.log('warm process started');
    }, () => {
      if (this.starting === starting) this.starting = null;
      this.failures++;
    });
    this.starting = starting;
  }

  private drop(reason: string): void {
    const held = this.held;
    this.held = null;
    if (!held) return;
    this.stats.closed++;
    held.process.close('closed');
    this.log(`warm process closed (${reason}) after ${held.turns} call(s)`);
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = this.timers.set(() => this.check(), Math.max(0, ms));
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private log(line: string): void { try { this.options.log?.(line); } catch { /* Best effort. */ } }
}
