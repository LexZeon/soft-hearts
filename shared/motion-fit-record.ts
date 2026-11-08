/**
 * Stored motion scores (universal skeleton step 1, docs/claude/2026-11-06-skeleton-step1.md). The first load of a model scores
 * every library motion on it (src/stage/motion-retarget.ts scan); this is the plain record of those scores the host keeps per
 * model content (electron/motion-fit-store.ts), so the same model's next load uses them instead of converting and scoring all
 * 76 motions again.
 *
 * What is in it: the model half of the conversion's identity (`input`, retargetInputKey: a digest of both rigs and the
 * profile), a stamp of the conversion and check versions (`stamp`), and per library motion its content hash, its pack and
 * motion id, the verdict and its numbers, short issue/adjustment texts in standard part words, and the standard parts it
 * plays without. No path, no URL, no model bone or morph name, nothing of the conversation; never part of a card export.
 * Every string is checked against a short character set without slashes, backslashes or drive colons before it is kept.
 *
 * When it is not used: another stamp (the conversion or the check changed), another input (another model or profile), or a
 * motion whose hash the current library does not have under that id (the library changed): those are scored again.
 */
import { sha256Hex } from './sha256-sync';
import { RETARGET_ALGORITHM_VERSION, RETARGET_VERSION } from './motion-retarget';
import { BODY, FAIL_SHARE, FITTED_BODY, FIT_SAMPLE_SECONDS, JOINT_LIMITS, MOTION_FIT_VERSION, STRUCTURE_TOLERANCE, type FitCheck, type MotionFitStatus } from './motion-fit';
import { COLLISION_PROXY_VERSION } from './collision-proxy';
import { CONTACT_TOLERANCE } from './motion-contact';
import { isStandardPart, type FingerSlot, type StandardBone } from './universal-skeleton';

export const MOTION_FIT_RECORD_VERSION = 1;
/**
 * Which conversion and check produced a score: both versions and a digest of the check's thresholds. A stored record with
 * another stamp is ignored (scored again), so changing any threshold, or bumping RETARGET_ALGORITHM_VERSION or
 * MOTION_FIT_VERSION, needs nothing else.
 */
export const MOTION_SCORE_STAMP = `r${RETARGET_VERSION}.${RETARGET_ALGORITHM_VERSION}-f${MOTION_FIT_VERSION}-c${COLLISION_PROXY_VERSION}-${sha256Hex(JSON.stringify({
  FIT_SAMPLE_SECONDS, FAIL_SHARE, BODY, FITTED_BODY, JOINT_LIMITS, STRUCTURE_TOLERANCE, CONTACT_TOLERANCE,
})).slice(0, 16)}`;

export interface StoredMotionFit {
  /** The library motion's content hash (shared/motion-catalog.json). */
  sha256: string;
  /** Its pack and motion id in the library. */
  pack: string;
  motion: string;
  status: MotionFitStatus;
  basis: 'source' | 'sampled';
  samples: number;
  /** "check: where", standard part words ("joint-limit: elbowLeft"). */
  issues: string[];
  adjustments: string[];
  /** Standard parts (bones or finger joints) the motion moves that bind to nothing on this model. */
  lost: (StandardBone | FingerSlot)[];
}
export interface MotionFitRecord {
  version: typeof MOTION_FIT_RECORD_VERSION;
  stamp: string;
  /** retargetInputKey of the plan ("fit:" + sha256). */
  input: string;
  motions: StoredMotionFit[];
}

export const MAX_STORED_MOTIONS = 256;
const HEX64 = /^[0-9a-f]{64}$/;
const INPUT = /^fit:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const STAMP = /^[a-z0-9.-]{1,64}$/i;
/** Short plain text: letters, digits, spaces and a few marks. No slash, backslash or colon: a path cannot be written with it. */
const TEXT = /^[A-Za-z0-9 ()°,.'<>=+-]{1,160}$/u;
const CHECKS: readonly FitCheck[] = ['penetration', 'floating', 'sinking', 'sliding', 'joint-limit', 'stretch', 'structure', 'contact'];
const STATUSES: readonly MotionFitStatus[] = ['ok', 'adjusted', 'hidden'];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** "check: where" with a known check and plain text after it. */
export const isStoredIssue = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const at = value.indexOf(': ');
  return at > 0 && CHECKS.includes(value.slice(0, at) as FitCheck) && TEXT.test(value.slice(at + 2));
};
export const isStoredText = (value: unknown): value is string => typeof value === 'string' && TEXT.test(value);

function acceptMotion(value: unknown): StoredMotionFit | null {
  if (!isObject(value)) return null;
  const { sha256, pack, motion, status, basis, samples, issues, adjustments, lost } = value;
  if (typeof sha256 !== 'string' || !HEX64.test(sha256) || typeof pack !== 'string' || !ID.test(pack) || typeof motion !== 'string' || !ID.test(motion)
    || !STATUSES.includes(status as MotionFitStatus) || (basis !== 'source' && basis !== 'sampled')
    || !Number.isInteger(samples) || (samples as number) < 0 || (samples as number) > 100_000
    || !Array.isArray(issues) || issues.length > 16 || !issues.every(isStoredIssue)
    || !Array.isArray(adjustments) || adjustments.length > 8 || !adjustments.every(isStoredText)
    || !Array.isArray(lost) || lost.length > 64 || !lost.every(isStandardPart)) return null;
  // Rebuilt from the known fields only: nothing else a caller put in survives.
  return { sha256, pack, motion, status: status as MotionFitStatus, basis, samples: samples as number, issues: [...issues], adjustments: [...adjustments], lost: [...lost] };
}

/**
 * A stored record as plain, checked data, or null when anything in it is off (then nothing of it is used: the motions are
 * simply scored again). With `expect`, also null when it was made by another conversion/check or for another input.
 */
export function acceptMotionFitRecord(value: unknown, expect?: { stamp: string; input: string }): MotionFitRecord | null {
  try {
    if (!isObject(value) || value.version !== MOTION_FIT_RECORD_VERSION || typeof value.stamp !== 'string' || !STAMP.test(value.stamp)
      || typeof value.input !== 'string' || !INPUT.test(value.input) || !Array.isArray(value.motions) || value.motions.length > MAX_STORED_MOTIONS) return null;
    if (expect && (value.stamp !== expect.stamp || value.input !== expect.input)) return null;
    const bySha = new Map<string, StoredMotionFit>();
    for (const row of value.motions) {
      const motion = acceptMotion(row);
      if (!motion) return null;
      bySha.delete(motion.sha256); bySha.set(motion.sha256, motion);
    }
    return { version: MOTION_FIT_RECORD_VERSION, stamp: value.stamp, input: value.input, motions: [...bySha.values()] };
  } catch { return null; }
}

/**
 * What the host keeps after a save: the motions of both when the two records come from the same conversion, check and
 * input (the newer score of a motion wins), else just the newer record. Bounded to MAX_STORED_MOTIONS (the newest kept).
 */
export function mergeMotionFitRecords(previous: MotionFitRecord | null, next: MotionFitRecord): MotionFitRecord {
  const motions = new Map<string, StoredMotionFit>();
  if (previous && previous.stamp === next.stamp && previous.input === next.input) for (const motion of previous.motions) motions.set(motion.sha256, motion);
  for (const motion of next.motions) { motions.delete(motion.sha256); motions.set(motion.sha256, motion); }
  return { version: MOTION_FIT_RECORD_VERSION, stamp: next.stamp, input: next.input, motions: [...motions.values()].slice(-MAX_STORED_MOTIONS) };
}
