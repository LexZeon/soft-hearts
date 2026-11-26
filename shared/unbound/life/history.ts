/**
 * Unbound v1 step 4, afternoon addition C: what she noticed of you while she was out, kept for today in memory,
 * and the words the chat Claude is given. Pure.
 *
 * The words (tests/unbound-life-history.test.ts scans them):
 *  - facts only: what you did, in plain words; never an instruction to her ("你要提到", "你应该回应", "请…"), no required retelling;
 *  - no numbers: a duration is said in rounded words ("十来分钟"), counts as "一次 / 两次 / 好几次";
 *  - it says she sensed it herself, and with what: the camera's pose sensing, the microphone (only that you were talking, not what);
 *  - a "maybe" is told with "好像"; an "unsure" never reaches here (reactions.ts drops it).
 * The fixed system prompt is not touched: these sentences ride on the per-turn 【此刻的感知】 line, which that prompt already says wins.
 */
import type { MoodReading } from '../director';
import type { ConfidenceBand } from './pose-read';

export const NOTICED_KINDS = ['left', 'came-back', 'facing', 'wave', 'stretch', 'leaned-back', 'talked', 'answered', 'pulled-along'] as const;
export type NoticedKind = (typeof NOTICED_KINDS)[number];
export interface Noticed { kind: NoticedKind; band: Exclude<ConfidenceBand, 'unsure'>; at: number; awayMs?: number }
/** Which sense noticed it (the line names only the senses that did). */
/** 'mouse': step 5, you pulled her along with the mouse (no sense of hers was involved: the line names none for it). */
export const NOTICED_SENSE: Readonly<Record<NoticedKind, 'camera' | 'microphone' | 'both' | 'mouse'>> = Object.freeze({
  left: 'camera', 'came-back': 'camera', facing: 'camera', wave: 'camera', stretch: 'camera', 'leaned-back': 'camera', talked: 'microphone', answered: 'both', 'pulled-along': 'mouse',
});

/** A duration in rounded words (no digits). */
export function durationWords(ms: number): string {
  const m = Math.max(0, ms) / 60_000;
  if (m < 3) return '一小会儿';
  if (m < 8) return '几分钟';
  if (m < 15) return '十来分钟';
  if (m < 25) return '二十来分钟';
  if (m < 50) return '半个多小时';
  if (m < 80) return '一个来小时';
  if (m < 150) return '一个多小时';
  if (m < 210) return '两三个小时';
  return '好几个小时';
}
/** A count in words (no digits). */
export const countWords = (n: number): string => n <= 1 ? '一次' : n === 2 ? '两次' : n === 3 ? '三次' : '好几次';

/** One thing you did, in a few words (no "用户刚才"); a maybe says "好像". */
export function noticedPhrase(n: Noticed): string {
  const phrase = ((): string => {
    switch (n.kind) {
      case 'left': return '走开了';
      case 'came-back': return `走开了${durationWords(n.awayMs ?? 0)}，又回到了电脑前`;
      case 'facing': return '朝着你看了一会儿';
      case 'wave': return '朝你挥了挥手';
      case 'stretch': return '伸了个懒腰';
      case 'leaned-back': return '往后靠着歇了一会儿';
      case 'talked': return '在和别人说话（你只听得出有人在说，没听内容）';
      case 'answered': return '在你走近的时候理了你';
      case 'pulled-along': return '拉着你走了一段';
    }
  })();
  return n.band === 'maybe' ? `好像${phrase}` : phrase;
}

const SENSE_WORDS = { camera: '摄像头（姿势识别）', microphone: '麦克风' } as const;
/** What she was told this happened through (the senses that are on while she is out). */
function senseClause(items: readonly Noticed[]): string {
  const cam = items.some(n => NOTICED_SENSE[n.kind] === 'camera' || NOTICED_SENSE[n.kind] === 'both'), mic = items.some(n => NOTICED_SENSE[n.kind] === 'microphone');
  if (!cam && !mic) return '';
  const senses = [cam ? SENSE_WORDS.camera : '', mic ? SENSE_WORDS.microphone : ''].filter(Boolean).join('和');
  return `你在外面的时候${senses}开着，下面是你自己感知到的。`;
}

/** A part of the day in words, from a local hour. */
export function partOfDay(hour: number): string {
  if (hour < 5) return '深夜'; if (hour < 9) return '早上'; if (hour < 12) return '上午'; if (hour < 14) return '中午';
  if (hour < 18) return '下午'; if (hour < 20) return '傍晚'; return '晚上';
}
const localHour = (at: number) => new Date(at).getHours();

/** One part of the day's events → "走开过两次（最长一个多小时），朝着你看过好几次…" ('' for nothing). */
function partWords(events: readonly Noticed[]): string {
  const count = (kind: NoticedKind) => events.filter(e => e.kind === kind).length;
  const parts: string[] = [];
  const backs = events.filter(e => e.kind === 'came-back' && e.awayMs), longest = backs.reduce((m, e) => Math.max(m, e.awayMs ?? 0), 0);
  if (count('left')) parts.push(`走开过${countWords(count('left'))}${longest ? `（最长${durationWords(longest)}）` : ''}`);
  if (count('facing')) parts.push(`朝着你看过${countWords(count('facing'))}`);
  if (count('wave')) parts.push(`朝你挥过${countWords(count('wave'))}手`);
  if (count('stretch')) parts.push(`伸过${countWords(count('stretch'))}懒腰`);
  if (count('leaned-back')) parts.push(`往后靠着歇过${countWords(count('leaned-back'))}`);
  if (count('talked')) parts.push(`和别人说过${countWords(count('talked'))}话`);
  if (count('answered')) parts.push(`你走近的时候理了你${countWords(count('answered'))}`);
  if (count('pulled-along')) parts.push(`拉着你走过${countWords(count('pulled-along'))}`);
  return parts.join('，');
}

/**
 * Today's events (oldest first) → a local account by part of the day: counts in words, durations rounded, no clock times, no digits.
 * '' when there is not yet a day worth a line (fewer than two kinds of thing). Long accounts are what haiku condenses.
 */
export function dayAccount(events: readonly Noticed[], hourOf: (at: number) => number = localHour): string {
  if (new Set(events.map(e => e.kind)).size < 2) return '';
  const order: string[] = [], byPart = new Map<string, Noticed[]>();
  for (const e of events) { const part = partOfDay(hourOf(e.at)); if (!byPart.has(part)) { byPart.set(part, []); order.push(part); } byPart.get(part)!.push(e); }
  const parts = order.map(part => { const words = partWords(byPart.get(part)!); return words ? (order.length > 1 ? `${part}${words}` : words) : ''; }).filter(Boolean);
  return parts.length ? `今天你们之间：用户${parts.join('；')}。` : '';
}

/**
 * The sentences for this chat turn ('' for none): what you did a moment ago that she was not told yet, and today's account (the
 * local one, or haiku's shorter one when it is long). Facts only.
 */
export function noticedTurnLine(fresh: readonly Noticed[], day: string): string {
  const items = fresh.slice(-4);
  if (!items.length && !day) return '';
  const now = items.length ? `${senseClause(items)}用户刚才${items.map(noticedPhrase).join('；')}。` : '';
  return now + day;
}

/** Instruction-like words that must never appear in these lines (tests/unbound-life-history.test.ts; the touch line's rule too). */
export const INSTRUCTION_WORDS = ['你要', '你应该', '应该', '请', '必须', '务必', '记得', '提到', '回应他', '回应用户', '告诉他', '告诉用户', '复述', '一定要', '不要忘'] as const;

/**
 * Whether she says something about it now (afternoon addition C step 3, like the touch's speak.ts): one roll from her mood numbers
 * and character; no switch, no Claude call here. Only a yes asks for a speech cue (the inner loop, the one opus call; Unbound has no cap).
 */
export const NOTICED_SPEAK = Object.freeze({
  base: { 'came-back': 0.3, wave: 0.25, facing: 0.08, stretch: 0.1, 'leaned-back': 0.04, left: 0, talked: 0, answered: 0, 'pulled-along': 0 } as Readonly<Record<NoticedKind, number>>,
  maybe: 0.5, perO: 0.004, perD: 0.002, perLonging: 0.002, sleepy: 0.2, lively: 0.002, restrained: -0.002, recentPenalty: 0.25, recentHalfLifeMs: 5 * 60_000, max: 0.6,
});
export function noticedSpeakChance(input: { kind: NoticedKind; band: 'sure' | 'maybe'; mood: MoodReading; lean?: { lively?: number; restrained?: number }; sinceSpokeMs?: number | null; asleep?: boolean }): number {
  const k = NOTICED_SPEAK, base = k.base[input.kind] ?? 0;
  if (input.asleep || base <= 0) return 0;
  const m = input.mood, lean = input.lean ?? {};
  let chance = base * (input.band === 'maybe' ? k.maybe : 1) + k.perO * (m.O - 50) + k.perD * (m.D - 50) + k.perLonging * Math.min(100, Math.max(0, m.M))
    - (m.A >= 0.5 ? k.sleepy : 0) + k.lively * ((lean.lively ?? 50) - 50) + k.restrained * ((lean.restrained ?? 50) - 50);
  if (typeof input.sinceSpokeMs === 'number' && input.sinceSpokeMs >= 0) chance -= k.recentPenalty * Math.pow(0.5, input.sinceSpokeMs / k.recentHalfLifeMs);
  return Math.min(k.max, Math.max(0, Number.isFinite(chance) ? chance : 0));
}
