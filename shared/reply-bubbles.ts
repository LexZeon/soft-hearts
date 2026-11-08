import { splitReplySegments } from './reply-segments';
import type { PetReplyPieces } from './contracts';

/**
 * R27 bubble policy: how one ordinary streamed reply is laid out in the pet's
 * native reply window. This is the ONLY switch; flip it and rebuild to compare.
 * Default follows the user-confirmed R27 standard ("two complete sentences show
 * as two independent bubbles"); the alternative stays one switch away.
 *
 * - 'same-bubble': the whole reply stays in one bubble. Text appears as
 *   it streams and advances by the model's own natural paragraphs. No line
 *   breaks are inserted between sentences and earlier text is never re-rendered.
 * - 'bubble-per-sentence' (default): every complete sentence (and every natural paragraph)
 *   pops in as its own bubble below the previous one, which dims.
 *
 * Either way the native window still receives the exact raw cumulative prefix,
 * so the host's display receipt, completed-prefix speech proof, archive and
 * reader keep their original bytes. Pieces are display-only offsets.
 */
export type ReplyBubblePolicy = 'same-bubble' | 'bubble-per-sentence';
export const REPLY_BUBBLE_POLICY: ReplyBubblePolicy = 'bubble-per-sentence';

export const MAX_REPLY_PIECES = 128;
const LINE = /\r\n|\r|\n/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * End offsets of natural paragraphs (line-break runs) outside fenced code.
 * An end is reported only once real content follows it, so a growing prefix
 * never retracts an earlier end.
 */
export function paragraphEnds(text: string): number[] {
  const ends: number[] = [];
  let fence: { marker: string; count: number } | null = null;
  let start = 0, pendingEnd = -1;
  const visit = (line: string, lineEnd: number) => {
    if (line.trim() && pendingEnd > 0) { ends.push(pendingEnd); pendingEnd = -1; }
    const marker = FENCE.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.count && !marker[2].trim()) fence = null;
    } else if (marker) fence = { marker: marker[1][0], count: marker[1].length };
    // Only a line that leaves us outside a fence may close a paragraph.
    if (!fence && line.trim()) pendingEnd = lineEnd;
  };
  LINE.lastIndex = 0;
  for (let match: RegExpExecArray | null; (match = LINE.exec(text));) {
    visit(text.slice(start, match.index), match.index);
    start = match.index + match[0].length;
  }
  // The trailing line is still streaming: it can confirm an earlier end but
  // never ends a paragraph itself.
  const tail = text.slice(start);
  if (tail.trim() && pendingEnd > 0) ends.push(pendingEnd);
  return ends;
}

function sentenceEndsOf(text: string): number[] {
  try { return splitReplySegments(text).map(piece => piece.end); } catch { return []; }
}

/**
 * Display pieces for one ordinary reply text under the given policy.
 * `sentenceEnds` are stable incremental boundaries from the streaming readout;
 * without them (a completed text), sentences are derived from the whole text.
 * Returns null when the text has no visible content.
 */
export function replyPieces(text: string, sentenceEnds?: readonly number[], policy: ReplyBubblePolicy = REPLY_BUBBLE_POLICY): PetReplyPieces | null {
  if (typeof text !== 'string' || !text.trim() || text.length > 32000) return null;
  const candidates = paragraphEnds(text);
  if (policy === 'bubble-per-sentence') candidates.push(...(sentenceEnds ?? sentenceEndsOf(text)));
  const sorted = [...new Set(candidates.filter(end => Number.isSafeInteger(end) && end > 0 && end < text.length))].sort((a, b) => a - b);
  // Never split a surrogate pair; drop the oldest ends beyond the bound (they
  // have scrolled away and simply merge into the first piece).
  const safe = sorted.filter(end => !(/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])));
  const ends = [...safe.slice(Math.max(0, safe.length - (MAX_REPLY_PIECES - 1))), text.length];
  return { mode: policy === 'bubble-per-sentence' ? 'bubbles' : 'paragraphs', ends };
}

/** Host-side shape check; pieces describe `text` and carry no other capability. */
export function validReplyPieces(value: unknown, text: string): value is PetReplyPieces {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pieces = value as PetReplyPieces;
  if (Object.keys(pieces).some(key => key !== 'mode' && key !== 'ends') || !['paragraphs', 'bubbles'].includes(pieces.mode)) return false;
  const ends = pieces.ends;
  if (!Array.isArray(ends) || !ends.length || ends.length > MAX_REPLY_PIECES || ends.at(-1) !== text.length) return false;
  let previous = 0;
  for (const end of ends) {
    if (!Number.isSafeInteger(end) || end <= previous || end > text.length) return false;
    previous = end;
  }
  return true;
}

export interface PlannedReplyPiece {
  start: number; end: number;
  /** Exact source slices: lead + core + trail === text.slice(start, end). */
  lead: string; core: string; trail: string;
  /** Whitespace-only piece; rendered hidden, kept for exact text. */
  blank: boolean;
  /** Paragraph mode: preceded by a blank line in the original. */
  gap: boolean;
}

/** Pure layout plan; the native preload only turns it into nodes. */
export function planReplyPieces(text: string, pieces: PetReplyPieces): PlannedReplyPiece[] {
  const planned: PlannedReplyPiece[] = [];
  let start = 0;
  for (const end of pieces.ends) {
    const slice = text.slice(start, end);
    // Paragraph mode keeps indentation; a bubble never starts with whitespace.
    const lead = (pieces.mode === 'bubbles' ? /^\s*/u : /^(?:[ \t]*(?:\r\n|\r|\n))*/u).exec(slice)![0];
    const rest = slice.slice(lead.length);
    const trail = /\s*$/u.exec(rest)![0];
    const core = rest.slice(0, rest.length - trail.length);
    planned.push({ start, end, lead, core, trail, blank: !core,
      gap: pieces.mode === 'paragraphs' && planned.length > 0 && (lead.match(/\r\n|\r|\n/g)?.length ?? 0) >= 2 });
    start = end;
  }
  return planned;
}
