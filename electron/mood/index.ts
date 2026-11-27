// 心情和反应 (part 5), host side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside electron/mood/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part mood`).
// The part's wiring modules (mood-judge/wiring.ts, reactions/wiring.ts) are wiring: electron/main.ts imports them directly;
// color-block-log.ts is loaded by a dynamic import in electron/main.ts and stays direct.
// electron/voice/voice-companion.ts imports MoodReplyProtocol from mood-chat.ts directly: speech-emotion.ts -> the voice page ->
// voice-companion.ts would otherwise close a runtime import cycle through this page.

// The mood host: hormones and mood values, her moments, the mood in chat and in the situation line.
export { MoodHost } from './mood';
export type { LiveMood, MoodInteractionNote } from './mood';
export { StageMoods } from './stage-moods'; // I-209 step 2: a live mood for everyone on stage
export { StageTouchMood } from './stage-touch'; // I-209 step 4: touches, pulls on someone else on stage move her own mood
export { chatGestureSentence, LEADING_BREAKS, MoodReplyProtocol } from './mood-chat';
export type { HerFolderOption, MoodAppraisal, ReplyCheck, SettingProposalOption } from './mood-chat';
export { todayLines } from './mood-situation';
// Fatigue: activity and the host.
export { FatigueActivityBridge, verifiedFatigueBackground } from './fatigue-activity';
export { SYSTEM_FATIGUE_CLOCK } from './fatigue-host';
// Her needs; her state for the agent channel and the window.
export { HerNeedsHost } from './her-needs/host';
export type { HerNeedsHostOptions } from './her-needs/host';
export { createHerState, hearingSource, StageStateHost } from './her-state-host';
// Blush calibration (the per-model red).
export { BlushCalibrationStore, createTrustedPackedModel } from './blush-calibration';
export { createOwnAppArchive } from './own-app-archive'; // 2026-11-27: Mumi and One inside the packaged app's archive get a stable identity
// Reactions: to the user's pose, the reaction table (I-037), realer emotions and their expiry.
export { PoseReactionHost } from './pose-reactions/host';
export type { PoseReactionHostOptions, PoseSimulation, PoseSimulationResult } from './pose-reactions/host';
export type { ReactionSafetyPort, ReactionSensePort } from './reactions/host';
export { realerDurationLine, realerEmotionsRequest } from './realer-emotions-host';
export { startRealerExpiryWatcher } from './realer-expiry';
// Emotion read off speech.
export { composeSpeechConfig, freezeTurnSpeechStyle, ReplySpeechStyles, supportsTurnSpeechEmotion } from './speech-emotion';
export type { SpeechMood } from './speech-emotion';
// Touch: the brain that answers a touch, the sink that receives touches.
export { createTouchBrain } from './touch/brain';
export { reportTouch, setTouchSink } from './touch/sink';
export { acceptPetTouch } from './touch/pet-touch'; // I-136 5a: the companion window's pull report
