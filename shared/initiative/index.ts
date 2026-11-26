// 她主动做的事 (part 8), shared side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/initiative/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part initiative`),
// including the part's behaviour folders, which stay in shared/behaviors/ with the other parts' behaviour folders. Except four
// value sources only the host uses: the renderer imports this page too, and rolldown keeps every module a page re-exports values
// from (their top-level Object.freeze calls count as side effects), so these would add ~2.8 KB of host-only code to the window
// bundle. Their importers import them directly (the inner-loop host, impulse, keepsake, shared/initiative/rps-personality.ts):
//   - BoredomTimingDirector, boredomTimingNow (behaviors/boredom-timing/choose), FeedCueDirector, feedCueNow (behaviors/feed-cue/
//     choose), proactiveTalk (behaviors/inner-rhythm/knobs; foundation/settings since the wiring rewrite step 1), rpsExpectedHand (rps-memory). Their types are here (erased at build).

// Feeding cues (what she says while you feed her): the clip text and limits, the kinds of thinking cues.
export { CUE_TEXT, cueInstruction, FEED_CUE_MAX_BYTES, isCueKind, THINK_CUE_KINDS } from './feed-cue';
export type { CueKind, FeedCueClip } from './feed-cue';
// Her folder: the journal's action and refusal words, the wire views.
export { HER_FOLDER_ACTIONS, HER_FOLDER_REFUSALS } from './her-folder';
export type { HerFolderActionKind, HerFolderNoteView, HerFolderRefusal, HerFolderView } from './her-folder';
// The inner loop: the journal's words, its quiet rule, the profile query, the wire view; visibleLength is a small text helper.
export { INNER_LOOP_ACTIONS, INNER_LOOP_PROFILE_QUERY, INNER_LOOP_RESULTS, innerLoopNightKey, innerLoopQuiet, visibleLength } from './inner-loop';
export type { InnerLoopAction, InnerLoopDiagnostic, InnerLoopFocus, InnerLoopQuiet, InnerLoopResult, InnerLoopView } from './inner-loop';
// R20 task offers she makes: the wire types.
export type { R20ProactiveOfferAcknowledgement, R20ProactiveOfferEvent, R20ProactiveOfferResponse, R20ProactiveOfferResult, R20ProactiveOfferState, R20ProactiveOfferView } from './r20-proactive-offer';
// Rock-paper-scissors: hands and outcomes, her habits (her personality reads them), the wire types.
export { RPS_HANDS, rpsLoserAgainst, rpsWinnerAgainst } from './rps';
export type { RpsFace, RpsHand, RpsIntent, RpsOutcome, RpsResponseRequest, RpsThrowRequest, RpsUnreadWhy, RpsView } from './rps';
export type { RpsHabits } from './rps-memory';
export type { OurThing, OurThingView, OurThingsView } from './our-things';
// Looking at herself: the rise above baseline, the journal's words.
export { riseAboveBaseline, SELF_LOOK_RESULT_WORDS, SELF_LOOK_RESULTS, SELF_LOOK_SENSE_WORDS, SELF_LOOK_SENSES, SELF_LOOK_WHY_WORDS, SELF_LOOK_WHYS } from './self-look';
export type { SelfLookResult, SelfLookSense, SelfLookWhy } from './self-look';
// The surprise preview: clip ids, revisions, the model's hash, the grant.
export { SHY_CLIP_ID, SHY_REVISION, SURPRISE_CLIP_ID, SURPRISE_MODEL_SHA, SURPRISE_REVISION } from './surprise-preview';
export type { ManualEmotionRecipe, SurprisePreviewGrant } from './surprise-preview';
// Taking the user to a page: the page ids and the wire types.
export { controlNavigateRequest, isTakeMeThereCharacter, isTakeMeThereId, TAKE_ME_THERE, TAKE_ME_THERE_IDS } from './take-me-there';
export type { ControlNavigateRequest, TakeMeThereFocus, TakeMeThereId, TakeMeThereRequest, TakeMeThereView } from './take-me-there';
// I-173: a capability item → its 「带我去」 page and the element to flash (the channel's open_control_page and read_handbook use it).
export { takeMeThereItem } from './take-me-there-items';
export type { TakeMeThereItem } from './take-me-there-items';

// ---- The part's behaviour folders (shared/behaviors/) ----------------------------------------------------------------------
// Boredom timing and feeding cues (the mood host runs them; the mood panel and the stage show them).
export type { BoredomKind, BoredomTimingHost, BoredomTimingNow, BoredomTimingWhy } from '../behaviors/boredom-timing/interface';
export type { FeedCueHost, FeedCueNow, FeedCueView, FeedCueWhy, FeedEatStage } from '../behaviors/feed-cue/interface';
export { FEED_CUE_KNOBS } from '../behaviors/feed-cue/knobs';
export type { FeedTaste } from '../behaviors/feed-cue/knobs';
export { FeedEatPerformer } from '../behaviors/feed-cue/perform';
// Giving and holding hands: the journal's words and the wire types; the stage command for holding hands.
export { PICTURE_REASONS } from '../behaviors/give/choose';
export type { PictureReason } from '../behaviors/give/choose';
export type { GiveAnswer, GiveEvent } from '../behaviors/give/interface';
export { GIVE_ITEM_IDS, GIVE_LEAN_MOMENTS } from '../behaviors/give/knobs';
export type { GiveItemId, GiveLeanMoment } from '../behaviors/give/knobs';
export type { HandsAnswer, HandsEvent, HandsRequest } from '../behaviors/hands/interface';
export { HAND_OUTCOMES, HAND_USES, HAND_WHYS } from '../behaviors/hands/knobs';
export type { HandOutcome, HandUse, HandWhy } from '../behaviors/hands/knobs';
export type { HandsStageCommand } from '../behaviors/hands/session';
// Her impulses: the journal's words.
export { INITIATIVE_FLOOR_WORDS, INITIATIVE_FLOORS, INITIATIVE_KIND_WORDS, INITIATIVE_KINDS, INITIATIVE_WHY_WORDS, INITIATIVE_WHYS, URGE_BUCKET_WORDS, URGE_BUCKETS } from '../behaviors/impulse/interface';
export type { InitiativeFloor, InitiativeKind, InitiativeWhy, UrgeBucket } from '../behaviors/impulse/interface';
// How often she starts talking (the setting), the interaction budget, keepsake knobs.
export type { ProactiveTalk } from '../behaviors/inner-rhythm/knobs';
export type { BudgetCreditKind, InteractionBudget, InteractionBudgetView } from '../behaviors/interaction-budget/interface';
export { INTERACTION_BUDGET_KNOBS } from '../behaviors/interaction-budget/knobs';
export { KEEPSAKE_KNOBS } from '../behaviors/keepsake/knobs';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { GIVE_JOURNAL_EVENTS, INITIATIVE_JOURNAL_TYPES, RPS_ENDS, RPS_JOURNAL_EVENTS, buildInitiativeJournalEntry, describeInitiativeJournalEntry, initiativeJournalReason } from './journal-entries';
export type { GiveJournalEvent, InitiativeJournalInput, RpsJournalEvent } from './journal-entries';
