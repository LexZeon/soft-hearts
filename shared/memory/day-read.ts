/**
 * I-089 item 5, 听得出你今天的状态: across the day she forms a gentle read
 * of how the user is, out of signals that are ALREADY on. Idea only from the "ears" project in docs/claude/2026-11-12-borrow-scan.md
 * (compare each moment with the person's own day rather than judging one sentence); nothing is copied.
 *
 * Closed on purpose: one of five kinds (or none), with one reason category. Never a word of the user, never audio, never a picture, never
 * a number from either. Memory only (electron/memory/day-read.ts), every signal fades on its own clock and is dropped after DAY_READ_KEEP_MS, a
 * restart starts empty. She never says it ("检测到" is exactly what she must not say): it is one private line for her turn.
 *
 * Read and write loop (handbook/README.md principles 1 and 6, handbook mood docs):
 *  - reads (all from what is already on; a switch that is off just means fewer signals, nothing turns on by itself):
 *      voice   the closed tone of a voice turn (shared/senses/user-tone.ts; needs 语音输入 on with the local recognizer),
 *      look    the closed tag of her own look (shared/initiative/self-look.ts; needs 「发图片」 and her looking),
 *      said    her own judgment of the user in the reply tail (shared/senses/user-state.ts; always),
 *      late    the user writing to her in the small hours (the clock; always),
 *      rhythm  a run of very short, quick messages (counts and lengths only, never the text; always).
 *  - writes: nothing about her mood and nothing to any file. Only one private context line for her chat turn and for her own decision
 *    to speak first (inner loop), worded so that it shapes warmth and how much she says, never a lecture, never "go and talk to someone
 *    else", never a reason for the user to feel guilty or watched.
 */

export const DAY_READS = ['tired', 'low', 'upbeat', 'busy', 'edgy'] as const;
export type DayRead = (typeof DAY_READS)[number];
export const DAY_REASONS = ['voice', 'look', 'said', 'late', 'rhythm'] as const;
export type DayReason = (typeof DAY_REASONS)[number];

export interface DaySignal { read: DayRead; reason: DayReason; weight: number; at: number }

const MINUTE = 60_000;
/**
 * Fallback numbers (not rules: they only keep one stray signal from deciding the day, and keep the read from flickering). How long a
 * signal counts for by half: tiredness and a low mood last through the afternoon, a laugh or a burst of quick messages is gone soon.
 */
export const DAY_READ_HALF_LIFE_MS: Readonly<Record<DayRead, number>> = {
  tired: 120 * MINUTE, low: 120 * MINUTE, upbeat: 40 * MINUTE, busy: 20 * MINUTE, edgy: 40 * MINUTE,
};
/** A signal older than this is forgotten outright (the read decays within the day). */
export const DAY_READ_KEEP_MS = 6 * 60 * MINUTE;
export const DAY_READ_MAX_SIGNALS = 48;
/** The leading kind must reach this much, and beat the next by this factor, or the read is "unclear" (no line at all). */
export const DAY_READ_MIN_SCORE = 0.9;
export const DAY_READ_LEAD = 1.4;

const TONE_SIGNAL: Readonly<Record<string, { read: DayRead; weight: number }>> = {
  laughing: { read: 'upbeat', weight: 1 }, happy: { read: 'upbeat', weight: 1 },
  sad: { read: 'low', weight: 1 }, crying: { read: 'low', weight: 1.5 }, angry: { read: 'edgy', weight: 1 },
};
const LOOK_SIGNAL: Readonly<Record<string, { read: DayRead; weight: number }>> = {
  tired: { read: 'tired', weight: 1.2 }, smiling: { read: 'upbeat', weight: 1 },
};
const SAID_SIGNAL: Readonly<Record<string, DayRead>> = { tired: 'tired', low: 'low', happy: 'upbeat', excited: 'upbeat', annoyed: 'edgy' };

/** The signal a voice tone gives (shared/senses/user-tone.ts values), or null. */
export const voiceSignal = (tone: unknown, at: number): DaySignal | null => {
  const hit = typeof tone === 'string' && Object.hasOwn(TONE_SIGNAL, tone) ? TONE_SIGNAL[tone] : null;
  return hit && Number.isFinite(at) ? { read: hit.read, reason: 'voice', weight: hit.weight, at } : null;
};
/** The signal her own look's closed tag gives (shared/initiative/self-look.ts SELF_LOOK_TAGS): present, away, unclear and anything else give none. */
export const lookSignal = (tag: unknown, at: number): DaySignal | null => {
  const hit = typeof tag === 'string' && Object.hasOwn(LOOK_SIGNAL, tag) ? LOOK_SIGNAL[tag] : null;
  return hit && Number.isFinite(at) ? { read: hit.read, reason: 'look', weight: hit.weight, at } : null;
};
/** The signal her own judgment in the reply tail gives (shared/senses/user-state.ts kinds; calm and unknown give none). */
export const saidSignal = (state: unknown, at: number): DaySignal | null => {
  const read = typeof state === 'string' && Object.hasOwn(SAID_SIGNAL, state) ? SAID_SIGNAL[state] : null;
  return read && Number.isFinite(at) ? { read, reason: 'said', weight: 1.5, at } : null;
};
/** A message in the small hours (local 0:00 to 4:59) says a little about tiredness; the same message in daytime says nothing. */
export const lateSignal = (hour: number, at: number): DaySignal | null =>
  Number.isInteger(hour) && hour >= 0 && hour < 5 && Number.isFinite(at) ? { read: 'tired', reason: 'late', weight: 0.4, at } : null;

/**
 * Message rhythm, from the times and lengths of the user's recent messages only: four short ones (under 12 characters) within five
 * minutes, each soon after the last, read as someone replying on the side while doing something else.
 */
export function rhythmSignal(recent: readonly { at: number; length: number }[], at: number): DaySignal | null {
  const window = recent.filter(m => Number.isFinite(m.at) && at - m.at <= 5 * MINUTE && at - m.at >= 0);
  const run = window.slice(-4);
  if (run.length < 4 || !run.every(m => m.length > 0 && m.length < 12)) return null;
  for (let i = 1; i < run.length; i++) if (run[i].at - run[i - 1].at > 90_000) return null;
  return { read: 'busy', reason: 'rhythm', weight: 1, at };
}

export interface DayReadResult { read: DayRead; reason: DayReason; score: number }

/** Score of one signal now: its weight, halved every half-life; nothing once it is too old (or from the future). */
export function signalScore(signal: DaySignal, now: number): number {
  const age = now - signal.at;
  if (!(signal.weight > 0) || !Number.isFinite(age) || age < 0 || age >= DAY_READ_KEEP_MS) return 0;
  return signal.weight * Math.pow(0.5, age / DAY_READ_HALF_LIFE_MS[signal.read]);
}

/** The day's read now, or null ("unclear": too little, or two kinds too close). The reason is the strongest source of the leading kind. */
export function dayRead(signals: readonly DaySignal[], now: number): DayReadResult | null {
  const totals = new Map<DayRead, number>();
  const byReason = new Map<string, number>();
  for (const signal of signals) {
    const score = signalScore(signal, now);
    if (score <= 0) continue;
    totals.set(signal.read, (totals.get(signal.read) ?? 0) + score);
    byReason.set(`${signal.read}|${signal.reason}`, (byReason.get(`${signal.read}|${signal.reason}`) ?? 0) + score);
  }
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] < DAY_READ_MIN_SCORE) return null;
  if (ranked[1] && top[1] < ranked[1][1] * DAY_READ_LEAD) return null;
  let reason: DayReason = 'said', best = -1;
  for (const candidate of DAY_REASONS) { const value = byReason.get(`${top[0]}|${candidate}`) ?? 0; if (value > best) { best = value; reason = candidate; } }
  return { read: top[0], reason, score: top[1] };
}

const READ_WORDS: Readonly<Record<DayRead, string>> = {
  tired: '有点累', low: '情绪有点低', upbeat: '心情不错', busy: '像是在忙着别的事，顺手回你', edgy: '有点烦躁',
};
const REASON_WORDS: Readonly<Record<DayReason, string>> = {
  voice: '从声音里', look: '从神情上', said: '从你们聊的话里', late: '这么晚了还醒着', rhythm: '从他回话的节奏上',
};
/** What each kind asks of her, as a lean and never a rule (principle 6: warmth, no lecture, no pushing him towards other people, no guilt). */
const LEAN_WORDS: Readonly<Record<DayRead, string>> = {
  tired: '语气放轻一点、少让他费劲，可以陪着，不要说教，不要催他去睡',
  low: '多一点温柔和在场，不追问，也不急着替他想办法',
  upbeat: '可以跟着轻快一点，玩笑多一点',
  busy: '话短一点，别拉着他聊长的',
  edgy: '别火上浇油，也别绕着他走，平常地待着就好',
};

/** The private line for her turn ('' for none). Fixed words per closed value. */
export function dayReadLine(result: DayReadResult | null | undefined): string {
  if (!result || !Object.hasOwn(READ_WORDS, result.read) || !Object.hasOwn(REASON_WORDS, result.reason)) return '';
  return `（你隐约觉得用户今天${READ_WORDS[result.read]}（${REASON_WORDS[result.reason]}感觉到的，可能不准）。${LEAN_WORDS[result.read]}；以他这轮的话为准，自然体现就好，不要说出这个判断，不要说你"检测""识别"到了什么，别让他觉得被盯着或有负担。）`;
}
/** The same read for her own decision to speak first (inner loop). */
export function dayReadInnerLoopLine(result: DayReadResult | null | undefined): string {
  if (!result || !Object.hasOwn(READ_WORDS, result.read)) return '';
  return `你隐约觉得用户今天${READ_WORDS[result.read]}。只是参考：${LEAN_WORDS[result.read]}；不必说出来。`;
}
