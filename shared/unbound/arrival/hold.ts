/**
 * I-192: how long she stays once she has arrived (One said the approach had no "staying
 * there" state; it should hold until she backs off by herself). Every close pose — the look, the kiss, the hug, her reply's lean-in — holds as
 * long as she decides, then eases back on her own.
 *
 *   arrivalHoldS   her own length: a base per kind × her warmth and boldness (tension shortens it), a little variation, at least
 *                  `holdMinS` (a kiss or a hug: `closeHoldMinS`, I-203), at most `holdCapS`
 *   holdGoesOn     each frame of the hold: on while she speaks (up to the cap: "up to while her reply lasts"); after she spoke during it, on
 *                  for `afterSpeechS` more (the pucker only shows when she is quiet); otherwise until her own length
 * Pure: the caller gives the clock and the random draw.
 */
import { ARRIVAL_KNOBS, type ArrivalKnobs } from './knobs';

export type HoldKind = 'look' | 'kiss' | 'hug' | 'lean-in';
/** What the length reads (each 0..1): her warmth, boldness and tension (shared/unbound/close-moments closeReading). */
export interface HoldReading { warmth: number; boldness: number; tension: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** The base length of each kind (s). */
export function holdBaseS(kind: HoldKind, knobs: ArrivalKnobs = ARRIVAL_KNOBS): number {
  return kind === 'look' ? knobs.lookHoldS : kind === 'kiss' ? knobs.kissHoldS : kind === 'hug' ? knobs.hugHoldS : knobs.leanInHoldS;
}

/** Her own hold (s): about 0.5× (tense, new, shy) to 1.8× (warm, close, bold) the base, `random` in [0, 1) varies it by ±10%. */
export function arrivalHoldS(kind: HoldKind, reading: HoldReading, random: number, knobs: ArrivalKnobs = ARRIVAL_KNOBS): number {
  const factor = 0.83 + 0.55 * clamp01(reading.warmth) + 0.2 * clamp01(reading.boldness) - 0.35 * clamp01(reading.tension);
  const s = holdBaseS(kind, knobs) * clamp(factor, 0.45, 1.8) * (0.9 + 0.2 * clamp01(random));
  // I-203: a kiss or a hug may be as short as the storyboard's 1.5 s (closeHoldMinS); the look and the lean-in keep holdMinS.
  return clamp(s, kind === 'kiss' || kind === 'hug' ? knobs.closeHoldMinS : knobs.holdMinS, knobs.holdCapS);
}

/** What the hold reads each frame. */
export interface HoldState {
  /** Seconds in the hold. */
  beat: number;
  /** Her own length (arrivalHoldS). */
  holdS: number;
  /** She is speaking now (the held "she is speaking"). */
  speaking: boolean;
  /** She spoke at some point during this hold. */
  spoke: boolean;
  /** Seconds since she last spoke (Infinity: not during this hold). */
  quietS: number;
}
/** Does the hold go on this frame? */
export function holdGoesOn(state: HoldState, knobs: ArrivalKnobs = ARRIVAL_KNOBS): boolean {
  if (!(state.beat < knobs.holdCapS)) return false;
  if (state.speaking) return true;
  if (state.beat < state.holdS) return true;
  return state.spoke && state.quietS < knobs.afterSpeechS;
}

/** Tracks `spoke` / `quietS` through a hold (the caller feeds the held "she is speaking" each frame). */
export class HoldClock {
  beat = 0;
  spoke = false;
  quietS = Infinity;
  frame(dt: number, speaking: boolean): void {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.beat += step;
    if (speaking) { this.spoke = true; this.quietS = 0; } else if (this.spoke) this.quietS += step;
  }
  state(holdS: number, speaking: boolean): HoldState { return { beat: this.beat, holdS, speaking, spoke: this.spoke, quietS: this.quietS }; }
}
