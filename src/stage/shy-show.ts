/**
 * I-038 part A (2) / I-037: 害羞 and 惊喜 as whole performances on any model, for whoever wants her to show them — the new
 * reaction system first (src/stage/reaction-performers.ts `playShy(strength)` can call `playUniversalShy(stage, strength)`).
 *
 * What plays is the E1 show (expression-show.ts): every channel is semantic — the model profile's head, upper body and eye
 * bones, and the face slots the profile validated by where their vertices move (browUp, sad, surprise, smileEyes, mouthSmile,
 * o, blink as eyelids) plus the procedural blush — so it is the same performance on Gene, a renamed Gene or another model, and a
 * part the model lacks is skipped and named (`missing`). Played through procedural life's preview channel, under the same owners
 * as the preview buttons (a pat, a window move, hidden fade it out over 0.3 s and back in).
 *
 * Strength scales the whole performance (bones and face alike). Asked again while it is still coming in or holding, it keeps
 * going and takes the higher strength (eased); asked again later, or the other recipe, it starts again from what shows
 * (show-blend.ts). Nothing here touches the mood, the chat, the journal or a file.
 */
import type { ExpressionRecipe, ExpressionSupport } from '../../shared/expression-preview';

/** The part of the stage this needs (MmdStage.playExpression). */
export interface ShowStage { playExpression(recipe: unknown, strength?: number): ExpressionSupport | null }
export interface ShowOutcome {
  /** True when it now plays (or keeps playing) on this model. */
  played: boolean;
  /** What of the performance this model shows and what it skips (null: no model loaded yet). */
  support: ExpressionSupport | null;
  /** Why it did not play ('' when it did). */
  reason: string;
}

function play(stage: ShowStage | null | undefined, recipe: ExpressionRecipe, strength: number): ShowOutcome {
  if (!stage) return { played: false, support: null, reason: '舞台还没准备好。' };
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength <= 0) return { played: false, support: null, reason: '强度为 0，不做。' };
  const support = stage.playExpression(recipe, Math.min(1, strength));
  if (!support) return { played: false, support: null, reason: '舞台没有接受这个表演。' };
  return support.usable ? { played: true, support, reason: '' } : { played: false, support, reason: support.reason };
}

/** 害羞 at `strength` (0..1; 1 = the preview buttons' full show) on the loaded model. */
export const playUniversalShy = (stage: ShowStage | null | undefined, strength: number): ShowOutcome => play(stage, 'shy', strength);
/** 惊喜 at `strength` (0..1). */
export const playUniversalSurprise = (stage: ShowStage | null | undefined, strength: number): ShowOutcome => play(stage, 'surprise', strength);
