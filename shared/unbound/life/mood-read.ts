/**
 * Unbound v1 step 4: how her mood sets the pace of her own life (docs/claude/2026-11-17-unbound-step4.md「心情怎么读、怎么写」).
 *
 * READ only, the same reading as the peek (electron/unbound/peek.ts peekMoodFrom): D/O/E/N/C as levels relative to her card's
 * baseline (50 = at baseline), A her sleep pressure 0..1, B/M as they are. The user's words (plan, 11-17):
 *   O up → she moves and comes up more;  A up → less, to a corner;  N up → further away, smaller;  E up → closer.
 * WRITE: nothing here. Her own moving never changes her mood (T-246a: she must not give herself points); the one write is the
 * existing 'peek-answered' moment when you answer her coming closer (electron/unbound/life.ts).
 *
 * The starting numbers are developer-panel knobs (LIFE_KNOB_DEFAULTS, this run only); the user has no frequency knob (scope 定稿).
 */
import type { MoodReading } from '../director';

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

/** What the mood means for movement, each 0..1 (amplitude 0.5..1). */
export interface LifeDrives {
  /** How lively: O (and a little D) up → more; sleepy or tense → less. */
  energy: number;
  /** A over 0.35, full at 0.7. */
  sleepy: number;
  /** N over her baseline. */
  tense: number;
  /** E over her baseline. */
  warm: number;
  /** How big her small moves are (tense → smaller). */
  amplitude: number;
}

export function lifeDrives(mood: MoodReading): LifeDrives {
  const o = (mood.O - 50) / 50, d = (mood.D - 50) / 50;
  const sleepy = clamp01((mood.A - 0.35) / 0.35), tense = clamp01((mood.N - 50) / 30), warm = clamp01((mood.E - 50) / 30);
  const energy = clamp01(0.5 + 0.35 * o + 0.15 * d - 0.5 * sleepy - 0.3 * tense);
  return { energy, sleepy, tense, warm, amplitude: Math.max(0.5, 1 - 0.5 * tense) };
}

/** The starting numbers (developer panel). Ranges: each min..max pair spans what the mood can choose. */
export interface LifeKnobs {
  peekPerHourMin: number; peekPerHourMax: number;
  placeMinutesMin: number; placeMinutesMax: number;
  smallMinutesMin: number; smallMinutesMax: number;
  pausesPerMinuteMin: number; pausesPerMinuteMax: number;
  /** Between two things you notice (small and up), at least this long (s). */
  gapSeconds: number;
  /** After you stop interacting with her, nothing new for this long (s). */
  afterUserSeconds: number;
}
export const LIFE_KNOB_DEFAULTS: Readonly<LifeKnobs> = Object.freeze({
  peekPerHourMin: 1, peekPerHourMax: 4, placeMinutesMin: 10, placeMinutesMax: 30, smallMinutesMin: 2, smallMinutesMax: 6,
  pausesPerMinuteMin: 3, pausesPerMinuteMax: 8, gapSeconds: 45, afterUserSeconds: 20,
});
export const LIFE_KNOB_RANGES: Readonly<Record<keyof LifeKnobs, readonly [number, number]>> = Object.freeze({
  peekPerHourMin: [1, 6], peekPerHourMax: [1, 6], placeMinutesMin: [1, 120], placeMinutesMax: [1, 120], smallMinutesMin: [0.5, 30], smallMinutesMax: [0.5, 30],
  pausesPerMinuteMin: [0, 12], pausesPerMinuteMax: [0, 12], gapSeconds: [5, 600], afterUserSeconds: [0, 300],
});
/** Words for the panel. */
export const LIFE_KNOB_WORDS: Readonly<Record<keyof LifeKnobs, string>> = Object.freeze({
  peekPerHourMin: '凑过来每小时最少', peekPerHourMax: '凑过来每小时最多', placeMinutesMin: '换位置最短隔（分钟）', placeMinutesMax: '换位置最长隔（分钟）',
  smallMinutesMin: '小动作最短隔（分钟）', smallMinutesMax: '小动作最长隔（分钟）', pausesPerMinuteMin: '待机停顿每分钟最少', pausesPerMinuteMax: '待机停顿每分钟最多',
  gapSeconds: '两件事之间至少（秒）', afterUserSeconds: '你理完她以后先不动（秒）',
});

/** Applies a patch of knobs (only known keys, only in range); min/max pairs are kept in order. Returns the new knobs. */
export function patchLifeKnobs(knobs: LifeKnobs, patch: unknown): LifeKnobs {
  const next = { ...knobs };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return next;
  for (const key of Object.keys(LIFE_KNOB_RANGES) as (keyof LifeKnobs)[]) {
    const value = (patch as Record<string, unknown>)[key];
    const [lo, hi] = LIFE_KNOB_RANGES[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi) next[key] = value;
  }
  const order = (a: keyof LifeKnobs, b: keyof LifeKnobs) => { if (next[a] > next[b]) [next[a], next[b]] = [next[b], next[a]]; };
  order('peekPerHourMin', 'peekPerHourMax'); order('placeMinutesMin', 'placeMinutesMax'); order('smallMinutesMin', 'smallMinutesMax'); order('pausesPerMinuteMin', 'pausesPerMinuteMax');
  next.peekPerHourMin = Math.round(next.peekPerHourMin); next.peekPerHourMax = Math.round(next.peekPerHourMax);
  return next;
}

/** How often, from the drives: livelier → more peeks, shorter gaps between moves; stiller (sleepy, low energy) → more idle pauses. */
export interface LifeRates { peekPerHour: number; placeMinutes: number; smallMinutes: number; pausesPerMinute: number }
export function lifeRates(drives: LifeDrives, knobs: LifeKnobs = LIFE_KNOB_DEFAULTS): LifeRates {
  const e = drives.energy, still = clamp01(0.6 - 0.6 * e + 0.6 * drives.sleepy);
  return {
    // Floor: at her baseline (energy 0.5) two an hour, as the peek had before step 4; the most only when she is at her liveliest.
    peekPerHour: Math.min(knobs.peekPerHourMax, Math.floor(lerp(knobs.peekPerHourMin, knobs.peekPerHourMax, e) + 1e-9)),
    placeMinutes: lerp(knobs.placeMinutesMax, knobs.placeMinutesMin, e),
    smallMinutes: lerp(knobs.smallMinutesMax, knobs.smallMinutesMin, e),
    pausesPerMinute: lerp(knobs.pausesPerMinuteMin, knobs.pausesPerMinuteMax, still),
  };
}
