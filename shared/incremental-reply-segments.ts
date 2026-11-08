import { splitReplySegments, type ReplySegment } from './reply-segments';

// Match the existing completed-reply speech admission bound. These helpers do
// not own playback, consent, style, display acknowledgements or segment leases.
const MAX_REPLY = 6_000;
const MAX_SEGMENTS = 128;
const MAX_DISPLAY = 100_000;

export class IncrementalReplyOverflow extends Error {
  constructor() { super('回复超出增量分句范围，请改用完整原文显示。'); this.name = 'IncrementalReplyOverflow'; }
}
export interface IncrementalReplyOptions { maxReplyChars?: number; maxSegments?: number }

function closedQuotes(text: string): boolean {
  const opens = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['〈', '〉']]);
  const closes = new Set(opens.values());
  const stack: string[] = []; let doubleQuote = false, escaped = false;
  for (const c of text) {
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { doubleQuote = !doubleQuote; continue; }
    const end = opens.get(c); if (end) stack.push(end);
    else if (closes.has(c) && stack.at(-1) === c) stack.pop();
  }
  return !doubleQuote && stack.length === 0;
}

/** Receives only actual visible protocol deltas from one owned reply. */
export class IncrementalReplySegments {
  private pending = '';
  private offset = 0;
  private total = 0;
  private count = 0;
  private closed = false;
  private readonly maxReplyChars: number;
  private readonly maxSegments: number;

  constructor(options: IncrementalReplyOptions = {}) {
    this.maxReplyChars = options.maxReplyChars ?? MAX_REPLY;
    this.maxSegments = options.maxSegments ?? MAX_SEGMENTS;
    if (![this.maxReplyChars, this.maxSegments].every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_DISPLAY))
      throw new RangeError('增量分句限制无效。');
  }

  push(delta: string): ReplySegment[] {
    if (this.closed) return [];
    if (typeof delta !== 'string') throw new TypeError('回复增量必须是字符串。');
    if (this.total + delta.length > this.maxReplyChars) return this.overflow();
    this.pending += delta;
    this.total += delta.length;
    return this.drain(false);
  }

  /** Only call on the actual successful provider completion. */
  finish(): ReplySegment[] {
    if (this.closed) return [];
    const output = this.drain(true);
    this.closed = true;
    return output;
  }

  /** Issued segments belong to their existing host leases; never replay tail. */
  cancel(): void { this.closed = true; this.pending = ''; }

  private overflow(): never { this.cancel(); throw new IncrementalReplyOverflow(); }

  private drain(final: boolean): ReplySegment[] {
    if (!this.pending) return [];
    let parts: ReplySegment[];
    try { parts = splitReplySegments(this.pending); } catch { return this.overflow(); }
    let count = final ? parts.length : Math.max(0, parts.length - 1);
    // Existing parser deliberately waits for following content. For an actual
    // complete CJK sentence at the current edge, a non-emitted lookahead lets
    // the same parser decide whether it is prose (not code, list or a link).
    // Unclosed quotes wait for their real closer. No lookahead enters a result.
    if (!final && /[。！？]["'”’」』）)\]】》〉»]*$/u.test(this.pending) && closedQuotes(this.pending)) {
      let probe: ReplySegment[];
      try { probe = splitReplySegments(this.pending + '文'); } catch { return this.overflow(); }
      if (probe.length > 1 && probe.at(-2)?.end === this.pending.length) count = parts.length;
    }
    if (this.count + count > this.maxSegments) return this.overflow();
    const output = parts.slice(0, count).map(part => ({ start: this.offset + part.start,
      end: this.offset + part.end, text: part.text }));
    if (output.length) {
      const used = parts[count - 1].end;
      this.pending = this.pending.slice(used); this.offset += used; this.count += count;
    }
    return output;
  }
}
