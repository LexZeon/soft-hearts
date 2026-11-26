// 心情和反应 (mood): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { BlushCalibrationView, MoodInput, MoodParameterIdentity, MoodView } from '../mood';

export interface MoodDesktopAPI {
  getMood(): Promise<MoodView>;
  onMood(callback: (view: MoodView) => void): () => void;
  setMoodDeveloperMode(enabled: boolean): Promise<MoodView>;
  setMoodExpressions(enabled: boolean): Promise<MoodView>;
  setMoodParameters(parameters: unknown, expected: MoodParameterIdentity): Promise<MoodView>;
  restoreMoodParameters(expected: MoodParameterIdentity): Promise<MoodView>;
  getBlushCalibration(): Promise<BlushCalibrationView>;
  setBlushCalibration(modelKey: string, calibration: unknown): Promise<BlushCalibrationView>;
  onBlushCalibration(callback: (view: BlushCalibrationView) => void): () => void;
  moodInteraction(input: MoodInput): Promise<MoodView>;
  /** I-027 心情调整员 (electron/mood/mood-judge/): the switch in 隐私与设置 (default off; the control window changes it) and its daily cap. */
  getMoodJudge(): Promise<import('../mood').MoodJudgeSwitchView>;
  setMoodJudge(enabled: boolean): Promise<import('../mood').MoodJudgeSwitchView>;
  onMoodJudge(callback: (view: import('../mood').MoodJudgeSwitchView) => void): () => void;
  /** I-037 新的反应方式 (electron/mood/reactions/): the switch in 隐私与设置 (on by default in every version, 2026-11-07) and the current character's six 反应倾向 (角色页). */
  getReactions(): Promise<import('../mood').ReactionSwitchView>;
  setReactions(enabled: boolean): Promise<import('../mood').ReactionSwitchView>;
  getReactionDispositions(): Promise<import('../mood').ReactionDispositionsView>;
  /** Some or all of the six (0–100 integers), or null: back to what the character card gives. */
  setReactionDispositions(values: Partial<Record<import('../mood').DispositionId, number>> | null): Promise<import('../mood').ReactionDispositionsView>;
  onReactions(callback: (view: import('../mood').ReactionsBroadcast) => void): () => void;
  /** Companion window: one reaction cue for its stage (src/mood/reaction-performers.ts). */
  onReaction(callback: (cue: unknown) => void): () => void;
  /** Companion window: what its stage did with a reaction cue ('played', 'busy', 'unsupported' or 'invalid'); the host records that, not just "sent". */
  reactionResult(input: import('../mood').ReactionStageReply): Promise<boolean>;
  /** I-017: the companion window's music state for the next chat turn's perception line (shared/mood/her-state.ts; only the companion window, only that shape). */
  noteStageState(value: import('../mood').StageStateReport): Promise<boolean>;
  /** I-136 step 5a 拉她: the companion window's pull report (shared/behaviors/pull/session.ts); only the companion window, fixed words and clamped numbers (the host adds the place and time). */
  petTouch(report: import('../stage').PullReport): Promise<boolean>;
}
