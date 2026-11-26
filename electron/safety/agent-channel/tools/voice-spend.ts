// 2026-11-24: what the user's own Claude reads and is told about paid voices
// (docs/claude/2026-11-24-channel-voice-spend.md). Pure, no tools: the Drama 3 monthly limit and this month's spending (numbers only),
// each character's own voice provider, what a paid voice costs (the words the dialogs show), and the voice a set_character_voice
// request writes. The tools are set_character_voice (./voice.ts) and set_setting's drama3_monthly_limit (./settings.ts); the reads are
// list_settings' `voices` (./settings.ts) and read_handbook (./handbook.ts). Nothing here holds or shows a key or an address: only
// whether a provider's key is saved (ttsProviderReady), as the public settings already say.
import type { AppSettings } from '../../../../shared/foundation/settings';
import type { CharacterCardState } from '../../../../shared/foundation/character-card';
import { normalizeCharacterVoice, type CharacterVoice } from '../../../../shared/foundation/character-voice';
import type { TtsProvider } from '../../../../shared/foundation/tts-config';
import {
  DEFAULT_TTS_CONFIG, FISH_LIST_USD_PER_MILLION_BYTES, FISH_NO_MONTHLY_CAP, FISH_PROMO_END_MS, characterTtsConfig, fishBudgetExhausted, fishMonthKey,
  fishUsdPerMillionBytes, ttsProviderReady, validFishMonthlyCap, voiceLabel, type FishBudgetView, type TtsConfig, type VoiceSubject,
} from '../../../../shared/voice';
import { PROVIDER_LABEL, paidVoice } from './setting-values';
import { ASSISTANT_NAME } from '../../../../shared/foundation/assistant-name';

const ttsOf = (settings: AppSettings): TtsConfig => (settings.tts ?? DEFAULT_TTS_CONFIG) as TtsConfig;
export const isPaidProvider = (provider: TtsProvider): boolean => provider === 'bailian' || provider === 'fish';

/** What each paid voice costs, in the control window's words (「Drama 3 语音」's introduction, the voice_provider choice). */
export function voiceCostLine(provider: TtsProvider, at: Date): string {
  if (provider === 'bailian') return '百炼按次付费：她每读一句，都会用你的百炼账号产生一次费用。朗读的文字会发给百炼。';
  if (provider !== 'fish') return '系统声音免费，读的文字不离开这台电脑。';
  const later = at.getTime() < FISH_PROMO_END_MS ? `（11 月 30 日之后约 ${FISH_LIST_USD_PER_MILLION_BYTES} 美元）` : '';
  return `Drama 3 按字节付费：她每读一句，按这句的字节数用你的 Fish Audio 账号计费，现在每百万字节约 ${fishUsdPerMillionBytes(at)} 美元${later}，一个汉字约 3 字节。朗读的文字会发给 Fish Audio。`;
}

/** Drama 3's limit and this month's spending: numbers only (what the control window's "本月约花了" line shows). */
export interface Drama3View {
  /** 0 = no limit. */
  monthlyLimitUsd: number; noLimit: boolean;
  /** The calendar month, "2026-11". */
  month: string;
  /** Spent this month, in US dollars (cents); null when the host could not read it. */
  spentUsd: number | null; bytes: number | null;
  /** This month's spending reached the limit: she reads with the system voice until the month changes or the limit goes up. */
  reachedLimit: boolean | null;
  usdPerMillionBytes: number;
  /** A Drama 3 key is saved (never the key). */
  keySaved: boolean;
}
export function drama3View(settings: AppSettings, budget: FishBudgetView | null | undefined, at: Date): Drama3View {
  const tts = ttsOf(settings), limit = validFishMonthlyCap(tts.fishMonthlyCapUsd), month = fishMonthKey(at);
  const now = budget ? (budget.month === month ? budget : { month, bytes: 0, spentMicroUsd: 0 }) : null;
  return { monthlyLimitUsd: limit, noLimit: limit === FISH_NO_MONTHLY_CAP, month, spentUsd: now ? Math.round(now.spentMicroUsd / 10_000) / 100 : null,
    bytes: now ? now.bytes : null, reachedLimit: budget ? fishBudgetExhausted(budget, limit, at) : null, usdPerMillionBytes: fishUsdPerMillionBytes(at),
    keySaved: ttsProviderReady(tts, 'fish') };
}
export const limitText = (usd: number | null): string => usd === null ? '未知' : usd === FISH_NO_MONTHLY_CAP ? '不设上限' : `${usd} 美元`;
const spentText = (view: Drama3View): string => view.spentUsd === null ? '本月花了多少还没读到' : `本月（${view.month}）已经花了约 $${view.spentUsd.toFixed(2)}（${view.bytes} 字节）`;
/** One line for a dialog about Drama 3: the limit and this month's spending. */
export function drama3LimitLine(view: Drama3View): string {
  if (view.noLimit) return `每月上限：不设（花多少由你 Fish Audio 账号里预充的余额决定）；${spentText(view)}。`;
  return `每月上限：${view.monthlyLimitUsd} 美元，到了就换回系统声音；${spentText(view)}${view.reachedLimit ? '，已经到上限，本月先用系统声音' : ''}。`;
}

/** The set_setting dialog for the monthly limit: from, to, this month's spending, what changes for her, the price. */
export function monthlyLimitConfirmation(from: number | null, to: number, view: Drama3View, at: Date): { title: string; detail: string } {
  const effect = to === FISH_NO_MONTHLY_CAP ? '不设上限：她每读一句都照常用 Drama 3，花多少只由你 Fish Audio 账号里预充的余额决定。'
    : view.spentUsd !== null && view.spentUsd >= to ? `本月已经花到 ${to} 美元以上：改完后她这个月先用系统声音（免费）读，下个月或调高上限后再用 Drama 3。`
      : `到了 ${to} 美元，她这个月剩下的朗读自动换回系统声音（免费），下个月重新计。`;
  return { title: `${ASSISTANT_NAME} 请求把 Drama 3 的每月上限改为${to === FISH_NO_MONTHLY_CAP ? '“不设上限”' : ` ${to} 美元`}`,
    detail: [`从：${limitText(from)}`, `改为：${limitText(to)}`, `${spentText(view)}。`, effect, voiceCostLine('fish', at), '不碰 Key；改回去也要你的同意。'].join('\n') };
}

/** set_character_voice's provider: one of the three, or 'default' (no voice of her own: the default voice for new characters). */
export type CharacterVoiceChoice = TtsProvider | 'default';
/** What a set_character_voice request is about, taken before any dialog (the dialog shows it; the change applies only while it holds). */
export interface CharacterVoiceRequest {
  id: string; name: string; active: boolean;
  /** Her own voice now (null: she follows the default voice for new characters) and what is written. */
  before: CharacterVoice | null; next: CharacterVoice | null;
  /** The provider she is set to speak with before and after (with no voice of her own: the default's). */
  previousProvider: TtsProvider; provider: TtsProvider;
  /** That provider's key (and Bailian's connection) is saved; otherwise another voice reads until it is. */
  ready: boolean;
  /** Something changes (her own voice is not already exactly this); nothing changing needs no consent and writes nothing. */
  changed: boolean;
}
/** The request is a spending decision: it sets a paid voice that is not already hers (the words and the dialog; no undo). */
export const characterVoiceSpends = (request: Pick<CharacterVoiceRequest, 'changed' | 'provider'>): boolean => request.changed && isPaidProvider(request.provider);
/**
 * The voice written: her own voice with the new provider, as the 「她的声音」 form saves it (her pace, description and reading stay; a new
 * provider starts with no voice id unless one is given, so the description picks one). 'default' takes her own voice away.
 */
export function characterVoiceNext(before: CharacterVoice | null, choice: CharacterVoiceChoice, voiceId?: string): CharacterVoice | null {
  if (choice === 'default') return null;
  const id = voiceId ?? (before?.provider === choice ? before.voiceId : '');
  return normalizeCharacterVoice({ ...(before ?? {}), provider: choice, voiceId: id }) ?? { provider: choice, voiceId: '' };
}
export function characterVoiceRequest(settings: AppSettings, cards: Pick<CharacterCardState, 'cards' | 'activeId'>, card: { id: string; name: string },
  choice: CharacterVoiceChoice, voiceId?: string): CharacterVoiceRequest {
  const before = normalizeCharacterVoice((cards.cards.find(item => item.id === card.id) as { voice?: unknown } | undefined)?.voice) ?? null;
  const next = characterVoiceNext(before, choice, voiceId), fallback = paidVoice(settings);
  const provider = next?.provider ?? fallback;
  return { id: card.id, name: card.name, active: cards.activeId === card.id, before, next, previousProvider: before?.provider ?? fallback, provider,
    ready: ttsProviderReady(ttsOf(settings), provider), changed: JSON.stringify(before) !== JSON.stringify(next) };
}
const voiceWords = (voice: CharacterVoice | null, provider: TtsProvider): string => voice ? voiceLabel(voice) : `新角色的默认声音（${PROVIDER_LABEL[provider]}）`;
/** The dialog for a paid voice: from, to, how it is charged, Drama 3's limit and spending, a missing key. Never a key or an address. */
export function characterVoiceConfirmation(request: CharacterVoiceRequest, drama3: Drama3View, at: Date): { title: string; detail: string } {
  const label = PROVIDER_LABEL[request.provider];
  const missing = request.ready ? '' : request.provider === 'fish' ? 'Drama 3 的 Key 还没有填：填好之前她先用别的声音读（不花钱）。'
    : '百炼的连接和 Key 还没有填：填好之前她先用别的声音读（不花钱）。';
  return {
    title: request.next ? `${ASSISTANT_NAME} 请求把「${request.name}」的声音换成${label}` : `${ASSISTANT_NAME} 请求让「${request.name}」跟随新角色的默认声音（现在是${label}）`,
    detail: [`从：${voiceWords(request.before, request.previousProvider)}`, `改为：${voiceWords(request.next, request.provider)}`, voiceCostLine(request.provider, at),
      request.provider === 'fish' ? drama3LimitLine(drama3) : '', missing,
      '只改她的声音选择，不马上读，不碰任何 Key；你随时可以在「角色」页「她的声音」里改回系统声音。'].filter(Boolean).join('\n'),
  };
}

const FALLBACK_WORDS: Readonly<Record<string, string>> = { 'no-key': '还没有填 Key', 'no-voice-id': 'Drama 3 还没有声音编号', 'wrong-gender': '音色和她的性别对不上' };
/** One character's voice as the channel reads it: her own choice (or the default's), and what really reads for her now. */
export interface CharacterVoiceRow {
  id: string; name: string; active: boolean;
  /** Her own voice (provider and that provider's voice id); null = she follows the default voice for new characters. */
  own: { provider: TtsProvider; voiceId: string } | null;
  /** The provider she is set to speak with; `paid` when it costs money. */
  provider: TtsProvider; paid: boolean;
  /** What reads for her now, and why it is another one (no key, no Drama 3 voice id, this month's limit reached). */
  speaksWith: TtsProvider; because?: string;
}
export function characterVoiceRows(settings: AppSettings, cards: Pick<CharacterCardState, 'cards' | 'activeId'>, drama3: Drama3View): CharacterVoiceRow[] {
  return cards.cards.map(card => {
    const own = normalizeCharacterVoice((card as { voice?: unknown }).voice), provider = own?.provider ?? paidVoice(settings);
    let speaksWith: TtsProvider = provider, because: string | undefined;
    try {
      const plan = characterTtsConfig(settings, card as unknown as VoiceSubject, card.id === cards.activeId ? settings.model?.path ?? '' : '').voicePlan;
      if (plan) { speaksWith = plan.used; because = plan.fallback ? FALLBACK_WORDS[plan.fallback] : undefined; }
    } catch { /* A card the resolver cannot read: her own choice is still shown. */ }
    if (speaksWith === 'fish' && drama3.reachedLimit) { speaksWith = 'system'; because = '本月 Drama 3 已经到上限'; }
    return { id: card.id, name: card.name, active: card.id === cards.activeId, own: own ? { provider: own.provider, voiceId: own.voiceId } : null,
      provider, paid: isPaidProvider(provider), speaksWith, ...(because ? { because } : {}) };
  });
}

/** list_settings' `voices`: the default for new characters, which keys are saved (never a key), Drama 3's limit and spending, each character. */
export function voiceSpendingView(settings: AppSettings, cards: Pick<CharacterCardState, 'cards' | 'activeId'>, budget: FishBudgetView | null | undefined, at: Date) {
  const tts = ttsOf(settings), drama3 = drama3View(settings, budget, at);
  return { newCharacterDefault: paidVoice(settings), keysSaved: { bailian: ttsProviderReady(tts, 'bailian'), fish: ttsProviderReady(tts, 'fish') }, drama3,
    characters: characterVoiceRows(settings, cards, drama3),
    how: '某个角色自己的声音用 set_character_voice 换；Drama 3 每月上限用 set_setting 的 drama3_monthly_limit 改（都要用户原话，会弹窗）。Key、百炼的连接地址和地域只能用户自己在控制窗口填。' };
}
