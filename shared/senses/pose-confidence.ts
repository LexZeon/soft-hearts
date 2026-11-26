/**
 * How far to trust a pose confidence (0..1): the three words every consumer shares, so none invents its own cut-offs.
 * The two cut-offs are first guesses checked only on synthetic sequences (docs/claude/2026-11-17-pose-confidence.md); tune them
 * once a real person has used it. Missing or non-finite is 'unsure'.
 */
export const POSE_SURE_AT = 0.7;
export const POSE_MAYBE_AT = 0.4;

export type PoseConfidenceBand = 'sure' | 'maybe' | 'unsure';

export function poseConfidenceBand(value: number | null | undefined): PoseConfidenceBand {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unsure';
  return value >= POSE_SURE_AT ? 'sure' : value >= POSE_MAYBE_AT ? 'maybe' : 'unsure';
}
