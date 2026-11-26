/**
 * I-078 第 1 步: when and which of her sleepy small actions, how long settling takes, which pose she leans toward. Pure; the
 * random source is passed in (tests use a seeded one). Values come from knobs.ts; hormones are read, never written
 * (docs/claude/2026-11-11-i078-sleep-step1.md has the read/write table).
 *
 * Less mechanical feel (docs/claude/2026-11-11-loosen-plan.md「降低程序感」): every gap is log-normal around its mean (not one
 * value), shifted by her hormones, never shorter than its floor; a variant is never picked twice in a row.
 */
import { SLEEP_BODY_KNOBS, type SleepBodyKnobs } from './knobs';

export type Rng = () => number;
export interface Hormones { readonly D: number; readonly O: number; readonly E: number; readonly N: number; readonly C: number }
export const NEUTRAL_HORMONES: Hormones = Object.freeze({ D: 0, O: 0, E: 0, N: 0, C: 0 });
const CHANNELS = ['D', 'O', 'E', 'N', 'C'] as const;
const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));

/** Channels against her own baseline, −1..1 (the same normalization shared/mood/fatigue.ts uses). Bad input → neutral. */
export function normalizedHormones(values: Partial<Hormones> | null | undefined, baseline: Partial<Hormones> | null | undefined): Hormones {
  const out = { D: 0, O: 0, E: 0, N: 0, C: 0 };
  for (const k of CHANNELS) {
    const v = values?.[k], b = baseline?.[k];
    if (typeof v !== 'number' || typeof b !== 'number' || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0 || b >= 100) continue;
    out[k] = clamp((v - b) / (v >= b ? 100 - b : b), -1, 1);
  }
  return out;
}

/** A standard normal draw (Box–Muller). */
function normal(rng: Rng): number {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/**
 * A gap with this mean (s): the floor `min` plus a log-normal part (so nothing piles up exactly on the floor, which a clamp
 * would do: one gap in eight at exactly the same second reads as a timer), never over 4 × mean.
 */
export function logNormalGap(mean: number, min: number, spread: number, rng: Rng): number {
  const s = clamp(spread, 0.05, 1.2), m = Math.max(min, mean), extra = Math.max(m - min, m * 0.15);
  return Math.min(m * 4, min + extra * Math.exp(s * normal(rng) - s * s / 2));
}

/** Seconds to the next drowsy small action: sleepier (F) → sooner; N tense → a little sooner (more nodding off and catching). */
export function drowsyGap(phase: string, F: number, h: Hormones, rng: Rng, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): number {
  const d = k.drowsy, base = phase === 'light-drowsy' ? d.lightMeanGapS : d.meanGapS;
  const sleepier = clamp(1.25 - clamp(F, 0, 1) * 0.5, 0.75, 1.25), tense = 1 - 0.15 * Math.max(0, h.N), calm = 1 + 0.2 * Math.max(0, h.E);
  return logNormalGap(base * sleepier * tense * calm, d.minGapS, d.spread, rng);
}
/** Seconds to the next small movement asleep: C restless → sooner; E calm and deep sleep (A) → later. */
export function asleepGap(A: number, h: Hormones, rng: Rng, k: SleepBodyKnobs = SLEEP_BODY_KNOBS, habit = 0): number {
  const s = k.asleep, restless = 1 - 0.35 * Math.max(0, h.C), calm = 1 + 0.3 * Math.max(0, h.E), deep = 1 + 0.4 * clamp(A, 0, 1);
  return logNormalGap(s.meanGapS * restless * calm * deep * habitGap(habit, k), s.minGapS, s.spread, rng);
}
/** I-078 第 3 步: the 睡相 factor on the asleep gap (exactly 1 in the middle). */
export function habitGap(habit: number, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): number {
  const r = clamp(habit, -1, 1);
  return r > 0 ? k.habit.restlessGap ** r : r < 0 ? k.habit.calmGap ** -r : 1;
}
export function murmurGap(rng: Rng, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): number {
  return logNormalGap(k.murmur.meanGapS, k.murmur.minGapS, 0.5, rng);
}

/** A weighted pick that is never `last` (unless it is the only choice with weight). */
export function pickVariant<T extends string>(weights: Readonly<Record<T, number>>, last: T | null, rng: Rng): T | null {
  const entries = (Object.entries(weights) as [T, number][]).filter(([key, w]) => w > 0 && key !== last);
  const pool = entries.length ? entries : (Object.entries(weights) as [T, number][]).filter(([, w]) => w > 0);
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  if (!(total > 0)) return null;
  let r = rng() * total;
  for (const [key, w] of pool) { r -= w; if (r < 0) return key; }
  return pool[pool.length - 1][0];
}

export type DrowsyAction = 'yawn' | 'rub' | 'nod';
export function drowsyWeights(h: Hormones, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): Record<DrowsyAction, number> {
  return { yawn: k.drowsy.yawn, rub: k.drowsy.rub * (1 + 0.4 * Math.max(0, h.C)), nod: k.drowsy.nod * (1 + 0.5 * Math.max(0, h.N)) };
}
/** 'turn', 'hug' and 'arm-out' (I-078 第 3 步) only come with a restless 睡相 (habit > 0); in the middle their weight is 0. */
export type AsleepMove = 'nuzzle' | 'hand' | 'sigh' | 'curl' | 'settle-head' | 'turn' | 'hug' | 'arm-out';
/**
 * Which small movement asleep. `habit` (I-078 第 3 步, the card's 睡相, −1 calm … 0 middle … 1 restless; sleepHabitScale): restless
 * adds turning over, hugging the pillow tighter (more with O) and an arm out (more with C); calm keeps fewer hand shifts and
 * curls. At 0 the weights are exactly the step-1 ones (the new moves have weight 0 and are never picked).
 */
export function asleepWeights(h: Hormones, habit = 0, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): Record<AsleepMove, number> {
  const restless = Math.max(0, clamp(habit, -1, 1)), calm = Math.max(0, -clamp(habit, -1, 1)), fewer = 1 - (1 - k.habit.calmFewer) * calm;
  return { nuzzle: 1 + 0.4 * Math.max(0, h.O), hand: (0.8 + 0.6 * Math.max(0, h.C)) * fewer, sigh: 0.7 + 0.3 * Math.max(0, h.E), curl: (0.6 + 0.4 * Math.max(0, h.C)) * fewer, 'settle-head': 0.7,
    turn: k.habit.turn * restless * (1 + 0.6 * Math.max(0, h.C)), hug: k.habit.hug * restless * (1 + Math.max(0, h.O)), 'arm-out': k.habit.armOut * restless * (1 + 0.6 * Math.max(0, h.C)) };
}
/** I-078 第 3 步: the card's 睡相 (0 calm … 50 middle … 100 restless; absent = middle) as −1…1. */
export function sleepHabitScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp((value - 50) / 50, -1, 1) : 0;
}
/** How much bigger (restless) or smaller (calm) her small movements asleep are: 1 in the middle. */
export function habitSize(habit: number, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): number {
  return 1 + k.habit.sizeRange * clamp(habit, -1, 1);
}

/** The settling timeline in seconds: when she sits down, how long she stays sitting before lying or leaning. */
export function settleTimes(h: Hormones, rng: Rng, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): { sitDelay: number; sitDwell: number } {
  const [d0, d1] = k.settle.sitDelayS, [w0, w1] = k.settle.sitDwellS;
  // N tense: toward the long end of the delay (harder to settle); E calm: toward the short end.
  const lean = clamp(rng() + 0.35 * h.N - 0.2 * h.E, 0, 1);
  return { sitDelay: d0 + (d1 - d0) * lean, sitDwell: w0 + (w1 - w0) * clamp(rng() + 0.25 * h.N, 0, 1) };
}
/** How many seconds a body move takes (E calm slower, C restless faster). */
export function moveSeconds(kind: 'sit' | 'lie' | 'rise', h: Hormones, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): number {
  const base = kind === 'sit' ? k.settle.sitSeconds : kind === 'lie' ? k.settle.lieSeconds : k.settle.riseSeconds;
  return base * (1 + 0.15 * Math.max(0, h.E) - 0.15 * Math.max(0, h.C));
}
/** Breaths per second asleep: calmer (E) and deeper sleep (A) breathe a little slower. */
export function breathRate(A: number, h: Hormones, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): number {
  return k.asleep.breathRateHz * (1 - 0.1 * Math.max(0, h.E) - 0.08 * clamp(A, 0, 1) + 0.1 * Math.max(0, h.C));
}

/** Her lean toward each pose kind: the knobs, closeness (O: lying with the pillow), variety (not last night's kind). */
export function posePreferences(h: Hormones, lastKind: string | null, k: SleepBodyKnobs = SLEEP_BODY_KNOBS): { lie: number; desk: number; sit: number } {
  const p = k.prefer, out = { lie: p.lie + 0.1 * Math.max(0, h.O), desk: p.desk, sit: p.sit };
  if (lastKind === 'lie') out.desk += p.variety; else if (lastKind === 'desk') out.lie += p.variety;
  return out;
}
/** How much of the hug variant (0..1): closeness O. */
export const hugShare = (h: Hormones) => clamp(0.25 + 0.6 * h.O, 0, 1);
