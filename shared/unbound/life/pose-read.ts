/**
 * Unbound v1 step 4 (afternoon addition B): the ONE place her free time reads the camera's pose signal. Only these parts of it:
 * whether somebody is there, which way they face, how they sit, a wave or a stretch, each with how sure the sensing is. Never the
 * frame, never where in the frame, never the body points.
 *
 * Confidence comes from the pose sensing part (merged 2026-11-17, 8db0f2d7; not edited here): PoseSignal carries
 * `facingConfidence`, `postureConfidence` and `eventConfidence` (0..1), banded by shared/senses' poseConfidenceBand, the one cut-off
 * every consumer shares. A missing confidence (an older signal, a missing field) is 'unsure': she reacts to nothing she is not sure of.
 *
 *   sure   → she reacts, and may be told it as a fact
 *   maybe  → only a glance, told with "好像"
 *   unsure → as if not seen, never told
 */
import { poseConfidenceBand, type PoseConfidenceBand } from '../../senses';

export type ConfidenceBand = PoseConfidenceBand;

/** The shared bands (shared/senses/pose-confidence.ts). */
export function confidenceBand(value: number | null | undefined): ConfidenceBand { return poseConfidenceBand(value); }

export type PoseFacingWord = 'toward' | 'side' | 'away';
export type PosePostureWord = 'sitting' | 'standing' | 'slumped' | 'leaning-back';
export interface Banded<T> { value: T; band: ConfidenceBand }
/** What her free time knows of the camera now (memory only). */
export interface PoseRead {
  present: boolean;
  facing: Banded<PoseFacingWord> | null;
  posture: Banded<PosePostureWord> | null;
  /** One-shot events of this signal, with their bands (only wave and stretch). */
  wave: ConfidenceBand | null;
  stretch: ConfidenceBand | null;
}

const FACINGS: readonly string[] = ['toward', 'side', 'away'];
const POSTURES: readonly string[] = ['sitting', 'standing', 'slumped', 'leaning-back'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A pose signal (already parsed by the pose host) → the parts above; anything else in it is never read. Null: no signal. */
export function readPose(signal: unknown): PoseRead | null {
  if (!record(signal) || typeof signal.present !== 'boolean') return null;
  const present = signal.present;
  const facing = present && typeof signal.facing === 'string' && FACINGS.includes(signal.facing)
    ? { value: signal.facing as PoseFacingWord, band: confidenceBand(signal.facingConfidence as number | undefined) } : null;
  const posture = present && typeof signal.posture === 'string' && POSTURES.includes(signal.posture)
    ? { value: signal.posture as PosePostureWord, band: confidenceBand(signal.postureConfidence as number | undefined) } : null;
  const events = present && Array.isArray(signal.events) ? signal.events : [];
  const eventBands = record(signal.eventConfidence) ? signal.eventConfidence : {};
  const event = (name: 'wave' | 'stretch'): ConfidenceBand | null => events.includes(name) ? confidenceBand(eventBands[name] as number | undefined) : null;
  return { present, facing, posture, wave: event('wave'), stretch: event('stretch') };
}

/** Taken as true (sure), as a "maybe" (only a glance, "好像"), or not at all. */
export const seen = (band: ConfidenceBand | null | undefined): boolean => band === 'sure' || band === 'maybe';
