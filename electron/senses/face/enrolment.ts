/**
 * I-135: which embeddings are kept for the user's face. Pure rules; storage is electron/senses/face/store.ts.
 *
 * User decision enrolment keeps several embeddings, and later, when a match is
 * very confident and looks different from what is stored (other light, angle), one more is added now and then, up to a cap.
 * Only numbers are kept, never a picture. Enrolled embeddings are never replaced by automatic ones.
 */
import type { FaceEnrolHint } from '../../../shared/senses/face-check';
import { isClearFace, type FaceObservation } from './decision';
import { FACE_KNOBS, type FaceKnobs } from './knobs';
import { cosine, l2normalize } from './score';

export interface EnrolledFace {
  /** Unit-length embedding (128 numbers). */
  vector: Float32Array;
  source: 'enrol' | 'auto';
  /** When it was added (ms since epoch); only for the interval rule. */
  at: number;
}

/** What to tell the user about this enrolment frame, in the order a person can fix them: nobody, too far, light, angle, sharpness. */
export function enrolHint(observation: FaceObservation | null, knobs: FaceKnobs = FACE_KNOBS): FaceEnrolHint {
  if (!observation) return 'starting';
  if (!observation.found) return 'no-face';
  const q = knobs.quality;
  if (observation.faceWidth < q.minFaceWidthPx) return 'too-small';
  if (observation.brightness < q.minBrightness) return 'too-dark';
  if (observation.brightness > q.maxBrightness) return 'too-bright';
  if (observation.frontal < q.minFrontal || observation.detScore < q.minDetScore) return 'off-angle';
  if (observation.sharpness < q.minSharpness) return 'blurry';
  return 'good';
}

export type EnrolSampleOutcome = 'taken' | 'no-face' | 'not-clear' | 'duplicate' | 'different-person' | 'full';

/**
 * One frame during enrolment. Taken only when the face is clear and looks like the samples so far (someone else
 * stepping in mid-enrolment is not mixed in); an identical frame is skipped.
 */
export function judgeEnrolSample(samples: readonly Float32Array[], observation: FaceObservation, embedding: ArrayLike<number> | null,
  knobs: FaceKnobs = FACE_KNOBS): EnrolSampleOutcome {
  if (samples.length >= knobs.enrol.samples) return 'full';
  if (!observation.found || !embedding) return 'no-face';
  if (!isClearFace(observation, knobs)) return 'not-clear';
  const vector = l2normalize(embedding);
  for (const sample of samples) {
    const similarity = cosine(vector, sample);
    if (similarity >= knobs.enrol.duplicateCosine) return 'duplicate';
    if (similarity < knobs.match.sameCosine) return 'different-person';
  }
  return 'taken';
}

/** Should this confident match be added to the stored set? */
export function shouldAugment(stored: readonly EnrolledFace[], observation: FaceObservation, embedding: ArrayLike<number> | null,
  now: number, knobs: FaceKnobs = FACE_KNOBS): boolean {
  const rule = knobs.augment;
  if (!embedding || !stored.length || stored.length >= rule.cap) return false;
  if (!isClearFace(observation, knobs)) return false;
  if (observation.similarity === null || observation.similarity < rule.minCosine) return false;
  if (observation.frontal < rule.minFrontal || observation.detScore < rule.minDetScore || observation.sharpness < rule.minSharpness) return false;
  const last = Math.max(...stored.map(face => face.at));
  if (now - last < rule.minIntervalMs) return false;
  const vector = l2normalize(embedding);
  // Diversity: something new (light, angle), not the same look again.
  return stored.every(face => cosine(vector, face.vector) < rule.maxSimilarToStored);
}
