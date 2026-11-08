/**
 * I-022 的假实现 = 原来的做法（2026-11-03 的 shared/fatigue.ts）：应用关着时 A 和 F 都冻住、最多算 2 小时；深夜和白天一个样
 * （入睡 0.72、正在入睡时降到 0.60 就不睡、刚醒 0.18、消退倍数 1）。把这组参数盖到困倦参数上，模型就和原来一模一样
 * （tests/sleep-rhythm.test.ts 对着原来那份的冻结副本逐步比）。只给测试和以后对照用，应用不用它。
 */
import type { FatigueParameters } from '../../fatigue';
import type { SleepRhythmParameters } from './interface';

/** The rhythm parameters that reproduce the 2026-11-03 model on top of `p` (its day thresholds become the night ones). */
export function originalSleepRhythm(p: Pick<FatigueParameters, 'sleepEnter' | 'sleepExit' | 'recoveredA'>): SleepRhythmParameters {
  return Object.freeze({
    nightPeakMinute: 180, maxOfflineMs: 2 * 3_600_000, offlineVirtualRest: false, offlineRestQuality: 0.25, offlineNightRestQuality: 0.25,
    nightRestScale: 1, nightSleepEnter: p.sleepEnter, nightSleepExit: p.sleepExit, nightQuietMs: 0, nightRecoveredA: p.recoveredA,
    // I-043 not yet: the same 18-hour pace at every hour.
    wakeRateDay: 1, wakeRateNight: 1, wakeRateRiseMinute: 1260, wakeRateNightMinute: 0, wakeRateFallMinute: 300, wakeRateDayMinute: 480,
  });
}

/** `p` with the original rhythm: the whole fatigue model as it was before I-022. */
export function originalFatigueParameters<P extends FatigueParameters>(p: Readonly<P>): Readonly<P> {
  // Before I-043 the clock also added its own sleepiness (clockSleepWeight was clockWeight).
  return Object.freeze({ ...p, ...originalSleepRhythm(p), clockSleepWeight: p.clockWeight });
}
