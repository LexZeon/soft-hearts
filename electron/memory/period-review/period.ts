// I-088 第 1 条 她的"这阵子"回顾: the calendar of the look-backs. A week is Monday to Sunday and a month is a calendar month, both in
// the machine's own time zone, named by dates ("2026-11-03" is the week that starts on that Monday, "2026-10" is October). Every step
// is calendar arithmetic (never "now minus n x 24 hours", which repeats or skips a day around a daylight-saving change).
import { isDateKey, localDayRange, shiftDate } from '../diary/diary-dates';

export type ReviewKind = 'week' | 'month';

const MONTH = /^(\d{4})-(\d{2})$/;

/** The Monday of the week this date is in. */
export function weekStartOf(date: string): string {
  if (!isDateKey(date)) throw Error('回顾日期不正确。');
  const [year, month, day] = date.split('-').map(Number);
  const dow = new Date(year!, month! - 1, day!).getDay(); // 0 = Sunday
  return shiftDate(date, -((dow + 6) % 7));
}
export function isWeekKey(value: unknown): value is string {
  return typeof value === 'string' && isDateKey(value) && weekStartOf(value) === value;
}
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MONTH.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[1]) >= 1000;
}
export function isPeriodKey(kind: ReviewKind, key: unknown): key is string { return kind === 'week' ? isWeekKey(key) : isMonthKey(key); }

/** The seven dates of a week, Monday first. */
export function weekDates(start: string): string[] { return Array.from({ length: 7 }, (_, index) => shiftDate(start, index)); }
/** [start, end) of a week in epoch milliseconds (calendar steps, so a 23- or 25-hour day does not shift the edge). */
export function weekRange(start: string): { start: number; end: number } {
  return { start: localDayRange(start).start, end: localDayRange(shiftDate(start, 6)).end };
}
/** A week is over when its Sunday is before today (the next Monday has begun). */
export function weekIsOver(start: string, today: string): boolean { return today >= shiftDate(start, 7); }
/** The `count` most recent finished weeks, newest first (the week before the one `today` is in, and so on). */
export function finishedWeeks(today: string, count: number): string[] {
  const current = weekStartOf(today);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => shiftDate(current, -7 * (index + 1)));
}

export function monthOf(date: string): string {
  if (!isDateKey(date)) throw Error('回顾日期不正确。');
  return date.slice(0, 7);
}
export function monthFirst(key: string): string { return `${key}-01`; }
export function shiftMonth(key: string, months: number): string {
  const [year, month] = key.split('-').map(Number);
  const at = new Date(year!, month! - 1 + months, 1);
  return `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}`;
}
export function monthLast(key: string): string { return shiftDate(monthFirst(shiftMonth(key, 1)), -1); }
/** [start, end) of a month in epoch milliseconds. */
export function monthRange(key: string): { start: number; end: number } {
  return { start: localDayRange(monthFirst(key)).start, end: localDayRange(monthFirst(shiftMonth(key, 1))).start };
}
/** The weeks that belong to a month: those whose Monday is in it (a week that straddles two months goes to the first). Oldest first. */
export function weeksOfMonth(key: string): string[] {
  const out: string[] = [];
  for (let at = weekStartOf(monthLast(key)); at >= monthFirst(key); at = shiftDate(at, -7)) out.unshift(at);
  return out;
}
/**
 * A month is written once every week that belongs to it is over (its last Monday's week has ended), so the weekly look-backs it is
 * made from can all exist: a month that ends on a Wednesday is written the following Monday, not on the 1st.
 */
export function monthIsReady(key: string, today: string): boolean {
  const weeks = weeksOfMonth(key);
  const last = weeks[weeks.length - 1];
  return !!last && weekIsOver(last, today);
}
/** The most recent finished month that is ready to write, or null (one month only: older ones are not caught up). */
export function readyMonth(today: string): string | null {
  const key = shiftMonth(monthOf(today), -1);
  return monthIsReady(key, today) ? key : null;
}

/** "11-03" for a date key. */
export const shortDate = (date: string): string => date.slice(5);
