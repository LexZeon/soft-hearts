/**
 * 边说边演第 2 步：拍子从"过滤后的字"挪到"真正显示出来的字"上。
 *
 * 过滤器（choose.ts）在回复的最前面去掉标记，拍子的 at 是过滤后那串字里的位置。之后这串字还要经过回复协议（开头标记前的草稿、
 * 尾注、草稿拦截）和强调符号的处理，气泡、朗读、聊天记录拿到的是处理后的字（"显示的字"），可能比过滤后的少一截。
 * 这里把两串字对齐（显示的字基本是过滤后的字的子序列，逐字向前找），算出每一拍在显示的字里的位置：
 * 拍子落在"过滤后位置 >= at 的第一个显示出来的字"前面；回复结束时还没落下的，落在显示的字的末尾。
 *
 * 纯的：不碰时钟、不调用模型。对不上的字（比如草稿被整段拦下后补的一句）不前进对齐位置，只是拍子的时间偏一点，不会漏字。
 */
import type { SpeechBeat, SpeechBeatChunk } from './interface';
import { isCloseBeatWord, isFrameBeatWord, keptBeat } from './choose';

/**
 * The beat at its place in the shown text (I-175: her "how long" goes with it). 2026-11-23: a kiss / hug
 * sits right after the last SPOKEN character of the words before it, not after the line break or spaces that follow them (`blank`): the reading,
 * and the bubble that follows it, stop at the last spoken character, so a beat placed after the blank would wait for progress that never comes
 * while its own words wait for the beat. I-203: the frames the same (a hug-held or a pause holds the words after it; a let-go is reached there).
 */
const moved = (beat: SpeechBeat, shownAt: number, blank = 0): SpeechBeat =>
  keptBeat(beat, isCloseBeatWord(beat.word) || isFrameBeatWord(beat.word) ? Math.max(0, shownAt - blank) : shownAt);

/** A character she can say or show (the same line as choose.ts performanceOnly), and the reply protocol's own markers (never shown). */
const SPOKEN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const PROTOCOL_MARK = /<\/?sh-[^>]*>?/gu;

export class SpeechBeatPlacer {
  private filtered = '';
  private pointer = 0;
  private shownLength = 0;
  /** How many whitespace characters end the shown text so far. */
  private blank = 0;
  private readonly pending: SpeechBeat[] = [];
  private ended = false;

  /** 过滤器吐出的一段（字和这一段里新出现的拍子，位置是过滤后的）。 */
  input(chunk: SpeechBeatChunk): void {
    if (this.ended) return;
    this.filtered += chunk.text;
    for (const beat of chunk.beats) this.pending.push(beat);
  }

  /** 一段真正要显示的字（在它被显示之前调用）：返回这段字前面落下的拍子，位置是显示的字里的。 */
  shown(delta: string): SpeechBeat[] {
    const out: SpeechBeat[] = [];
    if (this.ended || typeof delta !== 'string') return out;
    for (let i = 0; i < delta.length; i += 1) {
      const j = this.filtered.indexOf(delta[i], this.pointer);
      if (j >= 0) {
        while (this.pending.length && this.pending[0].at <= j) out.push(moved(this.pending.shift()!, this.shownLength, this.blank));
        this.pointer = j + 1;
      }
      this.shownLength += 1;
      this.blank = /\s/.test(delta[i]) ? this.blank + 1 : 0;
    }
    return out;
  }

  /**
   * 先后顺序（2026-11-23）：后面的字要等一个动作时，过滤后位置 <= `at` 的拍子现在就落下（落在已经显示的字的末尾），不等后面的字显示。
   */
  reach(at: number): SpeechBeat[] {
    const out: SpeechBeat[] = [];
    if (this.ended) return out;
    while (this.pending.length && this.pending[0].at <= at) out.push(moved(this.pending.shift()!, this.shownLength, this.blank));
    return out;
  }

  /**
   * 2026-11-25 (K14, docs/claude/2026-11-25-k14-hug-regression.md): spoken characters before filtered position `at` that the shown text has not
   * reached yet: something between the stream and the screen still holds them (a reply without its opening marker shows nothing until it is
   * complete), so the page cannot reach a beat at `at` before the reply ends. The protocol's own markers (`<sh-…>`) are never shown and do not count.
   */
  unshownBefore(at: number): boolean {
    if (!(at > this.pointer)) return false;
    return SPOKEN.test(this.filtered.slice(this.pointer, at).replace(PROTOCOL_MARK, ''));
  }

  /** 回复结束：还没落下的拍子落在末尾（只演不说的回复，拍子全在这里落下，位置都是 0）。之后不再接受。 */
  finish(): SpeechBeat[] {
    if (this.ended) return [];
    this.ended = true;
    return this.pending.splice(0).map(beat => moved(beat, this.shownLength, this.blank));
  }
}
