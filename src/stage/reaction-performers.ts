/**
 * I-037 新的反应方式, stage side: the reaction cues that need the stage itself (shared/behaviors/reactions/stage.ts), played on
 * whatever model is loaded. MmdStage.playReaction is the only caller (one line of wiring); the stage's own gates still apply.
 *
 * 害羞 (shy): the universal shy performance (I-038 part A, src/stage/shy-show.ts `playUniversalShy`): the model profile's head,
 * upper body and eye bones and its validated face slots, on Gene and on any other model alike; parts a model lacks are skipped and
 * named. It never uses the old Gene-only shy clip (MmdStage previewSurprise / SHY_CLIP_ID).
 *
 * R29 (smooth, never a jump): asked again while the shy show is still coming in or holding, it keeps going and eases to the higher
 * strength (show-blend.ts) — so being praised twice makes her stay shy a little longer, never snaps her head back. Another kind
 * of performance (a Gene preview, a personal pose or body preview) is never cut: the cue is refused ('busy'). The show starts and
 * ends at exactly 0 with continuous speed, and fades out over 0.3 s when a pat, a window move or a hidden window interrupts it.
 */
import type { ExpressionRecipe, ExpressionSupport } from '../../shared/expression-preview';
import { readReactionStageCue } from '../../shared/behaviors/reactions/stage';
import type { ReactionLevel } from '../../shared/behaviors/reactions/knobs';
import { playUniversalShy } from './shy-show';

export type ReactionStageResult = 'played' | 'busy' | 'unsupported' | 'invalid';

export interface ReactionStagePort {
  /** Another kind of performance is on now (a Gene preview, a personal pose or body preview): a shy show would cut it. */
  showingOther(): boolean;
  /** MmdStage.playExpression: the model-agnostic show at a strength (null for an unknown recipe or a disposed stage). */
  playExpression(recipe: ExpressionRecipe, strength?: number): ExpressionSupport | null;
}

/** The level's strength (0–1; 1 = the preview buttons' full show). */
export const SHY_STRENGTH: Readonly<Record<ReactionLevel, number>> = Object.freeze({ light: 0.6, mid: 0.8, strong: 1 });

/** 害羞 at `strength` 0–1 on the loaded model (the universal performance; see the file header). */
export function playShy(port: ReactionStagePort, strength: number): ReactionStageResult {
  if (port.showingOther()) return 'busy';
  return playUniversalShy(port, strength).played ? 'played' : 'unsupported';
}

/** One cue from the host (`desk:reaction`). */
export function playReactionCue(value: unknown, port: ReactionStagePort): ReactionStageResult {
  const cue = readReactionStageCue(value);
  if (!cue) return 'invalid';
  switch (cue.kind) {
    case 'shy': return playShy(port, SHY_STRENGTH[cue.level]);
  }
}
