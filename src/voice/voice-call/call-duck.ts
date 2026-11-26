/**
 * I-177 batch 2, plan item 4 "先侧耳听，再判断" (docs/claude/2026-11-22-i177-batch2.md).
 * the rule that stays (11-19): only a clear, complete sentence interrupts.
 *
 * In a call, when the user starts talking over her reading (MediaInput's barge-in: past the echo gate and called speech by the VAD), her
 * voice is made quieter at once (CALL_DUCK_KNOBS.duckDb, eased over downMs) and held there while she goes on reading. Then:
 *   - the clip turns out to be a clear sentence or a stop word (the host's judge, unchanged): her reading is stopped as before → `stopped()`;
 *   - it is a filler, a fragment, her echo, or no words (the host's 'held' / 'unheard'), or listening over her ended with nothing collected
 *     → `held()` / `clipEnded(false)`: her volume eases back (upMs) and she simply continues;
 *   - nothing comes back in time (maxHoldMs from the duck, verdictWaitMs after the clip was handed in) → back up as well ('timeout').
 * THE DUCK ALONE NEVER STOPS HER: this class only moves the output's level (a factor above 0), it has no way to stop a reading.
 * Only a cloud voice (Drama 3 / Bailian, through the window's shared output) can be ducked; the system voice cannot change its volume
 * mid-sentence, so `canDuck()` says no and nothing happens. Pure (injected level port, clock and timers); tests use fakes.
 */
import { CALL_DUCK_KNOBS, type CallDuckKnobs } from '../../../shared/behaviors/call-duck/knobs';
import { VOICE_CALL_KNOBS, type VoiceCallKnobs } from '../../../shared/behaviors/voice-call/knobs';

/** Decibels to a gain factor (-12 dB ≈ 0.25); never above 1. */
export const dbToGain = (db: number): number => Math.pow(10, Math.min(0, Number.isFinite(db) ? db : 0) / 20);

/** How a duck ended: her reading was stopped, she went on, or nothing came back in time (she went on too). */
export type DuckEnd = 'stop' | 'resume' | 'timeout';
export interface CallDuckPorts {
  /** The window's output level (src/voice/audio-output.ts duck): 1 = her normal volume. */
  level(target: number, ms: number): void;
  /** Her voice can be ducked now: read-aloud on, volume above 0, a cloud voice. */
  canDuck(): boolean;
  now(): number;
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** A duck ended (numbers only: how, after how long). */
  ended?(end: DuckEnd, ms: number): void;
  knobs?: CallDuckKnobs;
}

export class CallDuck {
  private since: number | null = null;
  private timer: unknown = null;
  /** Ducks begun and how they ended in this window, for tests and the developer line. */
  readonly counts = { ducks: 0, stop: 0, resume: 0, timeout: 0 };
  constructor(private readonly ports: CallDuckPorts) {}

  private get knobs(): CallDuckKnobs { return this.ports.knobs ?? CALL_DUCK_KNOBS; }
  /** Her voice is ducked now. */
  get ducked(): boolean { return this.since !== null; }

  /** The user started talking over her: quieter at once, held until the clip is judged. Only the volume. */
  overHer(): void {
    if (this.since !== null) return;
    let can = false;
    try { can = this.ports.canDuck() === true; } catch { can = false; }
    if (!can) return;
    this.since = this.ports.now();
    this.counts.ducks++;
    this.ports.level(dbToGain(this.knobs.duckDb), this.knobs.downMs);
    this.arm(this.knobs.maxHoldMs);
  }

  /** Listening over her ended: with a clip handed to recognition, wait for its verdict a little; with nothing collected, back up now. */
  clipEnded(clip: boolean): void {
    if (this.since === null) return;
    if (!clip) { this.end('resume'); return; }
    // The absolute limit stays: a clip handed in at 5.5 s waits only until 6 s, not 3 s more (T-260).
    const left = Math.max(0, this.knobs.maxHoldMs - (this.ports.now() - this.since));
    this.arm(Math.min(this.knobs.verdictWaitMs, left));
  }

  /** The clip was held (a filler, a fragment, her echo, no words): she goes on at her normal volume. */
  held(): void { if (this.since !== null) this.end('resume'); }

  /** Her reading was stopped (a clear sentence or a stop word reached her): the level goes back for whatever she says next. */
  stopped(): void { if (this.since !== null) this.end('stop'); }

  /** The call ended in this window: back to normal, not counted. */
  reset(): void {
    this.clear();
    if (this.since === null) return;
    this.since = null;
    this.ports.level(1, this.knobs.upMs);
  }

  private end(how: DuckEnd): void {
    const since = this.since;
    if (since === null) return;
    this.clear();
    this.since = null;
    this.counts[how]++;
    this.ports.level(1, this.knobs.upMs);
    try { this.ports.ended?.(how, Math.max(0, this.ports.now() - since)); } catch { /* numbers only */ }
  }
  private arm(ms: number): void {
    this.clear();
    this.timer = this.ports.timers.set(() => { this.timer = null; this.end('timeout'); }, Math.max(0, ms));
  }
  private clear(): void { if (this.timer !== null) { this.ports.timers.clear(this.timer); this.timer = null; } }
}

/**
 * The call's knobs for the output it plays on (batch 1's verdict): with headphones there is no echo of her voice in the microphone, so the
 * "user is talking over her" gate may be lower (CALL_DUCK_KNOBS.headphonesFloor / headphonesGateFactor); on speakers (or unknown) as today.
 */
export function callKnobsFor(output: 'headphones' | 'speakers' | 'unknown' | null | undefined, knobs: CallDuckKnobs = CALL_DUCK_KNOBS): VoiceCallKnobs {
  if (output !== 'headphones') return VOICE_CALL_KNOBS;
  return { ...VOICE_CALL_KNOBS, bargeIn: { ...VOICE_CALL_KNOBS.bargeIn, floor: knobs.headphonesFloor, gateFactor: knobs.headphonesGateFactor } };
}
