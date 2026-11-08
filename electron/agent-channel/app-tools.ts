// v1 soft hearts tools for the agent channel. Each handler calls an existing host
// path through AgentAppBridge; nothing here touches windows, files or settings directly
// except reading the one file the user confirmed.
import { readFile } from 'node:fs/promises';
import type { AppSettings } from '../../shared/contracts';
import { proactiveTalk } from '../../shared/behaviors/inner-rhythm/knobs';
import { herStateWords, type HerStateSource } from '../../shared/her-state-words';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../../shared/tts';
import type { CharacterCardState } from '../../shared/character-cards';
import { cardUpdateSummaryLines, type CharacterCardUpdateOutcome, type CharacterCardUpdatePlanView } from '../../shared/character-card-update';
import {
  AGENT_SETTING_STATE_LABELS, AGENT_SETTINGS, AGENT_TIER_LABELS, AGENT_TOOLS, agentSetting, validateAgentSettingValue,
  type AgentChannelRendererAction, type AgentSettingId, type AgentSettingSpec, type AgentSettingValue, type AgentSettingView,
} from '../../shared/agent-channel';
import { REALER_EMOTIONS_CONSENT } from '../../shared/realer-emotions';
import { MODEL_CAPABILITY_IDS, deriveModelCapabilities, type CapabilityChoice, type ModelCapabilityId } from '../../shared/model-capability';
import { CAPABILITY_LABELS, type CapabilityPreviewResult, type ModelCapabilityView } from '../../shared/model-capability-check';
import { approximateActions, fingerReasonWords, fingerWords, missingActionGroups, modelAdaptation, partWords } from '../../shared/model-adaptation';
import { HER_ACTIONS } from '../../shared/her-actions';
import { CHAT_ACTION_WORDS, type ChatActionWord } from '../../shared/chat-actions';
import type { ChannelActionResult } from '../chat-actions-host';
import { DISPOSITIONS, DISPOSITION_IDS, type DispositionId, type Dispositions } from '../../shared/behaviors/reactions/dispositions';
import type { ReactionDispositionsView } from '../../shared/behaviors/reactions/views';
import type { CapabilityEntry } from '../../shared/capabilities';
import type { LocalAsrView } from '../../shared/local-asr';
import type { PoseSensingView } from '../../shared/pose-signals';
import type { ModelPhysicsSettings } from '../../shared/model-physics';
import type { MusicSettings } from '../../shared/music-settings';
import { ASR_ARCHIVES, SENSEVOICE_REPO } from '../asr/manifest';
import { handbookCategory, handbookIndex, isCapabilityCategory } from '../../shared/capability-handbook';
import type { AgentRecyclePart, AgentRecycleSummary } from '../../shared/agent-channel';
import { AgentToolError, type AgentCallContext, type AgentCommitGuard, type AgentToolDefinition } from './registry';
import { argsObject, assertUnchanged, cardId, inspectLocalFile, localFilePath, noArgs, nodeFileSystem, oneOf,
  type FileFacts, type FileSystemPort } from './validate';

export interface WindowFacts { visible: boolean; minimized: boolean }
/** I-014 感知: what is on right now (the same facts the privacy page and the pet's switches show). */
/**
 * I-036: the camera is two switches, `camera_images` (「发图片」) and `camera_pose` (「姿势识别」). `camera` is the old
 * single switch: on means 「姿势识别」 (what it meant before), off turns both off; its fact is "either is on".
 */
export type PerceptionKind = 'camera' | 'camera_images' | 'camera_pose' | 'microphone' | 'screen' | 'system_audio';
export type SystemAudioPurpose = 'music' | 'movie';
export interface PerceptionFacts { camera: boolean; cameraImages?: boolean; cameraPose?: boolean; microphone: boolean; screen: boolean; systemAudio: Record<SystemAudioPurpose, boolean> }
/** I-014 回收站 (electron/recoverable-forget.ts behind it). Summaries carry names and counts only. */
export interface AgentMemoryBridge {
  forget(characterId: string, characterName: string, parts: AgentRecyclePart[], guard: AgentCommitGuard): Promise<{ entries: AgentRecycleSummary[]; empty: AgentRecyclePart[]; failed: AgentRecyclePart[] }>;
  restore(entryId: string, guard: AgentCommitGuard): Promise<{ restored: AgentRecycleSummary; count: number; replaced: AgentRecycleSummary | null }>;
  list(): AgentRecycleSummary[];
  days(): number;
  setDays(days: number, guard: AgentCommitGuard): Promise<number>;
}
export interface CommitResult { persistence: 'saved' | 'unchanged' | 'not-committed' | 'unknown'; presentation: string }
/** Numbers only (see electron/reply-latency.ts); text is never part of a record. */
export interface LatencyNumbers {
  status: 'complete' | 'stopped' | 'error' | 'superseded';
  firstContentMs: number | null; firstVisibleMs: number | null; firstSentenceVisibleMs: number | null;
  streamEndMs: number | null; allVisibleMs: number | null; chars: number; deltas: number;
}

/**
 * Existing host functionality, provided by electron/agent-channel/electron-wiring.ts. Every
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
  /** 熟悉度: the active character card's "关系慢慢升温" only. */
  setSlowWarmUp?(value: boolean, guard: AgentCommitGuard): Promise<unknown>;
  /** F6: the active character card's "更真实的情绪" only (turning it on is a confirm-tier call: set_setting's tierFor). */
  setRealerEmotions?(value: boolean, guard: AgentCommitGuard): Promise<unknown>;
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
  /** C3: update that card in place (same id) when it is still the planned card (`expected`); backup first. */
  updateCharacterCard?(id: string, content: string, expected: string, guard: AgentCommitGuard): Promise<CharacterCardUpdateOutcome>;
  /** The existing model-loading path (asset registration, settings, sync). */
  loadModel(file: string, guard: AgentCommitGuard): Promise<{ name: string }>;
  /** Sends a closed action to the control window; false when it cannot receive it. */
  rendererAction(action: AgentChannelRendererAction): boolean;
  diagnostics(): { replyLatency: LatencyNumbers[]; petWindow: { enabled: boolean; entries: number } };
  memory?(): { rss: number; heapUsed: number };
  uptimeSeconds?(): number;
  /** I-014: 三方互通 is on (interconnect-only settings exist only then). Absent: off. */
  interconnected?(): boolean;
  /** I-014 感知: read and switch through the same host paths as the pet's own switches. */
  perception?(): PerceptionFacts;
  setPerception?(kind: PerceptionKind, enabled: boolean, purposes: readonly SystemAudioPurpose[], guard: AgentCommitGuard): Promise<unknown>;
  /** I-014 删除记忆（进回收站）. */
  memories?: AgentMemoryBridge;
  /** I-025 本机语音识别: the control window's own view and buttons (electron/asr/electron-wiring.ts), reused. */
  localAsr?(): LocalAsrView | null;
  /** Starts the download and returns once it started; it goes on in the background (progress in the control window). */
  downloadLocalAsr?(guard: AgentCommitGuard): Promise<void>;
  cancelLocalAsrDownload?(guard: AgentCommitGuard): Promise<void>;
  removeLocalAsr?(guard: AgentCommitGuard): Promise<void>;
  /**
   * I-025 第 3 段: the rest of the settings window, each through the host operation its own control already uses
   * (electron/agent-channel/bridge.ts AGENT_HOST_OPERATIONS).
   */
  hostSettings?(): HostSettingFacts;
  /** 看看她现在怎么样 (get_her_state): the mood view the control window already reads (getMood); words are made from it in shared/her-state-words.ts. */
  herState?(): HerStateSource | null;
  /** The clock the words are measured against (tests). Default Date.now. */
  now?(): number;
  setUiLanguage?(preference: 'system' | 'en' | 'zh-CN', guard: AgentCommitGuard): Promise<void>;
  setDeveloperMode?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  setMusic?(patch: Partial<MusicSettings>, guard: AgentCommitGuard): Promise<void>;
  setPhysics?(next: ModelPhysicsSettings, guard: AgentCommitGuard): Promise<void>;
  setProactiveVision?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  setFeedRecognition?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /** I-027 心情调整员: the privacy page's own switch (electron/mood-judge/wiring.ts setMoodJudge). */
  setMoodJudge?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /** I-006 第 1 步 「知道你是不是在忙」: the privacy page's own switch (electron/user-activity.ts setEnabled). */
  setUserActivity?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  downloadPose?(guard: AgentCommitGuard): Promise<void>;
  cancelPoseDownload?(guard: AgentCommitGuard): Promise<void>;
  removePose?(guard: AgentCommitGuard): Promise<void>;
  recoverPet?(guard: AgentCommitGuard): Promise<void>;
  useBundledModel?(guard: AgentCommitGuard): Promise<void>;
  unbindCharacterModel?(id: string, guard: AgentCommitGuard): Promise<void>;
  createCharacterForCurrentModel?(guard: AgentCommitGuard): Promise<CharacterCardState>;
  /** I-024 这个模型能做什么: the current model's record and cached profile, its per-model switch, and 试一下 on the pet. */
  modelCapabilities?(): Promise<ModelCapabilityView>;
  setModelCapabilityChoice?(modelKey: string, id: ModelCapabilityId, choice: CapabilityChoice, guard: AgentCommitGuard): Promise<void>;
  previewModelCapability?(id: ModelCapabilityId, guard: AgentCommitGuard): Promise<CapabilityPreviewResult>;
  /** 通用骨架第 5 步 · 通道: one of her seven small actions, by the same rules as her own pick (electron/chat-actions-host.ts perform). */
  playChatAction?(word: ChatActionWord, guard: AgentCommitGuard): Promise<ChannelActionResult>;
  /** I-037 新的反应方式: the privacy page's own switch (electron/reactions/wiring.ts setEnabled). */
  setReactions?(enabled: boolean, guard: AgentCommitGuard): Promise<void>;
  /** I-037: the 角色页's six sliders for the current character (null: back to the card's values); returns the view and what was stored before. */
  setReactionDispositions?(values: Partial<Record<DispositionId, number>> | null, guard: AgentCommitGuard): Promise<ReactionDispositionsView & { before: Dispositions | null }>;
  reactionDispositions?(): ReactionDispositionsView | null;
}

/** I-024: the table the character page shows, for the channel: ids, labels and states only (no part names, no paths). */
function modelCapabilityFacts(view: ModelCapabilityView) {
  const card = deriveModelCapabilities(view.profile, view.record?.choices ?? {}, view.record?.haiku ?? {});
  return {
    model: view.modelKey ? 'loaded' : 'none',
    checked: view.record?.checkedAt ? new Date(view.record.checkedAt).toISOString() : null,
    items: MODEL_CAPABILITY_IDS.map(id => ({ id, label: CAPABILITY_LABELS[id], has: card[id].detected, foundBy: card[id].source,
      choice: card[id].choice ?? 'auto', on: card[id].enabled, missing: [...card[id].missing] })),
    // T-213: her actions on this model by the stage's own pre-play rule, in standard part words (never the model's own names).
    actions: (() => {
      const adaptation = modelAdaptation(view.profile, view.record?.haiku ?? {});
      return { total: HER_ACTIONS.length, possible: HER_ACTIONS.filter(id => adaptation.actions[id].ok).length, cannot: missingActionGroups(adaptation),
        // Skeleton step 2: done as an approximation (a face shape it lacks, built from its own near ones), as the character page says.
        approximate: approximateActions(adaptation).map(row => `${row.action}：没有${row.part}，用${row.using.join('、')}${row.lighter ? '拼的，会轻一点' : '代替'}`),
        fingersLeftOut: adaptation.fingerIssues.map(issue => `${fingerWords(issue.finger)}：${fingerReasonWords(issue.reason)}`),
        skeleton: adaptation.structure.map(row => `${partWords(row.bone)}接在${partWords(row.actual)}下（标准是${partWords(row.expected)}下）`) };
    })(),
    note: view.profile ? 'choice: auto 跟着有没有走；on/off 是用户在角色页（或通过 set_model_capability）选的。actions 是按骨骼结构的检查；真正做时还会核对动作轨，适配检查也可能跳过。'
      : '这个模型还没有档案（第一次载入时生成），所以都算没有。',
  };
}

/** I-025 第 3 段: what the host reports for the settings kept outside AppSettings (each null when it cannot be read). */
export interface HostSettingFacts {
  uiLanguage: 'system' | 'en' | 'zh-CN' | null;
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
}

const title = (name: string) => AGENT_TOOLS.find(tool => tool.name === name)?.title ?? name;
const unavailable = (message: string) => new AgentToolError('unavailable', message);
const CHAT_ACTION_NOTICE: Readonly<Record<ChatActionWord, string>> = Object.freeze({
  wave: '让她打招呼', nod: '让她点头', tilt: '让她歪头', heart: '让她比心', clap: '让她鼓掌', wink: '让她眨一只眼', pout: '让她撅嘴' });
const PREVIEW_LINE = '你好，我会在这里，陪你度过平常的一天。';

/** C3 update_character_card after its checks: the file the user is asked about and the plan the dialog shows. */
interface CardUpdateRequest { facts: FileFacts; content: string; id: string; name: string; plan: CharacterCardUpdatePlanView }

/** Settings that live on the active character card rather than in AppSettings. */
export type SettingCards = Pick<CharacterCardState, 'cards' | 'activeId'>;
/**
 * Settings kept outside AppSettings and the cards: the recycle bin's retention (I-014); the microphone switch and the local
 * recognizer (I-025).
 */
export interface SettingExtras { recycleDays?: number | null; voiceInput?: boolean | null; localAsr?: LocalAsrView | null; host?: HostSettingFacts | null }

/** I-025 第 3 段: a component's phase (local pose sensing) as its setting reads it, like local_asr. */
export function componentValue(view: { phase: string } | null | undefined): AgentSettingValue | null {
  if (!view) return null;
  if (view.phase === 'unsupported') return 'unsupported';
  if (view.phase === 'downloading' || view.phase === 'installing') return 'downloading';
  return view.phase === 'not-installed' ? 'not-installed' : 'installed';
}
/** I-025 第 3 段: what downloading local pose sensing means (size from the host, sources from its manifest). */
export function poseDownloadText(view: PoseSensingView | null | undefined): string {
  const size = view?.downloadBytes && view.downloadBytes > 0 ? `约 ${megabytes(view.downloadBytes)} MB` : '一百多 MB';
  return `要下载${size}：姿态识别模型（RTMPose，来自 OpenMMLab）和识别运行组件（onnxruntime）。下载后在这台电脑上识别伸懒腰、打哈欠等，画面不上传；下完还要打开摄像头才会用。`;
}

/** I-025: the local recognizer's phase as the local_asr setting reads it. */
export function localAsrValue(view: LocalAsrView | null | undefined): AgentSettingValue | null {
  if (!view) return null;
  if (view.phase === 'unsupported') return 'unsupported';
  if (view.phase === 'downloading' || view.phase === 'installing') return 'downloading';
  return view.phase === 'not-installed' ? 'not-installed' : 'installed';
}

/** Bytes of the recognition model itself (the SenseVoice files from Hugging Face), from the manifest. */
export const ASR_MODEL_BYTES = ASR_ARCHIVES.filter(archive => archive.kind === 'file').reduce((sum, archive) => sum + archive.networkBytes, 0);
const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

/**
 * I-025: what downloading the local recognizer means, in the words the chat card, the dialog and the handbook show: how much,
 * from where, what it is for. Sizes come from the host's own view (the manifest), never from model text.
 */
export function localAsrDownloadText(view: LocalAsrView | null | undefined): string {
  const total = view?.downloadBytes && view.downloadBytes > 0 ? view.downloadBytes : ASR_MODEL_BYTES;
  const runtime = total - ASR_MODEL_BYTES;
  return `要下载约 ${megabytes(total)} MB：SenseVoice 识别模型约 ${megabytes(ASR_MODEL_BYTES)} MB，来自 Hugging Face（${SENSEVOICE_REPO}）`
    + (runtime > 1_000_000 ? `；另有约 ${megabytes(runtime)} MB 的识别运行组件（onnxruntime）` : '')
    + '。下载后免费，声音只在这台电脑上识别、不上传；下载完还要再打开语音输入才会用麦克风。';
}
export const VOICE_INPUT_ON_TEXT = '打开后会用麦克风听你说话，停顿时转成文字发给她；声音只在这台电脑上识别（用本机识别时）。随时可以关。';

/** I-025: one line that explains a value needing consent (chat card, dialog, handbook); undefined for the rest. */
export function settingDetail(id: AgentSettingId, value: AgentSettingValue, extras?: SettingExtras): string | undefined {
  if (id === 'local_asr' && value === 'installed') return localAsrDownloadText(extras?.localAsr);
  if (id === 'local_asr' && value === 'not-installed')
    return localAsrValue(extras?.localAsr) === 'downloading' ? '取消正在进行的下载。' : '删除已下载的识别组件（之后要用语音输入得重新下载），不动聊天记录。';
  if (id === 'voice_input' && value === true) return VOICE_INPUT_ON_TEXT;
  if (id === 'pose_sensing' && value === 'installed') return poseDownloadText(extras?.host?.pose);
  if (id === 'pose_sensing' && value === 'not-installed')
    return componentValue(extras?.host?.pose) === 'downloading' ? '取消正在进行的下载。' : '删除已下载的姿态感知组件（之后要用得重新下载），不动任何记录。';
  if (id === 'proactive_vision' && value === true) return '屏幕共享开着时，她会看画面主动找话题；画面会交给你的 Claude（占用量）。随时可以关。';
  if (id === 'feed_recognition' && value === true) return '喂食时，图会缩小后交给你的 Claude 认一下（占用量），她会说出是什么。随时可以关。';
  if (id === 'pause_talk' && value === true)
    return '她每条回复都会多问一次你 Claude 里的 haiku（占用量，普通的一天 30～80 次）：按她的性格和此刻的心情，定说到哪停一下、要不要停下来等你接话。第一个字照样马上出来。随时可以关。';
  if (id === 'user_activity' && value === true)
    return '打开后，应用会每秒读一次“距你上次动键盘鼠标过了多少秒”，再加上有没有锁屏、电脑有没有睡眠、她的窗口有没有拿到焦点，据此知道你是不是在专心做事，好让她安静下来做自己的事。不知道你按了什么键、在哪个窗口、鼠标去了哪里；不存任何记录。随时可以关。';
  if (id === 'new_reactions' && value === true)
    return '你每发一句话，你 Claude 里的 haiku 会和她的回答同时看一眼（第一个字不等它），替她从反应清单里挑 0～2 个反应，并给这句话的心情变化（占用量：每句最多一次，每天最多 800 次）。开着时心情调整员不再重复看消息。随时可以关。';
  if (id === 'mood_judge' && value === true)
    return '她身上发生的事照常马上起作用；过一两分钟，你 Claude 里的 haiku 会按她的性格和此刻的心情再微调一下心情数（占用量，普通的一天约 80 次，每天最多 200 次）。不发图片和听到的原文。随时可以关。';
  if (id === 'chat_model') return value === 'opus' ? '换成 opus：回答更细，也最占你的 Claude 用量。' : value === 'haiku' ? '换成 haiku：最快、最省用量。'
    : value === '' ? '跟随你 Claude Code 自己的默认模型。' : `换成 ${String(value)}。`;
  if (id === 'voice_provider' && value === 'bailian') return '切到百炼：每读一句都会用你的百炼账号付费。';
  return undefined;
}

function settingValue(id: AgentSettingId, settings: AppSettings, cards?: SettingCards, extras?: SettingExtras): AgentSettingValue | null {
  switch (id) {
    case 'voice_provider': return settings.tts?.provider === 'bailian' ? 'bailian' : 'system';
    case 'recycle_bin_days': return typeof extras?.recycleDays === 'number' ? extras.recycleDays : null;
    case 'voice_input': return typeof extras?.voiceInput === 'boolean' ? extras.voiceInput : null;
    case 'local_asr': return localAsrValue(extras?.localAsr);
    case 'click_through': return settings.pet.clickThrough;
    case 'chat_model': return settings.provider?.model ?? '';
    case 'voice_rate': return Math.round(settings.voice.rate * 100);
    case 'voice_mood_influence': return Math.round(settings.voice.moodInfluence ?? 50);
    case 'voice_first_chunk': return settings.voice.firstChunk === 'comma' ? 'comma' : 'sentence';
    case 'pause_talk': return settings.voice.pauseTalk === true;
    case 'ui_language': return extras?.host?.uiLanguage ?? null;
    case 'developer_mode': return extras?.host?.developerMode ?? null;
    case 'music_strength': return extras?.host?.music ? Math.round(extras.host.music.strength * 100) : null;
    case 'music_always_dance': return extras?.host?.music ? extras.host.music.alwaysDance : null;
    case 'proactive_vision': return extras?.host?.proactiveVision ?? null;
    case 'feed_recognition': return extras?.host?.feedRecognition ?? null;
    case 'mood_judge': return extras?.host?.moodJudge ?? null;
    case 'new_reactions': return extras?.host?.reactions ?? null;
    case 'user_activity': return extras?.host?.userActivity ?? null;
    case 'pose_sensing': return componentValue(extras?.host?.pose);
    case 'physics_hair': return extras?.host?.physics ? extras.host.physics.hair.enabled : null;
    case 'physics_chest': return extras?.host?.physics ? extras.host.physics.chest.enabled : null;
    case 'physics_quality': return extras?.host?.physics ? extras.host.physics.quality : null;
    case 'slow_warm_up': {
      const active = cards?.cards.find(card => card.id === cards.activeId);
      return active ? active.slowWarmUp === true : null;
    }
    case 'realer_emotions': {
      const active = cards?.cards.find(card => card.id === cards.activeId);
      return active ? active.realerEmotions === true : null;
    }
    case 'proactive_talk': return proactiveTalk(settings.proactiveTalk);
    case 'experience_journal': return settings.experienceJournal === true;
    case 'read_aloud': return settings.voice.enabled;
    case 'readout_volume': return Math.round(settings.voice.volume * 100);
    case 'pet_visible': return settings.pet.visible;
    case 'always_on_top': return settings.pet.alwaysOnTop;
    case 'follow_mouse': return settings.pet.followMouse;
    case 'breath': return Math.round(settings.pet.breath * 100);
    case 'fps': return settings.pet.fps;
  }
}

/** F6: the consent dialog for "更真实的情绪", the same words the card editor's dialog shows (shared/realer-emotions.ts). */
export function realerEmotionsConfirmation(cards: SettingCards | null | undefined): { title: string; detail: string; buttons: readonly [string, string] } {
  const name = cards?.cards.find(card => card.id === cards.activeId)?.name ?? '当前角色';
  return { title: REALER_EMOTIONS_CONSENT.message(name), detail: REALER_EMOTIONS_CONSENT.detail,
    buttons: [REALER_EMOTIONS_CONSENT.decline, REALER_EMOTIONS_CONSENT.accept] };
}

export function settingViews(settings: AppSettings, cards?: SettingCards, extras?: SettingExtras): AgentSettingView[] {
  return AGENT_SETTINGS.map(spec => ({ ...structuredClone(spec), value: settingValue(spec.id, settings, cards, extras) }));
}

/** I-014: the informational box shown once (not waited for) when "更真实的情绪" turned on without its dialog. */
export function realerEmotionsInformation(cards: SettingCards | null | undefined): { title: string; detail: string } {
  const name = cards?.cards.find(card => card.id === cards.activeId)?.name ?? '当前角色';
  return { title: `已给「${name}」打开“更真实的情绪”`, detail: REALER_EMOTIONS_CONSENT.detail };
}

const PERCEPTION_LABELS: Readonly<Record<PerceptionKind, string>> = Object.freeze({ camera: '摄像头', camera_images: '摄像头发图片', camera_pose: '摄像头姿势识别',
  microphone: '麦克风', screen: '屏幕共享', system_audio: '电脑声音' });
const PURPOSE_LABELS: Readonly<Record<SystemAudioPurpose, string>> = Object.freeze({ music: '陪听音乐', movie: '陪看视频' });
function perceptionOn(facts: PerceptionFacts, kind: PerceptionKind, purposes: readonly SystemAudioPurpose[]): boolean {
  if (kind === 'system_audio') return purposes.some(purpose => facts.systemAudio[purpose]);
  if (kind === 'camera_images') return facts.cameraImages === true;
  if (kind === 'camera_pose') return facts.cameraPose === true;
  return facts[kind];
}

function describe(spec: AgentSettingSpec, value: AgentSettingValue | null): string {
  if (value === null) return '未知';
  if (spec.kind === 'number') return `${value}${spec.unit}`;
  return spec.choices.find(choice => choice.value === value)?.label ?? AGENT_SETTING_STATE_LABELS[String(value)] ?? String(value);
}

/**
 * I-025: whether this value of the setting needs the user's consent (confirm tier). In her chat a card that shows what happens
 * (`cardConsent`) is that consent already; "更真实的情绪" keeps its own dialog there too, as before.
 */
export function settingNeedsConsent(spec: AgentSettingSpec, value: AgentSettingValue, via: 'agent' | 'chat'): boolean {
  if (!spec.confirmWhen?.some(item => item === value)) return false;
  return !(via === 'chat' && spec.cardConsent === true);
}

function committed(result: CommitResult): void {
  if (result.persistence === 'not-committed') throw unavailable('桌宠窗口尚未就绪，没有保存。');
  if (result.persistence === 'unknown') throw unavailable('无法确认设置是否保存，请查看控制窗口。');
}

/** The values settingViews needs beyond AppSettings and the cards (each read on its own; a failing read is unknown). */
export function settingExtras(bridge: Pick<AgentAppBridge, 'memories' | 'perception' | 'localAsr' | 'hostSettings'>): SettingExtras {
  const read = <T>(work: () => T | undefined): T | null => { try { return work() ?? null; } catch { return null; } };
  return { recycleDays: read(() => bridge.memories?.days()), voiceInput: read(() => bridge.perception?.().microphone), localAsr: read(() => bridge.localAsr?.()),
    host: read(() => bridge.hostSettings?.()) };
}

export interface AppToolOptions {
  fs?: FileSystemPort; platform?: NodeJS.Platform; readText?(file: string): Promise<string>;
  /** Who calls these tools: the external channel (default) or the pet's chat setting cards (electron/chat-settings.ts). */
  settingVia?: 'agent' | 'chat';
}

export function createAppTools(bridge: AgentAppBridge, options: AppToolOptions = {}): AgentToolDefinition[] {
  const fs = options.fs ?? nodeFileSystem, platform = options.platform ?? process.platform, via = options.settingVia ?? 'agent';
  const readText = options.readText ?? (file => readFile(file, 'utf8'));
  const card = (id: string) => {
    const found = bridge.characters().cards.find(item => item.id.toLowerCase() === id);
    if (!found) throw new AgentToolError('invalid_input', '没有这张角色卡，请先用 list_characters 查看。');
    return found;
  };
  const setReadAloud = async (enabled: boolean, guard: AgentCommitGuard) => {
    const current = bridge.settings();
    if (current.voice.enabled !== enabled) await bridge.saveSettings({ ...current, voice: { ...current.voice, enabled } }, guard);
    return bridge.settings().voice.enabled;
  };
  /** I-014: 三方互通 is on right now (a failing reader means off). */
  const interconnected = () => { try { return bridge.interconnected?.() === true; } catch { return false; } };
  // I-025: the microphone's state is read only with 三方互通 on (as get_status shows perception only then).
  const extras = (): SettingExtras => { const more = settingExtras(bridge); return interconnected() ? more : { ...more, voiceInput: null }; };
  const valueOf = (id: AgentSettingId) => settingValue(id, bridge.settings(), bridge.characters(), extras());
  const activeId = () => bridge.characters().activeId;
  const applySetting = async (id: AgentSettingId, value: AgentSettingValue, guard: AgentCommitGuard): Promise<void> => {
    switch (id) {
      case 'voice_provider': {
        const current = bridge.settings(), tts = current.tts ?? structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig;
        // The key itself never crosses the channel: the public settings only say whether one is saved.
        if (value === 'bailian' && (!tts.apiKey || !tts.apiHost?.trim()))
          throw unavailable('还没有设好百炼的连接和密钥。请在控制窗口「连接与声音」里自己设置（密钥不经过内部通道）。');
        if (tts.provider !== value) await bridge.saveSettings({ ...current, tts: { ...tts, provider: value as TtsConfig['provider'] } }, guard);
        return;
      }
      case 'recycle_bin_days':
        if (!bridge.memories) throw unavailable('这个版本还没有回收站。');
        await bridge.memories.setDays(value as number, guard); return;
      case 'slow_warm_up':
        if (!bridge.setSlowWarmUp) throw unavailable('这个版本还不能在聊天里改角色卡设置。');
        await bridge.setSlowWarmUp(value as boolean, guard); return;
      case 'realer_emotions':
        if (!bridge.setRealerEmotions) throw unavailable('这个版本还不能在聊天里改角色卡设置。');
        await bridge.setRealerEmotions(value as boolean, guard); return;
      case 'experience_journal':
        if (!bridge.setExperienceJournal) throw unavailable('这个版本还不能通过内部通道改体验记录开关。');
        await bridge.setExperienceJournal(value as boolean, guard); return;
      case 'voice_input': {
        // I-025: the same host path as the user's own 「语音输入」 switch (the pet window's, as set_perception).
        if (!bridge.perception || !bridge.setPerception) throw unavailable('这个版本还不能这样开关语音输入。');
        const pet = bridge.windows().pet;
        if (value === true && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来，语音输入在桌宠上打开。');
        await bridge.setPerception('microphone', value as boolean, [], guard);
        if (value === true && !bridge.perception().microphone) {
          const asr = localAsrValue(extras().localAsr);
          throw unavailable(asr === 'not-installed' || asr === 'downloading'
            ? `语音输入没有打开：本机语音识别${asr === 'downloading' ? '还在下载' : '还没有下载'}（local_asr）。下载好以后再打开。`
            : '语音输入没有打开：可能缺少语音识别连接，soft hearts 上会有说明。');
        }
        return;
      }
      case 'click_through': case 'chat_model': case 'voice_rate': case 'voice_mood_influence': case 'voice_first_chunk': case 'pause_talk': case 'proactive_talk': {
        // The settings window's own whole-settings save (the same form fields).
        const current = bridge.settings();
        const next = id === 'click_through' ? { ...current, pet: { ...current.pet, clickThrough: value as boolean } }
          : id === 'chat_model' ? { ...current, provider: { ...current.provider, model: value as string } }
          : id === 'voice_rate' ? { ...current, voice: { ...current.voice, rate: (value as number) / 100 } }
          : id === 'voice_first_chunk' ? { ...current, voice: { ...current.voice, firstChunk: value as 'sentence' | 'comma' } }
          : id === 'proactive_talk' ? { ...current, proactiveTalk: proactiveTalk(value) }
          : id === 'pause_talk' ? { ...current, voice: { ...current.voice, pauseTalk: value as boolean } }
          : { ...current, voice: { ...current.voice, moodInfluence: value as number } };
        if (settingValue(id, current) !== value) await bridge.saveSettings(next, guard);
        return;
      }
      case 'ui_language':
        if (!bridge.setUiLanguage) throw unavailable('这个版本还不能这样改界面语言。');
        await bridge.setUiLanguage(value as 'system' | 'en' | 'zh-CN', guard); return;
      case 'developer_mode':
        if (!bridge.setDeveloperMode) throw unavailable('这个版本还不能这样开关开发者模式。');
        await bridge.setDeveloperMode(value as boolean, guard); return;
      case 'music_strength': case 'music_always_dance':
        if (!bridge.setMusic) throw unavailable('这个版本还不能这样改音乐律动。');
        await bridge.setMusic(id === 'music_strength' ? { strength: (value as number) / 100 } : { alwaysDance: value as boolean }, guard); return;
      case 'physics_hair': case 'physics_chest': case 'physics_quality': {
        const physics = extras().host?.physics;
        if (!bridge.setPhysics || !physics) throw unavailable('这个版本还不能这样改局部物理。');
        await bridge.setPhysics(id === 'physics_quality' ? { ...physics, quality: value as ModelPhysicsSettings['quality'] }
          : { ...physics, [id === 'physics_hair' ? 'hair' : 'chest']: { ...physics[id === 'physics_hair' ? 'hair' : 'chest'], enabled: value as boolean } }, guard);
        return;
      }
      case 'proactive_vision':
        if (!bridge.setProactiveVision) throw unavailable('这个版本还不能这样开关“根据画面主动聊天”。');
        await bridge.setProactiveVision(value as boolean, guard); return;
      case 'feed_recognition':
        if (!bridge.setFeedRecognition) throw unavailable('这个版本还不能这样开关喂食认图。');
        await bridge.setFeedRecognition(value as boolean, guard); return;
      case 'user_activity':
        if (!bridge.setUserActivity) throw unavailable('这个版本还不能这样开关“知道你是不是在忙”。');
        await bridge.setUserActivity(value as boolean, guard); return;
      case 'mood_judge':
        if (!bridge.setMoodJudge) throw unavailable('这个版本还不能这样开关心情调整员。');
        await bridge.setMoodJudge(value as boolean, guard); return;
      case 'new_reactions':
        if (!bridge.setReactions) throw unavailable('这个版本还不能这样开关新的反应方式。');
        await bridge.setReactions(value as boolean, guard); return;
      case 'pose_sensing': {
        // The privacy page's own 「下载」/「取消」/「删除感知组件」 (electron/pose/control-ipc.ts), reused as they are.
        if (!bridge.downloadPose || !bridge.cancelPoseDownload || !bridge.removePose) throw unavailable('这个版本还不能这样下载姿态感知组件。');
        const now = componentValue(extras().host?.pose);
        if (now === null || now === 'unsupported') throw unavailable('这台电脑用不了本机姿态感知（只支持 Windows ARM64 / x64）。');
        if (value === 'installed') { if (now === 'not-installed') await bridge.downloadPose(guard); return; }
        if (now === 'downloading') await bridge.cancelPoseDownload(guard);
        else if (now === 'installed') await bridge.removePose(guard);
        return;
      }
      case 'local_asr': {
        // I-025: the control window's own 「下载」/「取消」/「删除识别组件」 (electron/asr/electron-wiring.ts), reused as they are.
        if (!bridge.localAsr || !bridge.downloadLocalAsr || !bridge.cancelLocalAsrDownload || !bridge.removeLocalAsr)
          throw unavailable('这个版本还不能这样下载本机语音识别。');
        const now = localAsrValue(bridge.localAsr());
        if (now === null || now === 'unsupported') throw unavailable('这台电脑用不了本机语音识别（只支持 Windows ARM64 / x64）。');
        if (value === 'installed') { if (now === 'not-installed') await bridge.downloadLocalAsr(guard); return; }
        if (now === 'downloading') await bridge.cancelLocalAsrDownload(guard);
        else if (now === 'installed') await bridge.removeLocalAsr(guard);
        return;
      }
      case 'read_aloud': await setReadAloud(value as boolean, guard); return;
      case 'readout_volume': committed(await bridge.commitReadoutVolume(value as number, guard)); return;
      case 'pet_visible': await bridge.setPetVisible(value as boolean, guard); return;
      case 'always_on_top': committed(await bridge.commitPetBoolean(value as boolean, 'pet.set-always-on-top', guard)); return;
      case 'follow_mouse': committed(await bridge.commitPetBoolean(value as boolean, 'pet.set-follow-mouse', guard)); return;
      case 'breath': committed(await bridge.commitBreath(value as number, guard)); return;
      case 'fps': {
        const current = bridge.settings();
        if (current.pet.fps !== value) await bridge.saveSettings({ ...current, pet: { ...current.pet, fps: value as number } }, guard);
      }
    }
  };
  /** Renderer requests are sent synchronously; the check is the last step before sending. */
  const rendererAction = (action: AgentChannelRendererAction, context: AgentCallContext) => {
    context.check();
    return bridge.rendererAction(action);
  };
  /** I-025 手册: an entry's value as far as this channel may read it (on/off, names and numbers only; never chat text or keys). */
  const handbookValue = (entry: CapabilityEntry): unknown => {
    const channel = entry.channel;
    if (channel && 'setting' in channel) {
      if (agentSetting(channel.setting)?.interconnectOnly && !interconnected()) return undefined;
      return valueOf(channel.setting);
    }
    const settings = bridge.settings();
    const sensed = () => { try { return interconnected() && bridge.perception ? bridge.perception() : null; } catch { return null; } };
    switch (entry.id) {
      case 'active_character': {
        const cards = bridge.characters(), active = cards.cards.find(item => item.id === cards.activeId);
        return active ? { id: active.id, name: active.name } : null;
      }
      case 'model': return settings.model ? settings.model.name : null;
      case 'voice_input': return sensed()?.microphone;
      case 'screen_sharing': return sensed()?.screen;
      case 'camera_sharing': return sensed()?.camera;
      case 'camera_images': return sensed()?.cameraImages;
      case 'camera_pose': return sensed()?.cameraPose;
      case 'system_audio': return sensed()?.systemAudio;
      case 'interconnect': return interconnected();
      case 'click_through': return settings.pet.clickThrough;
      case 'chat_model': return settings.provider?.model || '默认';
      case 'camera': return { ...settings.camera };
      case 'system_voice': return { rate: settings.voice.rate, moodInfluence: settings.voice.moodInfluence ?? 50 };
      default: return undefined;
    }
  };
  const controlsReady = (needsVisible: boolean) => {
    const controls = bridge.windows().controls;
    if (!controls || (needsVisible && (!controls.visible || controls.minimized)))
      throw unavailable(needsVisible ? '请先打开控制窗口的“外观”页，让模型预览显示出来。' : '控制窗口尚未就绪。');
  };

  const tools: AgentToolDefinition<any, any>[] = [
    {
      name: 'get_status', title: title('get_status'), tier: 'read', validate: noArgs,
      run: () => {
        const settings = bridge.settings(), cards = bridge.characters(), windows = bridge.windows();
        const active = cards.cards.find(item => item.id === cards.activeId);
        const provider = settings.tts?.provider === 'bailian' ? 'bailian' : 'system';
        return {
          app: 'soft hearts', version: bridge.version(),
          character: active ? { id: active.id, name: active.name } : null,
          model: settings.model ? { name: settings.model.name } : null,
          voice: { provider, providerLabel: provider === 'bailian' ? '百炼（按次付费）' : '系统声音（免费）',
            readAloud: settings.voice.enabled, volumePercent: Math.round(settings.voice.volume * 100) },
          windows: { pet: windows.pet, controls: windows.controls, petVisibleSetting: settings.pet.visible },
          // I-014: whether the user keeps Claude, her chat and the settings in step; what is being sensed (on/off only).
          interconnect: interconnected(),
          ...(interconnected() && bridge.perception ? { perception: (() => { try { return bridge.perception!(); } catch { return null; } })() } : {}),
        };
      },
    },
    {
      // how she is, in plain words (no chat, diary or profile text, no raw numbers).
      name: 'get_her_state', title: title('get_her_state'), tier: 'read', validate: noArgs,
      run: () => {
        if (!bridge.herState) throw unavailable('这个版本还不能读她的状态。');
        let source: HerStateSource | null = null;
        try { source = bridge.herState(); } catch { source = null; }
        if (!source) throw unavailable('现在读不到她的状态（桌宠还没准备好）。');
        const words = herStateWords(source, (bridge.now ?? Date.now)());
        const card = bridge.characters().cards.find(item => item.id === bridge.characters().activeId);
        return { character: card ? card.name : null, ...words };
      },
    },
    {
      name: 'list_characters', title: title('list_characters'), tier: 'read', validate: noArgs,
      run: () => {
        const state = bridge.characters();
        return { activeId: state.activeId, characters: state.cards.map(item => ({
          id: item.id, name: item.name, modelName: item.modelName ?? null, active: item.id === state.activeId })) };
      },
    },
    {
      name: 'list_settings', title: title('list_settings'), tier: 'read', validate: noArgs,
      run: () => {
        const more = extras();
        return {
          settings: settingViews(bridge.settings(), bridge.characters(), more).filter(view => !view.interconnectOnly || interconnected()).map(view => {
            // I-025: what a value needing consent means (download size and source, the microphone), for telling the user first.
            const details = (view.kind === 'number' ? [] : view.choices).flatMap(choice => {
              const text = settingDetail(view.id, choice.value, more);
              return text ? [{ value: choice.value, detail: text }] : [];
            });
            return details.length ? { ...view, details } : view;
          }),
          tiers: AGENT_TIER_LABELS, interconnect: interconnected(),
        };
      },
    },
    {
      // I-025: the handbook generated from the capability list (shared/capabilities.ts), with what can be read right now.
      name: 'read_handbook', title: title('read_handbook'), tier: 'read',
      validate: raw => {
        const category = argsObject(raw, ['category']).category;
        if (category !== undefined && !isCapabilityCategory(category))
          throw new AgentToolError('invalid_input', 'category 只接受：window、chat、characters、appearance、memory、providers、agent、privacy。');
        return category ?? null;
      },
      run: (category: string | null) => {
        const interconnect = interconnected();
        if (!category || !isCapabilityCategory(category)) return handbookIndex({ interconnect });
        return handbookCategory(category, { interconnect, value: handbookValue });
      },
    },
    {
      name: 'get_diagnostics', title: title('get_diagnostics'), tier: 'read', validate: noArgs,
      run: () => {
        const facts = bridge.diagnostics(), records = facts.replyLatency.slice(-20);
        const numbers = (key: keyof LatencyNumbers) => records.map(record => record[key]).filter((v): v is number => typeof v === 'number');
        const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
          return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
        const last = records.at(-1);
        const memory = (bridge.memory ?? (() => { const usage = process.memoryUsage(); return { rss: usage.rss, heapUsed: usage.heapUsed }; }))();
        return {
          replyLatency: {
            samples: records.length,
            complete: records.filter(record => record.status === 'complete').length,
            stoppedOrError: records.filter(record => record.status !== 'complete').length,
            medianFirstContentMs: median(numbers('firstContentMs')),
            medianFirstVisibleMs: median(numbers('firstVisibleMs')),
            medianAllVisibleMs: median(numbers('allVisibleMs')),
            last: last ? { firstContentMs: last.firstContentMs, firstVisibleMs: last.firstVisibleMs,
              firstSentenceVisibleMs: last.firstSentenceVisibleMs, allVisibleMs: last.allVisibleMs, chars: last.chars, deltas: last.deltas } : null,
          },
          memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
          uptimeSeconds: Math.round(bridge.uptimeSeconds?.() ?? process.uptime()),
          petWindowDiagnostics: { enabled: facts.petWindow.enabled, entries: facts.petWindow.entries },
          frameClock: null,
          notes: ['回复延迟只在开发者模式下记录。', '帧时钟只在渲染端画布上（data-frame-clock），主进程读不到。'],
        };
      },
    },
    {
      name: 'activate_character', title: title('activate_character'), tier: 'reversible',
      validate: raw => ({ id: cardId(argsObject(raw, ['id']).id) }),
      prepare: (input: { id: string }) => card(input.id),
      noticeDetail: (target: { name: string }) => `换成「${target.name}」`,
      run: async (target: { id: string; name: string }, context: AgentCallContext) => {
        const previous = activeId();
        await bridge.activateCharacter(target.id, context.check);
        const state = bridge.characters();
        const back = state.cards.find(item => item.id === previous);
        if (back && previous !== state.activeId) context.offerUndo({ label: `换回「${back.name}」`, run: async guard => {
          if (activeId() !== target.id) throw unavailable('之后又换过角色了，没有撤回。');
          await bridge.activateCharacter(back.id, guard);
        } });
        return { activeId: state.activeId, name: state.cards.find(item => item.id === state.activeId)?.name ?? null };
      },
    },
    {
      name: 'set_read_aloud', title: title('set_read_aloud'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['state']).state, ['on', 'off'] as const, 'state '),
      run: async (state: 'on' | 'off', context: AgentCallContext) => {
        const previous = bridge.settings().voice.enabled;
        const readAloud = await setReadAloud(state === 'on', context.check);
        if (readAloud !== previous) context.offerUndo({ label: previous ? '重新打开朗读' : '关掉朗读', run: async guard => {
          if (bridge.settings().voice.enabled !== readAloud) throw unavailable('朗读之后又改过了，没有撤回。');
          await setReadAloud(previous, guard);
        } });
        return { readAloud };
      },
    },
    {
      name: 'set_setting', title: title('set_setting'), tier: 'reversible',
      validate: raw => {
        const args = argsObject(raw, ['id', 'value']), spec = agentSetting(args.id);
        // I-014: an interconnect-only setting does not exist while 三方互通 is off.
        if (!spec || (spec.interconnectOnly && !interconnected())) throw new AgentToolError('invalid_input', '没有这项设置，请先用 list_settings 查看。');
        try { return { spec, value: validateAgentSettingValue(spec, args.value) }; }
        catch (error) { throw new AgentToolError('invalid_input', (error as Error).message); }
      },
      // F6: turning "更真实的情绪" on asks the user first, with what it does in plain words; turning it off does not. I-025: the same
      // for every value a setting marks (`confirmWhen`: the microphone on, the recognizer's download and removal). With 三方互通 on
      // the call must carry the user's words (registry); with it off the dialog below asks. Her chat: see settingNeedsConsent.
      tierFor: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => settingNeedsConsent(input.spec, input.value, via) ? 'confirm' : input.spec.tier,
      confirmation: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => {
        if (input.spec.id === 'realer_emotions') return realerEmotionsConfirmation(bridge.characters());
        const detail = settingDetail(input.spec.id, input.value, extras());
        if (input.spec.id === 'local_asr') return { title: input.value === 'installed' ? 'Claude 请求下载本机语音识别' : 'Claude 请求取消或删除本机语音识别', detail: detail ?? '' };
        if (input.spec.id === 'voice_input') return { title: 'Claude 请求打开语音输入（会用麦克风）', detail: detail ?? '' };
        if (input.spec.id === 'pose_sensing') return { title: input.value === 'installed' ? 'Claude 请求下载本机姿态感知组件' : 'Claude 请求取消或删除姿态感知组件', detail: detail ?? '' };
        if (detail) return { title: `Claude 请求把「${input.spec.label}」改为 ${describe(input.spec, input.value)}`, detail };
        return {
          title: `Claude 请求修改「${input.spec.label}」`,
          detail: `从：${describe(input.spec, valueOf(input.spec.id))}\n改为：${describe(input.spec, input.value)}`,
        };
      },
      informWithoutDialog: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) =>
        input.spec.id === 'realer_emotions' && input.value === true ? realerEmotionsInformation(bridge.characters()) : undefined,
      noticeDetail: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => {
        if (input.spec.id === 'local_asr') {
          if (input.value === 'installed') return `开始下载本机语音识别（约 ${megabytes(extras().localAsr?.downloadBytes || ASR_MODEL_BYTES)} MB，来自 Hugging Face）`;
          return localAsrValue(extras().localAsr) === 'downloading' ? '取消下载本机语音识别' : '删除本机语音识别组件';
        }
        if (input.spec.id === 'voice_input') return input.value === true ? '打开语音输入（麦克风）' : '关闭语音输入（麦克风）';
        if (input.spec.id === 'pose_sensing') {
          if (input.value === 'installed') return `开始下载本机姿态感知组件${extras().host?.pose?.downloadBytes ? `（约 ${megabytes(extras().host!.pose!.downloadBytes)} MB）` : ''}`;
          return componentValue(extras().host?.pose) === 'downloading' ? '取消下载姿态感知组件' : '删除姿态感知组件';
        }
        return `「${input.spec.label}」改为 ${describe(input.spec, input.value)}`;
      },
      wordsItem: (input: { spec: AgentSettingSpec; value: AgentSettingValue }) => ({ item: input.spec.id, value: input.value }),
      run: async (input: { spec: AgentSettingSpec; value: AgentSettingValue }, context: AgentCallContext) => {
        const { spec } = input, card = activeId();
        const previous = valueOf(spec.id);
        await applySetting(spec.id, input.value, context.check);
        const value = valueOf(spec.id);
        try { bridge.settingChanged?.(spec.id, previous, value, via); } catch { /* Keeping a record never undoes a change. */ }
        // I-025: a download goes on in the background and is not undone by 撤回 (删除 is its own request, with the user's words).
        if (spec.id === 'pose_sensing') return { id: spec.id, label: spec.label, previous, value, ...(value === 'downloading'
          ? { note: '已开始下载，进度在控制窗口「隐私与设置 → 输入与共享」；下载好以后用户打开摄像头才会用到。' } : {}) };
        if (spec.id === 'local_asr') return { id: spec.id, label: spec.label, previous, value, ...(value === 'downloading'
          ? { note: '已开始下载，进度在控制窗口「连接与声音 → 语音输入」；下载好以后可以用 voice_input 打开语音输入（也要用户的原话）。' } : {}) };
        // I-014 撤回: back to the previous value, only while nobody changed it since (and on the same card for card settings).
        // I-025: 撤回 never does what needs the user's words (the microphone back on, the paid voice, a bigger model, sharing more).
        if (previous !== null && value !== previous && !spec.confirmWhen?.some(item => item === previous)) context.offerUndo({ label: `把「${spec.label}」改回 ${describe(spec, previous)}`, run: async guard => {
          if (valueOf(spec.id) !== value || ((spec.id === 'slow_warm_up' || spec.id === 'realer_emotions') && activeId() !== card))
            throw unavailable(`「${spec.label}」之后又改过了，没有撤回。`);
          await applySetting(spec.id, previous, guard);
          try { bridge.settingChanged?.(spec.id, value, valueOf(spec.id), via); } catch { /* As above. */ }
        } });
        return { id: spec.id, label: spec.label, previous, value };
      },
    },
    {
      name: 'play_preview', title: title('play_preview'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['kind']).kind, ['surprise', 'shy'] as const, 'kind '),
      prepare: (kind: 'surprise' | 'shy') => { controlsReady(true); return kind; },
      run: (kind: 'surprise' | 'shy', context: AgentCallContext) => {
        if (!rendererAction({ kind: 'play-preview', recipe: kind }, context)) throw unavailable('控制窗口尚未就绪。');
        return { requested: true, kind, note: '已请求控制窗口播放；结果显示在模型预览下方。' };
      },
    },
    {
      // I-024 这个模型能做什么 (the character page's table, the same host operations).
      name: 'list_model_capabilities', title: title('list_model_capabilities'), tier: 'read', validate: noArgs,
      run: async () => {
        if (!bridge.modelCapabilities) throw unavailable('这个版本还没有模型体检。');
        return modelCapabilityFacts(await bridge.modelCapabilities());
      },
    },
    {
      name: 'set_model_capability', title: title('set_model_capability'), tier: 'reversible',
      validate: raw => { const args = argsObject(raw, ['id', 'value']);
        return { id: oneOf(args.id, MODEL_CAPABILITY_IDS, 'id '), value: oneOf(args.value, ['on', 'off'] as const, 'value ') }; },
      prepare: async (input: { id: ModelCapabilityId; value: 'on' | 'off' }) => {
        if (!bridge.modelCapabilities || !bridge.setModelCapabilityChoice) throw unavailable('这个版本还不能这样开关。');
        const view = await bridge.modelCapabilities();
        if (!view.modelKey) throw unavailable('请先载入一个模型。');
        const label = CAPABILITY_LABELS[input.id];
        const card = deriveModelCapabilities(view.profile, view.record?.choices ?? {}, view.record?.haiku ?? {});
        if (input.value === 'on' && !card[input.id].detected) throw unavailable(`这个模型没有「${label}」需要的部位，打不开。`);
        return { ...input, label, modelKey: view.modelKey, previous: (view.record?.choices?.[input.id] ?? null) as CapabilityChoice };
      },
      noticeDetail: (target: { label: string; value: 'on' | 'off' }) => `${target.value === 'on' ? '打开' : '关掉'}了「${target.label}」（只对现在这个模型）`,
      run: async (target: { id: ModelCapabilityId; value: 'on' | 'off'; label: string; modelKey: string; previous: CapabilityChoice }, context: AgentCallContext) => {
        await bridge.setModelCapabilityChoice!(target.modelKey, target.id, target.value, context.check);
        if (target.previous !== target.value) context.offerUndo({ label: `把「${target.label}」改回原来的样子`, run: async guard => {
          const now = await bridge.modelCapabilities!();
          if (now.modelKey !== target.modelKey) throw unavailable('模型之后换过了，没有撤回。');
          if ((now.record?.choices?.[target.id] ?? null) !== target.value) throw unavailable(`「${target.label}」之后又改过了，没有撤回。`);
          await bridge.setModelCapabilityChoice!(target.modelKey, target.id, target.previous, guard);
        } });
        return { id: target.id, label: target.label, value: target.value, note: '只对现在这个模型；存在本机，不改模型文件。' };
      },
    },
    {
      name: 'try_model_capability', title: title('try_model_capability'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['id']).id, MODEL_CAPABILITY_IDS, 'id '),
      prepare: (id: ModelCapabilityId) => {
        if (!bridge.previewModelCapability) throw unavailable('这个版本还不能试。');
        return id;
      },
      noticeDetail: (id: ModelCapabilityId) => `试了一下「${CAPABILITY_LABELS[id]}」`,
      run: async (id: ModelCapabilityId, context: AgentCallContext) => {
        const result = await bridge.previewModelCapability!(id, context.check);
        const note = result === 'shown' ? '桌宠上演了一次，演完回到原样。' : result === 'pet-hidden' ? '桌宠没在显示，先 show_pet 再试。'
          : '没演：这个模型做不了、这一项关着，或者她正忙着别的（先用 list_model_capabilities 看）。';
        return { id, label: CAPABILITY_LABELS[id], result, note };
      },
    },
    {
      // 通用骨架第 5 步 · 通道: the seven small actions she may pick in a reply, for the user's own Claude. A show,
      // not a setting: reversible, no privacy effect, no dialog (like try_model_capability). It cannot speak or change anything.
      name: 'play_her_action', title: title('play_her_action'), tier: 'reversible',
      validate: raw => oneOf(argsObject(raw, ['action']).action, CHAT_ACTION_WORDS, 'action '),
      prepare: (word: ChatActionWord) => {
        if (!bridge.playChatAction) throw unavailable('这个版本还不能让她做小动作。');
        return word;
      },
      noticeDetail: (word: ChatActionWord) => CHAT_ACTION_NOTICE[word],
      run: async (word: ChatActionWord, context: AgentCallContext) => {
        let result: ChannelActionResult;
        try { result = await bridge.playChatAction!(word, context.check); }
        catch (error) { throw error instanceof AgentToolError ? error : unavailable('控制窗口尚未就绪，或这个版本还不能让她做小动作。'); }
        return { action: word, played: result.played, status: result.status, ...(result.missing.length ? { missing: result.missing } : {}),
          note: result.played ? '她做了一次。' : `没做：${result.reason}` };
      },
    },
    {
      // I-037: the six 反应倾向 are decided with the user and kept per character id (never in the card). The 角色页's
      // own sliders, for the user's own Claude: reversible (the previous values come back with undo_last_action), no privacy effect.
      name: 'set_reaction_dispositions', title: title('set_reaction_dispositions'), tier: 'reversible',
      validate: raw => {
        const args = argsObject(raw, [...DISPOSITION_IDS, 'reset']);
        if (args.reset !== undefined && args.reset !== true) throw new AgentToolError('invalid_input', 'reset 只能是 true。');
        const values: Partial<Record<DispositionId, number>> = {};
        for (const id of DISPOSITION_IDS) {
          const n = args[id];
          if (n === undefined) continue;
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) throw new AgentToolError('invalid_input', `${id}（${DISPOSITIONS[id].label}）要是 0～100 的整数。`);
          values[id] = n;
        }
        const given = Object.keys(values).length;
        if (args.reset === true && given) throw new AgentToolError('invalid_input', 'reset 不能和六项同时给。');
        if (args.reset !== true && !given) throw new AgentToolError('invalid_input', '至少给一项（shy、clingy、lively、soothable、volatile、restrained），或者 reset:true。');
        return args.reset === true ? null : values;
      },
      prepare: (values: Partial<Record<DispositionId, number>> | null) => {
        if (!bridge.setReactionDispositions) throw unavailable('这个版本还不能这样调她的反应倾向。');
        return values;
      },
      noticeDetail: (values: Partial<Record<DispositionId, number>> | null) => values === null ? '把她的反应倾向改回按角色卡推算'
        : `调了她的反应倾向：${(Object.keys(values) as DispositionId[]).map(id => `${DISPOSITIONS[id].label} ${values[id]}`).join('、')}`,
      run: async (values: Partial<Record<DispositionId, number>> | null, context: AgentCallContext) => {
        const result = await bridge.setReactionDispositions!(values, context.check);
        const characterId = result.characterId, after = result.values, stored = result.stored;
        context.offerUndo({ label: '把她的反应倾向改回原来的值', run: async guard => {
          if (bridge.reactionDispositions?.()?.characterId !== characterId) throw unavailable('之后换过角色了，没有撤回。');
          await bridge.setReactionDispositions!(result.before, guard);
        } });
        return { characterId, values: after, fromCard: !stored, before: result.before ?? '按角色卡推算',
          note: '只属于当前角色，存在本机，不写进角色卡；从下一件事起生效。' };
      },
    },
    {
      name: 'show_pet', title: title('show_pet'), tier: 'reversible', validate: noArgs,
      run: async (_input: unknown, context: AgentCallContext) => {
        const wasVisible = bridge.settings().pet.visible;
        await bridge.setPetVisible(true, context.check);
        if (!wasVisible) context.offerUndo({ label: '再把桌宠藏起来', run: async guard => {
          if (!bridge.settings().pet.visible) throw unavailable('桌宠已经藏起来了。');
          await bridge.setPetVisible(false, guard);
        } });
        return { petVisibleSetting: bridge.settings().pet.visible, pet: bridge.windows().pet };
      },
    },
    {
      // I-014 感知: the same host paths as the user's own switches; never on unless asked, off is always allowed.
      name: 'set_perception', title: title('set_perception'), tier: 'reversible', interconnectOnly: true,
      validate: raw => {
        const args = argsObject(raw, ['kind', 'state', 'purpose']);
        const kind = oneOf(args.kind, ['camera', 'camera_images', 'camera_pose', 'microphone', 'screen', 'system_audio'] as const, 'kind ');
        const state = oneOf(args.state, ['on', 'off'] as const, 'state ');
        if (args.purpose !== undefined && kind !== 'system_audio') throw new AgentToolError('invalid_input', 'purpose 只用于 system_audio。');
        const purpose = args.purpose === undefined ? undefined : oneOf(args.purpose, ['music', 'movie'] as const, 'purpose ');
        const purposes: SystemAudioPurpose[] = kind !== 'system_audio' ? [] : purpose ? [purpose] : state === 'on' ? ['music'] : ['music', 'movie'];
        return { kind, enabled: state === 'on', purposes };
      },
      // I-025: privacy: opening a sense needs the user's own words (三方互通 is always on for this tool); closing never does.
      tierFor: (input: { enabled: boolean }) => input.enabled ? 'confirm' : 'reversible',
      confirmation: (input: { kind: PerceptionKind; purposes: SystemAudioPurpose[] }) => ({ title: `Claude 请求打开${PERCEPTION_LABELS[input.kind]}`,
        detail: `${PERCEPTION_LABELS[input.kind]}${input.kind === 'system_audio' && input.purposes.length === 1 ? `（${PURPOSE_LABELS[input.purposes[0]]}）` : ''}默认是关的；打开后随时可以关。` }),
      wordsItem: (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }) =>
        ({ item: input.kind, value: input.kind === 'system_audio' && input.purposes.length === 1 ? input.purposes[0] : input.enabled }),
      prepare: (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }) => {
        if (!bridge.perception || !bridge.setPerception) throw unavailable('这个版本还不能通过内部通道开关感知。');
        const pet = bridge.windows().pet;
        if (input.enabled && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来（可以用 show_pet），感知在桌宠上打开。');
        return input;
      },
      noticeDetail: (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }) =>
        `${input.enabled ? '打开' : '关闭'}${PERCEPTION_LABELS[input.kind]}${input.kind === 'system_audio' && input.purposes.length === 1 ? `（${PURPOSE_LABELS[input.purposes[0]]}）` : ''}`,
      run: async (input: { kind: PerceptionKind; enabled: boolean; purposes: SystemAudioPurpose[] }, context: AgentCallContext) => {
        const before = perceptionOn(bridge.perception!(), input.kind, input.purposes);
        await bridge.setPerception!(input.kind, input.enabled, input.purposes, context.check);
        const after = perceptionOn(bridge.perception!(), input.kind, input.purposes);
        // I-025: 撤回 can close a sense again, never re-open one (that needs the user's words).
        if (after !== before && !before) context.offerUndo({ label: `关掉${PERCEPTION_LABELS[input.kind]}`, run: async guard => {
          if (perceptionOn(bridge.perception!(), input.kind, input.purposes) !== after) throw unavailable(`${PERCEPTION_LABELS[input.kind]}之后又改过了，没有撤回。`);
          const pet = bridge.windows().pet;
          if (before && (!pet || !pet.visible || pet.minimized)) throw unavailable('请先让桌宠显示出来，感知在桌宠上打开。');
          await bridge.setPerception!(input.kind, before, input.purposes, guard);
        } });
        return { kind: input.kind, label: PERCEPTION_LABELS[input.kind], on: after,
          ...(input.enabled && !after ? { note: '没有打开：可能缺少需要的组件或语音识别连接，soft hearts 上会有说明。' } : {}) };
      },
    },
    {
      name: 'import_character_card', title: title('import_character_card'), tier: 'confirm',
      validate: raw => localFilePath(argsObject(raw, ['path']).path, ['.json'], platform),
      prepare: (file: string) => inspectLocalFile(file, ['.json'], 1_000_000, fs, platform),
      noticeDetail: (facts: FileFacts) => facts.name,
      confirmation: (facts: FileFacts) => ({
        title: 'Claude 请求导入一张角色卡',
        detail: `文件：${facts.name}\n位置：${facts.directory}\n大小：${Math.max(1, Math.round(facts.size / 1024))} KB\n\n只读取这个 JSON 并按角色卡格式检查；导入不授予任何文件或执行权限。`,
      }),
      run: async (facts: FileFacts, context: AgentCallContext) => {
        await assertUnchanged(facts, fs);
        const content = await readText(facts.file);
        const before = new Set(bridge.characters().cards.map(item => item.id));
        const state = await bridge.importCharacterCard(content, context.check);
        const added = state.cards.find(item => !before.has(item.id));
        return { imported: added ? { id: added.id, name: added.name } : null, notice: state.notice ?? null, count: state.cards.length };
      },
    },
    {
      // C3 (docs/claude/2026-11-03-card-update-in-place.md): the same card, the same id; her memories stay hers.
      name: 'update_character_card', title: title('update_character_card'), tier: 'confirm',
      validate: raw => {
        const args = argsObject(raw, ['id', 'path']);
        return { id: cardId(args.id), file: localFilePath(args.path, ['.json'], platform) };
      },
      prepare: async (input: { id: string; file: string }): Promise<CardUpdateRequest> => {
        if (!bridge.planCharacterCardUpdate || !bridge.updateCharacterCard) throw unavailable('这个版本还不能用角色卡文件更新角色。');
        const target = card(input.id);
        const facts = await inspectLocalFile(input.file, ['.json'], 1_000_000, fs, platform);
        // The dialog lists what would change, so the file is read and checked before asking; nothing is written yet.
        const content = await readText(facts.file).catch(() => { throw unavailable('文件不存在或无法读取。'); });
        let plan: CharacterCardUpdatePlanView;
        try { plan = await bridge.planCharacterCardUpdate(target.id, content); }
        catch (error) { throw new AgentToolError('invalid_input', error instanceof Error && error.message ? error.message.slice(0, 200) : '角色卡文件无法读取。'); }
        if (plan.summary.unchanged) throw unavailable(`文件里的人设和「${target.name}」现在的一模一样，不需要更新。`);
        return { facts, content, id: plan.id, name: target.name, plan };
      },
      confirmation: (request: CardUpdateRequest) => ({
        title: request.plan.summary.name.changed ? 'Claude 请求用角色卡文件更新一个角色（名字不一样，请看清）' : 'Claude 请求用角色卡文件更新一个角色',
        detail: [`要更新的角色：${request.name}（原地更新，还是同一个她）`, `文件：${request.facts.name}`, `位置：${request.facts.directory}`, '',
          ...cardUpdateSummaryLines(request.plan.summary).map(line => (line.warning ? '⚠ ' : '') + line.text)].join('\n'),
      }),
      noticeDetail: (request: CardUpdateRequest) => `「${request.name}」，用 ${request.facts.name}（更新前已备份）`,
      run: async (request: CardUpdateRequest, context: AgentCallContext) => {
        await assertUnchanged(request.facts, fs);
        const outcome = await bridge.updateCharacterCard!(request.id, request.content, request.plan.expected, context.check);
        const updated = outcome.state.cards.find(item => item.id === request.id);
        return { updated: { id: request.id, name: updated?.name ?? null }, nameChanged: outcome.summary.name.changed,
          changedFields: outcome.summary.changedFields, mood: outcome.summary.mood, slowWarmUp: outcome.summary.slowWarmUp.after,
          response: outcome.summary.response, kept: '还是同一个角色：聊天、日记、画像、熟悉度和昵称、模型和头像都保留。',
          backup: '更新前已把角色卡存档备份在配置目录里（characters.before-update-…json）。', notice: outcome.notice ?? null };
      },
    },
    {
      name: 'load_model', title: title('load_model'), tier: 'confirm',
      validate: raw => localFilePath(argsObject(raw, ['path']).path, ['.pmx', '.pmd'], platform),
      prepare: (file: string) => inspectLocalFile(file, ['.pmx', '.pmd'], 1024 * 1024 * 1024, fs, platform),
      confirmation: (facts: FileFacts) => ({
        title: 'Claude 请求载入一个 MMD 模型',
        detail: `文件：${facts.name}\n位置：${facts.directory}\n\n载入后会替换当前模型，并清除当前动作；贴图从同一目录读取，原文件不会被修改。`,
      }),
      noticeDetail: (facts: FileFacts) => facts.name,
      run: async (facts: FileFacts, context: AgentCallContext) => {
        await assertUnchanged(facts, fs);
        // I-014: the model it replaces is remembered, so 撤回 can load it again (the original files are never changed).
        const previous = bridge.settings().model;
        const loaded = await bridge.loadModel(facts.file, context.check);
        const now = bridge.settings().model;
        if (previous && now && previous.path !== now.path) context.offerUndo({ label: `换回模型「${previous.name}」`, run: async guard => {
          if (bridge.settings().model?.path !== now.path) throw unavailable('模型之后又换过了，没有撤回。');
          await bridge.loadModel(previous.path, guard);
        } });
        return { model: { name: loaded.name }, ...(previous ? { previousModel: { name: previous.name } } : {}) };
      },
    },
    {
      name: 'bind_current_model_to_character', title: title('bind_current_model_to_character'), tier: 'confirm',
      validate: raw => ({ id: cardId(argsObject(raw, ['id']).id) }),
      prepare: (input: { id: string }) => {
        const target = card(input.id), model = bridge.settings().model;
        if (!model) throw unavailable('请先载入一个 MMD 模型。');
        return { id: target.id, name: target.name, modelName: model.name, modelPath: model.path };
      },
      confirmation: (target: { name: string; modelName: string }) => ({
        title: 'Claude 请求把当前模型关联到角色',
        detail: `角色：${target.name}\n模型：${target.modelName}\n\n以后切换到这个角色时会自动载入这个模型。`,
      }),
      noticeDetail: (target: { name: string; modelName: string }) => `「${target.modelName}」→「${target.name}」`,
      run: async (target: { id: string; modelPath: string }, context: AgentCallContext) => {
        // A model changed while the dialog was open must not be bound under the old confirmation.
        if (bridge.settings().model?.path !== target.modelPath) throw unavailable('当前模型在确认之后变了，已取消。');
        await bridge.bindCurrentModel(target.id, context.check);
        const bound = bridge.characters().cards.find(item => item.id === target.id);
        return { id: target.id, modelName: bound?.modelName ?? null };
      },
    },
    {
      name: 'voice_preview', title: title('voice_preview'), tier: 'confirm', validate: noArgs,
      prepare: () => { controlsReady(false); return bridge.settings().tts?.provider === 'bailian' ? 'bailian' : 'system'; },
      confirmation: (provider: 'bailian' | 'system') => ({
        title: 'Claude 请求试听语音',
        detail: `${provider === 'bailian' ? '语音方案：百炼。会用你的百炼账号产生一次付费调用。' : '语音方案：系统声音（免费）。'}\n试听内容：“${PREVIEW_LINE}”`,
      }),
      noticeDetail: (provider: 'bailian' | 'system') => provider === 'bailian' ? '百炼（一次付费调用）' : '系统声音（免费）',
      run: (provider: 'bailian' | 'system', context: AgentCallContext) => {
        if ((bridge.settings().tts?.provider === 'bailian' ? 'bailian' : 'system') !== provider) throw unavailable('语音方案在确认之后变了，已取消。');
        if (!rendererAction({ kind: 'voice-preview' }, context)) throw unavailable('控制窗口尚未就绪。');
        return { requested: true, provider };
      },
    },
    {
      // I-025 第 3 段: the control window's 「一键恢复桌宠」.
      name: 'recover_pet', title: title('recover_pet'), tier: 'reversible', validate: noArgs,
      prepare: () => { if (!bridge.recoverPet) throw unavailable('这个版本还不能这样恢复桌宠。'); return null; },
      run: async (_input: unknown, context: AgentCallContext) => {
        await bridge.recoverPet!(context.check);
        return { recovered: true, note: '桌宠已居中显示，恢复默认大小和镜头；模型和连接没变。' };
      },
    },
    {
      // I-025 第 3 段: 「使用预装 Gene」 (replaces the model, like load_model; 撤回 loads the previous one again).
      name: 'use_bundled_model', title: title('use_bundled_model'), tier: 'confirm', validate: noArgs,
      prepare: () => { if (!bridge.useBundledModel) throw unavailable('这个版本还不能这样换回预装模型。'); return bridge.settings().model?.name ?? null; },
      confirmation: (previous: string | null) => ({ title: 'Claude 请求换回预装的 Gene 模型',
        detail: `${previous ? `现在的模型：${previous}
` : ''}换回后会清除当前动作；原来的模型文件不会被修改，可以撤回。` }),
      noticeDetail: () => '换回预装 Gene',
      run: async (_input: unknown, context: AgentCallContext) => {
        const previous = bridge.settings().model;
        await bridge.useBundledModel!(context.check);
        const now = bridge.settings().model;
        if (previous && now && previous.path !== now.path) context.offerUndo({ label: `换回模型「${previous.name}」`, run: async guard => {
          if (bridge.settings().model?.path !== now.path) throw unavailable('模型之后又换过了，没有撤回。');
          await bridge.loadModel(previous.path, guard);
        } });
        return { model: now ? { name: now.name } : null, ...(previous ? { previousModel: { name: previous.name } } : {}) };
      },
    },
    {
      // I-025 第 3 段: 「解除关联」 in the card editor.
      name: 'unbind_character_model', title: title('unbind_character_model'), tier: 'reversible',
      validate: raw => ({ id: cardId(argsObject(raw, ['id']).id) }),
      prepare: (input: { id: string }) => {
        if (!bridge.unbindCharacterModel) throw unavailable('这个版本还不能这样解除关联。');
        const target = card(input.id);
        if (!target.modelName) throw unavailable(`「${target.name}」没有关联模型。`);
        return { id: target.id, name: target.name, modelName: target.modelName };
      },
      noticeDetail: (target: { name: string; modelName: string }) => `「${target.name}」不再自动载入「${target.modelName}」`,
      run: async (target: { id: string; name: string; modelName: string }, context: AgentCallContext) => {
        const loaded = bridge.settings().model;
        await bridge.unbindCharacterModel!(target.id, context.check);
        // 撤回 (2026-11-07): the app only knows how to bind the model that is loaded now, so the undo is offered when that is still the model the
        // character was tied to (the usual case: unbinding leaves it loaded) and it is the same file when the undo runs.
        if (loaded && loaded.name === target.modelName) context.offerUndo({ label: `把「${target.name}」重新关联到「${target.modelName}」`, run: async guard => {
          if (bridge.settings().model?.path !== loaded.path) throw unavailable('现在载入的模型已经不是原来的那个，没有撤回；先载入原来的模型，再用“关联当前模型”。');
          if (card(target.id).modelName) throw unavailable(`「${target.name}」已经关联了模型，没有撤回。`);
          await bridge.bindCurrentModel(target.id, guard);
        } });
        return { id: target.id, name: target.name, unbound: target.modelName };
      },
    },
    {
      // I-025 第 3 段: 「新增角色 → 用现在的模型」 on the character page.
      name: 'create_character_for_current_model', title: title('create_character_for_current_model'), tier: 'reversible', validate: noArgs,
      prepare: () => {
        if (!bridge.createCharacterForCurrentModel) throw unavailable('这个版本还不能这样新建角色。');
        const model = bridge.settings().model;
        if (!model) throw unavailable('请先载入一个模型。');
        return model.name;
      },
      noticeDetail: (model: string) => `用「${model}」新建了一个角色`,
      run: async (_model: string, context: AgentCallContext) => {
        const before = new Set(bridge.characters().cards.map(item => item.id));
        const state = await bridge.createCharacterForCurrentModel!(context.check);
        const added = state.cards.find(item => !before.has(item.id));
        return { created: added ? { id: added.id, name: added.name } : null, activeId: state.activeId,
          note: '没有换到新角色；要换就用 activate_character。人设可以用 update_character_card 填。' };
      },
    },
    {
      // I-014 回收站 (Claude's suggestion): nothing is deleted for good at once; each part waits in her recycle bin.
      // I-025: deletion needs the user's own words (confirm tier; 三方互通 is always on for this tool).
      name: 'delete_memories', title: title('delete_memories'), tier: 'confirm', interconnectOnly: true,
      confirmation: (target: { name: string; parts: AgentRecyclePart[] }) => ({ title: `Claude 请求删除「${target.name}」的记忆`,
        detail: `${target.parts.map(part => part === 'chat' ? '聊天记忆' : '画像和日记').join('、')}会先进回收站，${bridge.memories?.days() ?? 7} 天内可以找回。` }),
      wordsItem: (target: { parts: AgentRecyclePart[] }) => ({ item: 'delete_memories', value: target.parts.join(',') }),
      validate: raw => {
        const args = argsObject(raw, ['id', 'parts']);
        const id = cardId(args.id);
        if (!Array.isArray(args.parts) || args.parts.length < 1 || args.parts.length > 2) throw new AgentToolError('invalid_input', 'parts 只能是 chat、profile 里的一两项。');
        const parts: AgentRecyclePart[] = [];
        for (const part of args.parts) {
          const value = oneOf(part, ['chat', 'profile'] as const, 'parts ');
          if (parts.includes(value)) throw new AgentToolError('invalid_input', 'parts 不能重复。');
          parts.push(value);
        }
        return { id, parts };
      },
      prepare: (input: { id: string; parts: AgentRecyclePart[] }) => {
        if (!bridge.memories) throw unavailable('这个版本还没有回收站，不能删除记忆。');
        const target = card(input.id);
        return { id: target.id, name: target.name, parts: input.parts };
      },
      noticeDetail: (target: { name: string; parts: AgentRecyclePart[] }) =>
        `「${target.name}」的${target.parts.map(part => part === 'chat' ? '聊天记忆' : '画像和日记').join('、')}进了回收站（${bridge.memories?.days() ?? 7} 天内可找回）`,
      run: async (target: { id: string; name: string; parts: AgentRecyclePart[] }, context: AgentCallContext) => {
        const memories = bridge.memories!;
        const outcome = await memories.forget(target.id, target.name, target.parts, context.check);
        if (outcome.entries.length) context.offerUndo({ label: `把「${target.name}」删掉的记忆放回去`, run: async guard => {
          for (const entry of outcome.entries) await memories.restore(entry.id, guard);
        } });
        return {
          character: { id: target.id, name: target.name },
          recycled: outcome.entries.map(entry => ({ entryId: entry.id, part: entry.part, label: entry.label, expiresAt: new Date(entry.expiresAt).toISOString() })),
          nothingToDelete: outcome.empty, failed: outcome.failed,
          note: `没有永久删除：在回收站里留 ${memories.days()} 天，期间可以用 restore_memories 或 undo_last_action 找回，到期才清理。`
            + (outcome.failed.length ? ' 有一部分没能放进回收站，所以那部分没有删除。' : ''),
        };
      },
    },
    {
      name: 'list_recycle_bin', title: title('list_recycle_bin'), tier: 'read', interconnectOnly: true, validate: noArgs,
      run: () => {
        if (!bridge.memories) throw unavailable('这个版本还没有回收站。');
        return { retentionDays: bridge.memories.days(), entries: bridge.memories.list().map(entry => ({
          entryId: entry.id, characterId: entry.characterId, characterName: entry.characterName, part: entry.part, label: entry.label,
          deletedAt: new Date(entry.deletedAt).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString() })) };
      },
    },
    {
      name: 'restore_memories', title: title('restore_memories'), tier: 'reversible', interconnectOnly: true,
      validate: raw => {
        const entryId = argsObject(raw, ['entryId']).entryId;
        if (typeof entryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryId))
          throw new AgentToolError('invalid_input', 'entryId 必须是 list_recycle_bin 返回的编号。');
        return entryId.toLowerCase();
      },
      prepare: (entryId: string) => {
        if (!bridge.memories) throw unavailable('这个版本还没有回收站。');
        const entry = bridge.memories.list().find(item => item.id === entryId);
        if (!entry) throw unavailable('回收站里没有这一项（可能已经找回或到期清理了）。');
        return entry;
      },
      noticeDetail: (entry: AgentRecycleSummary) => `「${entry.characterName}」的${entry.label}`,
      run: async (entry: AgentRecycleSummary, context: AgentCallContext) => {
        const outcome = await bridge.memories!.restore(entry.id, context.check);
        return { restored: { characterName: entry.characterName, part: entry.part, label: entry.label },
          ...(outcome.replaced ? { replaced: { entryId: outcome.replaced.id, label: outcome.replaced.label,
            note: '她在删除之后又记了新的画像或日记；那一份没有丢，换进了回收站。' } } : {}) };
      },
    },
  ];
  return tools;
}
