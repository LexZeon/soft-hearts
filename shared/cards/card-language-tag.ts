/**
 * I-219: a language tag on a card's name in the lists where the user picks a character.
 * Display only. The card keeps its own name; nothing here is saved, and nothing that tells her or another character a name (the
 * prompts, the chime-in rosters, the grey line, the voice) may take the tagged form: those use `baseCardName`.
 *
 *  - Only when the profile has cards in more than one language; a Chinese-only (or English-only) profile shows clean names.
 *  - A name that already ends in a language tag ("Gene (English)") is shown as it is.
 *  - Chinese interface: 「（中文）」「（English）」; English interface: 「(Chinese)」「(English)」.
 * Pure: no clock, no I/O.
 */
import type { CardLanguage } from '../foundation/character-card';

/** The trailing tag a name may already carry (the same words the opening's regex strips, shared/foundation/i139-texts.ts). */
const TRAILING_LANGUAGE_TAG = /\s*[（(](?:English|英文|中文|Chinese)[)）]$/u;

/** The name without a trailing language tag; the name itself when stripping would leave nothing. */
export function baseCardName(name: string): string {
  const text = String(name ?? '').trim();
  return text.replace(TRAILING_LANGUAGE_TAG, '').trim() || text;
}

/** Whether the name already ends in a language tag. */
export function hasLanguageTag(name: string): boolean {
  return TRAILING_LANGUAGE_TAG.test(String(name ?? '').trim());
}

const languageOf = (card: { language?: unknown }): CardLanguage => card.language === 'en' ? 'en' : 'zh-CN';

/** True when the cards do not all speak the same language. */
export function cardsMixLanguages(cards: readonly { language?: unknown }[]): boolean {
  return new Set(cards.map(languageOf)).size > 1;
}

/** One card's tag text for the interface language, e.g. "（中文）" or "(English)". */
export function languageTagText(language: CardLanguage, uiLanguage: string): string {
  if (uiLanguage === 'en') return language === 'en' ? '(English)' : '(Chinese)';
  return language === 'en' ? '（English）' : '（中文）';
}

/** The name to show in a list; `mixed` comes from cardsMixLanguages over every card in the list. */
export function displayCardName(card: { name: string; language?: unknown }, mixed: boolean, uiLanguage: string): string {
  if (!mixed || hasLanguageTag(card.name)) return card.name;
  const name = String(card.name ?? '').trim();
  return uiLanguage === 'en' ? `${name} ${languageTagText(languageOf(card), uiLanguage)}` : `${name}${languageTagText(languageOf(card), uiLanguage)}`;
}

/** A lookup by id for a whole list at once (the list decides `mixed` from all of its cards). */
export function cardDisplayNames(cards: readonly { id: string; name: string; language?: unknown }[], uiLanguage: string): Map<string, string> {
  const mixed = cardsMixLanguages(cards);
  return new Map(cards.map(card => [card.id, displayCardName(card, mixed, uiLanguage)]));
}
