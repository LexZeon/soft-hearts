// I-162 step 1 (默认声音"包括服务商，也需要做兼容提示词-用于非默认服务商"):
// a character's own default voice, stored on her card (docs/claude/2026-11-19-character-voice-step1.md).
// Foundation: the card draft names this type, so it lives beside shared/foundation/character-card.ts. Pure, imports only foundation.
// What the voice part does with it (which voice really speaks, never the wrong gender): shared/voice/character-voice-resolver.ts.
import { normalizeReadingEntries, portableReadingEntries, type ReadingEntry } from './character-voice-reading';
import type { TtsProvider } from './tts-config';

/**
 * Her default voice: a provider and that provider's voice, her pace (and pitch, which only the system voice can change), and a 声音描述
 * (a short Chinese description: gender, age feel, timbre, pace, how she laughs). The description is the "compatible prompt": with another
 * provider it picks that provider's closest voice, and a provider that takes an instruction gets it as one.
 * It carries no key, no address and no path: keys and hosts stay global and encrypted in the host (electron/voice/tts.ts).
 */
export interface CharacterVoice {
  provider: TtsProvider;
  /** system: the voiceURI; bailian: the voice id; fish: Drama 3's reference_id. '' = pick one by the description. */
  voiceId: string;
  /** 0.5…2; absent = the provider's normal pace. */
  rate?: number;
  /** 0.5…2, the system voice only; absent = normal. */
  pitch?: number;
  /** 声音描述; absent or '' = none (the card's own text then decides gender and age). */
  description?: string;
  /** I-164 读法: what the voice reads instead of some shown texts (a name, a tic); absent = it reads the text as shown (shared/foundation/character-voice-reading.ts). */
  reading?: ReadingEntry[];
}

export const CHARACTER_VOICE_DESCRIPTION_MAX = 300;
export const CHARACTER_VOICE_ID_MAX = 200;
const PROVIDERS: readonly TtsProvider[] = ['system', 'bailian', 'fish'];
const BAILIAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const FISH_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CONTROL = /[\u0000-\u001f\u007f]+/gu;

/** A voice id for its provider, or '' when it is not one (a path, a URL, a control character, the wrong shape). */
export function cleanVoiceId(provider: TtsProvider, value: unknown): string {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > CHARACTER_VOICE_ID_MAX || /[\u0000-\u001f\u007f]/u.test(id)) return '';
  if (provider === 'bailian') return BAILIAN_ID.test(id) ? id : '';
  if (provider === 'fish') return FISH_ID.test(id) ? id : '';
  // A system voiceURI is a name ("Microsoft Huihui - Chinese (Simplified, PRC)", "com.apple.voice.compact.zh-CN.Tingting"): never a path or a link.
  return /[\\/]/u.test(id) ? '' : id;
}

const pace = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(2, Math.max(0.5, value)) * 100) / 100 : undefined;

/** The description as kept: control characters become spaces, brackets go (Drama 3 reads brackets as directions), at most 300 characters. */
export function cleanVoiceDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL, ' ').replace(/[\[\]<>{}]/gu, '').replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, CHARACTER_VOICE_DESCRIPTION_MAX).join('').trim();
}

/**
 * A stored or imported voice made safe, never throwing (a card must always load): an unknown provider drops the whole voice (undefined);
 * an unusable id becomes '' (picked by the description); fields it does not know are left out, so nothing unknown is ever stored or exported.
 */
export function normalizeCharacterVoice(value: unknown): CharacterVoice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const provider = PROVIDERS.find(item => item === input.provider);
  if (!provider) return undefined;
  const rate = pace(input.rate), pitch = pace(input.pitch), description = cleanVoiceDescription(input.description), reading = normalizeReadingEntries(input.reading);
  return {
    provider,
    voiceId: cleanVoiceId(provider, input.voiceId),
    ...(rate !== undefined && rate !== 1 ? { rate } : {}),
    ...(pitch !== undefined && pitch !== 1 && provider === 'system' ? { pitch } : {}),
    ...(description ? { description } : {}),
    ...(reading.length ? { reading } : {}),
  };
}

// Key-like and path-like text never leaves in an exported card, even if someone typed it into the description.
const KEY_LIKE = /\b(?:sk|ak|pk|key|token|bearer)[-_ ]?[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_-]{32,}\b/giu;
const PATH_LIKE = /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:Users|home|var|etc|tmp|mnt|opt)\/)[^\s，。；、]*/gu;
const LINK_LIKE = /\b(?:https?|file|mmd-asset):\/\/[^\s，。；、]*/giu;

/**
 * What a card export carries (the user's recommendation a, by default: provider, voice id and description, never a key): exactly the
 * normalized fields, with anything that looks like a key, a path or a link cut out of the description. The voice id already cannot be a path.
 */
export function portableCharacterVoice(voice: unknown): CharacterVoice | undefined {
  const normal = normalizeCharacterVoice(voice);
  if (!normal) return undefined;
  const description = normal.description ? cleanVoiceDescription(normal.description.replace(LINK_LIKE, '').replace(PATH_LIKE, '').replace(KEY_LIKE, '')) : '';
  // A system voice is a readable name: one that looks like a key is not a voice name. Bailian and Drama 3 ids are their own fixed shapes.
  const voiceId = normal.provider === 'system' && new RegExp(KEY_LIKE.source, 'iu').test(normal.voiceId) ? '' : normal.voiceId;
  return { provider: normal.provider, voiceId, ...(normal.rate !== undefined ? { rate: normal.rate } : {}), ...(normal.pitch !== undefined ? { pitch: normal.pitch } : {}),
    ...(description ? { description } : {}), ...portableReading(normal.reading) };
}
/** The export's reading map: entries without a key, a path or a link; none left = the field is left out. */
function portableReading(reading: ReadingEntry[] | undefined): { reading?: ReadingEntry[] } {
  const kept = portableReadingEntries(reading);
  return kept.length ? { reading: kept } : {};
}

/** Two voices are the same choice (the fields a card stores). */
export function sameCharacterVoice(a: CharacterVoice | undefined, b: CharacterVoice | undefined): boolean {
  return JSON.stringify(normalizeCharacterVoice(a) ?? null) === JSON.stringify(normalizeCharacterVoice(b) ?? null);
}
