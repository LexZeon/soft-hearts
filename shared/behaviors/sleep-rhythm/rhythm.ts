/**
 * I-022 的真实现（接口见 interface.ts，旋钮见 knobs.ts）：纯函数，零额度，不碰聊天提示词。困倦模型（shared/fatigue.ts）每一步问这里
 * "这一刻在不在深夜、用哪组门槛、消退多快"；参数都在 FatigueParameters 里，默认值由 sleepRhythmParameters() 从旋钮算出来。
 *
 * 白天不变的保证（tests/sleep-rhythm.test.ts 逐步比）：不在深夜时 rules() 交回的就是参数里白天的那组门槛、消退倍数正好是 1，
 * 困倦模型的算式和原来一字不差（乘 1 是精确的），所以同样的输入，白天每一步的 A、F、相位和原来一模一样。
 */
import type { FatigueParameters } from '../../fatigue';
import { SLEEP_RHYTHM_KNOBS, type SleepRhythmKnobs } from './knobs';
import type { NightWindow, SleepRhythmParameters, SleepRules } from './interface';

const DAY_MINUTES = 1440, MINUTE_MS = 60_000, HOUR_MS = 3_600_000;
const wrap = (minute: number) => ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

/** The rhythm's share of DEFAULT_FATIGUE_PARAMETERS, from the knobs (the only place their values are written). */
export function sleepRhythmParameters(knobs: SleepRhythmKnobs = SLEEP_RHYTHM_KNOBS): SleepRhythmParameters {
  return {
    nightPeakMinute: knobs.night.peakMinute,
    maxOfflineMs: knobs.offline.longestRestHours * HOUR_MS,
    offlineVirtualRest: true,
    offlineRestQuality: knobs.offline.dayQuality,
    offlineNightRestQuality: knobs.offline.nightQuality,
    nightRestScale: knobs.night.restSpeed,
    nightSleepEnter: knobs.night.sleepEnter,
    nightSleepExit: knobs.night.sleepExit,
    nightQuietMs: knobs.night.quietMinutes * MINUTE_MS,
    nightRecoveredA: knobs.night.wakeBelow,
    wakeRateDay: knobs.wake.dayRate,
    wakeRateNight: knobs.wake.nightRate,
    wakeRateRiseMinute: knobs.wake.speedUpFrom,
    wakeRateNightMinute: knobs.wake.fastFrom,
    wakeRateFallMinute: knobs.wake.fastUntil,
    wakeRateDayMinute: knobs.wake.slowFrom,
  };
}

type WakeRateParameters = Pick<FatigueParameters, 'wakeRateDay' | 'wakeRateNight' | 'wakeRateRiseMinute' | 'wakeRateNightMinute' | 'wakeRateFallMinute' | 'wakeRateDayMinute'>;
const forward = (from: number, to: number) => wrap(to - from);

/** The four points of the wake rate go round the clock once, in order: day → speeding up → night → slowing down → day. */
export function wakeRateArcsValid(p: WakeRateParameters): boolean {
  const points = [p.wakeRateDayMinute, p.wakeRateRiseMinute, p.wakeRateNightMinute, p.wakeRateFallMinute];
  if (points.some(minute => !Number.isFinite(minute) || minute < 0 || minute >= DAY_MINUTES)) return false;
  const arcs = points.map((minute, index) => forward(minute, points[(index + 1) % points.length]));
  return arcs.every(arc => arc > 0) && arcs.reduce((sum, arc) => sum + arc, 0) === DAY_MINUTES;
}

/**
 * I-043: how fast her sleep pressure builds at this local minute while she is awake (× the 18-hour pace). Day: the day rate;
 * from wakeRateRiseMinute it rises evenly to the night rate at wakeRateNightMinute; the night rate until wakeRateFallMinute;
 * then it falls evenly back to the day rate by wakeRateDayMinute. A clock that cannot be read counts as day.
 */
export function wakeRateAt(localMinute: number, p: WakeRateParameters): number {
  if (!Number.isFinite(localMinute)) return p.wakeRateDay;
  const m = wrap(localMinute), inside = (from: number, to: number) => forward(from, m) < forward(from, to);
  if (inside(p.wakeRateDayMinute, p.wakeRateRiseMinute)) return p.wakeRateDay;
  if (inside(p.wakeRateRiseMinute, p.wakeRateNightMinute))
    return p.wakeRateDay + (p.wakeRateNight - p.wakeRateDay) * forward(p.wakeRateRiseMinute, m) / forward(p.wakeRateRiseMinute, p.wakeRateNightMinute);
  if (inside(p.wakeRateNightMinute, p.wakeRateFallMinute)) return p.wakeRateNight;
  return p.wakeRateNight + (p.wakeRateDay - p.wakeRateNight) * forward(p.wakeRateFallMinute, m) / forward(p.wakeRateFallMinute, p.wakeRateDayMinute);
}

/**
 * Night window around the fatigue model's own `nightPeakMinute`, not a fixed clock range (moved here unchanged from
 * shared/inner-loop.ts innerLoopNightWindow, which now calls it: the inner loop's "深夜" and her night sleep are one window).
 * (I-043: the body clock no longer adds to her sleepiness, clockSleepWeight is 0; clockWeight keeps sizing this window so the
 * night stays where it was.) Formerly the body clock added `clockWeight × timeNeed(t)` to the sleep need, with
 * timeNeed(t) = (1 + cos(2π(t − nightPeakMinute)/1440)) / 2. r = clockWeight / lightEnter is how much of
 * the way to light drowsiness the body clock alone carries her at its peak. The window is where
 * timeNeed(t) ≥ 1 − r: a stronger body clock or an earlier light-drowsy threshold (an easily tired
 * character) widens it. Default parameters: peak 03:00, r ≈ 0.32, half-width ≈ 274 min, about 22:26–07:34.
 */
export function nightWindow(p: Pick<FatigueParameters, 'nightPeakMinute' | 'clockWeight' | 'lightEnter'>): NightWindow {
  const r = Math.min(1, Math.max(0, p.lightEnter > 0 ? p.clockWeight / p.lightEnter : 0));
  const halfWidthMinutes = Math.acos(Math.min(1, Math.max(-1, 1 - 2 * r))) / (2 * Math.PI) * DAY_MINUTES;
  return { start: wrap(p.nightPeakMinute - halfWidthMinutes), end: wrap(p.nightPeakMinute + halfWidthMinutes), halfWidthMinutes };
}

/** Whether a local minute (0–1440) is inside the night window. A clock that cannot be read is not night. */
export function nightAt(localMinute: number, p: Pick<FatigueParameters, 'nightPeakMinute' | 'clockWeight' | 'lightEnter'>,
  window: NightWindow = nightWindow(p)): boolean {
  if (!Number.isFinite(localMinute)) return false;
  const distance = Math.abs(wrap(localMinute - p.nightPeakMinute + DAY_MINUTES / 2) - DAY_MINUTES / 2);
  return window.halfWidthMinutes > 0 && distance <= window.halfWidthMinutes;
}

/** What the fatigue model asks once per advance (the window and the three rule sets are worked out once, not every second). */
export interface PreparedSleepRhythm {
  /** Whether her clock is in the night at this local phase (ms since local midnight). */
  night(localPhaseMs: number): boolean;
  /** This step's thresholds: night and the user away at least nightQuietMs → the night entry thresholds. */
  rules(night: boolean, quietMs: number): SleepRules;
  /** Rest quality of a step she spends off screen (the app closed, another character, the computer asleep). */
  offlineQuality(night: boolean): number;
  /** I-043: how fast sleep pressure builds while she is awake at this local phase (ms since local midnight). */
  wakeRate(localPhaseMs: number): number;
}

export function prepareSleepRhythm(p: Readonly<FatigueParameters>): PreparedSleepRhythm {
  const window = nightWindow(p);
  const day: SleepRules = Object.freeze({ sleepEnter: p.sleepEnter, sleepExit: p.sleepExit, recoveredA: p.recoveredA, restScale: 1 });
  // Night but the user was with her lately: the day entry thresholds (so the rest reminder's "you are still up" is untouched).
  const nightNear: SleepRules = Object.freeze({ sleepEnter: p.sleepEnter, sleepExit: p.sleepExit, recoveredA: p.nightRecoveredA, restScale: p.nightRestScale });
  const nightAway: SleepRules = Object.freeze({ sleepEnter: p.nightSleepEnter, sleepExit: p.nightSleepExit, recoveredA: p.nightRecoveredA, restScale: p.nightRestScale });
  return {
    night: localPhaseMs => nightAt(localPhaseMs / MINUTE_MS, p, window),
    rules: (night, quietMs) => !night ? day : quietMs >= p.nightQuietMs ? nightAway : nightNear,
    offlineQuality: night => night ? p.offlineNightRestQuality : p.offlineRestQuality,
    wakeRate: localPhaseMs => wakeRateAt(localPhaseMs / MINUTE_MS, p),
  };
}
