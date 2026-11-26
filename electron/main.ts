import type { OwnLineCause } from '../shared/voice';
import { app, BrowserWindow, dialog, net, protocol, safeStorage, screen } from "electron";
import originalFs from 'original-fs';
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from 'node:os';
import type { AppSettings } from "../shared/contracts";
import { t } from '../shared/foundation/ui-language';
import { sensesFrom } from '../shared/unbound'; // Unbound v1 step 2
import { compileCharacterPersona, type CharacterCard } from "../shared/cards";
import bundledAssetManifest from '../shared/actions/bundled-assets.json';
import { PRODUCT_NAME, appUserModelId } from '../scripts/lib/app-identity.mjs';
// the trunk's own modules (start-up, the profile folder, the assets the windows load)
import { PROFILE_FOLDER, prepareProfileDirectory, startupProfileOverride } from "./profile";
import { resolveInstalledDesktopChannel } from './desktop-channel';
import { takeStartupLock, wireSecondInstance } from './wiring/startup-wait-wiring'; // I-182
import { MutationQueue } from './foundation/mutation-queue';
import { initialControlsVisible } from './foundation/initial-controls';
import { AssetRegistry } from "./foundation/assets";
import { createAssetProtocolHandler } from "./foundation/asset-protocol";
// what the trunk still makes or reads itself (each part's public page, or the module the trunk has always used)
import { agentInterconnected, appConversion, recordAgentOperations } from './safety/agent-channel/electron-wiring';
import { agentHostActions, type PerceptionSwitches } from './safety';
import { inspectGeneProfile } from './cards';
import { SettingsStore } from './settings';
import { initialPetPosition } from './stage';
import { unboundSource } from './unbound'; // Unbound U1
import { selectBodyStartupProfile } from './actions';
import { takeAssistantChat, type RecycleStores } from './memory/recycle-wiring'; // I-144 回收站
import { AppJournal, readBuildCommit } from './memory';
import { JournalExtras, herGestureInput, topmostFixInput } from './memory/journal/extras';
import { AppSessionHost } from './memory/app-session/host';
import { chatAvailability, createTurnAwareness } from './brain';
import { longChatHistory } from './brain/long-chat/host'; // I-134 new chat
import { ChatActionHost } from './brain/chat-actions-host';
import { memoryProviderScope } from './brain/companion';
import { PetReplyWindow } from './brain/reply-window';
import { CameraLookJournal, FeedCueSynth, ListenKindSource, SongMemoryHost } from './senses'; // I-084, B06, I-016, I-077 step 2
import { type MediaOwner } from "./senses/media-runtime";
import { StageStateHost, createHerState, hearingSource } from './mood';
// the wiring (electron/wiring/): the skeleton (step 3) and each part's wiring (steps 4 and 5)
import { host, hostIpc, partIpc, wireIpc } from './wiring/ipc-wiring'; // wiring rewrite step 3: the IPC guard
import { broadcast, createTray, guardSession, guardWindowNavigation, loadWindowsEarly, registerShortcuts, registerQuit, registerShell, releaseShell, showControls, syncTray, tray, windows, wireShell } from './wiring/shell-wiring'; // windows, tray, shortcuts, permissions
import { secureWindow, wireLifecycle } from './wiring/lifecycle-wiring'; // secureWindow's dispatch
import { holdForFlush, markExiting, exiting, wireQuit } from './wiring/quit-wiring'; // before quitting (step 5b)
import { notePetWindow, onNewDocument, publishVisibility, republishPetVisibility, wireWindowEvents, windowEvents } from './wiring/window-events-wiring'; // its order (step 5b)
// the parts' window steps (step 5b)
import { cancelPetMemorial, flushMemoryNotes, flushMemoryStores, noteQuitting, releaseProfile, wireMemoryCleanup } from './wiring/memory-cleanup-wiring';
import { abortAllTasks, abortWindowTasks, disposeChat, disposeRouting, flushCompanion, waitForChats } from './wiring/brain-cleanup-wiring';
import { disposeGame, disposeInitiative, disposeR20Offers, disposeTogether, stopSurprisePreview } from './wiring/initiative-cleanup-wiring';
import { checkVoiceCall, dropWindowSpeech, endVoiceCall, stopPlaybackActivity, stopSpeech, wireVoiceCleanup } from './wiring/voice-cleanup-wiring';
import { cancelPetDrag, closeControlsTools, disposeSingleEmoji, releasePetWindow, closeWindowAuthoring, notePetBodyVisible, petHidden, petPageGone, petWindowClosed, resetPetBody, sendNativeVisibility,
  wireStageCleanup } from './wiring/stage-cleanup-wiring';
import { clearClosedWindowVision, dropClosedMediaOwner, refreshVisionOnVisibility, releaseAmbientOwner, revokeAmbientOwner, revokeAudioOwner, revokeHiddenVoiceInput,
  revokeVisionOwner, revokeWindowVoiceInput, stopPetSystemAudio, wireSensesCleanup, abortVoiceRecognition, disposeLook, flushUserActivity, holdForPoseInference, releaseCapture,
  stopSensorProcesses, stopVisionAndSound, stopWatching } from './wiring/senses-cleanup-wiring';
import { clockTick } from './wiring/clock-wiring'; // the 1-second clock
import { declareParts, fatalStartDialog, wireHealth } from './wiring/health-wiring';
import { startPartStores } from './wiring/ready-wiring';
import { characterAvatars, closeLanguageAuthoring, conversionEnded, holdForConversion, wireCardsQuit, characterCards, characterResponseService, characterResponses, characterStickerHost, languageAuthoring, personalizeLanguage, saveCardPersona,
  startCardResponses, startCardStickers, startCardStore, startLanguageAuthoring } from './wiring/cards-ready-wiring'; // step 5: 角色卡's ready steps
import { wireCards } from './wiring/cards-wiring'; // wiring rewrite step 4: 角色卡
import { bundledAssets, cancelClosedWindowDownload, cancelMotionDownloads, dropMotionWeightsOwner, motionFits, motionLibrary, noteModelSelection, saveMotionSelection, startMotionFits, startMotionStores,
  wireActions } from './wiring/actions-wiring'; // wiring rewrite step 4: 身体动作 (its stores and numbers: step 5b)
import { companionCommands, invalidateCompanionCommands, refreshCompanionCommands, startUiLanguage, broadcastSettings, keepHostIntents, keepStaleAssetClears, modelChangeClearsMotion, releaseCompanionCommands, wireSaveSettings, wireSettings, wireSettingsSync } from './wiring/settings-wiring'; // wiring rewrite step 4: 设置
import { petHeld, releaseUnbound, startUnbound, syncUnbound, unbound, unboundEntry, wireUnbound } from './wiring/unbound-wiring'; // wiring rewrite step 4: Unbound
import { interruptOwnedTasks, releaseClaudeTasks, wireSafety } from './wiring/safety-wiring'; // wiring rewrite step 4: 连接任务和安全
import { saveStopsSpeech, saveTtsKey, wireVoice } from './wiring/voice-wiring'; // wiring rewrite step 4: 声音
import { ambientAudio, ambientComments, audioCapture, lastAmbientSpeech, listenTogether, proactiveVisionEnabled, saveProviderStopsAudio, saveVisionReset, saveVoiceInputKey, savedVisionState, setLastAmbientSpeech, setVisionSupported, syncVisionContext, syncVoiceScope, faceCheck, localAsr, startLocalAsr, startPoseAndFace, userActivity, userInputUntil, watchTogether, wireSenses } from './wiring/senses-wiring'; // wiring rewrite step 4c: 感知
import { diaryWriter, herNote, recycleBin, recycleHost, recycleSingle, recycleStores, registerPrivacyStores, reviewWriter, startMemory, startRecycleBin, textInvitationMemory, textMemorialHost, upcoming, userProfileContext, userProfileManagement, userProfiles, wireMemory } from './wiring/memory-wiring'; // wiring rewrite step 4d: 记忆
import { feeding, hands, impulse, innerLoopHost, lastVisionSpeech, moodCueOwner, proactiveSpeechGate, rps, selfLook, specialDay, takeMeThere, wireInitiative } from './wiring/initiative-wiring'; // wiring rewrite step 4e: 主动
import { blushCalibrations, companionCanExpress, disposeMoodJudges, fatigueActivity, judgeMood, moodJudge, releaseFatigue, startFatigueActivity, moodModel, reactions, startBlush, startRealerExpiry, syncFatigue, syncMood, touchBrain, wireMood, wireMoodPublish } from './wiring/mood-wiring'; // wiring rewrite step 4f: 心情
import { attachPetWindow, bodyAuthoring, bodyModelGeneration, herOnScreen, modelCapabilities, nativeVisibility, onScreen, petPresentation, petWindowDrag, physicsForWindows, playExpressionPreview, publishEmojiContext, replySurface, startEmojiSettings, startKeepInArea, startModelCapabilities, startModelProfiles, startPersonalizeAuthoring, startPersonalizeStores, startPhysicsSettings, startStageWindows, syncBodyModel, syncBodySelection, syncPetWindow, syncSingleEmoji, syncWindowVisibility, togglePet, verifyVisualGeneTarget, visualAuthoring, wireStage, withBodyPose } from './wiring/stage-wiring'; // wiring rewrite step 4g: 舞台
import { LONG_CHAT, SPEAK_ONLY_ON, attachChatWindows, chatSettings, claudeChat, companion, i139Chat, moduleRouter, pending, chatDiagnosticFacts, replyRhythm,
  reserveCompanionAuthoring, savedCompanionContext, startCompanion, wireBrain } from './wiring/brain-wiring'; // wiring rewrite step 4h: 大脑
import { publishCue, publishGateScope, publishR20, wireInitiativePublish } from './wiring/initiative-publish-wiring'; // step 5: the mood publish's steps
import { publishVisionActivity, wireSensesPublish } from './wiring/senses-publish-wiring';
import { publishMemorials } from './wiring/memory-publish-wiring';
import { registerSurprisePreview, surprisePreviewHost, wireSurprisePreview } from './wiring/initiative-handlers-wiring'; // step 5: the handlers moved out of registerIPC
import { registerSensesHandlers } from './wiring/senses-handlers-wiring';
import { registerMusicSettings, startMusicSettings } from './wiring/senses-music-wiring';
import { registerJournalHandlers } from './wiring/memory-handlers-wiring';

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mmd-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
app.setName(PRODUCT_NAME);
const defaultBodyQaProfile = path.join(app.getPath('appData'), PROFILE_FOLDER);
const installedDesktopChannel = resolveInstalledDesktopChannel({ executable: process.execPath, packaged: app.isPackaged,
  platform: process.platform, defaultProfile: defaultBodyQaProfile,
  requestedChannel: app.commandLine.getSwitchValue('soft-hearts-channel'),
  explicitProfile: app.commandLine.getSwitchValue('user-data-dir'),
  buildMarker: app.commandLine.getSwitchValue('soft-hearts-build'), ownerMarker: app.commandLine.getSwitchValue('soft-hearts-desktop'),
  readRawArchive: file => originalFs.readFileSync(file) });
if (installedDesktopChannel) {
  app.setAppUserModelId(appUserModelId(installedDesktopChannel.channel)); // Matches its own desktop shortcut's taskbar identity.
  app.commandLine.appendSwitch('soft-hearts-channel', installedDesktopChannel.channel);
  app.commandLine.appendSwitch('soft-hearts-build', installedDesktopChannel.asarSha256);
  app.commandLine.appendSwitch('soft-hearts-desktop', installedDesktopChannel.ownerMarker);
}
const profileOverride = installedDesktopChannel?.profile ?? app.commandLine.getSwitchValue("user-data-dir");
const requestedBodyQa = app.commandLine.hasSwitch('behavior-body-qa') || process.argv.some(value => /^--behavior-body-qa/i.test(value));
if (profileOverride && !path.isAbsolute(profileOverride) && !requestedBodyQa) throw new Error("用户数据目录必须是绝对路径。");
const bodyStartupProfile = (() => {
  try { return selectBodyStartupProfile({
  qaIntent: requestedBodyQa,
  startup: { switchValue: app.commandLine.getSwitchValue('behavior-body-qa'), explicitProfile: profileOverride,
    defaultProfile: defaultBodyQaProfile, systemTemp: tmpdir(), argv: process.argv },
  prepareNormal: () => prepareProfileDirectory(app.getPath('appData'),
    startupProfileOverride(profileOverride, app.isPackaged, process.env), installedDesktopChannel?.channel === 'stable'),
  setAppProfile: profile => app.setPath('userData', profile), getAppProfile: () => app.getPath('userData'),
}); } catch (error) {
  if (requestedBodyQa) {
    console.error('身体动作 QA 启动参数或临时配置不合法，已在读取配置前停止。');
    app.exit(2);
  }
  throw error;
}
})();
app.setPath('userData', bodyStartupProfile.profile);
const hasLock = takeStartupLock(() => app.requestSingleInstanceLock()); // I-182: start, hand over to the running one, or wait for a quitting one

const assets = new AssetRegistry();
let controls: BrowserWindow | null = null;
let pet: BrowserWindow | null = null;
let petReply: PetReplyWindow | null = null;
// The table of parts' needs (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md): every part's wire call below is handed this one
// table; its needs type picks what it reads. Each entry is written once: a getter (read when the part reads it, never kept) or a function that
// calls the current one. Nothing here runs when the table is made, so the wire calls keep their order and what each reads, when.
type PartTable = Parameters<typeof wireStage>[0] & Parameters<typeof wireUnbound>[0] & Parameters<typeof wireShell>[0] & Parameters<typeof wireCards>[0]
  & Parameters<typeof wireMemory>[0] & Parameters<typeof wireVoice>[0] & Parameters<typeof wireBrain>[0] & Parameters<typeof wireInitiative>[0]
  & Parameters<typeof wireSafety>[0] & Parameters<typeof wireMood>[0] & Parameters<typeof wireSenses>[0] & Parameters<typeof wireSettings>[0] & Parameters<typeof wireActions>[0]
  & Parameters<typeof wireInitiativePublish>[0] & Parameters<typeof wireSensesPublish>[0] & Parameters<typeof wireSurprisePreview>[0]
  & Parameters<typeof registerSensesHandlers>[1] & Parameters<typeof registerJournalHandlers>[1];
const parts: PartTable = {
  // the windows and the trunk's own state
  get controls() { return controls; }, get pet() { return pet; }, get petReply() { return petReply; }, get store() { return store; }, get assets() { return assets; },
  get exiting() { return exiting; }, get installedDesktopChannel() { return installedDesktopChannel; }, get appSession() { return appSession; },
  get page() { return { devUrl: !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined, electronDir: __dirname, distDir: path.join(__dirname, "../dist") }; },
  get perceptionSwitches() { return perceptionSwitches; }, get mutations() { return mutations; }, get companionCommands() { return companionCommands; },
  get appJournal() { return appJournal; }, get journalExtras() { return journalExtras; },
  get cameraLookJournal() { return cameraLookJournal; }, get herState() { return herState; }, get turnAwareness() { return turnAwareness; },
  get songMemory() { return songMemory; }, get listenKind() { return listenKind; }, get feedCueSynth() { return feedCueSynth; }, get chatActions() { return chatActions; },
  get recycleHost() { return recycleHost; }, get songsBin() { return songsBin; }, get stageState() { return stageState; }, get buildCommit() { return buildCommit; },
  // 角色卡, 身体动作 and the stores the ready chain makes
  get characterCards() { return characterCards; }, get characterAvatars() { return characterAvatars; }, get characterResponses() { return characterResponses; },
  get characterResponseService() { return characterResponseService; }, get personalizeLanguage() { return personalizeLanguage; }, get languageAuthoring() { return languageAuthoring; },
  get characterStickerHost() { return characterStickerHost; }, get surprisePreviewHost() { return surprisePreviewHost; }, get bundledAssets() { return bundledAssets; },
  get motionLibrary() { return motionLibrary; }, get motionFits() { return motionFits; },
  // the parts' shared state (their wiring files' live bindings and what their wire calls provide)
  get companion() { return companion; }, get claudeChat() { return claudeChat; }, get pending() { return pending; }, get LONG_CHAT() { return LONG_CHAT; },
  get SPEAK_ONLY_ON() { return SPEAK_ONLY_ON; }, get i139Chat() { return i139Chat; }, get chatSettings() { return chatSettings; }, get moduleRouter() { return moduleRouter; },
  get replyRhythm() { return replyRhythm; }, get unbound() { return unbound; }, get unboundEntry() { return unboundEntry; },
  get userProfileContext() { return userProfileContext; }, get userProfileManagement() { return userProfileManagement; }, get textMemorialHost() { return textMemorialHost; },
  get textInvitationMemory() { return textInvitationMemory; }, get proactiveSpeechGate() { return proactiveSpeechGate; }, get selfLook() { return selfLook; },
  get takeMeThere() { return takeMeThere; }, get rps() { return rps; }, get feeding() { return feeding; }, get specialDay() { return specialDay; },
  get hands() { return typeof hands !== 'undefined' ? hands : null; }, get innerLoopHost() { return innerLoopHost; }, get lastVisionSpeech() { return lastVisionSpeech; },
  get moodJudge() { return moodJudge; }, get moodModel() { return moodModel; }, get reactions() { return reactions; }, get touchBrain() { return touchBrain; }, get blushCalibrations() { return blushCalibrations; },
  get safety() { return safety; }, get petWindowDrag() { return petWindowDrag; }, get bodyModelGeneration() { return bodyModelGeneration; },
  get visualAuthoring() { return visualAuthoring; }, get bodyAuthoring() { return bodyAuthoring; }, get audioCapture() { return audioCapture; }, get localAsr() { return localAsr; },
  get lastAmbientSpeech() { return lastAmbientSpeech; }, set lastAmbientSpeech(value) { setLastAmbientSpeech(value); },
  get voiceCall() { return voiceCall; }, get callStreamingSpeech() { return callStreamingSpeech; }, get completedReplySpeech() { return completedReplySpeech; },
  get replySpeechStyles() { return replySpeechStyles; }, get speechRuntime() { return speechRuntime; }, get speechPlaybackActivity() { return speechPlaybackActivity; },
  get ambientSpeakingOwners() { return ambientSpeakingOwners; }, get voiceRoute() { return voiceRoute; }, get voiceHost() { return voiceHost; },
  get foregroundAsr() { return foregroundAsr; }, get media() { return media; }, get visionSupport() { return visionSupport; }, get visualSelfRuntime() { return visualSelfRuntime; },
  get cameraSamples() { return cameraSamples; }, get screenSnapshots() { return screenSnapshots; }, get lookTurns() { return lookTurns; },
  get ambientComments() { return ambientComments; }, get lookAttachments() { return lookAttachments; }, get visionPresentation() { return visionPresentation; }, get proactiveVision() { return proactiveVision; },
  get captureSharedCamera() { return captureSharedCamera; },
  // functions: each calls the current one
  mutate: operation => mutate(operation), sync: (exclude?: number) => sync(exclude), togglePet: () => togglePet(),
  speechScope: () => speechScope(), journalCharacterId: () => journalCharacterId(), recentLines: () => recentLines(), agentInterconnected: () => agentInterconnected(),
  syncCharacter: (applyModel: boolean, previousCard: CharacterCard, hint?: string) => syncCharacter(applyModel, previousCard, hint), activateUserProfile: () => activateUserProfile(),
  adoptCharacterForModel: model => adoptCharacterForModel(model), noteModelSelection: () => noteModelSelection(),
  topmostJournal: (outcome, visible, nth) => { appJournal.record(topmostFixInput(journalCharacterId(), outcome, visible, nth)); },
  reserveCompanionAuthoring: (owner, id, controller, source) => reserveCompanionAuthoring(owner, id, controller, source),
  fitSettingsScale: value => fitSettingsScale(value), noteCompanionTopmostWrite: previous => noteCompanionTopmostWrite(previous),
  commitCompanionVisibility: visible => commitCompanionVisibility(visible), companionCommandContext: sender => companionCommandContext(sender),
  petHeld: () => petHeld(), nativeVisibility: win => nativeVisibility(win), onScreen: win => onScreen(win),
  herOnScreen: () => herOnScreen(), replySurface: () => replySurface(), withBodyPose: view => withBodyPose(view), companionCanExpress: () => companionCanExpress(),
  replySpeechBusy: () => replySpeechBusy(), cancelReplyStyle: id => cancelReplyStyle(id), clearReplySpeech: () => clearReplySpeech(),
  cancelCompletedReply: (id, by) => cancelCompletedReply(id, by), beginInitiativeSpeech: (s, i, o) => beginInitiativeSpeech(s, i, o),
  syncFatigueActivity: () => syncFatigueActivity(), completedFatigueFeeling: (scope, cardId) => completedFatigueFeeling(scope, cardId),
  noteStuck: what => noteStuck(what), mediaChanged: previous => mediaChanged(previous), suspendAmbientSpeech: () => suspendAmbientSpeech(),
  stopSystemAudio: () => stopSystemAudio(), revokeVoice: (reason, preserveConsent) => revokeVoice(reason, preserveConsent), readingActive: () => readingActive(),
  currentAmbientSession: () => currentAmbientSession(), publishSenses: () => publishSenses(), noteVisionUserActivity: (cause?: OwnLineCause) => noteVisionUserActivity(cause),
  clearVisionContext: () => clearVisionContext(), refreshVisionContext: () => refreshVisionContext(), publishVisionState: () => publishVisionState(),
  refreshVisualSelfContext: (scope, displayId) => refreshVisualSelfContext(scope, displayId), roughForTurn: () => roughForTurn(), lookState: () => lookState(),
  lookScope: () => lookScope(), visionEligible: () => visionEligible(), chatContextData: (profileLease, visualLease) => chatContextData(profileLease, visualLease),
  setVisionSupported: value => setVisionSupported(value), forgetScreenSelection: () => forgetScreenSelection(), setCameraEnabled: value => { cameraEnabled = value; }, claimMoodCue: view => claimMoodCue(view), cancelProactiveVision: (inputOnly?: boolean, keep?: boolean) => cancelProactiveVision(inputOnly, keep), openCodexTaskConfirmation: (value, current) => openCodexTaskConfirmation(value, current),
  memoryProviderScope: provider => memoryProviderScope(provider), longChatHistory: input => longChatHistory(input as Parameters<typeof longChatHistory>[0]),
  // Unbound's own (U1, U2 her peek, v1 step 1)
  developerMode: () => !!companion?.mood.isDeveloperMode(), source: () => unboundSource(store.current, physicsForWindows()), reviewed: () => verifyVisualGeneTarget(),
  restPose: () => bundledAssets.getDefaultAssets().then(d => d.motion.url), republishPetVisibility: () => republishPetVisibility?.(),
  peek: { activityIdleSeconds: () => userActivity?.idleSeconds() ?? null, mood: () => companion?.mood.get() ?? null, asleep: () => innerLoopHost.loop.asleep() || !!companion?.mood.get().fatigue?.sleeping, inCall: () => voiceCall.on, // U2 (I-104): her peek reads what the app already knows
    userTalking: () => [...pending.values()].some(task => task.kind === 'chat'), lastInteractionAt: () => companion?.mood.get().snapshot.lastInteractionAt ?? null, answered: () => companion?.mood.moments.note('peek-answered') ?? false },
  face: () => faceCheck?.host.view() ?? null, replyRunning: () => [...pending.values()].some(task => task.kind === 'chat'), chatAvailable: () => chatAvailability.isAvailable(),
  // 连接任务和安全's test commands: which main-process object answers each one (electron/safety/test-commands/wiring.ts)
  testCommandPorts: {
    companion: () => companion, innerLoop: () => innerLoopHost.loop, rps: () => rps.host, diary: () => diaryWriter, upcoming: () => upcoming ?? undefined, specialDay: () => specialDay, userActivity: () => userActivity, watchAlong: () => watchAlong,
    innerLoopOn: () => !!store && store.current.innerLoop !== false,
    gate: () => ({ petVisible: !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(), dragging: !!petWindowDrag?.active,
      userTyping: Date.now() < userInputUntil, speaking: replySpeechBusy() || ambientSpeakingOwners.size > 0 || proactiveSpeechGate.busy,
      chatting: [...pending.values()].some(task => task.kind === 'chat'), playing: rps.host.active, claudeAvailable: chatAvailability.isAvailable(),
      idle: companion.mood.get().snapshot.phase === 'idle' }),
    note: (owner, note) => windows().find(win => win.webContents.id === owner)?.webContents.send('desk:test-note', note),
    effect: effect => broadcast('desk:test-effect', effect),
    expression: recipe => playExpressionPreview(recipe).petVisible,
    action: id => herActions.play(id),
    directory: () => store ? store.directory : null,
  },
};
// 舞台 (wiring rewrite step 4g, electron/wiring/stage-wiring.ts): her window's presentation (R37), pointer input (click-through only on the
// transparent space around her), dragging, the topmost guard, the windows' visibility, where her line can show (herOnScreen, replySurface), the
// single-emoji window, her body pose and its authoring, the expression preview, her-life motions, the model profile, check and physics; made
// here, where the pointer input and the presentation were (before Unbound, the IPC guard and the shell); what they read, read when used.
wireHealth(parts); // step 7: the part runner, before any part's wiring
const stagePart = wireStage(parts);
// Unbound U1 (developer mode, 「Unbound（试验）」): her second stage beside her home one (electron/unbound/, docs/claude/2026-11-12-unbound-u1-part1.md);
// its wiring is electron/wiring/unbound-wiring.ts (unbound, unboundEntry, unboundTyping and petHeld come from there; the ready chain runs startUnbound).
let perceptionSwitches: PerceptionSwitches | null = null; // Unbound v1 step 1 (electron/unbound/entry.ts)
wireUnbound(parts);
const publishSenses = () => unbound?.senses(sensesFrom(media.state, systemAudio.state.active)); // Unbound v1 step 2: the small light near her follows the senses in use
// Wiring rewrite step 3 (electron/wiring/): the IPC guard, the shell and secureWindow's subscribers read the app through these getters.
wireIpc({ windows, controls: () => controls });
wireShell(parts);
wireLifecycle([windowEvents]);
// secureWindow's order (electron/wiring/window-events-wiring.ts): every listener a window gets, in registration order (one event's listeners
// run in this order), each running its steps in order; a step is its part's (electron/wiring/<part>-cleanup-wiring.ts and the part's
// wiring file). The wiring golden reads this list in place (order.secureWindow). A part's new window cleanup: a step in its file, one entry here.
wireWindowEvents({
  helpers: [revokeAmbientOwner, releaseAmbientOwner, revokeVisionOwner, releaseHiddenCamera, interruptOwnedTasks, publishVisibility],
  listeners: [
    ['win', 'hide', [dropMotionWeightsOwner]],
    ['win', 'closed', [dropMotionWeightsOwner]],
    ['webContents', 'render-process-gone', [dropMotionWeightsOwner]],
    ['webContents', 'destroyed', releaseAmbientOwner],
    ['webContents', 'render-process-gone', releaseAmbientOwner],
    ['webContents', 'did-start-navigation', [onNewDocument]],
    ['webContents', 'render-process-gone', interruptOwnedTasks],
    ['webContents', 'render-process-gone', [stopSurprisePreview, revokeWindowVoiceInput]],
    ['webContents', 'render-process-gone', [revokeVisionOwner, dropWindowSpeech, petPageGone]],
    ['webContents', 'render-process-gone', [invalidateCompanionCommands, cancelPetMemorial]],
    ['webContents', 'did-start-navigation', [invalidateCompanionCommands]],
    notePetWindow,
    ['win', 'show', publishVisibility],
    ['win', 'hide', publishVisibility],
    ['win', 'hide', [closeControlsTools]],
    ['win', 'minimize', [stopSurprisePreview]],
    ['win', 'minimize', publishVisibility],
    ['win', 'restore', publishVisibility],
    ['webContents', 'did-finish-load', publishVisibility],
    guardWindowNavigation, // the security half (electron/wiring/shell-wiring.ts)
    ['webContents', 'destroyed', [stopSurprisePreview, closeLanguageAuthoring, closeWindowAuthoring, clearClosedWindowVision, dropWindowSpeech, petWindowClosed,
      interruptOwnedTasks, stopPetSystemAudio, cancelClosedWindowDownload, abortWindowTasks, cameraOffWithControls, dropClosedMediaOwner]],
  ],
  newDocument: [stopSurprisePreview, revokeWindowVoiceInput, revokeVisionOwner, resetPetBody, cancelPetDrag, interruptOwnedTasks, dropWindowSpeech, revokeAudioOwner,
    stopPetSystemAudio],
  visible: [refreshCompanionCommands],
  visibleWhileOpen: [revokeHiddenVoiceInput, checkVoiceCall, releaseCameraOffScreen, notePetBodyVisible, petHidden, sendNativeVisibility, refreshVisionOnVisibility],
});
let store: SettingsStore;
// 角色卡 (wiring rewrite step 4, electron/wiring/cards-wiring.ts): its handlers and the C1 model-card helpers; what it reads, read when used.
const cards = wireCards(parts);
const { splitCharacterFromModelAtStartup, adoptCharacterForModel, syncCharacter } = cards.provides;
// 记忆 (wiring rewrite step 4d, electron/wiring/memory-wiring.ts): the profile with her diary and look-backs, her note, the moving memory, plans, chat notes,
// recall by meaning, text memorials, the privacy registries (数据地图) and the recycle bin (I-144); what they read, read when used.
const memory = wireMemory(parts);
const { activateUserProfile, initTextMemorials, songsBin } = memory.provides;
// 数据地图 (wiring rewrite step 4d): 安全's Claude 助手 is registered here, for its owner, until 安全's wiring moves out of main.ts (electron/wiring/
// memory-wiring.ts registerPrivacyStores); 主动's stores are registered by electron/wiring/initiative-wiring.ts (step 4e).
let recycleAssistant: RecycleStores['assistant'] = null; // I-144b: the Claude 助手, set when the agent channel makes it
registerPrivacyStores('safety', { recycle: () => ({ assistant: recycleAssistant }), recordingOff: () => ({}) });
const recentLines = (): string[] => { try { return companion.recentChat().messages.slice(-3).reverse().map(message => message.content); } catch { return []; } }; // I-049: the lines before the user's, for the keyword match
// The guards also need a clock when nothing else happens; the tally is one line a minute (counts only, nothing when the minute was quiet).
setInterval(() => { if (readingPaused['system-audio'] || readingPaused.microphone || ambientSpeakingOwners.size > 0 || replySpeechBusy()) suspendAmbientSpeech(); }, 30_000).unref();
setInterval(() => { const counts = listenTally.take(); if (counts) try { appJournal.record({ type: 'listen-tally', characterId: journalCharacterId(), ...counts }); } catch { /* same */ } }, 60_000).unref();
setInterval(() => { void watchTogether?.tally().then(counts => { if (counts) appJournal.record({ type: 'watch-tally', characterId: journalCharacterId(), ...counts }); }).catch(() => {}); }, 60_000).unref(); // I-048: counts and timings only
let moodTimer: ReturnType<typeof setInterval> | null = null;
// 声音 (wiring rewrite step 4, electron/wiring/voice-wiring.ts): her reading voice (speech runtime, frozen reply styles, the reply's sentence plan
// and its display proofs, read-aloud cancel, speech scope), the voice call (I-091) and its VAD, the Drama 3 budget (I-070), the speech log (R02),
// the playback lease; what they read, read when used. Made here, as the voice call was: the chat's Claude process below reads the call's timing.
const voice = wireVoice(parts);
wireVoiceCleanup(voice.provides); // its window steps (electron/wiring/voice-cleanup-wiring.ts)
const { replySpeechStyles, completedReplySpeech, voiceCall, speechRuntime, callStreamingSpeech, speechPlaybackActivity, cancelCompletedReply, replySpeechBusy,
  clearReplySpeech, cancelReplyStyle, speechScope, beginInitiativeSpeech } = voice.provides;
// 大脑 (wiring rewrite step 4h, electron/wiring/brain-wiring.ts): her chat process and its switches (I-098 speak-only, I-134 the new chat, I-139),
// when Claude cannot answer, I-023 the module router, F7 停停说说 and her pace, R27 the reply timing, R41 chat settings, the tasks in flight
// (pending, launchTask, the authoring lease) and the chat turn (electron/wiring/brain-chat-wiring.ts); her conversation itself is made in the
// ready chain (startCompanion). Made here, where her chat process was (after 声音: its timing is the voice call's); what they read, read when used.
const brainPart = wireBrain(parts);
// 体验记录 (E2, electron/memory/journal/): off by default; on, the hosts' moments go into <profile>/journal/<local date>.jsonl, never any text.
const buildCommit = readBuildCommit(path.join(__dirname, 'build-info.json'));
const appJournal = new AppJournal({ profileDirectory: () => store ? store.directory : null, enabled: () => !!store && store.current.experienceJournal === true,
  characters: () => characterCards ? characterCards.publicState() : null, publish: view => { if (controls && !controls.isDestroyed()) controls.webContents.send('desk:journal', view); } });
const journalCharacterId = (): string | null => { try { return companion?.mood.get().characterId || null; } catch { return null; } };
// 体验记录 第一批新记录项 (docs/claude/2026-11-06-journal-batch1.md): reading, voice timing, capture numbers, blush stage, launch.
const journalExtras = new JournalExtras({ sink: appJournal, characterId: journalCharacterId, callTurn: () => voiceCall.on, engine: () => voiceRoute.engine, uptimeMs: () => Math.round(process.uptime() * 1000), blushStage: stage => companion?.noteBlushStage(stage),
  musicReaction: value => companion?.mood.moments.musicReaction(value) ?? false, // I-077: a reaction she had while listening, a small gated mood moment
  gaze: value => userGaze.fact(value, { moment: () => companion?.mood.moments.eyeContact() ?? false, record: line => appJournal.record({ ...line, characterId: journalCharacterId() }) }) }); // I-081: closed words; eye contact only while pose says you face her
const songMemory = new SongMemoryHost({ directory: () => store ? store.directory : null, characterId: journalCharacterId }); // I-077 step 2: numbers only, per character, clearable
const turnAwareness = createTurnAwareness({ phase: () => companion?.mood.get().fatigue?.phase, characterId: journalCharacterId, reading: journalExtras.lastReading }); // second batch 6, 7, 10
// I-022 关应用也记 (electron/app-session/): this run's start, its last sign of life and how it quit; the next start reads how long it was closed.
const appSession = new AppSessionHost({ directory: () => store ? store.directory : null, characterId: journalCharacterId });
// I-084: with 「发图片」 on, one journal line per chat turn: whether she saw the user, and if not why (closed words; never a picture or the chat).
const cameraLookJournal = new CameraLookJournal(line => { appJournal.record({ type: 'camera-look', characterId: journalCharacterId(), ...line }); });
// 主动 (wiring rewrite step 4e, electron/wiring/initiative-wiring.ts): the proactive-speech gate, I-040 看一眼、听一下 (made here, before the reactions
// read its port), I-085 her own look (its timer starts here: early()), G1 猜拳, I-019's line, I-051 带我去, I-050 her folder and its keepsakes,
// I-059 special days, I-086 递东西, I-087 牵手, the inner loop and her urge (松绑), R20 offers, the cue chain; what they read, read when used.
const initiative = wireInitiative(parts);
initiative.early(); // I-085: her own look's timer starts while main.ts is evaluated, as before
const { initR20ProactiveOffers, claimMoodCue, cancelProactiveVision } = initiative.provides;
// 连接任务和安全 (wiring rewrite step 4, electron/wiring/safety-wiring.ts): the help card (I-117), the developer test commands (D2 / I-008),
// Claude tasks (R20) and the agent channel (I-014); what they read, read when used. The help card is core: made here, as before.
const safetyPart = wireSafety(parts);
const { crisisCard: safety, openCodexTaskConfirmation } = safetyPart.provides; // I-117: the help card outside her role (memory only; no text kept)
// 心情 (wiring rewrite step 4f, electron/wiring/mood-wiring.ts): I-027 the mood judge, I-037 the reactions (made here, where the reactions were:
// after 安全's help card and 主动's sense router, whose ports they take, and before 感知 takes both), I-136 the touch brain (where touches go is
// set here: early()), her tiredness's activity bridge, the mood tick's automatic-expression gate and the mood host's handlers; what they read, read when used.
const moodPart = wireMood(parts);
moodPart.early(); // I-136: where touches go is set while main.ts is evaluated, as before
const { syncFatigueActivity, completedFatigueFeeling } = moodPart.provides;
/** B06 feeding cues: fixed short texts in the character's Bailian voice, beside (never through) speechRuntime. */
const feedCueSynth = new FeedCueSynth();
wireMemoryCleanup(parts); // 记忆's quit steps write the journal's stop line (electron/wiring/memory-cleanup-wiring.ts)
wireCardsQuit(appConversion); // 角色卡: quitting cancels a running conversion and waits for it (electron/wiring/cards-ready-wiring.ts)
let cameraEnabled = false;
// 感知 (wiring rewrite step 4c, electron/wiring/senses-wiring.ts). 听: voice input and its recognizer, the computer's sound, the old ambient
// listening, 读取音频, 一起听 / 一起看 (initAmbientAudio, in the ready chain), the pause guards. 看: the camera, microphone and screen switches
// and what follows a change, camera and screen capture, the look, the visual state, her proactive visual topic (R10), her visual self,
// watch-along, where you are. What they read, read when used. Made here, where the switches were made.
const senses = wireSenses(parts);
wireSensesCleanup(senses.provides); // its window steps (electron/wiring/senses-cleanup-wiring.ts)
const { ambientSpeakingOwners, readingPaused, listenTally, systemAudio, voiceRoute, ambientAsr, foregroundAsr, voiceHost, noteStuck, voiceCurrent, revokeVoice, stopSystemAudio, cancelAmbientPlayback,
  suspendAmbientSpeech, readingContextIdentity, readingActive, syncAudioCapture, allowsOwnedMedia, currentAmbientSession, initAmbientAudio,
  media, visionSupport, visualSelfRuntime, cameraSamples, screenSnapshots, lookTurns, userGaze, cameraGlance, cameraEye, lookAttachments, screenGlance, watchAlong,
  visionPresentation, proactiveVision, lookScope, lookState, roughForTurn, visionEligible, visionState, publishVisionState, noteVisionUserActivity, clearVisionContext,
  refreshVisionContext, refreshVisualSelfContext, chatContextData, captureSharedCamera, presencePorts, mediaChanged, releaseCameraOnLeave, forgetScreenSelection } = senses.provides;
// I-017: what she hears and what her body does to it, for each chat turn's perception line and the inner loop (electron/mood/her-state-host.ts).
const stageState = new StageStateHost(), herState = createHerState({ stage: stageState, capture: () => audioCapture?.getState() ?? null, legacy: () => ambientAudio?.getState() ?? null, contacts: () => companion?.mood.recentContacts() ?? [], body: (contacts, food) => touchBrain.chatWords(contacts, food), /* I-136 */ scope: () => companion.currentSpeechScope(),
  food: () => feeding.host.recentFoodName(companion.mood.get().characterId), kind: () => listenKind.heardKind(), speaking: () => listenTogether?.spokenWithin() ?? false, activity: () => userActivity?.view() ?? null }); // I-006: the user is absorbed (told once per change) I-019: "用户刚才喂你吃了草莓蛋糕" I-016: and what the sound is
// I-016: music / show / talk / quiet from the stage's beat score and the recognizer's tags; consumers use listenKind.host (shared/senses/listen-kind.ts).
const listenKind = new ListenKindSource({ stage: stageState, hearing: () => hearingSource(audioCapture?.getState() ?? null, ambientAudio?.getState() ?? null) !== null }); listenKind.start(); ambientAsr.observe(heard => listenKind.noteHeard(heard));
const mutations = new MutationQueue();
// 设置 (wiring rewrite step 4, electron/wiring/settings-wiring.ts): the companion commands (pin, show, breath, follow the mouse, read-aloud volume,
// framing, stop reading), sync and the whole-settings save; what they read, read when used.
const settings = wireSettings(parts);
const { sync, fitSettingsScale, companionCommandContext, noteCompanionTopmostWrite, commitCompanionVisibility, commitCompanionCommand, commitCompanionReadoutVolume, commitCompanionBreath } = settings.provides;
// The order of both fan-outs is the order the old bodies had (steps: see syncVoiceScope and below).
wireSettingsSync([syncVoiceScope, syncBodyModel, syncBodySelection, syncSingleEmoji, syncMood, syncPetWindow, syncFatigue, syncWindowVisibility, broadcastSettings,
  syncVisionContext, syncUnbound, syncTray]);
wireSaveSettings([keepHostIntents, keepStaleAssetClears, modelChangeClearsMotion, saveCardPersona, saveMotionSelection, saveVisionReset, saveTtsKey, saveStopsSpeech,
  saveProviderStopsAudio, saveVoiceInputKey, saveProfileScope], [savedCompanionContext, savedSync, savedVisionState]);
// The mood publish (electron/wiring/mood-wiring.ts publishMood): each part's reaction to a new view, in the order the old callback had them;
// the mood judge sees the view last, as it is. 主动's and 感知's steps are bound to what only this file has first.
wireInitiativePublish(parts); wireSensesPublish(parts);
wireMoodPublish([publishEmojiContext, publishGateScope, publishVisionActivity, publishMemorials, publishR20, publishCue, judgeMood]);
const mutate = <T>(operation: () => Promise<T>): Promise<T> => mutations.run(operation);
// 身体动作 (wiring rewrite step 4, electron/wiring/actions-wiring.ts): her actions and the motion handlers; what it reads, read when used.
const actions = wireActions(parts);
wireStageCleanup(parts); // 舞台's window steps (electron/wiring/stage-cleanup-wiring.ts)
const { herActions } = actions.provides;
declareParts(stagePart, cards, memory, voice, brainPart, initiative, safetyPart, moodPart, senses, settings, actions);
/** Skeleton step 5: the small actions she may pick in a reply (electron/brain/chat-actions-host.ts); her pick is one cue above, the stage decides. */
const chatActions = new ChatActionHost({ modelPath: () => store.current.model?.path ?? null, play: action => herActions.play(action),
  read: async () => { const view = modelCapabilities ? await modelCapabilities.view() : null; return view ? { view, fits: motionFits?.get(view.modelKey) ?? null } : null; },
  speaking: () => replySpeechBusy() || speechPlaybackActivity.busy, mood: () => companion?.mood.get() ?? null, developerMode: () => !!companion?.mood.isDeveloperMode(), log: line => console.info(line),
  journal: (word, answer, waited) => { appJournal.record(herGestureInput(journalCharacterId(), word, answer, waited)); } });
// 设置: sync and the whole-settings save fan a settings change out to every part, step by step in the order below (electron/wiring/
// settings-wiring.ts wireSettingsSync / wireSaveSettings; the wiring golden pins both). The steps are each part's old lines, unchanged.
/** Save step (记忆): another provider scope suspends her profile scope; another persona drops what is pending. */
function saveProfileScope(next: AppSettings): void {
  if (memoryProviderScope(next.provider) !== memoryProviderScope(store.current.provider)) userProfileManagement?.suspendScope();
  else if (next.persona !== store.current.persona) userProfileManagement?.cancelPending();
}
/** Saved step (设置): every part catches up; the control window that saved gets no settings echo. */
function savedSync(): void {
  sync(controls?.webContents.id);
}
// Camera steps (they write cameraEnabled).
/** Window helper: off screen, a window gives up camera and look (I-171; a step away keeps her reply: I-174, senses-look-wiring.ts). */
function releaseHiddenCamera(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  releaseCameraOnLeave(win, owner);
  if (owner === 'controls') cameraEnabled = false;
}
/** Visibility step: a window that left the screen releases its camera. */
function releaseCameraOffScreen(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (!onScreen(win)) releaseHiddenCamera(win, owner, windowId);
}
/** Destroyed step: the control window closed: the camera permission ends. */
function cameraOffWithControls(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (win === controls) cameraEnabled = false;
}
wireSurprisePreview(parts); // 主动 (electron/wiring/initiative-handlers-wiring.ts): the surprise / shy preview's host, made here as it was
function registerIPC(): void {
  const agentOperations = recordAgentOperations(hostIpc()); // Agent channel: the control-window operations it may reuse.
  // Every part registers its handlers here, inside the agent channel's recorder (the wiring golden pins the handlers, flags and recording).
  registerSensesHandlers(partIpc('senses'), parts); // 感知 (electron/wiring/senses-handlers-wiring.ts): the offline components' import dialogs, the listen-kind line, the song memory
  stagePart.register(partIpc('stage')); // 舞台 (electron/wiring/stage-wiring.ts): the single emoji's settings, the expression preview, her-life motions, the model profile and check (I-024), the reply bubble, personalize visual and body authoring, physics, the companion window (view, visibility, topmost, recovery, presentation, dragging, pointer input, the mouse)
  settings.register(partIpc('settings')); // 设置 (electron/wiring/settings-wiring.ts): the companion commands and framing, getSettings, saveSettings, the interface language, 恢复默认设置
  initiative.register(partIpc('initiative')); // 主动 (electron/wiring/initiative-wiring.ts): 带我去, her folder, her hand, 我们的小东西, the inner loop's switch, R20 offers, 猜拳, the snack line, the sense line, her own line acknowledged
  safetyPart.register(partIpc('safety')); // 连接任务和安全 (electron/wiring/safety-wiring.ts): runTestCommand (D2), the help card (I-117), Claude tasks (R20) and their folder
  actions.register(partIpc('actions')); // 身体动作 (electron/wiring/actions-wiring.ts): her actions, body motions, gestures, the motion library
  moodPart.register(partIpc('mood')); // 心情 (electron/wiring/mood-wiring.ts): her mood view, developer mode, 自动表现, the music tier, the mood parameters, blush calibration, direct interaction, the mood judge's and the reactions' switches, her stage state (I-017), the colour-block log (I-031)
  registerJournalHandlers(partIpc('memory'), parts); // 记忆 (electron/wiring/memory-handlers-wiring.ts): 体验记录 (E2), the motion-glitch and journal-fact notes
  memory.register(partIpc('memory')); // 记忆 (electron/wiring/memory-wiring.ts): her chat memory (list, read, edit, delete into the bin), text memorials, the profile with her diary, plans and look-backs, the moving memory, the nickname, 一起听 records, chat notes, recall by meaning, the recycle bin, a heard transcript
  brainPart.register(partIpc('brain')); // 大脑 (electron/wiring/brain-wiring.ts): R41 chat settings, her small actions, her recent chat, a new conversation, the F7 voice trial, the chat availability operations, I-134 her greeting, the model aliases, the chat turn and its cancel
  registerSurprisePreview(partIpc('initiative')); // 主动 (electron/wiring/initiative-handlers-wiring.ts): the surprise / shy preview, control window only
  registerMusicSettings(partIpc('senses')); // 感知 (electron/wiring/senses-music-wiring.ts): M1 the music settings
  voice.register(partIpc('voice')); // 声音 (electron/wiring/voice-wiring.ts): reading aloud, its playback lease and cancels, the feeding cue, the voice call and its VAD, the TTS pages, Drama 3
  senses.register(partIpc('senses')); // 感知 (electron/wiring/senses-wiring.ts). 看: the switches, the vision state and options, typing and input notes, the look offer, camera samples and frames, a message's frames, 「截取画面」, where you are. 听: 读取音频 and audio capture, the audio dance, the computer's sound and the old ambient listening, its transcripts and comments, voice input
  // The session's camera permission stays with the trunk's state it sets (cameraEnabled: the window events and the permission handler read it).
  host("setCameraPermission", (enabled: unknown) => {
    cameraEnabled = enabled === true;
  });
  registerShell(partIpc('shell')); // the shell (electron/wiring/shell-wiring.ts): openControls (I-065: an optional page, as 「带我去」)
  const memoryRecovery = startRecycleBin(); // 记忆 (electron/wiring/memory-wiring.ts): I-144 the app's one bin and its host (loaded now, purged hourly); I-014 the agent channel's delete_memories / restore_memories
  cards.register(partIpc('cards')); // 角色卡 (electron/wiring/cards-wiring.ts): its handlers, after the recycle bin they delete into
  // Agent internal channel (三方互通 on by default, I-014): reuses the operations above exactly as the control window would.
  // Its commits re-check the call's guard right before they take effect (agent-channel/host-actions.ts). The recorder stops here: every
  // part registered above (tests/wiring-parts.test.ts checks it). electron/wiring/safety-wiring.ts startAgentChannel makes the switches and the channel.
  const agentOperationsRecorded = agentOperations.done();
  perceptionSwitches = safetyPart.startAgentChannel(agentOperationsRecorded, partIpc('safety'), { // Unbound v1 step 1: the switches set_perception uses
    broadcast, chatSettings, ...chatDiagnosticFacts(), recoverable: memoryRecovery, recycleBin: recycleBin ?? undefined, songs: songsBin, assistantRecycle: assistant => { recycleAssistant = assistant; return () => recycleSingle(() => takeAssistantChat(recycleStores()), () => assistant.clear()); }, // I-144b: both into the recycle bin first; // I-077 step 2: clear_song_memory; I-144: the app's one bin
    settingChanged: (id, previous, value, via) => appJournal.setting(id, previous, value, via, journalCharacterId()),
    wordsUsed: use => appJournal.agentWords(use, journalCharacterId()), // I-025: item, value and the words' length only
    linkChecked: check => { appJournal.record({ type: 'claude-link', characterId: journalCharacterId(), ...check }); }, // I-061: link state, failure category, Claude Code version only
    diagnosticFacts: () => ({ commit: buildCommit, channel: installedDesktopChannel?.channel, journalEnabled: store.current.experienceJournal === true, entries: () => appJournal.writer.recent() }), // I-061: 「复制诊断信息」
    planCharacterCardUpdate: (id, content) => cards.provides.planCharacterCardUpdate(id, content), // C3: read only; the update itself is guarded below.
    conversion: { characterCards: () => characterCards, memory: () => companion.memory, relationship: () => companion.relationship, profiles: () => userProfiles ?? null, // I-071 v2 第三步 转换 (electron/cards/character-convert/)
      providerScopes: memoryRecovery.providerScopes, currentProviderScope: () => memoryProviderScope(store.current.provider),
      addCard: (id, draft, model) => mutate(async () => { const previous = characterCards.getActive(); await characterCards.addConverted(id, draft, model); return syncCharacter(false, previous); }),
      removeCard: id => mutate(async () => { const previous = characterCards.getActive(); if (previous.id === id) return; await characterCards.remove(id); return syncCharacter(false, previous); }) },
    ...agentHostActions({ mutations, registerAsset: (file, guard) => assets.register(file, guard),
      noteModelSelection, // Same steps as selectAsset('model') (electron/wiring/actions-wiring.ts).
      persistModel: async asset => { await store.persist({ ...store.current, model: asset, motion: null, motionLayers: undefined }); await adoptCharacterForModel(asset); },
      sync, importCharacterCard: cards.provides.importCharacterCardContent, updateCharacterCard: cards.provides.updateCharacterCardContent, commitPetBoolean: commitCompanionCommand,
      commitReadoutVolume: commitCompanionReadoutVolume, commitBreath: commitCompanionBreath }) });
  registerQuit(partIpc('shell')); // the shell: 退出, after the recorder stopped (the agent channel never quits the app)
}

if (hasLock) {
  // 正常退出开关 (electron/graceful-quit.ts): the same app.quit() as the tray's 退出; nothing while quitting (electron/wiring/startup-wait-wiring.ts)
  wireSecondInstance({ quit: () => { appSession.noteCause('quit-request'); app.quit(); }, show: showControls });
  app
    .whenReady()
    .then(async () => {
      store = new SettingsStore(app.getPath("userData"), safeStorage, assets);
      startMotionStores(store, assets); // 身体动作 (electron/wiring/actions-wiring.ts): the bundled assets, the motion library, the tag annotations
      const hasSavedSettings = await stat(path.join(store.directory, "settings.json")).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
      const geneProfile = await inspectGeneProfile(store.directory); // Before any initialization writes.
      await store.load();
      await startUiLanguage(store); // 设置 (electron/wiring/settings-wiring.ts): the interface language
      // GET/HEAD of approved model-folder files; a UTF-8 PMX is served with UTF-16LE text (docs/claude/2026-11-02-pmx-utf8.md).
      protocol.handle("mmd-asset", createAssetProtocolHandler({
        resolve: url => assets.resolve(url),
        fetchFile: url => net.fetch(url),
      }));
      const webPreferences = {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: true,
        autoplayPolicy: "no-user-gesture-required" as const,
      };
      controls = new BrowserWindow({
        width: 1260,
        height: 850,
        minWidth: 960,
        minHeight: 680,
        title: PRODUCT_NAME,
        backgroundColor: "#11121b",
        show: false,
        webPreferences,
      });
      const area = screen.getPrimaryDisplay().workArea;
      // Test launches open her away from the user's own companion (electron/stage/pet-placement.ts).
      const petAt = initialPetPosition(area, process.env, installedDesktopChannel?.channel);
      pet = new BrowserWindow({
        width: 400,
        height: 560,
        x: petAt.x,
        y: petAt.y,
        transparent: true,
        backgroundColor: "#00000000",
        frame: false,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        alwaysOnTop: false, // sync() sets it at the top-of-band level; the creation option is 'floating' (behind the taskbar, electron/stage/pet-topmost.ts)
        show: false,
        title: t("soft hearts · 桌宠"),
        webPreferences,
      });
      for (const win of windows()) secureWindow(win);
      guardSession({ systemAudio, stopSystemAudio, allowsOwnedMedia }, () => cameraEnabled); // display-media and permissions (electron/wiring/shell-wiring.ts)
      const windowsLoaded = loadWindowsEarly(controls, pet); // step 8: load now; an early call waits (shell-wiring)
      await startCardStore(store, geneProfile, hasSavedSettings); // 角色卡 (electron/wiring/cards-wiring.ts): the cards and their pictures
      startRealerExpiry(characterCards, mutate, syncCharacter); // I-112 B 更真实的情绪 that ran out (心情: electron/wiring/mood-wiring.ts)
      const initialGeneModel = await characterCards.needsInitialGeneModel(hasSavedSettings);
      if (!initialGeneModel) await splitCharacterFromModelAtStartup(); // C1, before anything reads the current card
      await startPhysicsSettings(store); // 舞台 (electron/wiring/stage-wiring.ts): the model physics switches
      await startMusicSettings(store); // 感知 (electron/wiring/senses-music-wiring.ts): M1 the music settings
      await startEmojiSettings(store); // 舞台: the single emoji's settings
      await startCardStickers(store); // 角色卡: the card stickers
      await startCardResponses(store); // 角色卡: the reaction profiles and personalised language
      await startPartStores(); // electron/wiring/ready-wiring.ts
      await startPersonalizeStores(store, characterCards); // 舞台: the personalize visual and body stores
      startLanguageAuthoring(store); // 角色卡: the language research (a chat call, never writable, on the chat's one lease)
      startPersonalizeAuthoring(); // 舞台: personalize visual and body authoring (their Claude calls are chat calls, never writable)
      await startBlush(store, bundledAssetManifest); // 心情 (electron/wiring/mood-wiring.ts): the blush calibration store, with the reviewed packed Gene entry when packed
      await startModelProfiles(store); // 舞台: the model profile cache
      await startMotionFits(store); // 身体动作: the motion fits (universal skeleton step 1)
      await startModelCapabilities(store); // 舞台: I-024 模型体检 (records, haiku's read-only look, 试一下 on her)
      store.current.persona = compileCharacterPersona(characterCards.getActive());
      await startCompanion(store, characterCards, appJournal, appSession, characterResponses, safety, watchAlong, herActions, chatActions); // 大脑 (electron/wiring/brain-wiring.ts): her conversation (the mood publish it is made with, electron/wiring/mood-wiring.ts publishMood) and the sources it is handed
      await startMemory(store, companion, activateUserProfile, initTextMemorials, initR20ProactiveOffers, initAmbientAudio, __dirname); // 记忆 (electron/wiring/memory-wiring.ts): the profile and her diary, look-backs, her note, the moving memory; text memorials, R20, 一起听; plans, recall by meaning, chat notes
      if (initialGeneModel) {
        const defaults = await bundledAssets.getDefaultAssets();
        await store.persist({ ...store.current, ...defaults });
        await characterCards.completeInitialGeneModel();
      }
      const fitted = fitSettingsScale(store.current);
      if (fitted.pet.scale !== store.current.pet.scale)
        await store.persist(fitted);
      await mkdir(path.join(store.directory, "chat"), { recursive: true });
      controls.on('closed',()=>characterStickerHost?.cancel());
      // I-022: Windows shutdown, restart or log off never reaches before-quit; the stop is written synchronously here instead.
      for (const win of [controls, pet]) win.on('session-end', () => { appJournal.appQuitting(app.getVersion(), buildCommit, journalCharacterId(), appSession.stop('session-end')); });
      controls.webContents.on('did-start-loading',()=>characterStickerHost?.cancel());
      controls.webContents.on('render-process-gone',()=>characterStickerHost?.cancel());
      app.once('before-quit',()=>characterStickerHost?.dispose());
      petReply = new PetReplyWindow(pet, bubble => companion.mood.decideReplyLinger(bubble)); // #5: she decides how long a finished reply stays
      startStageWindows(pet, petReply); // 舞台: the single-emoji window and its cues, dragging, the topmost guard (I-062)
      startUnbound(partIpc('unbound').host); // Unbound (electron/wiring/unbound-wiring.ts): her host, getUnbound / setUnbound / toggleUnbound (outside the agent channel's recorder, as before), entry, typing
      attachPetWindow(pet); // 舞台: R37's presentation notes, a contact ends on blur, a drag finishes or ends with the window
      attachChatWindows(pet, controls); // 大脑: her chat process closes on a new context and keeps warm while she is seen
      // The selected screen follows her display; crossing a display revokes pending frames.
      pet.on('move', refreshVisionContext);
      screen.on('display-removed', refreshVisionContext);
      screen.on('display-metrics-changed', refreshVisionContext);
      startKeepInArea(pet); // 舞台: a moved or resized taskbar, a DPI change or a removed display must not leave her over the taskbar strip
      controls.on("close", (event) => {
        if (!exiting && tray) {
          event.preventDefault();
          cameraEnabled = false;
          controls?.hide();
        }
      });
      pet.on("close", (event) => {
        if (!exiting) {
          event.preventDefault();
          void togglePet();
        }
      });
      createTray(showControls);
      startPoseAndFace(__dirname); // 感知 (electron/wiring/senses-wiring.ts): local pose sensing (I-001) and the face check (I-135)
      const faceReady = faceCheck?.host.init() ?? Promise.resolve();
      startLocalAsr(__dirname); // 感知: voice input's own recognizer on this computer (electron/senses/asr/)
      registerIPC();
      startFatigueActivity(store); // 心情 (electron/wiring/mood-wiring.ts): sleep entry counts the real activity from here (found 2026-11-09)
      // The 1-second clock (electron/wiring/clock-wiring.ts): its entries in their order, each reading what it reads at that tick.
      moodTimer = setInterval(() => clockTick({ diaryWriter, reviewWriter, herNote, syncFatigueActivity, screenGlance, userActivity, innerLoopHost, impulse, companion, faceCheck,
        refreshVisionContext, companionCanExpress, proactiveVisionEnabled, media, fatigueActivity, ambientComments, ambientAudio, readingActive, rps, moodCueOwner,
        proactiveVision, visionEligible }), 1_000);
      registerShortcuts(togglePet, () => unboundEntry); // Ctrl+Alt+P, Ctrl+Alt+U (electron/wiring/shell-wiring.ts)
      await windowsLoaded;
      void faceReady.catch(() => undefined).then(() => unboundEntry?.recover()); // Unbound v1 step 1: a stay that ended with the app dying is put back
      if(initialControlsVisible(!!store.current.model,companion.mood.isDeveloperMode(),store.current.pet.visible))controls.show();
      sync();
      petPresentation.arm('startup');
      // 体验记录: the cards as they are now, the newest lines back for the panel, then "应用启动" (version and commit).
      appJournal.characters(characterCards.publicState()); void appJournal.writer.loadRecent();
      appJournal.appStarted(app.getVersion(), buildCommit, journalCharacterId(), appSession.lastStop());
      if (bodyStartupProfile.recipeId) companion.mood.configureBodyQa(bodyStartupProfile.recipeId);
    })
    .catch((error) => {
      dialog.showErrorBox("soft hearts 启动失败", fatalStartDialog(error)); // step 7
      app.quit();
    });
}
// Before quitting (electron/wiring/quit-wiring.ts): every part's quit step, in this order, on each before-quit (a step may hold the quit
// while something it owns ends); then, once, the flush steps (the chats in flight first, then a conversion still saving, her conversation,
// the stores). A step is its part's (electron/wiring/<part>-cleanup-wiring.ts or the part's wiring file); the wiring golden reads both lists
// in place (order.beforeQuit). A part's new quit cleanup: a step in its file, one entry here.
wireQuit([noteQuitting, holdForPoseInference, holdForConversion, stopSensorProcesses, disposeSingleEmoji, releaseCompanionCommands, releaseProfile,
  disposeR20Offers, releasePetWindow, releaseUnbound, markExiting, releaseFatigue, stopPlaybackActivity, stopClock, stopVisionAndSound, stopSpeech,
  releaseClaudeTasks, disposeReplyWindow, cancelMotionDownloads, abortVoiceRecognition, endVoiceCall, releaseCapture, disposeInitiative, disposeLook,
  abortAllTasks, disposeChat, disposeGame, disposeRouting, disposeTogether, disposeMoodJudges, flushUserActivity, holdForFlush, releaseShell],
  [waitForChats, conversionEnded, flushCompanion, flushMemoryNotes, stopWatching, flushMemoryStores]);
/** Quit step (trunk): the 1-second clock stops. */
function stopClock(): void {
  if (moodTimer) { clearInterval(moodTimer); moodTimer = null; }
}
/** Quit step (trunk): her reply window ends. */
function disposeReplyWindow(): void {
  petReply?.dispose();
}
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
