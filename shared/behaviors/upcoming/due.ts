// P-001: the user's own time words ("明天下午", "周五", "下周三", "15号", "3点") -> the moment she may ask how it went (the "due" time).
// Pure: no clock of its own (`at` is the time the words were said, the start of the chat segment), local calendar, no I/O.
//
// The rules (docs/claude/2026-11-05-p001-plans-plan.md section 3): only a day -> 18:00 that day; 上午 -> 12:00; 下午 -> 18:00; 晚上 -> the next
// morning; a clock time -> two hours after it. Words that name no moment ("过阵子", "以后", "改天") give null: nothing is recorded for them.
// The hours are knobs (knobs.ts); the grammar is not, it is just how the words are read.

import { UPCOMING_KNOBS, type UpcomingKnobs } from './knobs';

const CN_DIGIT: Readonly<Record<string, number>> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 一..九十九 written in Chinese numerals ("十二", "二十", "二十五", "三"); null when it is not one. */
function cnNumber(text: string): number | null {
  if (!text) return null;
  if (text === '十') return 10;
  const ten = text.indexOf('十');
  if (ten === -1) return text.length === 1 && text in CN_DIGIT ? CN_DIGIT[text] : null;
  const tens = ten === 0 ? 1 : CN_DIGIT[text.slice(0, ten)], ones = ten === text.length - 1 ? 0 : CN_DIGIT[text.slice(ten + 1)];
  if (tens === undefined || ones === undefined || text.length - ten > 2 || ten > 1) return null;
  return tens * 10 + ones;
}

/** Fold width, drop spaces, and write the numbers that matter as digits ("三点" -> "3点", "十五号" -> "15号"; "周五" stays). */
function normalize(text: string): string {
  const folded = text.normalize('NFKC').replace(/\s+/gu, '');
  return folded.replace(/(?<![周期拜])([零〇一二两三四五六七八九十]+)(?=[点时号日月:]|天后|周后|个?星期后|个?礼拜后|小时后|分钟后)/gu,
    (match, digits: string) => { const n = cnNumber(digits); return n === null ? match : String(n); });
}

const PAST = /昨|前天|上周|上个月|上星期|上礼拜|刚才|上次/u;
const WEEKDAY: Readonly<Record<string, number>> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };
const WD = '[一二三四五六日天1-7]';

type Period = 'morning' | 'noon' | 'afternoon' | 'night';
interface Parsed { day: Date | null; period: Period | null; clock: { hour: number; minute: number } | null; relativeMs: number | null }

const startOfDay = (ms: number): Date => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const addDays = (day: Date, n: number): Date => new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
const mondayIndex = (day: Date): number => (day.getDay() + 6) % 7;
/** A real calendar day (the 31st of a 30-day month is not one). */
const exists = (year: number, month: number, date: number): Date | null => { const d = new Date(year, month, date); return d.getMonth() === ((month % 12) + 12) % 12 && d.getDate() === date ? d : null; };

function parseDay(s: string, today: Date): Date | null {
  let m: RegExpExecArray | null;
  if (/大后天/u.test(s)) return addDays(today, 3);
  if (/后天/u.test(s)) return addDays(today, 2);
  if (/明天|明日|明早|明晚|明儿/u.test(s)) return addDays(today, 1);
  if ((m = /(\d{1,3})天后/u.exec(s))) return Number(m[1]) >= 1 && Number(m[1]) <= 60 ? addDays(today, Number(m[1])) : null;
  if ((m = /(\d{1,2})(?:个)?(?:周|星期|礼拜)后/u.exec(s))) return Number(m[1]) >= 1 && Number(m[1]) <= 8 ? addDays(today, 7 * Number(m[1])) : null;
  if ((m = new RegExp(`下(?:个|一个)?(?:周|星期|礼拜)(${WD})`, 'u').exec(s))) return addDays(today, 7 - mondayIndex(today) + WEEKDAY[m[1]]);
  if ((m = new RegExp(`(?:这|本)(?:个)?(?:周|星期|礼拜)(${WD})`, 'u').exec(s))) {
    const delta = WEEKDAY[m[1]] - mondayIndex(today);
    return delta >= 0 ? addDays(today, delta) : null;
  }
  if ((m = new RegExp(`(?:周|星期|礼拜)(${WD})`, 'u').exec(s))) {
    let delta = WEEKDAY[m[1]] - mondayIndex(today);
    if (delta <= 0) delta += 7;
    return addDays(today, delta);
  }
  if (/今天|今日|今早|今晚|今儿|今夜/u.test(s)) return today;
  if ((m = /(?:下个月|下月)(\d{1,2})[号日]/u.exec(s))) return exists(today.getFullYear(), today.getMonth() + 1, Number(m[1]));
  if ((m = /(\d{1,2})月(\d{1,2})[号日]/u.exec(s))) {
    const month = Number(m[1]) - 1, date = Number(m[2]);
    const thisYear = exists(today.getFullYear(), month, date);
    if (month < 0 || month > 11) return null;
    if (thisYear && thisYear.getTime() >= today.getTime()) return thisYear;
    return exists(today.getFullYear() + 1, month, date);
  }
  if ((m = /(\d{1,2})[号日](?!线)/u.exec(s))) {
    const date = Number(m[1]);
    for (let k = 0; k <= 12; k++) {
      const found = exists(today.getFullYear(), today.getMonth() + k, date);
      if (found && found.getTime() >= today.getTime()) return found;
    }
  }
  return null;
}

function parseClock(s: string): { hour: number; minute: number; raw: number } | null {
  const m = /(\d{1,2})[:](\d{2})|(\d{1,2})点(?!点|儿)(半|整|(\d{1,2})分?)?/u.exec(s);
  if (!m) return null;
  const hour = Number(m[1] ?? m[3]);
  const minute = m[1] !== undefined ? Number(m[2]) : m[4] === '半' ? 30 : m[5] !== undefined ? Number(m[5]) : 0;
  if (!Number.isInteger(hour) || hour > 24 || minute > 59) return null;
  return { hour, minute, raw: hour };
}

function parsePeriod(s: string): Period | null {
  if (/上午|早上|早晨|清晨|明早|今早|早间|凌晨/u.test(s)) return 'morning';
  if (/中午/u.test(s)) return 'noon';
  if (/下午|午后/u.test(s)) return 'afternoon';
  if (/晚上|今晚|明晚|夜里|今夜|晚间/u.test(s)) return 'night';
  return null;
}

function parse(said: string, at: number): Parsed | null {
  if (typeof said !== 'string') return null;
  const s = normalize(said);
  if (!s || PAST.test(s)) return null;
  const today = startOfDay(at);
  const day = parseDay(s, today), period = parsePeriod(s), c = parseClock(s);
  let relativeMs: number | null = null;
  const rel = /(\d{1,3})(小时|分钟)后/u.exec(s);
  if (rel) relativeMs = Number(rel[1]) * (rel[2] === '小时' ? 3_600_000 : 60_000);
  if (!day && !period && !c && relativeMs === null) return null;
  let clock: Parsed['clock'] = null;
  if (c) {
    let hour = c.hour;
    if (period === 'afternoon' || period === 'night') { if (hour < 12) hour += 12; else if (hour === 12 && period === 'night') hour = 24; }
    else if (period === 'noon') { if (hour > 0 && hour < 11) hour += 12; }
    else if (period === null && hour >= 1 && hour <= 6) hour += 12;
    clock = { hour, minute: c.minute };
  }
  return { day, period, clock, relativeMs };
}

/**
 * When she may start asking about a plan the user described with `said`, said at `at`. null: the words do not name a moment.
 * Local calendar days; "weeks" start on Monday; a bare weekday is the next one (never today).
 */
export function resolveDue(said: string, at: number, knobs: UpcomingKnobs = UPCOMING_KNOBS): number | null {
  const parsed = parse(said, at);
  if (!parsed || !Number.isFinite(at)) return null;
  const { day, period, clock, relativeMs } = parsed;
  const today = startOfDay(at);
  const base = day ?? today;
  const at0 = (d: Date, hour: number, minute = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
  if (clock) {
    let moment = at0(base, clock.hour, clock.minute);
    if (!day && moment <= at) moment = at0(addDays(base, 1), clock.hour, clock.minute);
    return moment + knobs.due.clockDelayMinutes * 60_000;
  }
  if (relativeMs !== null && !day && !period) return at + relativeMs + knobs.due.clockDelayMinutes * 60_000;
  if (period) {
    if (period === 'night') return at0(addDays(base, 1), knobs.due.nightNextMorningHour);
    const hour = period === 'morning' ? knobs.due.morningHour : period === 'noon' ? knobs.due.noonHour : knobs.due.afternoonHour;
    let moment = at0(base, hour);
    if (!day && moment <= at) moment = at0(addDays(base, 1), hour);
    return moment;
  }
  return day ? at0(day, knobs.due.dayOnlyHour) : null;
}

/**
 * Whether a piece of the user's own text names a day or a clock time (a bare "晚上" does not count: "晚上好" is a greeting).
 * Used to let a very short marked chat segment still get a note, so that the plan in it can be noticed.
 */
export function hasTimeWord(text: string, at = 0): boolean {
  const parsed = parse(text, at);
  return !!parsed && (parsed.day !== null || parsed.clock !== null || parsed.relativeMs !== null);
}
