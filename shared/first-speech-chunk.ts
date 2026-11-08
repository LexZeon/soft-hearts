// I-029 朗读更早开口: two
// switchable ways to cut the FIRST piece a streaming Claude reply reads aloud (docs/claude/2026-11-04-i029-comma-first-reading.md).
//   'sentence' (default, unchanged): the first piece is the first complete sentence, as IncrementalReplySegments finds it.
//   'comma': the first piece may end at a comma inside that first sentence; everything after it is cut by whole sentences
//            exactly as before. Only the first piece of a reply is ever cut at a comma.
// This module only decides where pieces end. Display proof, leases, cloud claims, cancellation and "read once" stay with the
// host plan (electron/completed-reply-speech.ts), which treats a comma piece like any other piece.
import { IncrementalReplySegments, type IncrementalReplyOptions } from './incremental-reply-segments';
import { splitReplySegments, type ReplySegment } from './reply-segments';
import { speakableText } from './speakable-text';

export type FirstSpeechChunk = 'sentence' | 'comma';
export const firstSpeechChunk = (value: unknown): FirstSpeechChunk => value === 'comma' ? 'comma' : 'sentence';

/**
 * The first piece needs at least this many spoken units before its comma: a Chinese character counts 1, a Latin word or a
 * number counts 1, stage directions and punctuation count 0. "嗯，" "好呀，" "我想想，" stay with the words after them: such a
 * short piece saves almost nothing (it is on screen a moment after the first character) but adds a break right after the
 * first word.
 *   system voice: 4. Each piece is its own utterance; the next starts a moment after (about as between two sentences).
 *   Bailian: 8. The rest of the sentence is only requested once the first piece is audible (at most one segment ahead,
 *   R02), and its first audio takes about a second: a first piece shorter than that leaves a silence in the middle of the
 *   sentence. In the replay (scripts/first-chunk-replay.ts) 4–5 units left a 0.4 s median gap at the comma, 7+ almost none.
 */
export const FIRST_CHUNK_MIN_UNITS: Readonly<Record<'system' | 'bailian', number>> = Object.freeze({ system: 4, bailian: 8 });
/** The minimum for the voice that will read this reply (the TTS provider of the turn's settings; unknown = system). */
export const firstChunkMinUnits = (provider: unknown): number => provider === 'bailian' ? FIRST_CHUNK_MIN_UNITS.bailian : FIRST_CHUNK_MIN_UNITS.system;
/** `voice`: the turn's TTS provider ('system' / 'bailian'), which picks the minimum; `minUnits` overrides it (replay only). */
export interface FirstChunkOptions { mode: FirstSpeechChunk; voice?: unknown; minUnits?: number }
/** The first piece is never longer than the existing per-piece bound. */
const MAX_FIRST_CHUNK = 2_000;
const MAX_SEGMENTS = 128;

/**
 * Full-width comma and semicolon; ASCII ones only when a blank follows ("1,000" is a number). The enumeration comma "、" is
 * left out on purpose: it separates items of one list ("苹果、香蕉"), and a break there sounds like a stumble.
 */
const FULL_WIDTH_COMMA = new Set(['，', '；']);
const ASCII_COMMA = new Set([',', ';']);
const UNIT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9\u00C0-\u024F']+/gu;

/** Spoken units of `text` after stage directions are taken out (shared/speakable-text.ts, what the voices actually read). */
export function spokenUnits(text: string): number { return speakableText(text).match(UNIT)?.length ?? 0; }

/**
 * Whether the comma at `index` of `text` may end the first piece. Depends only on text[0..index] (and, for an ASCII comma,
 * the character after it), so the same reply is cut the same way however its stream is chunked.
 *   undefined: an ASCII comma at the very end; the next character decides.
 */
function commaCut(text: string, index: number, minUnits: number): boolean | undefined {
  const comma = text[index];
  if (ASCII_COMMA.has(comma)) {
    if (index + 1 >= text.length) return undefined;
    if (!/\s/u.test(text[index + 1])) return false;
  } else if (!FULL_WIDTH_COMMA.has(comma)) return false;
  const prefix = text.slice(0, index + 1);
  // An action between single asterisks that is still open ("*揉了揉眼睛，") would be read aloud: speakableText only takes
  // out a complete pair. Brackets are fine: an open "（" already hides the rest of its line from the voice.
  if ((prefix.match(/\*/gu)?.length ?? 0) % 2 === 1) return false;
  if (spokenUnits(prefix) < minUnits) return false;
  // Structure: a comma may end the first piece only where a full stop would have ended a sentence (the same parser as every
  // other piece: not in code, a link, a list item, a heading, a table or a quoted block) and nothing ended a sentence earlier.
  let probe: ReplySegment[];
  try { probe = splitReplySegments(text.slice(0, index) + '。文'); } catch { return false; }
  return probe.length >= 2 && probe[0].end === index + 1;
}

/**
 * The end of the first piece in comma mode, or null when there is none (yet). `limit`: the comma must come before it (the
 * end of the first sentence, once the sentence parser found it). `from`: commas before it were already judged.
 */
export function firstCommaCut(text: string, limit = text.length, from = 0, minUnits = FIRST_CHUNK_MIN_UNITS.system): { end: number | null; judged: number } {
  const bound = Math.min(limit, text.length, MAX_FIRST_CHUNK);
  let judged = from;
  for (let index = from; index < bound; index++) {
    const verdict = commaCut(text, index, minUnits);
    if (verdict === undefined) return { end: null, judged };
    judged = index + 1;
    if (verdict && index + 1 < limit) return { end: index + 1, judged };
  }
  return { end: null, judged };
}

/**
 * Same contract as IncrementalReplySegments (push/finish/cancel, contiguous original slices, never replays issued text),
 * with the first piece cut at a comma when firstCommaCut finds one inside the first sentence.
 */
export class FirstCommaReplySegments {
  private readonly inner: IncrementalReplySegments;
  private text = '';
  /** End of the last piece handed out. */
  private issued = 0;
  /** The comma decision is final: a comma piece was cut, or the first sentence came out whole. */
  private decided = false;
  private judged = 0;
  private readonly minUnits: number;
  constructor(options: IncrementalReplyOptions & { minUnits?: number } = {}) {
    this.minUnits = Number.isSafeInteger(options.minUnits) && options.minUnits! > 0 ? options.minUnits! : FIRST_CHUNK_MIN_UNITS.system;
    // One piece more than the sentence parser may hand out: keep the reply's total within the same bound.
    this.inner = new IncrementalReplySegments({ maxReplyChars: options.maxReplyChars, maxSegments: Math.max(1, (options.maxSegments ?? MAX_SEGMENTS) - 1) });
  }
  push(delta: string): ReplySegment[] {
    const pieces = this.inner.push(delta);
    if (typeof delta === 'string') this.text += delta;
    return this.merge(pieces, false);
  }
  finish(): ReplySegment[] { return this.merge(this.inner.finish(), true); }
  cancel(): void { this.inner.cancel(); this.decided = true; }

  private merge(pieces: ReplySegment[], final: boolean): ReplySegment[] {
    const out: ReplySegment[] = [];
    if (!this.decided) {
      // Before the sentence parser hands out anything, every comma seen so far is inside the first sentence.
      const limit = pieces.length ? pieces[0].end : this.text.length + (final ? 0 : 1);
      const found = firstCommaCut(this.text, limit, this.judged, this.minUnits);
      this.judged = found.judged;
      if (found.end !== null) {
        out.push({ start: 0, end: found.end, text: this.text.slice(0, found.end) });
        this.issued = found.end; this.decided = true;
      } else if (pieces.length || final) this.decided = true;
    }
    for (const piece of pieces) {
      if (piece.end <= this.issued) continue;
      const start = Math.max(piece.start, this.issued);
      out.push({ start, end: piece.end, text: this.text.slice(start, piece.end) });
      this.issued = piece.end;
    }
    return out;
  }
}

/** The host's per-reply parser for the chosen mode; 'sentence' is exactly the parser used before I-029. */
export function replySpeechParser(first: FirstChunkOptions, options: IncrementalReplyOptions): IncrementalReplySegments | FirstCommaReplySegments {
  return first.mode === 'comma' ? new FirstCommaReplySegments({ ...options, minUnits: first.minUnits ?? firstChunkMinUnits(first.voice) })
    : new IncrementalReplySegments(options);
}
