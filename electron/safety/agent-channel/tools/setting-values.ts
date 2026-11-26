// How a setting of the internal channel reads, and the words that explain it (docs/claude/2026-11-17-app-tools-split.md): its value
// from AppSettings, the active card and the host's extras; what turning it on means (download sizes, the microphone, the user's
// Claude usage); whether a value needs the user's consent; the 「更真实的情绪」 dialog. No tool definitions here: set_setting and
// list_settings are in ./settings.ts. Her chat setting cards and the handbook read these too (electron/brain/chat-settings.ts).
import type { AppSettings } from '../../../../shared/foundation/settings';
import { proactiveTalk } from '../../../../shared/foundation/settings'; // the settings vocabulary (wiring rewrite step 1; was shared/behaviors/inner-rhythm/knobs)
import { crisisRegionPreference } from '../../../../shared/safety/crisis-lines';
import { slowWarmUpOf, type CharacterCardState } from '../../../../shared/foundation/character-card';
import { AGENT_SETTING_STATE_LABELS, AGENT_SETTINGS, settingValueNeedsConsent, type AgentSettingId, type AgentSettingSpec, type AgentSettingValue, type AgentSettingView } from '../../../../shared/safety/agent-channel';
import { REALER_EMOTIONS_CONSENT } from '../../../../shared/mood';
import { DEFAULT_REALER_DURATION, type RealerDuration } from '../../../../shared/mood';
import { realerDurationLine } from '../../../mood';
import type { LocalAsrView } from '../../../../shared/senses';
import type { PoseSensingView } from '../../../../shared/senses';
import { ASR_ARCHIVES, SENSEVOICE_REPO } from '../../../foundation/asr-manifest';
import { validFishMonthlyCap } from '../../../../shared/voice';
import type { AgentAppBridge, HostSettingFacts } from './app-bridge';
import { ASSISTANT_NAME, ASSISTANT_CLI_NAME } from '../../../../shared/foundation/assistant-name';

/** Which reading voice is chosen; anything unknown is the free system voice. */
export type PaidVoice = 'system' | 'bailian' | 'fish';
export const paidVoice = (settings: AppSettings): PaidVoice => settings.tts?.provider === 'bailian' || settings.tts?.provider === 'fish' ? settings.tts.provider : 'system';
export const PROVIDER_LABEL: Readonly<Record<PaidVoice, string>> = { system: '系统声音（免费）', bailian: '百炼（按次付费）', fish: 'Drama 3（Fish Audio，按字节付费）' };

/** Settings that live on the active character card rather than in AppSettings. */
export type SettingCards = Pick<CharacterCardState, 'cards' | 'activeId'>;
/**
 * Settings kept outside AppSettings and the cards: the recycle bin's retention (I-014); the microphone switch and the local
 * recognizer (I-025).
 */
export interface SettingExtras { recycleDays?: number | null; voiceInput?: boolean | null; localAsr?: LocalAsrView | null; host?: HostSettingFacts | null; voiceCall?: boolean | null }

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
export const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

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
/** I-091: what starting a call means (the dialog, her chat card, the handbook). */
export const VOICE_CALL_ON_TEXT = '通话时麦克风一直开着在听（不用按 T），你说完她就接；她说话时你一开口她就停下来听。声音只在这台电脑上识别，不保存录音。很久没人说话会自动挂断，随时可以挂。朗读用百炼或 Drama 3 时，通话会让朗读次数变多（会计费），她先"嗯"一下的几个小片段也要生成一次；系统声音免费。';

/** I-025: one line that explains a value needing consent (chat card, dialog, handbook); undefined for the rest. */
export function settingDetail(id: AgentSettingId, value: AgentSettingValue, extras?: SettingExtras): string | undefined {
  if (id === 'local_asr' && value === 'installed') return localAsrDownloadText(extras?.localAsr);
  if (id === 'local_asr' && value === 'not-installed')
    return localAsrValue(extras?.localAsr) === 'downloading' ? '取消正在进行的下载。' : '删除已下载的识别组件（之后要用语音输入得重新下载），不动聊天记录。';
  if (id === 'voice_input' && value === true) return VOICE_INPUT_ON_TEXT;
  if (id === 'voice_call' && value === true) return VOICE_CALL_ON_TEXT;
  if (id === 'pose_sensing' && value === 'installed') return poseDownloadText(extras?.host?.pose);
  if (id === 'pose_sensing' && value === 'not-installed')
    return componentValue(extras?.host?.pose) === 'downloading' ? '取消正在进行的下载。' : '删除已下载的姿态感知组件（之后要用得重新下载），不动任何记录。';
  if (id === 'proactive_vision' && value === true) return `屏幕共享开着时，她会看画面主动找话题；画面会交给你的 ${ASSISTANT_NAME}（占用量）。随时可以关。`;
  if (id === 'feed_recognition' && value === true) return `喂食时，图会缩小后交给你的 ${ASSISTANT_NAME} 认一下（占用量），她会说出是什么。随时可以关。`;
  if (id === 'pause_talk' && value === true)
    return `她每条回复都会多问一次你 ${ASSISTANT_NAME} 里的 haiku（占用量，普通的一天 30～80 次）：按她的性格和此刻的心情，定说到哪停一下、要不要停下来等你接话。第一个字照样马上出来。随时可以关。`;
  if (id === 'user_activity' && value === true)
    return '打开后，应用会每秒读一次“距你上次动键盘鼠标过了多少秒”，再加上有没有锁屏、电脑有没有睡眠、她的窗口有没有拿到焦点，据此知道你是不是在专心做事，好让她安静下来做自己的事。不知道你按了什么键、在哪个窗口、鼠标去了哪里；不存任何记录。随时可以关。';
  if (id === 'new_reactions' && value === true)
    return `你每发一句话，你 ${ASSISTANT_NAME} 里的 haiku 会和她的回答同时看一眼（第一个字不等它），替她从反应清单里挑 0～2 个反应，并给这句话的心情变化（占用量：每句最多一次，每天最多 800 次）。开着时心情调整员不再重复看消息。随时可以关。`;
  if (id === 'mood_judge' && value === true)
    return `她身上发生的事照常马上起作用；过一两分钟，你 ${ASSISTANT_NAME} 里的 haiku 会按她的性格和此刻的心情再微调一下心情数（占用量，普通的一天约 80 次，每天最多 200 次）。不发图片和听到的原文。随时可以关。`;
  if (id === 'self_look' && value === true)
    return `摄像头的「发图片」开着时，她想看你时会自己看一眼，你们聊天时她手里没有新鲜的那句话也会在后台看一眼：每看一次是一次你 ${ASSISTANT_NAME} 里的 haiku（占用量，不限次数，最多大约每分钟一次），画面不保存，看到的那句话只在内存里留 10 分钟。不会替你打开摄像头；你说“别看”她自己会听，真不想让她看就关「发图片」。随时可以关。`;
  if (id === 'chat_model') return value === 'opus' ? `换成 opus：回答更细，也最占你的 ${ASSISTANT_NAME} 用量。` : value === 'haiku' ? '换成 haiku：最快、最省用量。'
    : value === '' ? `跟随你 ${ASSISTANT_CLI_NAME} 自己的默认模型。` : `换成 ${String(value)}。`;
  if (id === 'voice_provider' && value === 'bailian') return '把新角色的默认声音换成百炼：新建的角色（和还没有自己声音的角色）会用它，每读一句都用你的百炼账号付费；已有的角色用自己的声音，不变。';
  if (id === 'voice_provider' && value === 'fish')
    return `把新角色的默认声音换成 Drama 3：新建的角色（和还没有自己声音的角色）会用它，每读一句都用你的 Fish Audio 账号按字节付费（11 月 30 日前每百万字节约 10 美元，之后约 50 美元）。默认不设每月上限，花多少由你 Fish Audio 账号里预充的余额决定；你可以在控制窗口给它设一个上限（也可以让你的 ${ASSISTANT_NAME} 设，同样要你同意），到了就自动换回系统声音。`;
  return undefined;
}

export function settingValue(id: AgentSettingId, settings: AppSettings, cards?: SettingCards, extras?: SettingExtras): AgentSettingValue | null {
  switch (id) {
    case 'voice_provider': return paidVoice(settings);
    case 'drama3_monthly_limit': return validFishMonthlyCap(settings.tts?.fishMonthlyCapUsd); // 0 = no limit (the control window's field)
    case 'recycle_bin_days': return typeof extras?.recycleDays === 'number' ? extras.recycleDays : null;
    case 'voice_input': return typeof extras?.voiceInput === 'boolean' ? extras.voiceInput : null;
    case 'voice_call': return typeof extras?.voiceCall === 'boolean' ? extras.voiceCall : null;
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
    case 'unbound_default_place': return extras?.host?.unboundDefaultPlace ?? null;
    case 'pose_sensing': return componentValue(extras?.host?.pose);
    case 'physics_hair': return extras?.host?.physics ? extras.host.physics.hair.enabled : null;
    case 'physics_chest': return extras?.host?.physics ? extras.host.physics.chest.enabled : null;
    case 'physics_quality': return extras?.host?.physics ? extras.host.physics.quality : null;
    case 'slow_warm_up': {
      const active = cards?.cards.find(card => card.id === cards.activeId);
      return active ? slowWarmUpOf(active) : null;
    }
    case 'realer_emotions': {
      const active = cards?.cards.find(card => card.id === cards.activeId);
      return active ? active.realerEmotions === true : null;
    }
    case 'proactive_talk': return proactiveTalk(settings.proactiveTalk);
    case 'self_look': return settings.selfLook !== false;
    case 'crisis_region': return crisisRegionPreference(settings.crisisRegion);
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

/** F6: the consent dialog for "更真实的情绪", the same words the card editor's dialog shows (shared/mood/realer-emotions.ts). */
export function realerEmotionsConfirmation(cards: SettingCards | null | undefined, duration?: RealerDuration): { title: string; detail: string; buttons: readonly [string, string] } {
  return realerEmotionsConfirmationFor(cards?.cards.find(card => card.id === cards.activeId)?.name, duration);
}
/** T-239: the same dialog for the card the request was made for (its name taken before the dialog). */
export function realerEmotionsConfirmationFor(cardName: string | null | undefined, duration: RealerDuration = DEFAULT_REALER_DURATION): { title: string; detail: string; buttons: readonly [string, string] } {
  const name = cardName ?? '当前角色';
  return { title: REALER_EMOTIONS_CONSENT.message(name), detail: `${REALER_EMOTIONS_CONSENT.detail}\n\n${realerDurationLine(duration)}`,
    buttons: [REALER_EMOTIONS_CONSENT.decline, REALER_EMOTIONS_CONSENT.accept] };
}

export function settingViews(settings: AppSettings, cards?: SettingCards, extras?: SettingExtras): AgentSettingView[] {
  return AGENT_SETTINGS.map(spec => ({ ...structuredClone(spec), value: settingValue(spec.id, settings, cards, extras) }));
}

/** I-014: the informational box shown once (not waited for) when "更真实的情绪" turned on without its dialog. */
export function realerEmotionsInformation(cards: SettingCards | null | undefined, cardName?: string, duration: RealerDuration = DEFAULT_REALER_DURATION): { title: string; detail: string } {
  const name = cardName ?? cards?.cards.find(card => card.id === cards.activeId)?.name ?? '当前角色';
  return { title: `已给「${name}」打开“更真实的情绪”`, detail: `${REALER_EMOTIONS_CONSENT.detail}\n\n${realerDurationLine(duration)}` };
}

export function describe(spec: AgentSettingSpec, value: AgentSettingValue | null): string {
  if (value === null) return '未知';
  if (spec.id === 'drama3_monthly_limit' && value === 0) return '不设上限';
  if (spec.kind === 'number') return `${value}${spec.unit}`;
  return spec.choices.find(choice => choice.value === value)?.label ?? AGENT_SETTING_STATE_LABELS[String(value)] ?? String(value);
}

/**
 * I-025: whether this value of the setting needs the user's consent (confirm tier). In her chat a card that shows what happens
 * (`cardConsent`) is that consent already; "更真实的情绪" keeps its own dialog there too, as before.
 */
export function settingNeedsConsent(spec: AgentSettingSpec, value: AgentSettingValue, via: 'agent' | 'chat'): boolean {
  if (!settingValueNeedsConsent(spec, value)) return false;
  return !(via === 'chat' && spec.cardConsent === true);
}

/** The values settingViews needs beyond AppSettings and the cards (each read on its own; a failing read is unknown). */
export function settingExtras(bridge: Pick<AgentAppBridge, 'memories' | 'perception' | 'localAsr' | 'hostSettings' | 'voiceCall'>): SettingExtras {
  const read = <T>(work: () => T | undefined): T | null => { try { return work() ?? null; } catch { return null; } };
  return { recycleDays: read(() => bridge.memories?.days()), voiceInput: read(() => bridge.perception?.().microphone), localAsr: read(() => bridge.localAsr?.()),
    host: read(() => bridge.hostSettings?.()), voiceCall: read(() => bridge.voiceCall?.()) };
}
