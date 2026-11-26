/**
 * I-175 "做多久"（方案「"做多久"」，第 4 条按推荐：不写时照现在）。
 *  - reply（不写）：和现在一样，挂到同一条通道的下一拍接手，或这条回复说完（保险上限 SPEECH_BEAT_TIMING.holdCapMs = 12 秒）；
 *  - once（一下）：这一拍自己的时长（表情约 2.2 秒），不挂；
 *  - line（这一句）：挂到这句话念完的那个停顿：朗读开着时下一段开始念（或这条念完），关着时这句话显示完、下一句开始出来。
 * 身体的词（歪头、手放脸边、比 V、凑近、退开）本来就不挂，写了也照它自己的短时长。
 * 纯的：不碰时钟；位置是去掉标记以后显示的字里的下标。
 */
import type { SpeechBeatHow } from './interface';

/** What a stage's hold gets for a beat: false (not held: its own duration), true (held to the reply's end), 'line' (held to this sentence's pause). */
export type BeatHold = boolean | 'line';

/**
 * The hold a beat gets. `how`: the marker's suffix (undefined: none). `spanHolds`: today's rule says this reply's beats ride her speaking
 * (SpeechSpan.hold: not a performance-only reply, not finished). once → never held; line → 'line' where today's rule would hold; none → as today.
 */
export function beatHold(how: SpeechBeatHow | undefined, spanHolds: boolean): BeatHold {
  if (how === 'once') return false;
  if (how === 'line') return spanHolds ? 'line' : false;
  return spanHolds;
}

const SENTENCE_END = /[。！？!?…~～\n]/u;
const CLOSERS = /[」』”’）)】〗"'\s]/u;
/**
 * Where the sentence that holds position `at` ends in `text`: just past its closing punctuation (and any closing quotes or brackets right
 * after it), or the text's length when it has not ended yet. A sentence is what reads as one: 。！？!?… a newline, or a trailing ～.
 */
export function sentenceEndAfter(text: string, at: number): number {
  const value = typeof text === 'string' ? text : '';
  const start = Number.isSafeInteger(at) ? Math.min(Math.max(0, at), value.length) : 0;
  for (let k = start; k < value.length; k++) {
    if (!SENTENCE_END.test(value[k])) continue;
    let end = k + 1;
    while (end < value.length && (SENTENCE_END.test(value[end]) || CLOSERS.test(value[end]))) end++;
    return end;
  }
  return value.length;
}

/**
 * The 'line' holds of one reply: when a 'line' beat plays, its sentence's end is remembered; `reached(position)` says once that the reading
 * (the start of the segment read now) or the bubble (the length shown) has gone past it, so the stage lets the line's beats fall. A new
 * reply or a cancel: `clear()`.
 */
export class LineHolds {
  private end: number | null = null;
  private at = 0;
  private text = '';

  /** The reply's text as known now (it grows while it streams; a line still being written ends where the text ends for now). */
  setText(text: string): void { this.text = typeof text === 'string' ? text : ''; }
  /** A 'line' beat at `at` just played (a later one in the same reply moves the end to its own sentence). */
  hold(at: number): void { this.at = Number.isSafeInteger(at) && at >= 0 ? at : 0; this.end = sentenceEndAfter(this.text, this.at); }
  /** Something is held to a line end now. */
  get holding(): boolean { return this.end !== null; }

  /**
   * The reading or the bubble is at `position`: true once when it went past the held line's end (the beats fall now). `segment`: the reading
   * started a segment at `position` (it counts at or past the end), else the bubble shows `position` characters (the sentence is over once a
   * character after its end shows; a sentence still being written is not over).
   */
  reached(position: number, segment = false): boolean {
    if (this.end === null || !Number.isFinite(position)) return false;
    this.end = sentenceEndAfter(this.text, this.at); // the text may have grown since the beat
    if (segment ? position < this.end : position <= this.end) return false;
    this.end = null;
    return true;
  }

  clear(): void { this.end = null; this.at = 0; this.text = ''; }
}
