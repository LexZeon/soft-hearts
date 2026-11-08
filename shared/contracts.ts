import type { MotionTrackCoverageRequest, MotionTrackCoverageView } from "./motion-track-coverage";
import type { PetReplyLingerAnswer } from './behaviors/reply-linger/interface';
import type {R20ProactiveOfferState,R20ProactiveOfferAcknowledgement,R20ProactiveOfferView,R20ProactiveOfferResponse,R20ProactiveOfferResult,R20ProactiveOfferEvent} from './r20-proactive-offer';
import type { RpsResponseRequest, RpsThrowRequest, RpsView } from './rps';
import type { MotionDownloadProgress, MotionLibraryStatus, MotionPackId } from "./motion-library";
import type { CompanionCommandChoiceRequest, CompanionCommandView } from './companion-commands';
import type { UserProfileView, UserProfileToggleRequest, UserProfileEditRequest, UserProfileDeleteRequest, UserProfileExpected,
  UserDiaryEditRequest, UserDiaryDeleteRequest, UserDiaryClearRequest } from './user-profile-ui';
import type { MotionTagPreferenceRequest } from './r32/motion-tag-contracts';
import type { MotionWeightView, MotionWeightSave, MotionWeightQuery, MotionWeightResults } from './motion-weights';
import type { CharacterCardState, CharacterDraft } from "./character-cards";
import type { ProactiveTalk } from './behaviors/inner-rhythm/knobs';
import type { CharacterRosterView } from "./character-roster";
import type { CharacterCardUpdatePreview } from "./character-card-update";
import type { CodexApprovalDecision, CodexTaskCapabilities, CodexTaskContinue, CodexTaskDetails, CodexTaskEvent, CodexTaskStart, CodexTaskSummary } from './codex-tasks';
import type { MotionLayer } from "./motion-layers";
import type { ApprovedReplySpeechSegment, SpeechRequestContext, SpeechWireEvent } from "./tts";
import type { SpeechDiagnosticRecord } from "./speech-diagnostics";
import type { MoodInput, MoodView, MoodParameterIdentity } from './mood-runtime';
import type { BehaviorMotionResource } from './behavior-motion';
import type { BodyMotionPlan, BodyMotionResource, BodyStageObservation } from './body-motion';
import type { MemoryConfig, MemoryEdit, MemoryListQuery, MemoryPage, MemoryReadQuery, MemoryRecordPage, RecentChat } from './memory';
import type { TtsConfig } from './tts';
import type { CueKind, FeedCueClip } from './feed-cue';
import type { BlushCalibrationView } from './blush';
import type { ModelProfileCacheView } from './model-profile';
import type { ChatGestureResource } from './chat-gesture';
import type { VisionOptionsPatch, VisionRuntimeState, VisionInitiativeEvent, VisionInitiative } from './vision-runtime';
import type { ProactiveOrigin } from './proactive-speech';
import type { TextMemorialOfferState, TextMemorialAcknowledgement, TextMemorialPresented, TextMemorialEvent, TextMemorialView, TextMemorialEdit, TextMemorialDelete } from './text-memorials';
import type { ModelPhysicsSettings } from './model-physics';
import type { CharacterResponseProfile, CharacterResponseState } from './character-response';
import type { LanguageProfile, LanguageState } from './personalize-language';
import type { MusicSettings } from './music-settings';
import type { EmojiId, EmojiSettings } from './single-emoji';
import type { AmbientMode, AmbientTranscript, AmbientTranscriptPage, AmbientTranscriptQuery, AmbientComment, AmbientDeleteResult } from './ambient-audio';
import type { AmbientAudioView, AmbientRuntimeSubmission, AmbientSubmissionResult } from './ambient-audio-runtime';
import type { VoiceCaptureBinding, VoicePcmSubmission, VoicePcmReceipt } from './voice-segments';
import type { VoiceInputSignal, VoiceConversationEvent } from './voice-conversation';
import type { AudioReadingView, AudioReadingIntent, AudioReadingAck } from './audio-reading-toggles';
import type { ListenTogetherView } from './listen-together';
import type { AudioCaptureState, AudioCaptureAck, AudioReadingPcm, AudioReadingPcmAck } from './audio-capture';
import type { AudioDanceFrame, AudioDanceIntent } from './audio-dance';

export interface ModelPhysicsSettingsPatch {
  hair?: Partial<ModelPhysicsSettings['hair']>;
  chest?: Partial<ModelPhysicsSettings['chest']>;
  quality?: ModelPhysicsSettings['quality'];
}

/**
 * Claude-only edition. Settings saved with the retired
 * "openai" / "ollama" kinds, or the Codex edition's "codex", load as "claude"
 * (electron/validation.ts validateProvider); their old encrypted key is never decrypted.
 */
export type ProviderKind = "claude";
export interface ProviderConfig {
  kind: ProviderKind;
  /** Unused by Claude Code; kept only because it is part of the stored chat-memory scope. */
  baseUrl: string;
  /** Claude Code model alias or id; empty follows Claude Code's own default. */
  model: string;
}
export interface VoiceInputConfig {
  baseUrl: string; model: string; language: string; apiKey?: string;
  /**
   * 识别方式: 'local' = the app's own recognizer on this computer (default, electron/asr/);
   * 'compatible' = the OpenAI-compatible transcription address above. A saved setting without it is migrated in
   * electron/validation.ts: still the default address → 'local'; an address the user changed → 'compatible'.
   */
  engine?: VoiceInputEngine;
}
export type VoiceInputEngine = 'local' | 'compatible';
/**
 * Why voice input stayed off (electron/runtime.ts, local recognizer only): the component is missing (the control window
 * asks), still downloading or installing, or there is no local recognizer for this computer.
 */
export type VoiceRefusal = 'needs-component' | 'preparing' | 'unavailable';
/**
 * Why 「和她一起听」 hears only the rhythm (I-016, Codex T-207): the local recognizer's reasons, or 'not-local' — 识别方式 is the
 * compatible address, and played sound is transcribed only on this computer (the approved plan: "声音只在本机，转写只在本机").
 */
export type AudioReadingRefusal = VoiceRefusal | 'not-local';
export interface RuntimeState {
  voiceInput: boolean;
  screenSharing: boolean;
  cameraSharing: boolean;
  voiceOwner: 'controls' | 'pet' | null;
  cameraOwner: 'controls' | 'pet' | null;
  /**
   * Camera switch 「姿势识别」 on (I-001 local pose sensing): frames stay in the hidden sensor window and the local inference
   * process. I-036: one of the two independent switches under 「摄像头共享」; `cameraSharing` is true while
   * either is on.
   */
  cameraLocal?: boolean;
  /**
   * Camera switch 「发图片」 on (I-036): the owner window keeps a small frame ready and each message the
   * user sends carries it (a clear one when the user asks her to look); no component download.
   */
  cameraImages?: boolean;
  /** 「发图片」 is on but the user said not to look (electron/look-turns.ts): no frame is taken until the user asks her to look. */
  cameraHeld?: boolean;
  /** Only in the reply to the window that asked to turn the camera on and was refused (never in the broadcast state). */
  cameraRefused?: CameraRefusal;
  /** Only in the reply to the window that asked to turn voice input on and was refused (never in the broadcast state). */
  voiceRefused?: VoiceRefusal;
}
/**
 * Why 「姿势识别」 stayed off (electron/runtime.ts): the local pose component is missing (the control window asks),
 * it is still downloading or installing, or local sensing could not be set up at all. None of them turns 「发图片」 on
 * instead: that is the user's own separate switch (I-036).
 */
export type CameraRefusal = 'needs-component' | 'preparing' | 'unavailable';
/**
 * `cameraImages` / `cameraLocal`: the two camera switches (I-036). `cameraSharing: false` turns both off; `cameraSharing: true`
 * alone is the old single switch and means 「姿势识别」 (what the camera meant before I-036).
 */
export interface RuntimePatch { voiceInput?: boolean; screenSharing?: boolean; cameraSharing?: boolean; cameraImages?: boolean; cameraLocal?: boolean; }
export interface SystemAudioState { active: boolean; }
export interface CameraConfig {
  yaw: number;
  pitch: number;
  distance: number;
  targetY: number;
  targetX: number;
  targetZ?: number;
  fov: number;
}
export interface AssetRef {
  path: string;
  url: string;
  name: string;
}
export interface AssetSaveBaseline {
  model: string | null;
  motion: string | null;
  motionLayers?: { gesture: string | null; expression: string | null };
}
export interface AppSettings {
  /** 2 since R29f (the default render rate moved to 60 fps; a version-1 file on the old default 30 moves once). */
  version: 1 | 2;
  model: AssetRef | null;
  motion: AssetRef | null;
  motionLayers?: { gesture: AssetRef | null; expression: AssetRef | null };
  camera: CameraConfig;
  provider: ProviderConfig;
  persona: string;
  pet: {
    visible: boolean;
    alwaysOnTop: boolean;
    clickThrough: boolean;
    followMouse: boolean;
    fps: number;
    breath: number;
    scale?: number;
    size?: { width: number; height: number };
  };
  /**
   * `moodInfluence`: 0–100 % (default 50) of the reply mood's small rate/pitch nudge on the system voice (R02).
   * `firstChunk` (I-029): where a streaming Claude reply's first read-aloud piece ends: 'sentence' (default, the first whole
   * sentence) or 'comma' (may end at a comma inside the first sentence; shared/first-speech-chunk.ts). Both voices.
   * `pauseTalk` (F7 停停说说, default off = absent): haiku decides, from her mood and character, where her bubbles after the first
   * pause and whether she stops to wait for the user (shared/behaviors/pause-talk/); the first sentence never waits.
   */
  voice: { enabled: boolean; voiceURI: string; rate: number; volume: number; moodInfluence?: number; firstChunk?: 'sentence' | 'comma'; pauseTalk?: boolean };
  tts?: TtsConfig;
  voiceInput?: VoiceInputConfig;
  agent: { workingDirectory: string; model: string; writable: boolean };
  /** Inner loop (L1): she decides by herself at mood opportunities. Default on; host-owned intent (setInnerLoop). */
  innerLoop: boolean;
  /**
   * 她主动找你说话: 'less' | 'normal' (default, = today) | 'more'. Scales how often her own moments come
   * (shared/behaviors/inner-rhythm/); the card's speech caps are not touched. Absent in older files: 'normal'.
   */
  proactiveTalk?: ProactiveTalk;
  /**
   * 体验记录 (E2, "保留体验记录（只存本机）"): default off; host-owned intent (setExperienceJournal), never a stale form field.
   * On: `<profile>/journal/<local date>.jsonl` (electron/journal/writer.ts).
   */
  experienceJournal?: boolean;
}
export interface Attachment {
  source: "screen" | "camera";
  dataUrl: string;
  /**
   * Set by the host on a frame it took from sharing for a message (electron/look-attachments.ts); the window sends it back
   * unchanged. The host only trusts tickets it handed out itself. A snapshot the user attached by hand has none.
   */
  shareTicket?: string;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  origin?: ProactiveOrigin;
}
export interface ChatRequest {
  id: string;
  messages: ChatMessage[];
  attachments: Attachment[];
  profile?: UserProfileExpected;
  /** Renderer wall-clock send time (Date.now()), used only for developer-mode latency timing. */
  sentAt?: number;
  /**
   * F7 停停说说 (switch on only): the user spoke while her previous reply (`id`) had shown only `shown` characters in its bubbles.
   * A number, never text: the host takes the rest from its own copy of that reply.
   */
  pauseCut?: import('./behaviors/pause-talk/interface').PauseTalkCut;
}
export interface ChatStarted { id: string; messages: ChatMessage[]; owner: 'controls' | 'pet';
  /** Host-classified local control turn. It must preserve unrelated playback. */
  readoutControl?: true;
}
export interface StreamEvent {
  id: string;
  kind: "chat" | "agent";
  type: "delta" | "status" | "done" | "error";
  text: string;
  /** On a chat `error` that is Claude being unavailable (shared/chat-availability.ts): what she says instead of a technical error. */
  outage?: import("./chat-availability").ChatOutageNotice;
}
export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
}
export interface PointerPosition {
  x: number;
  y: number;
}
export type PetWindowOperation = 'move' | 'nw' | 'ne' | 'sw' | 'se';
export interface PetReplyAnchor { x: number; y: number; visible: boolean; radius?: number; }
export interface PetReplyUpdate {
  text?: string;
  state?: 'waiting' | 'streaming' | 'complete' | 'hidden';
  anchor?: PetReplyAnchor;
  /** Visual interaction fade only; never renews or pauses the reply lifetime. */
  interactionOpacity?: number;
  /** Ordinary completed reply only; proactive and ambient presentation keep their original mode. */
  segmented?: boolean;
  /** Ordinary chat only, sent with `text`: display-only layout of that exact text (R27). */
  pieces?: PetReplyPieces;
}
/** End offsets into the reply text (last = text.length). 'paragraphs' keeps one bubble; 'bubbles' gives each piece its own. */
export interface PetReplyPieces { mode: 'paragraphs' | 'bubbles'; ends: number[] }
export interface WindowVisibilityState {
  windowId: number;
  revision: number;
  /** Actual visibility of this sender's native window, including minimization. */
  visible: boolean;
  /** Host-owned requested pet visibility, independent of this window's role. */
  petVisible: boolean;
}
/** Pet renderer's own drawing state, reported for developer diagnostics only. */
export interface PetPresentationSample {
  reason: 'startup' | 'restore';
  visibility: 'visible' | 'hidden' | 'prerender' | 'unknown';
  hostVisible: boolean;
  canvasWidth: number;
  canvasHeight: number;
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
  /** null when no WebGL canvas exists. */
  contextLost: boolean | null;
  /** An animation frame actually ran shortly after the probe started. */
  frameAdvanced: boolean;
}
/** Bounded developer log of pet window facts; never contains settings, paths or chat. */
export interface PetWindowDiagnosticEntry {
  /** Milliseconds since the host process started. */
  t: number;
  event: string;
  detail: Record<string, string | number | boolean | null>;
}
export interface PetWindowDiagnosticsView {
  enabled: boolean;
  entries: PetWindowDiagnosticEntry[];
}

export interface DesktopAPI {
  getUiLanguage(): Promise<import('./ui-language').UiLanguageView>;
  setUiLanguage(preference: import('./ui-language').UiLanguagePreference): Promise<import('./ui-language').UiLanguageView>;
  getCharacterStickers():Promise<import('./character-sticker').CharacterStickerView>;
  beginCharacterStickerReference():Promise<import('./character-sticker').StickerReferenceChallenge>;
  acceptCharacterStickerReference(value:{challengeId:string;png:string;modelUrl:string;loadGeneration:number}):Promise<import('./character-sticker').CharacterStickerView>;
  generateCharacterSticker(value:{referenceId:string;intent:EmojiId}):Promise<import('./character-sticker').CharacterStickerView>;
  saveCharacterSticker(value:{resultId:string}):Promise<import('./character-sticker').CharacterStickerView>;
  previewCharacterSticker(value:{assetId:string}):Promise<boolean>;
  retireCharacterStickerReference(value:{challengeId:string}):Promise<import('./character-sticker').CharacterStickerView>;
  cancelCharacterSticker():Promise<import('./character-sticker').CharacterStickerView>;
  onCharacterStickers(callback:(view:import('./character-sticker').CharacterStickerView)=>void):()=>void;
  reportPetFramingState(state: import('./pet-framing').PetFramingState): Promise<void>;
  beginPetFraming(id: string): Promise<boolean>;
  completePetFraming(report: import('./pet-framing').PetFramingReport): Promise<boolean>;
  noteManualCameraChange(): Promise<void>;
  onPetFramingRequest(callback: (request: import('./pet-framing').PetFramingRequest) => void): () => void;
  getVisionRuntime(): Promise<VisionRuntimeState>;
  setVisionOptions(patch: VisionOptionsPatch): Promise<VisionRuntimeState>;
  onVisionRuntime(callback: (state: VisionRuntimeState) => void): () => void;
  onVisionInitiative(callback: (event: VisionInitiativeEvent) => void): () => void;
  onVisionInitiativeDelivered(callback: (message: VisionInitiative) => void): () => void;
  onVisionContextCleared(callback: () => void): () => void;
  ackVisionInitiative(id: string): Promise<boolean>;
  cancelVisionInitiative(): Promise<void>;
  noteUserInput(): Promise<void>;
  /** L2: the user is typing in a chat box (throttled by the renderer); lifts her out of her own thing. No text is sent. */
  noteChatTyping(): Promise<void>;
  /**
   * 屏幕只读大概: her "要我凑近看看吗" opened (its id and how long it stays) or closed (null); the pet shows "让她看清楚屏幕吗？" meanwhile
   * (src/ui/LookOfferPrompt.ts). "看吧" sends like "给她看看屏幕"; "不用" is `declineLookOffer`.
   */
  onLookOffer(callback: (offer: { id: string; ttlMs: number } | null) => void): () => void;
  /** "不用" on the pet's prompt: closes that offer without a frame (only the pet's window; an id that is not the open offer does nothing). */
  declineLookOffer(id: string): Promise<boolean>;
  onCameraSample(callback: (id: string) => void): () => void;
  publishCameraSample(id: string, dataUrl: string): Promise<void>;
  getMood(): Promise<MoodView>;
  onMood(callback: (view: MoodView) => void): () => void;
  setMoodDeveloperMode(enabled: boolean): Promise<MoodView>;
  setMoodExpressions(enabled: boolean): Promise<MoodView>;
  setMoodParameters(parameters: unknown, expected: MoodParameterIdentity): Promise<MoodView>;
  restoreMoodParameters(expected: MoodParameterIdentity): Promise<MoodView>;
  /** Inner loop switch (app setting) and, in developer mode, its last 20 diagnostic lines. */
  getInnerLoop(): Promise<import('./inner-loop').InnerLoopView>;
  setInnerLoop(enabled: boolean): Promise<import('./inner-loop').InnerLoopView>;
  onInnerLoop(callback: (view: import('./inner-loop').InnerLoopView) => void): () => void;
  getBlushCalibration(): Promise<BlushCalibrationView>;
  setBlushCalibration(modelKey: string, calibration: unknown): Promise<BlushCalibrationView>;
  onBlushCalibration(callback: (view: BlushCalibrationView) => void): () => void;
  /** Model profile cache for the current model (content-hash keyed, local only). */
  getModelProfile(): Promise<ModelProfileCacheView>;
  saveModelProfile(modelKey: string, profile: unknown): Promise<boolean>;
  /** Universal skeleton step 1: the current model's library motion scores (content-hash keyed, part words and numbers only). Controls window. */
  saveMotionFits(modelKey: string, record: unknown): Promise<boolean>;
  /**
   * I-024 模型体检 (shared/model-capability-check.ts): the current model's record (content-hash keyed, local only) and its cached
   * profile so a page can tell the record is its stage's model. Asking sends haiku only this model's own part names, once per model.
   */
  getModelCapabilities(): Promise<import('./model-capability-check').ModelCapabilityView>;
  askModelCapabilityNames(modelKey: string, request: import('./model-capability-check').ModelCheckRequest): Promise<import('./model-capability-check').ModelCheckAskResult>;
  saveModelCapabilityCheck(modelKey: string, matches: import('./model-capability').HaikuMatches): Promise<import('./model-capability-check').ModelCapabilityRecord>;
  /** Control window only: the user's on/off on the character page (null: follow what was detected). */
  setModelCapabilityChoice(modelKey: string, id: import('./model-capability').ModelCapabilityId, choice: import('./model-capability').CapabilityChoice): Promise<import('./model-capability-check').ModelCapabilityRecord>;
  onModelCapabilities(callback: (update: import('./model-capability-check').ModelCapabilityUpdate) => void): () => void;
  /** Control window only: 试一下 on the pet; the pet's stage answers through reportModelCapabilityPreview. */
  previewModelCapability(id: import('./model-capability').ModelCapabilityId): Promise<import('./model-capability-check').CapabilityPreviewResult>;
  onModelCapabilityPreview(callback: (request: import('./model-capability-check').CapabilityPreviewRequest) => void): () => void;
  reportModelCapabilityPreview(requestId: string, ok: boolean): Promise<void>;
  resolveChatGesture(cueId: string, token: string): Promise<ChatGestureResource>;
  /** 她自己的生活: the pinned library motion of her current state only (electron/her-life/motion-resource.ts). */
  resolveHerLifeMotion(motionId: string, token: string): Promise<import('./her-life').HerLifeMotionResource>;
  resolveBehaviorMotion(cueId: string, token: string): Promise<BehaviorMotionResource>;
  getBehaviorBodyPlan(token: string, observation?: BodyStageObservation): Promise<BodyMotionPlan>;
  resolveBehaviorBody(cueId: string, token: string): Promise<BodyMotionResource>;
  isBehaviorModelSupported(): Promise<boolean>;
  moodInteraction(input: MoodInput): Promise<MoodView>;
  listMemories(query?: MemoryListQuery): Promise<MemoryPage>;
  readMemory(id: string, query?: MemoryReadQuery): Promise<MemoryRecordPage>;
  /** C2/C3: her current conversation for the chat window (either window; read from the existing chat memory). */
  getRecentChat(): Promise<RecentChat>;
  editMemory(id: string, edit: MemoryEdit): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  /** I-021 (control window): one memory's note, read only, and deleting just the note (the memory stays). */
  readMemoryNote(id: string): Promise<import('./memory-notes/interface').MemoryNoteState>;
  deleteMemoryNote(id: string): Promise<import('./memory-notes/interface').MemoryNoteState>;
  getMemoryConfig(): Promise<MemoryConfig>;
  setMemoryConfig(config: unknown): Promise<void>;
  newConversation(): Promise<void>;
  onChatReset(callback: () => void): () => void;
  onMemoryChanged(callback: () => void): () => void;
  listCodexTasks(): Promise<CodexTaskSummary[]>;
  readCodexTask(taskId: string): Promise<CodexTaskDetails>;
  startCodexTask(request: CodexTaskStart): Promise<CodexTaskSummary>;
  continueCodexTask(request: CodexTaskContinue): Promise<CodexTaskSummary>;
  interruptCodexTask(taskId: string): Promise<void>;
  respondCodexApproval(taskId: string, approvalId: string, decision: CodexApprovalDecision): Promise<void>;
  codexTaskCapabilities(): Promise<CodexTaskCapabilities>;
  onCodexTaskEvent(callback: (event: CodexTaskEvent) => void): () => void;
  r20ProactiveOfferGet(): Promise<R20ProactiveOfferState>;
  r20ProactiveOfferAcknowledge(input: R20ProactiveOfferAcknowledgement): Promise<R20ProactiveOfferView | null>;
  r20ProactiveOfferRespond(input: R20ProactiveOfferResponse): Promise<R20ProactiveOfferResult>;
  r20ProactiveOfferEvents(callback: (event: R20ProactiveOfferEvent) => void): () => void;
  /** G1 猜拳 (electron/rps/host.ts): the pet window's game view, the user's hand (one input source), accept / decline / quit. */
  rpsGet(): Promise<RpsView | null>;
  rpsThrow(input: RpsThrowRequest): Promise<string>;
  rpsRespond(input: RpsResponseRequest): Promise<boolean>;
  rpsEvents(callback: (view: RpsView | null) => void): () => void;
  /**
   * I-019 喂食认图 (electron/feed-recognition/): the pet window hands over the one picture of the bite just accepted (PNG/JPEG
   * bytes it decoded and shrank itself, no name or path); her line comes back on desk:feed-line and is reported shown or not.
   * The switch "喂食时让她认出是什么" (default on) lives in 隐私与设置.
   */
  feedSnack(input: import('./feed-recognition').FeedSnackInput): Promise<boolean>;
  onFeedLine(callback: (message: import('./feed-recognition').FeedLineMessage) => void): () => void;
  feedLineDone(input: import('./feed-recognition').FeedLineDone): Promise<boolean>;
  /** I-040 看一眼、听一下: her short second line after a look or a listen (pet window). */
  onSenseLine(callback: (message: import('./sense-router').SenseLineMessage) => void): () => void;
  senseLineDone(input: import('./sense-router').SenseLineDone): Promise<boolean>;
  getFeedRecognition(): Promise<import('./feed-recognition').FeedRecognitionView>;
  setFeedRecognition(enabled: boolean): Promise<import('./feed-recognition').FeedRecognitionView>;
  onFeedRecognition(callback: (view: import('./feed-recognition').FeedRecognitionView) => void): () => void;
  /** I-027 心情调整员 (electron/mood-judge/): the switch in 隐私与设置 (default off; the control window changes it) and its daily cap. */
  getMoodJudge(): Promise<import('./behaviors/mood-judge/interface').MoodJudgeSwitchView>;
  setMoodJudge(enabled: boolean): Promise<import('./behaviors/mood-judge/interface').MoodJudgeSwitchView>;
  onMoodJudge(callback: (view: import('./behaviors/mood-judge/interface').MoodJudgeSwitchView) => void): () => void;
  /** I-037 新的反应方式 (electron/reactions/): the switch in 隐私与设置 (on by default in every version, 2026-11-07) and the current character's six 反应倾向 (角色页). */
  getReactions(): Promise<import('./behaviors/reactions/views').ReactionSwitchView>;
  setReactions(enabled: boolean): Promise<import('./behaviors/reactions/views').ReactionSwitchView>;
  getReactionDispositions(): Promise<import('./behaviors/reactions/views').ReactionDispositionsView>;
  /** Some or all of the six (0–100 integers), or null: back to what the character card gives. */
  setReactionDispositions(values: Partial<Record<import('./behaviors/reactions/dispositions').DispositionId, number>> | null): Promise<import('./behaviors/reactions/views').ReactionDispositionsView>;
  onReactions(callback: (view: import('./behaviors/reactions/views').ReactionsBroadcast) => void): () => void;
  /** Pet window: one reaction cue for its stage (src/stage/reaction-performers.ts). */
  onReaction(callback: (cue: unknown) => void): () => void;
  /** Pet window: what its stage did with a reaction cue ('played', 'busy', 'unsupported' or 'invalid'); the host records that, not just "sent". */
  reactionResult(input: import('./behaviors/reactions/stage').ReactionStageReply): Promise<boolean>;
  /** I-006 第 1 步 陪你做事 (electron/user-activity.ts): the switch 「知道你是不是在忙」 in 隐私与设置 (default on; the control window changes it). */
  getUserActivity(): Promise<import('./behaviors/user-activity/interface').UserActivitySwitchView>;
  setUserActivity(enabled: boolean): Promise<import('./behaviors/user-activity/interface').UserActivitySwitchView>;
  onUserActivity(callback: (view: import('./behaviors/user-activity/interface').UserActivitySwitchView) => void): () => void;
  proposeCodexTask(prompt: string): Promise<void>;
  onCodexTaskProposal(callback: (prompt: string) => void): () => void;
  /** R20 opt-in switch (off by default). Turning it on shows a native first-run notice. */
  setClaudeTasksEnabled(enabled: boolean): Promise<CodexTaskCapabilities>;
  claudeTasksEnabled(): Promise<boolean>;
  onClaudeTasks(callback: (state: { enabled: boolean }) => void): () => void;
  /** #5: a 'complete' update answers with that reply's lifetime, decided by the host (shared/behaviors/reply-linger/). */
  updatePetReply(update: PetReplyUpdate): Promise<PetReplyLingerAnswer | void>;
  getCharacterCards(): Promise<CharacterCardState>;
  saveCharacterCard(draft: CharacterDraft, id?: string): Promise<CharacterCardState>;
  /** F6 "更真实的情绪" of one card: on asks the user first in a native dialog (declined: the cards come back unchanged); off saves at once. */
  requestCharacterRealerEmotions(id: string, value: boolean): Promise<CharacterCardState>;
  activateCharacterCard(id: string): Promise<CharacterCardState>;
  deleteCharacterCard(id: string): Promise<CharacterCardState>;
  bindCharacterModel(id: string, enabled: boolean): Promise<CharacterCardState>;
  importCharacterCard(): Promise<CharacterCardState | null>;
  exportCharacterCard(id: string): Promise<boolean>;
  onCharacterCards(callback: (state: CharacterCardState) => void): () => void;
  /** C2 角色页: the card wall (display data only), refreshed on card changes and on `onCharacterRoster`. */
  getCharacterRoster(): Promise<CharacterRosterView>;
  /** C2 换成她: waits for her current line, then switches model, persona and memories together. */
  switchCharacter(id: string): Promise<CharacterCardState>;
  /** C2 新增角色 · 用现在的模型. */
  createCharacterForCurrentModel(): Promise<CharacterCardState>;
  /** C2 关联别的模型 / 重新选模型文件 (native file dialog in the host). */
  bindCharacterModelFile(id: string): Promise<CharacterCardState | null>;
  /** C2 小头像: a PNG data URL of the current card on its own model; stays on this computer. */
  saveCharacterAvatar(id: string, modelUrl: string, dataUrl: string): Promise<boolean>;
  /** C2 删除: only the card unless `forgetMemories` (the unticked "同时删除她的记忆"). */
  deleteCharacter(id: string, options: { forgetMemories: boolean }): Promise<CharacterCardState>;
  /** C3 用角色卡文件更新: the host's file dialog, then what the file would change on this card (null: cancelled). Nothing is written. */
  previewCharacterCardUpdate(id: string): Promise<CharacterCardUpdatePreview | null>;
  /** C3: applies exactly that preview to exactly that card, in place (same id; her memories stay hers). */
  applyCharacterCardUpdate(token: string): Promise<CharacterCardState>;
  discardCharacterCardUpdate(token: string): Promise<void>;
  onCharacterRoster(callback: () => void): () => void;
  /** I-018 理解讨论 (electron/character-understanding.ts): the discussion the host keeps (null: none). */
  getCharacterUnderstanding(): Promise<import("./character-understanding").UnderstandingView | null>;
  /** Opens a discussion about this card; Claude speaks first (the view follows on `onCharacterUnderstanding`). */
  startCharacterUnderstanding(id: string, trigger: import("./character-understanding").UnderstandingTrigger, changedFields?: string[]): Promise<import("./character-understanding").UnderstandingView>;
  replyCharacterUnderstanding(sessionId: string, text: string): Promise<import("./character-understanding").UnderstandingView>;
  /** "就这样": Claude writes the 理解说明 now. */
  finishCharacterUnderstanding(sessionId: string): Promise<import("./character-understanding").UnderstandingView>;
  retryCharacterUnderstanding(sessionId: string): Promise<import("./character-understanding").UnderstandingView>;
  /** 跳过 / 关闭: nothing is saved. */
  closeCharacterUnderstanding(sessionId: string): Promise<void>;
  /** The user's OK: the 理解说明 (and the chosen mood plan) go into the same card, in place. */
  saveCharacterUnderstanding(sessionId: string, choices: import("./character-understanding").UnderstandingSaveChoices): Promise<CharacterCardState>;
  onCharacterUnderstanding(callback: (view: import("./character-understanding").UnderstandingView | null) => void): () => void;
  getCharacterResponse(id: string): Promise<CharacterResponseState>;
  saveCharacterResponse(id: string, profile: CharacterResponseProfile, expectedRevision?: number): Promise<CharacterResponseState>;
  copyCharacterResponse(sourceId: string, targetId: string): Promise<CharacterResponseState>;
  onCharacterResponse(callback: (state: CharacterResponseState) => void): () => void;
  openLanguageAuthoring(id: string, savedRevision: number): Promise<import('./personalize-authoring').LanguageAuthoringSession>;
  researchLanguage(request: import('./personalize-authoring').LanguageResearchRequest): Promise<import('./personalize-authoring').LanguageResearchResult>;
  cancelLanguageAuthoring(id: string): Promise<void>;
  closeLanguageAuthoring(id: string): Promise<void>;
  getPersonalizeLanguage(id: string): Promise<LanguageState>;
  getVisualAuthoring(id:string):Promise<import('./personalize-visual').VisualAuthoringState>;
  chooseVisualMaterial(id:string,revision:number):Promise<import('./personalize-visual').VisualAuthoringState>;
  researchVisual(request:import('./personalize-visual').VisualResearchRequest):Promise<import('./personalize-visual').VisualAuthoringState>;
  researchExpression(request:import('./expression-composition').ExpressionResearchRequest):Promise<import('./personalize-visual').VisualAuthoringState>;
  editExpression(request:import('./expression-composition').ExpressionEditRequest):Promise<import('./personalize-visual').VisualAuthoringState>;
  previewExpression(id:string,revision:number):Promise<import('./expression-composition').ExpressionPreview>;
  resolveExpressionPreview(id:string,token:string,generation:number):Promise<import('./expression-composition').ExpressionResource>;
  previewVisualBinding(id:string,revision:number,selection:import('./personalize-visual').VisualSelection):Promise<import('./personalize-visual').VisualPreview>;
  visualPreviewReceipt(request:import('./personalize-visual').VisualPreviewReceipt):Promise<void>;
  resolveVisualPreview(id:string,token:string,stageGeneration:number):Promise<import('./behavior-motion').BehaviorMotionResource>;
  saveVisualBehavior(request:import('./personalize-visual').VisualSaveRequest):Promise<import('./personalize-visual').VisualAuthoringState>;
  changeVisualBehavior(request:import('./personalize-visual').VisualChangeRequest):Promise<import('./personalize-visual').VisualAuthoringState>;
  cancelVisualAuthoring(id:string):Promise<void>;
  onVisualPreviewCancelled(callback:(value:{id:string;token:string})=>void):()=>void;
  beginSurprisePreview(recipe?:import('./surprise-preview').ManualEmotionRecipe):Promise<import('./surprise-preview').SurprisePreviewGrant>;
  resolveSurprisePreview(id:string,stageGeneration:number):Promise<import('./surprise-preview').SurprisePreviewGrant>;
  stopSurprisePreview(id?:string):Promise<void>;
  onSurprisePreviewCancelled(callback:(value:{id:string})=>void):()=>void;
  getBodyAuthoring(id:string):Promise<import('./personalize-body').BodyVisualState>;
  chooseBodyMaterial(id:string,revision:number):Promise<import('./personalize-body').BodyVisualState>;
  researchBody(request:import('./personalize-body').BodyVisualResearchRequest):Promise<import('./personalize-body').BodyVisualState>;
  discardBodyAdvice(id:string,revision:number):Promise<void>;
  consumeBodyAdvice(id:string,revision:number,candidateId:string,side?:'left'|'right'|'both'|'head'|'torso'|'all'):Promise<import('./personalize-body').BodyAdviceFill>;
  previewBodyBinding(id:string,revision:number,selection:import('./personalize-body').BodyPoseSelection):Promise<import('./personalize-body').BodyPosePreview>;
  previewFixedBodyBinding(id:string,revision:number,selection:import('./personalize-body').BodyPoseSelection):Promise<import('./personalize-body').BodyPosePreview>;
  bodyPreviewReceipt(request:import('./personalize-body').BodyPoseReceipt):Promise<void>;
  resolveBodyPreview(id:string,token:string,stageGeneration:number):Promise<import('./personalize-body').BodyPoseBinding>;
  saveBodyBehavior(request:import('./personalize-body').BodyPoseSaveRequest):Promise<import('./personalize-body').BodyVisualState>;
  changeBodyBehavior(request:import('./personalize-body').BodyPoseChangeRequest):Promise<import('./personalize-body').BodyVisualState>;
  cancelBodyAuthoring(id:string):Promise<void>;
  onBodyPreviewCancelled(callback:(value:{id:string;token:string})=>void):()=>void;
  savePersonalizeLanguage(id: string, profile: LanguageProfile, expectedRevision: number): Promise<LanguageState>;
  undoPersonalizeLanguage(id: string, expectedRevision: number): Promise<LanguageState>;
  onPersonalizeLanguage(callback: (state: LanguageState) => void): () => void;
  getWindowVisibility(): Promise<WindowVisibilityState>;
  onWindowVisibility(callback: (state: WindowVisibilityState) => void): () => void;
  setPetVisible(visible: boolean): Promise<AppSettings>;
  setPetAlwaysOnTop(enabled: boolean): Promise<AppSettings>;
  getSettings(): Promise<AppSettings>;
  getModelPhysicsSettings(): Promise<ModelPhysicsSettings>;
  getMusicSettings(): Promise<MusicSettings>;
  getSingleEmojiSettings(): Promise<EmojiSettings>;
  setSingleEmojiSettings(settings: EmojiSettings): Promise<EmojiSettings>;
  previewSingleEmoji(id: EmojiId): Promise<boolean>;
  onSingleEmojiSettings(callback: (settings: EmojiSettings) => void): () => void;
  setMusicSettings(settings: Partial<MusicSettings>): Promise<MusicSettings>;
  onMusicSettings(callback: (settings: MusicSettings) => void): () => void;
  setModelPhysicsSettings(settings: ModelPhysicsSettingsPatch): Promise<ModelPhysicsSettings>;
  onModelPhysicsSettings(callback: (settings: ModelPhysicsSettings) => void): () => void;
  saveSettings(settings: AppSettings, assetBaseline?: AssetSaveBaseline): Promise<AppSettings>;
  synthesizeSpeech(id: string, text: string, context?: SpeechRequestContext): Promise<void>;
  beginSpeechPlaybackActivity(playbackId: string): Promise<string | null>;
  endSpeechPlaybackActivity(playbackId: string, lease: string): Promise<void>;
  prepareCharacterSpeechPreview(): Promise<SpeechRequestContext>;
  cancelSpeech(id: string): Promise<void>;
  releaseSpeech(id: string): Promise<void>;
  /** R02 dev diagnostics: one timing record (no text); written only in developer mode. */
  recordSpeechDiagnostic(record: SpeechDiagnosticRecord): Promise<void>;
  /** B06 feeding cue ("啊"/"嗯") in the character's Bailian voice; null when unavailable. Fixed host text, never a reply. */
  synthesizeFeedCue(kind: CueKind): Promise<FeedCueClip | null>;
  nextReplySpeechSegment(replyId: string, completedIndex?: number): Promise<ApprovedReplySpeechSegment | null>;
  acknowledgeReplySpeechReady(replyId: string): Promise<boolean>;
  cancelReplySpeech(replyId: string): Promise<void>;
  onReplySpeechSegment(callback: (segment: ApprovedReplySpeechSegment) => void): () => void;
  /** F7 说话节奏: each accepted reply's pace (its id, a multiplier for the bubbles after the first, shyness). Presentation only. */
  onReplyRhythm(callback: (pacing: import('./reply-rhythm').ReplyRhythmPacing) => void): () => void;
  /** F7 停停说说: haiku's plan for one reply (its id, pauses after which sentences, where she waits for the user). Presentation only. */
  onPauseTalk(callback: (cue: import('./behaviors/pause-talk/interface').PauseTalkCue) => void): () => void;
  onReplySpeechCancelled(callback: (replyId: string) => void): () => void;
  onSpeechEvent(callback: (event: SpeechWireEvent) => void): () => void;
  openTtsConsole(): Promise<void>;
  openTtsGuide(): Promise<void>;
  /** "Chat is not available" panel (electron/chat-availability-host.ts). None of these takes an argument. */
  getChatAvailability(): Promise<import('./chat-availability').ChatAvailabilityView>;
  onChatAvailability(callback: (view: import('./chat-availability').ChatAvailabilityView) => void): () => void;
  retryChatAvailability(): Promise<import('./chat-availability').ChatAvailabilityView>;
  openClaudeHelp(): Promise<void>;
  openNetworkSettings(): Promise<void>;
  savePetView(view: { camera?: CameraConfig; scale?: number }): Promise<AppSettings>;
  recoverPet(): Promise<AppSettings>;
  onPetRecovered(callback: () => void): () => void;
  /** Controls only; entries stay empty unless developer diagnostics are on. */
  getPetWindowDiagnostics(): Promise<PetWindowDiagnosticsView>;
  /** Pet only; diagnostic report, never a command. */
  reportPetPresentation(sample: PetPresentationSample): Promise<void>;
  setPetWindowOperation(operation: PetWindowOperation | null): Promise<void>;
  /** Pet only, click-through: take the mouse while the pointer is over her or a visible control. Resolves whether the window now receives it. */
  setPetPointerInput(receive: boolean): Promise<boolean>;
  getRuntimeState(): Promise<RuntimeState>;
  setRuntimeState(patch: RuntimePatch): Promise<RuntimeState>;
  onRuntimeState(callback: (state: RuntimeState) => void): () => void;
  getSystemAudioState(): Promise<SystemAudioState>;
  getAmbientAudioState(): Promise<AmbientAudioView>;
  beginAmbientAudio(mode: AmbientMode): Promise<AmbientAudioView>;
  confirmAmbientAudioCapture(sessionId: string): Promise<void>;
  stopAmbientAudio(expectedSessionId?: string): Promise<AmbientAudioView>;
  setAmbientAudioSpeaking(speaking: boolean): Promise<void>;
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
  onAmbientCommentOffer(callback: (offer: { id: string; sessionId: string; text: string }) => void): () => void;
  onAmbientCommentCommitted(callback: (comment: AmbientComment) => void): () => void;
  onAmbientCommentCancelled(callback: (event: { id: string }) => void): () => void;
  setSystemAudioSharing(enabled: boolean): Promise<SystemAudioState>;
  onSystemAudioState(callback: (state: SystemAudioState) => void): () => void;
  publishCameraFrame(dataUrl: string): Promise<void>;
  /**
   * Frames for the message about to be sent (识图第 1 步): none unless it asks her to look (`text`, read by the host with
   * shared/look-request.ts), the user pressed "给她看看屏幕" (`look`), or it answers her "要我凑近看看吗" with a yes.
   * Without a hint nothing is attached (electron/look-turns.ts).
   */
  sharedAttachments(hint?: { text?: string; look?: boolean }): Promise<Attachment[]>;
  transcribeAudio(wav: ArrayBuffer): Promise<string>;
  openVoiceCapture(): Promise<VoiceCaptureBinding>;
  submitVoicePcm(value: VoicePcmSubmission): Promise<VoicePcmReceipt>;
  signalVoiceCapture(captureSessionId: string, signal: VoiceInputSignal): Promise<boolean>;
  onVoiceConversation(callback: (event: VoiceConversationEvent) => void): () => void;
  /** 'sentence': finish the sentence being read, read nothing more of that reply (the microphone was turned on). */
  onVoiceReadingStop(callback: (mode?: 'sentence') => void): () => void;
  getAudioReadingView(): Promise<AudioReadingView>;
  setAudioReadingIntent(value: AudioReadingIntent): Promise<AudioReadingAck>;
  onAudioReadingView(callback: (value: AudioReadingView) => void): () => void;
  /** Only to the window whose listening/watching switch was refused (the local recognizer is not ready or not chosen): why, in her words. */
  onAudioReadingRefused(callback: (reason: AudioReadingRefusal) => void): () => void;
  getAudioCaptureState(): Promise<AudioCaptureState>;
  onAudioCaptureState(callback: (value: AudioCaptureState) => void): () => void;
  ackAudioCapture(value: AudioCaptureAck): Promise<boolean>;
  submitAudioReadingPcm(value: AudioReadingPcm): Promise<AudioReadingPcmAck>;
  setAudioDanceIntent(enabled: boolean): Promise<AudioCaptureState>;
  setAudioDanceSourceIntent(value: AudioDanceIntent): Promise<AudioCaptureState>;
  submitAudioDanceSample(value: AudioDanceFrame): Promise<boolean>;
  onAudioDanceSample(callback: (value: AudioDanceFrame) => void): () => void;
  onSettings(callback: (settings: AppSettings) => void): () => void;
  selectAsset(kind: "model" | "motion", layer?: MotionLayer): Promise<AssetRef | null>;
  useBundledModel(): Promise<AppSettings>;
  getMotionLibrary(preferences?: MotionTagPreferenceRequest): Promise<MotionLibraryStatus>;
  motionTrackCoverageRead(request: MotionTrackCoverageRequest): Promise<MotionTrackCoverageView>;
  readMotionWeights(packId: MotionPackId, motionId: string): Promise<MotionWeightView>;
  invalidateMotionWeightSelection(packId: MotionPackId): Promise<void>;
  saveMotionWeights(request: MotionWeightSave): Promise<MotionWeightView>;
  searchMotionWeights(request: MotionWeightQuery): Promise<MotionWeightResults>;
  previewMotion(packId: MotionPackId, motionId: string): Promise<AssetRef>;
  installMotionPack(packId: MotionPackId, motionId: string, layer?: MotionLayer): Promise<AssetRef>;
  clearMotionLayer(layer: MotionLayer): Promise<AppSettings>;
  cancelMotionDownload(): Promise<void>;
  onMotionDownload(callback: (progress: MotionDownloadProgress) => void): () => void;
  selectDirectory(): Promise<string | null>;
  listModels(config: ProviderConfig): Promise<string[]>;
  chat(request: ChatRequest): Promise<void>;
  chooseCompanionCommand(request: CompanionCommandChoiceRequest): Promise<CompanionCommandView | null>;
  onCompanionCommandView(callback: (view: CompanionCommandView) => void): () => void;
  onChatStarted(callback: (chat: ChatStarted) => void): () => void;
  cancel(id: string): Promise<void>;
  onStream(callback: (event: StreamEvent) => void): () => void;
  getUserProfile(): Promise<UserProfileView | null>;
  setUserProfileEnabled(request: UserProfileToggleRequest): Promise<UserProfileView>;
  editUserProfile(request: UserProfileEditRequest): Promise<UserProfileView>;
  deleteUserProfile(request: UserProfileDeleteRequest): Promise<UserProfileView>;
  /** L3 diary, inside the same profile scope. */
  editUserDiary(request: UserDiaryEditRequest): Promise<UserProfileView>;
  deleteUserDiary(request: UserDiaryDeleteRequest): Promise<UserProfileView>;
  clearUserDiary(request: UserDiaryClearRequest): Promise<UserProfileView>;
  /** 熟悉度: what she calls the user, agreed in chat (electron/relationship/). View, change (1–8 characters) or clear (null). */
  getRelationshipNickname(): Promise<string | null>;
  setRelationshipNickname(value: string | null): Promise<string | null>;
  /** Developer mode only, until restart: pretend the relationship stage is this (null: the real one). */
  setRelationshipStage(stage: import('./relationship').RelationshipStage | null): Promise<void>;
  /** F7, developer mode only, this run only: a slow reply's later system-voice sentences start after a short silence. Returns the new state. */
  setReplyRhythmVoiceTrial(on: boolean): Promise<boolean>;
  onUserProfileChanged(callback: (view: UserProfileView | null) => void): () => void;
  getCurrentTextMemorialOffer(): Promise<TextMemorialOfferState>;
  acknowledgeTextMemorial(request: TextMemorialAcknowledgement): Promise<TextMemorialPresented | null>;
  onTextMemorialEvent(callback: (event: TextMemorialEvent) => void): () => void;
  getTextMemorials(): Promise<TextMemorialView | null>;
  editTextMemorial(request: TextMemorialEdit): Promise<TextMemorialView>;
  deleteTextMemorial(request: TextMemorialDelete): Promise<TextMemorialView>;
  onTextMemorialsChanged(callback: (view: TextMemorialView | null) => void): () => void;
  screenSources(): Promise<ScreenSource[]>;
  captureScreen(id: string): Promise<Attachment>;
  setCameraPermission(enabled: boolean): Promise<void>;
  /** Local pose sensing (I-001): component state only — enums and byte counts, never paths or frames. */
  /** Local speech recognizer (voice input, electron/asr/): view, the「下载」question and its controls. Control window only (get/dismiss from either). */
  getLocalAsr(): Promise<import('./local-asr').LocalAsrView>;
  onLocalAsr(callback: (view: import('./local-asr').LocalAsrView) => void): () => void;
  downloadLocalAsr(): Promise<import('./local-asr').LocalAsrView>;
  cancelLocalAsrDownload(): Promise<void>;
  dismissLocalAsrPrompt(): Promise<import('./local-asr').LocalAsrView>;
  importLocalAsr(): Promise<import('./local-asr').LocalAsrView>;
  removeLocalAsr(): Promise<import('./local-asr').LocalAsrView>;
  getPoseSensing(): Promise<import('./pose-signals').PoseSensingView>;
  onPoseSensing(callback: (view: import('./pose-signals').PoseSensingView) => void): () => void;
  downloadPoseComponents(): Promise<import('./pose-signals').PoseSensingView>;
  cancelPoseDownload(): Promise<void>;
  dismissPosePrompt(): Promise<import('./pose-signals').PoseSensingView>;
  /** Opens the host's own file dialog; the chosen paths stay in the host. */
  importPoseComponents(): Promise<import('./pose-signals').PoseSensingView>;
  removePoseComponents(): Promise<import('./pose-signals').PoseSensingView>;
  redetectPoseHardware(): Promise<import('./pose-signals').PoseSensingView>;
  /** Developer mode only: signal categories and counts. */
  getPoseDiagnostics(): Promise<Partial<Record<string, number>>>;
  pointer(): Promise<PointerPosition>;
  openControls(): Promise<void>;
  resetSettings(): Promise<AppSettings>;
  /** Agent internal channel (off by default): control window toggle and status. */
  getAgentChannel(): Promise<import('./agent-channel').AgentChannelView>;
  setAgentChannelEnabled(enabled: boolean): Promise<import('./agent-channel').AgentChannelView>;
  /** I-014 "三方互通" (on by default, remembered once the user turns it off), 「重新接上」 Claude Code, 「撤回」, the recycle bin. */
  setAgentInterconnect(enabled: boolean): Promise<import('./agent-channel').AgentChannelView>;
  relinkAgentClaudeCode(): Promise<import('./agent-channel').AgentChannelView>;
  undoAgentAction(id: string): Promise<import('./agent-channel').AgentChannelView>;
  restoreRecycledMemory(id: string): Promise<import('./agent-channel').AgentChannelView>;
  setRecycleDays(days: number): Promise<import('./agent-channel').AgentChannelView>;
  onAgentChannel(callback: (view: import('./agent-channel').AgentChannelView) => void): () => void;
  /** "由 Claude 操作" notices, sent to both windows. */
  onAgentChannelNotice(callback: (notice: import('./agent-channel').AgentChannelNotice) => void): () => void;
  /** Closed set of control-window actions (play a preview, voice preview). */
  onAgentChannelAction(callback: (action: import('./agent-channel').AgentChannelRendererAction) => void): () => void;
  /** 体验记录 (E2): "刚才发生了什么" and the switch "保留体验记录（只存本机）" (control window). */
  getJournal(): Promise<import('./journal').JournalView>;
  setExperienceJournal(enabled: boolean): Promise<import('./journal').JournalView>;
  onJournal(callback: (view: import('./journal').JournalView) => void): () => void;
  /** The pet window's music tier for the 体验记录 (a closed tier and a 0..1 score; anything else is ignored). */
  noteMusicTier(value: { tier: 'none' | 'nod' | 'dance'; score: number | null }): Promise<boolean>;
  /** I-017: the pet window's music state for the next chat turn's perception line (shared/her-state.ts; only the pet window, only that shape). */
  noteStageState(value: import('./her-state').StageStateReport): Promise<boolean>;
  /** I-016: the host's music / show / talk / quiet judgement as one developer-panel line (pet window only; '' elsewhere). */
  readListenKind(): Promise<string>;
  /** 动作跳变记录 for the 体验记录: a guard catch or a physics kick (numbers, a bone or morph name, closed activities; anything else is ignored). */
  /** 体验记录 (first batch): a window tells a number-only fact ('voice-capture' summary, 'blush-stage', 'launch'); only the pet window may tell the last two. */
  noteJournalFact(kind: 'voice-capture' | 'blush-stage' | 'launch', value: unknown): Promise<boolean>;
  noteMotionGlitch(value: { kind: 'guard' | 'physics' | 'block'; part: 'bone' | 'morph' | 'geometry' | 'gpu'; name: string; size: number; activities: string[]; fps: number | null; frameMs: number | null; cleared?: boolean }): Promise<boolean>;
  /** I-031 色块诊断日志 (temporary, pet window only): a block or near miss of the 色块哨兵; the host checks it again and writes it outside every profile. */
  noteColorBlock(value: import('./color-block').ColorBlockReport): Promise<boolean>;
  /** Chat settings card (R41): a tap on one of the host's own choices, or 「取消」. */
  chooseChatSetting(request: import('./chat-settings').ChatSettingChoiceRequest): Promise<import('./chat-settings').ChatSettingCardView | null>;
  onChatSettingCard(callback: (card: import('./chat-settings').ChatSettingCardView) => void): () => void;
  /**
   * D2 developer test commands ("测试：xxx", electron/test-commands/): the window asks with the literal text; the host answers whether
   * it was a command (developer mode on and "测试：" prefix). Not handled: the window sends it as ordinary chat. The note lines
   * arrive on `onTestNote`; `onTestEffect` asks the stage to do one closed-set thing. Nothing here is chat and nothing is archived.
   */
  runTestCommand(text: string): Promise<import('./test-command').TestCommandOutcome>;
  onTestNote(callback: (note: import('./test-command').TestCommandNote) => void): () => void;
  onTestEffect(callback: (effect: import('./test-command').TestEffect) => void): () => void;
  /**
   * E1 惊喜 / 害羞 previews on any model (docs/claude/2026-11-03-e1-r18-fixes.md): either window asks for one closed recipe; the host
   * sends it to every window's stage (the pet first of all), which plays it on whatever model it has, skipping missing parts.
   */
  playExpressionPreview(recipe: import('./expression-preview').ExpressionRecipe): Promise<import('./expression-preview').ExpressionPreviewResult>;
  onExpressionPreview(callback: (recipe: import('./expression-preview').ExpressionRecipe) => void): () => void;
  /**
   * 她的动作 (T-211, shared/her-actions.ts): the host sends a short-lived cue to every window's stage; a stage resolves only that
   * live cue to its one pinned VMD; only the pet window's answer (played, skipped and why) reaches the test note.
   */
  onHerAction(callback: (cue: import('./her-actions').HerActionCue) => void): () => void;
  resolveHerAction(cueId: string): Promise<import('./her-actions').HerActionResource>;
  reportHerAction(outcome: import('./her-actions').HerActionOutcome): Promise<void>;
  quit(): Promise<void>;
}
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
