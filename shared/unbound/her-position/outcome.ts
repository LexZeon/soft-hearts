/**
 * I-193 (the journal showed her second come-near stayed, "already
 * there", and nothing told her): how her go-markers went, kept until her next turn's position line says it once.
 *
 * Fed from the same rows the journal gets (shared/unbound/life/host.ts: every go-word leaves one go-beat row, went or stayed with its closed reason),
 * so the line and the journal never disagree. Told once (take clears), only while fresh, at most the last few. Pure: the caller gives the time.
 */
import type { GoWord } from './ask';
import type { GoStayWhy, LifeJournalRow } from './journal';

/** One go-marker's outcome: went (she walked; where she is now is in the line) or stayed, with the closed reason. */
export interface GoOutcome { word: GoWord; outcome: 'went' | 'stayed'; why: GoStayWhy | null }

/** Fixed rules (not knobs): an outcome older than this is not told; at most this many are kept. */
export const GO_OUTCOME_RULES = Object.freeze({ freshMs: 20 * 60_000, keep: 3 });

export class GoOutcomes {
  private list: { outcome: GoOutcome; at: number }[] = [];

  /** A journal row of hers: a go-beat row is kept (the latest `keep`); anything else is ignored. */
  note(row: LifeJournalRow | null | undefined, at: number): void {
    if (!row || row.type !== 'go-beat' || !Number.isFinite(at)) return;
    this.list.push({ outcome: { word: row.word, outcome: row.outcome, why: row.outcome === 'went' ? null : row.why }, at });
    if (this.list.length > GO_OUTCOME_RULES.keep) this.list.splice(0, this.list.length - GO_OUTCOME_RULES.keep);
  }

  /** The outcomes since the last turn that are still fresh, oldest first; told once (cleared). */
  take(now: number): GoOutcome[] {
    const fresh = this.list.filter(item => Number.isFinite(now) && now - item.at <= GO_OUTCOME_RULES.freshMs).map(item => ({ ...item.outcome }));
    this.list = [];
    return fresh;
  }
}
