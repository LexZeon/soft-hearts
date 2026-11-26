/**
 * 边说边演第 3 步，窗口这边（记录 docs/claude/2026-11-20-speech-beats-2-4.md）。两个窗口都有一份：
 *  - 都做：记住主机说的这条回复的 final（只演不说吗、灰色小字、进她历史的字），聊天页显示灰色小字、历史用这段字。
 *  - 桌宠窗口还做：跟着朗读（朗读开着）或气泡的字（朗读关着）把拍子交给舞台演（shared/behaviors/speech-beats/schedule.ts 定时间）。
 *    新的回复开始、停止、清空、出错时，没演的全部作废，不补演。
 * 挂着（2026-11-20，可以跨句子）：表情、看向、眼神的拍子演起来以后挂着，到同一条通道的下一拍接手，或这条回复说完
 * （shared/behaviors/speech-beats/span.ts 判断：念完，或朗读关着时字显示完），或保险上限；停止、出错、新的回复马上放手。
 * 只演不说的回复不挂（每拍按自己的时长）。放手后怎么落、怎么接手是各个舞台自己的缓动。
 * 只是显示和表演：这里从不改回复、不改存档、不调用主机。
 */
import { SpeechBeatSchedule, type SpeechBeatPacing } from '../../shared/behaviors/speech-beats/schedule';
import { SpeechSpan } from '../../shared/behaviors/speech-beats/span';
import type { StreamEvent } from '../../shared/brain/stream-event';
import type { SpeechBeatRelease, SpeechBeatsEvent } from '../../shared/behaviors/speech-beats/interface';
import { LineHolds, beatHold, type BeatHold } from '../../shared/behaviors/speech-beats/how-long';
import { isSpeechBeatHow } from '../../shared/behaviors/speech-beats/choose';

/**
 * A call's 'beats' event from the voice host (desk:voice-conversation) as the stream event the chat wiring already takes for typed chat, so a call's beats
 * and final go through the same receive. Null for anything else, or one without a reply id.
 */
export function beatsStreamEvent(event: { type?: unknown; replyId?: unknown; speechBeats?: unknown }): StreamEvent | null {
  if (event?.type !== 'beats' || typeof event.replyId !== 'string' || !event.replyId || !event.speechBeats || typeof event.speechBeats !== 'object') return null;
  return { id: event.replyId, kind: 'chat', type: 'beats', text: '', speechBeats: event.speechBeats as SpeechBeatsEvent };
}

export interface SpeechBeatsViewPorts {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /**
   * The companion window: one word to her stage. `span`: it stays up while she speaks (released by `release`); I-175: 'line' only to this
   * sentence's pause (released by `release('line')`), false for her "once". Absent (the control window): nothing is performed here.
   */
  perform?(word: string, span: BeatHold): void;
  /** Her speaking of this reply is over, or it was cancelled, or a new reply began: what stayed up falls now. */
  release?(reason: SpeechBeatRelease): void;
  /** Read-aloud on for this reply ('voice') or not ('shown'). Read when the reply starts. */
  pacing(): SpeechBeatPacing;
  /** I-195: a small grey line under this reply (the chat page only): she left herself an alarm. */
  note?(replyId: string, line: string): void;
}

type Final = NonNullable<SpeechBeatsEvent['final']>;
const KEEP_FINALS = 24;

export class SpeechBeatsView {
  private readonly schedule = new SpeechBeatSchedule();
  private readonly span = new SpeechSpan();
  private readonly finals = new Map<string, Final>();
  private timer: unknown = null;
  /** I-175: her 'line' beats ("只带这一句") fall at their sentence's pause: the reading reaches the next segment, or the bubble the next sentence. */
  private readonly lines = new LineHolds();
  private pacingNow: SpeechBeatPacing = 'shown';
  private shownNow = 0;

  constructor(private readonly ports: SpeechBeatsViewPorts) {}

  /** A reply starts in this window (desk:chat-started): an earlier reply's beats that did not play are dropped. */
  begin(replyId: string): void {
    if (!this.ports.perform) return;
    const pacing = this.ports.pacing() === 'voice' ? 'voice' : 'shown';
    this.release('new'); // the earlier reply's held beats fall now (and what waited for a pause is dropped, I-175)
    this.lines.clear(); this.pacingNow = pacing; this.shownNow = 0;
    this.schedule.begin(replyId, pacing, this.ports.now());
    this.span.begin(replyId, pacing, this.ports.now());
    this.flush();
  }

  /** A 'beats' stream event from the host. */
  receive(event: StreamEvent): void {
    if (event?.kind !== 'chat' || event.type !== 'beats' || typeof event.id !== 'string') return;
    const payload = event.speechBeats;
    if (typeof payload?.note === 'string' && payload.note) { try { this.ports.note?.(event.id, payload.note); } catch { /* a line under the reply never breaks the chat */ } } // I-195: "（她记了件事）"
    if (Array.isArray(payload?.beats) && this.ports.perform) this.schedule.add(event.id, payload.beats.filter(beat => typeof beat?.word === 'string' && Number.isSafeInteger(beat.at)), this.ports.now());
    const final = payload?.final;
    if (final && typeof final.performanceOnly === 'boolean') {
      this.finals.set(event.id, { performanceOnly: final.performanceOnly, line: typeof final.line === 'string' ? final.line : '', history: typeof final.history === 'string' ? final.history : null });
      while (this.finals.size > KEEP_FINALS) this.finals.delete(this.finals.keys().next().value!);
      if (final.performanceOnly && this.ports.perform) { this.schedule.performanceOnly(event.id, this.ports.now()); this.span.performanceOnly(event.id); }
    }
    this.flush();
  }

  /** The bubble shows `prefix` of `full` (src/wiring/chat-view-wiring.ts renderReadout). */
  shown(replyId: string, prefix: string, full: string): void {
    if (!this.ports.perform) return;
    this.schedule.text(replyId, full);
    this.schedule.shown(replyId, prefix.length, this.ports.now());
    this.span.text(replyId, full);
    this.span.shown(replyId, prefix.length, this.ports.now());
    if (replyId === this.span.replyId) { this.lines.setText(full); this.shownNow = prefix.length; }
    this.flush();
  }

  /** A fact from the voice output: a segment is being heard now (key `${replyId}#…`). */
  voiced(cue: unknown): void {
    if (!this.ports.perform || !cue || typeof cue !== 'object') return;
    const { kind, key, text, voiced } = cue as { kind?: unknown; key?: unknown; text?: unknown; voiced?: unknown };
    if (kind !== 'start' || voiced !== true || typeof key !== 'string' || typeof text !== 'string') return;
    const replyId = key.slice(0, Math.max(0, key.lastIndexOf('#')));
    this.schedule.voiced(replyId, text, this.ports.now());
    this.span.voiced(replyId, text, this.ports.now());
    this.flush();
  }

  /** The reply's stream is done: `total` characters. */
  done(replyId: string, total: number): void {
    if (!this.ports.perform) return;
    this.schedule.done(replyId, total, this.ports.now());
    this.span.done(replyId, total, this.ports.now());
    this.flush();
  }

  /** Stop, clear, error: what did not play is dropped (no id: the current reply). */
  cancel(replyId?: string): void {
    this.schedule.cancel(replyId);
    this.span.cancel(replyId);
    if (replyId === undefined || replyId === this.span.replyId) { this.release('cancelled'); this.lines.clear(); }
    this.flush();
  }

  /** What her history keeps of this reply: the host's words for it (with her markers while the switch is on), else `reply`. */
  historyText(replyId: string, reply: string): string {
    const final = this.finals.get(replyId);
    return final ? final.history ?? '' : reply;
  }

  /** The grey line of a performance-only reply (null: not one). */
  performed(replyId: string): string | null {
    const final = this.finals.get(replyId);
    return final?.performanceOnly && final.line ? final.line : null;
  }

  /** The chat page's message for a performance-only reply: the grey line, small. False when it is not one. */
  showPerformed(replyId: string, node: HTMLElement): boolean {
    const line = this.performed(replyId);
    if (!line) return false;
    node.textContent = line;
    node.closest('.message')?.classList.add('message-performed');
    return true;
  }

  private release(reason: SpeechBeatRelease): void { try { this.ports.release?.(reason); } catch { /* the stage never breaks the chat */ } }

  /** I-175: a held line's sentence is over: read-aloud on, the reading started a later segment; off, the bubble shows the next sentence. */
  private lineEnds(): void {
    if (!this.lines.holding) return;
    const reading = this.pacingNow === 'voice' ? this.span.readingFrom : null;
    if (reading !== null ? this.lines.reached(reading, true) : this.pacingNow === 'shown' && this.lines.reached(this.shownNow)) this.release('line');
  }

  private flush(): void {
    if (this.timer !== null) { this.ports.clearTimer(this.timer); this.timer = null; }
    const perform = this.ports.perform;
    if (!perform) return;
    for (const play of this.schedule.due(this.ports.now())) {
      // I-175: her "how long": once = not held, line = held to this sentence's pause, none = as before.
      const hold = beatHold(isSpeechBeatHow(play.how) ? play.how : undefined, this.span.hold(play.replyId));
      if (hold === 'line') this.lines.hold(play.at);
      try { perform(play.word, hold); } catch { /* the stage never breaks the chat */ }
    }
    this.lineEnds();
    if (this.span.ended(this.ports.now())) this.release('ended'); // her speaking of this reply is over: what stayed up falls
    const scheduled = this.schedule.nextAt(), ends = this.span.endsAt();
    const next = scheduled === null ? ends : ends === null ? scheduled : Math.min(scheduled, ends);
    if (next !== null) this.timer = this.ports.setTimer(() => { this.timer = null; this.flush(); }, Math.max(0, next - this.ports.now()));
  }
}
