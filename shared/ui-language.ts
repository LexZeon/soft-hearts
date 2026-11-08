import { ENGLISH_UI_COPY } from './ui-copy.en';

export type UiLanguage = 'en' | 'zh-CN';
export type UiLanguagePreference = 'system' | UiLanguage;
export interface UiLanguageView {
  preference: UiLanguagePreference;
  language: UiLanguage;
  notice?: 'preference-unavailable';
}
let activeUiLanguage: UiLanguage = 'zh-CN';
export function setUiLanguage(language: UiLanguage): void { activeUiLanguage = language; }
export function currentUiLanguage(): UiLanguage { return activeUiLanguage; }
export type UiCopyParams = Readonly<Record<string, string | number>>;
const additionalCopy: Record<UiLanguage, Record<string, string>> = { en: {}, 'zh-CN': {} };
/** Maintainer-imported dictionaries only; never accept renderer/provider supplied catalogs. */
export function registerUiMessages(messages: Readonly<Record<UiLanguage, Readonly<Record<string, string>>>>): void {
  Object.assign(additionalCopy.en, messages.en);
  Object.assign(additionalCopy['zh-CN'], messages['zh-CN']);
}
/** Fixed UI keys/source copy only. User text bypasses this function. */
export function t(key: string, params: UiCopyParams = {}): string {
  const dictionary = additionalCopy[activeUiLanguage];
  const template = Object.hasOwn(dictionary, key) ? dictionary[key]
    : activeUiLanguage === 'en' && Object.hasOwn(ENGLISH_UI_COPY, key) ? ENGLISH_UI_COPY[key]
    : Object.hasOwn(additionalCopy['zh-CN'], key) ? additionalCopy['zh-CN'][key] : key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (marker, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : marker);
}

/** UI presentation only. Never changes ASR, character persona, chat or protocol language. */
export function resolveUiLanguage(preference: UiLanguagePreference, systemLocale: string): UiLanguage {
  if (preference !== 'system') return preference;
  return /^zh(?:[-_]|$)/i.test(systemLocale) ? 'zh-CN' : 'en';
}

export function parseUiLanguagePreference(input: unknown): UiLanguagePreference {
  if (input !== 'system' && input !== 'en' && input !== 'zh-CN')
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
  const template = language === 'en' && Object.hasOwn(english, source) ? english[source] : source;
  return template.replace(/\{(\d+)\}/g, (marker, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : marker);
}
