// I-162 step 1: moving each character's voice onto her card (docs/claude/2026-11-19-character-voice-step1.md). Pure; the cards part's ready
// and save steps (electron/wiring/cards-ready-wiring.ts) write what these return through CharacterCardStore.setVoices.
import { normalizeCharacterVoice, sameCharacterVoice, type CharacterVoice } from '../foundation/character-voice';
import { DEFAULT_TTS_CONFIG, resolveStyleBinding } from './tts';
import { capturedCharacterVoice, type VoiceSettings } from './character-voice-resolver';

/**
 * The migration (each start, idempotent): a card without a voice of her own gets the voice she speaks with now (her binding's provider and
 * voice, else the global ones), so the old global setting can become the default for new characters without changing anyone.
 * A card that has one is never touched. `modelPath` per card: the active card's is the current model; another card's is her linked model.
 */
export function voicesToSettle(settings: VoiceSettings, cards: readonly { id: string; voice?: CharacterVoice; modelPath?: string }[],
  active: { id: string; modelPath: string }): Map<string, CharacterVoice> {
  const result = new Map<string, CharacterVoice>();
  for (const card of cards) {
    if (normalizeCharacterVoice(card.voice)) continue;
    result.set(card.id, capturedCharacterVoice(settings, card.id, card.id === active.id ? active.modelPath : card.modelPath ?? ''));
  }
  return result;
}

/**
 * A settings save that changes the active character's own choice the old way moves her card's voice along: provider and voice id change, her
 * description, pace and pitch stay. Other characters keep theirs. Null: nothing to change (also when the model changed in the same save:
 * another model's binding is not a choice the user made now).
 *
 * Step 2 (the global 输出方案 became 「新角色的默认声音」): the global provider and the global voice ids are no longer hers, so
 * changing them moves nobody. What still follows is what is hers by the old routes: her own binding (this character + model: its provider,
 * voice, Drama 3 voice id and pace, as the agent channel's set_voice_style and the voice panel's 「声音编号（这个角色）」 save them) and the
 * system voice list when the system voice is hers (the list shows her own voice, so picking there is hers).
 */
export function followedVoice(previous: VoiceSettings, next: VoiceSettings, card: { id: string; voice?: CharacterVoice }): CharacterVoice | null {
  const modelPath = next.model?.path ?? '';
  if ((previous.model?.path ?? '') !== modelPath || !card.id) return null;
  const own = normalizeCharacterVoice(card.voice);
  const before = resolveStyleBinding(previous.tts ?? DEFAULT_TTS_CONFIG, card.id, modelPath), after = resolveStyleBinding(next.tts ?? DEFAULT_TTS_CONFIG, card.id, modelPath);
  const set = (change: Partial<CharacterVoice>): CharacterVoice | null => {
    const voice = normalizeCharacterVoice({ provider: 'system', voiceId: '', ...(own ?? {}), ...change });
    return voice && !sameCharacterVoice(voice, own) ? voice : null;
  };
  // Her binding names another provider than before: that is her choice now.
  if (after?.provider && after.provider !== before?.provider && after.provider !== own?.provider) {
    const voiceId = after.provider === 'system' ? next.voice?.voiceURI ?? '' : after.provider === 'bailian' ? after.voice : after.fishVoiceId ?? '';
    return set({ provider: after.provider, voiceId, ...(after.provider !== 'system' ? { rate: after.rate } : {}) });
  }
  if (own && own.provider !== 'system' && before && after) {
    // Her binding's voice id or pace for the provider she speaks with changed (the panel's fields for this character).
    const was = own.provider === 'bailian' ? before.voice : before.fishVoiceId, now = own.provider === 'bailian' ? after.voice : after.fishVoiceId;
    if (now !== undefined && now !== was && now !== own.voiceId && (own.provider === 'fish' || now)) return set({ voiceId: now });
    if (after.rate !== before.rate && after.rate !== (own.rate ?? 1)) return set({ rate: after.rate });
  }
  // The system voice list shows her own voice when the system voice is hers (src/wiring/settings-wiring.ts populateVoices): picking there is hers.
  const uri = next.voice?.voiceURI ?? '';
  return own?.provider === 'system' && uri !== (previous.voice?.voiceURI ?? '') && uri !== own.voiceId ? set({ voiceId: uri }) : null;
}
