/**
 * Where a reply's text stopped arriving. One reply's
 * text stopped reaching the main process for 24 s in the middle of the stream, and nothing said whether the model's stream had stalled or
 * something between the stream and the screen (the opening-marker protocol, the emphasis filter) was holding text. This measures, per
 * reply, the largest gap between the raw chunks the host receives from the model and the largest gap between the deltas that leave the
 * host toward the bubble and the archive (the same text after the protocol and the emphasis filter), and where each fell. A raw gap with
 * no shown gap larger beside it was upstream; a shown gap larger than the raw one was a hold.
 *
 * Numbers and closed words only: a gap in ms, the character index it fell at (the characters that had arrived before the chunk that ended
 * the gap), and what was pending when it began: an open bracket tag, a trailing emphasis mark, text held back by the protocol, or nothing.
 * Never a character of the reply. The clock is injected.
 */
import type { BrainJournalInput } from '../../shared/brain';
import type { StreamGaps, StreamPending } from '../../shared/brain/stream-gaps-journal';

const OPENERS = ['[', '(', '（', '<', '【', '「'], CLOSERS = [']', ')', '）', '>', '】', '」'];
const TAIL = 48;

/** What a stream whose last characters are `tail` was waiting for; `held` is how many received characters had not left the host yet. */
export function pendingOf(tail: string, held: number): StreamPending {
  const open = Math.max(...OPENERS.map(c => tail.lastIndexOf(c))), close = Math.max(...CLOSERS.map(c => tail.lastIndexOf(c)));
  if (open > close) return 'open-tag';
  if (/\*+$/u.test(tail)) return 'emphasis';
  return held > 0 ? 'held' : 'none';
}

export class StreamGapProbe {
  private rawAt: number | null = null; private rawChars = 0; private tail = ''; private chunks = 0;
  private rawMax = -1; private rawMaxAt = 0; private rawMaxPending: StreamPending = 'none';
  private shownAt: number | null = null; private shownChars = 0; private shownMax = -1; private shownMaxAt = 0;
  constructor(private readonly now: () => number = Date.now) {}

  /** A raw chunk arrived from the model; `shownSoFar` is how many characters had left the host before it (what the protocol had let through). */
  raw(text: string, shownSoFar: number): void {
    const at = this.now();
    if (this.rawAt !== null && at - this.rawAt > this.rawMax) { this.rawMax = at - this.rawAt; this.rawMaxAt = this.rawChars; this.rawMaxPending = pendingOf(this.tail, this.rawChars - shownSoFar); }
    this.rawAt = at; this.chunks++; this.rawChars += text.length; this.tail = (this.tail + text).slice(-TAIL);
  }

  /** A delta of `length` characters left the host toward the bubble and the archive. */
  shown(length: number): void {
    const at = this.now();
    if (this.shownAt !== null && at - this.shownAt > this.shownMax) { this.shownMax = at - this.shownAt; this.shownMaxAt = this.shownChars; }
    this.shownAt = at; this.shownChars += length;
  }

  /** The reply's numbers; null when no chunk arrived. */
  result(): StreamGaps | null {
    if (this.chunks === 0) return null;
    return { chunks: this.chunks, rawGapMs: this.rawMax < 0 ? null : Math.round(this.rawMax), ...(this.rawMax < 0 ? {} : { rawGapAt: this.rawMaxAt, rawPending: this.rawMaxPending }),
      shownGapMs: this.shownMax < 0 ? null : Math.round(this.shownMax), ...(this.shownMax < 0 ? {} : { shownGapAt: this.shownMaxAt }) };
  }
}

/** The journal input for one finished reply, or null when nothing arrived. */
export function streamGapsInput(characterId: string | null, probe: StreamGapProbe): Extract<BrainJournalInput, { type: 'stream-gaps' }> | null {
  const result = probe.result();
  return result ? { type: 'stream-gaps', characterId, ...result } : null;
}
