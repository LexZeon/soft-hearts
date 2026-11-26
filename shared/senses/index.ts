// 感知 (part 3), shared side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/senses/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part senses`), including
// the names other parts use from this part's behaviour folders, which stay in shared/behaviors/ like the other parts' (parts 1 and 2).
// Not here (their types are): the values of three modules only the companion window uses, which run code when loaded (Object.freeze), so
// through this page the host bundle would carry them: music-desire (src/stage/music-choice.ts), music-detect/knobs
// (src/stage/music-likeness.ts), behaviors/watch-along/direction (src/stage/her-life-stage.ts). shared/stage/model-profile.ts imports
// face-morphs directly: it sits in the chunk the companion and Unbound windows share, and through this page that chunk would grow ~60 KB.
// Also not here (types are): host-only values, which through this page would add ~1 KB to the control window bundle: behaviors/
// user-activity effects, held (HeldIntents) and presence (companion, mood, her-state-host, inner-loop and opening hosts), ambient-audio
// limits and language check (voice/audio-reading-archive.ts), user-tone (voice/voice-chat-host.ts). Their importers import them directly.
// Untangling these is left for the stage and core parts.
// shared/brain/perception-rule.ts imports look-request and screen-activity directly: feed-recognition -> the initiative page ->
// inner-loop.ts -> perception-rule.ts would otherwise close a runtime import cycle through this page.

// Behaviour folders of this part (shared/behaviors/gaze-attention, user-activity, watch-along): where her eyes go, what the user is doing, watching direction.
export type { GazeAttentionEvent, GazeReadout } from '../behaviors/gaze-attention/choose';
export type { UserGazePoint } from '../behaviors/gaze-attention/geometry'; // I-169: the readout's place of your head
// Unbound step 4: her gaze back at you when you face her (electron/unbound/life.ts), the companion's I-081 logic as it is.
export { GazeAttention, gazeMoodFrom } from '../behaviors/gaze-attention/choose';
export type { GazeMood, GazeMoodSource } from '../behaviors/gaze-attention/choose';
export { GAZE_JOURNAL_EVENTS, GAZE_JOURNAL_REASON, GAZE_JOURNAL_WHY_WORDS, parseUserGazeReading } from '../behaviors/gaze-attention/interface';
export type { GazeJournalEvent, GazeJournalWhy, UserGazeReading } from '../behaviors/gaze-attention/interface';
// I-167: "you are looking at her" from which way your head points, and the knobs (full-screen Unbound reads both).
export { LookingAtHer } from '../behaviors/gaze-attention/looking';
export { GAZE_ATTENTION_KNOBS } from '../behaviors/gaze-attention/knobs';
export type { GazeAttentionKnobs } from '../behaviors/gaze-attention/knobs';
export type { HeldIntent, HeldKind } from '../behaviors/user-activity/held';
export { SCREEN_LOOKS } from '../behaviors/user-activity/interface';
export type { PresenceView, ScreenLook, UserActivitySwitchView, UserActivityView } from '../behaviors/user-activity/interface';
export type { ScreenRect } from '../behaviors/watch-along/direction';
export { WATCH_ALONG_KNOBS } from '../behaviors/watch-along/knobs';
// Ambient audio: the runtime view, transcripts, comments and their limits.
export type { AmbientAudioView, AmbientRuntimeState, AmbientRuntimeSubmission, AmbientSubmissionResult } from './ambient-audio-runtime';
export type { AmbientComment, AmbientCommentInput, AmbientContextItem, AmbientContextQuery, AmbientDeleteResult, AmbientLanguage, AmbientLongTermCandidate, AmbientMode, AmbientScope, AmbientTranscript, AmbientTranscriptInput, AmbientTranscriptPage, AmbientTranscriptQuery, AmbientUserResponse } from './ambient-audio';
// Audio capture and reading PCM.
export { parseAudioReadingPcm } from './audio-capture';
export type { AudioCaptureAck, AudioCaptureDescriptor, AudioCaptureState, AudioReadingPcm, AudioReadingPcmAck } from './audio-capture';
// The camera: glance limits, the look journal's words.
export { GLANCE_MAX_AGE_MS, GLANCE_MAX_CHARS } from './camera-glance';
export { CAMERA_LOOK_SEEN, CAMERA_LOOK_SEEN_WORDS, CAMERA_LOOK_VIA, CAMERA_LOOK_VIA_WORDS, CAMERA_LOOK_WHY, CAMERA_LOOK_WHY_WORDS } from './camera-look';
export type { CameraLookSeen, CameraLookVia, CameraLookWhy, CameraLookMiss, CameraLookDetail } from './camera-look';
// Whether she already asked how the user is.
export { CareAskedTracker } from './care-asked';
// The face check view; face morph names (the stage and model profile resolve faces with them).
export { FACE_CHECK_PHASES } from './face-check';
export type { FaceCheckPhase, FaceCheckView } from './face-check';
export { morphDictionary, resolveFaceMorphs, resolveNamedFaceShapes } from '../foundation/face-morphs';
export type { FaceApproximation, FaceMorphLookup, FaceWrite } from '../foundation/face-morphs';
// Feed recognition: categories, likings, image limits, the line message.
export { FEED_CATEGORIES, FEED_JOURNAL_OUTCOMES, FEED_LIKINGS, FEED_MOOD_REASONS, FEED_PRESHRINK_EDGE, FEED_SOURCE_MAX_BYTES, FEED_SOURCE_MAX_PIXELS, imageHeaderSize, readFeedLineMessage, sniffImageFormat } from './feed-recognition';
export type { FeedCategory, FeedJournalOutcome, FeedLiking, FeedLineDone, FeedLineMessage, FeedRecognitionView, FeedSnackInput } from './feed-recognition';
// Listening together and the local recognizer: switches and views.
export { listenMusicSwitchOn, listenSwitchOn, listenWordsOn } from './listen-together';
export type { ListenTogetherView } from './listen-together';
export { WATCH_TOGETHER_TOOLTIPS, watchTogetherLook, watchTogetherPlan } from './watch-together-state'; // I-187: 一起看 = the screen + the dialogue, one switch
export type { DialogueHearing, WatchTogetherFacts, WatchTogetherLook, WatchTogetherPlan } from './watch-together-state';
export { switchWatchTogether, type WatchTogetherApi } from './watch-together-switch'; // I-190: the one click, also from the full-screen input box (host side)
export { parseLocalAsrView } from './local-asr';
export type { LocalAsrView } from './local-asr';
// Asking her to look.
export { isLookOffer, lookOfferTarget, scanLookRequest, withheldLook } from './look-request';
export type { LookTarget } from './look-request';
export { CALL_LOOK, spokenLookText } from './call-look'; // I-161: a voice segment's words for the same look rules
export type { CallGlanceMark } from './call-look'; // I-161 A: a call segment's small frames, kept until hang-up
export * from './see-and-say'; // I-166: small frames every turn, her own closer look (a hidden marker)
// Music: dance desire, onset detection, the off verdict, settings, taste.
export type { DanceDesire, DanceDesireFn, DanceDesireInput, DanceTier } from './music-desire';
export { onsetDelta, validCounter } from './music-detect/onset';
export { MUSIC_OFF_LABEL, MUSIC_OFF_REASONS } from './music-detect/verdict';
export type { MusicOffReason } from './music-detect/verdict';
export { DEFAULT_MUSIC_SETTINGS, normalizeMusicSettings } from './music-settings';
export type { MusicSettings } from './music-settings';
export { isNeutralMusicTaste, MUSIC_TASTE_AXES, MUSIC_TASTE_ENDS, musicTasteOf, validateMusicTaste } from './music-taste';
export type { MusicTaste, MusicTasteAxis } from './music-taste';
// Local pose signals and their view.
export { parsePoseView, POSE_EVENTS, POSE_LOCAL_ONLY, POSE_RECOGNISES, poseMegabytes } from './pose-signals';
export type { PoseEvent, PoseFacing, PosePosture, PoseSensingView, PoseSignal } from './pose-signals';
export { poseConfidenceBand, POSE_MAYBE_AT, POSE_SURE_AT } from './pose-confidence';
// I-189: what the local pose signals are used for (the behaviour folder shared/behaviors/pose-uses/, owned by this part).
export { AttentionTracker, attentionOf, awayForReading, parseUserAttention, turnedFromScreen, USER_ATTENTION_STATES } from '../behaviors/pose-uses/attention';
export type { UserAttention, UserAttentionState } from '../behaviors/pose-uses/attention';
export { asksYesNo, headGestureOf, HeadGestureDetector, lastQuestion, zigzag } from '../behaviors/pose-uses/nod';
export type { HeadGesture } from '../behaviors/pose-uses/nod';
export { PeopleWatch, PostureWatch, SittingClock, StareWatch } from '../behaviors/pose-uses/body-time';
export type { PostureFacts, SittingFacts, StareFacts } from '../behaviors/pose-uses/body-time';
export { asksAboutSitting, gestureTurnNote, gestureTurnText, sittingNote, twoPeopleNote, unheardRestNote } from '../behaviors/pose-uses/lines';
export { parsePoseUseFact, POSE_USE_EVENTS, POSE_USES } from '../behaviors/pose-uses/journal';
export type { PoseUse, PoseUseEvent } from '../behaviors/pose-uses/journal';
export { POSE_USES_KNOBS } from '../behaviors/pose-uses/knobs';
export type { PoseUsesKnobs } from '../behaviors/pose-uses/knobs';
export type { PoseConfidenceBand } from './pose-confidence';
// The screen glance: activities, prompts and fit.
export { ACTIVITY_PHRASES, ACTIVITY_WORDS, GLANCE_PROMPT, GLANCE_SYSTEM_PROMPT, glanceFit, SCREEN_ACTIVITIES } from './screen-activity';
export type { ScreenActivity } from './screen-activity';
// The one-look router's field and line message.
export { chimeInOrigin, parseSenseField, parseSenseLine, readSenseLineMessage, SENSE_JUDGE_RULE } from './sense-router'; // I-209 step 4: her chime-in's line and origin
export type { SenseId, SenseLineDone, SenseLineMessage } from './sense-router';
// Song sketches she remembers.
export { validateSketch } from './song-memory/index';
export type { SongSketch } from './song-memory/index';
export { SONG_MEMORY_KNOBS } from './song-memory/knobs';
// The user's state (tired, busy ...) and tone.
export { parseUserStateField, USER_STATE_FADE_MS, USER_STATE_INSTRUCTION, USER_STATE_LABELS, USER_STATES } from './user-state';
export type { ActiveUserState, UserStateJudgment, UserStateKind, UserStateView } from './user-state';
export type { UserTone } from './user-tone';
export type { AudioDanceFrame, AudioDanceIntent, AudioDanceSample } from './audio-dance'; // the values stay direct (moved from the stage page, wiring rewrite step 1)
// Batches D, F (docs/claude/2026-11-21-unbound-full-D.md): the frame's check, for Unbound (its only import is the onset counters, inside this part).
export { parseAudioDanceFrame } from './audio-dance';
// The vision runtime's options and presentation.
export { acceptVisionOptionsPatch, formatVisionPresentation, INNER_INITIATIVE_LABEL, isVisualAttentionCue } from './vision-runtime';
export type { VisionInitiative, VisionInitiativeEvent, VisionOptionsPatch, VisionRuntimeState } from './vision-runtime';
// I-178: the tail of the persona text for her own screen/camera topic (the recent-chat block and the spoken-words-only sentence ride on it).
export { visionTopicPersonaTail } from './vision-topic-prompt';
// Who is speaking in a turn (the user or a visitor).
export { speakerOf, visitorContent } from './visitor-turn';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { DANCE_TIERS, PAUSE_STUCK_KINDS, WATCH_OFF_WHYS, WATCH_CHANGE_EVENTS, WATCH_LOST_WHYS, WATCH_NOT_RESUMED_WHYS, SENSES_JOURNAL_TYPES, buildSensesJournalEntry, describeSensesJournalEntry, sensesJournalReason } from './journal-entries';
export type { JournalDanceTier, PauseStuckKind, WatchOffWhy, WatchChangeEvent, WatchLostWhy, WatchNotResumedWhy, SensesJournalInput } from './journal-entries';
// I-190: the sense source menus (what each offers, the choice) and the device lists both windows read (docs/claude/2026-11-22-i190-source-pickers.md).
export { FOLLOW_DEFAULT, SOURCE_KINDS, SOURCE_TEXT, chooseSource, deviceMenu, parseScreenSourceId, promote, screenMenu, screenSourceKind, systemAudioMenu } from './source-picker';
export type { ScreenSourceEntry, ScreenSourceMenuView, ScreenSourceView, SourceChoicePorts, SourceItem, SourceKind, SourceMenuModel } from './source-picker';
export { DeviceSources } from './device-sources';
export type { DeviceSourcePorts } from './device-sources';
export { createSourceChoices, type ScreenSourceApi, type SourceChoices } from './source-choices';
