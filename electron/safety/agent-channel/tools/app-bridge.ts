// The internal channel's view of the app: AgentAppBridge (what a tool may ask the host to read or do) and the facts it reads.
// Provided by electron/safety/agent-channel/electron-wiring.ts (createHostBridge in bridge.ts). Types only; split out of app-tools.ts
// (docs/claude/2026-11-17-app-tools-split.md). A new host step a tool needs is a new optional method here, taking the commit guard.
import type { AppSettings } from '../../../../shared/foundation/settings';
import type { HerStateSource } from '../../../../shared/mood';
import type { TakeMeThereFocus, TakeMeThereId } from '../../../../shared/initiative';
import type { CharacterCardState } from '../../../../shared/foundation/character-card';
import type { CharacterVoice } from '../../../../shared/foundation/character-voice';
import type { CharacterCardUpdateOutcome, CharacterCardUpdatePlanView } from '../../../../shared/cards';
import type { AgentChannelRendererAction, AgentSettingId, AgentSettingValue } from '../../../../shared/safety/agent-channel';
import type { RealerDuration } from '../../../../shared/mood';
import type { CapabilityChoice, ModelCapabilityId } from '../../../../shared/stage';
import type { CapabilityPreviewResult, ModelCapabilityView } from '../../../../shared/stage';
import type { ChatActionWord } from '../../../../shared/brain';
import type { ChannelActionResult } from '../../../brain';
import type { DispositionId, Dispositions } from '../../../../shared/mood';
import type { ReactionDispositionsView } from '../../../../shared/mood';
import type { LocalAsrView } from '../../../../shared/senses';
import type { PoseSensingView } from '../../../../shared/senses';
import type { ModelPhysicsSettings } from '../../../../shared/stage';
import type { MusicSettings } from '../../../../shared/senses';
import type { AgentRecyclePart, AgentRecycleSummary } from '../../../../shared/safety/agent-channel';
import type { AgentCommitGuard } from '../registry';

export interface WindowFacts { visible: boolean; minimized: boolean }
/** I-014 感知: what is on right now (the same facts the privacy page and the companion's switches show). */
/**
 * I-036: the camera is two switches, `camera_images` (「发图片」) and `camera_pose` (「姿势识别」). `camera` is the old
 * single switch: on means 「姿势识别」 (what it meant before), off turns both off; its fact is "either is on".
 */
export type PerceptionKind = 'camera' | 'camera_images' | 'camera_pose' | 'face_check' | 'microphone' | 'screen' | 'system_audio';
export type SystemAudioPurpose = 'music' | 'movie';
export interface PerceptionFacts { camera: boolean; cameraImages?: boolean; cameraPose?: boolean; faceCheck?: boolean; microphone: boolean; screen: boolean; systemAudio: Record<SystemAudioPurpose, boolean> }
/** I-014 回收站 (electron/memory/recoverable-forget.ts behind it). Summaries carry names and counts only. */
export interface AgentMemoryBridge {
  forget(characterId: string, characterName: string, parts: AgentRecyclePart[], guard: AgentCommitGuard): Promise<{ entries: AgentRecycleSummary[]; empty: AgentRecyclePart[]; failed: AgentRecyclePart[] }>;
  restore(entryId: string, guard: AgentCommitGuard): Promise<{ restored: AgentRecycleSummary; count: number; replaced: AgentRecycleSummary | null }>;
  list(): AgentRecycleSummary[];
  days(): number;
  setDays(days: number, guard: AgentCommitGuard): Promise<number>;
}
/** I-077 step 2: her memory of songs (electron/senses/song-memory.ts): numbers only. Clearing keeps the numbers so the undo can put them back. */
export interface AgentSongBridge {
  count(): Promise<number>;
  clear(): Promise<{ count: number; restore(): Promise<void> }>;
}
export interface CommitResult { persistence: 'saved' | 'unchanged' | 'not-committed' | 'unknown'; presentation: string }
/** Numbers only (see electron/brain/reply-latency.ts); text is never part of a record. */
export interface LatencyNumbers {
  status: 'complete' | 'stopped' | 'error' | 'superseded';
  firstContentMs: number | null; firstVisibleMs: number | null; firstSentenceVisibleMs: number | null;
  streamEndMs: number | null; allVisibleMs: number | null; chars: number; deltas: number;
}

/**
 * Existing host functionality, provided by electron/safety/agent-channel/electron-wiring.ts. Every
 * method that changes something takes the call's commit guard: the host checks it immediately
 * before the change takes effect (after any queue wait or file step), so a call abandoned
 * because the channel closed never commits (X-090).
 */
export interface AgentAppBridge {
  version(): string;
  /** Public settings: keys are already masked by the host. */
  settings(): AppSettings;
  characters(): CharacterCardState;
  windows(): { pet: WindowFacts | null; controls: WindowFacts | null };
  activateCharacter(id: string, guard: AgentCommitGuard): Promise<unknown>;
  bindCurrentModel(id: string, guard: AgentCommitGuard): Promise<unknown>;
  /**
   * 熟悉度: the active character card's "慢慢熟悉" only. T-239: `characterId` is the card the request was about (checked to be
   * the active one just before); the host op is sent for that id, never for whichever card is active by then.
   */
  setSlowWarmUp?(value: boolean, guard: AgentCommitGuard, characterId?: string): Promise<unknown>;
  /** F6: the active character card's "更真实的情绪" only (turning it on is a confirm-tier call: set_setting's tierFor). T-239: as above. */
  setRealerEmotions?(value: boolean, guard: AgentCommitGuard, characterId?: string, duration?: RealerDuration): Promise<unknown>;
  /** 体验记录: the switch "保留体验记录（只存本机）" (the same host operation as the control window's switch). */
  setExperienceJournal?(value: boolean, guard: AgentCommitGuard): Promise<unknown>;
  /** 体验记录: a setting this channel (or a chat card, `via`) changed: its id, old and new value. Never throws to the caller. */
  settingChanged?(id: AgentSettingId, previous: AgentSettingValue | null, value: AgentSettingValue | null, via: 'agent' | 'chat'): void;
  setPetVisible(visible: boolean, guard: AgentCommitGuard): Promise<unknown>;
  /** The control window's whole-settings save (validated, masked keys preserved by the host). */
  saveSettings(next: AppSettings, guard: AgentCommitGuard): Promise<unknown>;
  commitPetBoolean(value: boolean, actionId: 'pet.set-always-on-top' | 'pet.set-follow-mouse', guard: AgentCommitGuard): Promise<CommitResult>;
  commitReadoutVolume(percent: number, guard: AgentCommitGuard): Promise<CommitResult>;
  commitBreath(percent: number, guard: AgentCommitGuard): Promise<CommitResult>;
  /** The existing character card import path (validator, character sync and notices). */
  importCharacterCard(content: string, guard: AgentCommitGuard): Promise<CharacterCardState>;
  /** C3: what a card file would change on an existing card; nothing is written. */
  planCharacterCardUpdate?(id: string, content: string): Promise<CharacterCardUpdatePlanView>;
  /**
   * C3: update that card in place (same id) when it is still the planned card (`expected`); backup first. I-173: `useFileVoice` also takes
   * the file's voice (the 角色页's tick), only when the user's own words asked for it and the dialog showed it.
   */
  updateCharacterCard?(id: string, content: string, expected: string, guard: AgentCommitGuard, options?: { useFileVoice?: boolean }): Promise<CharacterCardUpdateOutcome>;
  /**
   * I-173: one card's own voice (the 角色页's 「她的声音」 save, electron/cards/character-voice-save.ts); nothing is spoken or spent, no key.
   * null takes her own voice away (she follows the default voice for new characters), as the page's 「恢复成新角色的默认声音」.
   */
  saveCharacterVoice?(id: string, voice: CharacterVoice | null, guard: AgentCommitGuard): Promise<CharacterCardState>;
  /** 2026-11-24: Drama 3's spending this month, numbers only (the control window's own getTtsBudget); null when it cannot be read. */
  fishBudget?(): import('../../../../shared/voice').FishBudgetView | null;
  /** I-173: the 角色页's delete (card, and her memories when `forgetMemories`) into the recycle bin; never for good. */
  deleteCharacter?(id: string, forgetMemories: boolean, guard: AgentCommitGuard): Promise<CharacterCardState>;
  /** The existing model-loading path (asset registration, settings, sync). */
  loadModel(file: string, guard: AgentCommitGuard): Promise<{ name: string }>;
  /** Sends a closed action to the control window; false when it cannot receive it. */
  rendererAction(action: AgentChannelRendererAction): boolean;
  diagnostics(): { replyLatency: LatencyNumbers[]; petWindow: { enabled: boolean; entries: number }; chatModel?: string | null };
  memory?(): { rss: number; heapUsed: number };
  uptimeSeconds?(): number;
  /** I-014: 三方互通 is on (interconnect-only settings exist only then). Absent: off. */
  interconnected?(): boolean;
  /** I-014 感知: read and switch through the same host paths as the companion's own switches. */
  perception?(): PerceptionFacts;
  setPerception?(kind: PerceptionKind, enabled: boolean, purposes: readonly SystemAudioPurpose[], guard: AgentCommitGuard): Promise<unknown>;
  /** I-137: 认出是不是你's phase (is its component installed?); a sense card never offers it otherwise. */
  faceCheckPhase?(): import('../../../../shared/senses').FaceCheckPhase | null;
  /** I-091 像打语音电话一样和她聊天: whether a call is on, and starting / hanging up through the companion window's own call handler. */
  voiceCall?(): boolean;
  setVoiceCall?(on: boolean, via: 'agent' | 'chat', guard: AgentCommitGuard): Promise<unknown>;
  /** I-014 删除记忆（进回收站）. */
  memories?: AgentMemoryBridge;
  /** I-077 step 2: clear_song_memory. */
  songs?: AgentSongBridge;
  /** I-025 本机语音识别: the control window's own view and buttons (electron/senses/asr/electron-wiring.ts), reused. */
  localAsr?(): LocalAsrView | null;
  /** Starts the download and returns once it started; it goes on in the background (progress in the control window). */
  downloadLocalAsr?(guard: AgentCommitGuard): Promise<void>;
  cancelLocalAsrDownload?(guard: AgentCommitGuard): Promise<void>;
  removeLocalAsr?(guard: AgentCommitGuard): Promise<void>;
  /**
   * I-025 第 3 段: the rest of the settings window, each through the host operation its own control already uses
   * (electron/safety/agent-channel/bridge.ts AGENT_HOST_OPERATIONS).
   */
  hostSettings?(): HostSettingFacts;
  /** Overhaul step 7: the units switched off alone, `<part>/<unit>` (get_status, get_diagnostics, 「复制诊断信息」). Absent: this build has none. */
  partsOff?(): string[];
  /** 看看她现在怎么样 (get_her_state): the mood view the control window already reads (getMood); words are made from it in shared/mood/her-state-words.ts. */
  herState?(): HerStateSource | null;
  /** The clock the words are measured against (tests). Default Date.now. */
  now?(): number;
  setUiLanguage?(preference: import('../../../../shared/foundation/ui-languages').UiLanguagePreference, guard: AgentCommitGuard): Promise<void>;
  setDeveloperMode?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  setMusic?(patch: Partial<MusicSettings>, guard: AgentCommitGuard): Promise<void>;
  setPhysics?(next: ModelPhysicsSettings, guard: AgentCommitGuard): Promise<void>;
  setProactiveVision?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  setFeedRecognition?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /** I-027 心情调整员: the privacy page's own switch (electron/mood/mood-judge/wiring.ts setMoodJudge). */
  setMoodJudge?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /** I-006 第 1 步 「知道你是不是在忙」: the privacy page's own switch (electron/senses/user-activity.ts setEnabled). */
  setUserActivity?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /**
   * 2026-11-23 全屏里她出来的位置: the full-screen panel's own 「设为默认位置」 (electron/unbound/place-keeper.ts). `true` keeps where she stands now
   * (false: she is not out, so nothing to keep); `false` clears it. Only two numbers are kept (across the screen, metres behind it).
   */
  setUnboundDefaultPlace?(keepHere: boolean, guard: AgentCommitGuard): Promise<boolean>;
  downloadPose?(guard: AgentCommitGuard): Promise<void>;
  cancelPoseDownload?(guard: AgentCommitGuard): Promise<void>;
  removePose?(guard: AgentCommitGuard): Promise<void>;
  recoverPet?(guard: AgentCommitGuard): Promise<void>;
  /** I-065: the control window on one page (the same move as her 「带我去」); navigation only. I-173: `focus` flashes one item there. */
  openControlPage?(page: TakeMeThereId, guard: AgentCommitGuard, focus?: TakeMeThereFocus): Promise<void>;
  useBundledModel?(guard: AgentCommitGuard): Promise<void>;
  unbindCharacterModel?(id: string, guard: AgentCommitGuard): Promise<void>;
  createCharacterForCurrentModel?(guard: AgentCommitGuard): Promise<CharacterCardState>;
  /** I-024 这个模型能做什么: the current model's record and cached profile, its per-model switch, and 试一下 on the companion. */
  modelCapabilities?(): Promise<ModelCapabilityView>;
  setModelCapabilityChoice?(modelKey: string, id: ModelCapabilityId, choice: CapabilityChoice, guard: AgentCommitGuard): Promise<void>;
  previewModelCapability?(id: ModelCapabilityId, guard: AgentCommitGuard): Promise<CapabilityPreviewResult>;
  /** 通用骨架第 5 步 · 通道: one of her seven small actions, by the same rules as her own pick (electron/brain/chat-actions-host.ts perform). */
  playChatAction?(word: ChatActionWord, guard: AgentCommitGuard): Promise<ChannelActionResult>;
  /** I-037 新的反应方式: the privacy page's own switch (electron/mood/reactions/wiring.ts setEnabled). */
  setReactions?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /** I-037: the 角色页's six sliders for the current character (null: back to the card's values); returns the view and what was stored before. */
  setReactionDispositions?(values: Partial<Record<DispositionId, number>> | null, guard: AgentCommitGuard): Promise<ReactionDispositionsView & { before: Dispositions | null }>;
  reactionDispositions?(): ReactionDispositionsView | null;
}

/** I-025 第 3 段: what the host reports for the settings kept outside AppSettings (each null when it cannot be read). */
export interface HostSettingFacts {
  uiLanguage: import('../../../../shared/foundation/ui-languages').UiLanguagePreference | null;
  developerMode: boolean | null;
  music: MusicSettings | null;
  physics: ModelPhysicsSettings | null;
  proactiveVision: boolean | null;
  feedRecognition: boolean | null;
  pose: PoseSensingView | null;
  /** I-027 心情调整员 (absent in older hosts: unknown). */
  moodJudge?: boolean | null;
  /** I-037 新的反应方式 (absent in older hosts: unknown). */
  reactions?: boolean | null;
  /** I-006 第 1 步 「知道你是不是在忙」 (absent in older hosts: unknown). */
  userActivity?: boolean | null;
  /** 2026-11-23: whether a default place is set for her in Unbound ('default') or not ('none'); null when unknown. */
  unboundDefaultPlace?: 'default' | 'none' | null;
}
