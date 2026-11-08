import type { ChatMessage } from '../../shared/contracts';
import { PRIVATE_LITERAL } from '../private-literal';
import { MEME_CONTEXT_NOTE } from '../../shared/relationship';
import { isDateKey, recentDiaryDates, shiftDate } from './diary-dates';

/**
 * L3 diary: one short entry per local day, written by the character in her own
 * voice, stored inside the user-profile file of the same character + chat-model
 * scope (docs/claude/2026-11-02-diary.md). Everything here is pure data work;
 * the profile store owns the file, its queue and its consent gates.
 */
export interface UserDiaryEntry {
  date: string; text: string; writtenAt: number; editedAt?: number;
  /** 熟悉度: at most one small thing that belongs only to the two of them, found by the same call that wrote the day. Goes with the day. */
  meme?: string;
}
export interface DiaryAttempt { date: string; count: number; lastAt: number }
/** Optional profile-file keys, written only when non-empty: a diary-free profile keeps the original v1 bytes. */
export interface StoredDiaryFields { diary?: UserDiaryEntry[]; diaryBlocked?: string[]; diaryAttempts?: DiaryAttempt[] }
export type DiaryState = Required<StoredDiaryFields>;
export const DIARY_FIELDS = ['diary', 'diaryBlocked', 'diaryAttempts'] as const;

export const DIARY_LIMITS = Object.freeze({
  /** About two years of days; when full the writer stops instead of silently deleting old days. */
  entries: 730,
  blocked: 2000,
  attempts: 64,
  /** A written entry is asked for in ≤150 characters; anything past this is treated as malformed. */
  writtenChars: 300,
  editedChars: 500,
  /** First try plus two retries for one day; then that day is left unwritten. */
  attemptsPerDay: 3,
  backfillDays: 3,
  materialChars: 6000,
  chatPointChars: 300,
  /** A meme is a short phrase; the opening block carries at most `memePoints` of the last `memeDays` days. */
  memeChars: 40,
  memeDays: 30,
  memePoints: 2,
});

/** The note that rides with the diary points inside `<private-user-profile-data>`. */
export const DIARY_CONTEXT_NOTE = '以下是你自己最近几天写的日记（新到旧）。这是你自己写的日记，至多自然提起其中一件，不要背诵，不要每次都提；这次对话用不上就不提。';

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const length = (value: string) => Array.from(value).length;

function plain(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) throw Error('日记数据格式不正确。');
}
function whole(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error('日记时间不正确。');
  return value as number;
}

/** Trimmed text with one newline style, or null when it is empty, too long, binary or carries a credential/path. */
export function diaryText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if (!text || length(text) > limit || control.test(text) || PRIVATE_LITERAL.test(text)) return null;
  return text;
}

/** Throws on anything the store must not accept from disk. Missing keys are an older (diary-free) profile. */
export function validateDiaryFields(value: Record<string, unknown>): void {
  const diary = value.diary ?? [], blocked = value.diaryBlocked ?? [], attempts = value.diaryAttempts ?? [];
  if (!Array.isArray(diary) || diary.length > DIARY_LIMITS.entries || !Array.isArray(blocked) || blocked.length > DIARY_LIMITS.blocked
    || !Array.isArray(attempts) || attempts.length > DIARY_LIMITS.attempts) throw Error('日记格式不正确。');
  const dates = new Set<string>();
  for (const entry of diary) {
    plain(entry, ['date', 'text', 'writtenAt', 'editedAt', 'meme']);
    if (!isDateKey(entry.date) || dates.has(entry.date) || diaryText(entry.text, DIARY_LIMITS.editedChars) !== entry.text) throw Error('日记条目不正确。');
    if (entry.meme !== undefined && diaryText(entry.meme, DIARY_LIMITS.memeChars) !== entry.meme) throw Error('日记条目不正确。');
    whole(entry.writtenAt); if (entry.editedAt !== undefined) whole(entry.editedAt);
    dates.add(entry.date);
  }
  if (!blocked.every(date => isDateKey(date) && !dates.has(date)) || new Set(blocked).size !== blocked.length) throw Error('日记删除记录不正确。');
  const tried = new Set<string>();
  for (const attempt of attempts) {
    plain(attempt, ['date', 'count', 'lastAt']);
    if (!isDateKey(attempt.date) || tried.has(attempt.date) || !Number.isSafeInteger(attempt.count)
      || (attempt.count as number) < 1 || (attempt.count as number) > DIARY_LIMITS.attemptsPerDay) throw Error('日记尝试记录不正确。');
    whole(attempt.lastAt); tried.add(attempt.date);
  }
}

export function diaryState(fields: StoredDiaryFields): DiaryState {
  return { diary: structuredClone(fields.diary ?? []), diaryBlocked: [...(fields.diaryBlocked ?? [])], diaryAttempts: structuredClone(fields.diaryAttempts ?? []) };
}
/** Omit empty keys; entries oldest first so the file reads like a diary. */
export function compactDiary(state: DiaryState): StoredDiaryFields {
  const diary = [...state.diary].sort((a, b) => a.date.localeCompare(b.date));
  const blocked = [...new Set(state.diaryBlocked)].sort();
  while (blocked.length > DIARY_LIMITS.blocked) blocked.shift();
  return { ...(diary.length ? { diary } : {}), ...(blocked.length ? { diaryBlocked: blocked } : {}),
    ...(state.diaryAttempts.length ? { diaryAttempts: [...state.diaryAttempts].sort((a, b) => a.date.localeCompare(b.date)) } : {}) };
}

/** Days still to write, in the given order: no entry, never deleted, attempts left. */
export function dueDiaryDates(state: DiaryState, dates: readonly string[]): string[] {
  if (state.diary.length >= DIARY_LIMITS.entries) return [];
  return dates.filter(date => isDateKey(date) && !state.diary.some(entry => entry.date === date) && !state.diaryBlocked.includes(date)
    && (state.diaryAttempts.find(attempt => attempt.date === date)?.count ?? 0) < DIARY_LIMITS.attemptsPerDay);
}

/** Counted before the model call, so a crash or quit mid-call still uses up the attempt. */
export function withAttempt(state: DiaryState, date: string, at: number, today: string): DiaryState {
  const horizon = shiftDate(today, -14);
  const attempts = state.diaryAttempts.filter(attempt => attempt.date >= horizon && attempt.date !== date);
  const previous = state.diaryAttempts.find(attempt => attempt.date === date)?.count ?? 0;
  attempts.push({ date, count: Math.min(DIARY_LIMITS.attemptsPerDay, previous + 1), lastAt: at });
  while (attempts.length > DIARY_LIMITS.attempts) attempts.shift();
  return { ...state, diaryAttempts: attempts };
}

/** Null when the day already has an entry (written or edited), was deleted, or the diary is full. */
export function withWrittenEntry(state: DiaryState, date: string, text: string, at: number, meme?: string): DiaryState | null {
  if (!dueDiaryDates({ ...state, diaryAttempts: [] }, [date]).length) return null;
  return { ...state, diary: [...state.diary, { date, text, writtenAt: at, ...(meme ? { meme } : {}) }], diaryAttempts: state.diaryAttempts.filter(attempt => attempt.date !== date) };
}

export function withEditedEntry(state: DiaryState, date: string, text: string, at: number): DiaryState {
  const index = state.diary.findIndex(entry => entry.date === date);
  if (index < 0) throw Error('这一天的日记已不存在。');
  const diary = structuredClone(state.diary);
  diary[index] = { ...diary[index], text, editedAt: at };
  return { ...state, diary };
}

/** The deleted day is remembered so the writer never writes it again. */
export function withoutEntry(state: DiaryState, date: string): DiaryState {
  if (!state.diary.some(entry => entry.date === date)) throw Error('这一天的日记已不存在。');
  return { diary: state.diary.filter(entry => entry.date !== date), diaryBlocked: [...state.diaryBlocked, date],
    diaryAttempts: state.diaryAttempts.filter(attempt => attempt.date !== date) };
}

/**
 * Clear all: every existing day and every day the writer could still backfill
 * (the last few days before today) is blocked. Days after today are unaffected,
 * so the diary simply continues tomorrow while recording stays on.
 */
export function clearedDiary(state: DiaryState, today: string): DiaryState {
  const blocked = [...state.diaryBlocked, ...state.diary.map(entry => entry.date), ...recentDiaryDates(today, DIARY_LIMITS.backfillDays)];
  return { diary: [], diaryBlocked: [...new Set(blocked)], diaryAttempts: [] };
}

const relative = ['昨天', '前天', '三天前'];
/**
 * Recent diary points, newest first, cut at `maxChars` (code points, line
 * breaks included). Only the last three days before `today` count as recent.
 */
export function diaryPoints(entries: readonly UserDiaryEntry[], today: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars));
  const lines: string[] = [];
  let used = 0;
  recentDiaryDates(today, DIARY_LIMITS.backfillDays).forEach((date, index) => {
    const entry = entries.find(item => item.date === date);
    if (!entry || used >= budget) return;
    const line = `${relative[index] ?? date}（${date}）：${entry.text.replace(/\s+/gu, ' ')}`;
    const room = budget - used - (lines.length ? 1 : 0);
    if (room <= 0) { used = budget; return; }
    if (length(line) <= room) { lines.push(line); used += length(line) + (lines.length > 1 ? 1 : 0); return; }
    if (room >= 16) lines.push(Array.from(line).slice(0, room - 1).join('') + '…');
    used = budget;
  });
  return lines.join('\n');
}

export function diaryContextSection(points: string): string {
  return points ? `${DIARY_CONTEXT_NOTE}\n${points}` : '';
}

/**
 * 熟悉度: the memes of the last `days` days (newest first, at most `max`), one line each. Only entries
 * that still exist count, so deleting or clearing a day takes its meme along. Never today's date.
 */
export function diaryMemes(entries: readonly UserDiaryEntry[], today: string, days: number = DIARY_LIMITS.memeDays, max: number = DIARY_LIMITS.memePoints): string[] {
  const window = recentDiaryDates(today, days);
  const lines: string[] = [];
  for (const date of window) {
    const entry = entries.find(item => item.date === date);
    if (entry?.meme) lines.push(`${date.slice(5)}：${entry.meme.replace(/\s+/gu, ' ')}`);
    if (lines.length >= max) break;
  }
  return lines;
}
export function memeContextSection(lines: readonly string[]): string {
  return lines.length ? `${MEME_CONTEXT_NOTE}\n${lines.join('\n')}` : '';
}

/** First user turn of a conversation: a greeting or proactive line may precede it, an earlier user message may not. */
export function isConversationOpening(messages: readonly ChatMessage[] | null | undefined): boolean {
  return Array.isArray(messages) && messages.at(-1)?.role === 'user' && messages.filter(message => message?.role === 'user').length === 1;
}
