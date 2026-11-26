// I-188: the local recognisers that are not about bedtime (bedtime.ts): something on the screen while watching together (#9), coming
// out of a full-screen program (#18), the first meeting of the day (#2) and back at the seat (#3). Each answers "is this a moment now"
// from readings the app already has; none calls a model. Pure (FullscreenTracker keeps two numbers between calls).

import { eveningMinute, fromEvening, type BedNights } from './bedtime';
import type { ScreenEvent, ScreenMomentEvent } from './interface';
import { MOMENT_KNOBS, type MomentKnobs } from './knobs';

/**
 * #9: the frame describer's last event word while watching together, as a moment. `at`: when that frame was described; `describedAt`:
 * the newest description of any frame. A loading frame becomes 'stuck' when it stays the newest for `stuckSeconds` (the screen did not
 * change enough to be described again); every other event counts while it is younger than `youngSeconds`.
 */
export function screenMoment(read: { event: ScreenEvent; at: number; describedAt: number } | null, now: number, knobs: MomentKnobs = MOMENT_KNOBS):
  { event: ScreenMomentEvent; at: number } | null {
  if (!read || !Number.isFinite(read.at) || read.at > now) return null;
  const age = now - read.at, young = knobs.screen.youngSeconds * 1000, stuck = knobs.screen.stuckSeconds * 1000;
  if (read.event === 'loading') return read.describedAt <= read.at && age >= stuck && age <= stuck + young ? { event: 'stuck', at: read.at } : null;
  return age <= young ? { event: read.event, at: read.at } : null;
}

/**
 * #18: follows Unbound's "a full-screen program is in front" reading. `update` answers the minutes it was in front when it just ended
 * (and lasted at least `minMinutes`) while she is still out in Unbound; null otherwise. Leaving Unbound forgets it.
 */
export class FullscreenTracker {
  private since: number | null = null;
  constructor(private readonly knobs: MomentKnobs = MOMENT_KNOBS) {}
  update(reading: { unbound: boolean; fullscreen: boolean } | null, now: number): number | null {
    if (!reading || !reading.unbound || !Number.isFinite(now)) { this.since = null; return null; }
    if (reading.fullscreen) { this.since ??= now; return null; }
    if (this.since === null) return null;
    const minutes = (now - this.since) / 60_000;
    this.since = null;
    return minutes >= this.knobs.fullscreen.minMinutes ? minutes : null;
  }
  get inFront(): boolean { return this.since !== null; }
}

/** The local day for "today's first meeting": a day starts at `dayStartMinute` (05:00), named by its date. */
export function momentDayKey(wallMs: number, localMinute: number, knobs: MomentKnobs = MOMENT_KNOBS): string {
  const shift = ((Math.floor(localMinute) - knobs.firstToday.dayStartMinute) % 1440 + 1440) % 1440;
  const day = new Date(wallMs - shift * 60_000);
  return `${String(day.getFullYear()).padStart(4, '0')}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/**
 * #2: the first time she sees the user today: back after at least `awayHours` (the presence judgment's 'back'), or active now with no
 * interaction for that long (the app was just started). Facts: minutes away, a weekend, and whether last night ran past the usual bedtime.
 */
export function firstToday(input: { back: number | null; active: boolean; lastInteractionAt: number | null; now: number; weekday: number;
  lastNight: string; nights: BedNights; bedMinute: number }, knobs: MomentKnobs = MOMENT_KNOBS): { awayMinutes: number; weekend: boolean; lateLastNight: boolean } | null {
  const need = knobs.firstToday.awayHours * 60;
  const sinceTalk = input.lastInteractionAt === null || !Number.isFinite(input.lastInteractionAt) ? Infinity : (input.now - input.lastInteractionAt) / 60_000;
  const away = input.back !== null && input.back >= need ? input.back : input.active && sinceTalk >= need ? sinceTalk : null;
  if (away === null) return null;
  const last = input.nights[input.lastNight];
  const lateLastNight = typeof last === 'number' && fromEvening(last) >= input.bedMinute + 60;
  return { awayMinutes: Number.isFinite(away) ? Math.round(away) : need, weekend: input.weekday === 0 || input.weekday === 6, lateLastNight };
}

/** #3: back at the seat after a short absence (between fromMinutes and toMinutes; longer ones are the old "你回来了" greeting's). */
export function backAtSeat(backMinutes: number | null, knobs: MomentKnobs = MOMENT_KNOBS): boolean {
  return backMinutes !== null && Number.isFinite(backMinutes) && backMinutes >= knobs.back.fromMinutes && backMinutes < knobs.back.toMinutes;
}

/** The night key of the night before a day (the noon-to-noon key of the previous evening). */
export function previousEveningKey(wallMs: number, localMinute: number): string {
  const e = eveningMinute(localMinute);
  const d = new Date(wallMs - e * 60_000 - 24 * 3_600_000);
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
