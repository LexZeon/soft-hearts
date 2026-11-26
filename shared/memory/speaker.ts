/**
 * I-209 step 2: who said one archived line. Today a character's archive
 * holds the user's lines and her own; with three on stage (step 4) her history will also hold what the others said. So every line she
 * says is archived with `by` (her card id and name), and the readers below say who it was:
 *
 *  - a user-role line without `by`: the user ('visitor' when the face check said someone else sat there, I-135);
 *  - an assistant line without `by` (every archive before this): the character whose archive it is;
 *  - any line with `by`: that character, herself when it is the archive's own character, someone else otherwise.
 *
 * Step 4 plugs in here: a line another character said is archived into each listener's archive with her `by`; the history Claude gets
 * labels it with `historyLabel` ("Gene：…", "你（用户）：…"), and the chat record page shows `speakerName`.
 */

/** Who said a line: a character's card id and her name as the card had it then. */
export interface MemorySpeaker { characterId: string; name: string }

/** A card id as the archive keeps it (the card store's UUIDs and the preset ids). */
export const SPEAKER_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A name is kept short (the card store caps names lower; this only bounds what the archive keeps). */
export const SPEAKER_NAME_MAX = 40;

/** A valid speaker (a bounded copy), or undefined: anything else reads as "no speaker" (the old meaning). */
export function validSpeaker(value: unknown): MemorySpeaker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { characterId, name } = value as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'characterId' && key !== 'name')) return undefined;
  if (typeof characterId !== 'string' || !SPEAKER_ID.test(characterId) || typeof name !== 'string' || name.includes('\0')) return undefined;
  return { characterId, name: Array.from(name.trim()).slice(0, SPEAKER_NAME_MAX).join('') };
}

/** Who said a line, as the archive of `self` reads it. */
export type LineSpeaker = { kind: 'user' } | { kind: 'visitor' } | { kind: 'self'; name: string } | { kind: 'other'; characterId: string; name: string };

/** One archived message as these readers need it. */
export interface SpokenLine { role: 'user' | 'assistant'; speaker?: 'visitor'; by?: MemorySpeaker }

export function lineSpeaker(line: SpokenLine, self: string): LineSpeaker {
  const by = validSpeaker(line.by);
  if (by) return by.characterId === self ? { kind: 'self', name: by.name } : { kind: 'other', characterId: by.characterId, name: by.name };
  if (line.role === 'assistant') return { kind: 'self', name: '' };
  return line.speaker === 'visitor' ? { kind: 'visitor' } : { kind: 'user' };
}

/** The words for the people in a history (the card's chat language picks them). */
export interface SpeakerWords { user: string; visitor: string; self: string; unnamed: string }
export const SPEAKER_WORDS_ZH: SpeakerWords = { user: '你（用户）', visitor: '来访的另一个人', self: '你自己', unnamed: '另一位角色' };
export const SPEAKER_WORDS_EN: SpeakerWords = { user: 'You (the user)', visitor: 'Someone else who was there', self: 'You', unnamed: 'Another character' };

/** Who said it, for the chat record page: the user, the visitor, her own name (or '' for her own line), or the other one's name. */
export function speakerName(line: SpokenLine, self: string, words: SpeakerWords = SPEAKER_WORDS_ZH): string {
  const who = lineSpeaker(line, self);
  return who.kind === 'user' ? words.user : who.kind === 'visitor' ? words.visitor : who.kind === 'self' ? who.name : who.name || words.unnamed;
}

/**
 * Step 4's seam: one line of a history handed to Claude when several were there ("Gene：……", "你（用户）：……"). Her own lines keep the
 * plain assistant role there; only another speaker's line and the user's are labelled.
 */
export function historyLabel(line: SpokenLine, self: string, words: SpeakerWords = SPEAKER_WORDS_ZH): string {
  const who = lineSpeaker(line, self);
  return who.kind === 'user' ? words.user : who.kind === 'visitor' ? words.visitor : who.kind === 'self' ? words.self : who.name || words.unnamed;
}
