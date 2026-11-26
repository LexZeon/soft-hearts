/**
 * Read-aloud while she is out (docs/claude/2026-11-15-unbound-read-aloud.md): the Unbound page's report of exactly which reply
 * text its bubble has painted. The host keeps what it sent (electron/unbound/read-aloud.ts) and accepts a report only when its
 * text is exactly what it sent at that revision, so the page can never claim words the host did not give it.
 */

/** Longest text a report may carry (the companion's reply window takes the same). */
export const SHOWN_TEXT_MAX = 32_000;

export interface UnboundShownReport {
  /** The bubble's reply or line id (the host's own id for it). */
  id: string;
  /** The host revision whose text was on screen (UnboundBubble.rev). */
  rev: number;
  /** The bubble's whole text at that revision, untrimmed (the concatenation of the deltas it received). */
  text: string;
  /** Painted and readable: not hidden, not fading, her head on the window. False: nothing of this bubble is on screen now. */
  visible: boolean;
}

/** Strict: anything that is not exactly a report is null (the host ignores it). */
export function parseUnboundShown(value: unknown): UnboundShownReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== 'id' && key !== 'rev' && key !== 'text' && key !== 'visible')) return null;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.id)) return null;
  if (!Number.isSafeInteger(raw.rev) || (raw.rev as number) < 1) return null;
  if (typeof raw.text !== 'string' || raw.text.length > SHOWN_TEXT_MAX) return null;
  if (typeof raw.visible !== 'boolean') return null;
  return { id: raw.id, rev: raw.rev as number, text: raw.text, visible: raw.visible };
}
