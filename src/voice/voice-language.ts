// I-071 v2: the language of the active card decides which system voice reads aloud when the user's chosen one does not fit.
// Pure except for the one remembered value, which the window sets from the active card (src/main.ts).
import { systemVoiceGender, type VoiceGender } from '../../shared/voice';
import type { ReadingEntry } from '../../shared/foundation/character-voice-reading';
import type { VoicePlan } from '../../shared/foundation/tts-config';
export type SpeechLanguage = 'zh-CN' | 'en';
let source: () => SpeechLanguage = () => 'zh-CN';
/** The window says where the active card's language is read from (once, at start); it is looked at when a reply is read aloud. */
export function setSpeechLanguageSource(next: () => SpeechLanguage): void { source = next; }
export function setSpeechLanguage(language: SpeechLanguage): void { source = () => language; }
export function speechLanguage(): SpeechLanguage { try { return source() === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; } }

interface VoiceLike { voiceURI: string; lang: string; name?: string }
/** I-162: what the active character's voice asks of the system voice (shared/voice/character-voice-resolver.ts VoicePlan). */
export interface SystemVoiceWish { gender: VoiceGender; voiceURI: string; /** Her own pace and pitch (step 2), multiplied onto the global ones. */ rate?: number; pitch?: number;
  /** I-164 读法: her reading map for the system voice (only when the system voice really reads her); the system voice reads these texts as mapped. */ reading?: ReadingEntry[] }
let wishSource: () => SystemVoiceWish | null = () => null;
/** The window says where the active character's wish is read from (once, at start: src/wiring/voice-wiring.ts startVoiceOutput). */
export function setSystemVoiceWishSource(next: () => SystemVoiceWish | null): void { wishSource = next; }
function systemVoiceWish(): SystemVoiceWish | null { try { return wishSource(); } catch { return null; } }
/** Her own pace and pitch for the system voice (step 2: the character page); 1 when she has none. */
export function systemVoiceDelivery(wish: SystemVoiceWish | null = systemVoiceWish()): { rate: number; pitch: number } { return { rate: wish?.rate ?? 1, pitch: wish?.pitch ?? 1 }; }
/**
 * What the active character's voice plan asks of the system voice (the window's wiring reads it for every system-voice pick and reading).
 * Her reading map goes along only when the system voice really reads her: another provider's entries (Drama 3's while its month is used up
 * and the system voice stands in) are written for that engine and never used here.
 */
export function systemWishOf(plan: VoicePlan | undefined): SystemVoiceWish | null {
  return plan ? { gender: plan.gender, voiceURI: plan.systemVoiceURI, ...(plan.rate ? { rate: plan.rate } : {}), ...(plan.pitch ? { pitch: plan.pitch } : {}),
    ...(plan.used === 'system' && plan.reading?.length ? { reading: plan.reading } : {}) } : null;
}
/** Her reading map for the system voice (I-164); none = the text is read as shown. */
export function systemVoiceReading(wish: SystemVoiceWish | null = systemVoiceWish()): readonly ReadingEntry[] | undefined { return wish?.reading; }
// English cards: natural/female voices first. Names are the common Windows/Edge/Apple ones; any en-* voice is the fallback.
const PREFERRED_ENGLISH_NAMES = /\b(aria|jenny|ava|emma|michelle|zira|samantha|libby|sonia|hazel|susan)\b/i;
/**
 * The system voice for a reply. I-162: a voice whose name is known to be of the other gender than hers is never picked (the wish's gender);
 * her own voiceURI comes first when the system voice is her choice. Then, as before: a Chinese card takes the chosen voice, else a Chinese one
 * (her gender's known voices first); an English card keeps the chosen voice only if it speaks English, else an English one.
 * Null when no voice fits (the utterance then only names the language).
 */
export function pickSystemVoice<V extends VoiceLike>(voices: readonly V[], voiceURI: string, language: SpeechLanguage = speechLanguage(),
  wish: SystemVoiceWish | null = systemVoiceWish()): V | null {
  const fits = (voice: V): boolean => !wish || systemVoiceGender(voice) !== (wish.gender === 'female' ? 'male' : 'female');
  const allowed = voices.filter(fits);
  const known = (list: readonly V[]): V[] => wish ? list.filter(voice => systemVoiceGender(voice) === wish.gender) : [];
  const chosen = (wish?.voiceURI ? allowed.find(voice => voice.voiceURI === wish.voiceURI) : undefined) ?? allowed.find(voice => voice.voiceURI === voiceURI);
  if (language !== 'en') {
    const chinese = allowed.filter(voice => voice.lang.startsWith('zh'));
    return chosen ?? known(chinese)[0] ?? chinese[0] ?? null;
  }
  const english = (voice: V): boolean => voice.lang.toLowerCase().startsWith('en');
  if (chosen && english(chosen)) return chosen;
  const englishVoices = allowed.filter(english);
  const natural = englishVoices.filter(voice => /natural|neural|online/i.test(voice.name ?? ''));
  const named = (list: readonly V[]): V | undefined => list.find(voice => PREFERRED_ENGLISH_NAMES.test(voice.name ?? ''));
  return (wish?.gender === 'male' ? known(natural)[0] ?? known(englishVoices)[0] : undefined)
    ?? named(natural) ?? named(englishVoices) ?? known(englishVoices)[0] ?? englishVoices[0] ?? chosen ?? null;
}
/** The utterance language when no voice was found. */
export function fallbackUtteranceLang(language: SpeechLanguage = speechLanguage()): string { return language === 'en' ? 'en-US' : 'zh-CN'; }
/** The one short line under the system-voice list: which voice this character will read aloud with. */
export function systemVoiceLine<V extends VoiceLike>(voices: readonly V[], voiceURI: string, language: SpeechLanguage): string {
  const voice = pickSystemVoice(voices, voiceURI, language);
  const name = voice ? (voice.name || voice.voiceURI) : '';
  if (language === 'en') return name ? `当前角色是英文：系统朗读会用英文声音「${name}」` : '当前角色是英文：没找到英文系统声音，会用系统默认声音';
  return name ? `当前角色是中文：系统朗读会用「${name}」` : '当前角色是中文：系统朗读会用系统默认中文声音';
}
