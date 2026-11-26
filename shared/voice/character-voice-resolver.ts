// I-162 step 1: the one resolver every speech path goes through (replies, read-aloud, calls, fillers, previews, cues): which voice a character
// really speaks with. docs/claude/2026-11-19-character-voice-step1.md. Pure: the host's wiring and the windows call it with the settings and
// the active card; tests/character-voice-resolver.test.ts holds it to its rules.
//
// The rules (the brief's "Do" 2):
// - Her default voice (card.voice: provider + voice id + pace + 声音描述) speaks when its provider can speak and the voice is usable.
// - Otherwise another provider, in this order: the default provider for new characters (the old global one) if it can speak, then the free
//   system voice. With another provider the 声音描述 picks the closest voice there (Bailian: its known voices by gender, age and timbre) and
//   Bailian takes it as its instruction (a separate request field) when nothing else is set.
// - Drama 3 never gets the 声音描述 as its acting style (2026-11-20): Drama 3's direction is written inline, in square brackets in front of
//   the words, and a long description is partly read aloud (One's 208-character description: "切，是鼻子里干干的出气" spoken in every reply,
//   user: "”切，是鼻子里干干的粗气“直接读出来了"). Only an acting style written for Drama 3 (the panel's 表演提示, short) goes there.
// - A known voice of the other gender is never used: not Bailian's, not a system voice (src/voice/voice-language.ts checks the window's
//   voices with the plan's gender). Drama 3 without a voice id would read with its own built-in voice, not chosen for her and possibly male:
//   it is never used (the cause of "我切到艾琳的时候输出变成男声了").
// - Paid providers keep their notices and budget exactly as they were: nothing here starts a paid voice the settings did not already choose.
import type { CharacterTextDraft } from '../foundation/character-card';
import { normalizeCharacterVoice, type CharacterVoice } from '../foundation/character-voice';
import type { TtsConfig, TtsProvider, VoicePlan } from '../foundation/tts-config';
import { DEFAULT_TTS_CONFIG, TTS_EMOTIONS, effectiveTtsConfig, resolveStyleBinding, ttsProviderReady } from './tts';
import { readingFor } from './reading-map';
import { bailianVoiceGender, cardVoiceText, closestBailianVoice, voiceTraits, type VoiceTraits } from './voice-traits';

/** What the resolver reads from the settings (both the host's and a window's public copy fit). */
export interface VoiceSettings {
  tts?: TtsConfig;
  voice?: { voiceURI?: string };
  model?: { path?: string } | null;
}
/** What it reads from the card (the host's active card and a window's public card both fit). */
export type VoiceSubject = { id: string; voice?: CharacterVoice } & Partial<Pick<CharacterTextDraft, 'name' | 'description' | 'personality' | 'scenario' | 'systemPrompt'>>
  & { understandingNotes?: string };

const ttsOf = (settings: VoiceSettings): TtsConfig => settings.tts ?? (DEFAULT_TTS_CONFIG as TtsConfig);

/**
 * The voice a character's settings added up to before I-162: her binding's own provider, else the global one, and that provider's voice
 * (the system voice is the global voiceURI; Bailian and Drama 3 take her binding's voice, else the global one). The migration captures it,
 * and a save that changes it for the active character moves her card along (electron/wiring/cards-ready-wiring.ts saveCardPersona).
 */
export function chosenVoiceIdentity(settings: VoiceSettings, characterId: string, modelPath: string): { provider: TtsProvider; voiceId: string } {
  const tts = ttsOf(settings), binding = characterId ? resolveStyleBinding(tts, characterId, modelPath) : undefined;
  const provider = binding?.provider ?? tts.provider;
  const voiceId = provider === 'system' ? settings.voice?.voiceURI ?? ''
    : provider === 'bailian' ? binding?.voice ?? tts.voice : binding?.fishVoiceId ?? tts.fishVoiceId ?? '';
  return { provider, voiceId };
}

/** The default voice for new characters: the old global choice (no character's own binding). */
export function newCharacterVoice(settings: VoiceSettings): CharacterVoice {
  const { provider, voiceId } = chosenVoiceIdentity(settings, '', '');
  return normalizeCharacterVoice({ provider, voiceId }) ?? { provider: 'system', voiceId: '' };
}

/** The migration's capture: her current effective choice, with her pace when a paid voice reads her (the system voice keeps the global pace). */
export function capturedCharacterVoice(settings: VoiceSettings, characterId: string, modelPath: string): CharacterVoice {
  const tts = ttsOf(settings), { provider, voiceId } = chosenVoiceIdentity(settings, characterId, modelPath);
  const rate = provider === 'system' ? undefined : resolveStyleBinding(tts, characterId, modelPath)?.rate ?? tts.rate;
  return normalizeCharacterVoice({ provider, voiceId, ...(rate !== undefined ? { rate } : {}) }) ?? { provider: 'system', voiceId: '' };
}

const PROVIDER_LABEL: Readonly<Record<TtsProvider, string>> = { system: '系统声音', bailian: '百炼', fish: 'Drama 3' };
const PROVIDER_LABEL_EN: Readonly<Record<TtsProvider, string>> = { system: 'the system voice', bailian: 'Bailian', fish: 'Drama 3' };
/** The one line when her own voice cannot speak: Chinese, and the same line in English (the window picks by the interface language; step 2). */
function noticeFor(name: string, wanted: TtsProvider, used: TtsProvider, gender: VoiceTraits['gender'], fallback: NonNullable<VoicePlan['fallback']>): { zh: string; en: string } {
  const who = name ? `「${name}」` : '她', hers = name ? `"${name}"'s` : 'Her';
  const usedLabel = used === 'system' ? (gender === 'male' ? '系统男声' : '系统女声') : PROVIDER_LABEL[used];
  const usedEn = used === 'system' ? (gender === 'male' ? 'a male system voice' : 'a female system voice') : PROVIDER_LABEL_EN[used];
  if (fallback === 'no-key') return { zh: `${who}的声音用${PROVIDER_LABEL[wanted]}，但还没有填它的 Key，先用${usedLabel}读。`,
    en: `${hers} voice is set to ${PROVIDER_LABEL_EN[wanted]}, but its key is not filled in yet, so ${usedEn} reads for now.` };
  if (fallback === 'no-voice-id') return { zh: `${who}的 Drama 3 还没有指定声音编号（不指定会用 Drama 3 自带的声音，可能是男声），先用${usedLabel}读；在「她的声音」里给她填一个声音编号就会用 Drama 3。`,
    en: `${hers} Drama 3 voice has no voice id yet (without one Drama 3 reads in its own built-in voice, which may be a man's), so ${usedEn} reads for now. Fill in a voice id under "Her voice" to use Drama 3.` };
  return { zh: `${who}的${PROVIDER_LABEL[wanted]}音色和她的性别对不上，换成了${usedLabel}里最接近她的声音描述的一个。`,
    en: `${hers} ${PROVIDER_LABEL_EN[wanted]} voice does not match her gender, so the closest voice to her voice description is used instead.` };
}

const instructionOf = (config: Pick<TtsConfig, 'emotion' | 'instruction'>): string =>
  config.emotion === 'custom' ? config.instruction : TTS_EMOTIONS.find(item => item.id === config.emotion)?.instruction ?? config.instruction;

/**
 * The voice this character speaks with now. Everything that reads aloud for her calls this (through electron/voice/character-voice-config.ts
 * on the host, src/wiring/voice-wiring.ts currentTtsConfig in a window). The result is a TtsConfig: the provider really used, its voice, the
 * style of her binding (Bailian's instruction and emotion, Drama 3's acting style, the pace), `ownProvider` for the voice panel and `voicePlan`.
 */
export function characterTtsConfig(settings: VoiceSettings, card: VoiceSubject | null | undefined, modelPath: string = settings.model?.path ?? ''): TtsConfig {
  const tts = ttsOf(settings), id = card?.id ?? '';
  const style = effectiveTtsConfig(tts, id, modelPath);
  const binding = id ? resolveStyleBinding(tts, id, modelPath) : undefined;
  const own = normalizeCharacterVoice(card?.voice);
  const wanted = own ?? newCharacterVoice(settings);
  const traits = voiceTraits(wanted.description, card ? cardVoiceText(card) : '');
  const description = wanted.description ?? '';
  // Her own pace speaks for her own provider (step 2: the character page edits it; the panel's slider moves it along, see followedVoice).
  const rateOf = (isWanted: boolean): number => isWanted ? wanted.rate ?? style.rate : style.rate;
  let fallback: VoicePlan['fallback'] = null;
  const finish = (config: TtsConfig, used: TtsProvider, systemVoiceURI = ''): TtsConfig => {
    delete config.ownProvider;
    if (own && own.provider !== tts.provider) config.ownProvider = own.provider; // the panel's 「这个角色的朗读声音」: '' when hers is the default
    const reason = fallback; // 'no-key' and 'no-voice-id' are only set when her own provider was passed over
    const notice = reason ? noticeFor(card?.name ?? '', wanted.provider, used, traits.gender, reason) : null;
    // Her own pace and pitch for the system voice (step 2): only when the system voice is hers; the window applies them on top of the global ones.
    const reading = readingFor(own?.reading, used); // I-164: the entries of the provider that really reads her
    const hersSystem = used === 'system' && wanted.provider === 'system' && !reason;
    config.voicePlan = { wanted: wanted.provider, used, gender: traits.gender, ...(traits.age ? { age: traits.age } : {}), systemVoiceURI, fallback: reason,
      ...(notice ? { notice: notice.zh, noticeEn: notice.en } : {}),
      ...(hersSystem && wanted.rate ? { rate: wanted.rate } : {}), ...(hersSystem && wanted.pitch ? { pitch: wanted.pitch } : {}),
      ...(reading.length ? { reading } : {}) };
    return config;
  };
  const order = [...new Set<TtsProvider>([wanted.provider, tts.provider, 'system'])];
  for (const provider of order) {
    const isWanted = provider === wanted.provider;
    if (!ttsProviderReady(tts, provider)) { if (isWanted) fallback = 'no-key'; continue; }
    if (provider === 'fish') {
      // Her own Drama 3 voice, or (as another provider) the one her binding names. None = Drama 3's built-in voice: never hers.
      // I-173: her own Drama 3 with no id of its own takes the id her binding names (what the channel's set_voice_style
      // wrote for her), so the page and the channel cannot disagree into the system voice. The global id is never borrowed for her.
      const voiceId = isWanted ? wanted.voiceId || binding?.fishVoiceId || '' : binding?.fishVoiceId ?? '';
      if (!voiceId) { if (isWanted) fallback = 'no-voice-id'; continue; }
      const acting = style.fishActingStyle; // never the 声音描述: Drama 3 would read it aloud (header)
      const config: TtsConfig = { ...style, provider: 'fish', fishVoiceId: voiceId, rate: rateOf(isWanted) };
      if (acting) config.fishActingStyle = acting; else delete config.fishActingStyle;
      return finish(config, 'fish');
    }
    if (provider === 'bailian') {
      // Her own voice id (trusted unless it is a known voice of the other gender), else the closest known voice to her description.
      const candidate = isWanted ? wanted.voiceId : binding?.voice ?? '';
      const trusted = isWanted ? !!own : !!binding;
      const known = candidate ? bailianVoiceGender(candidate) : null;
      const usable = !!candidate && (known ? known === traits.gender : trusted);
      if (candidate && known && known !== traits.gender && isWanted) fallback = 'wrong-gender';
      const voice = usable ? candidate : closestBailianVoice(traits).id;
      const config: TtsConfig = { ...style, provider: 'bailian', voice, rate: rateOf(isWanted) };
      if (description && !instructionOf(style).trim() && (!usable || !isWanted)) { config.emotion = 'custom'; config.instruction = description; }
      return finish(config, 'bailian');
    }
    // The system voice is always there; the window picks the voice itself (her own voiceURI when it is her choice, else one of her gender).
    return finish({ ...style, provider: 'system' }, 'system', isWanted ? wanted.voiceId : '');
  }
  return finish({ ...style, provider: 'system' }, 'system');
}
