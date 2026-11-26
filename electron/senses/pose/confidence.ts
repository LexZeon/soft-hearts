/**
 * Per-signal confidence of the pose signal.
 * docs/claude/2026-11-17-pose-confidence.md. Pure functions; the tracker (features.ts) feeds them. Everything is a first guess
 * checked only on synthetic sequences: no real person yet.
 *
 * Facing and posture (a vote over the last 7 frames, the winner is the mode):
 *   confidence = agreement x keypointScore
 *   agreement  = winner votes / max(frames in the window, MIN_VOTES)  (a window shorter than MIN_VOTES is discounted)
 *   keypointScore = mean RTMPose score of the keypoints the winning rule looked at (facing: toward nose + eyes, side nose + the better eye,
 *                   away the shoulders and, inverted, the missing nose and eyes), averaged over the frames that voted for it
 *   'unknown' -> 0.
 * Events (wave, stretch):
 *   confidence = keypointScore x clarity
 *   keypointScore = mean score of the keypoints the test used (wave: wrist, elbow, shoulders; stretch: wrists, elbows, shoulders) over the frames in the test window
 *   clarity = how clearly the motion pattern passed its test: wave the mean of min(1, reversals / WAVE_FULL_REVERSALS) (the test passes at 2)
 *             and min(1, swing range / WAVE_FULL_RANGE) (range of the wrist's sideways position, in shoulder widths; the test needs 0.2 per swing),
 *             stretch min(1, margin / STRETCH_FULL_MARGIN) with margin = the smallest gap, in shoulder widths, between the head line and the higher wrist.
 */

/** A vote over fewer frames than this counts as if the window were this long. */
export const MIN_VOTES = 3;
/** Reversals that make a wave "clearly a wave" (the detector already accepts 2). */
export const WAVE_FULL_REVERSALS = 4;
/** Sideways swing range (shoulder widths) that makes a wave "clearly a wave". */
export const WAVE_FULL_RANGE = 0.6;
/** Wrist height over the head line (shoulder widths) that makes a stretch "clearly a stretch". */
export const STRETCH_FULL_MARGIN = 0.5;

/** The keypoints each rule looks at (COCO-17). */
export const POSTURE_POINTS = { slumped: [0, 5, 6], standing: [5, 6, 11, 12, 13, 14], 'leaning-back': [0, 5, 6], sitting: [0, 5, 6] } as const;
export const WAVE_POINTS = (wrist: number, elbow: number) => [wrist, elbow, 5, 6] as const;
export const STRETCH_POINTS = [9, 10, 7, 8, 5, 6] as const;

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
export const round2 = (value: number) => Math.round(clamp01(value) * 100) / 100;

/** Mean score of some keypoints (a missing score counts as 0). */
export function meanScore(scores: ArrayLike<number>, indices: readonly number[]): number {
  if (!indices.length) return 0;
  let sum = 0;
  for (const i of indices) { const s = scores[i]; sum += Number.isFinite(s) ? s : 0; }
  return clamp01(sum / indices.length);
}

/** The keypoint score behind one facing vote (the keypoints facingOf looked at for that answer). */
export function facingScore(facing: string, scores: ArrayLike<number>): number {
  const nose = scores[0] ?? 0, eyes = Math.max(scores[1] ?? 0, scores[2] ?? 0);
  if (facing === 'toward') return meanScore(scores, [0, 1, 2]);
  if (facing === 'side') return clamp01((nose + eyes) / 2);
  if (facing === 'away') return clamp01((meanScore(scores, [5, 6]) + (1 - Math.max(nose, eyes))) / 2);
  return 0;
}

export interface Vote<T> { value: T; score: number }

/** The confidence of the winning value of a vote window; 0 when the winner is 'unknown' or the window is empty. */
export function voteConfidence<T extends string>(votes: readonly Vote<T>[], winner: T): number {
  if (!votes.length || winner === 'unknown') return 0;
  const mine = votes.filter(vote => vote.value === winner);
  if (!mine.length) return 0;
  const agreement = mine.length / Math.max(votes.length, MIN_VOTES);
  const score = mine.reduce((sum, vote) => sum + clamp01(vote.score), 0) / mine.length;
  return round2(agreement * score);
}

export const waveClarity = (reversals: number, range: number) => (clamp01(reversals / WAVE_FULL_REVERSALS) + clamp01(range / WAVE_FULL_RANGE)) / 2;
export const stretchClarity = (marginInShoulderWidths: number) => clamp01(marginInShoulderWidths / STRETCH_FULL_MARGIN);
export const eventConfidence = (keypointScore: number, clarity: number) => round2(clamp01(keypointScore) * clamp01(clarity));
