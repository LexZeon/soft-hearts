/**
 * I-091 step 1, I-204: the user talked over her reading during a call. The reply being read is marked interrupted once, at the point
 * her voice stopped, and the user's next utterance gets one private line saying so (shared/voice/call-cut-note.ts): where she was cut,
 * what she had said aloud, the unspoken rest she had meant to say, and the user's line that cut her.
 *
 * Where her voice is: the reading window reports each sentence's start and end (noteReplySpeechHeard), and the host gives the sentence's
 * place in the reply text; the ledger keeps them for the reply being read only. The same places give the echo check its window: the
 * sentence she is reading and the one before it (her own voice is judged against what she is saying now).
 *
 * Marking never archives, rewards or changes the reply: it was archived and rewarded once when it settled. The unspoken rest is only
 * information in her next turn's private context: never read on, shown or archived. A late mark for an older reply (a newer one was
 * read since) is ignored, and the line is taken once.
 */
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { callCutNote, type CallCutPoint } from '../../../shared/voice/call-cut-note';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export type SentencePhase = 'start' | 'end' | 'skip' | 'over';
export interface SentenceRange { start: number; end: number }
interface Sentence extends SentenceRange { ended: boolean }
/** Characters after the sentence she is reading that the echo window also covers (her next sentence may start before its 'start' arrives). */
const ECHO_AHEAD = 12;
const LINE_MAX = 400;

export class InterruptionLedger {
  /** The newest reply read aloud in this call (the only one that can be interrupted now). */
  private reading: string | null = null;
  /** Sentences of `reading` the reading window reported, by index. */
  private readonly sentences = new Map<number, Sentence>();
  private readonly marked = new Set<string>();
  private pending: { replyId: string; point: CallCutPoint; line: string } | null = null;

  /** A reply's reading was authorized in the call (the host's 'speech' event for it). */
  noteReading(replyId: string): void {
    if (!validId(replyId)) return;
    if (replyId !== this.reading) this.sentences.clear();
    this.reading = replyId;
  }

  /** The newest reply read aloud in this call, or null. */
  get current(): string | null { return this.reading; }

  /** The reading window says a sentence of `replyId` started or ended being heard (`range`: its place in the reply text, when known). */
  heard(replyId: unknown, index: unknown, phase: SentencePhase, range: SentenceRange | null): void {
    if (!validId(replyId) || replyId !== this.reading || !Number.isInteger(index) || (index as number) < 0 || (index as number) > 127) return;
    const at = index as number;
    if (phase === 'start') {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start) return;
      this.sentences.set(at, { start: range.start, end: range.end, ended: false });
    } else if (phase === 'end') { const sentence = this.sentences.get(at); if (sentence) sentence.ended = true; }
  }

  /** Where her voice is in the reply being read now: the last sentence the window reported (unknown when none). */
  point(): CallCutPoint {
    const latest = this.latest();
    if (!latest) return { known: false, saidEnd: 0, sentenceEnd: 0 };
    return latest.ended ? { known: true, saidEnd: latest.end, sentenceEnd: latest.end } : { known: true, saidEnd: latest.start, sentenceEnd: latest.end };
  }

  /** The stretch of `text` (the reply being read) the echo check compares against: the sentence before, this one, a little after. All of it when unknown. */
  echoWindow(text: string): string {
    const latest = this.latest();
    if (!latest || typeof text !== 'string') return typeof text === 'string' ? text : '';
    const before = this.sentences.get(this.latestIndex() - 1);
    return text.slice(Math.min(before?.start ?? latest.start, latest.start), Math.min(text.length, latest.end + ECHO_AHEAD));
  }

  /** The user talked over her reading of `replyId` (`line`: what they said): true when this marked it (first time, and it is the newest reading). */
  mark(replyId: unknown, line = ''): boolean {
    if (!validId(replyId) || replyId !== this.reading || this.marked.has(replyId)) return false;
    this.marked.add(replyId);
    if (this.marked.size > 64) this.marked.delete(this.marked.values().next().value!);
    this.pending = { replyId, point: this.point(), line: typeof line === 'string' ? line.slice(0, LINE_MAX) : '' };
    return true;
  }

  /**
   * The private line for the next utterance's first request, once; '' when nothing was interrupted (or the window had reported the
   * reply's last sentence finished: nothing was cut). `text` gives the cut reply's written text (null: unknown, then only "cut, where
   * unknown" and the user's line are told).
   */
  takeNote(text: (replyId: string) => string | null, language?: CardLanguage | null): string {
    const pending = this.pending;
    if (!pending) return '';
    this.pending = null;
    let written: string | null = null;
    try { written = text(pending.replyId); } catch { written = null; }
    const known = pending.point.known && typeof written === 'string' && written.length > 0;
    return callCutNote({ ...pending.point, known, text: known ? written! : '', userLine: pending.line }, language);
  }

  /** The call ended: nothing carries over to a later conversation. */
  clear(): void { this.reading = null; this.pending = null; this.marked.clear(); this.sentences.clear(); }

  private latestIndex(): number { let index = -1; for (const key of this.sentences.keys()) if (key > index) index = key; return index; }
  private latest(): Sentence | null { return this.sentences.get(this.latestIndex()) ?? null; }
}
