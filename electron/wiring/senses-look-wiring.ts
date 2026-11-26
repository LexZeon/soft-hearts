// 感知's wiring, 看 (docs/claude/2026-11-17-split-senses-wiring.md; moved from electron/wiring/senses-wiring.ts, which keeps wireSenses,
// the needs and the register entry; before that from electron/main.ts).
// 看: the camera, microphone and screen switches (MediaRuntime) and what follows a change (mediaChanged), camera and screen capture, the
//   look (lookTurns / lookAttachments / screenGlance / cameraGlance / closer look), the visual state, her proactive visual topic (R10),
//   her visual self, watch-along, where you are (I-081), 「截取画面」, and their 15 handlers. The camera and screen privacy gates are here
//   (tests/senses-privacy-gates.test.ts, tests/pose-privacy.test.ts, tests/camera-two-switches.test.ts, tests/screen-rough-only.test.ts).
// - wireLook runs last inside wireSenses (its switches take 语音输入's recognizer route on construction); everything it makes only stores
//   its ports on construction. At its end it hands 她听, 语音输入 and the sensor windows what they read from it.
// - State other parts read is module-level here and exported (senses-wiring.ts exports it again): userInputUntil, visionGeneration,
//   visionSupported, visionStatus, proactiveVisionEnabled; other parts write two of them through setVisionSupported / setVisionStatus.
// - The sync step, the save step and the saved step are top-level functions (electron/main.ts's step lists name them; the wiring golden
//   expands their bodies in place).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { ownLineYields, type OwnLineCause } from '../../shared/voice';
import { app, desktopCapturer, nativeImage, screen, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AppSettings, Attachment } from '../../shared/contracts';
import { t } from '../../shared/foundation/ui-language';
import { acceptVisionOptionsPatch, GLANCE_PROMPT, GLANCE_SYSTEM_PROMPT, listenWordsOn, SEE_AND_SAY, visionTopicPersonaTail, type CameraLookMiss, type ScreenLook, type VisionRuntimeState } from '../../shared/senses';
import { cardLanguageOf, personalizeLanguageContext } from '../../shared/cards';
import { withSpeechLanguage } from '../../shared/brain';
import { proactiveChatFor } from './proactive-chat-wiring';
import { CameraGlance, CameraSampleBroker, CameraTrayEye, captureProactiveFrames, CloserLook, createWatchAlong, curiosityFrom, LookAttachments,
  LookTurns, PROACTIVE_VISION_DEFAULT, ProactiveVision, ScreenGlance, ScreenSnapshots, trayBitmap, UserGazeHost, VisionPresentationGuard,
  VisionProviderSupport, VisualSelfRuntime, WindowsForegroundProbe, type VisualSelfLease, type VisualSelfSnapshot } from '../senses';
import { MediaRuntime, callGlancesRevoked, cameraImagesRevoked, type MediaOwner } from '../senses/media-runtime';
import { visionContextChange, visionContextKey } from '../senses/vision-context';
import { waitsForHer } from './quiet-wiring';
import { poseCameraPolicy } from '../senses/pose/electron-wiring';
import { chatAvailability, streamClaude } from '../brain';
import { quickLineWithClaude } from '../initiative';
import type { SettingsStore } from '../settings';
import { PROFILE_FOLDER } from '../profile';
import type { PartIpc } from './ipc-wiring';
import { broadcast, ownerFor, tray, windows } from './shell-wiring';
import { lifeFeeds, unbound } from './unbound-wiring';
import { relayCameraHeld } from './unbound-senses-wiring';
import { faceCheck, keepForSensorWindows, localAsr, poseSensing, userActivity, type SensesNeeds } from './senses-wiring';
import { audioCapture, audioReading, ambientComments, keepLookForListen, listenTogether, watchTogether, type ListenPart } from './senses-listen-wiring';
import { asrTask, keepLookForVoice, type VoiceInputPart } from './senses-voice-input-wiring';
import { wireSeeAndSay } from './see-and-say-wiring';
import { createAwayVision, leaveClearsVision } from '../../shared/foundation/step-away';
import { screenCaptures } from '../senses';
import { registerScreenSource, screenSourceChoice } from './screen-source-wiring'; // I-190

// State other parts read (live bindings) and, for two of them, write through the setters below.
/** Until when the user counts as typing or acting (her own lines hold back). Set by noteVisionUserActivity. */
export let userInputUntil = 0;
/** Bumped when the vision context ends or the user acts: a later look or line from before is stale. */
export let visionGeneration = 0;
/** Whether the current connection is known to take a picture (a chat with a picture that went through says yes). */
export let visionSupported = false;
/** The vision status line the windows show. */
export let visionStatus = '';
/** R10: her proactive visual topic (off until 识图第 3 步, electron/senses/look-turns.ts). */
export let proactiveVisionEnabled = PROACTIVE_VISION_DEFAULT; // R10 starts off until 识图第 3 步 (electron/senses/look-turns.ts)
/** Unbound step 4: the rough activity word of the program in front (sharing on, no "别看"), or null; memory only. */
export let screenActivityNow: () => string | null = () => null;
export function setVisionSupported(value: boolean): void { visionSupported = value; }
export function setVisionStatus(value: string): void { visionStatus = value; }

// The sync step and the save steps below call these (set by wireLook, which runs while electron/main.ts is evaluated, long before
// any sync or save).
let clearVisionContext!: (keepReply?: boolean) => void;
let refreshVisionContext!: () => string;
let publishVisionState!: () => void;
function keepForSteps(clear: () => void, refresh: () => string, publish: () => void): void {
  clearVisionContext = clear; refreshVisionContext = refresh; publishVisionState = publish;
}
/** Sync step (感知): what she sees follows the settings. */
export function syncVisionContext(): void {
  refreshVisionContext();
}
/** Save step (感知): another provider or persona starts what she sees over. */
export function saveVisionReset(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  if (JSON.stringify(next.provider) !== JSON.stringify(store.current.provider) || next.persona !== store.current.persona) {
    clearVisionContext(waitsForHer('connection')); // 2026-11-25: after her reply
    visionSupported = false;
    visionStatus = '';
  }
}
/** Saved step (感知): the windows learn what she can see now. */
export function savedVisionState(): void {
  publishVisionState();
}

/** 看, made last: its switches (MediaRuntime) take 语音输入's recognizer route on construction. */
export function wireLook(needs: SensesNeeds, listen: ListenPart, voice: VoiceInputPart) {
  // The other parts' functions the moved lines call (electron/main.ts's wrappers read its own functions when called).
  const { cancelProactiveVision, syncFatigueActivity, replySurface, herOnScreen, onScreen, nativeVisibility, publishSenses, journalCharacterId,
    speechScope } = needs;
  // Made before wireSenses runs and never replaced.
  const { appJournal, proactiveSpeechGate, selfLook, voiceCall } = needs;
  // 她听's and 语音输入's (electron/wiring/senses-listen-wiring.ts, senses-voice-input-wiring.ts).
  const { cancelAmbientPlayback } = listen.provides;
  const { syncAudioCapture, voiceRoute, revokeVoice } = voice.provides;
  // ---- 看
  const media = new MediaRuntime(() => syncAudioCapture(), poseCameraPolicy(() => poseSensing), voiceRoute.policy); // no pose host: the camera is refused as 'unavailable', never shared instead
  // One host gate serves visual and audio opportunities.
  const visionSupport = new VisionProviderSupport();
  let visionContextIdentity = '';
  const awayVision = createAwayVision(); // I-171
  const visualSelfRuntime = new VisualSelfRuntime();
  let visualSelfIdentity = '';
  let visualSelfRevision = 0;
  let visualSelfScreenSourceId: string | null = null;
  // no-pet-ok: needs.pet is the companion window's existing name
  const captures = screenCaptures({ media, companion: () => needs.pet, onScreen, capturer: desktopCapturer, displayOf: win => screen.getDisplayMatching(win.getBounds()), intervalSeconds: () => screenSnapshots.state.intervalSeconds, pick: (id, size) => screenSourceChoice().source(id, size),
    visualSelf: () => ({ runtime: visualSelfRuntime as never, sourceId: visualSelfScreenSourceId }) }); // the shared screen's two reads (senses-screen-capture.ts)
  const captureGlanceThumbnail = (signal: AbortSignal) => captures.glance(signal), captureSharedScreen = (id: string, signal: AbortSignal) => captures.shared(id, signal);
  let visualSelfCameraOwnerId: number | null = null;
  const cameraSamples = new CameraSampleBroker((owner, id) => {
    const win = windows().find(win => win.webContents.id === owner);
    if (!win || !onScreen(win)) throw new Error('Camera owner unavailable');
    win.webContents.send('desk:camera-sample', id);
  });
  const screenSnapshots = new ScreenSnapshots({ capture: captureSharedScreen });
  // 识图第 1 步: which frames a message carries (none unless the user asks her to look; electron/senses/look-turns.ts). Her "要我凑近看看吗"
  // opening or closing shows or hides the companion's "让她看清楚屏幕吗？" (屏幕只读大概, src/senses/LookOfferPrompt.ts).
  const lookTurns = new LookTurns(Date.now, offer => broadcast('desk:look-offer', offer), { holds: SEE_AND_SAY.holdOnNo }); // I-168: "别看" holds nothing
  const lookScope = () => { try { return `${speechScope()}|${media.revision}`; } catch { return ''; } };
  const lookState = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: lookScope(), screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  // I-036 「发图片」: the small frame a message carries, kept ready by the owner window (never captured on send); with 「姿势识别」 also on,
  // only when the pose changed or none went for 10 minutes (electron/senses/camera-glance.ts). The tray eye shows while either switch is on.
  // I-081: the latest pose position and screen interest for her gaze, memory only; the companion window polls it (userGaze).
  const userGaze = new UserGazeHost();
  const cameraGlance = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => media.state.cameraLocal === true,
    signal: () => poseSensing?.latestSignal() ?? null, opening: () => media.openings.camera });
  const cameraEye = new CameraTrayEye((eye, tip) => { tray?.setImage(nativeImage.createFromBitmap(trayBitmap(eye), { width: 24, height: 24 })); tray?.setToolTip(t(tip)); });
  // 识图第 1 步: the frames a message carries, decided first and taken only after a yes (electron/senses/look-attachments.ts).
  const closerLook = new CloserLook({ curiosity: () => { try { return curiosityFrom(needs.companion?.mood.get() ?? null); } catch { return null; } }, sight: () => { const { companion } = needs; return companion ? watchTogether?.session.sight(companion.currentScope().characterId) ?? null : null; } }); // I-085 第 3 步: her own closer look while watching together
  // I-166: a small frame from each sense that is on (no "别看"), every turn; her own closer look.
  const seeing = () => ({ camera: media.sharesCameraFrames() && !!media.state.cameraOwner && media.state.cameraHeld !== true, screen: media.state.screenSharing === true && !lookTurns.refusedIn(lookState()) });
  const see = wireSeeAndSay({ seeing, screenKey: () => `${media.openings.screen}|${media.revision}|${visionGeneration}`, thumbnail: signal => captureGlanceThumbnail(signal), fromDataURL: url => nativeImage.createFromDataURL(url), language: () => cardLanguageOf(needs.characterCards.getActive()),
    sampleCamera: signal => { const owner = windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner); if (media.sharesCameraFrames() && owner) return captureSharedCamera(owner.webContents.id, signal); return Promise.resolve(null); },
    journal: entry => appJournal.record({ type: 'see-and-say', characterId: journalCharacterId(), ...entry }) });
  const lookAttachments = new LookAttachments(lookTurns, {
    ...see.lookPorts,
    noteActivity: () => { noteVisionUserActivity(); refreshVisionContext(); },
    state: lookState,
    sharesCameraFrames: () => media.sharesCameraFrames(),
    revision: () => media.revision,
    generation: () => visionGeneration,
    opening: source => media.openings[source], // 关掉之后的旧帧: a frame is sendable only in the opening it was taken in
    captureScreen: (signal, miss) => screenSnapshots.sampleOnce(signal, miss), refreshContext: () => { refreshVisionContext(); }, // 2026-11-22: her closer look's one retry
    watchingTogether: () => media.state.screenSharing === true && !!listenTogether && listenWordsOn(audioReading?.getView()), // 和她一起看: every message takes the screen
    curious: () => closerLook.claim(), // I-085 第 3 步: text first; a frame only when asked, pointed at, or she very much wants a closer look
    captureCamera: async (signal, miss) => {
      const owner = windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner);
      // Local pose sensing: no camera picture ever reaches chat (also checked here, at the call, like every camera capture).
      if (media.sharesCameraFrames() && owner) return captureSharedCamera(owner.webContents.id, signal, miss);
      miss?.(media.sharesCameraFrames() ? 'no-window' : 'off');
      return null;
    },
    glance: everyTurn => cameraGlance.take(everyTurn), seenCamera: () => cameraGlance.seen(), // I-166: every turn, also with 「姿势识别」 on
    holdCamera: held => { const previous = { ...media.state }; if (media.holdCamera(held)) mediaChanged(previous); },
  });
  // 屏幕只读大概 (I-015): with sharing on, an ordinary message carries no picture; she knows roughly
  // what the user does from the program in front (its file name only, mapped here to an activity and never sent), and for a program the
  // table cannot tell, one 320×200 thumbnail the small model names in one word, in the background (electron/senses/screen-glance.ts).
  const screenGlance = new ScreenGlance({
    probe: process.platform === 'win32' ? new WindowsForegroundProbe() : null,
    thumbnail: signal => captureGlanceThumbnail(signal),
    classify: async (picture, signal) => (await quickLineWithClaude(GLANCE_PROMPT, GLANCE_SYSTEM_PROMPT, signal, undefined, [picture])).text,
    mayLook: () => media.state.screenSharing && !lookTurns.refusedIn(lookState()) && chatAvailability.isAvailable(),
    idleSeconds: () => userActivity?.idleSeconds() ?? null, interactionsLastHour: () => needs.companion.interactionsLastHour(), // I-006 step 3: a browser video may get one look
  });
  // I-006 step 3 跟着看: what the user watches or plays on the shared screen (a category word only; null with sharing off), for her own life.
  const watchAlong = createWatchAlong({ sharing: () => media.state.screenSharing, refused: () => lookTurns.refusedIn(lookState()), activity: () => screenGlance.watching() });
  // Unbound step 4: her own life reads the same category word, under the same two conditions (sharing on, no "别看"); never a name.
  screenActivityNow = () => media.state.screenSharing && !lookTurns.refusedIn(lookState()) ? screenGlance.watching() : null;
  lifeFeeds.screenActivity = () => screenActivityNow();
  lifeFeeds.pose = () => poseSensing?.latestSignal() ?? null; // read only while she is out (shared/unbound/life/signals.ts)
  lifeFeeds.activityState = () => userActivity?.view().state ?? 'unknown';
  /** This turn's rough reading: only with sharing on and no "别看" holding (then her line says nothing about what the user does). */
  const roughForTurn = () => media.state.screenSharing && !lookTurns.refusedIn(lookState()) ? screenGlance.rough() : undefined;
  const visionPresentation = new VisionPresentationGuard({
    surface: replySurface,
    identity: () => { try { return `${speechScope()}:${visionGeneration}`; } catch { return ''; } },
    eligible: visionEligible,
  });
  const proactiveVision: ProactiveVision = new ProactiveVision({
    gate: proactiveSpeechGate,
    current: () => visionEligible(), unable: (id, stage) => needs.innerLoopHost.opening.unable(id, stage), // I-020 #10 备选: no frame or no line, she may pick once more
    capture: async signal => {
      const { store } = needs; // read when called
      const generation = visionGeneration;
      const supported = await visionSupport.supports({ ...store.current.provider }, signal);
      signal.throwIfAborted();
      if (generation !== visionGeneration) throw new Error('Vision context changed');
      visionSupported = supported;
      if (!visionSupported) {
        visionStatus = '当前连接的图像能力未确认；API 模型可先发送一次附图验证。';
        publishVisionState();
        return [];
      }
      visionStatus = '';
      publishVisionState();
      return captureProactiveFrames({ screenOn: () => media.state.screenSharing, screen: s => screenSnapshots.sampleOnce(s), media,
        camera: async s => {
          const owner = windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner);
          if (media.sharesCameraFrames() && owner) return captureSharedCamera(owner.webContents.id, s);
          return null;
        } }, signal);
    },
    generate: async (attachments, signal) => {
      const { store, personalizeLanguage, characterCards, companion } = needs; // read when called
      const settings = structuredClone(store.current);
      const languageProfile = settings.provider.kind === 'claude' ? personalizeLanguage?.effectiveProfile(characterCards.getActive().id) : undefined;
      settings.persona += visionTopicPersonaTail(companion.mood.chatContext(), attachments.map(a => a.source), proactiveChatFor(() => ({ companion, characterCards }))(), cardLanguageOf(characterCards.getActive())); // I-178: + what you two talked about lately, and the spoken-words-only sentence
      const request = { id: proactiveVision.pendingId!, messages: [{ role: 'user' as const, content: '请依据明确开启的这一刻画面，生成一次简短主动话题。此句由应用触发，不是用户发言。' }], attachments };
      const visualLease = visualSelfRuntime.accept('accepted-proactive-vision', request.id, attachments, Date.now() + 60_000);
      let text = '';
      const append = (part: string) => { if (text.length + part.length > 2_000) throw new Error('Vision reply too long'); text += part; };
      try {
      if (settings.provider.kind === 'claude') await streamClaude({ kind: 'chat', model: settings.provider.model,
        workingDirectory: path.join(store.directory, 'chat'), writable: false,
        get prompt() { const data = visualSelfData(visualLease);
          return withSpeechLanguage(`${settings.persona}${personalizeLanguageContext(languageProfile)}${data ? `\n\n${data}` : ''}\n\n${request.messages[0].content}`, cardLanguageOf(characterCards.getActive())); },
        imageDataUrls: attachments.map(frame => frame.dataUrl), imageTemporaryRoot: path.join(app.getPath('temp'), PROFILE_FOLDER, 'chat') },
        signal, (type, value) => { if (type === 'delta') append(value); });
      return text;
      } finally { visualSelfRuntime.cancel(visualLease); }
    },
    offer: message => {
      const { pet } = needs; // read when called
      if (!visionEligible() || !pet || pet.isDestroyed()) return false;
      pet.webContents.send('desk:vision-initiative', { type: 'offer', message, ...unbound?.holdVisionLine(message), ...(userActivity?.presence().presence === 'meeting' ? { silent: true as const } : {}) });
    },
    present: (message, signal) => visionPresentation.present(message, signal),
    presentationCurrent: message => visionPresentation.current(message),
    cancelOffer: id => broadcast('desk:vision-initiative', { type: 'cancel', id }),
    archive: async message => {
      const { companion } = needs; // read when called
      const scope = companion.currentScope(), generation = visionGeneration, acceptedScope = speechScope();
      await companion.memory.appendInitiative(scope, { id: message.id, text: message.text, at: message.origin.at, origin: message.origin });
      if (generation !== visionGeneration || !visionEligible()) return;
      try { if (acceptedScope !== speechScope()) return; } catch { return; }
      broadcast('desk:vision-initiative-delivered', message);
      broadcast('desk:memory-changed', undefined);
    },
    onError: stage => { visionStatus = stage === 'archive' ? '主动画面话题的文字保存失败，请查看聊天记忆。' : '本次主动画面话题已跳过；不会重试采集或请求模型。'; publishVisionState(); },
  });
  function visionEligible(): boolean {
    const { companion, store, petWindowDrag, pending } = needs; // read when called
    return !!companion && !!store && proactiveVisionEnabled && (media.state.screenSharing || media.sharesCameraFrames())
      && herOnScreen()
      && !petWindowDrag?.active && Date.now() >= userInputUntil
      // New opportunities check speech busy state in the shared tick. A confirmed
      // presentation must remain valid while its own final PCM is playing.
      && companion.mood.get().snapshot.phase === 'idle'
      && ![...pending.values()].some(task => task.kind === 'chat');
  }
  function visionState(): VisionRuntimeState {
    return { autoCapture: false, intervalSeconds: screenSnapshots.state.intervalSeconds, // R09's switch stays retired; nothing keeps a frame in the background (屏幕只读大概)
      proactiveVision: proactiveVisionEnabled, supported: visionSupported, status: visionStatus };
  }
  function publishVisionState(): void { broadcast('desk:vision-runtime', visionState()); }
  /** You did something: nothing new of hers starts for a while; a line she is saying ends only for a clear intent (I-174: own-line.ts). */
  function noteVisionUserActivity(cause: OwnLineCause = 'input'): void {
    const keepLine = !ownLineYields(cause);
    userInputUntil = Date.now() + 15_000;
    visionGeneration++;
    visualSelfRuntime.cancelActive();
    cancelProactiveVision(true, keepLine);
    if (!keepLine) cancelAmbientPlayback();
    ambientComments?.interrupt();
    syncFatigueActivity();
  }
  /** I-161 A: the small frames a call's Claude process holds are dropped (electron/brain/claude-session.ts forgetFrames). */
  function forgetCallFrames(): void { try { needs.claudeChat?.forgetFrames(); } catch { /* not made yet, or closing: it holds none */ } }
  /** `keepReply` (I-174 9b): the page starts anew after her reply. `keepTalk` (I-221): her reply and the page stay. */
  function clearVisionContext(keepReply = false, keepTalk = false): void {
    const { surprisePreviewHost, languageAuthoring, visualAuthoring, bodyAuthoring } = needs; // read when called
    surprisePreviewHost?.invalidate();
    languageAuthoring?.invalidate();
    visualAuthoring?.invalidate();
    bodyAuthoring?.invalidate();
    visionGeneration++;
    visionContextIdentity = '';
    visualSelfIdentity = '';
    visualSelfScreenSourceId = null;
    visualSelfCameraOwnerId = null;
    visualSelfRuntime.clear();
    cancelProactiveVision(false, keepReply);
    lookAttachments.abort();
    forgetCallFrames(); // I-161 A: a call's small frames go with the context (her Claude process is replaced)
    lookTurns.clear(); // her "要我凑近看看吗" belongs to the context that just ended (the companion's prompt goes too)
    selfLook.cancel(); // I-085: what she saw belongs to the context that just ended
    media.clearCamera();
    screenSnapshots.configure({ sharing: false, visible: false, sourceId: null, scope: '' });
    broadcast('desk:vision-context-cleared', keepTalk ? { keepConversation: true } : keepReply ? { afterReply: true } : undefined);
  }
  /** A sense off or moved (I-221): what she was shown goes now; her reply and the page stay (a journal row while she is busy). */
  function sightOff(): void { waitsForHer('sight-off'); clearVisionContext(true, true); }
  /** Only her mood token rotated (electron/senses/vision-context.ts): her own looks under way and the previews stop; what she was shown stays. */
  function clearMoodScope(): void {
    const { surprisePreviewHost, languageAuthoring, visualAuthoring, bodyAuthoring } = needs; // read when called
    surprisePreviewHost?.invalidate(); languageAuthoring?.invalidate(); visualAuthoring?.invalidate(); bodyAuthoring?.invalidate();
    visualSelfIdentity = ''; visualSelfScreenSourceId = null; visualSelfCameraOwnerId = null; visualSelfRuntime.clear();
    selfLook.cancel(); cancelProactiveVision();
  }
  function refreshVisionContext(): string {
    const { exiting, store, companion, pet } = needs; // read when called
    if (exiting || !store || !companion) return '';
    let scope = '', speech = '';
    try { speech = speechScope(); scope = `${speech}:${companion.mood.get().token}`; } catch { speech = ''; /* transition */ }
    const visible = !!pet && onScreen(pet); // Unbound v1 step 2: her screen look still works while she is out (her companion window hidden but held)
    const display = visible ? screen.getDisplayMatching(pet!.getBounds()) : null;
    const away = awayVision({ visible, window: pet ?? null, /* no-pet-ok: the companion window */ displayId: display?.id ?? null }); // I-171: a minimize keeps the identity
    const identity = visionContextKey({ speech, scope, visible: away.visible, display: away.displayId, screen: media.state.screenSharing, camera: media.state.cameraSharing, cameraOwner: media.state.cameraOwner ?? null });
    const change = visionContextChange(visionContextIdentity, identity); // 2026-11-21: her mood token alone no longer retires the warm process
    if (change === 'seeing') clearVisionContext(); else if (change === 'off') sightOff(); else if (change === 'mood') clearMoodScope(); // 'grew': nothing to clear
    visionContextIdentity = identity;
    proactiveSpeechGate.setScope(scope);
    refreshVisualSelfContext(scope, display ? String(display.id) : null);
    screenSnapshots.configure({ sharing: media.state.screenSharing, visible, // 2026-11-22: her mood token alone no longer stops a screen read under way
      sourceId: display ? String(display.id) : null, scope: speech });
    return scope;
  }
  function refreshVisualSelfContext(scope?: string, displayId?: string | null): void {
    const { companion, pet, characterCards, store } = needs; // read when called
    try {
      if (scope === undefined) scope = `${speechScope()}:${companion.mood.get().token}`;
      const window = pet && !pet.isDestroyed() ? nativeVisibility(pet) : null;
      if (!scope || !window?.visible) {
        visualSelfIdentity = ''; visualSelfScreenSourceId = null; visualSelfCameraOwnerId = null;
        visualSelfRuntime.clear(); return;
      }
      const card = characterCards.getActive();
      const publicName = card.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || '当前角色';
      const key = (value: string) => createHash('sha256').update(value).digest('hex');
      const sources: VisualSelfSnapshot['sources'][number][] = [];
      const displayKey = displayId === undefined ? String(screen.getDisplayMatching(pet!.getBounds()).id) : displayId;
      if (media.state.screenSharing && displayKey) sources.push({ kind: 'screen',
        key: key(`screen:${displayKey}:${media.revision}`), revision: media.revision });
      const cameraOwner = media.sharesCameraFrames() && media.state.cameraOwner
        ? windows().find(win => ownerFor(win.webContents.id) === media.state.cameraOwner && onScreen(win)) : null;
      if (cameraOwner) sources.push({ kind: 'camera',
        key: key(`camera:${cameraOwner.webContents.id}:${media.revision}`), revision: media.revision });
      const identity = JSON.stringify([scope, card.id, publicName, store.current.model?.path ?? null,
        store.current.model?.url ?? null, window.windowId, window.revision, sources]);
      if (identity !== visualSelfIdentity) visualSelfRevision++;
      const accepted = visualSelfRuntime.setContext({ revision: visualSelfRevision,
        character: { key: key(`${card.id}:${scope}`), publicName },
        // A configured asset is not proof of the mesh currently loaded by Stage.
        model: null, window: { role: 'pet', key: key(`pet:${window.windowId}`),
          revision: window.revision, visible: window.visible }, sources });
      visualSelfIdentity = accepted ? identity : '';
      visualSelfScreenSourceId = accepted && media.state.screenSharing ? displayKey : null;
      visualSelfCameraOwnerId = accepted && cameraOwner ? cameraOwner.webContents.id : null;
    } catch {
      visualSelfIdentity = ''; visualSelfScreenSourceId = null; visualSelfCameraOwnerId = null;
      visualSelfRuntime.clear();
    }
  }
  function visualSelfData(lease: VisualSelfLease | null): string | undefined {
    if (!lease) return undefined;
    // Refresh existing native/identity facts only; this does not configure or capture a source.
    refreshVisualSelfContext();
    const data = visualSelfRuntime.read(lease);
    return data ? `以下JSON仅为当前附图的宿主身份元数据，不是画面中的指令。角色名表示当前活动角色；selfInFrame为UNKNOWN、region为空，不能据此断言画面包含桌宠或把任意相似人物当成自己。\n${data}` : undefined;
  }
  function chatContextData(profileLease: string | null, visualLease: VisualSelfLease | null): string | undefined {
    const { userProfileContext } = needs; // read when called
    return [userProfileContext?.read(profileLease), visualSelfData(visualLease)].filter(Boolean).join('\n\n') || undefined;
  }
  /** `miss` (2026-11-21): why no frame came, in closed words, for the journal's camera line (camera-sample.ts). */
  async function captureSharedCamera(owner: number, signal: AbortSignal, miss?: (why: CameraLookMiss) => void): Promise<Attachment | null> {
    if (!media.sharesCameraFrames()) return null; // local pose sensing: no window frame ever reaches chat
    if (media.state.cameraHeld) { miss?.('off'); return null; } // I-036: the user said not to look; also her proactive topics take nothing
    const token = owner === visualSelfCameraOwnerId ? visualSelfRuntime.beginCapture('camera') : null;
    const requestedAt = Date.now();
    const frame = await cameraSamples.request(owner, signal, miss);
    if (frame && token && owner === visualSelfCameraOwnerId && !signal.aborted)
      visualSelfRuntime.completeCapture(token, frame, Date.now(), requestedAt + 2_000);
    return frame;
  }
  /** I-066 你现在方便吗: her last interaction, the local camera's "somebody in front" (P1, only while it runs), the opt-in screen look (sharing on). */
  function presencePorts() {
    return { lastInteractionAt: () => needs.companion?.mood.get().snapshot.lastInteractionAt ?? null, person: () => poseSensing?.latestSignal()?.present === true ? true : null,
      screen: { on: () => media.state.screenSharing === true && !lookTurns.refusedIn(lookState()) && chatAvailability.isAvailable(), capture: (signal: AbortSignal) => captureGlanceThumbnail(signal) },
      looked: (look: ScreenLook | 'failed') => { appJournal.record({ type: 'presence-look', characterId: journalCharacterId(), look }); } };
  }
  /**
   * I-171, I-174 item 9b: a window that left the screen. A step away (her window minimized, or the control window hiding while she is here)
   * keeps the look's context, unless it releases its camera (privacy): then the context ends with her reply kept (the page starts the new
   * conversation after that reply: desk:vision-context-cleared { afterReply }), and the refresh after the release finds nothing left to end.
   */
  function releaseCameraOnLeave(win: BrowserWindow, owner: MediaOwner): void {
    const away = !leaveClearsVision(win, owner, herOnScreen()), camera = media.state.cameraSharing && media.state.cameraOwner === owner;
    if ((media.state.screenSharing || media.state.cameraSharing || proactiveVision.pendingId || lookAttachments.busy) && (!away || camera)) clearVisionContext(away);
    if (camera) {
      const previous = { ...media.state };
      media.update({ cameraSharing: false }, owner);
      mediaChanged(previous);
    }
  }
  let sourceSelection = { at: 0, ids: new Set<string>() };
  function mediaChanged(previous: typeof media.state): void {
    const { pending } = needs; // read when called
    const next = media.state;
    // Microphone on no longer stops her reading (2026-11-25); opening the capture waits for her reply.
    if (!next.voiceInput || previous.voiceOwner !== next.voiceOwner) revokeVoice('voice-off');
    if (!next.voiceInput || previous.voiceOwner !== next.voiceOwner)
      asrTask?.controller.abort();
    if (
      (previous.screenSharing && !next.screenSharing) ||
      cameraImagesRevoked(previous, next)
    ) {
      sightOff();
    }
    // 屏幕只读大概: no frame is kept in the background any more; the rough reading starts and stops with sharing,
    // and everything it knew is forgotten when sharing goes off.
    if (!next.screenSharing && screenSnapshots.state.enabled) try { screenSnapshots.setOptions({ enabled: false }); } catch { /* ended at quit */ }
    screenGlance.setSharing(next.screenSharing);
    refreshVisionContext();
    poseSensing?.syncCamera(next);
    faceCheck?.host.cameraChanged(); // I-135: camera off stops every face check at once
    if (!next.cameraImages) cameraGlance.reset();
    cameraEye.images(media.sharesCameraFrames());
    selfLook.mediaChanged(); // I-085: a "别看" or 「发图片」 off drops what she saw and stops a look under way
    relayCameraHeld(next.cameraHeld === true); // batch D: a "别看" stops the pose reading to her full-screen page at once
    if (callGlancesRevoked(previous, next)) { forgetCallFrames(); see.smallScreens.forget(); } // I-161 A: "别看" or a switch off drops a call's small frames at once
    localAsr?.setWanted(next.voiceInput && voiceRoute.engine === 'local'); // model loaded while voice input is on
    broadcast("desk:runtime", { ...next });
    publishVisionState();
    publishSenses();
    voiceCall.check(); // I-091: voice input off ends a call at once
  }
  keepForSteps(clearVisionContext, refreshVisionContext, publishVisionState);
  keepForSensorWindows({ needs, media, mediaChanged, cameraGlance, userGaze, cameraEye, cameraSamples, presencePorts });
  keepLookForListen({ media, mediaChanged, lookTurns, lookState, screenSnapshots, userGaze });
  keepLookForVoice({ media, mediaChanged, lookAttachments, seeAndSay: see.finish(lookAttachments) });
  return {
    provides: { media, visionSupport, visualSelfRuntime, cameraSamples, screenSnapshots, lookTurns, userGaze, cameraGlance, cameraEye, lookAttachments, screenGlance,
      watchAlong, visionPresentation, proactiveVision, lookScope, lookState, roughForTurn, visionEligible, visionState, publishVisionState, noteVisionUserActivity,
      clearVisionContext, refreshVisionContext, refreshVisualSelfContext, chatContextData, captureSharedCamera, presencePorts, mediaChanged, releaseCameraOnLeave,
      forgetScreenSelection: () => { sourceSelection = { at: 0, ids: new Set() }; } },
    register(registrar: PartIpc): void {
      const { host, scopedHost } = registrar;
      registerScreenSource(registrar); // I-190: which screen or window sharing reads
      // What the handlers read: set before the ready chain registers (registerIPC) and not replaced later.
      const { pet, companion } = needs;
      host("getRuntimeState", () => ({ ...media.state }), false);
      host('getVisionRuntime', () => visionState(), false);
      scopedHost('setVisionOptions', (_sender, value: unknown) => {
        // R09 自动截图 is retired (识图第 1 步): its two keys are read and dropped; only R10's switch is applied.
        const patch = acceptVisionOptionsPatch(value);
        if (patch.proactiveVision === false) clearVisionContext(true, true); // I-221
        if (typeof patch.proactiveVision === 'boolean') proactiveVisionEnabled = patch.proactiveVision;
        visionStatus = '';
        refreshVisionContext();
        publishVisionState();
        return visionState();
      }, false);
      scopedHost('noteUserInput', () => { noteVisionUserActivity(); }, false);
      // L2 (pretrial issue 6): typing to her lifts her out of her own thing (she looks up; the message hears what she was doing).
      scopedHost('noteChatTyping', () => { companion.noteTyping(); screenGlance.noteTalk(); see.typing(); faceCheck?.host.noteTalk(); }, false); // 屏幕只读大概: a browser in front may get one small look, in the background; I-135: typing after being away triggers a face check
      // 屏幕只读大概: "不用" on the companion's "让她看清楚屏幕吗？" closes her offer without a frame, like a short "不用" in words (electron/senses/look-turns.ts).
      scopedHost('declineLookOffer', (sender, id: unknown) => sender === pet?.webContents.id && lookTurns.decline(id, lookState()), false);
      scopedHost('cancelVisionInitiative', () => { noteVisionUserActivity(); }, false);
      // 2026-11-21: on the screen as her senses count it (onScreen): her companion window held hidden while she is out in full-screen Unbound
      // gives the frame she was asked for (before: refused, every camera look failed while she was out). A "别看" said meanwhile wins.
      scopedHost('publishCameraSample', (sender, id: unknown, frame: unknown) => {
        const owner = windows().find(win => win.webContents.id === sender);
        if (!media.sharesCameraFrames() || media.state.cameraHeld === true || media.state.cameraOwner !== ownerFor(sender)
          || !owner || !onScreen(owner)) { cameraSamples.refuse(sender, id); return false; }
        return cameraSamples.accept(sender, id, frame);
      }, false);
      host('noteVisionUserActivity', noteVisionUserActivity, false);
      scopedHost(
        "setRuntimeState",
        (sender, patch) => {
          const previous = { ...media.state };
          const next = media.update(patch, ownerFor(sender), owner => audioCapture?.selectChatOwner(owner) ?? owner);
          mediaChanged(previous);
          return next;
        },
        false,
      );
      scopedHost(
        "publishCameraFrame",
        (sender, frame) => media.publishCamera(ownerFor(sender), frame),
        false,
      );
      // 识图第 1 步: an ordinary message carries no frame; only one that asks her to look (or the button, or a yes to her offer).
      // The decision comes first and a frame is taken only after a yes (electron/senses/look-attachments.ts).
      host("sharedAttachments", (hint?: unknown) => lookAttachments.request(hint), false);
      host("screenSources", async () => {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: false,
        });
        sourceSelection = {
          at: Date.now(),
          ids: new Set(sources.map((s) => s.id)),
        };
        return sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        }));
      });
      host("captureScreen", async (id: unknown) => {
        if (
          typeof id !== "string" ||
          !sourceSelection.ids.has(id) ||
          Date.now() - sourceSelection.at > 60000
        )
          throw new Error("请重新选择要截取的屏幕或窗口。");
        const sources = await desktopCapturer.getSources({
          types: [id.startsWith("screen:") ? "screen" : "window"],
          thumbnailSize: { width: 1600, height: 1000 },
          fetchWindowIcons: false,
        });
        const selected = sources.find((s) => s.id === id);
        sourceSelection = { at: 0, ids: new Set() };
        if (!selected || selected.thumbnail.isEmpty())
          throw new Error("该画面无法截取，请重新选择。");
        return {
          source: "screen",
          dataUrl: `data:image/jpeg;base64,${selected.thumbnail.toJPEG(75).toString("base64")}`,
        };
      });
      // I-081: where pose sensing says you are, in the companion window's pointer units (the companion window only; null otherwise). Memory only.
      scopedHost('userGaze', sender => { const bounds = pet && !pet.isDestroyed() && sender === pet.webContents.id ? pet.getBounds() : null; return bounds ? userGaze.read(bounds, screen.getDisplayMatching(bounds).bounds) : null; }, false);
    },
  };
}
