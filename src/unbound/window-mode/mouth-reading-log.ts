/**
 * 嘴型记录 (2026-11-22): what her mouth did while she read
 * one reply aloud on the window's Unbound engine, for the experience journal (shared/stage/journal-entries.ts 'mouth-reading'; the host writes
 * it only while the journal is on). Numbers and closed words only:
 *  - a stretch is one held "she is speaking" (the mouth's SpeechHold: a stream's short stalls are one stretch), about a sentence;
 *  - per stretch: the expression that held her face for most of its frames ('none' when none did), the widest her lips parted as a share of
 *    that model's own あ at full (UnboundMouth.lastReading.aa), and whether the floor or the ceiling held the flap at any frame.
 * A reply's line is handed out when its speaking is released (ended, cancelled, a new reply) or after QUIET_S of silence, whichever first;
 * never twice. Pure: no DOM, no clock of its own (frames carry dt).
 */
import { MOUTH_READING_MAX, MOUTH_READING_WORDS, type MouthReadingSentence, type MouthReadingWord } from '../../../shared/stage';
import type { ShowcaseFace } from '../motion/generator';
import type { MouthReading } from '../mouth';

/** Silence after which the reply's line is handed out even without a release. */
export const QUIET_S = 3;
/** An expression counts as holding her face from this much of its showcase weight. */
const HOLDS = 0.1;

const FACE_KEY: Readonly<Record<Exclude<MouthReadingWord, 'none'>, keyof ShowcaseFace>> = {
  'confirm-smile': 'confirm', 'warm-smile': 'warm', laugh: 'laugh', pout: 'pout', shy: 'shy', surprise: 'surprise', sly: 'sly', content: 'content', yawn: 'yawn',
};

/** The expression holding her face most in these showcase faces (an asked expression, her reply's beats): the strongest at or over HOLDS. */
export function dominantExpression(...faces: readonly (Readonly<ShowcaseFace> | null | undefined)[]): MouthReadingWord {
  let best: MouthReadingWord = 'none', weight = HOLDS;
  for (const face of faces) if (face) for (const word of MOUTH_READING_WORDS) {
    if (word === 'none') continue;
    const value = face[FACE_KEY[word]];
    if (typeof value === 'number' && value >= weight) { weight = value; best = word; }
  }
  return best;
}

export interface MouthReadingEntry { readonly sentences: MouthReadingSentence[] }

export class MouthReadingLog {
  private sentences: MouthReadingSentence[] = [];
  private open: { frames: Map<MouthReadingWord, number>; peak: number; floor: boolean; ceiling: boolean } | null = null;
  private quiet = 0;

  constructor(private readonly report: (entry: MouthReadingEntry) => void) {}

  /** One drawn frame: whether the held "she is speaking" is on, what the mouth showed, and which expression holds her face. */
  frame(dt: number, voiced: boolean, reading: Readonly<MouthReading> | null | undefined, word: MouthReadingWord): void {
    if (voiced && reading) {
      this.quiet = 0;
      const open = this.open ??= { frames: new Map(), peak: 0, floor: false, ceiling: false };
      open.frames.set(word, (open.frames.get(word) ?? 0) + 1);
      if (Number.isFinite(reading.aa)) open.peak = Math.max(open.peak, reading.aa);
      open.floor ||= reading.floored; open.ceiling ||= reading.capped;
      return;
    }
    this.close();
    if (!this.sentences.length) return;
    this.quiet += Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.quiet >= QUIET_S) this.flush();
  }

  /** Her speaking of a reply was released (ended, cancelled, a new reply): what was read so far is one line. */
  release(): void { this.close(); this.flush(); }

  /** The window went away or another model came: nothing is reported. */
  reset(): void { this.sentences = []; this.open = null; this.quiet = 0; }

  private close(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (this.sentences.length >= MOUTH_READING_MAX) return;
    let word: MouthReadingWord = 'none', most = -1;
    for (const [candidate, frames] of open.frames) if (frames > most) { most = frames; word = candidate; }
    this.sentences.push({ word, peak: Math.round(Math.min(2, open.peak) * 100) / 100, floor: open.floor, ceiling: open.ceiling });
  }

  private flush(): void {
    const sentences = this.sentences;
    this.sentences = []; this.quiet = 0;
    if (sentences.length) try { this.report({ sentences }); } catch { /* never blocks her frame */ }
  }
}
