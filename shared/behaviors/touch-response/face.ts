/**
 * I-136: which face she shows for a click, a pinch or a pull, picked here from her mood numbers and character (no Claude). The same
 * scoring as I-037's reaction table (shared/behaviors/reactions/choose.ts scoreReactions): base + character lean + mood label + the
 * mood numbers (hormones against the baseline, B, M, A) + part + how hard + sleepy − recently shown + a little randomness. The top
 * one wins (there is always a face: "blank" is a face too).
 */
import { scoreReactions } from '../reactions/choose';
import type { ReactionCandidate, ReactionNow } from '../reactions/interface';
import type { TouchFaceEvent, TouchFaceId, TouchFaceView } from './interface';
import { TOUCH_FACES, TOUCH_RESPONSE_KNOBS, type TouchResponseKnobs } from './knobs';
import type { TouchPart } from '../../mood/touch';

export interface TouchFacePick {
  readonly face: TouchFaceId;
  readonly score: number;
  /** Every face's score, highest first (developer view and tests). */
  readonly scores: readonly Pick<ReactionCandidate, 'id' | 'score' | 'parts'>[];
}

/** The face for this touch. `now` is the same "she at this moment" the body reactions read (with the mood numbers). */
export function pickTouchFace(event: TouchFaceEvent, now: ReactionNow, options: { random?: () => number; knobs?: Pick<TouchResponseKnobs, 'faceJitter'> } = {}): TouchFacePick {
  const knobs = options.knobs ?? TOUCH_RESPONSE_KNOBS;
  const scoring = scoreReactions(event, now, { table: TOUCH_FACES, random: options.random,
    knobs: { offset: 0, jitter: knobs.faceJitter, candidates: Object.keys(TOUCH_FACES).length, floor: -Infinity } });
  const top = scoring.candidates[0];
  const face = (top?.id ?? 'blank') as TouchFaceId;
  return { face, score: top?.score ?? 0, scores: scoring.candidates.map(item => ({ id: item.id, score: item.score, parts: item.parts })) };
}

/** The view the stages read (MoodView.touchFace). */
export function touchFaceView(id: string, event: TouchFaceEvent, face: TouchFaceId, at: number, holdMs: number, part?: TouchPart | null): TouchFaceView {
  const row = TOUCH_FACES[face];
  return Object.freeze({ id, kind: event, face, smile: row.smile, eyelids: row.eyelids, at, until: at + Math.max(0, holdMs), ...(part ? { part } : {}) });
}
