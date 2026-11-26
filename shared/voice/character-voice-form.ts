// I-162 step 2: what the character page's 「她的声音」 shows and what it saves.
// docs/claude/2026-11-20-character-voice-step2.md. Pure: the window builds its controls from these tables and turns the form back into a card voice
// here, so the same rules hold for the page, the tests and the mutation checks. It never reads a key and has no way to carry one: the form has no
// key field, and what comes out is only a normalized CharacterVoice (shared/foundation/character-voice.ts).
import { CHARACTER_VOICE_DESCRIPTION_MAX, normalizeCharacterVoice, type CharacterVoice } from '../foundation/character-voice';
import type { ReadingEntry } from '../foundation/character-voice-reading';
import type { TtsProvider } from '../foundation/tts-config';
import { BAILIAN_KNOWN_VOICES, systemVoiceGender, type VoiceGender } from './voice-traits';

export interface VoiceProviderForm {
  /** The name on the choice (Chinese; the window translates it). */
  readonly label: string;
  /** A paid, cloud provider: the text is sent to it, and Drama 3 charges by the byte. Choosing it here never starts a voice by itself. */
  readonly paid: boolean;
  /** Which settings the provider can change. */
  readonly rate: boolean;
  readonly pitch: boolean;
  /** How the voice is picked: a list of voices ('list'), a voice id typed in ('id'). */
  readonly pick: 'list' | 'id';
}
export const VOICE_PROVIDER_FORM: Readonly<Record<TtsProvider, VoiceProviderForm>> = Object.freeze({
  system: { label: '系统声音（免费）', paid: false, rate: true, pitch: true, pick: 'list' },
  bailian: { label: '百炼（需要自己的 Key）', paid: true, rate: true, pitch: false, pick: 'list' },
  fish: { label: 'Drama 3（Fish Audio，付费）', paid: true, rate: true, pitch: false, pick: 'id' },
});
export const VOICE_PROVIDER_ORDER: readonly TtsProvider[] = ['system', 'bailian', 'fish'];

/** What each paid provider is, in one line shown the moment it is chosen (no money moves: a preview or a reply is what asks). */
export const PAID_PROVIDER_NOTE: Readonly<Partial<Record<TtsProvider, string>>> = Object.freeze({
  bailian: '百炼是云端朗读：朗读的文字会发给你自己的百炼账号。只选它不会花钱，也不会马上读；要读之前需要先在「百炼语音」填好连接和 Key。',
  fish: 'Drama 3 是付费云端朗读，按字节收费，朗读的文字会发给 Fish Audio。只选它不会花钱，也不会马上读；要读之前需要先填好 Key，试听和每月上限照旧。',
});

export interface VoiceChoice { readonly id: string; readonly label: string; readonly gender: VoiceGender | null }
export const GENDER_MARK: Readonly<Record<VoiceGender, string>> = Object.freeze({ female: '女声', male: '男声' });

/** Bailian's voices with the gender where it is known (shared/voice/voice-traits.ts). 龙安风悦 is listed without one: it has not been listened to. */
export function bailianVoiceChoices(): VoiceChoice[] {
  const names: Readonly<Record<string, string>> = { 'longanlingxin_v3.1': '龙安灵心', 'longanhuan_v3.1': '龙安欢', 'longanfengyue_v3.1': '龙安风悦', 'xunanchuan_v3.1': '许南川' };
  const ids = [...new Set([...Object.keys(names), ...BAILIAN_KNOWN_VOICES.map(voice => voice.id)])];
  return ids.map(id => ({ id, label: names[id] ?? id, gender: BAILIAN_KNOWN_VOICES.find(voice => voice.id === id)?.gender ?? null }));
}
/** The window's system voices as choices: the gender from the voice's name where it is known. */
export function systemVoiceChoices(voices: readonly { voiceURI: string; name?: string; lang?: string }[]): VoiceChoice[] {
  return voices.map(voice => ({ id: voice.voiceURI, label: `${voice.name || voice.voiceURI}${voice.lang ? ` · ${voice.lang}` : ''}`, gender: systemVoiceGender(voice) }));
}
/** "龙安灵心 · 女声", or the label alone when the gender is not known. */
export function choiceLabel(choice: VoiceChoice): string {
  return choice.gender ? `${choice.label} · ${GENDER_MARK[choice.gender]}` : choice.label;
}

/** The form as the window holds it: strings and numbers only, never a key. */
export interface VoiceForm {
  provider: TtsProvider;
  voiceId: string;
  /** 0.5…2; 1 = the provider's normal pace. */
  rate: number;
  pitch: number;
  description: string;
  /** I-164 读法: shown text -> spoken text. */
  reading?: ReadingEntry[];
}
export const EMPTY_VOICE_FORM: VoiceForm = Object.freeze({ provider: 'system', voiceId: '', rate: 1, pitch: 1, description: '' });

/** The form for a card: her own voice, or (when she has none yet) the default voice for new characters. */
export function voiceFormOf(own: CharacterVoice | undefined, newDefault: CharacterVoice | undefined): VoiceForm {
  const voice = normalizeCharacterVoice(own) ?? normalizeCharacterVoice(newDefault);
  if (!voice) return { ...EMPTY_VOICE_FORM };
  return { provider: voice.provider, voiceId: voice.voiceId, rate: voice.rate ?? 1, pitch: voice.pitch ?? 1, description: voice.description ?? '', ...(voice.reading?.length ? { reading: voice.reading.map(entry => ({ ...entry })) } : {}) };
}

/**
 * What saving the form writes to her card. Only what the provider can change is kept (a pitch means nothing for a cloud voice); the result
 * goes through normalizeCharacterVoice, so a path, a link or a control character in the voice id is dropped and an odd number is clamped.
 */
export function voiceFromForm(form: VoiceForm): CharacterVoice {
  const caps = VOICE_PROVIDER_FORM[form.provider] ?? VOICE_PROVIDER_FORM.system;
  return normalizeCharacterVoice({ provider: form.provider, voiceId: form.voiceId,
    ...(caps.rate ? { rate: form.rate } : {}), ...(caps.pitch ? { pitch: form.pitch } : {}), description: form.description, reading: form.reading }) ?? { provider: 'system', voiceId: '' };
}
/** The form's description box: its limit, and an example that shows the kind of sentence that works. */
export const VOICE_DESCRIPTION_MAX = CHARACTER_VOICE_DESCRIPTION_MAX;
export const VOICE_DESCRIPTION_EXAMPLE = '二十出头的女生，声音亮亮的，有点软，语速不快，笑起来会轻轻拖一点尾音。';

/** Nothing to save: the form says what her card already has. */
export function voiceFormUnchanged(own: CharacterVoice | undefined, form: VoiceForm): boolean {
  return JSON.stringify(normalizeCharacterVoice(own) ?? null) === JSON.stringify(voiceFromForm(form));
}

/** The one line shown under the provider choice: what is true of it, in the words the page uses. */
export function providerNote(provider: TtsProvider): string {
  return PAID_PROVIDER_NOTE[provider] ?? '系统声音是免费的，读的文字不会离开这台电脑。';
}
/** A short name for the card-update line and the page: "百炼 · 龙安欢", "系统声音". */
export function voiceLabel(voice: CharacterVoice | undefined, t: (text: string) => string = text => text): string {
  const normal = normalizeCharacterVoice(voice);
  if (!normal) return '';
  const base = normal.provider === 'system' ? t('系统声音') : normal.provider === 'bailian' ? t('百炼') : 'Drama 3';
  const named = normal.provider === 'bailian' ? bailianVoiceChoices().find(choice => choice.id === normal.voiceId)?.label : undefined;
  return normal.voiceId ? `${base} · ${named ?? (normal.provider === 'system' ? t('指定的声音') : normal.voiceId)}` : base;
}
