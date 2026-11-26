/**
 * I-135 (Beta): knowing why the face check did nothing, and what a check scored. Pure; the host feeds it and writes the rows.
 *
 * Why (a report that the face check found no face for a while): a check that never ran left no trace, because the counts row is written only when the
 * verdict changes, the checks stop, or every 30 minutes. Now (1) every check writes one row with its closed outcome and numbers
 * (a steady run of near-identical rows is thinned so the journal stays readable) and (2) when checks are expected (switch on, camera on,
 * a face enrolled) but none ran for a minute, one row says why, in closed words. Never an image or the face's numbers.
 */
import type { FaceIdleWhy, FaceScoreInput, FaceScoreOutcome } from '../../../shared/senses/face-journal';
import type { CheckClass, FaceObservation } from './decision';

export const IDLE_AFTER_MS = 60_000;
/** After one idle row, the next only after this long (still idle). */
export const IDLE_REPEAT_MS = 5 * 60_000;
/** A steady run of the same outcome with a similar score is written at most this often; a change is written at once. */
export const SCORE_STEADY_MS = 30_000;
export const SCORE_STEADY_DELTA = 0.03;

export interface IdleFacts {
  installed: boolean;
  gaveUp: boolean;
  workerFailed: boolean;
  /** The scheduler is active (the ticker should be running). */
  active: boolean;
  /** Frame grabs that gave nothing / analyses that gave nothing since the last check that ran. */
  noFrames: number;
  noResult: number;
}

/** The closed reason nothing ran, from what the host knows. */
export function idleWhy(facts: IdleFacts): FaceIdleWhy {
  if (!facts.installed) return 'models-missing';
  if (facts.gaveUp || facts.workerFailed) return 'worker-failed';
  if (!facts.active) return 'not-started';
  if (facts.noResult > 0 && facts.noResult >= facts.noFrames) return 'no-result';
  return 'no-frames';
}

/** Tracks the time since the last check that ran, while checks are expected; says when to write an idle row. */
export class FaceIdleWatch {
  private since: number | null = null;
  private lastRan = -Infinity;
  private lastRow = -Infinity;

  /** A check ran (any class except skipped). */
  ran(now: number): void { this.lastRan = now; this.lastRow = -Infinity; }

  /** Checks are no longer expected (switch off, camera off, nothing enrolled): the clock starts over next time. */
  stopExpecting(): void { this.since = null; }

  /** Called regularly while checks are expected; the seconds quiet so far when a row is due, else null. */
  due(now: number): number | null {
    if (this.since === null) this.since = now;
    const quiet = now - Math.max(this.since, this.lastRan);
    if (quiet < IDLE_AFTER_MS || now - this.lastRow < IDLE_REPEAT_MS) return null;
    this.lastRow = now;
    return Math.round(quiet / 1000);
  }
}

/** Which closed outcome a journal row carries (a skipped check is not a row). */
export function scoreOutcome(cls: CheckClass): FaceScoreOutcome | null { return cls === 'skipped' ? null : cls; }

/** Thins steady runs of rows: written when the outcome or the score moved, or after SCORE_STEADY_MS. */
export class ScoreRowGate {
  private last: { outcome: FaceScoreOutcome; similarity: number | null; at: number } | null = null;

  admit(outcome: FaceScoreOutcome, similarity: number | null, now: number): boolean {
    const last = this.last;
    const same = last && last.outcome === outcome && ((last.similarity === null) === (similarity === null))
      && (similarity === null || Math.abs(similarity - (last.similarity as number)) < SCORE_STEADY_DELTA) && now - last.at < SCORE_STEADY_MS;
    if (same) return false;
    this.last = { outcome, similarity, at: now };
    return true;
  }

  reset(): void { this.last = null; }
}

/** The check row (the writer adds the character id): numbers and closed words only. */
export function checkRow(cls: CheckClass, observation: FaceObservation | null, which: number | null, clear: boolean): Omit<Extract<FaceScoreInput, { event: 'check' }>, 'characterId'> | null {
  const outcome = scoreOutcome(cls);
  if (!outcome || !observation) return null;
  return { type: 'face-score', event: 'check', outcome, similarity: observation.similarity, which, clear,
    frontal: observation.found ? observation.frontal : 0, det: observation.found ? observation.detScore : 0 };
}
