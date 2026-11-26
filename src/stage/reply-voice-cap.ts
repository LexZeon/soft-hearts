/**
 * I-165: how much of one reply the companion's native bubble may show while her
 * voice reads it. The companion window's reply publisher asks `limit` whenever it publishes that reply's text; the cap comes from src/voice/bubble-follow-view.ts.
 *
 * - A cap only ever applies to the reply it names, and only if the bubble has not shown that reply's text yet (a reply already on screen
 *   is never hidden again: `refuse`).
 * - null = no cap (everything shows); 0 = nothing yet (the bubble shows "……"). Caps never go back.
 * - Never between the two halves of a character outside the basic plane, nor inside a combined emoji when the platform can tell.
 */
export class ReplyVoiceCap {
  private state: { id: string; cap: number | null } | null = null;
  private refused: string | null = null;

  /** The follow view's cap for reply `id`. True when the bubble should publish that reply again (the cap changed and it applies). */
  set(id: string, cap: number | null, textAlreadyShown: boolean): boolean {
    if (typeof id !== 'string' || !id || (cap !== null && (!Number.isSafeInteger(cap) || cap < 0))) return false;
    if (this.state?.id !== id) {
      if (cap !== null && textAlreadyShown) { this.refused = id; this.state = null; return false; } // already on screen: never hidden again
      this.state = { id, cap };
      return true;
    }
    if (this.refused === id) return false;
    const before = this.state.cap;
    if (before === null) return false; // released for good
    const next = cap === null ? null : Math.max(before, cap);
    if (next === before) return false;
    this.state.cap = next;
    return true;
  }

  /** How many code units of `text` (reply `id`'s text) the bubble may show now; null = all of it. */
  limit(id: string | undefined, text: string): number | null {
    const state = this.state;
    if (!id || !state || state.id !== id || state.cap === null || this.refused === id) return null;
    if (state.cap >= text.length) return text.length;
    return snapBack(text, state.cap);
  }

  /** The reply whose text is held now (its cap is not null), or null. */
  get holding(): string | null { return this.state && this.state.cap !== null ? this.state.id : null; }
}

function snapBack(text: string, cut: number): number {
  let at = Math.max(0, Math.min(text.length, cut));
  if (at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])) at--;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(input: string): Iterable<{ index: number }> } }).Segmenter;
  if (!Segmenter || at <= 0 || at >= text.length) return at;
  // A combined emoji (or a letter with its marks) shows whole or not at all.
  const from = Math.max(0, at - 16);
  let boundary = from;
  for (const piece of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(from, Math.min(text.length, at + 16)))) {
    if (from + piece.index > at) break;
    boundary = from + piece.index;
  }
  // A slice that began at the text's start knows its first boundary; one that began mid-grapheme does not (keep the cut then).
  return boundary > from || from === 0 ? boundary : at;
}
