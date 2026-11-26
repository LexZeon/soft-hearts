// I-188 #4: the user's usual bedtime, learned from when the computer was last in use on recent nights (a robust median), and the
// late-night recogniser. Only "the last minute someone was at the computer tonight" is kept per night: no app, no window, no words.
// Pure: the caller gives the local minute and the night key.

import { MOMENT_KNOBS, type MomentKnobs } from './knobs';

const DAY = 1440;
/** The evening clock: minutes since local noon (0 = 12:00, 720 = midnight). A night is noon to noon, named by the date it starts on. */
export function eveningMinute(localMinute: number): number { return (((Math.floor(localMinute) - 720) % DAY) + DAY) % DAY; }
/** Minutes from midnight (negative = the evening before) from an evening minute. */
export function fromEvening(evening: number): number { return evening - 720; }
/** The noon-to-noon night key for a wall time and its local minute: the local date of (wall - 12 h). */
export function eveningNightKey(wallMs: number, localMinute: number): string {
  const since = eveningMinute(localMinute);
  const day = new Date(wallMs - since * 60_000);
  return `${String(day.getFullYear()).padStart(4, '0')}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** Evening minutes that count as "still up at night": 20:00 (480) to 06:00 (1080). */
export const NIGHT_FROM_EVENING = 480;
export const NIGHT_TO_EVENING = 1080;
export function isNightMinute(localMinute: number): boolean { const e = eveningMinute(localMinute); return e >= NIGHT_FROM_EVENING && e <= NIGHT_TO_EVENING; }

/** nights: key → the last evening minute someone was at the computer that night. */
export type BedNights = Readonly<Record<string, number>>;

/**
 * The usual bedtime in minutes from midnight: the median of the last `useNights` nights before tonight (the median: one all-nighter or
 * one early night does not move it), clamped to [earliestBedMinute, latestBedMinute]; the fallback with fewer than `minNights` nights.
 */
export function usualBedtime(nights: BedNights, tonight: string, knobs: MomentKnobs = MOMENT_KNOBS): { minute: number; nights: number } {
  const k = knobs.lateNight;
  const values = Object.entries(nights).filter(([key, value]) => key < tonight && Number.isFinite(value) && value >= NIGHT_FROM_EVENING && value <= NIGHT_TO_EVENING)
    .sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, Math.max(1, k.useNights)).map(([, value]) => value).sort((a, b) => a - b);
  if (values.length < Math.max(1, k.minNights)) return { minute: k.fallbackBedMinute, nights: values.length };
  const mid = values.length / 2;
  const median = values.length % 2 ? values[Math.floor(mid)] : (values[mid - 1] + values[mid]) / 2;
  return { minute: Math.round(Math.min(k.latestBedMinute, Math.max(k.earliestBedMinute, fromEvening(median)))), nights: values.length };
}

/** Records tonight's last active minute (only night minutes count); keeps the newest `keepNights` nights. Returns a new object or the same. */
export function noteNightActivity(nights: BedNights, tonight: string, localMinute: number, knobs: MomentKnobs = MOMENT_KNOBS): BedNights {
  if (!isNightMinute(localMinute)) return nights;
  const e = eveningMinute(localMinute);
  if ((nights[tonight] ?? -1) >= e) return nights;
  const next: Record<string, number> = { ...nights, [tonight]: e };
  const keys = Object.keys(next).sort();
  while (keys.length > Math.max(1, knobs.lateNight.keepNights)) delete next[keys.shift()!];
  return next;
}

/**
 * Is it a late night now? The user is active, it is at least `marginMinutes` past the usual bedtime and not yet morning (`lastMinute`).
 * Returns the facts for her prompt, or null.
 */
export function lateNight(input: { localMinute: number; active: boolean; bed: { minute: number; nights: number } }, knobs: MomentKnobs = MOMENT_KNOBS):
  { bedMinute: number; nowMinute: number; nights: number } | null {
  if (!input.active || !Number.isFinite(input.localMinute)) return null;
  const now = fromEvening(eveningMinute(input.localMinute));
  if (now > knobs.lateNight.lastMinute || now < input.bed.minute + knobs.lateNight.marginMinutes) return null;
  return { bedMinute: input.bed.minute, nowMinute: now, nights: input.bed.nights };
}

/** "HH:MM" for minutes from midnight (negative = the evening before). */
export function clockWords(minute: number): string {
  const m = ((Math.round(minute) % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
