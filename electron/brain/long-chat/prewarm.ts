// Prewarm (I-134 new chat, docs/claude/2026-11-15-prewarm-restart.md): the parts of "prepare the replacement session before the
// restart" that do not need PersistentClaudeChat's private state: the one hidden request that writes the opening into Claude's
// prompt cache, and the developer log of restarts. The state machine itself is in electron/brain/claude-session.ts.
import { claudeInput, noteClaudeCall, type ClaudeUsage } from '../claude';
import type { ClaudeChatProcess } from '../claude-process';
import { appendBounded } from '../reply-latency';

/** After her reply, wait this long before reading her archive, so the reply the host is still archiving is in the window. */
export const PREWARM_DELAY_MS = 1_500;
/** The hidden request gives up after this long (it normally ends at the model's first output, a few seconds). */
export const PREWARM_TIMEOUT_MS = 60_000;

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };

/**
 * The hidden request: `opening` (a prepared opening, composePreparedOpening) as the only text of the only message of `warmer`, a
 * throwaway process started like the replacement and in the replacement's folder, so both requests open with the same prefix and
 * the API caches it. Stopped (Claude Code's own interrupt) at the model's first output, which comes only after the prompt was read;
 * the process is closed either way. Nothing of it goes anywhere: no emit, no reply id, no timing, no availability, no archive, and
 * the replacement process never sees it. Counts as a running Claude call meanwhile (claudeCallsInFlight, I-021 notes wait).
 * True when the model answered at all (the prompt was read, so its prefix was cached), false on any failure or timeout.
 */
export async function warmOpening(warmer: ClaudeChatProcess, opening: string, timers: Timers, timeoutMs = PREWARM_TIMEOUT_MS): Promise<boolean> {
  const done = noteClaudeCall();
  const controller = new AbortController();
  let answered = false;
  const timer = timers.set(() => controller.abort(), timeoutMs);
  try {
    await warmer.runTurn(claudeInput({ prompt: opening }), controller.signal, () => {}, { firstOutput: () => { answered = true; controller.abort(); } });
    answered = true;
  } catch { /* Stopped on purpose at the first output, or it failed: either way there is nothing to keep. */ }
  finally {
    timers.clear(timer);
    warmer.close('closed');
    done();
  }
  return answered;
}

/**
 * One restart of her conversation process (dev telemetry, numbers and closed words only):
 * - reason: `budget` (the session reached sessionMaxChars) or `prepared` (switched early to a prepared replacement while she was idle); `start` or
 *   `switch` (2026-11-23, the paid prewarm step: the first turn of a spare that was warmed when the app came up / she came on stage; sessionChars 0);
 * - prepared: the first reply after it ran with the prepared opening; warm: how the hidden request went (`none` when none was sent);
 * - sessionChars / contextTokens: the old session's character count and its last request's whole input in tokens;
 * - firstCharMs: message written to the new process → her first character; cacheRead/CreationTokens: that first request's usage.
 */
export interface SessionRestartEntry {
  reason: 'budget' | 'prepared' | 'start' | 'switch';
  prepared: boolean;
  warm: 'none' | 'warming' | 'warmed' | 'failed';
  sessionChars: number;
  contextTokens: number | null;
  firstCharMs: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** The whole input of a request, from its usage (null when Claude Code reported none). */
export function contextTokens(usage: ClaudeUsage | null | undefined): number | null {
  if (!usage) return null;
  const parts = [usage.inputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens].filter((value): value is number => typeof value === 'number');
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : null;
}

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const REASONS = new Set(['budget', 'prepared', 'start', 'switch']);
const WARMS = new Set(['none', 'warming', 'warmed', 'failed']);

/** A record with exactly the known fields, numbers bounded, words from the closed lists; null when it is not one. */
export function sanitizeRestartEntry(entry: unknown): SessionRestartEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry as Record<string, unknown>;
  if (!REASONS.has(value.reason as string) || !WARMS.has(value.warm as string) || typeof value.prepared !== 'boolean') return null;
  const chars = count(value.sessionChars);
  if (chars === null) return null;
  return { reason: value.reason as SessionRestartEntry['reason'], prepared: value.prepared, warm: value.warm as SessionRestartEntry['warm'], sessionChars: chars,
    contextTokens: count(value.contextTokens), firstCharMs: count(value.firstCharMs), cacheReadTokens: count(value.cacheReadTokens), cacheCreationTokens: count(value.cacheCreationTokens) };
}

export interface SessionRestartLogOptions {
  /** Developer mode, checked per record. */
  enabled(): boolean;
  /** JSON-lines file, or null when no profile directory is ready. */
  file(): string | null;
  wallNow?(): number;
  write?(file: string, line: string): Promise<void>;
}

/** `<profile>/dev/session-restarts.jsonl`: one line per restart, `{"at": …, …SessionRestartEntry}`. Never any text of the chat. */
export class SessionRestartLog {
  constructor(private readonly options: SessionRestartLogOptions) {}

  /** True when a line was handed to the writer. Never throws into the chat path. */
  record(entry: SessionRestartEntry): boolean {
    let file: string | null = null;
    try { file = this.options.enabled() ? this.options.file() : null; } catch { return false; }
    const clean = sanitizeRestartEntry(entry);
    if (!file || !clean) return false;
    const line = JSON.stringify({ at: new Date(this.options.wallNow?.() ?? Date.now()).toISOString(), ...clean });
    void (this.options.write ?? appendBounded)(file, line + '\n').catch(() => {});
    return true;
  }
}
