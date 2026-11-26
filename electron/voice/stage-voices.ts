/**
 * I-209 stage voice:
 * every character on the full-screen stage reads her own lines in her own card's voice, one voice at a time.
 *
 * Her voice is the one reading pipeline the desktop companion has (one reply read at a time: electron/wiring/voice-wiring.ts). What makes a
 * reading hers is the reply id: ReplySpeechStyles.begin(…, characterId) remembers it when her turn (or her chime-in line) is accepted, and
 * from then on the pipeline reads that reply
 *  - under HER scope (her seat's conversation and generation, CompanionService.speechScopeOf): a reply of someone who left the stage, or
 *    whose conversation changed, is no longer current and is never read (GONE never matches a scope a reading was accepted under);
 *  - with HER card's voice (provider, voice id, pace, reading map): characterTtsConfig with her card, her binding by her id alone;
 *  - against ONE Drama 3 budget (the one synthesizer the runtime has: the monthly limit and the usage count are everyone's together).
 * A reply nobody registered is the desktop companion's, read exactly as before. Pure: the wiring hands the companion and the cards.
 */
import type { TtsConfig } from '../../shared/voice/tts';
import { characterTtsConfig, type VoiceSubject } from '../../shared/voice/character-voice-resolver';

/** Never a scope a reading is accepted under (those are a hash or the desktop companion's JSON pair). */
export const GONE_SCOPE = 'stage-voice:gone';

export interface ReadingScopePorts {
  /** The desktop companion's card id (throws while switching, as her scope does). */
  desk(): string;
  /** The desktop companion's voice scope (voice-wiring's speechScope with no reply). */
  deskScope(): string;
  /** What a turn of someone else on stage is accepted under (CompanionService.speechScopeOf; throws once she left). */
  seat(characterId: string): string;
}

/** The scope a reading of `owner` (null: the desktop companion) is current under now. */
export function readingScope(owner: string | null, ports: ReadingScopePorts): string {
  if (!owner || owner === ports.desk()) return ports.deskScope();
  try { return ports.seat(owner) || GONE_SCOPE; } catch { return GONE_SCOPE; }
}

export interface ReadingCards { getActive(): VoiceSubject; getCard(id: string): VoiceSubject }

/**
 * The voice a reading uses: the desktop companion's card (and her model's binding) for her own replies; for someone else on stage her own
 * card, her binding found by her id (her model is not the desktop one). A card that cannot be read throws: the sentence is not read in
 * somebody else's voice.
 */
export function readingVoice(settings: Parameters<typeof characterTtsConfig>[0], cards: ReadingCards, owner: string | null): TtsConfig {
  const active = cards.getActive();
  return !owner || owner === active.id ? characterTtsConfig(settings, active) : characterTtsConfig(settings, cards.getCard(owner), '');
}
