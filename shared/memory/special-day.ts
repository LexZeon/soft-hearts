// I-059: on a day the user told her about (their birthday, an anniversary) she may say something herself, also when
// 「她的文件夹」 is off. Pure helpers only: which date is today, the one private line, the local word check, the small per-day record.
// Dates come from the same source as I-050 (shared/memory/keepsake.ts parseSpecialDates over the profile's entries while 「允许记录」 is on); no guessing.
// docs/claude/2026-11-10-i059-special-day.md.
import { daysUntil, parseSpecialDates, type SpecialDate, type SpecialKind } from './keepsake';
import type { CardLanguage } from '../foundation/character-card';

export type { SpecialKind };

/**
 * Fallbacks, not a rhythm (the handbook's 「少一点程序感」): the quiet hours are tact (nobody wants a birthday line at 3 a.m.), the
 * chance cap only stops a topic she judged unfitting from coming back every turn (the same reasoning as I-056).
 */
export const SPECIAL_DAY_LIMITS = Object.freeze({
  /** Local hours [0, 6) are the night: no hint and no line of her own. */
  quietUntilHour: 6,
  /** The first daytime turn plus at most two more, until her shown reply touches the day. */
  maxHints: 3,
  /** The one line she says by herself is at most this long (it is hers to write; this only cuts a runaway). */
  lineMaxChars: 40,
  /** I-071: the same cut for a line she writes in English (a short English sentence is about twice the characters of a Chinese one). */
  lineMaxCharsEn: 100,
});

/** Closed journal values (shared/memory/journal.ts): who brought the day up first, and what happened to the day. */
export const SPECIAL_DAY_EVENTS = ['hinted', 'said', 'expired', 'user-first'] as const;
export type SpecialDayEvent = (typeof SPECIAL_DAY_EVENTS)[number];
export const SPECIAL_DAY_FIRST = ['her', 'user'] as const;
export type SpecialDayFirst = (typeof SPECIAL_DAY_FIRST)[number];
export const SPECIAL_DAY_KINDS = ['birthday', 'anniversary'] as const;

export const isQuietHour = (now: number): boolean => new Date(now).getHours() < SPECIAL_DAY_LIMITS.quietUntilHour;

/** Local calendar day, "2026-11-10". */
export function dayStamp(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The dates the user told her that fall on today (local). `texts` null = recording is off: nothing. `pretend` is the developer test
 * command's made-up day; it only ever adds one when recording is on (the same switch).
 */
export function datesToday(now: number, texts: readonly string[] | null | undefined, pretend?: SpecialKind | null): SpecialDate[] {
  if (texts === null || texts === undefined) return [];
  const out = parseSpecialDates(texts).filter(date => daysUntil(now, date.month, date.day).days === 0);
  if (pretend && !out.some(date => date.kind === pretend)) {
    const today = new Date(now);
    out.push({ kind: pretend, month: today.getMonth() + 1, day: today.getDate(), label: pretend === 'birthday' ? '生日' : '纪念日' });
  }
  return out;
}

/**
 * The one private line for the first daytime turn (data for her, not shown). A plain line like I-056's: no block, no marker.
 * 2026-11-10 (I-064 card K11): the first wording ("这一轮可选……也别硬凑") let a small model skip the day for two turns in a row;
 * the day itself is now the point of the turn, the words and the manner stay hers.
 */
export function specialDayHintLine(kind: SpecialKind, language: CardLanguage = 'zh-CN'): string {
  if (language === 'en') return kind === 'birthday'
    ? "Today is the user's birthday (they told you themselves). This turn, bring it up in your own way: wish them a happy birthday, or work it into what you are talking about. Do not mention \"records\" or \"reminders\". Only if the user is clearly in a bad mood right now, keep them company first and say it a little later."
    : "Today is your anniversary (the user told you about it). This turn, bring it up in your own way: say something about the day, or work it into what you are talking about. Do not mention \"records\" or \"reminders\". Only if the user is clearly in a bad mood right now, keep them company first and say it a little later.";
  return kind === 'birthday'
    ? '今天是用户的生日（他自己告诉过你）。这一轮用你自己的方式提到它，祝他生日快乐，或者顺着话题说起；别提“记录”或“提醒”。只有用户此刻心情明显很差时，才先陪着他，晚点再说。'
    : '今天是你们的纪念日（用户告诉过你）。这一轮用你自己的方式提到它，说说这一天，或者顺着话题说起；别提“记录”或“提醒”。只有用户此刻心情明显很差时，才先陪着他，晚点再说。';
}

const WORDS: Record<SpecialKind, RegExp> = {
  birthday: /生日|生辰|birthday/iu,
  anniversary: /纪念日|周年|anniversary/iu,
};
/** A small local check: does this text (her shown reply, or the user's message) speak of the day? Not a judgment of how well. */
export const mentionsDay = (kind: SpecialKind, text: unknown): boolean => typeof text === 'string' && WORDS[kind].test(text);

/** One record per character per local day. Flags and counts only: nothing the user or she said. */
export interface SpecialDayRecord {
  kind: SpecialKind;
  /** How many turns carried the line. */
  hints: number;
  /** The user has talked to her in the daytime of this day (so she no longer opens the day herself). */
  spoke: boolean;
  /** Done: her shown line touched the day, or the chances ran out, or the user said it first. */
  done: boolean;
  first: SpecialDayFirst | null;
  /** The 'expired' line was written (so it is written once). */
  closed: boolean;
}
export interface SpecialDayBook { v: 1; records: Record<string, SpecialDayRecord> }
export const emptyBook = (): SpecialDayBook => ({ v: 1, records: {} });
export const recordKey = (characterId: string, day: string): string => `${characterId}|${day}`;
export const freshRecord = (kind: SpecialKind): SpecialDayRecord => ({ kind, hints: 0, spoke: false, done: false, first: null, closed: false });

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const KEEP_DAYS = 4;

/** Read back from disk: anything odd is dropped (an empty book only means a hint may come again today). Old days are pruned. */
export function readBook(raw: unknown, now: number): SpecialDayBook {
  const out = emptyBook();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const records = (raw as Record<string, unknown>).records;
  if (!records || typeof records !== 'object' || Array.isArray(records)) return out;
  const oldest = dayStamp(now - KEEP_DAYS * 86_400_000);
  for (const [key, value] of Object.entries(records as Record<string, unknown>).slice(0, 200)) {
    const day = key.split('|').at(-1) ?? '';
    if (!DAY.test(day) || day < oldest || !value || typeof value !== 'object') continue;
    const v = value as Partial<SpecialDayRecord>;
    if (v.kind !== 'birthday' && v.kind !== 'anniversary') continue;
    out.records[key] = {
      kind: v.kind, hints: typeof v.hints === 'number' && Number.isInteger(v.hints) ? Math.max(0, Math.min(SPECIAL_DAY_LIMITS.maxHints, v.hints)) : 0,
      spoke: v.spoke === true, done: v.done === true, first: v.first === 'her' || v.first === 'user' ? v.first : null, closed: v.closed === true,
    };
  }
  return out;
}

/** The line she writes herself on the day, cleaned: one line, no quotes or markup, short. '' = unusable. */
export function cleanSpokenLine(raw: unknown, language: CardLanguage = 'zh-CN'): string {
  if (typeof raw !== 'string') return '';
  const line = raw.replace(/\r/gu, '').split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
  const text = line.replace(/^["“”'「『（(]+|["“”'」』）)]+$/gu, '').trim();
  if (!text || [...text].length > (language === 'en' ? SPECIAL_DAY_LIMITS.lineMaxCharsEn : SPECIAL_DAY_LIMITS.lineMaxChars)) return '';
  if (/[<>{}\\]|https?:|[A-Za-z]:[\\/]/u.test(text)) return '';
  return text;
}
