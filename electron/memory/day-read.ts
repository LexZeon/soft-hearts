import {
  DAY_READ_KEEP_MS, DAY_READ_MAX_SIGNALS, dayRead, dayReadInnerLoopLine, dayReadLine, lateSignal, lookSignal, rhythmSignal, saidSignal, voiceSignal,
  type DayRead, type DayReadResult, type DaySignal,
} from '../../shared/memory/day-read';

/**
 * I-089 item 5: the day's read of the user (shared/memory/day-read.ts has what and why). Memory only: nothing is written anywhere, a restart
 * starts empty, a signal older than DAY_READ_KEEP_MS is dropped. About the user, not the character.
 *
 * She does not repeat herself: a new kind of read always reaches her turn; the same read again only now and then (her own pace, by
 * `random`), because the conversation she is in already holds what she was told. That is taste, not a rule: it only saves her prompt.
 */
export class DayReadStore {
  private signals: DaySignal[] = [];
  private recent: { at: number; length: number }[] = [];
  private lastTold: DayRead | null = null;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly hour: (at: number) => number;
  constructor(options: { clock?: () => number; random?: () => number; hour?: (at: number) => number } = {}) {
    this.clock = options.clock ?? Date.now; this.random = options.random ?? Math.random; this.hour = options.hour ?? (at => new Date(at).getHours());
  }

  private add(signal: DaySignal | null): void {
    if (!signal) return;
    this.signals.push(signal);
    this.signals = this.signals.filter(s => signal.at - s.at < DAY_READ_KEEP_MS).slice(-DAY_READ_MAX_SIGNALS);
  }

  noteTone(tone: unknown, at = this.clock()): void { this.add(voiceSignal(tone, at)); }
  noteLook(tag: unknown, at = this.clock()): void { this.add(lookSignal(tag, at)); }
  noteSaid(state: unknown, at = this.clock()): void { this.add(saidSignal(state, at)); }
  /** One message of the user's: only its length and time (the text is never passed here). */
  noteMessage(length: number, at = this.clock()): void {
    if (!Number.isFinite(length) || length < 0) return;
    this.recent.push({ at, length }); if (this.recent.length > 8) this.recent.shift();
    this.add(lateSignal(this.hour(at), at));
    this.add(rhythmSignal(this.recent, at));
  }

  current(now = this.clock()): DayReadResult | null { return dayRead(this.signals, now); }

  /** The line for the next chat turn: '' when unclear, or when the same read was just told and she is not due to hear it again. */
  chatContext(now = this.clock()): string {
    const result = this.current(now);
    if (!result) { this.lastTold = null; return ''; }
    if (this.lastTold === result.read && this.random() >= 0.3) return '';
    this.lastTold = result.read;
    return dayReadLine(result);
  }
  /** For her own decision to speak first: every time (she decides rarely), same read. */
  innerLoopContext(now = this.clock()): string { return dayReadInnerLoopLine(this.current(now)); }

  clear(): void { this.signals = []; this.recent = []; this.lastTold = null; }
}
