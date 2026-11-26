// 保存她念出来的声音（用来比对）: the numbers and names of the dev-only keep-her-voice tool (docs/claude/2026-11-24-voice-keep.md).
// Only the cap and the day range are fixed (disk safety); the default of 7 days is what the user picked, the rest is the user's setting.
export const VOICE_KEEP_FOLDER = 'voice-keep';
export const VOICE_KEEP_SETTINGS_FILE = 'settings.json';
export const VOICE_KEEP_EVENTS_FILE = 'events.jsonl';
export const VOICE_KEEP_DEFAULT_DAYS = 7;
export const VOICE_KEEP_MIN_DAYS = 1;
export const VOICE_KEEP_MAX_DAYS = 30;
/** Stop keeping above this much audio on disk (a safety cap, not a pace); keeping goes on once a sweep or the user's 清空 frees room. */
export const VOICE_KEEP_SIZE_CAP_BYTES = 2 * 1024 ** 3;
/** One sentence's audio is never kept past this size (a runaway stream must not fill the disk before the cap check). */
export const VOICE_KEEP_SENTENCE_MAX_BYTES = 24 * 1024 * 1024;
/** How often old days are looked at while the app runs (also once at start, and after the days setting changes). */
export const VOICE_KEEP_SWEEP_MS = 60 * 60 * 1000;

export function clampKeepDays(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : VOICE_KEEP_DEFAULT_DAYS;
  return Math.min(VOICE_KEEP_MAX_DAYS, Math.max(VOICE_KEEP_MIN_DAYS, n));
}
