/**
 * I-136 step 5e「拉她」: how she takes being pulled (docs/claude/2026-11-18-unbound-step5-plan.md「心情怎么读、怎么写」「待你定」3, decided
 * as recommended: she may pull back, pout, wince or slip free, all from her mood and character, no switch).
 *
 * Read (the same reading as the touch face: hormones relative to her baseline, sleepiness A, the card's playful / posture strengths):
 *   O up (close)          → she follows, her arm loose, quicker;
 *   N or C up, O low       → she stands firm: leans less, and on a hard pull she pulls back (less give, never a push);
 *   A up (sleepy)          → she follows softly and slowly, never pulls back;
 *   D up (happy, curious)  → she follows lightly (quicker);
 *   new to each other      → she pauses a moment before following (like her hesitant reach for your hand).
 * Slipping free needs all three: pulled hard (≥ hardAt) and long (≥ longMs) and unwilling now. Even then it is slow: the body eases
 * back from what shows (the stage layer's springs), never a pop.
 * The body attitude only changes the springs' give and caps (≤ 1, the caps stay hard); her face and whether she says something stay
 * the brain's (shared/behaviors/touch-response/).
 * Pure and deterministic: the same numbers give the same stance.
 */
import type { MoodValues } from '../../foundation/mood';

export interface PullMoodReading {
  values: MoodValues;
  baseline: MoodValues;
  /** Sleepiness 0–1 (adenosine A). */
  sleepy: number;
  /** The card's playful strength, 0–100 (50 plain). */
  playful?: number;
  /** 0–1: how new you are to each other (1 just met); absent: not new. */
  newness?: number;
}

export interface PullStance {
  /** 0–1: how willing she is right now (what the rest is made of). */
  willing: number;
  /** Multiplies the caps (≤ 1). */
  compliance: number;
  /** Multiplies how fast she follows. */
  pace: number;
  /** Her first pause before following (ms). */
  hesitateMs: number;
  /** 0–1: how much she pulls back on a hard pull (0: never). */
  resist: number;
}

export const PULL_ATTITUDE_KNOBS = Object.freeze({
  /** How far a hormone above / below her baseline counts (points per full step). */
  span: 20,
  /** Willingness from closeness, tension and joy (per full step), around 0.5. */
  close: 0.25, tense: 0.3, joy: 0.1,
  /** The caps at no willingness (1 at full). */
  minCompliance: 0.55,
  /** Sleepy: this much slower at A 1; happy: this much quicker at a full step of D. */
  sleepySlow: 0.5, joyQuick: 0.2,
  /** New to each other: this long a pause at newness 1. */
  hesitateMs: 450,
  /** A hard pull from this strength; held this long counts as long (the touch brain's own numbers: touch-response knobs lift). */
  hardAt: 0.6, longMs: 5000,
  /** Below this willingness (and hard, long, not sleepy), she slips free. */
  slipBelow: 0.3, slipSleepyMax: 0.5,
});

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** Her stance for a pull, from her mood now. */
export function pullStanceOf(reading: PullMoodReading, knobs = PULL_ATTITUDE_KNOBS): PullStance {
  const rel = (key: keyof MoodValues) => clamp((reading.values[key] - reading.baseline[key]) / knobs.span, -1, 1);
  const close = rel('O'), tense = Math.max(rel('N'), rel('C')), joy = rel('D'), sleepy = clamp(reading.sleepy);
  const playful = clamp(((reading.playful ?? 50) - 50) / 50, -1, 1);
  const willing = clamp(0.5 + knobs.close * close - knobs.tense * Math.max(0, tense) + knobs.joy * (joy + 0.5 * playful));
  return {
    willing,
    compliance: knobs.minCompliance + (1 - knobs.minCompliance) * Math.max(willing, sleepy),
    pace: clamp((1 - knobs.sleepySlow * sleepy) * (1 + knobs.joyQuick * Math.max(0, joy)), 0.3, 1.5),
    hesitateMs: Math.round(knobs.hesitateMs * clamp(reading.newness ?? 0)),
    resist: clamp((0.5 - willing) * 2) * (1 - sleepy) ** 2,
  };
}

export type PullAttitude = 'follow' | 'firm' | 'pull-back' | 'slip';

/** What she does this moment of the pull: follows, stands firm, pulls back (hard pull, resisting) or slips free (hard + long + unwilling). */
export function pullAttitudeNow(stance: PullStance, strength: number, heldMs: number, sleepy = 0, knobs = PULL_ATTITUDE_KNOBS): PullAttitude {
  const hard = strength >= knobs.hardAt, long = heldMs >= knobs.longMs;
  if (hard && long && stance.willing < knobs.slipBelow && sleepy < knobs.slipSleepyMax) return 'slip';
  if (hard && stance.resist > 0.2) return 'pull-back';
  return stance.willing < 0.5 ? 'firm' : 'follow';
}

/** The caps' share this moment: her compliance, less on a hard pull she resists (only less give; never a push). */
export function pullGiveNow(stance: PullStance, strength: number, knobs = PULL_ATTITUDE_KNOBS): number {
  const over = clamp((strength - knobs.hardAt) / (1 - knobs.hardAt));
  return clamp(stance.compliance * (1 - 0.5 * stance.resist * over));
}
