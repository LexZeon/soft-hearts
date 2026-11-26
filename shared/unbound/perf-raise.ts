/**
 * Unbound quality tier, the way back up and the journal (docs/claude/2026-11-23-unbound-quality-tier.md).
 *
 * Pure logic, no DOM. perf-tiers.ts decides how she goes down (a self-test, a drop); this decides when she may come back up one
 * tier inside a session, and keeps the small journal of every tier change.
 */
import { COMFORT, RAISE_AFTER_S, RAISE_MAX_S, RAISE_TRIAL_MS, STALL_MS, lateness, percentile, tierOf, type PerfTierId } from './perf-tiers';

/**
 * Counts comfortable full-rate seconds. A second counts when all its frames were drawn at the full rate and their p95 lateness is
 * within COMFORT; a bad second (or a stall) starts the count again; a second that held quiet-rate frames is neutral (it says
 * nothing about the full rate). True when the count reaches the wait; the caller raises her one tier and calls raised().
 */
export class RaiseUp {
  private bin: number[] = [];
  private binStart = 0;
  private binQuiet = false;
  private streak = 0;
  private needS = RAISE_AFTER_S;
  private raisedAt = -Infinity;
  /** Seconds in the current comfortable stretch (for the journal). */
  get seconds(): number { return this.streak; }
  /** How long the next stretch has to be (doubled after a raise that did not hold). */
  get wait(): number { return this.needS; }
  /** After a drop, a pause or a scene change. A drop soon after a raise means the higher tier does not fit: the next wait is doubled. */
  reset(now: number, dropped = false): void {
    if (dropped && now - this.raisedAt < RAISE_TRIAL_MS) this.needS = Math.min(RAISE_MAX_S, this.needS * 2);
    this.clear();
  }
  raised(now: number): void { this.raisedAt = now; this.clear(); }
  private clear(): void { this.bin = []; this.binStart = 0; this.binQuiet = false; this.streak = 0; }
  feed(now: number, intervalMs: number, fps: number, quiet: boolean): boolean {
    if (!this.binStart) this.binStart = now;
    if (now - this.binStart >= 1_000) {
      if (this.bin.length && !this.binQuiet) {
        if ((percentile(this.bin, 0.95) ?? 0) <= COMFORT) this.streak++; else this.streak = 0;
      }
      this.bin = []; this.binQuiet = false; this.binStart = now;
    }
    if (quiet) this.binQuiet = true;
    else if (intervalMs < STALL_MS) this.bin.push(lateness(intervalMs, fps));
    else this.streak = 0;
    return this.streak >= this.needS;
  }
}

/**
 * One row each time the tier changes, in closed words and numbers (never a sentence), kept in the page's storage so it can be read
 * next time. test: `p95` is the lateness of the tier kept, `n` how many starts agreed; adapt: `n` the seconds over budget it saw;
 * raise: `n` the comfortable seconds it waited.
 */
export interface TierJournalRow { at: number; from: PerfTierId; to: PerfTierId; why: 'test' | 'adapt' | 'raise'; p95: number | null; n: number }
export const PERF_JOURNAL_KEY = 'unbound.perf.journal.v1';
export const PERF_JOURNAL_ROWS = 24;
export function parseJournal(raw: string | null): TierJournalRow[] {
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw) as unknown;
    return Array.isArray(rows)
      ? (rows as TierJournalRow[]).filter(r => r && tierOf(r.from) && tierOf(r.to) && ['test', 'adapt', 'raise'].includes(r.why) && Number.isFinite(r.at)).slice(-PERF_JOURNAL_ROWS)
      : [];
  } catch { return []; }
}
export const appendJournal = (raw: string | null, row: TierJournalRow): string => JSON.stringify([...parseJournal(raw), row].slice(-PERF_JOURNAL_ROWS));
