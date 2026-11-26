// I-088 第 1 条 她的"这阵子"回顾: how a look-back comes back, both local and instant (nothing here calls a model, and nothing is added to a
// turn that has no match):
//   1. when the user says "上周 / 上个月 / 那阵子 / 这个月 / 这周", or names something a look-back names, that look-back is offered as a
//      memory through MemoryStore.retrieve (the same path the chat memories use: same record count, same character budget);
//   2. at a new week's first conversation she may be given one sentence of last week's look-back (the diary's opening path), not every
//      time: whether she is given one is decided once per week.
import { hasExplicitRecallCue } from '../../../shared/memory/memory';
import { VAGUE_TERMS, prepareNoteQuery, squashText } from '../../../shared/memory/memory-notes/recall';
import { shiftDate } from '../diary/diary-dates';
import { REVIEW_LIMITS, type ReviewData, type ReviewEntry } from './data';
import { monthOf, monthRange, shiftMonth, shortDate, weekRange, weekStartOf } from './period';

/** What recall hands to MemoryStore.retrieve: shaped like one of its records, with no chat behind it. */
export interface ReviewRecalled { id: string; title: string; createdAt: number; excerpt: string }

const LAST_WEEK = /上(?:个|一个)?(?:周|星期|礼拜)|上一周|前一周/u;
const THIS_WEEK = /(?:这|本)(?:一|个)?(?:周|星期|礼拜)(?!末)/u;
const LAST_MONTH = /上(?:个|一个)?月|上一个月/u;
const THIS_MONTH = /这(?:一)?个月|这月|本月/u;
const WHILE = /那阵子|前阵子|这阵子|前段时间|那段时间|前些日子|这段时间/u;
/** "这周要…" / "这个月打算…" look ahead, not back: a look-back is not offered for them. */
const AHEAD = /打算|准备|计划|想去|要去|等会|待会|明天|后天|下周|下个月|下礼拜|会不会|能不能|可以吗/u;
const HAN = /^\p{Script=Han}+$/u;

const newest = (items: readonly ReviewEntry[]) => [...items].sort((a, b) => b.key.localeCompare(a.key))[0];

/** The look-back a period word points at, or null. Last month / last week mean exactly that period; "这周" is the week just over. */
export function reviewByPeriodWord(items: readonly ReviewEntry[], text: string, today: string): ReviewEntry | null {
  const weeks = items.filter(item => item.kind === 'week'), months = items.filter(item => item.kind === 'month');
  const lastWeek = shiftDate(weekStartOf(today), -7);
  if (LAST_MONTH.test(text)) { const hit = months.find(item => item.key === shiftMonth(monthOf(today), -1)); if (hit) return hit; }
  if (LAST_WEEK.test(text)) { const hit = weeks.find(item => item.key === lastWeek); if (hit) return hit; }
  const ahead = AHEAD.test(text);
  if (!ahead && THIS_WEEK.test(text)) { const hit = weeks.find(item => item.key === lastWeek); if (hit) return hit; }
  if (!ahead && THIS_MONTH.test(text)) { const hit = newest(weeks.filter(item => monthOf(item.key) === monthOf(today))); if (hit) return hit; }
  if (WHILE.test(text)) { const hit = newest(months) ?? newest(weeks); if (hit) return hit; }
  return null;
}

/** The look-back the user's words name (a person, place or thing it names), best first; null when the words are too thin or too common. */
export function reviewByWords(items: readonly ReviewEntry[], text: string): ReviewEntry | null {
  const query = prepareNoteQuery(text);
  if (!query) return null;
  const need = query.cue || hasExplicitRecallCue(text) ? 2 : 3;
  let best: { entry: ReviewEntry; score: number } | null = null;
  for (const entry of items) {
    let score = 0;
    for (const word of entry.words) {
      const key = squashText(word);
      if (!key || VAGUE_TERMS.has(key) || !query.squashed.includes(key)) continue;
      const size = Array.from(key).length;
      if (HAN.test(key) ? size < 2 : size < 3) continue;
      score += size >= 3 ? 3 : 2;
    }
    if (score >= need && (!best || score > best.score || (score === best.score && entry.key > best.entry.key))) best = { entry, score };
  }
  return best?.entry ?? null;
}

const title = (entry: ReviewEntry): string => entry.kind === 'week'
  ? `一周回顾（${Number(entry.key.slice(5, 7))}月${Number(entry.key.slice(8))}日起）`
  : `一个月的回顾（${entry.key.slice(0, 4)}年${Number(entry.key.slice(5))}月）`;

/** At most one look-back for this message, shaped for MemoryStore.retrieve. A period word wins over names. */
export function recallReview(data: ReviewData | undefined, text: string, today: string): ReviewRecalled | null {
  if (!data?.items.length || typeof text !== 'string' || !text.trim()) return null;
  const entry = reviewByPeriodWord(data.items, text, today) ?? reviewByWords(data.items, text);
  if (!entry) return null;
  const end = entry.kind === 'week' ? weekRange(entry.key).end : monthRange(entry.key).end;
  return { id: `review:${entry.kind}:${entry.key}`, title: title(entry), createdAt: end, excerpt: entry.text };
}

export const REVIEW_OPENING_NOTE = '以下是你自己回顾上一周时写下的一件事（新的一周刚开始）。这是你自己的回忆，至多自然提起一次，不要背诵，不要每次都提；这次对话用不上就不提。';

/** The sentences of a look-back worth saying on their own. */
export function reviewSentences(text: string): string[] {
  const sentences = text.split(/(?<=[。！？!?\n])/u).map(item => item.replace(/\s+/gu, ' ').trim()).filter(item => Array.from(item).length >= 6);
  return sentences.length ? sentences : [text.replace(/\s+/gu, ' ').trim()];
}

/**
 * The new week's first conversation: once per week, decided with a little luck (a chance somewhere between 40 and 70 percent, drawn
 * each week, so it is not every time and not on a schedule), and then which sentence of last week's look-back is luck too. Null when
 * the week was already decided or last week has no look-back yet (nothing is decided then, so a look-back written later still counts).
 * `next` is the state to keep (the decision is kept whether or not she got a line).
 */
export function chooseOpening(data: ReviewData | undefined, today: string, random: () => number = Math.random): { line: string; next: ReviewData } | null {
  const week = weekStartOf(today), state = data;
  if (!state || state.opening?.week === week) return null;
  const last = state.items.find(item => item.kind === 'week' && item.key === shiftDate(week, -7));
  if (!last) return null;
  const chance = 0.4 + 0.3 * clamp(random()), shown = clamp(random()) < chance;
  const sentences = reviewSentences(last.text);
  const sentence = sentences[Math.min(sentences.length - 1, Math.floor(clamp(random()) * sentences.length))]!;
  const chars = Array.from(sentence);
  const said = chars.length > REVIEW_LIMITS.openingChars ? chars.slice(0, REVIEW_LIMITS.openingChars - 1).join('') + '…' : sentence;
  return { line: shown ? `${REVIEW_OPENING_NOTE}\n上一周（${shortDate(last.key)} 起）：${said}` : '', next: { ...state, opening: { week, shown } } };
}
const clamp = (value: number) => Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
