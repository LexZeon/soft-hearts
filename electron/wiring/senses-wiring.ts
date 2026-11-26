// 感知's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4c.md).
// Moved from electron/main.ts; the statements are the ones main.ts had. Split by feature (docs/claude/2026-11-17-split-senses-wiring.md):
//   electron/wiring/senses-listen-wiring.ts       她听: the computer's sound, the old ambient listening, 读取音频, 一起听 / 一起看, the pause guards.
//   electron/wiring/senses-voice-input-wiring.ts  语音输入: the recognizer route, the foreground recognizer, R33's continuous voice.
//   electron/wiring/senses-look-wiring.ts         看: the switches, camera and screen capture, the look, the visual state, R10, her visual self.
// This file keeps what the rest of the app sees of 感知: wireSenses (made where main.ts made the switches, while main.ts is evaluated: it
// makes the three in that order), SensesNeeds and SensesProvides, the data map's stores, the sensor windows and the register entry. The
// privacy gates of what she sees and hears are in the three files: tests/senses-privacy-gates.test.ts and the tests that read the wiring
// as text (tests/helpers/wiring-source.ts) evaluate them there.
// - What the lines read from the rest of the app comes through SensesNeeds (getters electron/main.ts gives). The other parts' functions
//   and the objects made before wireSenses runs are taken once; a value that changes is read when it is used: `const { store } = needs;
//   // read when called` at the top of a function, `needs.<name>` inside a constructor's ports. register() takes the values the ready
//   chain set before it registers (registerIPC) and never replaces.
// - State other parts read is module-level in the feature files and exported again here (live bindings): userInputUntil,
//   visionGeneration, visionSupported, visionStatus, proactiveVisionEnabled, and 听's audioCapture, audioReading, ambientAudio,
//   ambientComments, listenTogether, watchTogether, ambientStore, asrTask, readingInputSpeech, lastAmbientSpeech. Other parts write three
//   of them, through named setters (setVisionSupported, setVisionStatus, setLastAmbientSpeech).
// 传感窗口: local pose sensing (I-001), the face check (I-135), voice input's own recognizer and what the user is doing (I-006) are made
//   by ready-chain steps here (startUserActivity, startPoseAndFace, startLocalAsr), top-level like startUnbound, so the wiring golden
//   reads their statements in place; their handles are module-level and exported (poseSensing, faceCheck, localAsr, userActivity).
// - register() runs inside the agent channel's recorder, where main.ts registered these handlers; it hands the registrar to the three
//   feature files in the order main.ts registered them (看, what the user is doing, 她听, 语音输入).
// - The sync steps and save steps are top-level functions in the feature files (electron/main.ts's step lists name them, imported from
//   here; the wiring golden expands their bodies in place).
// What stays in electron/main.ts and why (docs/claude/2026-11-16-wiring-step-4c.md): the camera permission switch (cameraEnabled: the
// session's permission handler and the window events write it), the listen kind (the stage's beat score feeds it), deleting a heard transcript and the 一起听 records'
// handlers (they go through the recycle bin), the window events (secureWindow's order). cancelProactiveVision, the vision-initiative
// ack, the sense router (I-040) and her own look (I-085) are 主动's wiring since step 4e (electron/wiring/initiative-wiring.ts).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { OwnLineCause } from '../../shared/voice';
import type { PerceptionSwitches } from '../safety';
import { app, safeStorage, type BrowserWindow } from 'electron';
import { voiceprint } from './senses-voiceprint-wiring'; // Unbound v1 step 3: 「允许记录」 off deletes the voiceprint
import type { AppSettings, Attachment } from '../../shared/contracts';
import type { RuntimeState } from '../../shared/foundation/runtime-state';
import type { CameraLookMiss, ScreenLook, VisionRuntimeState } from '../../shared/senses';
import type { CallLookFields, ReadingCancelBy, VoiceCancelReason } from '../../shared/voice';
import type { ChatMessage } from '../../shared/foundation/chat';
import type { JournalInput, PauseStuckKind } from '../../shared/memory';
import { CameraGlance, CameraSampleBroker, CameraTrayEye, createWatchAlong, LookAttachments, LookTurns, ProactiveVision, ScreenGlance,
  ScreenSnapshots, UserGazeHost, VisionPresentationGuard, VisionProviderSupport, VisualSelfRuntime, type LocalAsrHost, type PoseSensingHost,
  type VisualSelfLease } from '../senses';
import { AmbientAsrRoute, ForegroundAsr, ListenTally, ListenTogether, SystemAudioRuntime, VoiceRoute, type AmbientCommentSession } from '../senses';
import { MediaRuntime, type MediaOwner } from '../senses/media-runtime';
import { createPoseSensingOrNull } from '../senses/pose/electron-wiring';
import { createFaceCheckOrNull, type FaceCheckParts } from '../senses/face/electron-wiring';
import { previewTarget } from '../senses/face/frames';
import { createLocalAsrOrNull } from '../senses/asr/electron-wiring';
import { createElectronUserActivity } from '../senses/user-activity-wiring';
import type { CompanionService } from '../brain';
import type { CharacterCardStore, PersonalizeLanguageStore } from '../cards';
import { AudioReadingHostBroker, CallOffers, SpeakingOwners } from '../voice';
import type { MemoryStore } from '../memory';
import type { ReplyProofSurface } from '../unbound';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { startUnit, startUnitSync, type PartHandle } from './parts-wiring';
import { registerPrivacyStores, type RecycleStores } from './memory-wiring';
import { broadcast, ownerFor, petWindow, showControls, windows } from './shell-wiring'; // no-pet-ok: petWindow is shell-wiring's existing export name
import { VoiceChatHost, type VoiceAppCapture, type VoiceNeeds, type VoiceProvides } from './voice-wiring';
import { listenTogether, watchTogether, ambientStore, wireListen } from './senses-listen-wiring';
import { wireVoiceInput } from './senses-voice-input-wiring';
import { wireLook } from './senses-look-wiring';
import { relayPoseSensing, relayUserGaze } from './unbound-senses-wiring';
import { wirePoseUses } from './senses-pose-uses-wiring';

/** The voice chat host's ports (electron/voice/voice-chat-host.ts), for the types of what it is handed. */
type VoiceHostPorts = ConstructorParameters<typeof VoiceChatHost>[0];

/** What the senses wiring reads from the rest of the app (electron/main.ts gives getters; each read when it is used). */
export interface SensesNeeds {
  /** 数据地图 (step 4d): what she was fed (I-019) and the songs she knows (I-077), still made by electron/main.ts; 感知 hands them to the privacy actions. */
  readonly feeding: { readonly store: NonNullable<RecycleStores['feeding']> };
  readonly songMemory: NonNullable<RecycleStores['songs']>;
  /** Undefined until the ready chain made it (the switches' callbacks read it optionally, as before). */
  readonly store: SettingsStore;
  readonly pet: BrowserWindow | null;
  /** 2026-11-24 (续): the user's own switches' host paths (electron/safety/agent-channel), null until the control window's operations are recorded; 一起看 resumes through them when her window comes back. */
  readonly perceptionSwitches: PerceptionSwitches | null;
  readonly companion: CompanionService;
  readonly characterCards: CharacterCardStore;
  readonly exiting: boolean;
  readonly petWindowDrag: { readonly active: boolean } | null;
  /** 大脑: the tasks in flight (a chat turn or an agent task). */
  readonly pending: Map<string, { controller: AbortController; owner: number; kind: 'chat' | 'agent'; source?: 'language-authoring' | 'visual-authoring' }>;
  /** 主动: the inner loop's opening choice (I-020 #10: a visual topic that could not go may let her pick once more). */
  readonly innerLoopHost: { readonly opening: { unable(id: string, stage: 'capture' | 'generation'): void } };
  /** 记忆: the user's profile read for one chat turn's context. */
  readonly userProfileContext: { read(lease: string | null): string | null | undefined } | undefined;
  readonly personalizeLanguage: PersonalizeLanguageStore | undefined;
  // 角色卡 / 舞台: what a vision context change makes stale (personalize authoring and the surprise preview).
  readonly surprisePreviewHost: { invalidate(): void } | undefined;
  readonly languageAuthoring: { invalidate(): void } | undefined;
  readonly visualAuthoring: { invalidate(): void } | undefined;
  readonly bodyAuthoring: { invalidate(): void } | undefined;
  readonly controls: BrowserWindow | null;
  /** 记忆: the text invitations' archive (a voice turn's long-chat window reads it too). */
  readonly textInvitationMemory: MemoryStore | null;
  /** 设置: the companion commands (a spoken sentence makes the open ones stale). */
  readonly companionCommands: { invalidate(): void } | null;
  /** 一起听: music / show / talk from the stage's beat score (made after wireSenses runs; read by initAmbientAudio). */
  readonly listenKind: { readonly host: ConstructorParameters<typeof ListenTogether>[0]['kinds'] };
  // Made before wireSeeing runs and never replaced (taken once).
  readonly appJournal: { record(input: JournalInput): void };
  readonly proactiveSpeechGate: ConstructorParameters<typeof ProactiveVision>[0]['gate'] & { setScope(scope: string): void };
  /** 主动 I-085: her own look (it drops what she saw when the context ends or a switch changes). */
  readonly selfLook: { cancel(): void; mediaChanged(): void };
  /** 声音: the voice call (I-091), the call's sentence-by-sentence reading, the frozen reply styles and the speech runtime. */
  readonly voiceCall: VoiceProvides['voiceCall'];
  readonly callStreamingSpeech: VoiceProvides['callStreamingSpeech'];
  readonly replySpeechStyles: VoiceProvides['replySpeechStyles'];
  readonly speechRuntime: VoiceProvides['speechRuntime'];
  /** 体验记录's extra rows: how long a spoken sentence took to become words (journal only). */
  readonly journalExtras: { readonly voiceTime: { measure(wav: ArrayBuffer, run: () => Promise<string>): Promise<string>; endpoint(): void; noSound(): void }; readonly readCancel: { note(by: ReadingCancelBy): void }; readonly readingLedger: { expect(replyId: string): void; notHanded(by: ReadingCancelBy): void }; readonly callLook: { note(ms: number | null): void }; callLookLine(fields: CallLookFields): void };
  /** 心情 / 大脑: a spoken sentence is the user's message too (the mood judge, the reactions, the chat's Claude process). */
  readonly moodJudge: { readonly host: { userText(id: string, text: string, voice: boolean): void } };
  /** `asking` and `firstChar`: I-161's semantic look rides on the utterance's reaction call (electron/senses/sense-router/voice.ts). */
  readonly reactions: { userTurn(id: string, text: string): void; firstChar(id: string): void; readonly host: { asking(id: string): boolean } };
  /** I-161 A: `forgetFrames` drops a call's small frames from her process ("别看", a switch off, a cleared vision context). */
  readonly claudeChat: Required<VoiceHostPorts['claude']> & { forgetFrames(): void };
  // 大脑 / 设置: the call's take-me-there and setting cards, the long chat (I-134) and I-139's labels.
  readonly takeMeThere: ConstructorParameters<typeof CallOffers>[0]['takeMeThere'];
  readonly chatSettings: ConstructorParameters<typeof CallOffers>[0]['chatSettings'];
  readonly i139Chat: { labels(): unknown; cardLanguage(): string; relaxed(): ReturnType<NonNullable<VoiceHostPorts['relaxedChat']>> };
  /** I-134 新聊天's knobs (shared/behaviors/long-chat/knobs.ts), handed to longChatHistory as they are. */
  readonly LONG_CHAT: unknown;
  // The other parts' functions (electron/main.ts's wrappers; taken once).
  /** `keepLine` (I-174 item 3): the line she is saying now goes on (only what has not started yet is dropped). */
  cancelProactiveVision(inputOnly?: boolean, keepLine?: boolean): void;
  syncFatigueActivity(): void;
  replySpeechBusy(): boolean;
  cancelReplyStyle(id: string): boolean;
  clearReplySpeech(): void;
  completedFatigueFeeling: VoiceNeeds['completedFatigueFeeling'];
  memoryProviderScope(provider: AppSettings['provider']): string;
  agentInterconnected: ConstructorParameters<typeof CallOffers>[0]['interconnected'];
  recentLines(): string[];
  /** 大脑 I-134: a voice utterance starts from her archive's window (electron/brain/long-chat/host.ts). */
  longChatHistory(input: { knobs: unknown; archives: readonly unknown[]; scope: unknown; turnId: string; labels: unknown; language: string }): ChatMessage[] | null;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  replySurface(): ReplyProofSurface | null;
  herOnScreen(): boolean;
  onScreen(win: BrowserWindow): boolean;
  nativeVisibility(win: BrowserWindow): { visible: boolean; windowId: number; revision: number };
  publishSenses(): void;
  journalCharacterId(): string | null;
  speechScope(): string;
}

export interface SensesProvides {
  // 听
  readonly ambientSpeakingOwners: SpeakingOwners;
  /** Which 读取音频 source is paused now, and the minute's listen counts (electron/main.ts's two module timers read them). */
  readonly readingPaused: { 'system-audio': boolean; microphone: boolean };
  readonly listenTally: ListenTally;
  readonly systemAudio: SystemAudioRuntime;
  readonly voiceRoute: VoiceRoute;
  readonly ambientAsr: AmbientAsrRoute;
  readonly foregroundAsr: ForegroundAsr;
  readonly voiceHost: VoiceChatHost;
  noteStuck(what: PauseStuckKind): void;
  voiceCurrent(capture: VoiceAppCapture): boolean;
  revokeVoice(reason: VoiceCancelReason, preserveConsent?: boolean): void;
  stopSystemAudio(): void;
  cancelAmbientPlayback(): void;
  suspendAmbientSpeech(): void;
  readingContextIdentity(): string;
  readingActive(view?: ReturnType<AudioReadingHostBroker['getView']>): boolean;
  syncAudioCapture(): void;
  allowsOwnedMedia(owner: MediaOwner, kind: 'audio' | 'video', manualCamera?: boolean): boolean;
  currentAmbientSession(): AmbientCommentSession | null;
  /** The ready-chain step: the heard-words archive, the old ambient listening, 一起听 / 一起看, audio capture and reading. */
  initAmbientAudio(): Promise<void>;
  // 看
  readonly media: MediaRuntime;
  readonly visionSupport: VisionProviderSupport;
  readonly visualSelfRuntime: VisualSelfRuntime;
  readonly cameraSamples: CameraSampleBroker;
  readonly screenSnapshots: ScreenSnapshots;
  readonly lookTurns: LookTurns;
  readonly userGaze: UserGazeHost;
  readonly cameraGlance: CameraGlance;
  readonly cameraEye: CameraTrayEye;
  readonly lookAttachments: LookAttachments;
  readonly screenGlance: ScreenGlance;
  readonly watchAlong: ReturnType<typeof createWatchAlong>;
  readonly visionPresentation: VisionPresentationGuard;
  readonly proactiveVision: ProactiveVision;
  lookScope(): string;
  lookState(): ReturnType<ConstructorParameters<typeof LookAttachments>[1]['state']>;
  roughForTurn(): ReturnType<ScreenGlance['rough']> | undefined;
  visionEligible(): boolean;
  visionState(): VisionRuntimeState;
  publishVisionState(): void;
  /** `cause` (I-174 item 3): 'message' / 'stop' end the line she is saying; input, a touch or her mood moving do not (default 'input'). */
  noteVisionUserActivity(cause?: OwnLineCause): void;
  clearVisionContext(): void;
  refreshVisionContext(): string;
  refreshVisualSelfContext(scope?: string, displayId?: string | null): void;
  chatContextData(profileLease: string | null, visualLease: VisualSelfLease | null): string | undefined;
  /** `miss` (2026-11-21): why no frame came (closed words, for the camera-look journal line). */
  captureSharedCamera(owner: number, signal: AbortSignal, miss?: (why: CameraLookMiss) => void): Promise<Attachment | null>;
  presencePorts(): { lastInteractionAt(): number | null; person(): boolean | null; screen: { on(): boolean; capture(signal: AbortSignal): Promise<string | null> }; looked(look: ScreenLook | 'failed'): void };
  mediaChanged(previous: RuntimeState): void;
  /** I-171, I-174 item 9b: a window left the screen: its camera goes; a step away keeps her reply (senses-look-wiring.ts). */
  releaseCameraOnLeave(win: BrowserWindow, owner: MediaOwner): void;
  /** 「截取画面」's last pick is forgotten (恢复默认设置). */
  forgetScreenSelection(): void;
}

// 主动's wiring (electron/wiring/initiative-wiring.ts, step 4e) makes I-040's sense router and I-019's snack line: 感知's own modules,
// handed over here so that wiring reaches into no other part's inside.
export { createSenseRouter } from '../senses/sense-router/wiring';
export { createFeedRecognition } from '../senses/feed-recognition/electron-wiring';

// State other parts read (live bindings, declared where it is written) and the sync and save steps, from the feature files.
export { proactiveVisionEnabled, saveVisionReset, savedVisionState, setVisionStatus, setVisionSupported, syncVisionContext, userInputUntil, visionGeneration, visionStatus,
  visionSupported } from './senses-look-wiring';
export { seeAndSay } from './see-and-say-wiring'; // I-166: her closer look and her paragraph (live binding)
export { ambientAudio, ambientComments, ambientStore, audioCapture, audioReading, lastAmbientSpeech, listenTogether, setLastAmbientSpeech,
  attachWatchSpeaker, watchContinuity, watchTogether } from './senses-listen-wiring';
export { asrTask, readingInputSpeech, saveProviderStopsAudio, saveVoiceInputKey, syncVoiceScope } from './senses-voice-input-wiring';

// 传感窗口: made by the ready-chain steps below.
export let poseSensing: PoseSensingHost | null = null; // I-001 local pose sensing (electron/senses/pose/host.ts): owns the camera when on
export let faceCheck: FaceCheckParts | null = null; // I-135 (electron/senses/face/host.ts): off by default; checks only while the user's camera is on; the lead reads state()/strangerLine()
export let localAsr: LocalAsrHost | null = null; // voice input's own recognizer on this computer (electron/senses/asr/)
export let userActivity: ReturnType<typeof createElectronUserActivity> | undefined; // I-006 第 1 步 陪你做事: created once the app is ready (powerMonitor); memory only
// The ready-chain steps below read these (set by wireLook inside wireSenses, which runs while electron/main.ts is evaluated, before the ready chain).
let sensorNeeds!: SensesNeeds;
let media!: MediaRuntime;
let mediaChanged!: (previous: RuntimeState) => void;
let cameraGlance!: CameraGlance;
let userGaze!: UserGazeHost;
let cameraEye!: CameraTrayEye;
let cameraSamples!: CameraSampleBroker;
let presencePorts!: SensesProvides['presencePorts'];
export function keepForSensorWindows(parts: { needs: SensesNeeds; media: MediaRuntime; mediaChanged: (previous: RuntimeState) => void; cameraGlance: CameraGlance;
  userGaze: UserGazeHost; cameraEye: CameraTrayEye; cameraSamples: CameraSampleBroker; presencePorts: SensesProvides['presencePorts'] }): void {
  sensorNeeds = parts.needs; media = parts.media; mediaChanged = parts.mediaChanged; cameraGlance = parts.cameraGlance; userGaze = parts.userGaze;
  cameraEye = parts.cameraEye; cameraSamples = parts.cameraSamples; presencePorts = parts.presencePorts;
}

/** Ready-chain step (感知 I-006): what the user is doing, with I-066's presence ports (memory only). */
export async function startUserActivity(): Promise<void> {
  await startUnit('senses', 'user-activity', async () => { // overhaul step 7: this unit's start, through the part runner
  userActivity = createElectronUserActivity({ directory: () => sensorNeeds.store.directory, broadcast: view => broadcast('desk:user-activity', view), ...presencePorts() }); await userActivity.load(); // I-006
  });
}
/** Ready-chain step (感知 I-001, I-135): local pose sensing (it owns the camera when on) and the face check; main.ts starts the check's init (faceReady). */
export function startPoseAndFace(directory: string): void {
  startUnitSync('senses', 'pose-sensing', () => { // overhaul step 7: each its own unit
  const uses = wirePoseUses({ companion: () => sensorNeeds.companion ?? null, characterCards: () => sensorNeeds.characterCards ?? null, chatRunning: () => [...sensorNeeds.pending.values()].some(task => task.kind === 'chat'), // I-189 (electron/wiring/senses-pose-uses-wiring.ts)
    speaking: () => sensorNeeds.replySpeechBusy(), controls: () => sensorNeeds.controls, record: input => sensorNeeds.appJournal.record(input), journalCharacterId: () => sensorNeeds.journalCharacterId() });
  userGaze.setAttention(() => uses.attention()); // I-189 #1, #2: the windows' userGaze answer carries it
  poseSensing = createPoseSensingOrNull({ directory, developerMode: () => !!sensorNeeds.companion?.mood.isDeveloperMode(),
    onSignal: signal => { uses.note(signal); sensorNeeds.companion?.pose.signal(signal); cameraGlance.noteSignal(signal); userGaze.note(signal); relayUserGaze((win, display) => userGaze.read(win, display)); faceCheck?.host.notePoseSignal(signal.present); }, onSensing: on => { faceCheck?.host.cameraChanged(); /* the pose frames start or stop: the face check follows */ uses.sensing(on); sensorNeeds.companion?.pose.sensing(on); userGaze.sensing(on); relayPoseSensing(on); }, // batch D: her full-screen page too, only while on // P1 第二阶段: her reactions (electron/mood/pose-reactions/host.ts)
    publish: view => broadcast('desk:pose-sensing', view), promptRaised: owner => { if (owner === 'pet') showControls(); },
    disableCamera: () => { if (!media.state.cameraLocal) return; const previous = { ...media.state }; media.update({ cameraLocal: false }, media.state.cameraOwner ?? 'controls'); mediaChanged(previous); }, // I-036: 「姿势识别」 only
    trayChanged: on => cameraEye.pose(on) });
  void poseSensing?.init();
  });
  startUnitSync('senses', 'face-check', () => {
  faceCheck = createFaceCheckOrNull({ directory, profileDirectory: app.getPath('userData'), secret: safeStorage, publish: view => broadcast('desk:face-check', view), // I-135
    journal: counts => sensorNeeds.appJournal.record({ type: 'face-check', characterId: sensorNeeds.journalCharacterId(), ...counts }),
    record: row => sensorNeeds.appJournal.record({ ...row, characterId: sensorNeeds.journalCharacterId() }), // 2026-11-25: each check's score, or why none ran (shared/senses/face-journal.ts)
    sendPreview: message => { try { previewTarget(windows(), petWindow())?.webContents.send('desk:face-check', message); } catch { /* the control window is gone */ } }, // the enrolment picture: the control window only (no-pet-ok: petWindow is shell-wiring's export name)
    frames: { poseOn: () => media.state.cameraLocal === true && poseSensing?.cameraMode() === 'local', poseTap: () => poseSensing?.supervisor.tap() ?? Promise.resolve(null),
      imagesOn: () => media.sharesCameraFrames() && !media.state.cameraHeld, latestPicture: () => media.cameraAttachment()?.dataUrl ?? null,
      clearPicture: async signal => { const owner = windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner); return owner ? (await cameraSamples.request(owner.webContents.id, signal))?.dataUrl ?? null : null; } } });
  });
}
/** Ready-chain step (感知): voice input's own recognizer on this computer (electron/senses/asr/). */
export function startLocalAsr(directory: string): void {
  startUnitSync('senses', 'local-asr', () => { // overhaul step 7: this unit's start, through the part runner
  localAsr = createLocalAsrOrNull({ directory, publish: view => broadcast('desk:local-asr', view), promptRaised: owner => { if (owner === 'pet') showControls(); } });
  void localAsr?.init();
  });
}

export function wireSenses(needs: SensesNeeds): PartHandle<SensesProvides> & { register(ipc: PartIpc): void } {
  // 数据地图 (wiring rewrite step 4d): the stores 感知 owns, for deleting a character with her memories, the recycle bin and 「允许记录」 off.
  registerPrivacyStores('senses', {
    recycle: () => ({ feeding: needs.feeding.store, songs: needs.songMemory, listen: listenTogether, watch: watchTogether, ambient: ambientStore ?? null }),
    recordingOff: () => ({ feeding: needs.feeding.store, songMemory: needs.songMemory, listenTogether, watchTogether, voiceprint: typeof voiceprint === 'function' ? voiceprint(needs) : null }), // Unbound v1 step 3: made now if it was not, so its file goes even unused
  });
  // The three features, in the order they were made in one closure before (docs/claude/2026-11-17-split-senses-wiring.md): 她听, then
  // 语音输入 (it reads 她听's pause guards), then 看 (its switches take 语音输入's recognizer route on construction).
  const listenPart = wireListen(needs);
  const voicePart = wireVoiceInput(needs, listenPart);
  const lookPart = wireLook(needs, listenPart, voicePart);
  return {
    id: 'senses',
    units: ['pose-sensing', 'face-check', 'local-asr', 'user-activity', 'ambient-audio', 'audio-capture', 'audio-reading', 'listen-together', 'watch-together', 'system-audio', 'voice-route', 'ambient-asr', 'foreground-asr',
      'voice-host', 'media', 'camera-samples', 'screen-snapshots', 'look-turns', 'look-attachments', 'camera-glance', 'camera-eye', 'closer-look', 'screen-glance',
      'watch-along', 'user-gaze', 'vision-presentation', 'proactive-vision', 'visual-self', 'vision-support', 'music-settings'],
    /** Overhaul step 7: the handlers of each unit that can be switched off (they answer PART_OFF while it is off). */
    ipc: { 'music-settings': ['getMusicSettings', 'setMusicSettings'], 'user-activity': ['getUserActivity', 'setUserActivity'],
      'pose-sensing': ['getPoseSensing', 'downloadPoseComponents', 'cancelPoseDownload', 'dismissPosePrompt', 'importPoseComponents', 'removePoseComponents', 'redetectPoseHardware', 'getPoseDiagnostics'],
      'face-check': ['getFaceCheck', 'setFaceCheck', 'downloadFaceComponents', 'cancelFaceDownload', 'startFaceEnrolment', 'cancelFaceEnrolment', 'deleteFaceData', 'importFaceComponents', 'removeFaceComponents'],
      'local-asr': ['getLocalAsr', 'downloadLocalAsr', 'cancelLocalAsrDownload', 'dismissLocalAsrPrompt', 'importLocalAsr', 'removeLocalAsr'],
      'ambient-audio': ['getAmbientAudioState', 'beginAmbientAudio', 'stopAmbientAudio', 'setAmbientAudioSpeaking', 'submitAmbientAudio', 'confirmAmbientAudioCapture', 'listAmbientTranscripts', 'readAmbientTranscript', 'readAmbientComments', 'acknowledgeAmbientComment'] },
    register(ipc: PartIpc): void {
      const { scopedHost } = ipc;
      // Handed on as `registrar`: scripts/dev/wiring-golden.mjs follows a part's registrar by that name into the files it registers in.
      const registrar = ipc;
      lookPart.register(registrar); // 看 (electron/wiring/senses-look-wiring.ts)
      userActivity?.register(scopedHost); // I-006: the 「知道你是不是在忙」 switch (control window; the agent channel calls the same operation)
      listenPart.register(registrar); // 她听 (electron/wiring/senses-listen-wiring.ts)
      voicePart.register(registrar); // 语音输入 (electron/wiring/senses-voice-input-wiring.ts)
    },
    provides: { ...listenPart.provides, ...voicePart.provides, ...lookPart.provides },
  };
}
