// 感知 (part 3), host side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside electron/senses/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part senses`).
// Privacy: every sense here stays off until the user turns it on; this page only re-exports, it opens nothing.
// Six importers in other parts import the modules directly, because this page reaches back to them through other parts' pages and
// would close a runtime import cycle (proactive-vision -> initiative page, look-closer -> self-look, feed-cue -> voice page -> memory
// page, sense-cards -> safety page): initiative/inner-loop/host.ts (vision-presentation-adapter), memory/memory-semantic/manifest.ts
// (pose/manifest), safety/agent-channel/app-tools.ts (asr/manifest), voice/audio-reading-archive.ts (ambient-audio-store),
// voice/voice-call/vad.ts (asr/protocol); initiative/self-look/wiring.ts (sense-router/model) is wiring. Untangling waits for the
// wiring rewrite (plan step 4).
// watch-notes/frame-picture.ts (prepareWatchFrame) is not here: it loads electron's nativeImage at import time, which the node tests'
// electron stub does not have, so every test reaching this page would fail to load. Only electron/main.ts uses it, directly.

// Ambient audio (听身边的声音): the runtime, its store of transcripts, her comments on what she heard.
export { AmbientAudioRuntime } from './ambient-audio-runtime';
export { AmbientAudioStore } from './ambient-audio-store';
export { AmbientComments, ambientContextText } from './ambient-comments';
export type { AmbientCommentSession } from './ambient-comments';
// Speech recognition: the compatible transcription address, WAV checks; the local recognizer (host, routes, PCM checks, model archives).
export { transcribeWav, validateWav } from './asr';
export { AmbientAsrRoute, refusedReadingAck } from './asr/ambient-route';
export { wavSamples } from './asr/features';
export { LocalAsrHost } from './asr/host';
export { ASR_ARCHIVES, ASR_COMPONENT_VERSION, SENSEVOICE_REPO } from '../foundation/asr-manifest';
export { checkedPcm, checkedTurnPcm } from './asr/protocol';
export { VoiceRoute } from './asr/voice-route';
// Microphone and system audio capture (the host side of a reading).
export { AudioCaptureHost } from './audio-capture-host';
// The camera: one glance, its journal line, the sample broker, the face check's chat turn.
export { CameraGlance } from './camera-glance';
export { CameraLookJournal } from './camera-look-journal';
export { CameraSampleBroker } from './camera-sample';
export { faceTurnFor } from './face/chat-turn';
// Feeding: the cue synth; the feed recognition's journal entry type.
export { FeedCueSynth } from './feed-cue';
export type { FeedJournalEntry } from './feed-recognition/host';
// What the user is doing: the foreground window probe (and its PowerShell runner), foreground speech.
export { WindowsForegroundProbe, windowsPowerShell } from './foreground-app';
export { ForegroundAsr } from './foreground-asr';
// Listening together: what kind of sound, the tally, the host and its IPC, the comment port.
export { ListenKindSource } from './listen-kind-source';
export { ListenTally } from './listen-tally';
export { ListenTogether, NO_LISTEN_ASK, registerListenTogetherIpc } from './listen-together/host';
export type { AmbientCommentsLike } from './listen-together/proactive';
// Looking: attachments of a message, the closer look, look turns and the proactive vision default.
export { LookAttachments } from './look-attachments';
export { CloserLook, curiosityFrom } from './look-closer';
export { SmallScreenFrames, freshSmallCamera } from './small-frames'; // I-166: the small frames no window keeps
export { LookTurns, PROACTIVE_VISION_DEFAULT } from './look-turns';
export { voiceLegLook, type VoiceLegLook, type VoiceLookPorts } from './voice-look';
// Music settings store; the pause guard.
export { MusicSettingsStore } from './music-settings';
export { PauseGuard } from './pause-guard';
// Local pose sensing: the component store (recall by meaning installs into it too), the host, the manifest, the quit gate, the tray eye.
export { ComponentInstallError, defaultComponentRoot, PoseComponentStore } from './pose/component-store';
export type { FetchLike } from './pose/component-store';
export { PoseSensingHost } from './pose/host';
export { POSE_ARCHIVES, POSE_COMPONENT_VERSION, POSE_GENERATED_FILES, POSE_PACKS, POSE_RUNTIME_ENTRY, posePlatform } from '../foundation/pose-manifest';
export type { ManifestArchive, PoseManifest } from '../foundation/pose-manifest';
export { createPoseQuitGate } from './pose/quit-gate';
export { CameraTrayEye, trayBitmap } from './pose/tray';
// Proactive vision and the screen: capture frames, the proactive look, screen glances and snapshots, the selected visual image.
export { captureProactiveFrames } from './proactive-capture';
export { ProactiveVision } from './proactive-vision';
export { ScreenGlance } from './screen-glance';
export { ScreenSnapshots } from './screen-snapshots';
export { readSelectedVisualImage } from './selected-visual-image';
export type { SelectedVisualImage } from './selected-visual-image';
// Sense cards in chat (asking to turn a sense on), the one-look router's Claude ask.
export { parseSenseProposal, SENSE_PROPOSAL_NOTE, senseAllowance, senseAppliedMessage, senseCardApplier, senseChoice, senseContextText } from './sense-cards';
export type { SenseAllowance, SenseCardApplier, SenseCardSpec, SenseFacts, SenseOutcome, SenseValue } from './sense-cards';
export { senseAskWithClaude, senseLineWithClaude } from './sense-router/model';
// I-161 semantic look for voice input and calls: the voice host's port onto the I-040 router.
export { voiceSegmentSenses, type VoiceSegmentSenses, type VoiceSensePorts } from './sense-router/voice';
export { deliverSenseLine, senseLineFree, type SenseFreeFacts, type SenseLineRoute } from './sense-router/free';
// Songs she remembers; system audio; the user's gaze and state.
export { SongMemoryHost } from './song-memory';
export { SystemAudioRuntime } from './system-audio';
export { UserGazeHost } from './user-gaze';
export { WatchContinuity, WatchFactsTurn, type WatchContinuityPorts, type WatchFactsOutcome, type WatchFactsTurnPorts } from './watch-continuity'; // 2026-11-24: 一起看 paused and resumed with her window, her turn after a lost share
export { PoseUsesHost } from './pose-uses/host'; // I-189: what the local pose signals are used for
export type { PoseMomentFacts, PoseUseRow, PoseUsesPorts } from './pose-uses/host';
export { UserStateDiagnostics, UserStateStore } from './user-state';
// Vision support and presentation, the visual behaviour store, her look at herself.
export { VisionPresentationGuard } from './vision-presentation-adapter';
export type { VisionPresentationSurface } from './vision-presentation-adapter';
export { VisionProviderSupport } from './vision-support';
export { VisualBehaviorStore } from './visual-behavior-store';
export type { VisualSelfSnapshot } from './visual-self-context';
export { VisualSelfRuntime } from './visual-self-runtime';
export type { VisualSelfLease } from './visual-self-runtime';
export { offAsNotUsers, onWatchChange } from './watch-off-notice'; // 2026-11-24 (再续): Unbound's way back puts switches back as itself, not as the user
// Watching along: the watcher, a frame's picture.
export { createWatchAlong } from './watch-along';
// I-174: the shared screen's two reads (moved out of the look wiring; ports injected).
export { screenCaptures, type ScreenCapturePorts } from './screen-capture';
export { ScreenSourceChoice, SCREEN_MENU_TTL_MS, type ScreenSourcePorts } from './screen-source'; // I-190: which screen or window sharing reads
