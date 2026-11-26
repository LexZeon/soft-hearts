// 给你留点东西 (I-050 她的文件夹，第 2 步): dates she knows, when she prepares something for a special day, how far apart her own
// keepsakes are, and the small ledger that keeps "once per date per year". Pure: no disk, no model, no clock of its own.
// docs/claude/2026-11-08-i050-her-folder.md (第 2 步).
import type { MoodTendency } from '../foundation/mood';
import { KEEPSAKE_KNOBS } from "../initiative";
export { KEEPSAKE_KNOBS };


export type SpecialKind = 'birthday' | 'anniversary';
export interface SpecialDate { kind: SpecialKind; month: number; day: number; label: string }

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validDay = (month: number, day: number) => Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];

// Only what the user told her (a profile entry: their own words, or typed by them in the profile). Someone else's birthday is not theirs.
const OTHERS = /朋友|同事|同学|妈|爸|家人|孩子|女儿|儿子|老婆|老公|对象|别人|他|她们|他们|friend|mom|dad/iu;
const MD = '(0?[1-9]|1[0-2])月(0?[1-9]|[12]\\d|3[01])[日号]';
const BIRTHDAY = [new RegExp(`生日[^0-9\\n]{0,6}${MD}`, 'u'), new RegExp(`${MD}[^，。；;\\n]{0,4}生日`, 'u')];
const ANNIVERSARY = [new RegExp(`(?:纪念日|周年)[^0-9\\n]{0,8}${MD}`, 'u'), new RegExp(`${MD}[^，。；;\\n]{0,6}(?:纪念日|周年)`, 'u')];

/** Dates the user told her, from the profile's entry texts. Never a guess: a text without a clear month-and-day yields nothing. */
export function parseSpecialDates(texts: readonly string[] | null | undefined): SpecialDate[] {
  const found = new Map<string, SpecialDate>();
  for (const raw of (texts ?? []).slice(0, 400)) {
    if (typeof raw !== 'string' || raw.length > 400 || OTHERS.test(raw)) continue;
    for (const [kind, patterns, label] of [['birthday', BIRTHDAY, '生日'], ['anniversary', ANNIVERSARY, '纪念日']] as const) {
      for (const pattern of patterns) {
        const match = pattern.exec(raw);
        if (!match) continue;
        const month = Number(match[1]), day = Number(match[2]);
        if (!validDay(month, day)) continue;
        found.set(`${kind}-${month}-${day}`, { kind, month, day, label });
        break;
      }
    }
  }
  return [...found.values()];
}

export const specialKey = (date: Pick<SpecialDate, 'kind' | 'month' | 'day'>): string =>
  `${date.kind}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;

/** Days from today (local) to the next time this month and day come around: 0 = today. `year` is the year it falls in. Feb 29 is Feb 28 in other years. */
export function daysUntil(now: number, month: number, day: number): { days: number; year: number } {
  const today = new Date(now), y = today.getFullYear();
  const start = new Date(y, today.getMonth(), today.getDate()).getTime();
  const on = (year: number) => {
    const leap = new Date(year, 1, 29).getMonth() === 1;
    return new Date(year, month - 1, month === 2 && day === 29 && !leap ? 28 : day).getTime();
  };
  let year = y, at = on(year);
  if (at < start) { year = y + 1; at = on(year); }
  return { days: Math.round((at - start) / 86_400_000), year };
}

/** The local midnight that ends the day after the date (the last moment the special-day line may still be said). */
export function tellDeadline(now: number, daysAhead: number): number {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAhead + 2).getTime();
}
export function startOfDay(now: number, daysAhead = 0): number {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAhead).getTime();
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** How many days before the date she starts preparing: fixed per character, date and year (so it does not wobble from tick to tick). */
export function leadDaysFor(characterId: string, key: string, year: number, knobs = KEEPSAKE_KNOBS): number {
  const { min, max } = knobs.prepLeadDays;
  return min + (hash(`${characterId}|${key}|${year}`) % (Math.max(min, max) - min + 1));
}

export const ledgerKey = (characterId: string, key: string, year: number): string => `${characterId}|${key}|${year}`;

/** The pending light line about something she left (one per character). */
export interface PendingTell { id: string; text: string; from: number; until: number; kind: 'special' | 'mention'; ledger: string | null }

export interface SpecialRecord { attempts: number; lastAttemptAt: number; done: boolean; file?: string; told: boolean }
export interface CharacterKeepsakes { nextAt: number | null; lastForm: string | null; special: number; occasional: number; tell: PendingTell | null }
export interface KeepsakeLedger { v: 1; specials: Record<string, SpecialRecord>; characters: Record<string, CharacterKeepsakes> }

export const emptyLedger = (): KeepsakeLedger => ({ v: 1, specials: {}, characters: {} });
export const emptyCharacter = (): CharacterKeepsakes => ({ nextAt: null, lastForm: null, special: 0, occasional: 0, tell: null });

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A ledger read back from disk, with anything odd dropped (a bad file is an empty ledger, which only means she may prepare again). */
export function readLedger(raw: unknown, now: number): KeepsakeLedger {
  const out = emptyLedger();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const data = raw as Record<string, unknown>;
  const year = new Date(now).getFullYear();
  if (data.specials && typeof data.specials === 'object') {
    for (const [key, value] of Object.entries(data.specials as Record<string, unknown>).slice(0, 200)) {
      const v = value as Partial<SpecialRecord> | null;
      const keyYear = Number(key.split('|').at(-1));
      if (!v || typeof v !== 'object' || !Number.isInteger(keyYear) || keyYear < year - 2 || keyYear > year + 1) continue;
      out.specials[key] = { attempts: finite(v.attempts) ? Math.max(0, Math.min(9, v.attempts)) : 0, lastAttemptAt: finite(v.lastAttemptAt) ? v.lastAttemptAt : 0,
        done: v.done === true, ...(typeof v.file === 'string' && v.file.length <= 200 ? { file: v.file } : {}), told: v.told === true };
    }
  }
  if (data.characters && typeof data.characters === 'object') {
    for (const [id, value] of Object.entries(data.characters as Record<string, unknown>).slice(0, 64)) {
      const v = value as Partial<CharacterKeepsakes> | null;
      if (!v || typeof v !== 'object') continue;
      const tell = v.tell as Partial<PendingTell> | null | undefined;
      out.characters[id] = {
        nextAt: finite(v.nextAt) ? v.nextAt : null, lastForm: typeof v.lastForm === 'string' ? v.lastForm.slice(0, 40) : null,
        special: finite(v.special) ? Math.max(0, v.special) : 0, occasional: finite(v.occasional) ? Math.max(0, v.occasional) : 0,
        tell: tell && typeof tell.id === 'string' && typeof tell.text === 'string' && finite(tell.from) && finite(tell.until) && (tell.kind === 'special' || tell.kind === 'mention')
          ? { id: tell.id, text: tell.text, from: tell.from, until: tell.until, kind: tell.kind, ledger: typeof tell.ledger === 'string' ? tell.ledger : null } : null,
      };
    }
  }
  return out;
}

/** What she writes this time, weighted by her character and not the same as the last time. */
export const KEEPSAKE_FORMS = Object.freeze([
  { id: 'poem', words: '一首很短的诗', weights: { close: 0.3, playful: 0.2 } },
  { id: 'letter', words: '一封短信', weights: { close: 0.8 } },
  { id: 'list', words: '一份小清单（比如你们之间的小事，或者想一起做的事）', weights: { playful: 0.6, comfortable: 0.2 } },
  { id: 'note', words: '几句随手记下的心里话', weights: { cautious: 0.6, comfortable: 0.3 } },
  { id: 'diary', words: '一小段她自己的日记', weights: { close: 0.3, cautious: 0.3 } },
] as const satisfies readonly { id: string; words: string; weights: Partial<Record<MoodTendency, number>> }[]);
export type KeepsakeForm = (typeof KEEPSAKE_FORMS)[number];

/** One weighted draw among the forms, never the one she made last time. `random` is read exactly once. */
export function drawForm(personality: Partial<Record<MoodTendency, number>> | null | undefined, last: string | null, random: () => number): KeepsakeForm {
  const weights = KEEPSAKE_FORMS.map(form => {
    let w = 1;
    for (const [trait, strength] of Object.entries(form.weights)) {
      const value = personality?.[trait as MoodTendency];
      w *= Math.min(3, Math.max(0.3, 1 + (strength as number) * 2 * ((finite(value) ? value : 1) - 1)));
    }
    return form.id === last ? 0 : w;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  const r = random(), roll = (finite(r) ? Math.min(0.999999, Math.max(0, r)) : 0) * (total || 1);
  let acc = 0;
  for (let i = 0; i < KEEPSAKE_FORMS.length; i++) { acc += weights[i]; if (weights[i] > 0 && roll < acc) return KEEPSAKE_FORMS[i]; }
  return KEEPSAKE_FORMS.find(form => form.id !== last) ?? KEEPSAKE_FORMS[0];
}

/** How long until her next own keepsake: a draw in the range, shorter for a clingy or playful card, longer when she is asked to talk less. */
export function drawGapMs(personality: Partial<Record<MoodTendency, number>> | null | undefined, talkScale: number, random: () => number, knobs = KEEPSAKE_KNOBS): number {
  const { min, max } = knobs.occasionalGapHours;
  const close = finite(personality?.close) ? personality!.close! : 1, playful = finite(personality?.playful) ? personality!.playful! : 1;
  const scale = Math.min(1.5, Math.max(0.6, 1 - 0.25 * (close - 1) - 0.15 * (playful - 1))) * (finite(talkScale) ? Math.max(0.5, talkScale) : 1);
  const r = random();
  return Math.round((min + (finite(r) ? Math.min(1, Math.max(0, r)) : 0) * (max - min)) * scale * 3_600_000);
}
