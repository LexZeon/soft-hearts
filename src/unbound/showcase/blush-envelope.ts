/**
 * Round 15 (the blush "瞬间出现"): the showcase blush has its own slow envelope, apart from the expression that
 * brings it. Before, it followed the shy expression's quick onset with a 2x gain and went from 0.1 to 0.6 in 0.2–0.33 s. A real
 * blush comes up over a second or two and goes away slower still: here it rises over 1.2–1.8 s and fades over 2–3 s (this beat's
 * own variation picks where in the range), both ease-in-out, and it rises fully even when the expression is shorter than that.
 * Several blushes at once take the highest (continuous, no jump). A pure function of time and the started beats: nothing to reset.
 */
import type { ShowcaseExpression } from '../../../shared/unbound/showcase';

export const BLUSH_ENVELOPE = Object.freeze({ riseS: 1.5, riseRangeS: [1.2, 1.8] as const, fadeS: 2.5, fadeRangeS: [2, 3] as const });
/** Which expressions bring a blush, and how much at a full cue. Only shy does in the showcase; others can join here. */
export const BLUSH_FROM: Readonly<Partial<Record<ShowcaseExpression, number>>> = Object.freeze({ shy: 1 });

/** On: the slow envelope. Off (development, `blushOld=1`): the old blush, for a before/after comparison. */
export let SLOW_BLUSH = true;
export function setSlowBlush(on: boolean): void { SLOW_BLUSH = on; }

export interface BlushBeat {
  kind: string; name?: ShowcaseExpression; playedAt: number; dur: number; intensity: number;
  vary: { amp: number; speed: number; roll: number };
}

const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** One beat's blush at time `t` (0 when it brings none). */
export function beatBlush(b: BlushBeat, t: number): number {
  const share = b.kind === 'expression' && b.name ? BLUSH_FROM[b.name] ?? 0 : 0;
  const since = t - b.playedAt;
  if (!(share > 0) || !(since > 0)) return 0;
  const rise = clamp(BLUSH_ENVELOPE.riseS + 0.3 * b.vary.speed, BLUSH_ENVELOPE.riseRangeS);
  const fade = clamp(BLUSH_ENVELOPE.fadeS + 0.5 * b.vary.roll, BLUSH_ENVELOPE.fadeRangeS);
  const after = since - Math.max(b.dur, rise);
  if (after >= fade) return 0;
  // The level the shy expression used to drive the blush to (2x its own level, which saturated near full for most cues).
  const level = Math.min(1, 2 * (0.55 + 0.45 * b.intensity) * (1 + 0.12 * b.vary.amp)) * share;
  return Math.min(1, Math.max(0, level * S5(since / rise) * (after > 0 ? 1 - S5(after / fade) : 1)));
}

/** The blush at `t` over the started beats (the highest one). */
export function blushAt(beats: readonly BlushBeat[], t: number): number {
  let top = 0;
  for (const b of beats) { const v = beatBlush(b, t); if (v > top) top = v; }
  return top;
}
