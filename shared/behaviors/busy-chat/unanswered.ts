/**
 * Replaces the old hard stop "after speechWithoutReply unanswered lines she never speaks again" (改成大幅降低接着说的欲望).
 * Pure; the factor is in knobs.ts. Imported by shared/mood.ts (the gate) and the inner loop's prompt.
 */
import { BUSY_CHAT_KNOBS, type BusyChatKnobs } from './knobs';

/** How many unanswered lines are "over" the card's own allowance (0 while within it). */
export function unansweredOver(unanswered: number, allowance: number): number {
  return Math.max(0, Math.floor(unanswered) - Math.floor(allowance) + 1);
}

/** The speech interval after `unanswered` lines without a reply: the (possibly busy-chat adjusted) interval × factor, once per line over the allowance. */
export function speechIntervalAfterUnanswered(intervalMs: number, unanswered: number, allowance: number, knobs: BusyChatKnobs = BUSY_CHAT_KNOBS): number {
  const over = unansweredOver(unanswered, allowance);
  if (over === 0) return intervalMs;
  // Capped, and a card whose own interval is already longer keeps it: the cap never shortens, nor stretches further.
  return Math.max(intervalMs, Math.min(intervalMs * Math.pow(knobs.unansweredFactor, over), knobs.unansweredCapMinutes * 60_000));
}

/** One fact and one leaning for her prompt; '' while nothing is unanswered. Not a rule: she may still speak. */
export function unansweredSentence(unanswered: number): string {
  const n = Math.floor(unanswered);
  if (!(n >= 1)) return '';
  return `你已经主动说了 ${n} 句，他都还没回，多半在忙；除非真的很想他或者有要紧的事，否则这次安静待着。`;
}
