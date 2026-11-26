/**
 * I-117: what the windows hear about the safety card (desk:safety-card) and the one answer they may give (safetyCardAnswer).
 * The view carries only the region (the windows build the card from shared/safety/crisis-lines.ts); never any text of the user's.
 */
import { isCrisisRegion, type CrisisRegion } from './crisis-lines';
import type { SafetyAnswer } from './state';

export interface SafetyCardView {
  readonly open: boolean;
  /** Changes each time the card shows; an answer for an older card is ignored. '' before the first. */
  readonly id: string;
  readonly region: CrisisRegion;
}
export interface SafetyCardAnswer { readonly id: string; readonly answer: SafetyAnswer }

export const CLOSED_SAFETY_CARD: SafetyCardView = Object.freeze({ open: false, id: '', region: 'other' });

/** Strict: exactly { id, answer } with a short id and one of the two answers; anything else is null. */
export function readSafetyCardAnswer(value: unknown): SafetyCardAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'answer,id') return null;
  if (typeof record.id !== 'string' || !/^card-\d{1,9}$/u.test(record.id)) return null;
  if (record.answer !== 'safe' && record.answer !== 'close') return null;
  return { id: record.id, answer: record.answer };
}

export function readSafetyCardView(value: unknown): SafetyCardView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.open !== 'boolean' || typeof record.id !== 'string' || record.id.length > 20 || !isCrisisRegion(record.region)) return null;
  return { open: record.open, id: record.id, region: record.region };
}
