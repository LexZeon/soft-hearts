/** Local calendar days ("YYYY-MM-DD" in the machine's own time zone). One diary entry per day. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localDateKey(ms: number): string {
  const day = new Date(ms);
  if (!Number.isFinite(day.getTime())) throw Error('日记日期不正确。');
  return `${String(day.getFullYear()).padStart(4, '0')}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateKey(day.getTime()) === value;
}

function parts(date: string): [number, number, number] {
  if (!isDateKey(date)) throw Error('日记日期不正确。');
  const [, year, month, day] = DATE.exec(date)!;
  return [Number(year), Number(month) - 1, Number(day)];
}

/** Calendar arithmetic, so a daylight-saving day is still exactly one date step. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = parts(date);
  return localDateKey(new Date(year, month, day + days).getTime());
}

/** [start, end) in epoch milliseconds for one local day. */
export function localDayRange(date: string): { start: number; end: number } {
  const [year, month, day] = parts(date);
  return { start: new Date(year, month, day).getTime(), end: new Date(year, month, day + 1).getTime() };
}

/** The `days` whole days before `today`, newest first (yesterday, the day before, ...). Today is never included. */
export function recentDiaryDates(today: string, days: number): string[] {
  return Array.from({ length: Math.max(0, Math.floor(days)) }, (_, index) => shiftDate(today, -(index + 1)));
}
