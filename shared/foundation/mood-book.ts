// I-098 on: one message's mood book in the experience journal (shared/memory/journal.ts 'mood-book'). Who kept it (her own state tail, or
// haiku after she spoke), how it went, which haiku answered, and the numbers it gave: context, the D/O/E/N/C delta as answered
// (before any blend), whether it named the user's state. A week of these shows whether the judge's E runs high next to the tail's
// (experiment 2026-11-12: mean |E| 0.88 for the judge, 0.28 for the tail). Closed values and numbers only, never a word.
import { MOOD_CHANNELS, type MoodContext, type MoodValues } from './mood';

export const MOOD_BOOK_BY = ['tail', 'judge'] as const;
export type MoodBookBy = (typeof MOOD_BOOK_BY)[number];
export const MOOD_BOOK_OUTCOMES = ['judged', 'unusable', 'failed', 'capped', 'superseded'] as const;
export type MoodBookOutcome = (typeof MOOD_BOOK_OUTCOMES)[number];
export const MOOD_BOOK_VIAS = ['warm', 'one-shot'] as const;
export type MoodBookVia = (typeof MOOD_BOOK_VIAS)[number];

export const MOOD_BOOK_BY_WORDS: Readonly<Record<MoodBookBy, string>> = { tail: '她自己写的尾注', judge: 'haiku 在她说完后记' };
export const MOOD_BOOK_VIA_WORDS: Readonly<Record<MoodBookVia, string>> = { warm: '待命的 haiku 接着问', 'one-shot': '临时开的 haiku' };
export const MOOD_BOOK_OUTCOME_WORDS: Readonly<Record<Exclude<MoodBookOutcome, 'judged'>, string>> = {
  unusable: '答案不合规则，没用上', failed: '没答上（出错或超时）', capped: '今天的次数到上限了', superseded: '新消息来了，这笔作废',
};
export const MOOD_BOOK_CONTEXT_WORDS: Readonly<Record<MoodContext, string>> = {
  neutral: '平常', positive: '开心', support: '被支持', concern: '担心你', disappointment: '失落', offense: '被冒犯', fright: '害怕',
};

/** A delta as the journal keeps it: D/O/E/N/C only, each finite, within ±6, one decimal; zeros dropped. Null when anything else is in it. */
export function moodBookDelta(value: unknown): Partial<MoodValues> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Partial<MoodValues> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(MOOD_CHANNELS as readonly string[]).includes(key) || typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 6) return null;
    const rounded = Math.round(raw * 10) / 10;
    if (rounded !== 0) out[key as keyof MoodValues] = rounded;
  }
  return out;
}

/** "D+2 E+0.5 C-1" in channel order; '' for an empty delta. */
export function moodBookDeltaText(delta: Partial<MoodValues>): string {
  return MOOD_CHANNELS.filter(channel => typeof delta[channel] === 'number' && delta[channel] !== 0)
    .map(channel => `${channel}${delta[channel]! > 0 ? '+' : ''}${delta[channel]}`).join(' ');
}
