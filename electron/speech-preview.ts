import { randomUUID } from 'node:crypto';
import type { CharacterTextDraft } from '../shared/character-cards';
import type { SpeechRequestContext, TtsConfig } from '../shared/tts';
import { characterSpeechPersona } from './speech-persona';
import { composeSpeechConfig, ReplySpeechStyles, type SpeechMood } from './speech-emotion';

/** Explicit preview authority is created by the host, never by a renderer style. */
export function prepareCharacterSpeechPreview(input: {
  owner: number; scope: string; config: TtsConfig;
  card: Pick<CharacterTextDraft, 'personality' | 'description' | 'systemPrompt'>;
  mood: SpeechMood; styles: ReplySpeechStyles; stop(): void;
  createId?: () => string;
}): SpeechRequestContext {
  const id = `preview-${(input.createId ?? randomUUID)()}`;
  const style = composeSpeechConfig(input.config, input.mood, characterSpeechPersona(input.card));
  // Detach the previous recipient before minting the new identity. A late cancel
  // from that previous player must not clear this preview's authority.
  input.stop();
  input.styles.clear();
  input.styles.begin(input.owner, id, input.scope);
  input.styles.complete(input.owner, id, input.scope, input.mood, style);
  return { replyId: id };
}
