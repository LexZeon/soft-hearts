// 舞台：桌宠画面 (part 2), shared half: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/stage/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part stage`).
// The part's behaviour folder shared/behaviors/idle-gesture/ stays with the other behaviour folders; its names used outside are here.
// Not here (their types are): the values of three modules that import other parts' pages which come back to this one, so through this
// page they would close runtime import cycles: audio-dance (the senses part's since the wiring rewrite step 1),
// personalize-visual (the cards page; emptyVisualBehavior, validateVisualBehavior, VISUAL_GENE_SHA), behaviors/idle-gesture/choose (the
// brain and mood pages; IdleGestureDirector, idleGestureNow). Their users import them directly: electron/main.ts,
// electron/mood/mood.ts, electron/senses/audio-capture-host.ts, electron/senses/visual-behavior-store.ts, src/voice/AudioReadingClient.ts.
// Also direct: IdleGesturePerformer (window only, src/mood/mood-feedback.ts; through here the host bundle took it) and
// normalizeModelPhysicsSettings in the Unbound window (src/unbound/main.ts, showcase/page.ts; through here rollup moved this page and
// the modules it keeps into the chunk the companion and Unbound windows share).

// Her own life: the activities, how each one looks, offers to switch.
export { HER_LIFE_ACTIVITIES, HER_LIFE_NEUTRAL_PRESENTATION, HER_LIFE_TABLE, isHerLifeActivity } from './her-life';
export type { HerLifeActivity, HerLifeMotionResource, HerLifePresentation, HerLifeSwitchOffer, HerLifeView, HerLifeWatchKind } from './her-life';
// How long she fades out and in when the model changes (both engines of the companion window).
export { PRESENCE_FADE_IN_MS, PRESENCE_FADE_OUT_MS } from './presence-times';
// The model: profile, capabilities and their check, physics.
export { acceptCachedProfile, calibratedWeight, profileBoneState, profileFingerCount, profileFingerNames } from './model-profile';
export type { ModelProfile, ModelProfileCacheView, StandardBone, Vec3 } from './model-profile';
export { capabilityEnabled, deriveModelCapabilities, MODEL_CAPABILITY_IDS } from './model-capability';
export type { CapabilityChoice, HaikuMatches, ModelCapabilities, ModelCapabilityId } from './model-capability';
export { CAPABILITY_LABELS } from './model-capability-check';
export type { CapabilityPreviewRequest, CapabilityPreviewResult, ModelCapabilityRecord, ModelCapabilityUpdate, ModelCapabilityView, ModelCheckAskResult, ModelCheckRequest } from './model-capability-check';
export { normalizeModelPhysicsSettings } from './model-physics';
export type { ModelPhysicsSettings, ModelPhysicsState, PhysicsQuality } from './model-physics';
// Personalising her body and look; the expression preview.
export { bodyPoseBinding, bodyPoseChoices } from './personalize-body-bindings';
export { selectBodyPosePresentation } from './personalize-body-presentation';
export type { BodyPosePresentation } from './personalize-body-presentation';
export type { BodyAdviceFill, BodyPoseBinding, BodyPoseChangeRequest, BodyPosePreview, BodyPoseReceipt, BodyPoseSaveRequest, BodyPoseSelection, BodyVisualResearchRequest, BodyVisualState } from './personalize-body';
export type { VisualAuthoringState, VisualBehaviorProfile, VisualChangeRequest, VisualPreview, VisualPreviewReceipt, VisualResearchRequest, VisualSaveRequest, VisualSelection } from './personalize-visual';
export { isExpressionRecipe } from './expression-preview';
export type { ExpressionPreviewResult, ExpressionRecipe, ExpressionSupport } from './expression-preview';
// Framing the companion window: the request in chat and the camera presets.
export { scanFramingRequest } from './framing-request';
export { sameFramingCamera } from './pet-framing';
export type { PetFramingPreset, PetFramingReport, PetFramingRequest, PetFramingState } from './pet-framing';
// Dancing to audio: the frames and intents.
// The colour-block check (stray coloured blocks on the stage).
export { COLOR_BLOCK_FRAME_COLUMNS, COLOR_BLOCK_GAP_MS, COLOR_BLOCK_IMAGE_BYTES, COLOR_BLOCK_IMAGE_PREFIX, COLOR_BLOCK_MAX_FRAMES, COLOR_BLOCK_MAX_RUNS, COLOR_BLOCK_MAX_STRIPS, COLOR_BLOCK_NEAR_GAP_MS } from './color-block';
export type { ColorBlockEnv, ColorBlockEvent, ColorBlockFrames, ColorBlockInspect, ColorBlockNearMiss, ColorBlockReport, ColorBlockSample, ColorBlockWatchStats } from './color-block';
// The single-emoji catalog.
export { EMOJI_CATALOG, getEmoji } from './single-emoji';
export type { EmojiId, EmojiSettings } from './single-emoji';
// Idle gestures (shared/behaviors/idle-gesture/).
export type { IdleGestureHost, IdleGestureStage, IdleGestureView, IdleGestureWhy } from '../behaviors/idle-gesture/interface';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { MOTION_ACTIVITIES, MOTION_GLITCH_KINDS, MOUTH_READING_MAX, MOUTH_READING_WORDS, STAGE_JOURNAL_TYPES, TOPMOST_FIX_OUTCOMES, buildStageJournalEntry, describeStageJournalEntry, stageJournalReason } from './journal-entries';
export type { MotionActivity, MotionGlitchKind, MouthReadingSentence, MouthReadingWord, StageJournalInput, TopmostFixOutcome } from './journal-entries';
// The companion window's diagnostics view (the mood part's companion panel draws it).
export type { PetWindowDiagnosticsView } from './desktop-api';
// 聊天时头别乱晃 (I-170, shared/behaviors/talk-calm/): the eased calm of the idle's own head and the talk signal (the stage and Unbound use them).
export { TalkCalm, talkSignal, type TalkSignals } from '../behaviors/talk-calm/talk-calm';
export { TALK_CALM_KNOBS } from '../behaviors/talk-calm/knobs';
// 拉她 (I-136 step 5, shared/behaviors/pull/): the session, its knobs and gates (the companion input and Unbound use them).
export { PullSession, PULL_GROUP_OF } from '../behaviors/pull/session';
export type { PullGrab, PullGroup, PullPhase, PullReport } from '../behaviors/pull/session';
export { PULL_BOUNDS, PULL_KNOBS, normalizePullKnobs } from '../behaviors/pull/knobs';
export type { PullKnobs } from '../behaviors/pull/knobs';
export { PULL_ASLEEP_PHASES, pullGatesOf, pullRefusal } from '../behaviors/pull/gates';
export type { PullGates } from '../behaviors/pull/gates';
export { PULL_ATTITUDE_KNOBS, pullAttitudeNow, pullGiveNow, pullStanceOf } from '../behaviors/pull/attitude';
export type { PullAttitude, PullMoodReading, PullStance as PullStanceOf } from '../behaviors/pull/attitude';
// 2026-11-24 三人同框别卡 (docs/claude/2026-11-24-stage-smooth.md): the frame-time journal row's checked fields (the host's stage coordinator builds one from a page's numbers).
export { frameTimeFrom, FRAME_TIERS } from './smooth-journal';
export type { FrameTimeRow, FrameTier } from './smooth-journal';
