import { ENGLISH_UI_COPY } from './ui-copy.en';

/**
 * The interface-language registry (I-157).
 * One row per interface language. The language type, the saved-preference parser, the system-language match and the
 * settings dropdown all read this table; nothing else lists languages by hand.
 *
 * To add a language (e.g. Japanese):
 *  1. Write shared/foundation/ui-copy.ja.ts exporting a Record<string,string> keyed by the Chinese source text
 *     (copy the keys of ui-copy.en.ts; keys you leave out fall back to Chinese, never to a blank).
 *  2. Add one row below: id, label (its own name, never translated), matchLocale (which system locales pick it), copy.
 *  3. Run the tests. If a place is typed with the literal pair 'en' | 'zh-CN' the compiler points at it; use UiLanguage there.
 * Chinese stays the source text: its row has no copy, and anything not translated shows the Chinese.
 * Interface language only changes the interface; chat, character and speech-recognition languages are separate.
 */
export interface UiLanguageEntry {
  readonly id: string;
  /** The language's own name shown in the dropdown; the same in every interface language. */
  readonly label: string;
  /** System locales (app.getLocale()) that select this language when the preference is "follow system". */
  readonly matchLocale: RegExp;
  /** Dictionary keyed by the Chinese source text. Absent for the source language itself. */
  readonly copy?: Readonly<Record<string, string>>;
}

/** The language the code is written in; untranslated copy falls back to it. */
export const SOURCE_UI_LANGUAGE = 'zh-CN' as const;
/** The language used when no row matches the system locale. */
export const FALLBACK_UI_LANGUAGE = 'en' as const;

export const UI_LANGUAGES = [
  { id: 'zh-CN', label: '简体中文', matchLocale: /^zh(?:[-_]|$)/i },
  { id: 'en', label: 'English', matchLocale: /^en(?:[-_]|$)/i, copy: ENGLISH_UI_COPY },
] as const satisfies readonly UiLanguageEntry[];

export type UiLanguage = (typeof UI_LANGUAGES)[number]['id'];
export type UiLanguagePreference = 'system' | UiLanguage;

export function isUiLanguage(value: unknown, table: readonly UiLanguageEntry[] = UI_LANGUAGES): value is UiLanguage {
  return typeof value === 'string' && table.some(entry => entry.id === value);
}

export function isUiLanguagePreference(value: unknown, table: readonly UiLanguageEntry[] = UI_LANGUAGES): value is UiLanguagePreference {
  return value === 'system' || isUiLanguage(value, table);
}

/** First row whose matchLocale accepts the system locale; otherwise the fallback language. */
export function matchSystemLocale(systemLocale: string, table: readonly UiLanguageEntry[] = UI_LANGUAGES): UiLanguage {
  return (table.find(entry => entry.matchLocale.test(systemLocale))?.id ?? FALLBACK_UI_LANGUAGE) as UiLanguage;
}

/** Dropdown rows after "follow system": value and the language's own name. */
export function uiLanguageChoices(table: readonly UiLanguageEntry[] = UI_LANGUAGES): { value: string; label: string }[] {
  return table.map(entry => ({ value: entry.id, label: entry.label }));
}

/** The built-in dictionary of a language (undefined for the source language or unknown ids). */
export function builtInCopy(language: string, table: readonly UiLanguageEntry[] = UI_LANGUAGES): Readonly<Record<string, string>> | undefined {
  return table.find(entry => entry.id === language)?.copy;
}
