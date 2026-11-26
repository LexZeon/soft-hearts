/**
 * 功能：I-136 Unbound v1 第 5 步「拉她」（方案 docs/claude/2026-11-18-unbound-step5-plan.md，记录 docs/claude/2026-11-18-unbound-step5.md）。
 *
 * 能调的数都在这里，全是起点数字（拖到她身高的 60% 算拉满；倾身约 15°、头约 10°、手臂最多伸直；
 * Unbound 跟着走不超过她平时的走路速度）。拖得再远，样子不再变大，只算"更用力"。
 *
 * 硬上限（PULL_BOUNDS）在 normalizePullKnobs 里，任何来源的数（调参、测试、以后的开发者面板）都过它：拉得太狠会像施暴，所以样子有
 * 封顶，改数也改不过它。变异检查 scripts/dev/mutations/stage.json 的 P1 守着这一条。
 */

export interface PullKnobs {
  // ---- 5a 认出你在拉哪儿（输入，和点一下分开：shared/unbound/click.ts 的 8 像素 / 0.45 秒）
  /** 按下后挪过这么多像素（CSS px）才算开始拉。 */
  readonly startMovePx: number;
  /** 按住不动这么久（毫秒）也算开始拉（力度 0，"拉着不放"）。 */
  readonly startHoldMs: number;
  /** 拉着超过这么久（毫秒）先报一次"还拉着"，松手再报一次。 */
  readonly holdingReportMs: number;
  /** 拖的距离到她身高（屏幕上）的这一份算拉满（力度 1）。 */
  readonly fullPull: number;

  // ---- 5b 身体（上限；从当前显示的姿势出发叠加，带淡入淡出）
  /** 腰以上最多倾这么多度（拉身体）。 */
  readonly leanMaxDeg: number;
  /** 头和脖子一起最多转这么多度（拉头）。 */
  readonly headMaxDeg: number;
  /** 上臂最多朝你拉的方向摆这么多度（拉手、胳膊）。 */
  readonly armSwingMaxDeg: number;
  /** 手肘最多伸直这一份（1 = 伸直）。 */
  readonly armExtend: number;
  /** 桌宠里拉脚：膝盖最多绕"胯到脚踝"那条线转这么多度（脚不动）。 */
  readonly kneeMaxDeg: number;
  /** 拉手、拉头、拉脚时，余下的力给上身：各占 leanMaxDeg 的这一份。 */
  readonly leanShareArm: number;
  readonly leanShareHead: number;
  readonly leanShareFoot: number;
  /** 鼠标 → 拉的目标（rad/s，临界阻尼）；目标 → 显示的转动（第二级，更柔，起步和松手都没有突变）。 */
  readonly followOmega: number;
  readonly settleOmega: number;

  // ---- 5c Unbound 跟着走
  /** 跟着走的最快速度，是她平时走路速度的这一份（≤ 1：不比走路快）。 */
  readonly followSpeedShare: number;
  /** 拉身体、拉手往旁边超过她身高的这一份，才给步态一个"想去的点"。 */
  readonly followStartShare: number;
  /** 拉脚：这只脚最多抬起她身高的这一份（根点高度不变，不离地）。 */
  readonly footLiftShare: number;
  /** 松手后至少这么多分钟她不自己走回去（之后按心情决定挪不挪）。 */
  readonly stayMinutes: number;
}

export const PULL_KNOBS: PullKnobs = Object.freeze({
  startMovePx: 8,
  startHoldMs: 450,
  holdingReportMs: 1500,
  fullPull: 0.6,
  leanMaxDeg: 15,
  headMaxDeg: 10,
  armSwingMaxDeg: 40,
  armExtend: 1,
  kneeMaxDeg: 8,
  leanShareArm: 0.5,
  leanShareHead: 0.35,
  leanShareFoot: 0.3,
  followOmega: 8,
  settleOmega: 6,
  followSpeedShare: 1,
  followStartShare: 0.08,
  footLiftShare: 0.04,
  stayMinutes: 5,
});

/** 硬上限：[最小, 最大]。样子永远不超过这些，换什么数都一样。 */
export const PULL_BOUNDS: Readonly<Record<keyof PullKnobs, readonly [number, number]>> = Object.freeze({
  startMovePx: [2, 40],
  startHoldMs: [200, 2000],
  holdingReportMs: [500, 10_000],
  fullPull: [0.2, 1.5],
  leanMaxDeg: [0, 20],
  headMaxDeg: [0, 15],
  armSwingMaxDeg: [0, 60],
  armExtend: [0, 1],
  kneeMaxDeg: [0, 12],
  leanShareArm: [0, 1],
  leanShareHead: [0, 1],
  leanShareFoot: [0, 1],
  followOmega: [2, 30],
  settleOmega: [2, 20],
  followSpeedShare: [0, 1],
  followStartShare: [0, 0.5],
  footLiftShare: [0, 0.08],
  stayMinutes: [0, 60],
});

/** Every value through its hard bound; anything missing or not a finite number takes the starting value. */
export function normalizePullKnobs(input?: Partial<Record<keyof PullKnobs, unknown>> | null): PullKnobs {
  const out = {} as Record<keyof PullKnobs, number>;
  for (const key of Object.keys(PULL_KNOBS) as (keyof PullKnobs)[]) {
    const raw = input?.[key], [min, max] = PULL_BOUNDS[key];
    out[key] = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : PULL_KNOBS[key];
  }
  return Object.freeze(out);
}
