// Prewarm dev telemetry (docs/claude/2026-11-15-prewarm-restart.md, 2026-11-23 the paid prewarm step): the line one process restart (or a warmed
// spare's first turn) writes after its first reply. Numbers and closed words only. Split out of claude-session.ts.
import type { ClaudeUsage } from '../claude';
import { contextTokens, type SessionRestartEntry } from './prewarm';

/** What the telemetry reads of a session. */
export interface TelemetrySession { turns: number; chars: number; process: { lastUsage: ClaudeUsage | null | undefined } }

/** A restart waiting for its first reply. */
export interface PendingRestart<S extends TelemetrySession> {
  entry: Omit<SessionRestartEntry, 'firstCharMs' | 'cacheReadTokens' | 'cacheCreationTokens' | 'warm' | 'prepared'>;
  /** How the hidden request went (a prepared replacement's, or a warmed spare's). */
  warm(): SessionRestartEntry['warm'];
  target: S | null;
  prepared: boolean;
  dispatchedAt: number | null;
  firstCharMs: number | null;
}

export class RestartTelemetry<S extends TelemetrySession> {
  private pending: PendingRestart<S> | null = null;

  constructor(private readonly deps: { log(): ((entry: SessionRestartEntry) => void) | undefined; enabled(): boolean; now(): number }) {}

  private open(entry: PendingRestart<S>['entry'], warm: () => SessionRestartEntry['warm']): void {
    if (!this.deps.log() || !this.deps.enabled()) return;
    this.flush();
    this.pending = { entry, warm, target: null, prepared: false, dispatchedAt: null, firstCharMs: null };
  }

  /** A restart for the budget (or an early prepared switch); its line is written after the next first reply. */
  note(reason: 'budget' | 'prepared', old: S, from: { warm: SessionRestartEntry['warm'] } | null): void {
    this.open({ reason, sessionChars: old.chars, contextTokens: contextTokens(old.process.lastUsage) }, () => from?.warm ?? 'none');
  }

  /** The paid prewarm step: a spare was warmed for 'start' / 'switch' (or the user wrote first): its first reply is measured like a restart's. */
  noteStartWarm(why: 'start' | 'switch', warm: SessionRestartEntry['warm']): void {
    this.open({ reason: why, sessionChars: 0, contextTokens: null }, () => warm);
  }

  /** The pending restart, when this turn is the first one on a new session (its first reply is the one measured). */
  forSession(session: S, preface: boolean): PendingRestart<S> | null {
    const restart = this.pending;
    if (!restart || restart.target || session.turns > 0) return null;
    restart.target = session;
    restart.prepared = preface;
    restart.dispatchedAt = this.deps.now();
    return restart;
  }

  /** Writes the pending restart's line (also when no reply measured it: closed before, or the first turn failed). */
  flush(session?: S): void {
    const restart = this.pending;
    if (!restart || (session && restart.target !== session)) return;
    this.pending = null;
    const usage = restart.target?.process.lastUsage ?? null;
    const measured = restart.target && restart.firstCharMs !== null;
    try {
      this.deps.log()?.({ ...restart.entry, prepared: restart.prepared, warm: restart.warm(), firstCharMs: restart.firstCharMs,
        cacheReadTokens: measured ? usage?.cacheReadInputTokens ?? null : null, cacheCreationTokens: measured ? usage?.cacheCreationInputTokens ?? null : null });
    } catch { /* Telemetry never affects chat. */ }
  }
}
