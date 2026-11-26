// 心情和反应 (part 5), window side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8). Files inside src/mood/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part mood`). The two
// stylesheets are imported directly by src/main.ts.
// src/initiative/HandsOverlay.ts imports PetInteractionCursor directly: MoodPanel.ts -> the initiative page -> HandsOverlay.ts would
// otherwise close a runtime import cycle through this page.

// Panels: blush calibration, her state reporter, the mood companion, judge, mood panel, reactions.
export { BlushCalibrationControls } from './BlushCalibrationControls';
export { HER_STATE_REPORT_CHECK_MS, HerStateReporter } from './her-state-reporter';
export { MoodCompanion } from './MoodCompanion';
export { MoodJudgePanel } from './MoodJudgePanel';
export { moodExtendedDifferences } from './MoodPanel';
export { ReactionDispositionsPanel, ReactionsPanel } from './ReactionsPanel';
// Touching her in the companion window: the interaction and its cursor.
export type { PetInteractionFeedback } from './PetInteraction';
export { PetInteractionCursor } from './PetInteractionCursor';
// I-154 follow-up: the same touch input and its mood inputs on full-screen Unbound (src/unbound/her/out-touch.ts), under companion names.
export { PetInteraction as TouchInput } from './PetInteraction'; // no-pet-ok: the touch input's old class name stays inside this part
export type { PetHeadRegion as TouchHeadRegion, PetInteractionState as TouchInputState, PetInteractionFeedback as TouchFeedback } from './PetInteraction'; // no-pet-ok: old type names stay inside this part
export { MoodInputQueue, matchesDirectContactCancellation } from './MoodCompanion';
export { MoodTouchSession } from './touch-session';
export type { LocalMoodInput } from './touch-session';
export { MoodViewLifetime } from './mood-view-lifetime';
// The stage's mood layer: cheek pinch, crying and tears, mood feedback and faces, pose reactions, reaction performers, the surprise preview.
export { CheekPinchMotion } from './cheek-pinch-feedback';
export type { CheekPinchMotionFrame } from './cheek-pinch-feedback';
export { projectCheekRegions } from './cheek-pinch-region';
// I-154 batch 3: her picked pinch face (I-136), for the cheek pinch on Unbound's window engine (src/unbound/window-mode/window-pinch.ts).
export { pinchFacePick } from '../../shared/behaviors/touch-response/view';
export type { CheekRegion } from './CheekPinch';
export { CryingTimeline } from './crying-timeline';
export type { CryingFrame } from './crying-timeline';
export { ProceduralTears, tearsSupport } from './procedural-tears';
export { EMPTY_CONTACT, MoodFeedback } from './mood-feedback';
export type { MoodContact } from './mood-feedback';
export { anchorWeights } from './mood-face/anchors';
export { MOOD_FACE_KNOBS } from './mood-face/knobs';
export { LabelBlend } from './mood-face/label-blend';
export type { LabelWeight } from './mood-face/label-blend';
export { FaceMoodReading } from './mood-face/reading';
export { framesWholeBody, PoseReactionStage, sampleKeys } from './pose-reaction-stage';
export type { PoseReactionPort } from './pose-reaction-stage';
export { playReactionCue } from './reaction-performers';
export type { ReactionStageResult } from './reaction-performers';
export { SURPRISE_DURATION_MS, SurpriseOverlay, surpriseSample } from './surprise-preview-overlay';
export { fullTouchable, touchable, windowTouchable } from './touchable'; // I-174 item 7: one rule for touching her
export type { TouchableState } from './touchable';
