/**
 * 功能：全屏 Unbound 里"按住她拉近、推远、横走"的摇杆式拉法和"按住不动才算碰"（I-196、I-194，（摇杆式拉法 + 滚轮；按住头发算拉，不算碰）；
 * —点她打开输入框不算碰，框开着再点她、按住不动才算）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 规则在同一个文件夹（stick.ts 偏多远走多快、滚轮一格走多远；press.ts 一次按下是点、按住不动（碰）还是拉）。偏移量全是屏幕像素，和她在屏幕上多大无关。
 * 这些都只是试用值，没在真机上看过。
 */
export interface StickKnobs {
  readonly deadZonePx: number;
  readonly fullOffsetPx: number;
  readonly curve: number;
  readonly depthRatePerS: number;
  readonly sideRatePerS: number;
  readonly sideMaxMps: number;
  readonly lookAheadS: number;
  readonly holdTouchMs: number;
  readonly wheelStep: number;
  readonly wheelIdleMs: number;
}

export const STICK_KNOBS: StickKnobs = Object.freeze<StickKnobs>({
  // 用户可能怎么说：手一抖她就走了／我想按住不动她却在挪
  // 怎么调：按下的点周围多大一圈（屏幕像素）里怎么动都不算；超出这一圈才开始拉。要和"点一下"允许的手抖（shared/unbound/click.ts 的 8 像素）一样大
  deadZonePx: 8,
  // 用户可能怎么说：要拖很远才走得快／稍微一偏就跑太快
  // 怎么调：偏离按下点多少像素（屏幕像素）时走得最快；再远也不更快
  fullOffsetPx: 140,
  // 用户可能怎么说：刚一偏就走得太急／要偏很多才动起来
  // 怎么调：速度随偏移变大的曲线：1 是一条直线，越大越是"小偏移很慢、大偏移才快"
  curve: 1.5,
  // 用户可能怎么说：拉近拉远太慢／太快（近处也一样快慢）
  // 怎么调：偏到最远时，她和你的距离每秒变几成（按"看到的大小"算：0.9 约每秒近到原来的 0.4 倍以内；近处和远处一样）
  depthRatePerS: 0.9,
  // 用户可能怎么说：左右横走太慢／太快
  // 怎么调：偏到最远时横走，每秒走她离你距离的几分之几（近处看起来和远处走得一样快）
  sideRatePerS: 0.35,
  // 用户可能怎么说：远处横走比她的步子还快，追不上
  // 怎么调：横走每秒最多走多少米（她自己的步子也有上限）
  sideMaxMps: 0.9,
  // 用户可能怎么说：松手以后她还多走了一截／手一动她反应慢半拍
  // 怎么调：摇杆指的是"这么多秒以后她该到哪"，越大她越提前迈步、停得越晚（越小越跟手）
  lookAheadS: 0.5,
  // 用户可能怎么说：我只是想碰她一下，按住了没反应／刚按住就算碰了
  // 怎么调：在她身上按住不动（不超出上面那一圈）多少毫秒，算碰她一下（要比"点一下"的最长按下 450 毫秒长）
  holdTouchMs: 500,
  // 用户可能怎么说：滚轮一格拉得太多／太少
  // 怎么调：滚轮一格，她和你的距离变几成（按"看到的大小"算，近处和远处一样）
  wheelStep: 0.14,
  // 用户可能怎么说：滚轮滚完她还在动／滚几下她就停了又重新开始
  // 怎么调：滚轮停下多少毫秒后，这一次"拉"就结束（她站在哪就记为她的位置）
  wheelIdleMs: 700,
});

export const STICK_KNOB_RANGES = Object.freeze({
  deadZonePx: Object.freeze([3, 24] as const), fullOffsetPx: Object.freeze([60, 400] as const), curve: Object.freeze([1, 3] as const),
  depthRatePerS: Object.freeze([0.2, 2] as const), sideRatePerS: Object.freeze([0.1, 1] as const), sideMaxMps: Object.freeze([0.3, 1.4] as const),
  lookAheadS: Object.freeze([0.2, 1.2] as const), holdTouchMs: Object.freeze([460, 1500] as const), wheelStep: Object.freeze([0.04, 0.4] as const),
  wheelIdleMs: Object.freeze([300, 2000] as const),
});

/** Knobs with every value kept inside its range (a bad or missing number falls back to the default). */
export function stickKnobs(input?: Partial<Record<keyof StickKnobs, unknown>> | null): StickKnobs {
  const out = { ...STICK_KNOBS } as Record<keyof StickKnobs, number>;
  for (const key of Object.keys(STICK_KNOBS) as (keyof StickKnobs)[]) {
    const raw = input?.[key], [lo, hi] = STICK_KNOB_RANGES[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = Math.min(hi, Math.max(lo, raw));
  }
  return Object.freeze(out);
}
