/**
 * I-091: one call turn's timing, all from the user's last voiced moment, in this window's own clock (the baseline's
 * "voice-time" mixed two clocks and a 1.5 s timer; docs/claude/2026-11-12-i091-latency-baseline.md):
 *   endpointMs  last voiced chunk → the utterance was cut (the silence wait)
 *   handInMs    last voiced chunk → the clip was handed to recognition
 *   textMs      last voiced chunk → her window got the recognized text
 *   fillerMs    last voiced chunk → her short "嗯" started (null: none)
 *   firstCharMs last voiced chunk → the first character of her reply arrived
 *   firstSoundMs last voiced chunk → her reply's first sound
 *   soundAfterCharMs her first character → her first sound (null when either is missing); step 4's number: how soon she starts
 *               talking after she starts writing
 *   earlyRead   the first sound came before her reply was finished (read while it was still being written); null without a sound
 *   bargeIn     this turn began by talking over her reading
 *   endToSoundMs I-099's one number: the user's last speech frame → her first sound of any kind (her short "嗯" or the
 *               reply, whichever came first); null when she made no sound this turn
 *   vad         the user's last speech frame was found by the call's VAD (false: by loudness, the fallback)
 *   endBy       how the end was decided (I-099/I-100): 'smart-turn' (the turn model said finished), 'smart-waited' (it said not yet,
 *               the long silence ended it), 'silence' (the plain silence rule: no model, no answer, or no VAD)
 * Numbers and flags only; the window sends one journal fact per turn ('voice-call-turn').
 */
import type { TurnEndBy } from './turn-end';

export interface CallTurnTiming {
  endpointMs: number | null; handInMs: number | null; textMs: number | null; fillerMs: number | null;
  firstCharMs: number | null; firstSoundMs: number | null; soundAfterCharMs: number | null; earlyRead: boolean | null; bargeIn: boolean;
  endToSoundMs: number | null; vad: boolean; endBy: TurnEndBy; smartTurnOff?: 'guard';
}

export class CallTurnClock {
  private voicedAt: number | null = null;
  private voicedByVad = false;
  private bargeIn = false;
  private turn: (CallTurnTiming & { from: number; replyDone: boolean }) | null = null;
  constructor(private readonly now: () => number, private readonly send: (timing: CallTurnTiming) => void) {}

  /** A chunk that counted as the user speaking; its speech ended at `at` (I-099: the VAD's last speech window), default now. */
  voiced(at?: number, vad = false): void {
    if (this.turn) this.finish(); // the user talks again before her first sound: the previous turn ends as it is
    const now = this.now();
    this.voicedAt = typeof at === 'number' && Number.isFinite(at) && at <= now ? at : now;
    this.voicedByVad = vad;
  }
  /** This turn started by interrupting her. */
  interrupted(): void { this.bargeIn = true; }
  /** The utterance was cut (silence long enough). */
  endpoint(by: TurnEndBy = 'silence', smartTurnOff?: 'guard'): void {
    if (this.voicedAt === null) return;
    this.turn = { from: this.voicedAt, endpointMs: this.since(this.voicedAt), handInMs: null, textMs: null, fillerMs: null,
      firstCharMs: null, firstSoundMs: null, soundAfterCharMs: null, earlyRead: null, replyDone: false, bargeIn: this.bargeIn,
      endToSoundMs: null, vad: this.voicedByVad, endBy: by, ...(smartTurnOff ? { smartTurnOff } : {}) };
    this.bargeIn = false;
  }
  handedIn(): void { this.mark('handInMs'); }
  text(): void { this.mark('textMs'); }
  filler(): void { this.mark('fillerMs'); }
  firstChar(): void { this.mark('firstCharMs'); }
  /** Her whole reply has been written (the voice host's terminal event for it). */
  replyDone(): void { if (this.turn) this.turn.replyDone = true; }
  /** Her reply sounded: the turn is complete. */
  firstSound(): void {
    if (!this.turn) return;
    this.mark('firstSoundMs');
    const { firstCharMs, firstSoundMs } = this.turn;
    this.turn.earlyRead = !this.turn.replyDone;
    this.turn.soundAfterCharMs = firstCharMs !== null && firstSoundMs !== null ? Math.max(0, firstSoundMs - firstCharMs) : null;
    this.finish();
  }
  /** Hang-up: an unfinished turn is sent as it is. */
  flush(): void { if (this.turn) this.finish(); this.voicedAt = null; this.bargeIn = false; }

  private mark(key: 'handInMs' | 'textMs' | 'fillerMs' | 'firstCharMs' | 'firstSoundMs'): void {
    if (this.turn && this.turn[key] === null) this.turn[key] = this.since(this.turn.from);
  }
  private since(from: number): number { return Math.max(0, Math.round(this.now() - from)); }
  private finish(): void {
    const turn = this.turn; this.turn = null;
    if (!turn) return;
    const sounds = [turn.fillerMs, turn.firstSoundMs].filter((value): value is number => value !== null);
    turn.endToSoundMs = sounds.length ? Math.min(...sounds) : null;
    const { from: _from, replyDone: _replyDone, ...timing } = turn;
    try { this.send(timing); } catch { /* timing only */ }
  }
}
