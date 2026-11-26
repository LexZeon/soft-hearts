/**
 * 只有插话会打断她.
 * What may cut her current reply or its reading, and what may not (docs/claude/2026-11-25-no-interrupt.md has the whole audit).
 * Pure: no clock, no Electron; both windows and the host read it.
 *
 * Cuts her (the user's own doing): a new message of yours typed and sent, a real spoken barge-in (the existing barge-in rules), a stop control,
 * read-aloud turned off (the voice only), another character, quitting or closing her window, a call started.
 * Never cuts her: any other settings save, a perception switch (pictures, camera, screen, sound, face check), opening or closing a panel,
 * the tray, the toolbar, another voice, rate, volume or provider. Those apply from her next reply (or wait until she is done).
 */

/** The settings a save can carry that matter here (the window's and the host's settings both fit). */
export interface InterruptSettingsView {
  model?: { path?: string } | null;
  voice?: { enabled?: boolean };
}

/**
 * Whether a settings save ends her reading right now. Another model (the character on stage changed) does; read-aloud turned off is
 * the caller's own line (it stops the voice only). A voice, rate, volume, provider or perception switch does not: it applies from the
 * next reply, so the same words never come out in two voices.
 */
export function settingsSaveCutsReading(previous: InterruptSettingsView, next: InterruptSettingsView): boolean {
  return (previous.model?.path ?? null) !== (next.model?.path ?? null);
}

/** Closed words for the experience journal's 'setting-deferred' row: which change waited until she had finished. */
export const SETTING_DEFERRALS = ['connection', 'persona', 'sight-off'] as const;
export type SettingDeferral = (typeof SETTING_DEFERRALS)[number];
/** What she was doing while it waited (closed). */
export const DEFERRED_WHILES = ['replying', 'speaking'] as const;
export type DeferredWhile = (typeof DEFERRED_WHILES)[number];
