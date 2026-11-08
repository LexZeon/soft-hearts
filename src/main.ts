import { uiText, uiHtml, uiMarkup, uiTemplate, setUiLanguage } from './ui/ui-language';
import './ui/ui-language.css';
import "./style.css";
import { SingleEmojiControls } from './ui/SingleEmojiControls';
import { AgentChannelPanel, agentNoticeText, runAgentRendererAction } from './ui/AgentChannelPanel';
import { JournalPanel } from './ui/JournalPanel';
import { PoseSensingPanel } from './ui/PoseSensingPanel';
import { LocalAsrPanel } from './ui/LocalAsrPanel';
import { ChatAvailabilityNotice } from './ui/ChatAvailabilityNotice';
import { outageDisplayText } from '../shared/chat-availability';
import { CharacterStickerControls } from './ui/CharacterStickerControls';
import './ui/single-emoji-controls.css';
import { PetFramingController } from './ui/PetFraming';
import { CompanionCommandChoices } from './ui/CompanionCommandChoices';
import { ChatSettingCards } from './ui/ChatSettingCard';
import type { CompanionCommandView } from '../shared/companion-commands';
import './ui/immersive-notice.css';
import { ImmersiveNotice } from './ui/ImmersiveNotice';
import { UserProfilePanel } from './ui/UserProfilePanel';
import { cameraRefusalAction, conciseFailure, NOTICE_ACTIONS, readingRefusalAction, voiceFailureAction, voiceRefusalAction, voiceUnheardLine, type NoticeAction } from './notice-policy';
import type { VoiceConversationEvent } from '../shared/voice-conversation';
import { VoiceDraftInput } from './ui/VoiceDraftInput';
import { VoiceContinuationStatus } from './ui/VoiceContinuationStatus';
import './pet.css';
import { renderControls } from "./ui/layout";
import { ControlNavigation, CONTROL_PAGE_TITLES, type ControlNavigationLocation } from './ui/ControlNavigation';
import type {
  AppSettings,
  Attachment,
  ChatMessage,
  ChatStarted,
  StreamEvent,
  RuntimeState,
  RuntimePatch,
  ModelPhysicsSettingsPatch,
  WindowVisibilityState,
} from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { MmdStage } from "./stage";
import { applyBehaviorGates } from "./stage/behavior-gates";
import { icon } from "./ui/icons";
import { VoiceOutput } from "./ui/VoiceOutput";
import { SharedAudioOutput } from "./ui/audio-output";
import { CompletedReplySpeechQueue } from "./ui/completed-reply-speech-queue";
import { EmotionalVoiceControls } from "./ui/EmotionalVoice";
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig } from "../shared/tts";
import './emotional-voice.css';
import { cameraSnapshot } from "./ui/capture";
import { mergeSettings } from "./ui/settings-merge";
import { PetUI, renderPet } from './ui/PetUI';
import { laterPopup } from './ui/pet-popups';
import { installPetPointerPassthrough } from './ui/pointer-passthrough';
import { MediaInput } from './ui/MediaInput';
import { wirePushToTalk } from './ui/push-to-talk';
import { ScreenSharingOptions, DEFAULT_SCREEN_SHARING_OPTIONS } from './ui/ScreenSharingOptions';
import { LookButton, lookButtonContent } from './ui/LookButton';
import { LookOfferPrompt, lookOfferContent } from './ui/LookOfferPrompt';
import { draftAfterClear, lookHint, turnAttachments } from './look-send';
import { formatVisionPresentation, type VisionRuntimeState, type VisionInitiative } from '../shared/vision-runtime';
import { prepareVisionDelivery } from './ui/proactive-vision-delivery';
import { TextMemorialOfferController, TextMemorialDeliveredHistory } from './ui/TextMemorialOffer';
import { TextMemorialPanel } from './ui/TextMemorialPanel';
import {ProactiveAgentOffer} from './ui/ProactiveAgentOffer';
import './r20-proactive-offer.css';
import { RpsOverlay, petSayPorts } from './ui/RpsOverlay';
import { FeedSnackClient } from './ui/feed-snack';
import { FeedLinePresenter } from './ui/feed-line';
import { readSenseLineMessage } from '../shared/sense-router';
import { FeedRecognitionPanel } from './ui/FeedRecognitionPanel';
import { MoodJudgePanel } from './ui/MoodJudgePanel';
import { ReactionDispositionsPanel, ReactionsPanel } from './ui/ReactionsPanel'; // I-037
import { UserActivityPanel } from './ui/UserActivityPanel'; // I-006
import './rps.css';
import './ui/screen-sharing-options.css';
import './ui/look-button.css';
import { MotionLibraryControls } from './ui/MotionLibrary';
import { MotionPreviewSession } from './ui/motion-preview';
import { motionAssetBaseline } from '../shared/motion-layers';
import { SystemAudioInput } from './ui/SystemAudio';
import { AudioReadingClient } from './ui/AudioReadingClient';
import { AmbientTranscriptHistory } from './ui/AmbientTranscriptHistory';
import { ListenTogetherPanel } from './ui/ListenTogetherPanel'; // I-016 一起听
import type { AmbientComment } from '../shared/ambient-audio';
import './ambient-audio.css';
import { CharacterCards } from './ui/CharacterCards';
import { CodexTasks, mountCodexTaskOffer } from './ui/CodexTasks';
import { claudeTasksOffered, watchClaudeTasks } from './ui/claude-task-gate';
import { compileCharacterPersona, type CharacterCardState } from '../shared/character-cards';
import './character-cards.css';
import { CharacterPage } from './ui/CharacterPage';
import { ModelCapabilityPanel } from './ui/ModelCapabilityPanel';
import { ModelCapabilitySync, bindCapabilityPreview } from './ui/model-capability-sync';
import { onStageModelProfile } from './stage/model-profile';
import './character-page.css';
import './character-response.css';
import './codex-tasks.css';
import { MoodCompanion } from './ui/MoodCompanion';
import { MemoryPanel } from './ui/MemoryPanel';
import { BlushCalibrationControls } from './ui/BlushCalibrationControls';
import type { BlushCalibrationView } from '../shared/blush';
import './blush-calibration.css';
import './mood.css';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings, type ModelPhysicsState, type PhysicsQuality } from '../shared/model-physics';
import { normalizeMusicSettings, type MusicSettings } from '../shared/music-settings';
import { renderReplyWaiting } from '../shared/reply-waiting-presentation';
import { ReplyPresentationState } from './ui/reply-presentation';
import { pauseCutForSend } from './ui/pause-talk-send';
import { ReplyThinkingPresenter, systemSpeechBusy } from './ui/reply-thinking';
import { THINK_CUE_KINDS } from '../shared/feed-cue';
import { FeedSpeechPause } from './ui/feed-speech-pause';
import { FeedCuePlayer } from './ui/feed-cue-player';
import { FeedCuePrefetch } from './ui/feed-cue-prefetch';
import { ChosenFeedCues } from './ui/feed-cue-choice';
import { formatReplySegments } from './ui/reply-segments';
import { appendReplyHistory, appendVoiceReply, ambientCommentHistoryText, outgoingChatMessages, trimReplyHistory } from './ui/reply-history';
import { restoredChatHistory } from './ui/chat-continuity';
import { isTransientSwitch, TRANSIENT_SWITCH_DELAY_MS, TRANSIENT_SWITCH_RETRIES } from './ui/transient-switch';
import { PetVisibilityIntent, WindowVisibilityTracker } from './ui/window-visibility';
import { checkPetPresentation } from './pet-presentation-probe';
import { scanBreathRequest } from '../shared/breath-request';
import { scanFramingRequest } from '../shared/framing-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { latchSignal } from './latched-signal';
import { TestCommandNotes } from './ui/TestCommandNotes';
import { asksTestCommand } from '../shared/test-command';
import { bindPreviewCardButtons } from './ui/ExpressionPreviewButtons';
import { HER_STATE_REPORT_CHECK_MS, HerStateReporter } from './ui/her-state-reporter';
import { ListenKindPanelFeed } from './ui/listen-kind-panel';

const app = document.querySelector<HTMLDivElement>("#app")!;
const isPet = new URLSearchParams(location.search).has("pet");
let settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
let hostSettings: AppSettings = structuredClone(DEFAULT_SETTINGS);
let alwaysOnTopPending = false;
let settingsBroadcastEpoch = 0;
let saveQueue: Promise<boolean> = Promise.resolve(true);
let stage: MmdStage;
let petFramingController: PetFramingController | null = null;
let saveTimer: ReturnType<typeof setTimeout>;
let activeChat: string | null = null;
const commandMessageRows = new Map<string, { root: HTMLElement; choices: CompanionCommandChoices | null }>();
const readoutControlTurns = new Map<string, { user: ChatMessage; text: string; output: HTMLElement; finished: boolean }>();
let pendingReadoutControl: string | null = null;
/** Local control replies use the existing message choices without replacing the
 * native speech surface, clearing its queue or starting another spoken reply. */
function beginReadoutControl(chat: ChatStarted): void {
  if (readoutControlTurns.has(chat.id)) return;
  while (readoutControlTurns.size >= 8) {
    const id = readoutControlTurns.keys().next().value!;
    const row = commandMessageRows.get(id); row?.choices?.dispose();
    if (isPet) row?.root.remove();
    commandMessageRows.delete(id); readoutControlTurns.delete(id);
  }
  const user = chat.messages.at(-1);
  if (user?.role !== 'user') return;
  const root = document.createElement('section');
  const literal = document.createElement('div'); literal.className = 'message-body'; literal.textContent = user.content;
  const output = document.createElement('div'); output.className = 'message-body';
  root.append(literal, output);
  (isPet ? document.querySelector('.pet-chat') : $('messages'))?.append(root);
  commandMessageRows.set(chat.id, { root, choices: null });
  readoutControlTurns.set(chat.id, { user, text: '', output, finished: false });
}
function receiveReadoutControl(event: StreamEvent): boolean {
  const turn = readoutControlTurns.get(event.id);
  if (event.kind !== 'chat' || !turn) return false;
  if (turn.finished) return true;
  if (event.type === 'delta') { turn.text += event.text; turn.output.textContent = turn.text; }
  if (event.type === 'done' || event.type === 'error') {
    turn.finished = true;
    if (event.type === 'error') turn.output.textContent = displayFailure(event.text);
    else history = appendReplyHistory(history, turn.user, turn.text);
    if (pendingReadoutControl === event.id) pendingReadoutControl = null;
  }
  return true;
}
function clearCommandMessageRows(cancel = true): void {
  for (const [id, row] of commandMessageRows) {
    row.choices?.dispose();
    if (isPet) row.root.remove();
    if (cancel) void window.desktop.cancel(id).catch(() => {});
  }
  commandMessageRows.clear();
  readoutControlTurns.clear(); pendingReadoutControl = null;
}
function presentCompanionCommand(view: CompanionCommandView): void {
  const row = commandMessageRows.get(view.requestId);
  if (!row) return;
  if (!row.choices) {
    if (isPet) document.querySelector('.pet-chat')?.append(row.root);
    row.choices = new CompanionCommandChoices(row.root, request => window.desktop.chooseCompanionCommand(request),
      view.owner === (isPet ? 'pet' : 'controls'));
  }
  row.choices.show(view);
}
const voiceUiGroups = new Map<string, { epoch: string; seq: number; message: ChatMessage; node: HTMLElement }>();
let voiceContinuationStatus: VoiceContinuationStatus | null = null;
const voiceReplyIds = new Set<string>();
let voiceSpeechReady: { replyId: string; epoch: string; presentationReady: boolean;
  pendingSpeech?: Extract<VoiceConversationEvent, { type: 'speech' }> } | null = null;
const voiceDraftInput = new VoiceDraftInput();
const voiceDraftRecords = new Map<string, { root: HTMLElement; text: HTMLTextAreaElement }>();
let chatOwner: 'controls' | 'pet' | null = null;
let activeUser: ChatMessage | null = null;
let assistantNode: HTMLElement | null = null;
let reply = "";
let history: ChatMessage[] = [];
let awaitingChatState = true;
// X1: the reply waiting for its first word drives her thinking (src/ui/reply-thinking.ts); presentation only.
const replyPresentation = new ReplyPresentationState(undefined, id => replyThinking.waiting(id),
  { typing: () => !!(document.getElementById('chat-input') as HTMLTextAreaElement | null)?.value.trim() }); // F7 停停说说: she waits a little longer while you type
let attachments: Attachment[] = [];
let captureController: AbortController | null = null;
let characterStickerControls: CharacterStickerControls | null = null;
let hostVisible = false;
const windowVisibility = new WindowVisibilityTracker();
let petVisibilityIntent: PetVisibilityIntent | null = null;
let pendingPetVisibility = false;
let petVisibilityRequest = 0;
let cameraEditing = false;
let petUI: PetUI | null = null;
let petPointer: ReturnType<typeof installPetPointerPassthrough> | null = null; // click-through: her and her controls stay clickable
let immersiveNotice: ImmersiveNotice | null = null;
let userProfilePanel: UserProfilePanel | null = null;
let textMemorialOffer: TextMemorialOfferController | null = null;
let r20ProactiveOfferUI: ProactiveAgentOffer | null = null;
let rpsOverlay: RpsOverlay | null = null; // G1 猜拳 (pet window only)
let feedSnacks: FeedSnackClient | null = null; // I-019 喂食认图: the accepted snack's picture (pet window only)
let testNotes: TestCommandNotes | null = null; // D2 developer test commands: the note lines under "测试：…"
let textMemorialDeliveredUnsubscribe: (() => void) | null = null;
let provisionalMemorialId: string | null = null;
let activeMemorialSpeechId: string | null = null;
const closeProfileForNotice = () => userProfilePanel?.close();
let immersiveDeveloperMode = false;
let pendingNotice: {message:string;error:boolean;action?:NoticeAction} | null = null;
let lastStageStatus = '';
let pointerTimer: ReturnType<typeof setInterval> | null = null;
let mediaInput: MediaInput | null = null;
let screenSharingOptions: ScreenSharingOptions | null = null;
let lookButton: LookButton | null = null;
let visionRuntime: VisionRuntimeState = { ...DEFAULT_SCREEN_SHARING_OPTIONS, supported: false, status: '' };
const shownInitiatives = new Set<string>();
let provisionalInitiative: { id: string; body: HTMLElement } | null = null;
let initiativeGeneration = 0;
let activeVisionSpeechId: string | null = null;
let motionLibraryControls: MotionLibraryControls | null = null;
/** Latest per-model motion fit from the stage (adaptation layer step 2); the library may be created after it arrives. */
let motionFitView: Parameters<MotionLibraryControls['setMotionFit']>[0] = null;
let motionPreview: MotionPreviewSession | null = null;
let visualPreviewUnsubscribe:(()=>void)|null=null;
let bodyPreviewUnsubscribe:(()=>void)|null=null;
let surprisePreviewUnsubscribe:(()=>void)|null=null;
let systemAudioInput: SystemAudioInput | null = null;
let ambientAudioController: AudioReadingClient | null = null;
let ambientTranscriptHistory: AmbientTranscriptHistory | null = null;
const ambientDisplayedComments = new Set<string>();
const ambientOfferedComments = new Set<string>();
let recoveringPetView = false;
let petRecoveryGeneration = 0;
let characterControls: CharacterCards | null = null;
/** C2 角色页: the card wall ("换成她"), above the editor. */
let characterPage: CharacterPage | null = null;
/** I-024 模型体检: this window's capability card for its stage, and (control window) the character page's 「这个模型能做什么」. */
let modelCapabilitySync: ModelCapabilitySync | null = null;
let modelCapabilityPanel: ModelCapabilityPanel | null = null;
let codexTasks: CodexTasks | null = null;
let controlNavigation: ControlNavigation | null = null;
let taskProposalUnsubscribe: (() => void) | null = null;
let petTaskOfferCleanup: (() => void) | null = null;
let characterState: CharacterCardState | null = null;
let characterName = uiText('桌面伙伴');
let emotionalVoiceControls: EmotionalVoiceControls | null = null;
let moodCompanion: MoodCompanion | null = null;
let memoryPanel: MemoryPanel | null = null;
let blushCalibrationControls: BlushCalibrationControls | null = null;
let blushCalibrationView: BlushCalibrationView | null = null;
let blushCalibrationUrl = '';
let blushCalibrationGeneration = 0;
let blushCalibrationUnsubscribe: (() => void) | null = null;
let modelPhysicsSettings = normalizeModelPhysicsSettings(undefined);
let modelPhysicsState: ModelPhysicsState | null = null;
let modelPhysicsSettingsReady = false;
let modelPhysicsSaving = false;
let modelPhysicsEventVersion = 0;
let modelPhysicsUnsubscribe: (() => void) | null = null;
let musicSettings = normalizeMusicSettings(undefined);
let musicSettingsReady = false;
let musicSettingsSaving = false;
let musicSettingsEventVersion = 0;
let musicSettingsUnsubscribe: (() => void) | null = null;
let composing = false;
let releaseReplySpeech: (() => void) | null = null;
let runtime: RuntimeState = { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null };
const windowKind = isPet ? 'pet' : 'controls';
const chatChannel = new BroadcastChannel('soft-hearts-chat');
const speechChannel = new BroadcastChannel("mmd-desk-speaking");
let speechPlaybackErrorShown = false;
let voicePlaybackActive = false;
let speechPreparing = false;
// 2026-11-05 freeze: building an AudioContext can block this window for seconds, so reading aloud, the feeding cues and
// the waiting hum share one output, whose context is built once, early (warmAudioOutput), and resumed after that.
const windowAudio = new SharedAudioOutput();
const speechOutput = new VoiceOutput({
  getTtsConfig: currentTtsConfig,
  getVoiceConfig: () => settings.voice,
  api: window.desktop,
  audio: windowAudio,
  onSpeaking: active => {
    voicePlaybackActive = active;
    stage?.setSpeaking(active);
    mediaInput?.setSpeaking(active);
    ambientAudioController?.setSpeaking(active);
    void window.desktop.setAmbientAudioSpeaking(active).catch(() => {});
    speechChannel.postMessage(active);
  },
  onState: state => {
    // T-215: "about to speak" (loading: synthesis or the device, before the first sound) lets a mouth face shape start
    // handing back now; a flag and a message only, so the sound itself is not delayed. Sent on changes only.
    const preparing = state.phase === 'loading' ? true : state.phase === 'idle' || state.phase === 'error' ? false : speechPreparing;
    if (preparing !== speechPreparing) { speechPreparing = preparing; stage?.setSpeechPreparing(preparing); speechChannel.postMessage({ prepare: preparing }); }
    emotionalVoiceControls?.setPlaybackState(state); feedCuePrefetch.playback(state);
  },
  onError: message => { speechPlaybackErrorShown = true; notify(message, true); },
});
// B06: a snack at her mouth pauses speech and the paced bubble, with a "啊"/"嗯" cue; the pet sees the snack, either window may speak.
const feedPauseChannel = new BroadcastChannel('soft-hearts-feed-pause');
const feedCues = new FeedCuePlayer({ api: window.desktop, getTtsConfig: currentTtsConfig, getVoiceConfig: () => settings.voice, audio: windowAudio });
// #32: the sound she picked for this snack (the host's pick in the mood view, shared/behaviors/feed-cue/), on the same cue player.
const chosenFeedCues = new ChosenFeedCues({ player: feedCues, onMood: listener => window.desktop.onMood(listener) });
// B06: once a reply plays aloud in the Bailian voice, both cues are fetched ahead of the first feed (feed-cue-prefetch.ts).
// X1: the waiting "嗯…" — same cue path, its own player (own cache and playback), warmed together with the feeding cues.
const thinkingCues = new FeedCuePlayer({ api: window.desktop, getTtsConfig: currentTtsConfig, getVoiceConfig: () => settings.voice, kinds: THINK_CUE_KINDS, audio: windowAudio });
const feedCuePrefetch = new FeedCuePrefetch({ prefetch: () => { feedCues.prefetch(); thinkingCues.prefetch(); }, getTtsConfig: currentTtsConfig, voiceOn: () => settings.voice.enabled });
const feedPause = new FeedSpeechPause({ targets: [speechOutput, replyPresentation], broadcast: message => feedPauseChannel.postMessage(message), voiceOn: () => settings.voice.enabled,
  cues: chosenFeedCues });
feedPauseChannel.onmessage = event => feedPause.receive(event.data);
const replyThinking = new ReplyThinkingPresenter({ stage: () => stage, cue: thinkingCues, voiceOn: () => settings.voice.enabled,
  // The window that reads this typed reply aloud (a voice conversation's open microphone never hears it).
  speaks: id => activeChat === id && chatOwner === windowKind && !!activeUser && !voiceReplyIds.has(id) && (!isPet || (hostVisible && !document.hidden)),
  busy: () => feedPause.active || feedPause.state !== 'idle' || voicePlaybackActive || systemSpeechBusy() });
let ordinaryVoiceConfig: AppSettings['voice'] | null = null;
const replySpeechQueue = new CompletedReplySpeechQueue(window.desktop,
  segment => speechOutput.speak(segment.text, { ...(ordinaryVoiceConfig ?? settings.voice) }, segment.context),
  () => settings.voice.enabled && (!isPet || (hostVisible && !document.hidden)),
  replyId => speechOutput.openReply({ ...(ordinaryVoiceConfig ?? settings.voice) }, replyId)); // R02: one Bailian playback per reply
const speech = {
  voices: () => speechOutput.voices(),
  speak: (...args: Parameters<VoiceOutput['speak']>) => { replySpeechQueue.cancel(); return speechOutput.speak(...args); },
  preview: (...args: Parameters<VoiceOutput['preview']>) => { replySpeechQueue.cancel(); return speechOutput.preview(...args); },
  previewCharacter: (...args: Parameters<VoiceOutput['previewCharacter']>) => { replySpeechQueue.cancel(); return speechOutput.previewCharacter(...args); },
  stop: () => { replySpeechQueue.cancel(); speechOutput.stop(); feedPause.cancelCues(); },
  prewarm: () => { if (settings.voice.enabled) speechOutput.prewarm(); },
  dispose: () => { replySpeechQueue.cancel(); speechOutput.dispose(); windowAudio.dispose(); },
};
/** Builds this window's audio context now, while the model loads, when she reads aloud in the Bailian voice (2026-11-05). */
function warmAudioOutput(): void {
  let bailian = false;
  try { bailian = currentTtsConfig().provider === 'bailian'; } catch { /* Config errors surface on speak. */ }
  if (settings.voice.enabled && bailian) setTimeout(() => windowAudio.warm(), 0);
}
let ordinaryReplyPresentation: { id: string; text: string; context: string; index: number;
  early:boolean; kicked:boolean; ended:boolean; textDrained:boolean; streaming?:boolean } | null = null;
function finishReplySpeechPresentation(id: string, replyContext?: string): void {
  const accepted = ordinaryReplyPresentation;
  if (accepted?.id === id) {
    if (replyContext !== undefined && accepted.context !== replyContext) return;
    accepted.ended=true;
    if(accepted.early&&!accepted.textDrained){petUI?.endAnswerSpeech(id);return;}
    ordinaryReplyPresentation = null;
    // A failed first-piece preparation still leaves one complete, readable
    // non-speaking answer. Never restore old content over a newer turn.
    if (!accepted.early && accepted.index === -1 && accepted.context === replySpeechContext() && !activeChat
      && hostVisible && !document.hidden) {
      petUI?.finishAnswer(accepted.text, id, false, false, true);
      return;
    }
  }
  petUI?.endAnswerSpeech(id);
}
async function prepareReplySpeechPresentation(accepted: NonNullable<typeof ordinaryReplyPresentation>): Promise<void> {
  const current = () => ordinaryReplyPresentation === accepted && accepted.context === replySpeechContext()
    && !activeChat && settings.voice.enabled && hostVisible && !document.hidden;
  try {
    if (!petUI) return;
    await petUI.flushReplyPublication();
    if (!current()) return;
    const ready = await window.desktop.acknowledgeReplySpeechReady(accepted.id);
    if (!ready && current()) finishReplySpeechPresentation(accepted.id, accepted.context);
  } catch (error) {
    if (!current()) return;
    void window.desktop.cancelReplySpeech(accepted.id).catch(() => {});
    reportReplySpeechError(error);
    finishReplySpeechPresentation(accepted.id, accepted.context);
  }
}
function kickCompletedReply(accepted:NonNullable<typeof ordinaryReplyPresentation>):void {
  if(ordinaryReplyPresentation!==accepted||accepted.kicked||accepted.ended||(activeChat&&!accepted.streaming)
    ||accepted.context!==replySpeechContext()||!settings.voice.enabled||(isPet&&(!hostVisible||document.hidden)))return;
  accepted.kicked=true;
  const release=()=>{
    if(ordinaryReplyPresentation!==accepted)return;
    if(releaseReplySpeech===release)releaseReplySpeech=null;
    endReplySpeech(accepted.id,accepted.context);
  };
  releaseReplySpeech=release;
  void replySpeechQueue.speak(accepted.id).then(release,error=>{
    if(ordinaryReplyPresentation!==accepted)return;
    reportReplySpeechError(error);release();
  });
}
/** R02: a Claude reply reads its first complete sentence as soon as its bubble shows, while the rest streams. */
function startStreamingReplySpeech(id: string): void {
  if (ordinaryReplyPresentation?.id === id) { ordinaryReplyPresentation.text = reply; return; }
  if (settings.provider.kind !== 'claude' || !settings.voice.enabled || !activeUser || voiceReplyIds.has(id)) return;
  const accepted = ordinaryReplyPresentation = { id, text: reply, context: replySpeechContext(), index: -1, early: true, kicked: false, ended: false, textDrained: false, streaming: true };
  ordinaryVoiceConfig = { ...settings.voice }; speechPlaybackErrorShown = false;
  if (chatOwner === windowKind && (!isPet || (hostVisible && !document.hidden))) kickCompletedReply(accepted);
}
function reportReplySpeechError(error: unknown): void {
  if (speechPlaybackErrorShown) return;
  const message = error instanceof Error ? error.message : String(error);
  notify(message.includes('6000字符限制') ? uiText('这条回复超过自动朗读的6000字符限制，完整文字仍可查看。')
    : message.includes('无法安全分段') ? uiText('这条回复无法安全分段朗读，完整文字仍可查看。')
    : message.includes('气泡尚未确认显示') ? uiText('回复气泡尚未确认显示，本段未开始朗读。')
    : uiText('本次朗读未完成，完整文字仍可查看。'), true);
}
window.desktop.onReplySpeechSegment(segment => {
  const accepted = ordinaryReplyPresentation;
  if (!accepted || accepted.ended || segment.replyId !== accepted.id || accepted.context !== replySpeechContext()
    || segment.index !== accepted.index + 1 || !accepted.text.startsWith(segment.visibleText)
    || !hostVisible || document.hidden) return;
  accepted.index = segment.index;
  // Streamed text is already visible. Speech progress must never replace the
  // full reply with an earlier prefix; the host verifies the current native
  // full-body receipt together with this segment's own lease.
  if (segment.index === 0) {
    if(accepted.early)petUI?.expectAnswerSpeech(segment.replyId);
    else petUI?.finishAnswer(accepted.text, segment.replyId, true, true);
  }
  petUI?.refreshAnswerReader(accepted.text, false);
});
window.desktop.onReplySpeechCancelled(id => {
  if (replySpeechQueue.replyId === id) speech.stop();
  if (ordinaryReplyPresentation?.id === id) finishReplySpeechPresentation(id);
});
speechChannel.onmessage = (event) => {
  if (typeof event.data === 'boolean') { stage?.setSpeaking(event.data, 'remote'); mediaInput?.setSpeaking(event.data); ambientAudioController?.setSpeaking(event.data); }
  else if (event.data && typeof event.data === 'object' && typeof event.data.prepare === 'boolean') stage?.setSpeechPreparing(event.data.prepare, 'remote');
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function text(id: string, value: string): void {
  const element = $(id);
  if (element) element.textContent = value;
}
function notify(message: string, error = false, action?: NoticeAction): void {
  const value=String(message).slice(0,4000);
  if(!immersiveNotice){
    if(!pendingNotice?.error || error)pendingNotice={message:value,error,action};
    return;
  }
  if(action)immersiveNotice.publishAction(uiText(NOTICE_ACTIONS[action]));
  else immersiveNotice.publish(value,error,error ? conciseFailure(value) : undefined);
}
function mountImmersiveNotice(): void {
  immersiveNotice?.dispose();
  immersiveNotice=new ImmersiveNotice(document,{quietOrdinaryFailures:isPet}); // no failure notices on the pet outside developer mode
  immersiveNotice.setDeveloperMode(immersiveDeveloperMode);
  const pending=pendingNotice;pendingNotice=null;
  if(pending)notify(pending.message,pending.error,pending.action);
}
function displayFailure(message:string):string{
  return immersiveDeveloperMode ? String(message).slice(0,4000) : conciseFailure(message,'chat');
}
function updateStageStatus(message:string):void{
  lastStageStatus=message;
  const visible=immersiveDeveloperMode ? message : /模型已就绪|VMD 播放中/.test(message)
    ? uiText('模型已就绪') : /读取|加载|准备/.test(message) ? uiText('正在准备角色…') : '';
  text(isPet ? 'pet-status' : 'stage-status',visible);
}
function showStartupFailure(error:unknown):void{
  const recovery=uiMarkup('<section id="startup-recovery" role="alert"><h1>暂时未能启动</h1><p>可以查看问题详情，或重试启动。</p><button id="startup-retry" type="button">重试</button><button id="startup-controls" type="button">打开设置</button><button id="startup-quit" type="button">退出</button></section>');
  if(!document.getElementById('notice-details')){
    app.innerHTML=recovery+uiMarkup('<button id="notice-details" type="button" hidden>查看问题详情</button><section id="notice-detail-panel" class="notice-detail-panel" hidden><button id="notice-detail-close" type="button">关闭详情</button><pre id="notice-detail-text"></pre></section><div id="toast" class="toast" role="status"></div>');
  }else if(!document.getElementById('startup-recovery')){
    // Keep any initialized scene and its owners intact until explicit retry/exit.
    app.insertAdjacentHTML('afterbegin',recovery);
  }
  if(!immersiveNotice)mountImmersiveNotice();
  $('startup-retry').onclick=()=>location.reload();
  $('startup-controls').onclick=()=>void window.desktop.openControls().catch(problem=>notify(String(problem),true));
  $('startup-quit').onclick=()=>void window.desktop.quit();
  immersiveNotice!.publish(String(error),true,conciseFailure(error,'startup'));
}
function save(): Promise<boolean> {
  clearTimeout(saveTimer);
  const operation = async () => {
    const sent = structuredClone(settings);
    try {
      const accepted = isPet
        ? await window.desktop.savePetView({ camera: sent.camera, scale: sent.pet.scale ?? 1 })
        : await window.desktop.saveSettings(sent, motionAssetBaseline(hostSettings));
      const memoryConnection = (value: AppSettings) => JSON.stringify([value.provider.kind, value.provider.baseUrl.trim().replace(/\/$/, ''), value.provider.model]);
      const memoryConnectionChanged = memoryConnection(hostSettings) !== memoryConnection(accepted);
      settings = mergeSettings(sent, settings, accepted);
      projectPetVisibility();
      hostSettings = accepted;
      if (memoryConnectionChanged) { memoryPanel?.reset(); clearChat(false); }
      applyStage();
      if (!isPet) syncForm();
      updateSummary();
      return true;
    } catch (error) {
      notify(String(error), true);
      return false;
    }
  };
  saveQueue = saveQueue.then(operation, operation);
  return saveQueue;
}
function queueSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 240);
}
async function requestAlwaysOnTop(enabled: boolean): Promise<void> {
  if (alwaysOnTopPending) return;
  alwaysOnTopPending = true;
  const input = document.getElementById('always-on-top') as HTMLInputElement | null;
  if (input) input.disabled = true;
  petUI?.setAlwaysOnTopPending(true);
  const epoch = settingsBroadcastEpoch;
  try {
    const accepted = await window.desktop.setPetAlwaysOnTop(enabled);
    // A newer broadcast wins over a delayed return. Preserve all unrelated drafts.
    if (epoch === settingsBroadcastEpoch) {
      settings.pet.alwaysOnTop = accepted.pet.alwaysOnTop;
      hostSettings.pet.alwaysOnTop = accepted.pet.alwaysOnTop;
    }
  } catch (error) { notify(String(error), true); }
  finally {
    alwaysOnTopPending = false;
    if (input) { input.disabled = false; input.checked = settings.pet.alwaysOnTop; }
    petUI?.setAlwaysOnTopPending(false);
    petUI?.applySettings(settings);
  }
}
function applyStage(): void {
  syncBehaviorGate();
  void stage
    .applySettings(motionPreview?.view(settings) ?? settings)
    .then(() => {
      if ((settings.model?.url ?? '') !== blushCalibrationUrl) void refreshBlushCalibration();
      if (!isPet) void characterPage?.modelShown(settings.model?.url ?? ''); // C2: her small picture, once posed
    })
    .catch((error) => notify(String(error), true));
}
function syncBehaviorGate(): void {
  // R29b: typing is not a window/camera adjustment; it only pauses new automatic behaviour.
  applyBehaviorGates(stage, { cameraEditing, composing, windowInteraction: !!petUI?.windowInteractionBlocked,
    clickThrough: settings.pet.clickThrough, preview: !!(motionPreview && motionPreview.state.phase !== 'idle' && motionPreview.state.local!=='surprise') });
  syncBodyInputGate(); petPointer?.refresh();
}
function syncBodyInputGate(): void {
  const focused = document.activeElement;
  const editable = focused instanceof HTMLElement && (focused.matches('input, textarea, select') || focused.isContentEditable);
  stage?.setBodyInputBlocked(!!activeChat || editable);
}
function syncModelPhysicsSupport(): void {
  if (isPet) return;
  for (const part of ['hair', 'chest'] as const) {
    const support = modelPhysicsState?.support[part];
    const enabled = $<HTMLInputElement>(`physics-${part}-enabled`);
    const strength = $<HTMLInputElement>(`physics-${part}-strength`);
    // An unsupported model must still let the user cancel a saved request.
    if (enabled) enabled.disabled = !modelPhysicsSettingsReady || modelPhysicsSaving
      || (!support?.supported && !modelPhysicsSettings[part].enabled);
    if (strength) strength.disabled = !modelPhysicsSettingsReady || modelPhysicsSaving || !support?.supported;
    text(`physics-${part}-support`, !settings.model ? uiText('载入模型后检查结构')
      : !support ? uiText('正在检查模型结构…')
      : support.supported ? uiText('当前模型支持此效果')
      : uiTemplate`当前模型不可用：${support.reason ?? uiText('缺少可靠的局部物理结构')}`);
  }
  const quality = $<HTMLSelectElement>('physics-quality');
  if (quality) quality.disabled = !modelPhysicsSettingsReady || modelPhysicsSaving;
}
function syncModelPhysicsForm(): void {
  if (isPet) return;
  for (const part of ['hair', 'chest'] as const) {
    const enabled = $<HTMLInputElement>(`physics-${part}-enabled`);
    const strength = $<HTMLInputElement>(`physics-${part}-strength`);
    if (enabled) enabled.checked = modelPhysicsSettings[part].enabled;
    if (strength) strength.value = String(modelPhysicsSettings[part].strength);
    text(`physics-${part}-strength-value`, String(modelPhysicsSettings[part].strength));
  }
  const quality = $<HTMLSelectElement>('physics-quality');
  if (quality) quality.value = modelPhysicsSettings.quality;
  syncModelPhysicsSupport();
}
function applyModelPhysicsSettings(next: ModelPhysicsSettings): void {
  modelPhysicsSettings = normalizeModelPhysicsSettings(next, modelPhysicsSettings);
  modelPhysicsSettingsReady = true;
  stage.setPhysicsSettings(modelPhysicsSettings);
  syncModelPhysicsForm();
}
async function initModelPhysicsSettings(): Promise<void> {
  modelPhysicsUnsubscribe = window.desktop.onModelPhysicsSettings(next => {
    modelPhysicsEventVersion++;
    applyModelPhysicsSettings(next);
  });
  const version = modelPhysicsEventVersion;
  try {
    const initial = await window.desktop.getModelPhysicsSettings();
    if (version === modelPhysicsEventVersion) applyModelPhysicsSettings(initial);
    text('physics-save-state', uiText('设置保存在本机 · 两项默认关闭'));
  } catch {
    text('physics-save-state', uiText('物理设置暂时无法读取，请重新打开设置窗口'));
  }
  syncModelPhysicsSupport();
}
async function saveModelPhysicsSettings(patch: ModelPhysicsSettingsPatch): Promise<void> {
  if (isPet || !modelPhysicsSettingsReady || modelPhysicsSaving) { syncModelPhysicsForm(); return; }
  const version = modelPhysicsEventVersion;
  modelPhysicsSaving = true;
  syncModelPhysicsSupport();
  text('physics-save-state', uiText('正在保存…'));
  try {
    const accepted = await window.desktop.setModelPhysicsSettings(patch);
    // The commit broadcast may have arrived first, including a newer update.
    if (version === modelPhysicsEventVersion) applyModelPhysicsSettings(accepted);
    text('physics-save-state', uiText('已保存 · 效果在桌宠窗口生效'));
  } catch {
    text('physics-save-state', uiText('未能保存，已恢复上次设置'));
    notify(uiText('物理设置未保存，请重试。'), true);
  } finally {
    modelPhysicsSaving = false;
    syncModelPhysicsForm();
  }
}
function bindModelPhysicsControls(): void {
  for (const part of ['hair', 'chest'] as const) {
    const enabled = $<HTMLInputElement>(`physics-${part}-enabled`);
    const strength = $<HTMLInputElement>(`physics-${part}-strength`);
    if (enabled) enabled.onchange = () => {
      if (enabled.checked && !modelPhysicsState?.support[part].supported) { syncModelPhysicsForm(); return; }
      void saveModelPhysicsSettings({ [part]: { enabled: enabled.checked } });
    };
    if (strength) {
      strength.oninput = () => text(`physics-${part}-strength-value`, strength.value);
      strength.onchange = () => {
        if (!Number.isFinite(strength.valueAsNumber) || !strength.checkValidity()) { syncModelPhysicsForm(); return; }
        void saveModelPhysicsSettings({ [part]: { strength: strength.valueAsNumber } });
      };
    }
  }
  const quality = $<HTMLSelectElement>('physics-quality');
  if (quality) quality.onchange = () => {
    if (!['low', 'standard', 'high'].includes(quality.value)) { syncModelPhysicsForm(); return; }
    void saveModelPhysicsSettings({ quality: quality.value as PhysicsQuality });
  };
  syncModelPhysicsForm();
}
function syncMusicSettingsForm(): void {
  if (isPet) return;
  const strength = $<HTMLInputElement>('music-strength');
  if (strength) { strength.value = String(musicSettings.strength); strength.disabled = !musicSettingsReady || musicSettingsSaving; }
  text('music-strength-value', String(musicSettings.strength));
  const always = $<HTMLInputElement>('music-always-dance');
  if (always) { always.checked = musicSettings.alwaysDance; always.disabled = !musicSettingsReady || musicSettingsSaving; }
}
function applyMusicSettings(next: MusicSettings): void {
  musicSettings = normalizeMusicSettings(next, musicSettings);
  musicSettingsReady = true;
  stage.setMusicSettings(musicSettings);
  syncMusicSettingsForm();
}
async function initMusicSettings(): Promise<void> {
  musicSettingsUnsubscribe = window.desktop.onMusicSettings(next => {
    musicSettingsEventVersion++;
    applyMusicSettings(next);
  });
  const version = musicSettingsEventVersion;
  try {
    const initial = await window.desktop.getMusicSettings();
    if (version === musicSettingsEventVersion) applyMusicSettings(initial);
    text('music-save-state', uiText('强度保存在本机 · 请在桌宠上单独开启音乐按钮'));
  } catch { text('music-save-state', uiText('音乐强度暂时无法读取，请重新打开设置窗口')); }
  syncMusicSettingsForm();
}
async function saveMusicSettings(change: number | Partial<MusicSettings>): Promise<void> {
  const patch = typeof change === 'number' ? { strength: change } : change;
  if (isPet || !musicSettingsReady || musicSettingsSaving) { syncMusicSettingsForm(); return; }
  const version = musicSettingsEventVersion;
  musicSettingsSaving = true;
  syncMusicSettingsForm();
  text('music-save-state', uiText('正在保存…'));
  try {
    const accepted = await window.desktop.setMusicSettings(patch);
    if (version === musicSettingsEventVersion) applyMusicSettings(accepted);
    text('music-save-state', uiText('已保存 · 音乐按钮保持独立控制'));
  } catch {
    text('music-save-state', uiText('未能保存，已恢复上次强度'));
    notify(uiText('音乐强度未保存，请重试。'), true);
  } finally { musicSettingsSaving = false; syncMusicSettingsForm(); }
}
function bindMusicSettingsControls(): void {
  const strength = $<HTMLInputElement>('music-strength');
  if (strength) {
    strength.oninput = () => text('music-strength-value', strength.value);
    strength.onchange = () => {
      if (!Number.isFinite(strength.valueAsNumber) || !strength.checkValidity()) { syncMusicSettingsForm(); return; }
      void saveMusicSettings(strength.valueAsNumber);
    };
  }
  const always = $<HTMLInputElement>('music-always-dance');
  if (always) always.onchange = () => { void saveMusicSettings({ alwaysDance: always.checked }); };
  syncMusicSettingsForm();
}
function applyBlushCalibration(view: BlushCalibrationView, url = settings.model?.url ?? ''): void {
  if (url !== (settings.model?.url ?? '')) return;
  blushCalibrationView = view; blushCalibrationUrl = url;
  stage.setBlushCalibration(view.calibration, url);
  blushCalibrationControls?.update(view, stage.getBlushSupport());
}
async function refreshBlushCalibration(): Promise<void> {
  const generation = ++blushCalibrationGeneration, url = settings.model?.url ?? '';
  try {
    const view = await window.desktop.getBlushCalibration();
    if (generation === blushCalibrationGeneration && url === (settings.model?.url ?? '')) applyBlushCalibration(view, url);
  } catch (error) { if (generation === blushCalibrationGeneration) notify(String(error), true); }
}
function stopMotionPreview(): void {
  void motionPreview?.stop().catch(error => notify(String(error), true));
}
function voiceContext(): { characterId: string; modelPath: string } {
  return { characterId: characterState?.activeId ?? '', modelPath: settings.model?.path ?? '' };
}
function currentTtsConfig(): TtsConfig {
  const context = voiceContext();
  return effectiveTtsConfig(settings.tts ?? structuredClone(DEFAULT_TTS_CONFIG), context.characterId, context.modelPath);
}
async function init(): Promise<void> {
  // Subscribe before the startup awaits; the handler attaches further down (src/latched-signal.ts).
  const petRecovered = latchSignal(callback => window.desktop.onPetRecovered(callback));
  const interfaceLanguage = await window.desktop.getUiLanguage();
  setUiLanguage(interfaceLanguage.language);
  document.documentElement.lang = interfaceLanguage.language;
  settings = await window.desktop.getSettings();
  projectPetVisibility();
  hostSettings = structuredClone(settings);
  if (!isPet) petVisibilityIntent = new PetVisibilityIntent(async visible => {
    const sent = structuredClone(settings);
    const accepted = await window.desktop.setPetVisible(visible);
    settings = mergeSettings(sent, settings, accepted);
    projectPetVisibility();
    hostSettings = accepted;
  }, async error => {
    projectPetVisibility(); notify(String(error), true);
  });
  if (isPet) {
    document.documentElement.classList.add("pet-root");
    document.body.classList.add("pet-mode");
    renderPet(app);
    petUI = new PetUI({
      edit: enabled => stage.setCameraEditMode(enabled ?? !cameraEditing),
      toggleAlwaysOnTop: () => void requestAlwaysOnTop(!settings.pet.alwaysOnTop),
      onInteractionBlockChange: () => { moodCompanion?.reset('window-operation'); syncBehaviorGate(); },
      feature: feature => void toggleRuntime(feature), watchTogether: () => void toggleWatchTogether(),
      camera: patch => window.desktop.setRuntimeState(patch), explainRuntime: reply => explainRuntimeReply(reply), // I-036: 发图片 / 姿势识别
      systemAudio: () => ambientAudioController?.toggleExpanded(),
      closeSystemAudioPanel: () => { if(ambientAudioController?.isExpanded)ambientAudioController.toggleExpanded(); },
      toggleUserProfile: () => userProfilePanel?.toggle(), closeUserProfile: () => userProfilePanel?.close(),
      popups: { // I-028: folding the toolbar closes these too (src/ui/pet-popups.ts)
        'screen-sharing-options': laterPopup(() => screenSharingOptions, options => options.isOpen, options => options.close()),
        'mood-companion': laterPopup(() => moodCompanion, mood => mood.panelOpen, mood => mood.closePanel()),
      },
      send: () => void sendChat(), stop: () => void stopChat(), error: message => notify(message, true),
    });
  } else {
    renderControls(app);
    const languageSelect = document.getElementById('ui-language') as HTMLSelectElement;
    let savedLanguagePreference = interfaceLanguage.preference;
    languageSelect.value = savedLanguagePreference;
    const languageNotice = document.getElementById('ui-language-status');
    if (languageNotice) languageNotice.textContent = uiText(interfaceLanguage.notice
      ? '无法读取已保存的界面语言，暂用系统默认；原文件已保留。'
      : '语言更改会在下次启动时生效。');
    languageSelect.addEventListener('change', () => {
      const selected = languageSelect.value;
      if (selected !== 'system' && selected !== 'en' && selected !== 'zh-CN') return;
      languageSelect.disabled = true;
      void window.desktop.setUiLanguage(selected).then(accepted => {
        savedLanguagePreference = accepted.preference;
        languageSelect.value = savedLanguagePreference;
        const output = document.getElementById('ui-language-status');
        if (output) output.textContent = uiText('语言已保存，下次打开应用时生效。');
      }).catch(error => {
        languageSelect.value = savedLanguagePreference;
        notify(String(error), true);
      }).finally(() => { languageSelect.disabled = false; });
    });
    new SingleEmojiControls($('single-emoji-controls'), {
      get: () => window.desktop.getSingleEmojiSettings(),
      save: value => window.desktop.setSingleEmojiSettings(value),
      preview: id => window.desktop.previewSingleEmoji(id),
      changed: callback => window.desktop.onSingleEmojiSettings(callback),
    });
    characterStickerControls=new CharacterStickerControls($('single-emoji-controls'),{
      get:()=>window.desktop.getCharacterStickers(),prepare:async()=>{const challenge=await window.desktop.beginCharacterStickerReference();try{const captured=await stage.captureCharacterStickerReference(challenge.modelUrl);return await window.desktop.acceptCharacterStickerReference({challengeId:challenge.id,...captured});}catch(error){await window.desktop.retireCharacterStickerReference({challengeId:challenge.id}).catch(()=>undefined);throw error;}},
      generate:(referenceId,intent)=>window.desktop.generateCharacterSticker({referenceId,intent}),save:resultId=>window.desktop.saveCharacterSticker({resultId}),preview:assetId=>window.desktop.previewCharacterSticker({assetId}),cancel:()=>window.desktop.cancelCharacterSticker(),changed:callback=>window.desktop.onCharacterStickers(callback),
    });
    new FeedRecognitionPanel($('feed-recognition'), { get: () => window.desktop.getFeedRecognition(), set: value => window.desktop.setFeedRecognition(value),
      changed: callback => window.desktop.onFeedRecognition(callback), error: message => notify(message, true) }); // I-019
    new MoodJudgePanel($('mood-judge'), { get: () => window.desktop.getMoodJudge(), set: value => window.desktop.setMoodJudge(value),
      changed: callback => window.desktop.onMoodJudge(callback), error: message => notify(message, true) }); // I-027
    new ReactionsPanel($('reactions'), { get: () => window.desktop.getReactions(), set: value => window.desktop.setReactions(value),
      changed: callback => window.desktop.onReactions(callback), error: message => notify(message, true) }); // I-037 新的反应方式
    new ReactionDispositionsPanel($('reaction-dispositions'), { get: () => window.desktop.getReactionDispositions(), set: values => window.desktop.setReactionDispositions(values),
      changed: callback => window.desktop.onReactions(callback), error: message => notify(message, true) }); // I-037: the six 反应倾向 on the 角色页
    new UserActivityPanel($('user-activity'), { get: () => window.desktop.getUserActivity(), set: value => window.desktop.setUserActivity(value),
      changed: callback => window.desktop.onUserActivity(callback), error: message => notify(message, true) }); // I-006
    new JournalPanel($('experience-journal'), { get: () => window.desktop.getJournal(), setEnabled: value => window.desktop.setExperienceJournal(value),
      changed: callback => window.desktop.onJournal(callback), error: message => notify(message, true) });
    new AgentChannelPanel($('agent-channel'), { get: () => window.desktop.getAgentChannel(), setEnabled: value => window.desktop.setAgentChannelEnabled(value),
      changed: callback => window.desktop.onAgentChannel(callback), copy: text => navigator.clipboard.writeText(text), error: message => notify(message, true),
      setInterconnect: value => window.desktop.setAgentInterconnect(value), relink: () => window.desktop.relinkAgentClaudeCode(), undo: id => window.desktop.undoAgentAction(id),
      restore: id => window.desktop.restoreRecycledMemory(id), setRecycleDays: days => window.desktop.setRecycleDays(days) }); // I-014
    new LocalAsrPanel($('local-asr'), { get: () => window.desktop.getLocalAsr(), changed: callback => window.desktop.onLocalAsr(callback),
      download: () => window.desktop.downloadLocalAsr(), cancel: () => window.desktop.cancelLocalAsrDownload(), dismiss: () => window.desktop.dismissLocalAsrPrompt(),
      importFiles: () => window.desktop.importLocalAsr(), remove: () => window.desktop.removeLocalAsr(),
      reveal: () => controlNavigation?.navigate('providers', 'voice-input-config'), error: message => notify(message, true) });
    new PoseSensingPanel($('pose-sensing'), { get: () => window.desktop.getPoseSensing(), changed: callback => window.desktop.onPoseSensing(callback),
      download: () => window.desktop.downloadPoseComponents(), cancel: () => window.desktop.cancelPoseDownload(), dismiss: () => window.desktop.dismissPosePrompt(),
      importFiles: () => window.desktop.importPoseComponents(), remove: () => window.desktop.removePoseComponents(), redetect: () => window.desktop.redetectPoseHardware(),
      diagnostics: () => window.desktop.getPoseDiagnostics(), reveal: () => controlNavigation?.navigate('privacy', 'privacy-camera'), error: message => notify(message, true) }, $('runtime-camera').closest('label'));
    new ChatAvailabilityNotice($('chat-availability'), { get: () => window.desktop.getChatAvailability(), changed: callback => window.desktop.onChatAvailability(callback),
      retry: () => window.desktop.retryChatAvailability(), help: () => window.desktop.openClaudeHelp(), networkSettings: () => window.desktop.openNetworkSettings(), error: message => notify(message, true) });
    window.desktop.onAgentChannelAction(action => runAgentRendererAction(action, { voicePreview: () => $('test-voice').click(),
      playPreview: recipe => $(recipe === 'shy' ? 'shy-preview' : 'surprise-preview').click() }));
    projectPetVisibility();
  }
  mountImmersiveNotice();
  window.desktop.onAgentChannelNotice(notice => notify(agentNoticeText(notice))); // "由 Claude 操作" in both windows.
  watchClaudeTasks(window.desktop); // R20: chat offers a task only while the user's switch is on.
  userProfilePanel = new UserProfilePanel($('user-profile-panel'), $<HTMLButtonElement>('user-profile-toggle'), window.desktop,
    message => notify(message, true), () => { $('notice-detail-panel').hidden = true; });
  userProfilePanel.setMemorials(new TextMemorialPanel(window.desktop, () => userProfilePanel?.refreshMemorials()));
  if (!isPet) $('user-profile-toggle').onclick = () => userProfilePanel?.toggle();
  $('notice-details').addEventListener('click', closeProfileForNotice);
  // I-024: the stage gets its capability card from its profile, haiku's checked matches and the user's choices (both windows).
  modelCapabilitySync = new ModelCapabilitySync({ api: window.desktop, apply: card => stage?.setModelCapabilities(card), onChange: state => modelCapabilityPanel?.update(state) });
  onStageModelProfile(profile => modelCapabilitySync?.profileBuilt(profile));
  window.desktop.onModelCapabilities(update => modelCapabilitySync?.receive(update));
  if (isPet) bindCapabilityPreview(window.desktop, () => stage); // 试一下 from the character page plays on the pet's own stage
  stage = new MmdStage($("stage"), {
    transparent: isPet,
    // P4: pet framing keeps the model below the hover toolbar and frames a never-framed camera.
    framingTop: isPet ? () => petUI?.toolbarReach() ?? 0 : undefined,
    frameUnframed: isPet,
    // 体验记录 (E2): her music tier, from the pet window only (the host ignores it unless the switch is on).
    onMusicTier: (tier, score) => { if (isPet) void window.desktop.noteMusicTier({ tier, score }).catch(() => {}); },
    onBlushCue: stage => { if (isPet) void window.desktop.noteJournalFact('blush-stage', stage).catch(() => {}); }, onFirstShown: () => { if (isPet) void window.desktop.noteJournalFact('launch', null).catch(() => {}); }, onMotionGlitch: glitch => { if (isPet) void window.desktop.noteMotionGlitch(glitch).catch(() => {}); }, // 动作跳变记录 → 体验记录 (only while it is on)
    onColorBlock: isPet ? report => { void window.desktop.noteColorBlock(report).catch(() => {}); } : undefined, // I-031 色块诊断日志 (temporary): the host writes it outside every profile
    onSurprisePreviewState: state=>{if(!isPet){text('surprise-preview-status',state==='playing'?uiText('正在预览表情与头身 · 手暂未加入'):state==='partial'?uiText('部分效果受当前状态影响 · 手暂未加入'):state==='unsupported'?uiText('当前模型暂不支持表情试作'):uiText('试作已结束 · 原动作继续'));if(state==='idle')motionPreview?.finishLocal();}},
    onPhysicsState: state => { modelPhysicsState = state; syncModelPhysicsSupport(); },
    onMotionFit: view => { motionFitView = view; motionLibraryControls?.setMotionFit(view); if (!view) modelCapabilitySync?.modelCleared(); },
    onFramingStateChange: () => { if (!petFramingController?.applying) queueMicrotask(() => petFramingController?.report()); },
    onCameraEditChange: enabled => {
      petFramingController?.invalidate();
      void window.desktop.noteManualCameraChange().catch(() => {});
      cameraEditing = enabled;
      syncBehaviorGate();
      if (enabled) moodCompanion?.reset('camera-edit');
      if (isPet) petUI?.setEditing(enabled); else syncCameraMode();
      if (!enabled && !recoveringPetView) void save();
    },
    onFaceAnchor: point => { petUI?.setFaceAnchor(point); rpsOverlay?.place(point, window.innerWidth, window.innerHeight); },
    onCameraChange: (camera) => {
      settings.camera = camera;
      if (!isPet) syncCamera();
      if (!recoveringPetView && !petFramingController?.applying) {
        void window.desktop.noteManualCameraChange().catch(() => {});
        queueSave();
      }
    },
    onStatus: (message) => {
      updateStageStatus(message);
    },
    onError: (message) => {
      text(isPet ? "pet-status" : "stage-status", immersiveDeveloperMode ? message : conciseFailure(message));
      notify(message, true);
    },
  });
  // I-017: her body's music state for the next chat turn's perception line (pet window only; the host checks freshness and order).
  if (isPet) { const herState = new HerStateReporter({ read: () => stage.getMusicPresence(), send: report => window.desktop.noteStageState(report) }); setInterval(() => herState.tick(), HER_STATE_REPORT_CHECK_MS); }
  if (isPet) { const listenPanel = new ListenKindPanelFeed({ active: () => !!stage.getMusicChoiceLine(), read: () => window.desktop.readListenKind(), show: line => stage.setListenKindLine(line) }); setInterval(() => listenPanel.tick(), HER_STATE_REPORT_CHECK_MS); } // I-016: the host's kind on the developer line
  hostVisible = windowVisibility.visible;
  stage.setVisible(hostVisible);
  if (isPet) petPointer = installPetPointerPassthrough({ document, stageRoot: $('stage'), probe: (x, y, signal) => stage.pixelProbe.request(x, y, signal),
    enabled: () => settings.pet.clickThrough && hostVisible, holds: () => cameraEditing || !!petUI?.windowInteractionBlocked,
    request: receive => window.desktop.setPetPointerInput(receive), visibility: window.desktop.onWindowVisibility });
  if (isPet) {
    petFramingController = new PetFramingController(crypto.randomUUID(), {
      state: () => stage.getFramingView(),
      report: state => { void window.desktop.reportPetFramingState(state).catch(() => {}); },
      begin: id => window.desktop.beginPetFraming(id), complete: report => window.desktop.completePetFraming(report),
      frame: preset => stage.frame(preset) !== null,
    });
    window.desktop.onPetFramingRequest(request => { void petFramingController!.receive(request).catch(() => notify(uiText('这次取景结果尚未确认。'), true)); });
    petFramingController.report();
  }
  await initModelPhysicsSettings();
  await initMusicSettings();
  moodCompanion = new MoodCompanion({
    isPet, surface: $('stage'), getHeadRegion: () => stage.getInteractionRegion(),
    getCharacterId: () => characterState?.cards.some(card => card.id === characterState!.activeId) ? characterState!.activeId : null,
    onScopeInvalidated: () => stage.invalidateMoodScope(),
    canInteract: () => !!settings.model && hostVisible && !document.hidden && !cameraEditing && !petUI?.windowInteractionBlocked && !composing,
    onFeedback: feedback => { stage.setMoodContact(feedback); feedPause.feedback(feedback); petUI?.setInteractionProgress(feedback.contact || feedback.feeding ? 1 : feedback.hover ?? 0); },
    getDegradation: () => stage.getMoodDegradation(),
    getMusicDesire: () => stage.getMusicChoiceLine(),
    getExpressionSupport: recipe => stage.expressionSupport(recipe), // E1: the developer panel's 「预览：惊喜 / 害羞」
    onProceduralLife: enabled => stage.setProceduralLife(enabled),
    onInteraction: active => petUI?.setInteraction(active),
    onView: view => {
      stage.setMood(view);petUI?.setDeveloperMode(view.developerMode);
      immersiveDeveloperMode=view.developerMode;
      document.body.classList.toggle('developer-mode',view.developerMode);
      immersiveNotice?.setDeveloperMode(view.developerMode);
      updateStageStatus(lastStageStatus);
    },
    onSnack: (file, sessionId) => { void feedSnacks?.send(file, sessionId); },
    onError: message => notify(message, true),
  });
  await moodCompanion.init();
  petUI?.setHostVisible(hostVisible);
  moodCompanion.setHostVisible(hostVisible);
  stage.setVisible(hostVisible);
  document.addEventListener('compositionstart', () => { composing = true; moodCompanion?.reset('composition'); syncBehaviorGate(); });
  document.addEventListener('compositionend', () => { composing = false; syncBehaviorGate(); });
  document.addEventListener('focusin', syncBodyInputGate);
  document.addEventListener('focusout', () => queueMicrotask(syncBodyInputGate));
  if (!isPet) {
    memoryPanel = new MemoryPanel($('memory-panel'), {
      list: query => window.desktop.listMemories(query),
      read: (id, query) => window.desktop.readMemory(id, query),
      edit: (id, patch) => window.desktop.editMemory(id, patch),
      remove: id => window.desktop.deleteMemory(id),
      note: id => window.desktop.readMemoryNote(id), removeNote: id => window.desktop.deleteMemoryNote(id), // I-021: her note, read only; delete just the note
      config: () => window.desktop.getMemoryConfig(),
      configure: config => window.desktop.setMemoryConfig(config),
      error: message => notify(message, true),
    });
    await memoryPanel.init();
    window.desktop.onMemoryChanged(() => void memoryPanel?.refresh());
    const listenSection = document.createElement('section'); listenSection.id = 'listen-together-panel'; $('memory-panel').append(listenSection); // I-016: her notes, the raw count and clear
    const listenPanel = new ListenTogetherPanel(listenSection, { view: () => window.desktop.getListenTogetherView(), clearRaw: () => window.desktop.clearListenRaw(), deleteNote: id => window.desktop.deleteListenNote(id), onError: message => notify(message, true), confirm: message => window.confirm(message) });
    await listenPanel.init(); window.desktop.onListenTogetherChanged(() => void listenPanel.refresh());
    const audioHistory = document.createElement('section'); audioHistory.id = 'ambient-transcript-history';
    $('memory-panel').append(audioHistory);
    ambientTranscriptHistory = new AmbientTranscriptHistory(audioHistory, {
      list: query => window.desktop.listAmbientTranscripts(query), read: id => window.desktop.readAmbientTranscript(id),
      comments: id => window.desktop.readAmbientComments(id), remove: id => window.desktop.deleteAmbientTranscript(id),
      onError: message => notify(message, true),
    });
    await ambientTranscriptHistory.init();
    window.desktop.onAmbientTranscriptChanged(() => void ambientTranscriptHistory?.refresh());
  }
  window.desktop.onChatReset(() => { clearChat(false); memoryPanel?.reset(); });
  if (isPet) systemAudioInput = new SystemAudioInput({
    onSample: sample => ambientAudioController?.captureSystemSample(sample),
    onState: state => { petUI?.setSystemAudioState(state); ambientAudioController?.captureState(state); },
    onStatus: status => petUI?.setSystemAudioState({ active: systemAudioInput?.active ?? false }, status),
    onError: message => notify(message, true),
  });
  if (isPet) window.desktop.onAmbientCommentOffer(offer => { void presentAmbientComment(offer); });

  window.desktop.onAmbientCommentCommitted(comment => {
    if (isPet || activeChat || ambientDisplayedComments.has(comment.id)) return;
    rememberAmbientComment(comment);
  });
  window.desktop.onAmbientCommentCancelled(event => {
    if (isPet) petUI?.hideAnswerFor(event.id);
  });
  let lastProactiveInput = -Infinity;
  const noteProactiveInput = () => {
    initiativeGeneration++;
    textMemorialOffer?.invalidate();
    if (activeMemorialSpeechId) { const id = activeMemorialSpeechId; activeMemorialSpeechId = null; speech.stop(); petUI?.hideAnswerFor(id); }
    if (activeVisionSpeechId) { activeVisionSpeechId = null; speech.stop(); petUI?.hideAnswer(); }
    if (provisionalInitiative) { petUI?.hideAnswer(); provisionalInitiative = null; }
    const now = performance.now(); if (now - lastProactiveInput < 500) return; lastProactiveInput = now;
    void window.desktop.noteVisionUserActivity().catch(() => {});
  };
  document.addEventListener('pointerdown', noteProactiveInput, true);
  document.addEventListener('pointermove', event => { if (event.buttons) noteProactiveInput(); }, true);
  document.addEventListener('keydown', noteProactiveInput, true);
  document.addEventListener('input', noteProactiveInput, true);
  petRecovered.attach(() => {
    if (!isPet) return;
    const generation = ++petRecoveryGeneration;
    recoveringPetView = true;
    clearTimeout(saveTimer);
    stage.setCameraEditMode(false);
    petUI?.setWindowAdjusting(false);
    void (async () => {
      // R37: resume drawing from the host's current native truth before re-framing.
      await window.desktop.getWindowVisibility().then(acceptWindowVisibility, () => {});
      await saveQueue;
      if (generation !== petRecoveryGeneration) return;
      settings = await window.desktop.getSettings();
      projectPetVisibility();
      hostSettings = structuredClone(settings);
      await stage.applySettings(settings);
      if (generation !== petRecoveryGeneration) return;
      stage.frame('full');
      const accepted = await window.desktop.savePetView({ camera: settings.camera, scale: DEFAULT_SETTINGS.pet.scale ?? 1 });
      if (generation !== petRecoveryGeneration) return;
      settings = accepted;
      projectPetVisibility();
      hostSettings = structuredClone(accepted);
      applyStage();
      updateSummary();
    })().catch(error => notify(String(error), true)).finally(() => {
      if (generation === petRecoveryGeneration) recoveringPetView = false;
      if (generation === petRecoveryGeneration) void checkPetPresentation({ document, hostVisible: () => hostVisible, reason: 'restore',
        report: sample => window.desktop.reportPetPresentation(sample), reload: () => location.reload() });
    });
  });
  if (!isPet) motionPreview = new MotionPreviewSession({
    getSettings: () => settings,
    load: (packId, motionId) => window.desktop.previewMotion(packId, motionId),
    apply: view => stage.applySettings(view),
    onState: state => {
      syncBehaviorGate();
      motionLibraryControls?.setPreviewState(state);
      text('motion-name', state.phase === 'idle' ? settings.motion?.name ?? uiText('未载入 · 使用平滑呼吸待机') : uiTemplate`预览：${state.name ?? uiText('动作')}`);
    },
  });
  applyStage();
  warmAudioOutput(); // after the model load has begun: the stall overlaps loading instead of her first words
  updateSummary();
  if (!isPet) {
    syncForm();
    bindControls();
    emotionalVoiceControls = new EmotionalVoiceControls($('emotional-voice'), {
      getConfig: currentTtsConfig,
      getContextKey: () => JSON.stringify(voiceContext()),
      getContextLabel: () => uiTemplate`${characterName} · ${settings.model?.name ?? uiText('未选择模型')} 的专属语音风格`,
      onChange: async draft => {
        speech.stop();
        const current = settings.tts ?? structuredClone(DEFAULT_TTS_CONFIG);
        const context = voiceContext();
        const { voice, instruction, emotion, rate } = draft;
        settings.tts = {
          ...current, provider: draft.provider, apiHost: draft.apiHost, region: draft.region,
          model: draft.model, apiKey: draft.apiKey, introduced: draft.introduced,
          ...(context.characterId && context.modelPath ? { styleBindings: [
            ...(current.styleBindings ?? []).filter(binding => binding.characterId !== context.characterId || binding.modelPath !== context.modelPath),
            { ...context, voice, instruction, emotion, rate },
          ].slice(-64) } : { voice, instruction, emotion, rate }),
        };
        if (!(await save())) throw new Error(uiText('语音配置未保存，请检查填写内容。'));
      },
      onPreview: text => speech.preview(text),
      onCharacterPreview: text => currentTtsConfig().provider === 'system'
        ? speech.preview(text)
        : speech.previewCharacter(text, () => window.desktop.prepareCharacterSpeechPreview()),
      onStop: () => speech.stop(),
      onOpenConsole: () => window.desktop.openTtsConsole(),
      onOpenGuide: () => window.desktop.openTtsGuide(),
      onFirstUse: message => notify(message,false,'voice-setup'),
      onError: message => notify(message, true),
    });
    codexTasks = new CodexTasks($('codex-tasks'), {
      api: window.desktop,
      getSettings: () => settings,
      beforeStart: save,
      onDirectorySelected: async path => { settings.agent.workingDirectory = path; await save(); },
      onError: message => notify(message, true),
      onOpen: openCodexTaskPanel,
    });
    taskProposalUnsubscribe = window.desktop.onCodexTaskProposal(prompt => {
      if (!codexTasks?.offer(prompt)) { codexTasks?.prepare(prompt); openCodexTaskPanel(); }
    });
    motionLibraryControls = new MotionLibraryControls($("motion-library"), {
      getModel: () => settings.model,
      getSettings: () => settings,
      beforeInstall: () => save(),
      onPreview: (packId, motion, layer) => {stage.cancelVisualPreview();stage.cancelBodyPreview();return motionPreview!.start(packId, motion, layer);},
      onStopPreview: () => motionPreview!.stop(),
      onClearLayer: async layer => {
        await motionPreview!.stop();
        if (!(await save())) return;
        const accepted = await window.desktop.clearMotionLayer(layer);
        settings = mergeSettings(hostSettings, settings, accepted);
        projectPetVisibility();
        hostSettings = accepted;
        applyStage();
        updateSummary();
      },
      onEnabled: async () => {
        const accepted = await window.desktop.getSettings();
        settings = mergeSettings(hostSettings, settings, accepted);
        projectPetVisibility();
        hostSettings = accepted;
        applyStage();
        updateSummary();
      },
      onError: (message) => notify(message, true),
    });
    await motionLibraryControls.init();
    motionLibraryControls?.setMotionFit(motionFitView);
  }
  window.desktop.onSettings((next) => {
    if (next.pet.alwaysOnTop !== hostSettings.pet.alwaysOnTop) settingsBroadcastEpoch++;
    const changedVoiceContext = next.model?.path !== settings.model?.path || JSON.stringify(next.tts) !== JSON.stringify(settings.tts)
      || JSON.stringify(next.voice) !== JSON.stringify(settings.voice);
    const changedProvider =
      JSON.stringify(next.provider) !== JSON.stringify(settings.provider);
    const changedPersona = next.persona !== settings.persona;
    const changedModel = next.model?.path !== settings.model?.path;
    if (changedModel || changedProvider || changedPersona) { petFramingController?.invalidate(); clearCommandMessageRows(); }
    if (changedModel || changedProvider || changedPersona) moodCompanion?.reset('context');
    settings = mergeSettings(hostSettings, settings, next);
    hostSettings = next;
    projectPetVisibility();
    if (changedVoiceContext) speech.stop();
    applyStage();
    updateSummary();
    if (!isPet) {
      syncForm();
    }
    if (changedProvider || changedPersona) { clearChat(false); memoryPanel?.reset(); ambientTranscriptHistory?.reset(); void ambientTranscriptHistory?.refresh(); }
    // C2/C3: a new persona for the same connection is her card changing; the window shows her current conversation again.
    if (changedPersona && !changedProvider) refillChat(false);
    if (!settings.voice.enabled) speech.stop();
    feedCuePrefetch.voiceContextChanged();
  });
  window.desktop.onStream(onStream);
  window.desktop.onChatStarted(chat => chat.readoutControl ? beginReadoutControl(chat) : beginChat(chat));
  window.desktop.onReplyRhythm(pacing => replyPresentation.setRhythm(pacing.id, pacing)); // F7 说话节奏: this reply's pace for the bubbles after the first
  window.desktop.onPauseTalk(cue => replyPresentation.setPausePlan(cue.id, cue)); // F7 停停说说: haiku's plan, for the bubbles not yet shown
  window.desktop.onCompanionCommandView(presentCompanionCommand);
  // R41 chat settings card: plain host data → DOM (textContent only); a tap goes back to the host.
  const chatSettingCards = new ChatSettingCards({ choose: request => window.desktop.chooseChatSetting(request), error: message => notify(message, true),
    container: () => isPet ? document.querySelector<HTMLElement>('.pet-chat') : $('messages'), prepend: isPet, settledLifetimeMs: isPet ? 5_000 : undefined }); // R46: readable 5 s, then fades
  window.desktop.onChatSettingCard(card => chatSettingCards.present(card));
  testNotes = new TestCommandNotes({ container: () => isPet ? document.querySelector<HTMLElement>('.pet-chat') : $('messages'), prepend: isPet, lifetimeMs: isPet ? 15_000 : undefined });
  window.desktop.onTestNote(note => testNotes?.note(note));
  window.desktop.onTestEffect(effect => { if (effect === 'music-rejudge') stage?.rejudgeMusicNow(); }); // D2: a closed set of stage requests
  window.desktop.onExpressionPreview(recipe => { stage?.playExpression(recipe); }); // E1: every window's stage plays 惊喜 / 害羞 on its own model
  window.desktop.onHerAction(cue => { void stage?.playHerAction(cue); }); // 她的动作 (T-211): every window's stage; the pet answers the host
  if (isPet) window.desktop.onReaction(cue => { const id = (cue as { id?: unknown } | null)?.id, result = stage?.playReaction(cue) ?? 'unsupported'; if (typeof id === 'string') void window.desktop.reactionResult({ id, result }).catch(() => {}); }); // I-037: a reaction cue (the shy show); the stage decides, never restarts a running show
  const sharingMount = document.createElement('div');
  sharingMount.className = isPet ? 'pet-sharing-options' : 'control-sharing-options';
  sharingMount.dataset.moodUi = 'true';
  (isPet ? $('pet-toolbar') : $('runtime-screen').closest('.settings-section')!).append(sharingMount);
  screenSharingOptions = new ScreenSharingOptions(sharingMount, patch => {
    void window.desktop.setVisionOptions(patch).then(applyVisionRuntime, error => {
      notify(String(error), true); screenSharingOptions?.update({ ...visionRuntime, ...runtime });
    });
  });
  // 识图第 1 步: "给她看看屏幕", only while screen sharing is on: sends what is typed (or "你看看我的屏幕。") with the screen (src/ui/LookButton.ts).
  const lookHost = isPet ? document.getElementById('chat-form') : document.querySelector<HTMLElement>('.composer-tools > div');
  if (lookHost) lookButton = new LookButton(lookHost, isPet ? document.getElementById('send-chat') : null, isPet, () => {
    const input = $<HTMLTextAreaElement>('chat-input'); input.value = lookButtonContent(input.value); void sendChat(true, true);
  });
  lookButton?.update(runtime);
  // 屏幕只读大概: her "要我凑近看看吗" shows "让她看清楚屏幕吗？ 看吧 / 不用" in the pet's chat (src/ui/LookOfferPrompt.ts); 看吧 sends like the
  // button above, 不用 closes her offer without a frame.
  if (isPet) {
    const lookOffer = new LookOfferPrompt({
      container: () => document.querySelector<HTMLElement>('.pet-chat'),
      look: () => { const input = $<HTMLTextAreaElement>('chat-input'); input.value = lookOfferContent(input.value); void sendChat(true, true); },
      decline: id => { void window.desktop.declineLookOffer(id).catch(() => {}); },
    });
    window.desktop.onLookOffer(offer => lookOffer.present(offer));
  }
  const visionStatus = document.createElement('output'); visionStatus.id = 'vision-runtime-status';
  visionStatus.setAttribute('role', 'status'); sharingMount.append(visionStatus);
  window.desktop.onVisionRuntime(applyVisionRuntime);
  applyVisionRuntime(await window.desktop.getVisionRuntime());
  window.desktop.onVisionContextCleared(() => { clearChat(false, false, true); provisionalInitiative = null; }); // the user's own draft snapshots stay (src/look-send.ts draftAfterClear)
  window.desktop.onVisionInitiative(event => {
    if (event.type === 'cancel') {
      if (activeVisionSpeechId === event.id) { activeVisionSpeechId = null; speech.stop(); petUI?.hideAnswer(); }
      retractInitiative(event.id); return;
    }
    if (!isPet) return;
    const message = event.message;
    if (!petUI || !hostVisible || activeChat || $<HTMLTextAreaElement>('chat-input').value.trim() || shownInitiatives.has(message.id)) {
      void window.desktop.cancelVisionInitiative(); return;
    }
    speech.stop();
    const generation = initiativeGeneration;
    const displayText = formatVisionPresentation(message);
    // Keep the real reply pending while its separate window confirms display.
    // A hidden pet DOM proxy is not evidence that the user saw this body.
    const body = petUI.showAnswer(displayText, true, message.id);
    provisionalInitiative = { id: message.id, body };
    void prepareVisionDelivery({
      publish: () => window.desktop.updatePetReply({ text: displayText, state: 'streaming' }),
      ack: () => window.desktop.ackVisionInitiative(message.id),
      current: () => generation === initiativeGeneration && provisionalInitiative?.id === message.id
        && hostVisible && !activeChat && !$<HTMLTextAreaElement>('chat-input').value.trim()
        && !shownInitiatives.has(message.id),
      retract: () => retractInitiative(message.id),
      commit: () => {
        provisionalInitiative = null;
        rememberInitiative(message);
        activeVisionSpeechId = message.id;
        petUI?.finishAnswer(displayText, message.id, settings.voice.enabled, true);
        if (settings.voice.enabled) {
          const ended = () => { if (activeVisionSpeechId === message.id) activeVisionSpeechId = null; endReplySpeech(message.id); };
          void speech.speak(message.text, settings.voice, { replyId: message.id }).then(ended, ended);
        }
      },
    });
  });
  window.desktop.onVisionInitiativeDelivered(message => {
    if (isPet || shownInitiatives.has(message.id)) return;
    const body = addMessage('assistant', message.text);
    const label = body.parentElement?.querySelector('.message-label');
    if (label) label.textContent = uiTemplate`${characterName} · 主动 · ${message.origin.labels.join('、')}`;
    rememberInitiative(message);
  });
  if (isPet) textMemorialOffer = new TextMemorialOfferController(window.desktop, {
    current: () => !!petUI && hostVisible && !activeChat && !replyPresentation.readoutPending
      && !ordinaryReplyPresentation && !voicePlaybackActive && !$<HTMLTextAreaElement>('chat-input').value.trim(),
    publish: async offer => {
      speech.stop(); provisionalMemorialId = offer.id;
      petUI?.showAnswer(offer.invite, true, offer.id);
      await window.desktop.updatePetReply({ text: offer.invite, state: 'streaming' });
    },
    retract: id => { if (provisionalMemorialId === id) { provisionalMemorialId = null; petUI?.hideAnswerFor(id); } },
    cancelled: id => { if (activeMemorialSpeechId === id) { activeMemorialSpeechId = null; speech.stop(); } petUI?.hideAnswerFor(id); },
    commit: result => {
      if (provisionalMemorialId !== result.offer.id) return;
      provisionalMemorialId = null;
      history.push({ role: 'assistant', content: result.offer.invite, origin: result.origin }); history = trimReplyHistory(history);
      petUI?.finishAnswer(result.offer.invite, result.offer.id, settings.voice.enabled, true);
      if (settings.voice.enabled) {
        activeMemorialSpeechId = result.offer.id;
        const ended = () => { if (activeMemorialSpeechId === result.offer.id) activeMemorialSpeechId = null; endReplySpeech(result.offer.id); };
        void speech.speak(result.offer.invite, settings.voice, result.context).then(ended, ended);
      }
    },
  });
  else {
    const delivered = new TextMemorialDeliveredHistory(event => {
      const body = addMessage('assistant', event.offer.invite);
      body.textContent = event.offer.invite;
      const label = body.parentElement?.querySelector('.message-label');
      if (label) label.textContent = uiTemplate`${characterName} · 主动 · ${event.origin.labels.join('、')}`;
      history.push({ role: 'assistant', content: event.offer.invite, origin: event.origin }); history = trimReplyHistory(history);
    });
    textMemorialDeliveredUnsubscribe = window.desktop.onTextMemorialEvent(event => delivered.event(event));
  }
  if (isPet) { rpsOverlay = new RpsOverlay(app, window.desktop, { stage, say: petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, // G1: her game lines in the ordinary bubble and voice
    free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }) }); void rpsOverlay.init(); }
  if (isPet) { feedSnacks = new FeedSnackClient(window.desktop); new FeedLinePresenter(window.desktop, { remember: rememberInitiative, // I-019: her line after a recognized feed
    say: petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }) }); }
  if (isPet) new FeedLinePresenter({ onFeedLine: callback => window.desktop.onSenseLine(callback), feedLineDone: input => window.desktop.senseLineDone(input) }, { remember: rememberInitiative, read: readSenseLineMessage, // I-040: her short line after a look or a listen
    say: petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }) });
  const r20Root = document.createElement('div'); r20Root.id = 'r20-proactive-offer';
  (isPet ? document.querySelector('.pet-chat') : $('messages').parentElement)?.append(r20Root);
  r20ProactiveOfferUI = new ProactiveAgentOffer(r20Root, window.desktop, {
    isPet,
    publish: async offer => {
      if (!petUI || !hostVisible || activeChat || replyPresentation.readoutPending || ordinaryReplyPresentation
        || voicePlaybackActive || $<HTMLTextAreaElement>('chat-input').value.trim()) throw Error(uiText('当前回复已变化，建议未显示。'));
      petUI.showAnswer(offer.question,true,offer.id);
      await window.desktop.updatePetReply({text:offer.question,state:'streaming'});
    },
    retract: id => { if (isPet) petUI?.hideAnswerFor(id); },
    presented: offer => {
      const at = Date.now();
      history.push({role:'assistant',content:offer.question,
        origin:{kind:'proactive',id:offer.id,at,sources:['text'],labels:['本轮对话的帮助提议']}});
      history = trimReplyHistory(history);
      // The question stays displayed while this purpose-specific ticket awaits an answer.
    },
    error: message => notify(message,true),
  });
  await r20ProactiveOfferUI.init();
  $('chat-input').addEventListener('compositionstart', noteProactiveInput);
  // L2 (pretrial issue 6): typing to her lifts her out of her own thing (the host decides; no text leaves, one note a second at most).
  let lastTypingNote = -Infinity;
  const noteChatTyping = () => { const now = performance.now(); if (now - lastTypingNote < 1_000) return; lastTypingNote = now; void window.desktop.noteChatTyping().catch(() => {}); };
  $('chat-input').addEventListener('compositionstart', noteChatTyping);
  $('chat-input').addEventListener('input', noteChatTyping);
  $('chat-input').addEventListener('focus', noteProactiveInput);
  mediaInput = new MediaInput({
    windowKind,
    pushToTalk: true, // hold T to talk: the microphone counts only while T is held in this window
    canStartVoice: () => voiceDraftRecords.size === 0,
    onUnheard: failure => { const line = voiceUnheardLine(failure); if (line) notify(uiText(line)); }, // 在听但不出字: say it, voice input stays on
    onTranscript: transcript => {
      if (!runtime.voiceInput || runtime.voiceOwner !== windowKind || !transcript.trim()) return;
      $<HTMLTextAreaElement>('chat-input').value = transcript;
      if (activeChat) notify(uiText('已识别，当前回复结束后可发送')); else void sendChat();
    },
    onError: (message, feature, explained) => {
      if (!explained) notify(message, true); // a recognition failure was already said in her words, in both windows
      const owner = feature === 'voiceInput' ? runtime.voiceOwner : runtime.cameraOwner;
      if (owner === windowKind) void window.desktop.setRuntimeState({ [feature]: false }).catch(() => {});
    },
    onStatus: message => text('chat-state', message),
    onVoiceStatus: message => {
      text(isPet ? 'pet-voice-state' : 'voice-input-state', message);
      $(isPet ? 'pet-voice-state' : 'voice-input-state')?.classList.toggle('hidden', !message);
    },
  });
  wirePushToTalk(window, () => mediaInput);
  window.desktop.onVoiceConversation(receiveVoiceConversation);
  window.desktop.onAudioReadingRefused(reason => { const action = readingRefusalAction(reason); if (action) notify(uiText(NOTICE_ACTIONS[action]), false, action); }); // why a listening/watching switch stayed off
  window.desktop.onVoiceReadingStop(mode => {
    voiceSpeechReady = null;
    // Microphone on mid-reading: this sentence plays out, the rest of the reply is not read; its bubbles still show.
    if (mode === 'sentence') replySpeechQueue.finishCurrent(ordinaryReplyPresentation?.id); else speech.stop();
  });
  ambientAudioController = new AudioReadingClient(isPet ? $('ambient-audio-controls') : null, {
    api: window.desktop, owner: windowKind, media: mediaInput, system: systemAudioInput,
    onMusicEnabled: enabled => { if (isPet) stage.setMusicEnabled(enabled); },
    onMusicSample: sample => { if (isPet) stage.setMusicSample(sample); },
    onDanceStatus: (active, status) => { if (isPet) petUI?.setAudioDanceState(active, status); },
    onError: message => notify(message, true),
    onExpanded: expanded => { if(isPet)petUI?.setSystemAudioExpanded(expanded); },
  });
  await ambientAudioController.init();
  const voiceStatus = $(isPet ? 'pet-voice-state' : 'voice-input-state');
  if (voiceStatus) {
    const output = document.createElement('small');
    output.style.flexBasis = '100%';
    $('voice-action-slot').append(output);
    voiceContinuationStatus = new VoiceContinuationStatus(output);
  }
  window.desktop.onRuntimeState(applyRuntime);
  applyRuntime(await window.desktop.getRuntimeState());
  window.desktop.onCharacterCards(applyCharacterCards);
  if (!isPet) {
    visualPreviewUnsubscribe=window.desktop.onVisualPreviewCancelled(value=>stage.cancelVisualPreview(value.id,value.token,false));
    bodyPreviewUnsubscribe=window.desktop.onBodyPreviewCancelled(value=>stage.cancelBodyPreview(value.id,value.token,false));
    surprisePreviewUnsubscribe=window.desktop.onSurprisePreviewCancelled(value=>stage.cancelSurprisePreview(value.id));
    characterControls = new CharacterCards($('character-cards'), { onError: message => notify(message, true), onState: applyCharacterCards, expressionSupport: recipe => stage.expressionSupport(recipe),
      onVisualPreview:async view=>{if(motionPreview&&motionPreview.state.phase!=='idle')throw Error(uiText('请先停止当前完整动作预览，再预览眉眼。'));return stage.previewVisual(view);},
      onExpressionPreview:async view=>{if(motionPreview&&motionPreview.state.phase!=='idle')throw Error(uiText('请先停止当前完整动作预览，再预览眉眼。'));return stage.previewVisual(view);},
      onBodyPreview:async view=>{if(motionPreview&&motionPreview.state.phase!=='idle')throw Error(uiText('请先停止当前完整动作预览，再预览姿势。'));return stage.previewBody(view);},
      onDelete: id => characterPage?.askDelete(id),
      onCreated: (card, how) => void characterPage?.discuss(card.id, how, [], card), // I-018: Claude talks a new card over (skippable)
    });
    await characterControls.init();
    characterPage = new CharacterPage($('character-page'), { api: window.desktop, onError: message => notify(message, true), onNotice: message => notify(message),
      onState: applyCharacterCards, onEdit: id => characterControls?.edit(id), onTune: id => characterControls?.edit(id, 'tune'), onBlank: () => characterControls?.newBlank(),
      capture: url => stage.captureCharacterAvatar(url), modelUrl: () => settings.model?.url ?? '' });
    await characterPage.init();
    $('goto-characters')?.addEventListener('click', () => controlNavigation?.navigate('characters'));
    const calibrationContainer = document.createElement('div'); $('character-cards').after(calibrationContainer);
    blushCalibrationControls = new BlushCalibrationControls(calibrationContainer, {
      onApply: async (modelKey, value) => { const url = settings.model?.url ?? ''; const view = await window.desktop.setBlushCalibration(modelKey, value); applyBlushCalibration(view, url); },
      onPreview: value => stage.previewBlush(value),
      onError: message => notify(message, true),
    });
    // I-024 这个模型能做什么: between the editor and the blush calibration; 试一下 plays on the pet.
    const capabilityContainer = document.createElement('div'); $('character-cards').after(capabilityContainer);
    modelCapabilityPanel = new ModelCapabilityPanel(capabilityContainer, { preview: id => window.desktop.previewModelCapability(id),
      setChoice: (modelKey, id, choice) => window.desktop.setModelCapabilityChoice(modelKey, id, choice), onError: message => notify(message, true) });
    if (modelCapabilitySync) modelCapabilityPanel.update(modelCapabilitySync.state);
  }
  blushCalibrationUnsubscribe = window.desktop.onBlushCalibration(view => {
    if ((settings.model?.url ?? '') === blushCalibrationUrl && view.modelKey === blushCalibrationView?.modelKey) applyBlushCalibration(view);
    else void refreshBlushCalibration();
  });
  await refreshBlushCalibration();
  applyCharacterCards(await window.desktop.getCharacterCards());
  chatChannel.onmessage = event => receiveChat(event.data);
  chatChannel.postMessage({ type: 'request-state', context: chatContext() });
  pointerTimer = setInterval(() => {
    if (!settings.pet.followMouse || !hostVisible || document.hidden) return;
    void window.desktop
      .pointer()
      .then((pointer) => stage.setPointer(pointer))
      .catch(() => {});
  }, 100);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (isPet) void ambientAudioController?.stop().catch(() => {});
      hideWaitingPresentation();
      moodCompanion?.reset('document-hidden');
      stopMotionPreview();
      if(!isPet)void window.desktop.cancelCharacterSticker().catch(()=>undefined);
      captureController?.abort();
      attachments = [];
      if (!isPet) renderAttachments();
    } else if (hostVisible && replyPresentation.canPresent(activeChat)) petUI?.refreshAnswerReader(reply, !!activeChat);
  });
  window.addEventListener("beforeunload", () => {
    characterStickerControls?.dispose();
    if(!isPet)void window.desktop.cancelCharacterSticker().catch(()=>undefined);
    visualPreviewUnsubscribe?.();visualPreviewUnsubscribe=null;
    bodyPreviewUnsubscribe?.();bodyPreviewUnsubscribe=null;
    surprisePreviewUnsubscribe?.();surprisePreviewUnsubscribe=null;
    textMemorialOffer?.dispose(); textMemorialOffer = null;
    r20ProactiveOfferUI?.dispose(); r20ProactiveOfferUI = null;
    textMemorialDeliveredUnsubscribe?.(); textMemorialDeliveredUnsubscribe = null;
    replyPresentation.clear();
    if (assistantNode) renderReplyWaiting(assistantNode, false);
    if(pointerTimer)clearInterval(pointerTimer);
    immersiveNotice?.dispose();
    $('notice-details')?.removeEventListener('click', closeProfileForNotice);
    userProfilePanel?.dispose(); userProfilePanel = null;
    clearTimeout(saveTimer);
    captureController?.abort();
    releaseReplySpeech?.();
    speech.stop();
    speech.dispose();
    emotionalVoiceControls?.dispose();
    speechChannel.close();
    chatChannel.close();
    mediaInput?.dispose();
    ambientAudioController?.dispose(); ambientTranscriptHistory?.dispose();
    screenSharingOptions?.dispose();
    lookButton?.dispose(); lookButton = null;
    systemAudioInput?.dispose();
    motionLibraryControls?.dispose();
    motionPreview?.dispose();
    characterControls?.dispose();
    characterPage?.dispose();
    modelCapabilityPanel?.dispose(); modelCapabilityPanel = null;
    modelCapabilitySync?.dispose();
    blushCalibrationControls?.dispose();
    blushCalibrationUnsubscribe?.();
    codexTasks?.dispose();
    controlNavigation?.dispose();
    taskProposalUnsubscribe?.();
    modelPhysicsUnsubscribe?.();
    musicSettingsUnsubscribe?.();
    petTaskOfferCleanup?.();
    petUI?.dispose();
    moodCompanion?.dispose();
    memoryPanel?.dispose();
    stage.dispose();
  });
}

function applyCharacterCards(next: CharacterCardState): void {
  if (characterState && (next.revision ?? 0) < (characterState.revision ?? 0)) return;
  const previousActiveId = characterState?.activeId ?? null;
  if (previousActiveId !== next.activeId) petFramingController?.invalidate();
  const current = characterState?.cards.find(card => card.id === characterState!.activeId);
  const selected = next.cards.find(card => card.id === next.activeId);
  const signature = (card: typeof selected) => card ? [card.id, card.name, card.greeting, compileCharacterPersona(card)].join('\0') : '';
  const changed = !!characterState && signature(current) !== signature(selected);
  characterState = next;
  characterName = selected?.name ?? uiText('桌面伙伴');
  characterControls?.applyState(next);
  characterPage?.applyCardState(next);
  emotionalVoiceControls?.refresh();
  feedCuePrefetch.voiceContextChanged();
  $('pet-answer')?.setAttribute('aria-label', uiTemplate`${characterName}的回答`);
  if (changed || previousActiveId !== next.activeId) moodCompanion?.reset('character');
  if (changed) {
    ambientTranscriptHistory?.reset(); void ambientTranscriptHistory?.refresh();
    memoryPanel?.reset();
    // C2/C3 (pretrial fixes 2026-11-03): updated in place or switched to her, the window shows her current conversation
    // (the host's chat memory); only a character with none starts with her greeting.
    clearChat(false);
    refillChat(true);
  } else if (!history.length && !activeChat && selected?.greeting && !current) {
    showCharacterGreeting(false);
  }
  if (next.notice) notify(next.notice, true);
  else if (next.hint && !isPet) showCharacterHint(next.hint); // C1: which card the model went with
}
let lastCharacterHint = { text: '', at: 0 };
/** C1: a short toast (ordinary notices are quiet, guidance is not), and the full line beside the model and on the character page. */
function showCharacterHint(hint: string): void {
  const now = Date.now();
  if (hint === lastCharacterHint.text && now - lastCharacterHint.at < 3000) return; // The broadcast and the returned state carry the same line.
  lastCharacterHint = { text: hint, at: now };
  // The toast holds 160 characters: the whole line when it fits, else its first sentence (the full line stays inline).
  const first = hint.split(/(?<=[。！？.!?])\s*/u)[0] || hint, toast = hint.length <= 160 ? hint : first;
  immersiveNotice?.publishAction(toast.length <= 160 ? toast : `${toast.slice(0, 158)}…`);
  const line = $('model-character-hint');
  if (line) { line.textContent = hint; line.hidden = false; }
  characterPage?.showHint(hint);
}
function chatContext(): string { return `${characterState?.revision ?? 0}:${characterState?.activeId ?? ''}`; }
function replySpeechContext(): string {
  return JSON.stringify([characterState?.activeId ?? '', settings.model?.url ?? '', settings.provider.kind, settings.provider.baseUrl, settings.provider.model]);
}
function showCharacterGreeting(remember: boolean): void {
  const greeting = characterState?.cards.find(card => card.id === characterState!.activeId)?.greeting.trim();
  if (!greeting) return;
  addMessage('assistant', greeting);
  if (remember) history = [{ role: 'assistant', content: greeting }];
}

function updateSummary(): void {
  if (isPet) {
    $("pet-empty").classList.toggle("hidden", !!settings.model);
    petUI?.applySettings(settings);
    return;
  }
  text("model-name", settings.model?.name ?? uiText("尚未载入模型"));
  text(
    "footer-model",
    settings.model ? uiTemplate`${settings.model.name} · 本地模型` : uiText("等待载入 MMD 模型"),
  );
  text(
    "model-path",
    settings.model?.path ?? uiText("选择 .pmx 或 .pmd，并保留原贴图目录"),
  );
  const preview = motionPreview?.state;
  text("motion-name", preview && preview.phase !== 'idle'
    ? uiTemplate`预览：${preview.name ?? uiText('动作')}`
    : settings.motion?.name ?? uiText("未载入 · 使用平滑呼吸待机"));
  motionLibraryControls?.refresh();
  text("fps-label", `${settings.pet.fps} FPS`);
  $("preview-empty").classList.toggle("hidden", !!settings.model);
  text("provider-badge", `Claude · ${settings.provider.model || uiText("默认模型")}`);
}
function syncCameraMode(): void {
  const button = $<HTMLButtonElement>('camera-edit');
  button?.setAttribute('aria-pressed', String(cameraEditing));
  if (button) button.innerHTML = `${icon('sliders')}<span>${cameraEditing ? uiText('完成调整') : uiText('调整模式')}</span>`;
  $('preview-camera-help')?.classList.toggle('hidden', !cameraEditing);
  document.querySelector('.preview-card')?.classList.toggle('camera-editing', cameraEditing);
  text('preview-camera-hint', cameraEditing ? uiText('调整后自动保存 · Esc 完成') : uiText('点击「调整模式」控制镜头 · 构图同步至桌宠'));
}
/** A refused camera request says why, in the window where it was clicked (2026-11-03: the pet button looked dead). */
function explainRuntimeReply(reply: RuntimeState): void { const action = cameraRefusalAction(reply) ?? voiceRefusalAction(reply); if (action) notify(uiText(NOTICE_ACTIONS[action]), false, action); }
/** 识别方式: the local recognizer's panel or the compatible address fields (control window). */
function syncAsrEngine(): void {
  const local = settings.voiceInput?.engine !== 'compatible', localFields = $('asr-local-fields'), compatibleFields = $('asr-compatible-fields');
  if (localFields) localFields.hidden = !local;
  if (compatibleFields) compatibleFields.hidden = local;
}
/** 和她一起看 (the pet toolbar): one click opens both 「和她一起听」 and screen sharing, or closes both when both are on. */
async function toggleWatchTogether(): Promise<void> {
  const listening = ambientAudioController?.listening ?? false, target = !(runtime.screenSharing && listening);
  try {
    if (runtime.screenSharing !== target) explainRuntimeReply(await window.desktop.setRuntimeState({ screenSharing: target }));
    if (listening !== target) await ambientAudioController?.setListenTogether(target);
  } catch (error) { notify(String(error), true); }
}
async function toggleRuntime(feature: keyof RuntimePatch): Promise<void> {
  try { explainRuntimeReply(await window.desktop.setRuntimeState({ [feature]: !runtime[feature] })); }
  catch (error) { notify(String(error), true); }
}
function applyRuntime(next: RuntimeState): void {
  const visionRevoked = (runtime.screenSharing && !next.screenSharing) || (runtime.cameraImages === true && next.cameraImages !== true);
  runtime = next;
  screenSharingOptions?.update({ ...visionRuntime, ...next });
  lookButton?.update(next);
  petUI?.applyRuntime(next);
  void mediaInput?.applyRuntime(next);
  if (visionRevoked) clearChat(true, false, true); // sharing off: the draft's hand-attached snapshots stay (Codex T-205 round 4)
  if (isPet) return;
  for (const [id, feature] of [['runtime-voice','voiceInput'],['runtime-screen','screenSharing'],['runtime-camera','cameraLocal'],['runtime-camera-images','cameraImages']] as const) {
    const input = $<HTMLInputElement>(id); if (input) input.checked = next[feature] === true;
  }
  const active = [next.voiceInput ? uiText('语音输入') : '', next.screenSharing ? uiText('屏幕共享') : '', next.cameraSharing ? uiText(next.cameraImages ? (next.cameraLocal ? '摄像头发图片 + 姿势识别' : '摄像头发图片') : '摄像头感知') : ''].filter(Boolean);
  text('privacy-indicator', active.length ? uiTemplate`${active.join(' · ')}已开启` : uiText('输入与共享已关闭'));
  text('privacy-state', next.screenSharing ? uiText('屏幕共享已开启 · 平时只知道你大概在做什么，叫她看才看清楚') : next.cameraImages ? uiText('摄像头发图片已开启 · 你发消息时附一张小图，叫她看时发清楚的一张') : next.cameraSharing ? uiText('摄像头感知开启中 · 画面只在本机处理，不保存、不上传') : uiText('屏幕与摄像头：共享关闭'));
}
function applyVisionRuntime(state: VisionRuntimeState): void {
  visionRuntime = state;
  screenSharingOptions?.update({ ...state, ...runtime });
  text('vision-runtime-status', state.status);
}
function rememberInitiative(message: VisionInitiative): void {
  if (shownInitiatives.has(message.id)) return;
  shownInitiatives.add(message.id);
  if (shownInitiatives.size > 128) shownInitiatives.delete(shownInitiatives.values().next().value!);
  history.push({ role: 'assistant', content: `[角色主动观察：${message.origin.labels.join('、')}] ${message.text}`, origin: message.origin });
  history = trimReplyHistory(history);
}
function retractInitiative(id: string): void {
  if (provisionalInitiative?.id !== id) return;
  initiativeGeneration++;
  if (isPet) petUI?.hideAnswer(); else provisionalInitiative.body.parentElement?.remove();
  provisionalInitiative = null;
}
function syncCamera(): void {
  for (const key of [
    "yaw",
    "pitch",
    "distance",
    "fov",
    "targetX",
    "targetY",
  ] as const) {
    const input = $<HTMLInputElement>(`camera-${key}`);
    if (input && document.activeElement !== input)
      input.value = String(Number(settings.camera[key].toFixed(2)));
  }
}
function syncForm(): void {
  syncCamera();
  const values: Record<string, string | number> = {
    "provider-model": settings.provider.model,
    "pet-fps": settings.pet.fps,
    breath: settings.pet.breath,
    "voice-rate": settings.voice.rate,
    "voice-volume": settings.voice.volume,
    "voice-mood": settings.voice.moodInfluence ?? DEFAULT_SETTINGS.voice.moodInfluence!,
    "voice-first-chunk": settings.voice.firstChunk === 'comma' ? 'comma' : 'sentence',
    "proactive-talk": settings.proactiveTalk === 'less' || settings.proactiveTalk === 'more' ? settings.proactiveTalk : 'normal',
    'asr-url': settings.voiceInput?.baseUrl ?? DEFAULT_SETTINGS.voiceInput!.baseUrl,
    'asr-model': settings.voiceInput?.model ?? DEFAULT_SETTINGS.voiceInput!.model,
    'asr-language': settings.voiceInput?.language ?? 'zh',
    'asr-key': settings.voiceInput?.apiKey ?? '',
    'asr-engine': settings.voiceInput?.engine === 'compatible' ? 'compatible' : 'local',
  };
  syncAsrEngine();
  for (const [id, value] of Object.entries(values)) {
    const input = $<HTMLInputElement>(id);
    if (document.activeElement !== input) input.value = String(value);
    if ($(`${id}-value`)) text(`${id}-value`, String(value));
  }
  const toggles: Record<string, boolean> = {
    "follow-mouse": settings.pet.followMouse,
    "voice-enabled": settings.voice.enabled,
    "voice-pause-talk": settings.voice.pauseTalk === true,
    "always-on-top": settings.pet.alwaysOnTop,
    "click-through": settings.pet.clickThrough,
  };
  for (const [id, value] of Object.entries(toggles))
    $<HTMLInputElement>(id).checked = value;
  populateVoices();
  $('system-voice-options').classList.toggle('hidden', currentTtsConfig().provider !== 'system');
  emotionalVoiceControls?.refresh();
  codexTasks?.syncSettings();
  updateSummary();
}
function openCodexTaskPanel(): void {
  controlNavigation?.navigate('agent');
}
function showControlLocation(location: ControlNavigationLocation, previous: ControlNavigationLocation | null): void {
  const panel = $(`tab-${location.page}`);
  const changedPage = previous?.page !== location.page;
  if (changedPage) {
    document.querySelectorAll('.tab-panel').forEach(item => item.classList.toggle('active', item === panel));
    text('page-title', uiText(CONTROL_PAGE_TITLES[location.page]));
    if (location.page === 'agent') void codexTasks?.init();
    if (location.page === 'memory') void memoryPanel?.refresh();
    if (location.page === 'characters') void characterPage?.refresh();
    if (location.page !== 'characters') stage.clearBlushPreview(); // C2: the blush calibration moved with the character cards
    if (location.page !== 'appearance') {
      stopMotionPreview();
      if (cameraEditing) stage.setCameraEditMode(false);
    }
  }
  let target = document.getElementById(location.target);
  if (!target || (!panel.contains(target) && location.target !== 'frame-full')) return;
  // Navigation reveals existing controls; it never invokes their actions.
  for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    if (ancestor === panel) break;
  }
  const requestedTarget = target;
  while (target !== panel && target.getClientRects().length === 0 && target.parentElement)
    target = target.parentElement;
  if (target !== requestedTarget) notify(uiText('当前配置未显示此项，已定位到所属设置。'));
  if (!target.matches('button, input, select, textarea, a[href], [tabindex]')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function populateVoices(): void {
  const select = $<HTMLSelectElement>("voice-select");
  if (!select) return;
  select.replaceChildren(new Option(uiText("系统默认中文声音"), ""));
  for (const voice of speech.voices())
    select.add(new Option(`${voice.name} · ${voice.lang}`, voice.voiceURI));
  select.value = settings.voice.voiceURI;
}
function bindControls(): void {
  // E1: the preview card's buttons play the model-agnostic 惊喜 / 害羞 on every window (the pet first of all); missing parts are skipped.
  bindPreviewCardButtons({ button: id => $(id), support: recipe => stage.expressionSupport(recipe), play: recipe => window.desktop.playExpressionPreview(recipe),
    status: line => text('surprise-preview-status', line), error: message => notify(message, true) });
  $('surprise-stop').onclick=()=>{void motionPreview?.stop().catch(error=>notify(String(error),true));};
  bindModelPhysicsControls();
  bindMusicSettingsControls();
  $('show-pet').onclick = () => { requestPetVisibility(true); };
  $('recover-pet').onclick = () => void (async () => {
    const button = $<HTMLButtonElement>('recover-pet');
    button.disabled = true;
    const label = button.querySelector('span');
    if (label) label.textContent = uiText('正在恢复…');
    recoveringPetView = true;
    try {
      await motionPreview?.stop();
      clearTimeout(saveTimer);
      stage.setCameraEditMode(false);
      await saveQueue;
      const sent = structuredClone(settings);
      const accepted = await window.desktop.recoverPet();
      settings = mergeSettings(sent, settings, accepted);
      hostSettings = structuredClone(accepted);
      projectPetVisibility();
      applyStage();
      syncForm();
      updateSummary();
      notify(accepted.model ? uiText('桌宠已恢复到显示器中央，正在自动取景') : uiText('桌宠窗口已恢复，请先载入 MMD 模型'));
    } catch (error) { notify(String(error), true); }
    finally {
      recoveringPetView = false;
      button.disabled = false;
      if (label) label.textContent = uiText('一键恢复桌宠');
    }
  })();
  controlNavigation = new ControlNavigation($('control-navigation'), { onNavigate: showControlLocation });
  const importModel = async () => {
    try {
      await motionPreview?.stop();
      const asset = await window.desktop.selectAsset("model");
      if (asset) {
        settings.model = asset;
        settings.motion = null;
        delete settings.motionLayers;
        await stage.applySettings(settings);
        updateSummary();
        stage.frame("portrait");
        notify(uiText("模型已载入，贴图从原目录读取"));
      }
    } catch (error) {
      notify(String(error), true);
    }
  };
  $("empty-import").onclick = $("import-model").onclick = () =>
    void importModel();
  $("use-bundled-model").onclick = () => void (async () => {
    const button = $<HTMLButtonElement>("use-bundled-model");
    button.disabled = true;
    try {
      await motionPreview?.stop();
      if (!(await save())) return;
      const accepted = await window.desktop.useBundledModel();
      settings = mergeSettings(hostSettings, settings, accepted);
      projectPetVisibility();
      hostSettings = accepted;
      await stage.applySettings(settings);
      updateSummary();
      notify(uiText("已启用预装 Gene 与 Stand 动作"));
    } catch (error) {
      notify(String(error), true);
    } finally {
      button.disabled = false;
    }
  })();
  $("import-motion").onclick = () => void (async () => {
    try {
      await motionPreview?.stop();
      if (!(await save())) return;
      const asset = await window.desktop.selectAsset("motion", motionLibraryControls?.selectedLayer ?? 'pose');
      if (asset) {
        const accepted = await window.desktop.getSettings();
        settings = mergeSettings(hostSettings, settings, accepted);
        projectPetVisibility();
        hostSettings = accepted;
        applyStage();
        updateSummary();
      }
    } catch (error) { notify(String(error), true); }
  })();
  $("clear-motion").onclick = () => void (async () => {
    try {
      await motionPreview?.stop();
      if (!(await save())) return;
      const accepted = await window.desktop.clearMotionLayer(motionLibraryControls?.selectedLayer ?? 'pose');
      settings = mergeSettings(hostSettings, settings, accepted);
      projectPetVisibility();
      hostSettings = accepted;
      applyStage();
      updateSummary();
    } catch (error) { notify(String(error), true); }
  })();
  $("frame-portrait").onclick = () => stage.frame("portrait");
  $("frame-full").onclick = () => stage.frame("full");
  $('camera-edit').setAttribute('aria-pressed', 'false');
  $('camera-edit').onclick = () => stage.setCameraEditMode(!cameraEditing);
  for (const [id, feature] of [['runtime-voice','voiceInput'],['runtime-screen','screenSharing'],['runtime-camera','cameraLocal'],['runtime-camera-images','cameraImages']] as const)
    $<HTMLInputElement>(id).onchange = event => void window.desktop.setRuntimeState({ [feature]: (event.target as HTMLInputElement).checked })
      // A refused switch flips back (no state change is broadcast for it) and says why.
      .then(reply => { (event.target as HTMLInputElement).checked = reply[feature] === true; explainRuntimeReply(reply); }, error => notify(String(error), true));
  $<HTMLSelectElement>('asr-engine').onchange = event => {
    settings.voiceInput ??= structuredClone(DEFAULT_SETTINGS.voiceInput!);
    settings.voiceInput.engine = (event.target as HTMLSelectElement).value === 'compatible' ? 'compatible' : 'local';
    syncAsrEngine();
    if (runtime.voiceInput) void window.desktop.setRuntimeState({ voiceInput: false });
    void save();
  };
  for (const [id, key] of [['asr-url','baseUrl'],['asr-model','model'],['asr-language','language'],['asr-key','apiKey']] as const)
    $<HTMLInputElement>(id).onchange = event => {
      settings.voiceInput ??= structuredClone(DEFAULT_SETTINGS.voiceInput!);
      const value = (event.target as HTMLInputElement).value.trim();
      if (key === 'baseUrl' && settings.voiceInput.baseUrl !== value) settings.voiceInput.apiKey = '';
      settings.voiceInput[key] = value;
      if (runtime.voiceInput) void window.desktop.setRuntimeState({ voiceInput: false });
      void save();
    };
  for (const key of [
    "yaw",
    "pitch",
    "distance",
    "fov",
    "targetX",
    "targetY",
  ] as const)
    $<HTMLInputElement>(`camera-${key}`).onchange = (event) => {
      const input = event.target as HTMLInputElement;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || !input.checkValidity()) {
        syncCamera();
        return;
      }
      settings.camera[key] = value;
      applyStage();
      queueSave();
    };
  const toggles: Record<string, (value: boolean) => void> = {
    "follow-mouse": (v) => (settings.pet.followMouse = v),
    "voice-enabled": (v) => {
      settings.voice.enabled = v;
      if (!v) speech.stop();
    },
    "voice-pause-talk": (v) => (settings.voice.pauseTalk = v), // F7 停停说说: from the next message
    "click-through": (v) => (settings.pet.clickThrough = v),
  };
  for (const [id, update] of Object.entries(toggles))
    $<HTMLInputElement>(id).onchange = (e) => {
      update((e.target as HTMLInputElement).checked);
      applyStage();
      void save();
    };
  $<HTMLInputElement>('always-on-top').onchange = event => {
    const input = event.target as HTMLInputElement;
    const desired = input.checked;
    input.checked = settings.pet.alwaysOnTop;
    void requestAlwaysOnTop(desired);
  };
  $<HTMLInputElement>('pet-visible').onchange = event => {
    requestPetVisibility((event.target as HTMLInputElement).checked);
  };
  for (const [id, update] of Object.entries({
    breath: (v: number) => (settings.pet.breath = v),
    "voice-rate": (v: number) => (settings.voice.rate = v),
    "voice-volume": (v: number) => (settings.voice.volume = v),
    "voice-mood": (v: number) => (settings.voice.moodInfluence = v),
  }))
    $<HTMLInputElement>(id).oninput = (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      update(value);
      text(`${id}-value`, String(value));
      applyStage();
      queueSave();
    };
  $<HTMLSelectElement>("pet-fps").onchange = (e) => {
    settings.pet.fps = Number((e.target as HTMLSelectElement).value);
    applyStage();
    void save();
  };
  $<HTMLInputElement>("provider-model").onchange = (e) => {
    settings.provider.model = (e.target as HTMLInputElement).value.trim();
    clearChat();
    void save();
  };
  $<HTMLSelectElement>("voice-select").onchange = (e) => {
    settings.voice.voiceURI = (e.target as HTMLSelectElement).value;
    void save();
  };
  // I-029: where reading aloud starts; the host freezes it per reply, so it applies from the next reply.
  $<HTMLSelectElement>("voice-first-chunk").onchange = (e) => {
    settings.voice.firstChunk = (e.target as HTMLSelectElement).value === 'comma' ? 'comma' : 'sentence';
    void save();
  };
  // 她主动找你说话: the host reads it from the saved settings on its next opportunity.
  $<HTMLSelectElement>("proactive-talk").onchange = (e) => {
    const value = (e.target as HTMLSelectElement).value;
    settings.proactiveTalk = value === 'less' || value === 'more' ? value : 'normal';
    void save();
  };
  speechSynthesis.onvoiceschanged = populateVoices;
  $("test-voice").onclick = () => void (currentTtsConfig().provider === 'system'
    ? speech.preview('你好，我会在这里，陪你度过平常的一天。')
    : speech.previewCharacter('你好，我会在这里，陪你度过平常的一天。', () => window.desktop.prepareCharacterSpeechPreview()))
    .catch(error => notify(String(error), true));
  $<HTMLFormElement>("chat-form").onsubmit = (e) => {
    e.preventDefault();
    void sendChat();
  };
  $<HTMLTextAreaElement>("chat-input").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendChat();
    }
  };
  $("new-chat").onclick = () => {
    clearChat(true, true);
    void window.desktop.newConversation().catch(error => notify(String(error), true));
  };
  $("stop-chat").onclick = () => void stopChat();
  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach(
    (button) =>
      (button.onclick = () => {
        $<HTMLTextAreaElement>("chat-input").value =
          button.dataset.prompt ?? "";
        void sendChat();
      }),
  );
  $("attach-screen").onclick = () => void chooseScreen();
  $("close-screen").onclick = () => {
    captureController?.abort();
    $<HTMLDialogElement>("screen-dialog").close();
  };
  $("attach-camera").onclick = async () => {
    if (attachments.length >= 2) return notify(uiText("每次最多附带两张快照"));
    const button = $<HTMLButtonElement>("attach-camera");
    button.disabled = true;
    captureController?.abort();
    const controller = new AbortController();
    captureController = controller;
    try {
      const shot = await cameraSnapshot(controller.signal);
      if (!controller.signal.aborted) {
        attachments.push(shot);
        renderAttachments();
        notify(uiText("已拍摄，摄像头已释放。发送后才交给模型。"));
      }
    } catch (error) {
      notify(String(error), true);
    } finally {
      button.disabled = false;
    }
  };
  $("reset-settings").onclick = () =>
    $<HTMLDialogElement>("reset-dialog").showModal();
  $("cancel-reset").onclick = () =>
    $<HTMLDialogElement>("reset-dialog").close();
  $("confirm-reset").onclick = async () => {
    try {
      await stopChat();
      await codexTasks?.interruptActive();
      captureController?.abort();
      clearTimeout(saveTimer);
      await saveQueue;
      settings = await window.desktop.resetSettings();
      hostSettings = structuredClone(settings);
      syncForm();
      applyStage();
      clearChat();
      $<HTMLDialogElement>("reset-dialog").close();
      notify(uiText("已重置应用设置"));
    } catch (error) {
      notify(String(error), true);
    }
  };
  $("quit-app").onclick = () => void window.desktop.quit();
}
function renderAttachments(): void {
  const element = $("attachments");
  element.replaceChildren();
  attachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment";
    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt =
      attachment.source === "screen"
        ? uiText("待发送的屏幕快照")
        : uiText("待发送的摄像头照片");
    const label = document.createElement("span");
    label.textContent =
      attachment.source === "screen" ? uiText("屏幕快照") : uiText("摄像头照片");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", uiText("移除快照"));
    remove.onclick = () => {
      attachments.splice(index, 1);
      renderAttachments();
    };
    chip.append(image, label, remove);
    element.append(chip);
  });
}
async function chooseScreen(): Promise<void> {
  if (attachments.length >= 2) return notify(uiText("每次最多附带两张快照"));
  const dialog = $<HTMLDialogElement>("screen-dialog");
  const list = $("screen-sources");
  list.textContent = uiText("正在读取可选屏幕…");
  dialog.showModal();
  captureController?.abort();
  const controller = new AbortController();
  captureController = controller;
  try {
    const sources = await window.desktop.screenSources();
    if (controller.signal.aborted) return;
    list.replaceChildren();
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "screen-source";
      const image = document.createElement("img");
      image.src = source.thumbnail;
      image.alt = "";
      const label = document.createElement("span");
      label.textContent = source.name;
      button.append(image, label);
      button.onclick = async () => {
        try {
          const shot = await window.desktop.captureScreen(source.id);
          if (controller.signal.aborted) return;
          attachments.push(shot);
          renderAttachments();
          dialog.close();
        } catch (error) {
          notify(String(error), true);
        }
      };
      list.append(button);
    }
  } catch (error) {
    list.textContent = String(error);
  }
}
function addMessage(role: "user" | "assistant", content: string): HTMLElement {
  if (isPet) return role === 'assistant' ? petUI!.showAnswer(content) : document.createElement('div');
  const messages = $("messages");
  messages.querySelector(".welcome")?.remove();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? uiText("你") : characterName;
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = role === 'assistant' ? formatReplySegments(content) : content;
  row.append(label, body);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return body;
}
function rememberAmbientComment(comment: AmbientComment): void {
  if (ambientDisplayedComments.has(comment.id)) return;
  ambientDisplayedComments.add(comment.id);
  if (ambientDisplayedComments.size > 128) ambientDisplayedComments.delete(ambientDisplayedComments.values().next().value!);
  history.push({ role: 'assistant', content: ambientCommentHistoryText(comment.text) }); history = trimReplyHistory(history);
  if (!isPet) {
    const body = addMessage('assistant', comment.text);
    const label = body.parentElement?.querySelector('.message-label');
    if (label) label.textContent = uiTemplate`${characterName} · 一起听到的声音`;
  }
}
async function presentAmbientComment(offer: { id: string; sessionId: string; text: string }): Promise<void> {
  if (!isPet || !ambientAudioController?.active || ambientAudioController.sessionId !== offer.sessionId
    || activeChat || !hostVisible || document.hidden || composing || cameraEditing || petUI?.windowInteractionBlocked || $('chat-input').textContent?.trim()
    || ($('chat-input') as HTMLTextAreaElement).value.trim() || ambientDisplayedComments.has(offer.id) || ambientOfferedComments.has(offer.id)) return;
  ambientOfferedComments.add(offer.id);
  const body = petUI!.showAnswer(offer.text, true, offer.id);
  try {
    const accepted = await window.desktop.acknowledgeAmbientComment(offer.id);
    if (!accepted || activeChat || ambientAudioController.sessionId !== offer.sessionId || body.textContent !== offer.text) {
      petUI?.hideAnswerFor(offer.id);
      return;
    }
    rememberAmbientComment(accepted.comment);
    const expectsSpeech = settings.voice.enabled;
    petUI?.finishAnswer(offer.text, offer.id, expectsSpeech, true);
    if (expectsSpeech) {
      await speech.speak(offer.text, settings.voice, accepted.context).catch(() => {});
      petUI?.endAnswerSpeech(offer.id);
    }
  } catch (error) {
    petUI?.hideAnswerFor(offer.id);
    notify(String(error), true);
  } finally { ambientOfferedComments.delete(offer.id); }
}
function setChatBusy(busy: boolean): void {
  $<HTMLButtonElement>("send-chat").disabled = busy;
  $("send-chat").classList.toggle("hidden", busy);
  $("stop-chat").classList.toggle("hidden", !busy);
  text("chat-state", busy ? uiText("正在回复…") : uiText("Enter 发送 · Shift + Enter 换行"));
}
async function sendChat(bypassSuggestion = false, look = false): Promise<void> {
  if (activeChat || pendingReadoutControl) return;
  const sentAt = Date.now(); // Developer latency timing only (electron/reply-latency.ts).
  const input = $<HTMLTextAreaElement>("chat-input");
  const content = input.value.trim();
  if (!content && !attachments.length) return;
  if (!attachments.length && (scanStopReadoutRequest(content) !== 'none' || scanFramingRequest(content) !== 'none' || scanBreathRequest(content).kind !== 'none')) {
    const id = crypto.randomUUID(); pendingReadoutControl = id;
    // The hint only avoids broad optimistic cleanup. Host reclassifies the
    // literal source; no action, target ID or authorization leaves this renderer.
    try {
      await window.desktop.chat({ id, messages: outgoingChatMessages(history, { role: 'user', content }), attachments: [] });
      if (input.value.trim() === content) input.value = '';
    } catch (error) { if (pendingReadoutControl === id) pendingReadoutControl = null; notify(String(error), true); }
    return;
  }
  // D2 developer test command ("测试：…"): asked only in developer mode, and the host decides whether it was one. A "no" (mode off,
  // not a command) falls through as ordinary chat, unchanged. A command is not chat: no history, no archive, no reply, no readout.
  if (asksTestCommand(immersiveDeveloperMode, attachments.length > 0, content)) {
    const guard = crypto.randomUUID(); pendingReadoutControl = guard;
    try {
      const outcome = await window.desktop.runTestCommand(content);
      if (outcome.handled) { testNotes?.begin(outcome.id, content); if (input.value.trim() === content) input.value = ''; return; }
    } catch (error) { notify(String(error), true); return; }
    finally { if (pendingReadoutControl === guard) pendingReadoutControl = null; }
  }
  await window.desktop.noteUserInput();
  // R20: an explicit file/code/command request is offered as a task; only the user's click starts one.
  if (claudeTasksOffered() && !bypassSuggestion && content) {
    const context = chatContext();
    const continueChat = () => {
      if (input.value.trim() !== content || chatContext() !== context) {
        notify(uiText('消息或角色已更改，请重新发送。')); return;
      }
      if (!isPet) controlNavigation?.navigate('chat');
      void sendChat(true);
    };
    if (!isPet && codexTasks?.offer(content, continueChat)) return;
    if (isPet) {
      petTaskOfferCleanup?.(); petTaskOfferCleanup = null;
      let container = $('pet-task-offer');
      if (!container) {
        container = document.createElement('div'); container.id = 'pet-task-offer';
        document.querySelector('.pet-chat')?.prepend(container);
      }
      petTaskOfferCleanup = mountCodexTaskOffer(container, content, {
        onTask: prompt => {
          petTaskOfferCleanup = null;
          if (input.value.trim() !== content || chatContext() !== context) { notify(uiText('消息或角色已更改，请重新发送。')); return; }
          void window.desktop.proposeCodexTask(prompt).then(() => {
            if (input.value.trim() === content && chatContext() === context) input.value = '';
          }).catch(error => notify(String(error), true));
        },
        onChat: () => { petTaskOfferCleanup = null; continueChat(); },
        onDismiss: () => { petTaskOfferCleanup = null; },
      });
      if (petTaskOfferCleanup) return;
    }
  }
  if (!history.length) {
    const greeting = characterState?.cards.find(card => card.id === characterState!.activeId)?.greeting.trim();
    if (greeting) history = [{ role: 'assistant', content: greeting }];
  }
  // F7 停停说说: with the switch on, the earlier reply stops where it is and how far it got goes with this message; off, nothing changes.
  const pauseCut = pauseCutForSend(settings.voice.pauseTalk === true, replyPresentation);
  const id = crypto.randomUUID();
  activeChat = id;
  syncBodyInputGate();
  reply = "";
  setChatBusy(true);
  speech.stop();
  speech.prewarm?.(); // R02: start the cloud audio device while the reply is generated.
  const user: ChatMessage = {
    role: "user",
    content: content || "请描述这张图片。",
  };
  activeUser = user;
  let shots = attachments;
  attachments = [];
  renderAttachments();
  input.value = "";
  assistantNode = null;
  const saved = await save();
  if (activeChat !== id) return;
  if (!saved) {
    onStream({
      id,
      kind: "chat",
      type: "error",
      text: uiText("配置未能保存，请修正设置后重试。"),
    });
    return;
  }
  try {
    // 识图第 1 步: the host attaches a frame only when this message asks her to look (or the button was pressed); the window decides nothing (src/look-send.ts).
    const shared = await window.desktop.sharedAttachments(lookHint(content, look));
    if (activeChat !== id) return;
    shots = turnAttachments(shots, shared);
    const profile = userProfilePanel?.messageExpectation();
    await window.desktop.chat({
      id,
      messages: outgoingChatMessages(history, user),
      attachments: shots,
      ...(profile ? { profile } : {}),
      ...(pauseCut ? { pauseCut } : {}),
      sentAt,
    });
  } catch (error) {
    onStream({ id, kind: "chat", type: "error", text: String(error) });
  }
}
async function stopChat(broadcast = true): Promise<void> {
  const id = activeChat;
  replyPresentation.cancelReadout();
  const mayPresent = hostVisible && !document.hidden && replyPresentation.canPresent(id);
  replyPresentation.close(id);
  if (id) history = voiceReplyIds.has(id)
    ? appendVoiceReply(history, reply)
    : appendReplyHistory(history, activeUser, reply);
  activeChat = null;
  syncBodyInputGate();
  activeUser = null;
  speech.stop();
  if ($('send-chat')) {
    setChatBusy(false);
    if (assistantNode) renderReplyWaiting(assistantNode, false);
    if (id && assistantNode) {
      assistantNode.textContent = reply.trim() ? uiTemplate`${formatReplySegments(reply)}\n\n[已停止]` : uiText("已停止");
      if (mayPresent) petUI?.finishAnswer(reply.trim() ? uiTemplate`${reply}\n\n[已停止]` : uiText('已停止'), id, false, false, true);
    }
  }
  if (id && broadcast) chatChannel.postMessage({ type: 'stop', id, context: chatContext() });
  if (id)
    await window.desktop
      .cancel(id)
      .catch((error) => notify(String(error), true));
}
let chatRefillGeneration = 0;
/**
 * C2/C3 (pretrial fixes 2026-11-03): after the window was cleared for a card change, fill it with her current conversation
 * from the host (electron/companion.ts recentChat). Only while nothing new happened in the window since (no message, no
 * reply, no other clear) and she is still the active character; her greeting only when she has no conversation.
 */
function refillChat(greeting: boolean): void {
  const generation = ++chatRefillGeneration, requestedFor = characterState?.activeId ?? null;
  const settle = (messages: ChatMessage[]) => {
    if (generation !== chatRefillGeneration || history.length || activeChat || (characterState?.activeId ?? null) !== requestedFor) return;
    if (!messages.length) { if (greeting) showCharacterGreeting(true); return; }
    history = messages;
    $('messages').replaceChildren();
    if (isPet) petUI?.refreshAnswerReader([...history].reverse().find(item => item.role === 'assistant')?.content ?? '', false);
    else for (const item of history) addMessage(item.role, item.content);
    text('chat-state', uiText('Enter 发送 · Shift + Enter 换行'));
  };
  const attempt = (left: number): void => {
    void window.desktop.getRecentChat().then(recent => settle(restoredChatHistory(recent, requestedFor, characterState?.activeId ?? null)), error => {
      if (generation !== chatRefillGeneration) return;
      if (left > 0 && isTransientSwitch(error)) setTimeout(() => attempt(left - 1), TRANSIENT_SWITCH_DELAY_MS);
      else settle([]);
    });
  };
  attempt(TRANSIENT_SWITCH_RETRIES);
}
function clearChat(broadcast = true, greeting = false, keepDraft = false): void {
  chatRefillGeneration++;
  textMemorialOffer?.invalidate(); activeMemorialSpeechId = null;
  clearCommandMessageRows();
  ordinaryReplyPresentation = null;
  for (const record of voiceDraftRecords.values()) record.root.remove();
  voiceDraftRecords.clear();
  voiceDraftInput.clear($<HTMLTextAreaElement>('chat-input'));
  voiceUiGroups.clear(); voiceReplyIds.clear(); voiceSpeechReady = null;
  voiceContinuationStatus?.clear();
  initiativeGeneration++; provisionalInitiative = null; activeVisionSpeechId = null;
  const cancelledId = activeChat;
  awaitingChatState = false;
  replyPresentation.clear();
  petTaskOfferCleanup?.(); petTaskOfferCleanup = null;
  codexTasks?.dismissOffer();
  void stopChat(false);
  if (!keepDraft) captureController?.abort();
  attachments = draftAfterClear(attachments, keepDraft);
  history = [];
  reply = "";
  assistantNode = null;
  petUI?.hideAnswer();
  renderAttachments();
  $("messages").replaceChildren();
  text("chat-state", uiText("新对话已开始"));
  if (greeting) showCharacterGreeting(true);
  if (broadcast) chatChannel.postMessage({ type: 'clear', greeting, cancelledId, context: chatContext(), ...(keepDraft ? { keepDraft: true as const } : {}) });
}
function renderReadout(id: string, prefix: string, full: string, sentenceEnds?: readonly number[]): void {
  if (!assistantNode || (isPet && (!hostVisible || document.hidden)) || (activeChat && activeChat !== id)) return;
  renderReplyWaiting(assistantNode, false);
  if (isPet) { petUI?.showAnswer(prefix, true, id, false, sentenceEnds); petUI?.refreshAnswerReader(full, true); }
  else assistantNode.textContent = formatReplySegments(prefix);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function beginChat(chat: ChatStarted, voice = false): void {
  textMemorialOffer?.invalidate();
  if (activeMemorialSpeechId) { activeMemorialSpeechId = null; speech.stop(); }
  clearCommandMessageRows(false);
  ordinaryReplyPresentation = null;
  voiceSpeechReady = null;
  initiativeGeneration++; provisionalInitiative = null; activeVisionSpeechId = null;
  if (!replyPresentation.begin(chat.id)) return;
  awaitingChatState = false;
  petTaskOfferCleanup?.(); petTaskOfferCleanup = null;
  codexTasks?.dismissOffer();
  activeChat = chat.id;
  syncBodyInputGate();
  chatOwner = chat.owner;
  activeUser = voice ? null : chat.messages.at(-1) ?? null;
  if (!voice) history = trimReplyHistory(chat.messages.slice(0, -1));
  reply = '';
  petUI?.beginAnswer(chat.id);
  speech.stop();
  if (activeUser) {
    const body = addMessage('user', activeUser.content);
    const root = isPet ? document.createElement('section') : body.parentElement!;
    if (isPet) {
      root.setAttribute('data-mood-ui', '');
      const literal = document.createElement('div');
      literal.className = 'message-body'; literal.textContent = activeUser.content.slice(0, 300);
      root.append(literal);
    }
    commandMessageRows.set(chat.id, { root, choices: null });
  }
  assistantNode = isPet ? petUI!.showWaiting(chat.id) : addMessage('assistant', '');
  renderReplyWaiting(assistantNode, true);
  replyPresentation.startReadout(chat.id, (prefix, full, ends) => renderReadout(chat.id, prefix, full, ends));
  if (!hostVisible || document.hidden) hideWaitingPresentation();
  setChatBusy(true);
}
function receiveVoiceConversation(event: VoiceConversationEvent): void {
  voiceContinuationStatus?.receive(event);
  const key = event.epoch + '\0' + ('groupId' in event ? event.groupId : '');
  if (event.type === 'row') {
    voiceSpeechReady = null;
    let group = voiceUiGroups.get(key);
    if (group && event.seq <= group.seq) return;
    if (!group) {
      const message: ChatMessage = { role: 'user', content: event.text };
      group = { epoch: event.epoch, seq: event.seq, message, node: addMessage('user', event.text) };
      voiceUiGroups.set(key, group); history = trimReplyHistory([...history, message]);
      if (voiceUiGroups.size > 128) voiceUiGroups.delete(voiceUiGroups.keys().next().value!);
    } else { group.seq = event.seq; group.message.content = event.text; group.node.textContent = event.text; }
    text('chat-state', event.seq === 1 ? uiText('这段话已收到，仍可继续说') : uiText('补充已收到，仍可继续说'));
    return;
  }
  if (event.type === 'start') {
    voiceSpeechReady = null;
    if (!voiceUiGroups.has(key)) return;
    voiceReplyIds.add(event.replyId); if (voiceReplyIds.size > 128) voiceReplyIds.delete(voiceReplyIds.values().next().value!);
    beginChat({ id: event.replyId, owner: event.owner, messages: [] }, true); return;
  }
  if (event.type === 'delta') { if (voiceReplyIds.has(event.replyId)) onStream({ id: event.replyId, kind: 'chat', type: 'delta', text: event.text }); return; }
  if (event.type === 'terminal') {
    voiceSpeechReady = event.complete && activeChat === event.replyId && hostVisible && !document.hidden
      && replyPresentation.canPresent(event.replyId) ? { replyId: event.replyId, epoch: event.epoch, presentationReady: false } : null;
    // R33: a reply stopped to merge the user's addition keeps what it showed (or disappears if it showed nothing); it is not a failure.
    const ended = event.complete || event.superseded;
    if (voiceReplyIds.has(event.replyId)) onStream({ id: event.replyId, kind: 'chat', type: ended ? 'done' : 'error', text: ended ? '' : uiText('本次续接未完成，已保留原文。') });
    return;
  }
  if (event.type === 'speech') {
    if (event.owner === windowKind && voiceUiGroups.has(key) && voiceReplyIds.has(event.replyId)
      && voiceSpeechReady?.replyId === event.replyId && voiceSpeechReady.epoch === event.epoch) {
      const ready = voiceSpeechReady;
      if (activeChat || !hostVisible || document.hidden || !settings.voice.enabled) { voiceSpeechReady = null; return; }
      // This completed event cannot replace an earlier paced prefix with the full
      // body. Retain it once until that same reply's existing readout drains.
      if (!ready.presentationReady) { ready.pendingSpeech ??= { ...event }; return; }
      voiceSpeechReady = null;
      petUI?.finishAnswer(event.text, event.replyId, true, false, true);
      void speech.speak(event.text, settings.voice, { replyId: event.replyId }).then(() => endReplySpeech(event.replyId), () => endReplySpeech(event.replyId));
    }
    return;
  }
  if (event.type === 'cancelled') {
    voiceSpeechReady = null;
    if (event.replyId && activeChat === event.replyId) onStream({ id: event.replyId, kind: 'chat', type: 'error', text: uiText('已停止。') });
    speech.stop(); return;
  }
  if (event.type === 'draft' && event.owner === windowKind) {
    const input = $<HTMLTextAreaElement>('chat-input');
    if (voiceDraftInput.place(input, key, event.text)) {
      notify(uiText('部分语音未完成处理，原文已保留在输入框。'), true);
    } else if (!isPet && event.groupId && voiceUiGroups.get(key)?.message.content === event.text) {
      const original = voiceUiGroups.get(key)!;
      const label = original.node.parentElement?.querySelector('.message-label');
      if (label) label.textContent = uiText('你 · 语音未完成处理');
      notify(uiText('输入框已有草稿；语音原文保留在本轮用户消息中。'), true);
    } else {
      // At most four accepted groups plus one rejected ASR final per capture.
      // Pending copies gate the next capture until explicitly handled.
      let record = voiceDraftRecords.get(key);
      if (!record && voiceDraftRecords.size < 5) {
        const root = document.createElement('details'); root.open = true;
        const title = document.createElement('summary'); title.textContent = uiText('未完成处理的语音原文');
        const text = document.createElement('textarea'); text.readOnly = true; text.rows = 3; text.setAttribute('aria-label', uiText('保留的语音原文'));
        const select = document.createElement('button'); select.type = 'button'; select.textContent = uiText('选中原文'); select.onclick = () => { text.focus(); text.select(); };
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = uiText('已处理，关闭');
        dismiss.onclick = () => { root.remove(); voiceDraftRecords.delete(key); };
        root.append(title, text, select, dismiss); input.after(root);
        record = { root, text }; voiceDraftRecords.set(key, record);
      }
      if (record) record.text.value = event.text;
      notify(uiText('输入框已有草稿；语音原文保留在聊天区的语音原文栏中。'), true);
    }
  } else if (event.type === 'unheard') {
    if (event.owner === windowKind) mediaInput?.noteUnheard(event.failure);
  } else if (event.type === 'fault') {
    // Recognition failed: every window says why, in her words (never a silent switch-off).
    const action = voiceFailureAction(event.failure);
    if (action) notify(uiText(NOTICE_ACTIONS[action]), false, action);
    if (event.owner === windowKind) mediaInput?.receiveVoiceFault(event, !!action);
  }
}
function hideWaitingPresentation(): void {
  if (isPet) replyPresentation.cancelReadout();
  voiceSpeechReady = null;
  const waiting = replyPresentation.isWaiting(activeChat);
  replyPresentation.suppressWaiting();
  if (waiting && assistantNode) renderReplyWaiting(assistantNode, false);
  petUI?.hideAnswer();
  // A pet-owned stream hidden before completion must not start late speech.
  // Hiding the controls window alone still permits its visible pet companion.
  if (isPet) { speech.stop(); releaseReplySpeech?.(); }
}
type ChatWire =
  | { type: 'request-state'; context: string }
  | { type: 'state'; context: string; history: ChatMessage[]; activeChat: string | null; activeUser: ChatMessage | null; reply: string; chatOwner: 'controls' | 'pet' | null }
  | { type: 'stop'; id: string; context: string }
  | { type: 'speech-ended'; id: string; context: string; replyContext?: string }
  | { type: 'clear'; greeting?: boolean; cancelledId?: string | null; context: string; keepDraft?: true };
function receiveChat(message: ChatWire): void {
  if (!message || typeof message !== 'object') return;
  // A global card revision can change while the active character keeps speaking.
  // Unique reply IDs already reject older playback after clear/new replies.
  if (message.type === 'speech-ended') {
    if (ordinaryReplyPresentation?.id === message.id && message.replyContext !== undefined
      && ordinaryReplyPresentation.context !== message.replyContext) return;
    if (typeof message.id === 'string' && message.id.length <= 128) finishReplySpeechPresentation(message.id, message.replyContext);
    return;
  }
  if (message.context !== chatContext()) return;
  if (message.type === 'request-state') {
    chatChannel.postMessage({ type: 'state', context: chatContext(), history, activeChat, activeUser, reply, chatOwner });
  } else if (message.type === 'state') {
    if (!awaitingChatState || history.length || activeChat) return;
    awaitingChatState = false;
    if (!message.history.length && !message.activeChat) return;
    history = trimReplyHistory(message.history);
    $('messages').replaceChildren();
    if (isPet) {
      // Restore old text to the manual reader without replaying a bubble
      // whose original completed speech identity belongs to another window.
      const lastAnswer = [...history].reverse().find(item => item.role === 'assistant');
      petUI?.refreshAnswerReader(lastAnswer?.content ?? '', false);
    } else for (const item of history) addMessage(item.role, item.content);
    if (message.activeChat && message.activeUser && replyPresentation.begin(message.activeChat, message.reply)) {
      const hydratedId = message.activeChat;
      activeChat = message.activeChat; activeUser = message.activeUser; reply = message.reply; chatOwner = message.chatOwner;
      syncBodyInputGate();
      addMessage('user', activeUser.content);
      petUI?.beginAnswer(message.activeChat);
      assistantNode = isPet ? petUI!.showWaiting(message.activeChat) : addMessage('assistant', '');
      renderReplyWaiting(assistantNode, replyPresentation.isWaiting(message.activeChat));
      replyPresentation.startReadout(hydratedId, (prefix, full, ends) => renderReadout(hydratedId, prefix, full, ends));
      if (!hostVisible || document.hidden) hideWaitingPresentation();
      if (reply.trim()) {
        replyPresentation.readoutContent(message.activeChat, reply);
        if (isPet && hostVisible && !document.hidden && replyPresentation.canPresent(message.activeChat)) petUI?.refreshAnswerReader(reply, true);
      }
      setChatBusy(true);
    }
  } else if (message.type === 'stop') {
    if (message.id === activeChat) void stopChat(false);
    else replyPresentation.close(message.id);
  }
  else if (message.type === 'clear') {
    if (typeof message.cancelledId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(message.cancelledId))
      replyPresentation.close(message.cancelledId);
    clearChat(false, message.greeting, message.keepDraft === true);
  }
}
function endReplySpeech(id: string, replyContext?: string): void {
  const current = !replyContext || ordinaryReplyPresentation?.id !== id || ordinaryReplyPresentation.context === replyContext;
  if (current) finishReplySpeechPresentation(id, replyContext);
  try { chatChannel.postMessage({ type: 'speech-ended', id, context: chatContext(), ...(replyContext ? { replyContext } : {}) }); }
  catch { /* Playback may finish while its window is unloading. */ }
}
function onStream(event: StreamEvent): void {
  if (receiveReadoutControl(event)) return;
  if (event.kind === "chat" && event.id === activeChat) {
    if (event.type === "delta") {
      reply += event.text;
      startStreamingReplySpeech(event.id);
      replyPresentation.content(event.id, reply);
      if (assistantNode && reply.trim()) replyPresentation.readoutContent(event.id, reply);
      if (isPet && hostVisible && !document.hidden && replyPresentation.canPresent(event.id)) petUI?.refreshAnswerReader(reply, true);
      text('chat-state', uiText('正在生成回复…'));
      $("messages").scrollTop = $("messages").scrollHeight;
    }
    if (event.type === "status") {
      if (event.text === '本次回复整段到达，将逐句展示。') immersiveNotice?.publishAction(uiText('本次回复整段到达，将逐句展示。'));
      text("chat-state", immersiveDeveloperMode ? event.text : uiText("正在回复…"));
    }
    if (event.type === "done" || event.type === "error") {
      if (event.type === 'error') replyPresentation.cancelReadout();
      // Claude unavailable (login, allowance, offline...): her own words, once; developer mode keeps the raw error.
      const outage=event.type==='error'&&!immersiveDeveloperMode ? outageDisplayText(event.outage) : null;
      const failure=event.type==='error' ? (outage ?? displayFailure(event.text)) : '';
      if(event.type==='error'&&outage===null)notify(event.text,true);
      const hasBody = !!reply.trim();
      const quietRepeat=event.type==='error'&&outage===''&&!hasBody; // already said once: nothing new on screen, the draft comes back
      const expectsSpeech = event.type === 'done' && hasBody && !!activeUser && settings.voice.enabled;
      const segmentedSpeech = expectsSpeech && !voiceReplyIds.has(event.id);
      const earlyCompletedSpeech=segmentedSpeech&&settings.provider.kind==='claude';
      let completedPresentation:NonNullable<typeof ordinaryReplyPresentation>|null=null;
      const streamed=ordinaryReplyPresentation?.id===event.id&&ordinaryReplyPresentation.streaming?ordinaryReplyPresentation:null;
      if (streamed && !segmentedSpeech) { if (replySpeechQueue.replyId === event.id) speech.stop(); ordinaryReplyPresentation = null; }
      if (streamed && segmentedSpeech) { streamed.text = reply; streamed.streaming = false; completedPresentation = streamed; } // R02: already speaking
      else if (segmentedSpeech) {
        ordinaryReplyPresentation = { id: event.id, text: reply, context: replySpeechContext(), index: -1,
          early:earlyCompletedSpeech,kicked:false,ended:false,textDrained:false };
        completedPresentation=ordinaryReplyPresentation;
        ordinaryVoiceConfig = { ...settings.voice };
        speechPlaybackErrorShown = false;
      }
      const mayPresent = hostVisible && !document.hidden && replyPresentation.canPresent(event.id);
      if (mayPresent) petUI?.refreshAnswerReader(reply, false);
      if (event.type === 'error' && (!replyPresentation.has(event.id) || quietRepeat)) {
        // Save/attachment/host-validation failures happened before acceptance.
        // Show the actual local failure without inventing a host reply identity.
        const input = $<HTMLTextAreaElement>('chat-input');
        if (!input.value && activeUser) input.value = activeUser.content;
      }
      history = voiceReplyIds.has(event.id)
        ? appendVoiceReply(history, reply)
        : appendReplyHistory(history, activeUser, reply);
      replyPresentation.close(event.id);
      if (assistantNode) renderReplyWaiting(assistantNode, false);
      if (quietRepeat) {
        assistantNode?.closest('.message')?.remove();
        assistantNode = null;
      } else if (event.type === "error") {
        assistantNode ??= addMessage('assistant', '');
        if (assistantNode) {
          assistantNode.textContent = hasBody
            ? `${isPet ? reply : formatReplySegments(reply)}\n\n${failure}`
            : failure;
          assistantNode.classList.add("message-error");
        }
      }
      const completedReply = reply, ownsSpeech = !!activeUser && chatOwner === windowKind && (!isPet || mayPresent);
      activeUser = null;
      activeChat = null;
      syncBodyInputGate();
      if (event.type === 'done' && !hasBody) {
        assistantNode?.closest('.message')?.remove();
        assistantNode = null;
        reply = '';
        petUI?.hideAnswer();
      } else if (quietRepeat) petUI?.hideAnswer();
      else if (event.type === 'error' && mayPresent) petUI?.finishAnswer(hasBody ? `${reply}\n\n${failure}` : failure, event.id, false, false, true);
      if(earlyCompletedSpeech&&completedPresentation&&isPet){
        petUI?.expectAnswerSpeech(event.id);
        void prepareReplySpeechPresentation(completedPresentation);
      }
      if (event.type === 'done' && hasBody) replyPresentation.finishReadout(event.id, () => {
        if ((isPet && (!hostVisible || document.hidden)) || activeChat) return;
        if(earlyCompletedSpeech&&completedPresentation&&ordinaryReplyPresentation!==completedPresentation)return;
        if (isPet) {
          petUI?.refreshAnswerReader(completedReply, false);
          if (!segmentedSpeech) petUI?.finishAnswer(completedReply, event.id, expectsSpeech, true, false);
          else if(earlyCompletedSpeech&&completedPresentation){
            completedPresentation.textDrained=true;
            // Full text has now naturally drained. Never expect speech a second time.
            petUI?.finishAnswer(completedReply,event.id,false,true,false);
            if(completedPresentation.ended&&ordinaryReplyPresentation===completedPresentation)ordinaryReplyPresentation=null;
          }
          else if (ordinaryReplyPresentation?.id === event.id) {
            // Normalize the already-visible full body to the host's raw receipt
            // mode even if voice was switched on during this streamed reply.
            petUI?.showAnswer(completedReply, true, event.id, false);
            petUI?.refreshAnswerReader(completedReply, false);
            void prepareReplySpeechPresentation(ordinaryReplyPresentation);
          }
        }
        if(earlyCompletedSpeech&&completedPresentation){
          completedPresentation.textDrained=true;
          if(completedPresentation.ended&&ordinaryReplyPresentation===completedPresentation)ordinaryReplyPresentation=null;
        }
        const voiceReady = voiceSpeechReady;
        if (voiceReady?.replyId === event.id) {
          voiceReady.presentationReady = true;
          const pendingSpeech = voiceReady.pendingSpeech;
          voiceReady.pendingSpeech = undefined;
          if (pendingSpeech) receiveVoiceConversation(pendingSpeech);
        }
        if (ownsSpeech && !earlyCompletedSpeech) {
          const acceptedReplyContext = segmentedSpeech ? replySpeechContext() : undefined;
          const release = () => { if (releaseReplySpeech === release) releaseReplySpeech = null; endReplySpeech(event.id, acceptedReplyContext); };
          releaseReplySpeech = release;
          if (segmentedSpeech) void replySpeechQueue.speak(event.id).then(release, error => { reportReplySpeechError(error); release(); });
          else void speech.speak(completedReply, settings.voice, { replyId: event.id }).then(release, release);
        }
      });
      setChatBusy(false);
      text(
        "chat-state",
        event.type === "error" ? uiText("本次请求未完成") : hasBody ? uiText("回复完成") : uiText("本次未返回回复正文"),
      );
      if(earlyCompletedSpeech&&ownsSpeech&&completedPresentation)kickCompletedReply(completedPresentation);
    }
  }
}
function projectPetVisibility(): void {
  const visible = windowVisibility.petVisible;
  if (visible !== null) settings.pet.visible = visible;
  const input = document.getElementById('pet-visible') as HTMLInputElement | null;
  const button = document.getElementById('show-pet') as HTMLButtonElement | null;
  if (input) { input.disabled = visible === null; if (visible !== null && !pendingPetVisibility) input.checked = visible; }
  if (button) button.disabled = visible === null;
}
function requestPetVisibility(desired: boolean): void {
  if (!petVisibilityIntent || windowVisibility.petVisible === null) { projectPetVisibility(); return; }
  const request = ++petVisibilityRequest;
  pendingPetVisibility = true;
  const input = document.getElementById('pet-visible') as HTMLInputElement | null;
  if (input) input.checked = desired;
  void petVisibilityIntent.request(desired).finally(async () => {
    if (request !== petVisibilityRequest) return;
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fresh = await Promise.race([
        window.desktop.getWindowVisibility(),
        new Promise<never>((_, reject) => { queryTimer = setTimeout(() => reject(new Error('窗口可见性状态查询超时')), 2000); }),
      ]);
      if (request === petVisibilityRequest) acceptWindowVisibility(fresh);
    } catch (error) { if (request === petVisibilityRequest) notify(String(error), true); }
    finally { if (queryTimer !== undefined) clearTimeout(queryTimer); }
    if (request === petVisibilityRequest) {
      pendingPetVisibility = false;
      projectPetVisibility();
    }
  });
}
function acceptWindowVisibility(value: WindowVisibilityState): void {
  if (!windowVisibility.accept(value)) return;
  hostVisible = windowVisibility.visible;
  projectPetVisibility();
  petUI?.setHostVisible(hostVisible);
  moodCompanion?.setHostVisible(hostVisible);
  stage?.setVisible(hostVisible);
  if (!hostVisible) {
    textMemorialOffer?.invalidate();
    if (activeMemorialSpeechId) { activeMemorialSpeechId = null; speech.stop(); }
    userProfilePanel?.close();
    if (isPet) void ambientAudioController?.stop().catch(() => {});
    hideWaitingPresentation(); stopMotionPreview(); captureController?.abort(); attachments = [];
    if (!isPet && document.getElementById('attachments')) renderAttachments();
  } else if (replyPresentation.canPresent(activeChat)) petUI?.refreshAnswerReader(reply, !!activeChat);
}
window.desktop.onWindowVisibility(acceptWindowVisibility);
void window.desktop.getWindowVisibility().then(acceptWindowVisibility).catch(error => notify(String(error), true));
void init().then(() => { if (isPet) void checkPetPresentation({ document, hostVisible: () => hostVisible, reason: 'startup', delayMs: 3000,
  report: sample => window.desktop.reportPetPresentation(sample) }); }).catch((error) => {
  showStartupFailure(error);
  console.error(error);
});
