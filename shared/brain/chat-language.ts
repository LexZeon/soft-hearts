// I-071 v2 (docs/claude/2026-11-11-i071-v2-plan.md): a card speaks one language ('zh-CN' or 'en'), set on the card itself
// (shared/cards/character-cards.ts `language`). A Chinese card speaks only Chinese and an English card only English; they share no
// memory (they are different characters with different ids). The interface language is a separate switch and does not decide this.
// This file only holds the one line an English card adds to the start of a conversation. Pure.
import type { CardLanguage } from '../foundation/character-card';

/**
 * One line, said once at the start of a session of an English card (where the I-063 date line goes), kept as a single constant so it is
 * easy to change. An English card's memories are English, so there is nothing to translate; the line only fixes the language.
 */
export const ENGLISH_SESSION_LINE = 'You always answer in English, whatever language the user writes in. Your memories of the user are in English too.';
/** The session-opening line for a card's language ('' for Chinese: nothing is added, so a Chinese card is exactly what it was). */
export function chatLanguageSessionLine(language: CardLanguage): string {
  return language === 'en' ? ENGLISH_SESSION_LINE : '';
}

/**
 * The line an English card's own-voice calls end with (the inner loop, the keepsake, her words in a game, the look-and-hear lines, the
 * ambient and listening comments). Their instructions are written in Chinese for every card, so a Chinese "say one short line" and a
 * Chinese JSON example led an English character to speak Chinese on her own.
 * It goes LAST in the prompt, where the model reads it after the Chinese example. The word limit is the Chinese character limit
 * restated for English; the validators (spokenLineMax) allow the same line more characters.
 */
export const ENGLISH_SPEECH_LINE = 'Language: you are an English-speaking character. Everything you say out loud to this person is in English, even though the instructions above are written in Chinese. Treat any Chinese character count above as roughly the same length in English: one short line, at most about 12 words. Keep JSON keys, action names and tags exactly as written; only the words you speak are English.';
/** The same without the length sentence, for a call whose fields are longer than one spoken line (the task offer's question, goal and plan). */
export const ENGLISH_TEXT_LINE = 'Language: you are an English-speaking character. Every text field you write for this person is in English, even though the instructions above are written in Chinese. Keep JSON keys, action names and tags exactly as written.';
/** The prompt with an English card's language line at the end; a Chinese card's prompt is returned unchanged (byte for byte). `oneLine` false: the longer-text variant. */
export function withSpeechLanguage(prompt: string, language?: CardLanguage | null, oneLine = true): string {
  return language === 'en' ? `${prompt}\n\n${oneLine ? ENGLISH_SPEECH_LINE : ENGLISH_TEXT_LINE}` : prompt;
}
