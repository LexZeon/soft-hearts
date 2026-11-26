/**
 * 边说边演：一条回复"她说话说到哪里为止"（纯的：时间由调用的人传进来，测试用假时钟）。
 *
 * 一个表情、看向或眼神演起来以后挂着，直到同一条通道的下一拍接手，或者这条回复说完；这里只回答"说完了没有"，
 * 挂多久、怎么落由各个舞台自己的缓动管（旧舞台 src/stage/speech-beat-overlay.ts、Unbound src/unbound/speech-beat-hold.ts）。
 *
 * 什么算说完（同一条回复）：
 *  - 朗读开着而且念出来了：流完了、全文都念到了，最后一段按每字估计的时间念完，再加 spanGraceMs。念到一半没有后续的段，等 voiceGraceMs 后也算。
 *  - 朗读关着（或开着却一直没念）：流完了、气泡把字都显示完了，再加 spanGraceMs。
 *  - 只演不说：没有"说"，不挂着（挂着的时间由每拍自己的时长管）：这里永远不报说完，hold() 为 false。
 *  - 停止、清空、出错、新的回复：马上算结束（cancel / begin 的返回值），调用的人立刻让挂着的落下去，不补演。
 */
import { SPEECH_BEAT_TIMING, type SpeechBeatTimingKnobs } from './knobs';
import type { SpeechBeatPacing } from './schedule';

interface Span {
  id: string; pacing: SpeechBeatPacing; text: string; shownLength: number; shownAt: number; total: number | null; doneAt: number | null;
  voiced: boolean; voicedFrom: number; voicedAt: number; voicedLength: number; performanceOnly: boolean; finished: boolean;
}

export class SpeechSpan {
  private span: Span | null = null;

  constructor(private readonly knobs: SpeechBeatTimingKnobs = SPEECH_BEAT_TIMING) {}

  get replyId(): string | null { return this.span?.id ?? null; }
  /** I-175: where the segment being read now starts in the reply's text (null: not reading this reply). */
  get readingFrom(): number | null { const span = this.span; return span && span.voiced ? span.voicedFrom - span.voicedLength : null; }

  /** 这条回复的拍子要不要"挂着"：只演不说的不挂（每拍按自己的时长）；没有这条回复也不挂。 */
  hold(replyId?: string): boolean { return !!this.span && (replyId === undefined || replyId === this.span.id) && !this.span.performanceOnly && !this.span.finished; }

  /** 新的一条回复开始。 */
  begin(replyId: string, pacing: SpeechBeatPacing, now: number): void {
    this.span = { id: replyId, pacing, text: '', shownLength: 0, shownAt: now, total: null, doneAt: null, voiced: false, voicedFrom: 0, voicedAt: now,
      voicedLength: 0, performanceOnly: false, finished: false };
  }

  text(replyId: string, full: string): void { const span = this.current(replyId); if (span && typeof full === 'string') span.text = full; }

  shown(replyId: string, length: number, now: number): void {
    const span = this.current(replyId);
    if (span && Number.isFinite(length) && length > span.shownLength) { span.shownLength = length; span.shownAt = now; }
  }

  /** 朗读开始念一段（这段的字）。找不到这段在全文里的位置时不算（和 schedule.ts 的 voiced 同一个找法）。 */
  voiced(replyId: string, segment: string, now: number): void {
    const span = this.current(replyId);
    if (!span || span.pacing !== 'voice' || typeof segment !== 'string') return;
    const piece = segment.trim();
    if (!piece) return;
    let start = span.text.indexOf(piece, span.voicedFrom);
    if (start < 0) start = span.text.indexOf(piece);
    if (start < 0) return;
    span.voiced = true; span.voicedFrom = start + piece.length; span.voicedAt = now; span.voicedLength = piece.length;
  }

  done(replyId: string, total: number, now: number): void {
    const span = this.current(replyId);
    if (span && Number.isFinite(total)) { span.total = Math.max(0, total); span.doneAt = now; }
  }

  performanceOnly(replyId: string): void { const span = this.current(replyId); if (span) span.performanceOnly = true; }

  /** 停止、清空、出错（不给 id 就是当前那条）：这条算结束，不再报说完（调用的人自己马上放手）。 */
  cancel(replyId?: string): void { if (this.span && (replyId === undefined || replyId === this.span.id)) this.span.finished = true; }

  /** 这条回复刚刚说完了吗？每条回复最多真一次。 */
  ended(now: number): boolean {
    const at = this.endsAt();
    if (at === null || now < at) return false;
    this.span!.finished = true;
    return true;
  }

  /** 说完的时间（估计）；还不知道时 null（定时用）。 */
  endsAt(): number | null {
    const span = this.span;
    if (!span || span.finished || span.performanceOnly || span.doneAt === null || span.total === null) return null;
    const grace = this.knobs.spanGraceMs;
    const shownAll = span.shownLength >= span.total;
    if (span.pacing === 'voice' && span.voiced) {
      const segmentEnds = span.voicedAt + span.voicedLength * this.knobs.voiceMsPerChar;
      // The last segment read to the end of the text; else a later segment may still come: wait that long more, then call it over.
      return span.voicedFrom >= span.total ? segmentEnds + grace : segmentEnds + this.knobs.voiceGraceMs;
    }
    if (!shownAll) return null;
    // Read-aloud off (or on and never read): the words all shown, then a moment. A read-aloud reply that was never read waits the grace for the reading to begin.
    const shown = Math.max(span.doneAt, span.shownAt);
    return shown + (span.pacing === 'voice' ? this.knobs.voiceGraceMs : 0) + grace;
  }

  private current(replyId: string): Span | null { return this.span && this.span.id === replyId ? this.span : null; }
}
