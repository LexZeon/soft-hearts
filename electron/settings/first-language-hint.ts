import path from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';
import { UI_LANGUAGES, type UiLanguage } from '../../shared/foundation/ui-languages';

/**
 * I-219: the first-install language hint.
 *
 * The installing Claude (START-HERE.md) asks "中文还是 English?" once and writes the answer into a one-line file in the app's own
 * folder (`.local/first-language.txt`: `zh-CN` or `en`). A file is the carrier because it reaches the app however it is started
 * (the cmd file, the setup script, a double click, explorer) without any argument having to survive the launchers.
 *
 * Read once, on the very first start: the file is deleted as soon as it is read. It is used only when the profile is fresh, meaning
 * neither the interface-language file nor settings.json exists; then it becomes the saved preference, so every later start just
 * follows the setting (which the user can still change). It never overrides a saved choice, and a value that is not a language this
 * app has is ignored (the interface then follows the system as it always did). Nothing leaves the app folder and the profile.
 */
export const FIRST_LANGUAGE_HINT_FILE = 'first-language.txt';

/** `en`, `zh-CN`, `zh`, `en-US` ...: a language the registry has. Anything else (a word, a sentence, an empty file) is null. */
export function parseFirstLanguageHint(text: string): UiLanguage | null {
  const value = text.replace(/^﻿/, '').trim();
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(value)) return null;
  return (UI_LANGUAGES.find(entry => entry.matchLocale.test(value))?.id ?? null) as UiLanguage | null;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

export interface FirstLanguageHintPlace {
  /** The hint file in the app folder. */
  hintFile: string;
  /** The interface-language file in the profile (its existence means a language was saved once). */
  uiLanguageFile: string;
  /** settings.json in the profile (its existence means this is not a first start). */
  settingsFile: string;
}

/**
 * Reads and removes the hint. Returns the language to save when the hint applies, otherwise null. The caller saves it (`UiLanguageStore.persist`),
 * before the interface language loads. A missing hint changes nothing and is the normal case.
 */
export async function takeFirstLanguageHint(place: FirstLanguageHintPlace): Promise<UiLanguage | null> {
  let text: string;
  try { text = (await readFile(place.hintFile, 'utf8')).slice(0, 64); } catch { return null; }
  await rm(place.hintFile, { force: true }).catch(() => {}); // consumed whether or not it applies: a stale hint never acts later
  const fresh = !(await exists(place.uiLanguageFile)) && !(await exists(place.settingsFile));
  return fresh ? parseFirstLanguageHint(text) : null;
}

/**
 * Where the hint file is. Normally the app folder's `.local/first-language.txt`. The isolated smoke (scripts/smoke/first-language-smoke.mjs)
 * must not write into this checkout's real `.local` (a dev app may read it), so a source run that already carries the smoke's
 * profile switch (MMD_DESK_USER_DATA, honoured only when not packaged) may name another folder with MMD_FIRST_LANGUAGE_HINT_DIR.
 */
export function firstLanguageHintFile(appFolder: string, env: NodeJS.ProcessEnv): string {
  const override = env.MMD_DESK_USER_DATA && env.MMD_FIRST_LANGUAGE_HINT_DIR;
  return override ? path.join(override, FIRST_LANGUAGE_HINT_FILE) : path.join(appFolder, '.local', FIRST_LANGUAGE_HINT_FILE);
}

/**
 * The start-up step: take the hint (the app folder's `.local/first-language.txt`) and, when it applies, save it as the interface-language
 * preference. Run before the store loads. A failed save only means this start follows the system, as before.
 */
export async function applyFirstLanguageHint(appFolder: string, profileFolder: string, store: { persist(preference: unknown): Promise<unknown> }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const language = await takeFirstLanguageHint({ hintFile: firstLanguageHintFile(appFolder, env),
    uiLanguageFile: path.join(profileFolder, 'ui-language-settings.json'), settingsFile: path.join(profileFolder, 'settings.json') }).catch(() => null);
  if (language) await store.persist(language).catch(() => {});
}
