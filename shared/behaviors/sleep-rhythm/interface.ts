/**
 * I-022 "她的作息"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 原来（2026-11-03 的 shared/fatigue.ts）：应用关着时困意积累 A 和困倦 F 都冻住（offlineVirtualRest: false），最多只算 2 小时；
 * 只有她在应用里真的睡着时 A 才消退，白天和深夜一个样（入睡门槛 0.72、刚醒 0.18、3 小时消掉约 63%）。用户开着她过了几天，
 * A 只涨不消，11-04 早上 A = 0.75，几乎每句都说困。
 * 现在：
 *  1. 她不在屏幕上的时间（应用关着、你在陪别的角色、电脑睡眠）按"她在睡觉"算：那一刻在应用里睡着会消多快 × 质量
 *     （深夜整段算，白天算一半），最多算 24 小时。关了多久只在一处算（shared/app-session.ts 的 closedSpan）：体验记录的
 *     "应用启动"那一行和这里用同一个数。
 *  2. 深夜（她的钟）你 30 分钟没理她时，她入睡的门槛低一点（0.62，白天 0.72）；深夜睡着时消得快一点（×1.5）；深夜里不自己醒，
 *     等深夜过去困意够低了再醒。白天的一切照旧：同样的输入，白天每一步的 A、F、相位和原来一模一样（tests/sleep-rhythm.test.ts
 *     对着原来那份模型的冻结副本逐步比）。
 *
 * 谁调用它、怎么调用：
 *  1. 困倦模型（shared/fatigue.ts 的 advanceFatigue）是唯一的调用方：每一秒的一步里问 rhythm.ts 的
 *     - nightAt()：她的钟这一刻在不在深夜；
 *     - rulesAt()：这一步用哪组门槛（深夜而且你够久没理她 → 深夜的入睡门槛；深夜 → 不自己醒、消得快）；
 *     - restRate()：这一步睡着（或关着）时困意消退的速度倍数。
 *     参数都是 FatigueParameters 里的字段，默认值来自 knobs.ts（sleepRhythmParameters），角色卡不带这些。
 *  2. 主机（electron/fatigue-host.ts）在她回到屏幕上时把"她离开了多久"交给困倦模型的 offline 那一步，记下这一次按休息算掉了多少
 *     （开发者面板看，只在内存）。应用关着的那段由 electron/app-session/ 算一次（上次停在什么时候、关了多久），同一个数交给体验记录和这里。
 *  3. 内心循环的"深夜"（shared/inner-loop.ts 的 innerLoopNightWindow）用 rhythm.ts 的 nightWindow，同一段深夜。
 *
 * 假实现在 fake.ts（参数和 2026-11-03 一模一样 = 原来的做法），守约测试在 tests/sleep-rhythm.test.ts：换一种实现，先过那组测试。
 */
import type { FatigueParameters } from '../../fatigue';

/** 困倦参数里归作息管的那几个（默认值都从 knobs.ts 来）。 */
export type SleepRhythmParameters = Pick<FatigueParameters,
  'nightPeakMinute' | 'maxOfflineMs' | 'offlineVirtualRest' | 'offlineRestQuality' | 'offlineNightRestQuality'
  | 'nightRestScale' | 'nightSleepEnter' | 'nightSleepExit' | 'nightQuietMs' | 'nightRecoveredA'
  | 'wakeRateDay' | 'wakeRateNight' | 'wakeRateRiseMinute' | 'wakeRateNightMinute' | 'wakeRateFallMinute' | 'wakeRateDayMinute'>;

/** 深夜在哪一段（本地分钟，0～1440）：以 nightPeakMinute 为中心、左右各 halfWidthMinutes。 */
export interface NightWindow { readonly start: number; readonly end: number; readonly halfWidthMinutes: number }

/** 这一步用的门槛和消退速度。白天（或深夜但你刚理过她）时入睡的两个门槛就是参数里白天的那两个。 */
export interface SleepRules {
  readonly sleepEnter: number;
  readonly sleepExit: number;
  /** 睡着时困意积累降到多少她会自己醒（还要 F ≤ recoveredF、睡够 minSleepResidenceMs）。 */
  readonly recoveredA: number;
  /** 睡着（或关着）时的消退速度倍数：dt × 质量 × restScale / restTauMs。 */
  readonly restScale: number;
}
