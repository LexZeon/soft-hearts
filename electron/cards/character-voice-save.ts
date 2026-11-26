// I-162 step 2: the character page's 「她的声音」 saves here. It writes one card's voice through the same store the resolver's input comes from
// (CharacterCardStore.setVoices), and nothing else: it starts no voice, spends nothing, and never touches a key. What is stored is only what
// normalizeCharacterVoice lets through (provider, voice id of that provider's shape, pace, pitch, 声音描述).
import type { CharacterCardState } from '../../shared/foundation/character-card';
import { normalizeCharacterVoice, type CharacterVoice } from '../../shared/foundation/character-voice';
import type { CharacterCardStore } from './character-cards';

/**
 * Sets her voice (a voice), or takes it away (null: she speaks with the default voice for new characters again). Throws for a card that does not
 * exist or for a voice that is not one (an unknown provider): a card keeps what it had in that case.
 */
export async function saveCharacterVoice(store: Pick<CharacterCardStore, 'publicState' | 'setVoices'>, id: unknown, voice: unknown): Promise<CharacterCardState> {
  if (typeof id !== 'string' || !store.publicState().cards.some(card => card.id === id)) throw new Error('角色卡不存在。');
  if (voice === null) return store.setVoices(new Map([[id, undefined]]));
  const normal = normalizeCharacterVoice(voice);
  if (!normal) throw new Error('这个声音选项不能用：服务商不认识。');
  return store.setVoices(new Map<string, CharacterVoice | undefined>([[id, normal]]));
}
