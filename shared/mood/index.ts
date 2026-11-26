// 心情和反应 (part 5), shared side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/mood/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part mood`), including
// the names other parts use from this part's behaviour folders, which stay in shared/behaviors/ like the other parts'.
// The mood model itself (hormones, mood values, labels, the proactive-talk gate) is foundation: shared/foundation/mood.ts.
// Not here (their types are), and imported directly by their users:
//   - values only the companion window uses, which run code when loaded (Object.freeze), so through this page the host bundle would carry
//     them: touch-response/view (MmdStage pinchFacePick); (sleep-body is the stage's since the wiring rewrite step 1);
//   - values only the host uses, so the control window bundle does not carry them: mood-judge/choose (memory journal), touch-feed-effect
//     choose and knobs (the feed-cue behaviour), her-state-words (the agent channel). (rps-personality is the initiative part's since the wiring rewrite step 1.)
// Also imported directly: by the Unbound window (src/unbound/showcase/page.ts blush, shared/unbound/typing.ts TOUCH_PARTS), since
// through this page vite would split this part's shared modules into a chunk the Unbound window loads too (~88 KB); and where this
// page would close a runtime import cycle (rps-personality -> the initiative page -> inner-loop.ts / perception-rule.ts):
// shared/initiative/inner-loop.ts (fatigue, realer-emotions), shared/brain/perception-rule.ts (her-state).
// Untangling waits for the stage and core parts and the wiring rewrite.

// Behaviour folders of this part (shared/behaviors/blush, mood-judge, reactions, sleep-rhythm, touch-feed-effect, touch-response).
export { proceduralBlushDepth } from '../behaviors/blush/choose';
export { MOOD_JUDGE_WHY_IDS, MOOD_JUDGE_WHYS } from '../behaviors/mood-judge/interface';
export type { MoodJudgeSwitchView, MoodJudgeWhyId } from '../behaviors/mood-judge/interface';
export { deriveDispositions, DISPOSITION_IDS, DISPOSITIONS } from '../behaviors/reactions/dispositions';
export type { DispositionCard, DispositionId, Dispositions } from '../behaviors/reactions/dispositions';
export { REACTION_EVENT_IDS, REACTION_EVENTS } from '../behaviors/reactions/events';
export type { ReactionEventId } from '../behaviors/reactions/events';
export { REACTION_BLOCK_WORDS, REACTION_BLOCKS, REACTION_DECIDERS, REACTION_HAIKU_OUTCOMES } from '../behaviors/reactions/interface';
export type { ReactionBlock, ReactionDecider, ReactionHaikuOutcome } from '../behaviors/reactions/interface';
export { REACTION_LEVEL_WORDS, REACTION_LEVELS, REACTION_TABLE } from '../behaviors/reactions/knobs';
export type { ReactionLevel } from '../behaviors/reactions/knobs';
export type { ReactionStageReply } from '../behaviors/reactions/stage';
export type { ReactionDispositionsView, ReactionsBroadcast, ReactionSwitchView } from '../behaviors/reactions/views';
export { nightAt, nightWindow } from '../behaviors/sleep-rhythm/rhythm';
export type { TouchFeedLandingId } from '../behaviors/touch-feed-effect/knobs';
export { TOUCH_EPISODE_KINDS, TOUCH_FACE_IDS, TOUCH_SPEAK_OUTCOMES } from '../behaviors/touch-response/interface';
export type { TouchEpisodeKind, TouchFaceId, TouchSpeakOutcome } from '../behaviors/touch-response/interface';
export { TOUCH_FACES } from '../behaviors/touch-response/knobs';
// The mood's wire view and inputs.
export { MOOD_LABELS } from './mood-runtime';
export type { MoodInput, MoodParameterIdentity, MoodView } from './mood-runtime';
// Blush profiles.
export { DEFAULT_BLUSH_CALIBRATION, validateBlushCalibration } from './blush';
export type { BlushCalibration, BlushCalibrationView } from './blush';
// Fatigue: the runtime view and the rules.
export type { FatigueView } from './fatigue-runtime';
export { DEFAULT_FATIGUE_PARAMETERS, FATIGUE_WORDS } from './fatigue';
export type { FatigueParameters, FatiguePhase } from './fatigue';
// Her needs and her state (words for the channel).
export { HER_NEED_IDS, herNeedVisibility, isHerNeedId, scaledHerNeedPresentation } from './her-needs';
export type { HerNeedEvent, HerNeedId, HerNeedView } from './her-needs';
export type { HerStateSource } from './her-state-words';
export { briefHearingWords, contactWords, hearingOff, hearingWords } from './her-state';
export type { HeardKind, HerContact, HerStateNow, StageMusicState, StageStateReport } from './her-state';
// Reactions to the user's pose.
export { POSE_FOLLOW_KINDS, readPoseReactionView } from './pose-reactions';
export type { PoseCharacter, PoseCoverCue, PoseFollowKind } from './pose-reactions';
// Realer emotions and how long they last.
export { DEFAULT_REALER_DURATION, isRealerDuration, realerStatus, realerUntil } from './realer-duration';
export type { RealerDuration } from './realer-duration';
export { REALER_EMOTIONS_CHAT_TEXT, REALER_EMOTIONS_CONSENT, REALER_EMOTIONS_INNER_LOOP_RULE, REALER_EMOTIONS_SESSION_TAG } from './realer-emotions';
// Her rock-paper-scissors personality.
// Words that wake her a little; touch kinds.
export { explicitWakeRequest } from './sleep-wake-words';
export { PULL_RESPONSES, TOUCH_PART_WORDS, TOUCH_PARTS, TOUCH_PLACES } from './touch';
export type { PullEnd, PullResponse, TouchPart, TouchPlace } from './touch';
export { headTopTouch, isEyeBoneName, partOfBoneName, sideOfBoneName, touchOfBoneChain, HEAD_TOP_FROM_EYES } from './touch-part';
export type { BoneTouch } from './touch-part';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { BLUSH_BLOCKS, BLUSH_OUTCOMES, BLUSH_SOURCES, BLUSH_STAGES, BOREDOM_LEVELS, HER_NEED_JOURNAL_EVENTS, LONGING_LEVELS, MOOD_EVENT_SOURCES, MOOD_JOURNAL_TYPES, POSE_JOURNAL_EVENTS, buildMoodJournalEntry, describeMoodJournalEntry, journalDeltaText, moodEventSource, moodJournalReason } from './journal-entries';
export type { BlushBlock, BlushOutcome, BlushSource, BlushStage, BoredomLevel, HerNeedJournalEvent, LongingLevel, MoodEventSource, MoodJournalInput, PoseJournalEvent } from './journal-entries';
export { MOOD_SNAPSHOT_WHENS } from './journal-state';
export type { JournalFatiguePhase, MoodAux, MoodNow, MoodSnapshotInput, MoodSnapshotWhen } from './journal-state';
