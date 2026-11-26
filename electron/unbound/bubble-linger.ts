/**
 * How long a finished full-screen bubble stays (docs/claude/2026-11-22-bubble-linger-one-rule.md): the same decision as the
 * companion window's (shared/behaviors/reply-linger/, asked through MoodHost.decideReplyLinger), fed with what this bubble shows:
 * the whole reply at once, one bubble, so the reading floor covers all of it (`readAll`). The page only waits the milliseconds
 * the host hands it with the 'done' event (UnboundBubble.lingerMs); it never works the time out itself.
 */
import type { ReplyLingerBubble } from '../../shared/brain';

/** The one thing of the mood host this needs (electron/mood/mood.ts MoodHost.decideReplyLinger). */
export interface BubbleLingerMood { decideReplyLinger(bubble: ReplyLingerBubble): number }

/** The full-screen bubble as the reply-linger rule sees it. */
export const wholeReplyBubble = (text: string): ReplyLingerBubble => ({ text, pieces: null, segmented: false, readAll: true });

/** The wiring's port: ask her mood host. */
export const unboundBubbleLingerMs = (mood: BubbleLingerMood, text: string): number => mood.decideReplyLinger(wholeReplyBubble(text));

/** Host side: the port's answer for a 'done' event, or undefined (the page then keeps the bubble the longest) when there is no port or it fails. */
export function bubbleLingerFor(port: ((text: string) => number) | undefined, text: string): number | undefined {
  try {
    const ms = port?.(text);
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
  } catch { return undefined; }
}

/** The same, as the fields to add to a 'done' event: nothing at all when there is no answer. */
export const lingerField = (port: ((text: string) => number) | undefined, text: string): { lingerMs?: number } => {
  const lingerMs = bubbleLingerFor(port, text);
  return lingerMs === undefined ? {} : { lingerMs };
};
