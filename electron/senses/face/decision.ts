/**
 * I-135: is the person at the computer the user? A pure state machine over single checks.
 *
 * User decision
 *  - Clearly the user (similarity ≥ sameCosine)                      → 'you' at once.
 *  - Uncertain (no face, side face, dark, blurry, small, middling)   → stays 'you'; while 'not-you', `unsureToReturn` of
 *    these in a row bring it back to 'you'.
 *  - Clearly not the user (clear frontal face, similarity < clearlyNotCosine) `notYouStreak` times in a row → 'not-you'.
 *  - No checks for `notYouExpireMs`, the feature or camera going off, or nothing enrolled: 'you'.
 */
import { FACE_KNOBS, type FaceKnobs } from './knobs';

export type FaceVerdict = 'you' | 'not-you';

/** One check's measurements (numbers only; never pixels). `similarity` is the best cosine against the enrolled set. */
export interface FaceObservation {
  found: boolean;
  detScore: number;
  /** Face box width in source pixels. */
  faceWidth: number;
  frontal: number;
  sharpness: number;
  brightness: number;
  similarity: number | null;
}

/**
 * match: clearly the user. clear-not: clearly someone else (one check). weak-not: a clear face in the grey band just under the official
 * "same person" line (half a low, never resets a streak). unsure: a face, but not clear or a middling score.
 * no-face: nobody in view. skipped: the check could not run (nothing enrolled, worker not ready, no frame).
 */
export type CheckClass = 'match' | 'clear-not' | 'weak-not' | 'unsure' | 'no-face' | 'skipped';

export function isClearFace(observation: FaceObservation, knobs: FaceKnobs = FACE_KNOBS): boolean {
  const q = knobs.quality;
  return observation.found && observation.detScore >= q.minDetScore && observation.faceWidth >= q.minFaceWidthPx
    && observation.frontal >= q.minFrontal && observation.sharpness >= q.minSharpness
    && observation.brightness >= q.minBrightness && observation.brightness <= q.maxBrightness;
}

export function classifyCheck(observation: FaceObservation | null, knobs: FaceKnobs = FACE_KNOBS): CheckClass {
  if (!observation) return 'skipped';
  if (!observation.found) return 'no-face';
  const similarity = observation.similarity;
  if (similarity === null || !Number.isFinite(similarity)) return 'skipped';
  // A confident match does not need a perfect picture: it can only ever confirm the user.
  if (similarity >= knobs.match.sameCosine) return 'match';
  // A clear face under the official line is a low: far under it a clear low, in the grey band just under it a weak low.
  if (isClearFace(observation, knobs)) return similarity < knobs.match.clearlyNotCosine ? 'clear-not' : 'weak-not';
  return 'unsure';
}

export interface DecisionStep { state: FaceVerdict; changed: boolean }

export class FaceDecision {
  private current: FaceVerdict = 'you';
  private lowStreak = 0;
  private unsureStreak = 0;
  private lastCheckAt = -Infinity;

  constructor(private readonly knobs: FaceKnobs = FACE_KNOBS) {}

  get state(): FaceVerdict { return this.current; }

  /** Feed one check's class. 'skipped' changes nothing but the clock. */
  step(check: CheckClass, now: number): DecisionStep {
    const before = this.current;
    if (check === 'skipped') { this.expire(now); return { state: this.current, changed: this.current !== before }; }
    this.lastCheckAt = now;
    if (check === 'match') { this.current = 'you'; this.lowStreak = 0; this.unsureStreak = 0; }
    else if (check === 'clear-not' || check === 'weak-not') {
      // Still under the official line on a clear face: it is never "the user", so it does not bring 'you' back either.
      this.unsureStreak = 0;
      this.lowStreak += check === 'clear-not' ? 1 : this.knobs.match.weakNotWeight;
      if (this.lowStreak >= this.knobs.match.notYouStreak) this.current = 'not-you';
    } else {
      // Uncertain counts as the user: it breaks a streak of lows, and enough of them in a row end 'not-you'.
      this.lowStreak = 0;
      if (this.current === 'not-you') {
        this.unsureStreak++;
        if (this.unsureStreak >= this.knobs.match.unsureToReturn) { this.current = 'you'; this.unsureStreak = 0; }
      }
    }
    return { state: this.current, changed: this.current !== before };
  }

  /** 'not-you' without any check for a while goes back to 'you' (camera stalled, checks stopped). */
  expire(now: number): DecisionStep {
    const before = this.current;
    if (this.current === 'not-you' && now - this.lastCheckAt >= this.knobs.match.notYouExpireMs) this.reset();
    return { state: this.current, changed: this.current !== before };
  }

  /** Feature off, camera off, enrolment changed: back to 'you' with nothing remembered. */
  reset(): void { this.current = 'you'; this.lowStreak = 0; this.unsureStreak = 0; this.lastCheckAt = -Infinity; }
}
