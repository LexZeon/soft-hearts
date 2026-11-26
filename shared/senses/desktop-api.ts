// 感知 (senses): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { SpeechRequestContext } from '../voice';
import type {
  AmbientAudioView, AmbientComment, AmbientDeleteResult, AmbientMode, AmbientRuntimeSubmission, AmbientSubmissionResult, AmbientTranscript,
  AmbientTranscriptPage, AmbientTranscriptQuery, AudioCaptureAck, AudioCaptureState, AudioDanceFrame, AudioDanceIntent, AudioReadingPcm,
  AudioReadingPcmAck, ListenTogetherView, MusicSettings, VisionInitiative, VisionInitiativeEvent, VisionOptionsPatch, VisionRuntimeState,
} from '../senses';
import type { RuntimePatch, RuntimeState, SystemAudioState } from '../foundation/runtime-state';
import type { Attachment } from '../foundation/chat';

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
}

export interface SensesDesktopAPI {
  getVisionRuntime(): Promise<VisionRuntimeState>;
  setVisionOptions(patch: VisionOptionsPatch): Promise<VisionRuntimeState>;
  onVisionRuntime(callback: (state: VisionRuntimeState) => void): () => void;
  onVisionInitiative(callback: (event: VisionInitiativeEvent) => void): () => void;
  onVisionInitiativeDelivered(callback: (message: VisionInitiative) => void): () => void;
  /** I-174 item 9b: `{ afterReply: true }` when a step away's camera release ended the context: start the new conversation after her reply. */
  onVisionContextCleared(callback: (value?: { afterReply?: boolean; keepConversation?: boolean }) => void): () => void;
  ackVisionInitiative(id: string): Promise<boolean>;
  cancelVisionInitiative(): Promise<void>;
  noteUserInput(): Promise<void>;
  /** L2: the user is typing in a chat box (throttled by the renderer); lifts her out of her own thing. No text is sent. */
  noteChatTyping(): Promise<void>;
  /**
   * 屏幕只读大概: her "要我凑近看看吗" opened (its id and how long it stays) or closed (null); the companion shows "让她看清楚屏幕吗？" meanwhile
   * (src/senses/LookOfferPrompt.ts). "看吧" sends like "给她看看屏幕"; "不用" is `declineLookOffer`.
   */
  onLookOffer(callback: (offer: { id: string; ttlMs: number } | null) => void): () => void;
  /** "不用" on the companion's prompt: closes that offer without a frame (only the companion's window; an id that is not the open offer does nothing). */
  declineLookOffer(id: string): Promise<boolean>;
  onCameraSample(callback: (id: string) => void): () => void;
  publishCameraSample(id: string, dataUrl: string): Promise<void>;
  /**
   * I-019 喂食认图 (electron/senses/feed-recognition/): the companion window hands over the one picture of the bite just accepted (PNG/JPEG
   * bytes it decoded and shrank itself, no name or path); her line comes back on desk:feed-line and is reported shown or not.
   * The switch "喂食时让她认出是什么" (default on) lives in 隐私与设置.
   */
  feedSnack(input: import('../senses').FeedSnackInput): Promise<boolean>;
  onFeedLine(callback: (message: import('../senses').FeedLineMessage) => void): () => void;
  feedLineDone(input: import('../senses').FeedLineDone): Promise<boolean>;
  /** I-040 看一眼、听一下: her short second line after a look or a listen (companion window). */
  onSenseLine(callback: (message: import('../senses').SenseLineMessage) => void): () => void;
  senseLineDone(input: import('../senses').SenseLineDone): Promise<boolean>;
  getFeedRecognition(): Promise<import('../senses').FeedRecognitionView>;
  setFeedRecognition(enabled: boolean): Promise<import('../senses').FeedRecognitionView>;
  onFeedRecognition(callback: (view: import('../senses').FeedRecognitionView) => void): () => void;
  /** I-006 第 1 步 陪你做事 (electron/senses/user-activity.ts): the switch 「知道你是不是在忙」 in 隐私与设置 (default on; the control window changes it). */
  getUserActivity(): Promise<import('../senses').UserActivitySwitchView>;
  setUserActivity(enabled: boolean): Promise<import('../senses').UserActivitySwitchView>;
  onUserActivity(callback: (view: import('../senses').UserActivitySwitchView) => void): () => void;
  getMusicSettings(): Promise<MusicSettings>;
  setMusicSettings(settings: Partial<MusicSettings>): Promise<MusicSettings>;
  onMusicSettings(callback: (settings: MusicSettings) => void): () => void;
  getRuntimeState(): Promise<RuntimeState>;
  setRuntimeState(patch: RuntimePatch): Promise<RuntimeState>;
  onRuntimeState(callback: (state: RuntimeState) => void): () => void;
  getSystemAudioState(): Promise<SystemAudioState>;
  getAmbientAudioState(): Promise<AmbientAudioView>;
  beginAmbientAudio(mode: AmbientMode): Promise<AmbientAudioView>;
  confirmAmbientAudioCapture(sessionId: string): Promise<void>;
  stopAmbientAudio(expectedSessionId?: string): Promise<AmbientAudioView>;
  /** `fillerShape` (2026-11-20): one of her short sounds in a call (its mouth scale, or null when it ended): only the Unbound mouth follows it. */
  setAmbientAudioSpeaking(speaking: boolean, fillerShape?: number | null): Promise<void>;
  noteVisionUserActivity(): Promise<void>;
  submitAmbientAudio(segment: AmbientRuntimeSubmission): Promise<AmbientSubmissionResult>;
  listAmbientTranscripts(query: AmbientTranscriptQuery): Promise<AmbientTranscriptPage>;
  readAmbientTranscript(id: string): Promise<AmbientTranscript>;
  readAmbientComments(recordId: string): Promise<AmbientComment[]>;
  deleteAmbientTranscript(id: string): Promise<AmbientDeleteResult>;
  acknowledgeAmbientComment(id: string): Promise<{ comment: AmbientComment; context: SpeechRequestContext } | null>;
  /** I-016 一起听 (control window): how much raw material is kept, and her notes; clear the raw text; delete one note. */
  getListenTogetherView(): Promise<ListenTogetherView>;
  clearListenRaw(): Promise<ListenTogetherView>;
  deleteListenNote(id: string): Promise<ListenTogetherView>;
  onListenTogetherChanged(callback: () => void): () => void;
  onAmbientAudioState(callback: (state: AmbientAudioView) => void): () => void;
  onAmbientTranscriptChanged(callback: () => void): () => void;
  onAmbientCommentOffer(callback: (offer: { id: string; sessionId: string; text: string; held?: true }) => void): () => void;
  onAmbientCommentCommitted(callback: (comment: AmbientComment) => void): () => void;
  onAmbientCommentCancelled(callback: (event: { id: string }) => void): () => void;
  setSystemAudioSharing(enabled: boolean): Promise<SystemAudioState>;
  onSystemAudioState(callback: (state: SystemAudioState) => void): () => void;
  publishCameraFrame(dataUrl: string): Promise<void>;
  /**
   * Frames for the message about to be sent (识图第 1 步): none unless it asks her to look (`text`, read by the host with
   * shared/senses/look-request.ts), the user pressed "给她看看屏幕" (`look`), or it answers her "要我凑近看看吗" with a yes.
   * Without a hint nothing is attached (electron/senses/look-turns.ts).
   */
  sharedAttachments(hint?: { text?: string; look?: boolean; lookAtMe?: boolean }): Promise<Attachment[]>;
  transcribeAudio(wav: ArrayBuffer): Promise<string>;
  getAudioCaptureState(): Promise<AudioCaptureState>;
  onAudioCaptureState(callback: (value: AudioCaptureState) => void): () => void;
  ackAudioCapture(value: AudioCaptureAck): Promise<boolean>;
  submitAudioReadingPcm(value: AudioReadingPcm): Promise<AudioReadingPcmAck>;
  setAudioDanceIntent(enabled: boolean): Promise<AudioCaptureState>;
  setAudioDanceSourceIntent(value: AudioDanceIntent): Promise<AudioCaptureState>;
  submitAudioDanceSample(value: AudioDanceFrame): Promise<boolean>;
  onAudioDanceSample(callback: (value: AudioDanceFrame) => void): () => void;
  screenSources(): Promise<ScreenSource[]>;
  captureScreen(id: string): Promise<Attachment>;
  /** I-190: the screens and other programs' windows 屏幕共享 may read (opaque ids; titles shown only in this window) and the choice now. */
  screenSourceMenu(): Promise<import('../senses').ScreenSourceMenuView>;
  /** I-190: an id from the last menu, or null for 跟着系统默认. Never turns sharing on or off. */
  chooseScreenSource(id: string | null): Promise<import('../senses').ScreenSourceView>;
  getScreenSource(): Promise<import('../senses').ScreenSourceView>;
  onScreenSource(callback: (view: import('../senses').ScreenSourceView) => void): () => void;
  setCameraPermission(enabled: boolean): Promise<void>;
  /** Local pose sensing (I-001): component state only — enums and byte counts, never paths or frames. */
  /** Local speech recognizer (voice input, electron/senses/asr/): view, the「下载」question and its controls. Control window only (get/dismiss from either). */
  getLocalAsr(): Promise<import('../senses').LocalAsrView>;
  onLocalAsr(callback: (view: import('../senses').LocalAsrView) => void): () => void;
  downloadLocalAsr(): Promise<import('../senses').LocalAsrView>;
  cancelLocalAsrDownload(): Promise<void>;
  dismissLocalAsrPrompt(): Promise<import('../senses').LocalAsrView>;
  importLocalAsr(): Promise<import('../senses').LocalAsrView>;
  removeLocalAsr(): Promise<import('../senses').LocalAsrView>;
  /**
   * I-135 认出"不是你": the switch (default off; on starts the one-time model download), enrolment, one-click delete and the
   * component's advanced controls. Enums, counts and byte sizes only — never a picture, an embedding, a score or a path.
   * Control window only, except get / onFaceCheck (the companion shows the small light from the view).
   */
  getFaceCheck(): Promise<import('../senses').FaceCheckView>;
  onFaceCheck(callback: (view: import('../senses').FaceCheckView) => void): () => void;
  setFaceCheck(on: boolean): Promise<import('../senses').FaceCheckView>;
  downloadFaceComponents(): Promise<import('../senses').FaceCheckView>;
  cancelFaceDownload(): Promise<void>;
  startFaceEnrolment(): Promise<import('../senses').FaceCheckView>;
  cancelFaceEnrolment(): Promise<import('../senses').FaceCheckView>;
  deleteFaceData(): Promise<import('../senses').FaceCheckView>;
  /** Opens the host's own file dialog; the chosen paths stay in the host. */
  importFaceComponents(): Promise<import('../senses').FaceCheckView>;
  removeFaceComponents(): Promise<import('../senses').FaceCheckView>;
  /**
   * Unbound v1 step 3 「只认你的声音」 (shared/senses/voiceprint.ts): the switch (default off; on starts the one model download), recording
   * the sample, one-click delete and removing the model. States and counts only — never a sound, a voiceprint, a score or a path.
   * Control window only.
   */
  getVoiceprint(): Promise<import('./voiceprint').VoiceprintView>;
  onVoiceprint(callback: (view: import('./voiceprint').VoiceprintView) => void): () => void;
  setVoiceprint(on: boolean): Promise<import('./voiceprint').VoiceprintView>;
  retryVoiceprintDownload(): Promise<import('./voiceprint').VoiceprintView>;
  cancelVoiceprintDownload(): Promise<import('./voiceprint').VoiceprintView>;
  startVoiceprintEnrol(): Promise<import('./voiceprint').VoiceprintView>;
  cancelVoiceprintEnrol(): Promise<import('./voiceprint').VoiceprintView>;
  deleteVoiceprint(): Promise<import('./voiceprint').VoiceprintView>;
  removeVoiceprintComponent(): Promise<import('./voiceprint').VoiceprintView>;
  getPoseSensing(): Promise<import('../senses').PoseSensingView>;
  onPoseSensing(callback: (view: import('../senses').PoseSensingView) => void): () => void;
  downloadPoseComponents(): Promise<import('../senses').PoseSensingView>;
  cancelPoseDownload(): Promise<void>;
  dismissPosePrompt(): Promise<import('../senses').PoseSensingView>;
  /** Opens the host's own file dialog; the chosen paths stay in the host. */
  importPoseComponents(): Promise<import('../senses').PoseSensingView>;
  removePoseComponents(): Promise<import('../senses').PoseSensingView>;
  redetectPoseHardware(): Promise<import('../senses').PoseSensingView>;
  /** Developer mode only: signal categories and counts. */
  getPoseDiagnostics(): Promise<Partial<Record<string, number>>>;
  /** I-081: where pose sensing says the user is, for her gaze (companion window only; null otherwise or while sensing gives nothing). Memory only. */
  userGaze(): Promise<unknown>;
  /** I-016: the host's music / show / talk / quiet judgement as one developer-panel line (companion window only; '' elsewhere). */
  readListenKind(): Promise<string>;
  /** I-077 step 2: her memory of songs (electron/senses/song-memory.ts): the companion window looks a song up (match) and teaches it (learn); the control window counts and clears. Numbers only. */
  songMemory(request: { op: 'match' | 'learn'; characterId: string; sketch: import('../senses').SongSketch } | { op: 'count' | 'clear' }): Promise<{ id: string } | { count: number } | { cleared: number } | null>;
}
