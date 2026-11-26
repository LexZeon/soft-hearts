// I-088 第 1 条 她的"这阵子"回顾: the data of her weekly and monthly look-backs (docs/claude/2026-11-12-i088-period-review.md), pure: no
// file, clock or model here. One file per character and connection holds them (store.ts); everything below is the rules for what
// that file may contain and how it changes.
import { diaryText } from '../diary/diary-data';
import { finishedWeeks, isPeriodKey, readyMonth, type ReviewKind } from './period';

/** A written look-back. `carry` (weeks only) is the one short line she keeps for the month; `words` are what it names, for local finding. */
export interface ReviewEntry { kind: ReviewKind; key: string; text: string; carry?: string; words: string[]; writtenAt: number; editedAt?: number }
/** Answers that could not be used, per period (a failed call is not counted: it is asked again later without limit). */
export interface ReviewTry { id: string; count: number }
/** The new week's first conversation was decided once (the mention is not every time): which week, and whether she was given a line. */
export interface ReviewOpening { week: string; shown: boolean }
export interface ReviewData { items: ReviewEntry[]; blocked: string[]; tries: ReviewTry[]; opening: ReviewOpening | null }
/** What the panel shows: no words, no carried line. */
export interface ReviewShown { kind: ReviewKind; key: string; text: string; writtenAt: number; editedAt?: number }

export const REVIEW_LIMITS = Object.freeze({
  /** About two years of weeks and three years of months; when full the writer stops instead of silently deleting old ones. */
  weeks: 120,
  months: 36,
  blocked: 400,
  tries: 32,
  /** Asked for ≤200 / ≤300 characters; these are the hard caps for a Chinese card. An English card says about 2.5 times as many characters. */
  weekChars: 320,
  monthChars: 480,
  englishScale: 2.5,
  /** What a stored look-back may hold (the user's own edit; a conversion's English text). */
  editedChars: 1200,
  carryChars: 60,
  carryStoredChars: 200,
  words: 8,
  wordChars: 16,
  wordStoredChars: 40,
  /** First try plus two retries of an answer that could not be used; then that period stays unwritten. */
  attemptsPerPeriod: 3,
  /** Newest finished weeks that are still caught up; older ones are not (a first run must not cost a call per old week). */
  backfillWeeks: 2,
  /** Enough to write about: a week needs this many diary days or this many chat notes; a month needs two weekly look-backs, or this many diary days. */
  minDiaryDays: 2,
  minNotes: 3,
  minWeeklies: 2,
  monthDiaryDays: 6,
  materialChars: 4000,
  /** The one thing she may mention at a new week's first conversation (a sentence of last week's look-back). */
  openingChars: 120,
});

export const reviewId = (kind: ReviewKind, key: string): string => `${kind}:${key}`;
export const emptyReview = (): ReviewData => ({ items: [], blocked: [], tries: [], opening: null });

const length = (value: string) => Array.from(value).length;
const KINDS: readonly string[] = ['week', 'month'];

function plain(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) throw Error('回顾数据格式不正确。');
}
const whole = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error('回顾时间不正确。');
  return value as number;
};

/** The words a look-back keeps for finding it: bounded, plain, and each one really in the text. */
export function reviewWords(value: unknown, text: string, limit: number = REVIEW_LIMITS.wordChars): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const word = diaryText(item, limit);
    if (word && !/[<>]/u.test(word) && length(word) >= 2 && text.includes(word) && !out.includes(word)) out.push(word);
    if (out.length >= REVIEW_LIMITS.words) break;
  }
  return out;
}

/** Throws on anything the store must not accept from disk. */
export function validateReviewData(value: unknown): ReviewData {
  plain(value, ['items', 'blocked', 'tries', 'opening']);
  const { items, blocked, tries, opening } = value;
  if (!Array.isArray(items) || !Array.isArray(blocked) || !Array.isArray(tries) || blocked.length > REVIEW_LIMITS.blocked || tries.length > REVIEW_LIMITS.tries) throw Error('回顾数据格式不正确。');
  const seen = new Set<string>(), counts = { week: 0, month: 0 };
  for (const item of items) {
    plain(item, ['kind', 'key', 'text', 'carry', 'words', 'writtenAt', 'editedAt']);
    if (!KINDS.includes(item.kind as string) || !isPeriodKey(item.kind as ReviewKind, item.key)) throw Error('回顾条目不正确。');
    const kind = item.kind as ReviewKind, id = reviewId(kind, item.key as string);
    if (seen.has(id) || diaryText(item.text, REVIEW_LIMITS.editedChars) !== item.text) throw Error('回顾条目不正确。');
    if (item.carry !== undefined && (kind !== 'week' || diaryText(item.carry, REVIEW_LIMITS.carryStoredChars) !== item.carry)) throw Error('回顾条目不正确。');
    if (!Array.isArray(item.words) || item.words.length > REVIEW_LIMITS.words
      || item.words.some(word => diaryText(word, REVIEW_LIMITS.wordStoredChars) !== word || /[<>]/u.test(word as string))) throw Error('回顾条目不正确。');
    whole(item.writtenAt); if (item.editedAt !== undefined) whole(item.editedAt);
    seen.add(id); counts[kind]++;
  }
  if (counts.week > REVIEW_LIMITS.weeks || counts.month > REVIEW_LIMITS.months) throw Error('回顾数据太多。');
  const marked = new Set<string>();
  for (const id of blocked) {
    const [kind, key] = typeof id === 'string' ? id.split(':') : [];
    if (!KINDS.includes(kind as string) || !isPeriodKey(kind as ReviewKind, key) || seen.has(id as string) || marked.has(id as string)) throw Error('回顾删除记录不正确。');
    marked.add(id as string);
  }
  const tried = new Set<string>();
  for (const entry of tries) {
    plain(entry, ['id', 'count']);
    const [kind, key] = typeof entry.id === 'string' ? entry.id.split(':') : [];
    if (!KINDS.includes(kind as string) || !isPeriodKey(kind as ReviewKind, key) || tried.has(entry.id as string)
      || !Number.isSafeInteger(entry.count) || (entry.count as number) < 1 || (entry.count as number) > REVIEW_LIMITS.attemptsPerPeriod) throw Error('回顾尝试记录不正确。');
    tried.add(entry.id as string);
  }
  if (opening !== null) {
    plain(opening, ['week', 'shown']);
    if (!isPeriodKey('week', opening.week) || typeof opening.shown !== 'boolean') throw Error('回顾开头记录不正确。');
  }
  return structuredClone(value) as unknown as ReviewData;
}

/** Null when nothing needs keeping (the file is then deleted); entries oldest first so the file reads like a record. */
export function compactReview(state: ReviewData): ReviewData | null {
  const items = [...state.items].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  const blocked = [...new Set(state.blocked)].sort();
  while (blocked.length > REVIEW_LIMITS.blocked) blocked.shift();
  const tries = [...state.tries];
  while (tries.length > REVIEW_LIMITS.tries) tries.shift();
  if (!items.length && !blocked.length && !tries.length && !state.opening) return null;
  return { items, blocked, tries, opening: state.opening ? { ...state.opening } : null };
}

const count = (state: ReviewData, kind: ReviewKind) => state.items.filter(item => item.kind === kind).length;
const full = (state: ReviewData, kind: ReviewKind) => count(state, kind) >= (kind === 'week' ? REVIEW_LIMITS.weeks : REVIEW_LIMITS.months);

/** Still to write: no look-back, never deleted, attempts left, room in the store. */
export function isDue(state: ReviewData, kind: ReviewKind, key: string): boolean {
  const id = reviewId(kind, key);
  return isPeriodKey(kind, key) && !full(state, kind) && !state.items.some(item => item.kind === kind && item.key === key) && !state.blocked.includes(id)
    && (state.tries.find(entry => entry.id === id)?.count ?? 0) < REVIEW_LIMITS.attemptsPerPeriod;
}
/** The finished weeks still to write, oldest first (so the month sees them in order). */
export function dueWeeks(state: ReviewData, today: string): string[] {
  return finishedWeeks(today, REVIEW_LIMITS.backfillWeeks).filter(key => isDue(state, 'week', key)).reverse();
}
/** The last finished month, when it is ready and still to write. */
export function dueMonth(state: ReviewData, today: string): string | null {
  const key = readyMonth(today);
  return key && isDue(state, 'month', key) ? key : null;
}

export function withTry(state: ReviewData, kind: ReviewKind, key: string): ReviewData {
  const id = reviewId(kind, key), previous = state.tries.find(entry => entry.id === id)?.count ?? 0;
  const tries = state.tries.filter(entry => entry.id !== id);
  tries.push({ id, count: Math.min(REVIEW_LIMITS.attemptsPerPeriod, previous + 1) });
  while (tries.length > REVIEW_LIMITS.tries) tries.shift();
  return { ...state, tries };
}

/** Null when the period already has one (written or edited), was deleted, or the store is full: the result is then not written. */
export function withWritten(state: ReviewData, entry: ReviewEntry): ReviewData | null {
  if (!isDue({ ...state, tries: [] }, entry.kind, entry.key)) return null;
  const id = reviewId(entry.kind, entry.key);
  return { ...state, items: [...state.items, structuredClone(entry)], tries: state.tries.filter(item => item.id !== id) };
}

/** The user's own edit: kept as written, never rewritten; words that the new text no longer holds go. */
export function withEdited(state: ReviewData, kind: ReviewKind, key: string, text: string, at: number): ReviewData {
  const index = state.items.findIndex(item => item.kind === kind && item.key === key);
  if (index < 0) throw Error('这段回顾已不存在。');
  const items = structuredClone(state.items);
  items[index] = { ...items[index]!, text, words: items[index]!.words.filter(word => text.includes(word)), editedAt: at };
  return { ...state, items };
}

/** The deleted period is remembered so it is never written again. */
export function withoutReview(state: ReviewData, kind: ReviewKind, key: string): ReviewData {
  if (!state.items.some(item => item.kind === kind && item.key === key)) throw Error('这段回顾已不存在。');
  const id = reviewId(kind, key);
  return { ...state, items: state.items.filter(item => !(item.kind === kind && item.key === key)), blocked: [...new Set([...state.blocked, id])],
    tries: state.tries.filter(entry => entry.id !== id) };
}

/** Months first, then weeks, each newest first. */
export function shownReviews(state: ReviewData | undefined): ReviewShown[] {
  return [...(state?.items ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || b.key.localeCompare(a.key))
    .map(({ kind, key, text, writtenAt, editedAt }) => ({ kind, key, text, writtenAt, ...(editedAt !== undefined ? { editedAt } : {}) }));
}

/** The writing caps for a card's language (a character cap counts characters; English needs about 2.5 times as many). */
export function writtenCap(kind: ReviewKind, english: boolean): number {
  const base = kind === 'week' ? REVIEW_LIMITS.weekChars : REVIEW_LIMITS.monthChars;
  return Math.min(REVIEW_LIMITS.editedChars, english ? Math.round(base * REVIEW_LIMITS.englishScale) : base);
}
export function carryCap(english: boolean): number {
  return Math.min(REVIEW_LIMITS.carryStoredChars, english ? Math.round(REVIEW_LIMITS.carryChars * REVIEW_LIMITS.englishScale) : REVIEW_LIMITS.carryChars);
}
