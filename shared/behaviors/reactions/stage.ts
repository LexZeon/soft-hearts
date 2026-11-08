/**
 * I-037: the one cue the reaction host sends to the pet window's stage (`desk:reaction`; src/stage/reaction-performers.ts plays it).
 * Only reactions that need the stage itself go this way (the shy show); a blush, a happy lift and the small actions use the mood host
 * and her small-action path. Data only: an id, a closed kind and a level.
 */
import { REACTION_LEVELS, type ReactionLevel } from './knobs';

export const REACTION_STAGE_KINDS = ['shy'] as const;
export type ReactionStageKind = typeof REACTION_STAGE_KINDS[number];
export interface ReactionStageCue { readonly id: string; readonly kind: ReactionStageKind; readonly level: ReactionLevel }

/** A cue from the host (or null when it is anything else). */
export function readReactionStageCue(value: unknown): ReactionStageCue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'id,kind,level') return null;
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(v.id)) return null;
  if (!(REACTION_STAGE_KINDS as readonly string[]).includes(v.kind as string) || !(REACTION_LEVELS as readonly string[]).includes(v.level as string)) return null;
  return { id: v.id, kind: v.kind as ReactionStageKind, level: v.level as ReactionLevel };
}

/** What the stage says it did with a cue (src/stage/reaction-performers.ts ReactionStageResult), or 'no-answer' when the host heard nothing in time. */
export const REACTION_STAGE_ANSWERS = ['played', 'busy', 'unsupported', 'invalid', 'no-answer'] as const;
export type ReactionStageAnswer = typeof REACTION_STAGE_ANSWERS[number];
/** The pet window's answer to one cue (`desk:reactionResult`; exactly these two fields). 'no-answer' is the host's own word, never accepted from the window. */
export interface ReactionStageReply { readonly id: string; readonly result: Exclude<ReactionStageAnswer, 'no-answer'> }

export function readReactionStageReply(value: unknown): ReactionStageReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'id,result') return null;
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(v.id)) return null;
  if (typeof v.result !== 'string' || v.result === 'no-answer' || !(REACTION_STAGE_ANSWERS as readonly string[]).includes(v.result)) return null;
  return { id: v.id, result: v.result as ReactionStageReply['result'] };
}
