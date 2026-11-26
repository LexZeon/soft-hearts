// Agent channel → existing host operations. Each operation is the app's own registered IPC
// handler, invoked exactly as the control window's main frame would invoke it, so the agent
// passes through the same sender check and validators and can do nothing the control window
// cannot. No Electron import here: tests drive it with fake windows and handlers.
import { isUiLanguagePreference } from '../../../shared/foundation/ui-languages';
import type { AppSettings, AssetRef } from '../../../shared/foundation/settings';
import type { CharacterCardState } from '../../../shared/foundation/character-card';
import type { CharacterCardUpdateOutcome, CharacterCardUpdatePlanView } from '../../../shared/cards';
import type { HerStateSource } from '../../../shared/mood';
import type { AgentChannelRendererAction } from '../../../shared/safety/agent-channel';
import type { CapabilityChoice, ModelCapabilityId } from '../../../shared/stage';
import type { CapabilityPreviewResult, ModelCapabilityView } from '../../../shared/stage';
import type { ChatActionWord } from '../../../shared/brain';
import type { TakeMeThereFocus, TakeMeThereId } from '../../../shared/initiative';
import type { Dispositions } from '../../../shared/mood';
import type { ReactionDispositionsView } from '../../../shared/mood';
import type { ChannelActionResult } from '../../brain';
import { parseLocalAsrView } from '../../../shared/senses';
import { validFishBudgetView } from '../../../shared/voice';
import { parsePoseView } from '../../../shared/senses';
import { FACE_CHECK_PHASES, type FaceCheckPhase } from '../../../shared/senses';
import type { HostSettingFacts } from './app-tools';
import type { AgentAppBridge, AgentMemoryBridge, CommitResult, LatencyNumbers, PerceptionFacts, PerceptionKind, SystemAudioPurpose, WindowFacts } from './app-tools';
import type { AgentCommitGuard } from './registry';
import { partsOffList } from '../../../shared/foundation/part-health';
import { reportedModelId } from '../../../shared/brain';
import type { PartHealthView } from '../../../shared/foundation/ports';

/** The only existing IPC operations the channel may reuse. Everything else is never looked up. */
export const AGENT_HOST_OPERATIONS: readonly string[] = Object.freeze([
  // I-065: 'openControls' takes an optional page (the channel's open_control_page; navigation only).
  'openControls',
  'getSettings', 'saveSettings', 'getCharacterCards', 'activateCharacterCard', 'bindCharacterModel', 'setPetVisible', 'getPetWindowDiagnostics',
  'setCharacterSlowWarmUp', 'setCharacterRealerEmotions', 'setExperienceJournal',
  // I-014 感知 (interconnect-only set_perception): read from either window, switched as the companion's own switches are.
  'getRuntimeState', 'getAudioReadingView', 'setRuntimeState', 'setAudioReadingIntent',
  // I-135 认出是不是你: the control window's own switch (set_perception face_check; on needs the user's words and the dialog).
  'getFaceCheck', 'setFaceCheck',
  // I-025 本机语音识别: the control window's own 「下载」「取消」「删除识别组件」 (electron/senses/asr/electron-wiring.ts).
  'getLocalAsr', 'downloadLocalAsr', 'cancelLocalAsrDownload', 'removeLocalAsr',
  // I-025 第 3 段: the rest of the settings window, each the operation its own control already calls.
  'getUiLanguage', 'setUiLanguage', 'getMood', 'setMoodDeveloperMode', 'getMusicSettings', 'setMusicSettings',
  'getModelPhysicsSettings', 'setModelPhysicsSettings', 'getVisionRuntime', 'setVisionOptions', 'getFeedRecognition', 'setFeedRecognition',
  'getPoseSensing', 'downloadPoseComponents', 'cancelPoseDownload', 'removePoseComponents', 'recoverPet', 'useBundledModel', 'createCharacterForCurrentModel',
  // I-024 这个模型能做什么: the character page's table, its switches and 「试一下」.
  'getModelCapabilities', 'setModelCapabilityChoice', 'previewModelCapability',
  // I-027 心情调整员: the privacy page's own switch.
  'getMoodJudge', 'setMoodJudge', 'getUserActivity', 'setUserActivity',
  // 通用骨架第 5 步 · 通道: the seven small actions (play_her_action), the same cue her own reply pick sends.
  'playChatAction',
  // I-037 新的反应方式: the privacy page's switch and the 角色页's six sliders (set_setting new_reactions, set_reaction_dispositions).
  'getReactions', 'setReactions', 'getReactionDispositions', 'setReactionDispositions',
  // I-091 像打语音电话一样和她聊天: the call, read from either window, started and hung up as the companion's own button does.
  'getVoiceCall', 'setVoiceCall',
  // I-173: the 角色页's own 「她的声音」 save (set_voice_style fills her Drama 3 id) and its delete into the recycle bin (delete_character).
  'saveCharacterVoice', 'deleteCharacter',
  // 2026-11-24: Drama 3's spending this month (read only, no arguments), for list_settings' voices and the paid-voice dialogs.
  'getTtsBudget',
]);
/**
 * I-014: the operations the channel calls as the companion window's main frame, because that is where the user's own switch
 * for them is (camera, microphone, screen and the computer's sound open in the companion). Nothing else is ever called so.
 */
export const AGENT_PET_OPERATIONS: readonly string[] = Object.freeze(['setRuntimeState', 'setAudioReadingIntent', 'setVoiceCall']);

export type IpcHandler = (event: any, ...args: any[]) => unknown;
export interface IpcRegistrar { handle(channel: string, handler: IpcHandler): void }
export interface AgentOperationRecorder {
  /** Stops recording (restores the registrar) and returns the whitelisted handlers. */
  done(): ReadonlyMap<string, IpcHandler>;
}

/**
 * Records the whitelisted `desk:*` handlers while main.ts registers its IPC. The real
 * registration still happens unchanged; nothing is recorded after `done()`.
 */
export function recordAgentOperations(ipc: IpcRegistrar): AgentOperationRecorder {
  const own = Object.prototype.hasOwnProperty.call(ipc, 'handle');
  const original = ipc.handle;
  const recorded = new Map<string, IpcHandler>();
  let active = true;
  ipc.handle = function (this: unknown, channel: string, handler: IpcHandler) {
    const method = typeof channel === 'string' && channel.startsWith('desk:') ? channel.slice(5) : '';
    if (active && AGENT_HOST_OPERATIONS.includes(method)) recorded.set(method, handler);
    return original.call(this ?? ipc, channel, handler);
  };
  return {
    done() {
      if (active) {
        active = false;
        if (own) ipc.handle = original; else delete (ipc as { handle?: unknown }).handle;
      }
      return recorded;
    },
  };
}

export interface AgentWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: { id: number; isDestroyed(): boolean; send(channel: string, value: unknown): void };
}
export const liveWindow = (win: AgentWindow | null | undefined): win is AgentWindow =>
  !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
const facts = (win: AgentWindow | null): WindowFacts | null => liveWindow(win) ? { visible: win.isVisible(), minimized: win.isMinimized() } : null;

/** Closures main.ts already has; nothing here reaches beyond them. */
export interface AgentHostWiring {
  version(): string;
  controls(): AgentWindow | null;
  pet(): AgentWindow | null;
  operations: ReadonlyMap<string, IpcHandler>;
  /**
   * Runs a reused IPC handler so the change it queues on the host's mutation queue re-checks
   * `guard` right before it starts (agent-channel/host-actions.ts, electron/foundation/mutation-queue.ts).
   */
  admit<T>(guard: AgentCommitGuard, run: () => T): T;
  /** The existing character card import (validator, sync, notices) for already-read JSON text. */
  importCharacterCard(content: string, guard: AgentCommitGuard): Promise<CharacterCardState>;
  /** C3: what a card file would change on an existing card (read only; electron/cards/character-card-update.ts). */
  planCharacterCardUpdate?(id: string, content: string): Promise<CharacterCardUpdatePlanView>;
  /** C3: the in-place update of that card (same id), queued and guarded like the import. I-173: `options.useFileVoice` as the 角色页's tick. */
  updateCharacterCard?(id: string, content: string, expected: string, guard: AgentCommitGuard, options?: { useFileVoice?: boolean }): Promise<CharacterCardUpdateOutcome>;
  /** The existing model-load path for one local .pmx/.pmd/.vrm file. */
  loadModel(file: string, guard: AgentCommitGuard): Promise<AssetRef>;
  commitPetBoolean(value: boolean, actionId: 'pet.set-always-on-top' | 'pet.set-follow-mouse', guard: AgentCommitGuard): Promise<CommitResult>;
  commitReadoutVolume(percent: number, guard: AgentCommitGuard): Promise<CommitResult>;
  commitBreath(percent: number, guard: AgentCommitGuard): Promise<CommitResult>;
  replyLatency(): LatencyNumbers[];
  /** 2026-11-26: the model id Claude Code reported for her current chat process, or null (get_diagnostics; diagnostic only). */
  chatModel?(): string | null;
  broadcast(channel: string, value: unknown): void;
  /** 体验记录: told after a set_setting call changed something (electron/memory/journal/). */
  settingChanged?: AgentAppBridge['settingChanged'];
  /** I-014: 三方互通 is on (read on every call). */
  interconnected?(): boolean;
  /** I-014 回收站 (main.ts wires electron/memory/recoverable-forget.ts through the host's mutation queue). */
  memories?: AgentMemoryBridge;
  /** I-077 step 2: her memory of songs (clear_song_memory only; nothing reads it out). */
  songs?: import('./app-tools').AgentSongBridge;
  /** I-025 体验记录: a user-words call committed (item, value, how long the words were; never the words). */
  wordsUsed?(use: import('./registry').AgentWordsUse): void;
  /**
   * 2026-11-23 全屏里她出来的位置: the place keeper behind the full-screen panel's 「设为默认位置」 (electron/unbound/place-keeper.ts), as the
   * safety wiring gives it. `isSet` null: unknown; `setHere` false: she is not out (nothing to keep); `clear` forgets the default place.
   */
  unboundPlace?: { isSet(): boolean | null; setHere(): boolean; clear(): void };
}

/** A frame token only this module holds; the host's sender check compares it with itself. */
const AGENT_FRAME = Object.freeze({ agentChannel: true });

type OperationWiring = Pick<AgentHostWiring, 'operations' | 'controls' | 'pet' | 'admit'>;

function operationCallers(wiring: OperationWiring) {
  /** Reads pass no guard. A changing operation checks it now and again when its queued change starts. */
  const op = (method: string, guard: AgentCommitGuard | null, ...args: unknown[]): unknown => {
    const handler = AGENT_HOST_OPERATIONS.includes(method) ? wiring.operations.get(method) : undefined;
    const controls = wiring.controls();
    if (!handler || !liveWindow(controls)) throw new Error('控制窗口尚未就绪。');
    const call = () => handler({ sender: { id: controls.webContents.id, mainFrame: AGENT_FRAME }, senderFrame: AGENT_FRAME }, ...args);
    if (!guard) return call();
    guard();
    return wiring.admit(guard, call);
  };
  /** I-014: the same, as the companion window's main frame (only AGENT_PET_OPERATIONS, only while the companion window lives). */
  const petOp = (method: string, guard: AgentCommitGuard, ...args: unknown[]): unknown => {
    const handler = AGENT_PET_OPERATIONS.includes(method) ? wiring.operations.get(method) : undefined;
    const pet = wiring.pet();
    if (!handler || !liveWindow(pet)) throw new Error('桌宠窗口尚未就绪。');
    guard();
    return wiring.admit(guard, () => handler({ sender: { id: pet.webContents.id, mainFrame: AGENT_FRAME }, senderFrame: AGENT_FRAME }, ...args));
  };
  return { op, petOp };
}

/**
 * I-014 感知: what is on, and the user's own switches' host paths (the companion's 摄像头 / 麦克风 / 屏幕 / 和她一起听, the control
 * window's 认出是不是你). The internal channel's set_perception and Unbound's permission bundle (electron/unbound/permission-bundle.ts)
 * both switch through here, so indicators, refusals and records behave exactly as when the user clicks.
 */
export interface PerceptionSwitches {
  read(): PerceptionFacts;
  set(kind: PerceptionKind, enabled: boolean, purposes: readonly SystemAudioPurpose[], guard: AgentCommitGuard): Promise<void>;
  /** I-137: 认出是不是你's phase (whether its component is installed), from the control window's own view; null when unknown. */
  facePhase(): FaceCheckPhase | null;
}
export function createPerceptionSwitches(wiring: OperationWiring): PerceptionSwitches {
  const { op, petOp } = operationCallers(wiring);
  const perception = (): PerceptionFacts => {
    const runtime = (op('getRuntimeState', null) ?? {}) as { cameraSharing?: unknown; cameraImages?: unknown; cameraLocal?: unknown; voiceInput?: unknown; screenSharing?: unknown };
    let system: { music?: { intent?: unknown }; movie?: { intent?: unknown } } | undefined;
    try { system = (op('getAudioReadingView', null) as { sources?: Record<string, typeof system> } | undefined)?.sources?.['system-audio']; }
    catch { system = undefined; }
    let faceCheck = false; // I-135
    try { faceCheck = wiring.operations.has('getFaceCheck') && (op('getFaceCheck', null) as { enabled?: unknown } | null)?.enabled === true; }
    catch { faceCheck = false; }
    // I-036: the camera's two switches as well as "either is on".
    return { camera: runtime.cameraSharing === true, cameraImages: runtime.cameraImages === true, cameraPose: runtime.cameraLocal === true, faceCheck,
      microphone: runtime.voiceInput === true, screen: runtime.screenSharing === true,
      systemAudio: { music: system?.music?.intent === true, movie: system?.movie?.intent === true } };
  };
  const set = async (kind: PerceptionKind, enabled: boolean, purposes: readonly SystemAudioPurpose[], guard: AgentCommitGuard): Promise<void> => {
    if (kind === 'system_audio') {
      for (const purpose of purposes) await petOp('setAudioReadingIntent', guard, { source: 'system-audio', purpose, enabled });
      return;
    }
    // I-135: the control window's own switch (turning it on may start the one-time model download, as the click does).
    if (kind === 'face_check') { await op('setFaceCheck', guard, enabled); return; }
    // I-036: `camera` is the old single switch (on: 「姿势识别」; off: both); the two switches each have their own kind.
    const patch = kind === 'camera' ? { cameraSharing: enabled } : kind === 'camera_images' ? { cameraImages: enabled }
      : kind === 'camera_pose' ? { cameraLocal: enabled } : kind === 'microphone' ? { voiceInput: enabled } : { screenSharing: enabled };
    await petOp('setRuntimeState', guard, patch);
  };
  // I-137: a sense card offers the face check only while its component is installed (turning it on then starts no download).
  const facePhase = (): FaceCheckPhase | null => {
    if (!wiring.operations.has('getFaceCheck')) return null;
    try { const phase = (op('getFaceCheck', null) as { phase?: unknown } | null)?.phase; return typeof phase === 'string' && (FACE_CHECK_PHASES as readonly string[]).includes(phase) ? phase as FaceCheckPhase : null; }
    catch { return null; }
  };
  return { read: perception, set, facePhase };
}

export function createHostBridge(wiring: AgentHostWiring): AgentAppBridge {
  const { op, petOp } = operationCallers(wiring);
  const switches = createPerceptionSwitches(wiring);
  const settings = () => op('getSettings', null) as AppSettings;
  const perception = switches.read;
  return {
    version: () => wiring.version(),
    settings,
    characters: () => op('getCharacterCards', null) as CharacterCardState,
    windows: () => ({ pet: facts(wiring.pet()), controls: facts(wiring.controls()) }),
    activateCharacter: async (id, guard) => op('activateCharacterCard', guard, id),
    bindCurrentModel: async (id, guard) => op('bindCharacterModel', guard, id, true),
    // 熟悉度: only the active card's "慢慢熟悉" (the same operation the card editor's host handler runs).
    // T-239: sent for the card the request was made for (set_setting checked it is still the active one); the active id only without one.
    setSlowWarmUp: async (value, guard, characterId) => op('setCharacterSlowWarmUp', guard, characterId ?? (op('getCharacterCards', null) as CharacterCardState).activeId, value),
    // F6: the active card's "更真实的情绪"; this host operation has no dialog of its own, so set_setting asks first (confirm tier) when it turns on.
    // T-239: the confirmed card's id, never whichever card is active when the OK arrives.
    setRealerEmotions: async (value, guard, characterId, duration) => op('setCharacterRealerEmotions', guard, characterId ?? (op('getCharacterCards', null) as CharacterCardState).activeId, value, duration),
    setExperienceJournal: async (value, guard) => op('setExperienceJournal', guard, value),
    settingChanged: (id, previous, value, via) => wiring.settingChanged?.(id, previous, value, via),
    setPetVisible: async (visible, guard) => op('setPetVisible', guard, visible),
    // saveSettings skips the control window's own echo; this save did not come from it.
    saveSettings: async (next, guard) => { const saved = await op('saveSettings', guard, next); wiring.broadcast('desk:settings', settings()); return saved; },
    commitPetBoolean: (value, actionId, guard) => wiring.commitPetBoolean(value, actionId, guard),
    commitReadoutVolume: (percent, guard) => wiring.commitReadoutVolume(percent, guard),
    commitBreath: (percent, guard) => wiring.commitBreath(percent, guard),
    importCharacterCard: (content, guard) => wiring.importCharacterCard(content, guard),
    ...(wiring.planCharacterCardUpdate && wiring.updateCharacterCard ? {
      planCharacterCardUpdate: (id: string, content: string) => wiring.planCharacterCardUpdate!(id, content),
      updateCharacterCard: (id: string, content: string, expected: string, guard: AgentCommitGuard, options?: { useFileVoice?: boolean }) =>
        wiring.updateCharacterCard!(id, content, expected, guard, options?.useFileVoice === true ? { useFileVoice: true } : undefined),
    } : {}),
    // I-173: the 角色页's own operations (the same sender check and validators): her voice save, and the delete into the recycle bin.
    ...(wiring.operations.has('saveCharacterVoice') ? { saveCharacterVoice: async (id: string, voice: unknown, guard: AgentCommitGuard) =>
      await op('saveCharacterVoice', guard, id, voice) as CharacterCardState } : {}),
    ...(wiring.operations.has('deleteCharacter') ? { deleteCharacter: async (id: string, forgetMemories: boolean, guard: AgentCommitGuard) =>
      await op('deleteCharacter', guard, id, { forgetMemories }) as CharacterCardState } : {}),
    // 2026-11-24: Drama 3's spending this month (numbers only), as the control window reads it; anything odd reads as unknown.
    ...(wiring.operations.has('getTtsBudget') ? { fishBudget: () => { try { return validFishBudgetView(op('getTtsBudget', null)); } catch { return null; } } } : {}),
    loadModel: (file, guard) => wiring.loadModel(file, guard),
    rendererAction: (action: AgentChannelRendererAction) => {
      const controls = wiring.controls();
      if (!liveWindow(controls)) return false;
      controls.webContents.send('desk:agent-channel-action', action);
      return true;
    },
    interconnected: () => wiring.interconnected?.() === true,
    perception,
    // I-091: the companion window's own call handler; `via` only names how it started in the journal (the consent was checked before).
    ...(wiring.operations.has('getVoiceCall') && wiring.operations.has('setVoiceCall') ? {
      voiceCall: () => { try { return (op('getVoiceCall', null) as { on?: unknown } | null)?.on === true; } catch { return false; } },
      setVoiceCall: async (on: boolean, via: 'agent' | 'chat', guard: AgentCommitGuard) => { await petOp('setVoiceCall', guard, on, via === 'chat' ? 'chat' : 'channel'); },
    } : {}),
    setPerception: (kind, enabled, purposes, guard) => switches.set(kind, enabled, purposes, guard),
    faceCheckPhase: () => switches.facePhase(), // I-137: sense cards offer the face check only while it is installed
    ...(wiring.memories ? { memories: wiring.memories } : {}),
    ...(wiring.songs ? { songs: wiring.songs } : {}),
    // I-025: the local recognizer through the control window's own handlers. The download runs until it is done (minutes);
    // the call returns once it started, the control window shows its progress, and a failure stays there too.
    ...(wiring.operations.has('getLocalAsr') ? {
      localAsr: () => parseLocalAsrView(op('getLocalAsr', null)),
      downloadLocalAsr: async (guard: AgentCommitGuard) => {
        const running = Promise.resolve(op('downloadLocalAsr', guard));
        running.catch(() => { /* Shown in the control window. */ });
        await Promise.race([running, new Promise(resolve => setTimeout(resolve, 50))]);
      },
      cancelLocalAsrDownload: async (guard: AgentCommitGuard) => { await op('cancelLocalAsrDownload', guard); },
      removeLocalAsr: async (guard: AgentCommitGuard) => { await op('removeLocalAsr', guard); },
    } : {}),
    // 看看她现在怎么样: the mood view the control window already reads; shared/mood/her-state-words.ts keeps only words from it.
    // Overhaul step 7: which parts are off, read through the control window's own read (getPartHealth); closed words only.
    ...(wiring.operations.has('getPartHealth') ? { partsOff: () => { try { return partsOffList(op('getPartHealth', null) as PartHealthView); } catch { return []; } } } : {}),
    ...(wiring.operations.has('getMood') ? { herState: () => { try { return op('getMood', null) as HerStateSource | null; } catch { return null; } } } : {}),
    // I-025 第 3 段: each read on its own (one that fails is unknown); each change through the control's own operation.
    hostSettings: (): HostSettingFacts => {
      const read = <T>(method: string, pick: (value: any) => T): T | null => {
        if (!wiring.operations.has(method)) return null;
        try { return pick(op(method, null)) ?? null; } catch { return null; }
      };
      const language = read('getUiLanguage', view => view?.preference);
      return {
        uiLanguage: isUiLanguagePreference(language) ? language : null,
        developerMode: read('getMood', view => typeof view?.developerMode === 'boolean' ? view.developerMode : null),
        music: read('getMusicSettings', view => view && typeof view.strength === 'number' && typeof view.alwaysDance === 'boolean' ? { strength: view.strength, alwaysDance: view.alwaysDance } : null),
        physics: read('getModelPhysicsSettings', view => view && view.hair && view.chest && typeof view.quality === 'string' ? structuredClone(view) : null),
        proactiveVision: read('getVisionRuntime', view => typeof view?.proactiveVision === 'boolean' ? view.proactiveVision : null),
        feedRecognition: read('getFeedRecognition', view => typeof view?.enabled === 'boolean' ? view.enabled : null),
        pose: read('getPoseSensing', view => parsePoseView(view)),
        moodJudge: read('getMoodJudge', view => typeof view?.enabled === 'boolean' ? view.enabled : null),
        userActivity: read('getUserActivity', view => typeof view?.enabled === 'boolean' ? view.enabled : null),
        unboundDefaultPlace: (() => { try { const set = wiring.unboundPlace?.isSet(); return typeof set === 'boolean' ? (set ? 'default' as const : 'none' as const) : null; } catch { return null; } })(),
        reactions: read('getReactions', view => typeof view?.enabled === 'boolean' ? view.enabled : null),
      };
    },
    ...(wiring.operations.has('setUiLanguage') ? { setUiLanguage: async (preference: string, guard: AgentCommitGuard) => { await op('setUiLanguage', guard, preference); } } : {}),
    ...(wiring.operations.has('setMoodDeveloperMode') ? { setDeveloperMode: async (enabled: boolean, guard: AgentCommitGuard) => { await op('setMoodDeveloperMode', guard, enabled); } } : {}),
    ...(wiring.operations.has('setMusicSettings') ? { setMusic: async (patch: unknown, guard: AgentCommitGuard) => { await op('setMusicSettings', guard, patch); } } : {}),
    ...(wiring.operations.has('setModelPhysicsSettings') ? { setPhysics: async (next: unknown, guard: AgentCommitGuard) => { await op('setModelPhysicsSettings', guard, next); } } : {}),
    ...(wiring.operations.has('setVisionOptions') ? { setProactiveVision: async (enabled: boolean, guard: AgentCommitGuard) => { await op('setVisionOptions', guard, { proactiveVision: enabled }); } } : {}),
    ...(wiring.operations.has('setFeedRecognition') ? { setFeedRecognition: async (enabled: boolean, guard: AgentCommitGuard) => { await op('setFeedRecognition', guard, enabled); } } : {}),
    ...(wiring.operations.has('setMoodJudge') ? { setMoodJudge: async (enabled: boolean, guard: AgentCommitGuard) => { await op('setMoodJudge', guard, enabled); } } : {}),
    ...(wiring.operations.has('setUserActivity') ? { setUserActivity: async (enabled: boolean, guard: AgentCommitGuard) => { await op('setUserActivity', guard, enabled); } } : {}),
    ...(wiring.unboundPlace ? { setUnboundDefaultPlace: async (keepHere: boolean, guard: AgentCommitGuard) => {
      guard();
      return wiring.admit(guard, () => { const place = wiring.unboundPlace!; if (!keepHere) { place.clear(); return true; } return place.setHere(); });
    } } : {}),
    ...(wiring.operations.has('downloadPoseComponents') ? {
      downloadPose: async (guard: AgentCommitGuard) => {
        const running = Promise.resolve(op('downloadPoseComponents', guard));
        running.catch(() => { /* Shown on the privacy page. */ });
        await Promise.race([running, new Promise(resolve => setTimeout(resolve, 50))]);
      },
      cancelPoseDownload: async (guard: AgentCommitGuard) => { await op('cancelPoseDownload', guard); },
      removePose: async (guard: AgentCommitGuard) => { await op('removePoseComponents', guard); },
    } : {}),
    ...(wiring.operations.has('recoverPet') ? { recoverPet: async (guard: AgentCommitGuard) => { await op('recoverPet', guard); } } : {}),
    // I-065: the control window on one page, through the same operation its own 「打开控制窗口」 uses (with the page).
    // I-173: `focus` (an element id, a card id) only flashes an item there; the host's handler drops anything malformed.
    ...(wiring.operations.has('openControls') ? { openControlPage: async (page: TakeMeThereId, guard: AgentCommitGuard, focus?: TakeMeThereFocus) => {
      await (focus && (focus.anchor || focus.character) ? op('openControls', guard, page, focus) : op('openControls', guard, page)); } } : {}),
    ...(wiring.operations.has('useBundledModel') ? { useBundledModel: async (guard: AgentCommitGuard) => { await op('useBundledModel', guard); wiring.broadcast('desk:settings', settings()); } } : {}),
    unbindCharacterModel: async (id: string, guard: AgentCommitGuard) => { await op('bindCharacterModel', guard, id, false); },
    ...(wiring.operations.has('createCharacterForCurrentModel')
      ? { createCharacterForCurrentModel: async (guard: AgentCommitGuard) => op('createCharacterForCurrentModel', guard) as Promise<CharacterCardState> } : {}),
    // I-024: the same three operations the character page's 「这个模型能做什么」 uses.
    ...(wiring.operations.has('getModelCapabilities') ? { modelCapabilities: async () => await op('getModelCapabilities', null) as ModelCapabilityView } : {}),
    ...(wiring.operations.has('setModelCapabilityChoice') ? { setModelCapabilityChoice: async (modelKey: string, id: ModelCapabilityId, choice: CapabilityChoice,
      guard: AgentCommitGuard) => { await op('setModelCapabilityChoice', guard, modelKey, id, choice); } } : {}),
    ...(wiring.operations.has('previewModelCapability') ? { previewModelCapability: async (id: ModelCapabilityId, guard: AgentCommitGuard) =>
      await op('previewModelCapability', guard, id) as CapabilityPreviewResult } : {}),
    ...(wiring.operations.has('setReactions') ? { setReactions: async (enabled: boolean, guard: AgentCommitGuard) => { await op('setReactions', guard, enabled); } } : {}),
    ...(wiring.operations.has('setReactionDispositions') ? {
      setReactionDispositions: async (values: unknown, guard: AgentCommitGuard) => await op('setReactionDispositions', guard, values) as ReactionDispositionsView & { before: Dispositions | null },
      reactionDispositions: () => { try { return op('getReactionDispositions', null) as ReactionDispositionsView; } catch { return null; } },
    } : {}),
    ...(wiring.operations.has('playChatAction') ? { playChatAction: async (word: ChatActionWord, guard: AgentCommitGuard) =>
      await op('playChatAction', guard, word) as ChannelActionResult } : {}),
    diagnostics: () => {
      let petWindow = { enabled: false, entries: 0 };
      try {
        const view = op('getPetWindowDiagnostics', null) as { enabled?: unknown; entries?: unknown };
        petWindow = { enabled: view?.enabled === true, entries: Array.isArray(view?.entries) ? view.entries.length : 0 };
      } catch { /* Diagnostics stay empty. */ }
      let replyLatency: LatencyNumbers[] = [];
      try { replyLatency = wiring.replyLatency(); } catch { /* No samples. */ }
      let chatModel: string | null = null;
      try { chatModel = reportedModelId(wiring.chatModel?.()); } catch { /* Unknown. */ }
      return { replyLatency, petWindow, chatModel };
    },
  };
}
