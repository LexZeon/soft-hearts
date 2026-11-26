import { applyAssistantNames } from './assistant-name';
import { SOURCE_UI_LANGUAGE, builtInCopy, isUiLanguagePreference, matchSystemLocale, type UiLanguage, type UiLanguagePreference } from './ui-languages';

// The language list lives in ui-languages.ts (the registry); see its header for how to add one.
export type { UiLanguage, UiLanguagePreference };
export interface UiLanguageView {
  preference: UiLanguagePreference;
  language: UiLanguage;
  notice?: 'preference-unavailable';
}
let activeUiLanguage: UiLanguage = 'zh-CN';
export function setUiLanguage(language: UiLanguage): void { activeUiLanguage = language; }
export function currentUiLanguage(): UiLanguage { return activeUiLanguage; }
export type UiCopyParams = Readonly<Record<string, string | number>>;
const additionalCopy: Record<string, Record<string, string>> = {};
/** Maintainer-imported dictionaries only; never accept renderer/provider supplied catalogs. A language may be left out. */
export function registerUiMessages(messages: Readonly<Partial<Record<UiLanguage, Readonly<Record<string, string>>>>>): void {
  for (const [language, dictionary] of Object.entries(messages))
    if (dictionary) Object.assign(additionalCopy[language] ??= {}, dictionary);
}
/** Fixed UI keys/source copy only. User text bypasses this function. */
export function t(key: string, params: UiCopyParams = {}): string {
  const registered = additionalCopy[activeUiLanguage] ?? {};
  const builtIn = builtInCopy(activeUiLanguage) ?? {};
  const source = additionalCopy[SOURCE_UI_LANGUAGE] ?? {};
  const template = Object.hasOwn(registered, key) ? registered[key]
    : Object.hasOwn(builtIn, key) ? builtIn[key]
    : Object.hasOwn(source, key) ? source[key] : key;
  // I-217: the assistant's name is swapped here, on the fixed copy only (params, which may hold user text, are filled in after).
  return applyAssistantNames(template).replace(/\{([A-Za-z0-9_]+)\}/g, (marker, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : marker);
}

/** UI presentation only. Never changes ASR, character persona, chat or protocol language. */
export function resolveUiLanguage(preference: UiLanguagePreference, systemLocale: string): UiLanguage {
  if (preference !== 'system') return preference;
  return matchSystemLocale(systemLocale);
}

export function parseUiLanguagePreference(input: unknown): UiLanguagePreference {
  if (!isUiLanguagePreference(input))
    throw new Error('Unsupported interface language.');
  return input;
}

/** Pure lookup with bounded, caller-owned placeholders; unknown copy retains its source. */
export function translateUiCopy(
  language: UiLanguage,
  source: string,
  english: Readonly<Record<string, string>>,
  values: readonly unknown[] = [],
): string {
  const template = language !== SOURCE_UI_LANGUAGE && Object.hasOwn(english, source) ? english[source] : source;
  return template.replace(/\{(\d+)\}/g, (marker, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : marker);
}
