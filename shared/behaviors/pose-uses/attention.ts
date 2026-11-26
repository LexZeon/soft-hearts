// I-189 #1 and #2: is the user facing the screen, turned away, or gone, as the local pose signals say, and
// for how long. Pure: the host feeds every checked pose signal with its time and asks at any moment. Never decides on one frame:
//  - 'turned': somebody is there and the facing vote says side or away with at least `sureConfidence`, over at least `minFrames` frames;
//  - 'gone':   pose sensing says nobody is in front (its own hysteresis already needs a second of misses);
//  - 'toward': facing the screen with at least `towardConfidence`;
//  - 'unsure': anything else: no signal for a while (sensing off, a stale reading), a low-confidence frame on its own, presence only.
// A stretch of unsure frames shorter than `gapMs` neither ends nor starts a 'turned' or 'gone' run (a single blurry frame never pauses
// her reading and never ends a pause); a confident 'toward' ends it at once.
import type { PoseSignal } from '../../senses/pose-signals';
import { POSE_USES_KNOBS, type PoseUsesKnobs } from './knobs';

export type UserAttentionState = 'toward' | 'turned' | 'gone' | 'unsure';
export const USER_ATTENTION_STATES: readonly UserAttentionState[] = ['toward', 'turned', 'gone', 'unsure'];

/** What one signal says on its own (before runs and gaps). */
export function attentionOf(signal: Pick<PoseSignal, 'present' | 'facing' | 'facingConfidence' | 'capability'>, knobs: PoseUsesKnobs['attention'] = POSE_USES_KNOBS.attention): UserAttentionState {
  if (!signal.present) return 'gone';
  if (signal.capability !== 'full') return 'unsure';
  if ((signal.facing === 'side' || signal.facing === 'away') && signal.facingConfidence >= knobs.sureConfidence) return 'turned';
  if (signal.facing === 'toward' && signal.facingConfidence >= knobs.towardConfidence) return 'toward';
  return 'unsure';
}

/** The reading the windows get: the state and how long it has held (ms); 'unsure' carries 0. */
export interface UserAttention { readonly state: UserAttentionState; readonly forMs: number }

export class AttentionTracker {
  private run: { state: 'toward' | 'turned' | 'gone'; since: number; frames: number; lastSure: number } | null = null;
  private lastAt = -Infinity;
  private lastPresent = false;

  constructor(private readonly knobs: PoseUsesKnobs['attention'] = POSE_USES_KNOBS.attention) {}

  /** Every checked pose signal, in order. */
  note(signal: Pick<PoseSignal, 'present' | 'facing' | 'facingConfidence' | 'capability'>, at: number): void {
    if (!Number.isFinite(at) || at < this.lastAt) return;
    this.lastAt = at; this.lastPresent = signal.present;
    const state = attentionOf(signal, this.knobs), run = this.run;
    if (state === 'unsure') {
      if (run && at - run.lastSure > this.knobs.gapMs) this.run = null; // a long unsure stretch: nothing is known any more
      return;
    }
    // The same answer again continues the run (signals come every 2 s while nobody is there, faster otherwise).
    if (run && run.state === state && at - run.lastSure <= (state === 'gone' ? this.knobs.absentFreshMs : this.knobs.freshMs)) { run.frames++; run.lastSure = at; return; }
    this.run = { state, since: at, frames: 1, lastSure: at };
  }

  /** Sensing stopped: nothing about the user is known. */
  forget(): void { this.run = null; this.lastAt = -Infinity; this.lastPresent = false; }

  read(now: number): UserAttention {
    const run = this.run;
    if (!run || !Number.isFinite(now)) return { state: 'unsure', forMs: 0 };
    const fresh = this.lastPresent ? this.knobs.freshMs : this.knobs.absentFreshMs;
    if (now - this.lastAt > fresh || now < run.since) return { state: 'unsure', forMs: 0 };
    if (run.state === 'turned' && run.frames < this.knobs.minFrames) return { state: 'unsure', forMs: 0 };
    return { state: run.state, forMs: Math.max(0, Math.round(now - run.since)) };
  }
}

/** The windows' check of the reading (the userGaze answer carries it): anything off is no reading. */
export function parseUserAttention(value: unknown): UserAttention | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || !(USER_ATTENTION_STATES as readonly unknown[]).includes(v.state)) return null;
  if (typeof v.forMs !== 'number' || !Number.isFinite(v.forMs) || v.forMs < 0 || v.forMs > 7 * 24 * 3_600_000) return null;
  return { state: v.state as UserAttentionState, forMs: Math.round(v.forMs) };
}

/** #1: the user turned away or left, sure, for long enough that her reading pauses. */
export function awayForReading(attention: UserAttention | null, knobs: PoseUsesKnobs['readPause'] = POSE_USES_KNOBS.readPause): boolean {
  return !!attention && (attention.state === 'turned' || attention.state === 'gone') && attention.forMs >= knobs.awaySeconds * 1000;
}

/** #2: the user's face is turned from the screen (sure, held a moment): what they say now is not talking over her. */
export function turnedFromScreen(attention: UserAttention | null, knobs: PoseUsesKnobs['bargeHold'] = POSE_USES_KNOBS.bargeHold): boolean {
  return !!attention && attention.state === 'turned' && attention.forMs >= knobs.turnedMs;
}
