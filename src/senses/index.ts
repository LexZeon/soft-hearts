// 感知 (part 3), window side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8). Files inside src/senses/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part senses`). The three
// stylesheets are imported directly by src/main.ts, and src/settings/layout.ts imports CameraSharingPanel for its side effect (it registers
// the English copy of the camera rows), so neither goes through this page.

// Audio input for the reading client: ambient segments, dance fusion, the listening switch, media, microphone and system audio input.
export { AmbientAudioSegments } from './ambient-audio-segments';
export { AudioDanceFusion } from './audio-dance-fusion';
export { MUSIC_STALL_GRACE_MS, MusicHearing, hearingReceiver, type MusicHearingPorts } from './music-hearing'; // 2026-11-22: a frame stall is not a capture stop
export { ListenTogetherSwitch } from './ListenTogetherSwitch';
export { MediaInput } from './MediaInput';
export type { CallInputEvent } from './MediaInput';
export { MicrophoneInput } from './MicrophoneInput';
export { SystemAudioInput } from './SystemAudio';
// Panels: ambient transcripts, camera sharing, face check, feed recognition, listening together, the local recognizer, pose sensing, screen sharing, user activity.
export { AmbientTranscriptHistory } from './AmbientTranscriptHistory';
export { CameraSharingPanel, cameraWords } from './CameraSharingPanel';
export { FaceCheckPanel, mountFaceCheckLight } from './FaceCheckPanel';
export { VoiceprintPanel } from './VoiceprintPanel'; // Unbound v1 step 3 只认你的声音
export { FeedRecognitionPanel } from './FeedRecognitionPanel';
export { ListenKindPanelFeed } from './listen-kind-panel';
export { ListenTogetherPanel } from './ListenTogetherPanel';
export { LocalAsrPanel } from './LocalAsrPanel';
export { PoseSensingPanel } from './PoseSensingPanel';
export { DEFAULT_SCREEN_SHARING_OPTIONS, ScreenSharingOptions } from './ScreenSharingOptions';
export { UserActivityPanel } from './UserActivityPanel';
// The stage's camera-derived input: capture smoothing, gaze attention, hand input, pose continuity.
export { smoothCapturedClip } from './capture-smoothing';
export { StageGazeAttention } from './gaze-attention-stage';
export { gazeDebug, unitsToPx, type GazeDebugFrame } from './gaze-debug-view'; // I-169 developer mode: where she looks (label and dot), with the two builders
export { flatGazeFrame, legacyGazeFrame } from './gaze-debug-flat';
export { HandInput } from './hand-input';
export type { HandReading } from './hand-input';
export { BaseSourceWatch, PoseContinuity } from './pose-continuity';
export type { PoseContinuityState, WatchedMixer } from './pose-continuity';
// Looking from the chat: camera snapshot, look button and offer, attachments of a turn, proactive vision delivery.
export { cameraSnapshot } from './capture';
export { draftAfterClear, lookHint, turnAttachments } from './look-send';
export { LookButton, lookButtonContent } from './LookButton';
export { lookOfferContent, LookOfferPrompt } from './LookOfferPrompt';
export { prepareVisionDelivery } from './proactive-vision-delivery';
export { switchWatchTogether, type WatchTogetherApi } from './watch-together-toggle'; // I-187: 一起看 = the screen + the dialogue, one click
export { setCameraChooser } from './camera-choice'; // I-190: which camera this window opens
export { UserAttentionStore } from './user-attention'; // I-189 #1, #2: the host's attention reading in this window
export type { UserAttentionMessage } from './user-attention';
