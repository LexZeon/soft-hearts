/**
 * 边说边演，Unbound 引擎（Unbound 模式和 Unbound 桌宠窗口共用）：一个表情、看向或眼神挂着，直到同一条通道的下一拍接手，
 * 或者这条回复说完（shared/behaviors/speech-beats/span.ts 报），或者到保险上限（SPEECH_BEAT_TIMING.holdCapMs）。
 *
 * 做法：展示的演员（showcase/performer.ts）里每一拍有自己的 dur，到点就按自己的缓出落下去（表情有各自的 release，看向交给第 3 层的弹簧）。
 * 挂着的拍子一开始把 dur 拉长到上限；放手时把 dur 改成"到现在"，演员就从这一刻起照常落下去，不跳（表情的包络在 dur 处连续）。
 * 身体的词（歪头、手放脸边、比 V、退开）不挂：它们有自己的短动作时长（一个 V 挂几句话会像卡住）。
 * I-192 例外——她凑过来以后停着，至少 ARRIVAL_KNOBS.leanInHoldS 秒，她这句还没说完就一直停着
 * （到 holdCapS 为止），然后她自己慢慢退回（shared/unbound/arrival/knobs.ts）。
 * 纯的：没有 DOM、没有 three.js。
 */
import { SPEECH_BEAT_MEANINGS, SPEECH_BEAT_TIMING, type SpeechBeatChannel, type SpeechBeatWord } from '../../shared/brain'; // 边说边演 (shared/behaviors/speech-beats/)
import type { PlayedBeat } from './showcase/performer';
import { ARRIVAL_KNOBS } from '../../shared/unbound/arrival';

/** I-192: body words that stay while she speaks, each at least this long (s) once played (the close poses' own hold). */
export const HELD_BODY_WORDS: Readonly<Partial<Record<SpeechBeatWord, () => number>>> = Object.freeze({ 'lean-in': () => ARRIVAL_KNOBS.leanInHoldS });

/** The channels whose beats ride her speaking; the body's words keep their own short gesture time. */
const HELD_CHANNELS: ReadonlySet<SpeechBeatChannel> = new Set<SpeechBeatChannel>(['expression', 'gaze', 'eyes']);
export const holdsWithSpeech = (word: SpeechBeatWord): boolean => HELD_CHANNELS.has(SPEECH_BEAT_MEANINGS[word].channel);

export class HeldBeats {
  private held: { channel: SpeechBeatChannel; beat: PlayedBeat; line: boolean; minS: number }[] = [];

  /** True while a beat is held (the performer must stay up for it). */
  get any(): boolean { return this.held.length > 0; }

  /**
   * The beat just appended to the performer (`clock` is its clock now). Rides her speaking when it is a held channel's word and `span` is on
   * (I-175: 'line' = only to this sentence's pause, `releaseLine`); the earlier held beat of the same channel is let go at once (the later one
   * takes over, each with its own ease). Returns whether this one is held.
   */
  hold(word: SpeechBeatWord, beat: PlayedBeat, clock: number, span: boolean | 'line'): boolean {
    const channel = SPEECH_BEAT_MEANINGS[word].channel;
    // A later beat on the channel takes over the earlier one whether or not it is held itself.
    if (HELD_CHANNELS.has(channel)) {
      for (const entry of this.held) if (entry.channel === channel && entry.minS === 0) this.letGo(entry.beat, clock);
      this.held = this.held.filter(entry => entry.channel !== channel || entry.minS > 0);
    }
    const body = HELD_BODY_WORDS[word];
    if (body && span) { // I-192: the lean-in stays while she speaks (at least its own hold), up to the close poses' cap
      for (const entry of this.held) if (entry.minS > 0) this.letGo(entry.beat, clock, entry.minS);
      this.held = this.held.filter(entry => entry.minS === 0);
      beat.dur = ARRIVAL_KNOBS.holdCapS;
      this.held.push({ channel, beat, line: false, minS: body() });
      return true;
    }
    if (!span || !HELD_CHANNELS.has(channel)) return false;
    beat.dur = SPEECH_BEAT_TIMING.holdCapMs / 1000;
    this.held.push({ channel, beat, line: span === 'line', minS: 0 });
    return true;
  }

  /** Her speaking is over, or it was cancelled, or a new reply began: every held beat falls from now. */
  releaseAll(clock: number): void { for (const entry of this.held) this.letGo(entry.beat, clock, entry.minS); this.held = []; }
  /** I-175: the sentence of a 'line' beat reached its pause: the beats held to the line fall from now; the ones held to the reply stay. */
  releaseLine(clock: number): void {
    for (const entry of this.held) if (entry.line) this.letGo(entry.beat, clock);
    this.held = this.held.filter(entry => !entry.line);
  }

  /** The beat ends now (its own release ease, or the springs', takes it down from here), or at its own least hold (I-192). Never longer than it was. */
  private letGo(beat: PlayedBeat, clock: number, minS = 0): void { beat.dur = Math.max(0, Math.min(beat.dur, Math.max(minS, clock - beat.playedAt))); }
}
