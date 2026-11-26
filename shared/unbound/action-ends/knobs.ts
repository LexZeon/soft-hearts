/**
 * 功能：全屏 Unbound 里什么能打断她正在做的动作
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 * 规则在同一个文件夹的 rules.ts。只是试用值，没在真机上看过。
 */
export interface ActionEndKnobs {
  readonly largePullPx: number;
  readonly tugShare: number;
}

export const ACTION_END_KNOBS: ActionEndKnobs = Object.freeze<ActionEndKnobs>({
  // 用户可能怎么说：她亲我抱我的时候我轻轻拉了一下她就走了／我用力拉她她还不停
  // 怎么调：按住她以后鼠标离按下的点多少像素才算"大幅"（打断她正在做的，变成原来的拉她）；小于这个只是身子、头发跟着晃一下，动作照做。默认 60：摇杆的死区是 8、全速是 140，手搭在鼠标上的小晃动在 20～30 以内，60 已经是有意拉的一下
  largePullPx: 60,
  // 用户可能怎么说：她亲我抱我时我轻轻拉她，她一点反应都没有／晃得太厉害了
  // 怎么调：小幅拉到快到上面那个距离时，被按住的地方最多被带动她身高的几成（她离镜头很近时屏幕上的几十像素在她身上只有几毫米，按身高算才看得出来；离得远时就是原来的拉法）
  tugShare: 0.06,
});

export const ACTION_END_KNOB_RANGES = Object.freeze({ largePullPx: Object.freeze([20, 240] as const), tugShare: Object.freeze([0, 0.2] as const) });

/** The knobs with a patch applied (anything out of range or not a number keeps the default). */
export function actionEndKnobs(patch?: Partial<Record<keyof ActionEndKnobs, unknown>> | null): ActionEndKnobs {
  const pick = (key: keyof ActionEndKnobs) => {
    const value = patch?.[key], [lo, hi] = ACTION_END_KNOB_RANGES[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi ? value : ACTION_END_KNOBS[key];
  };
  return { largePullPx: pick('largePullPx'), tugShare: pick('tugShare') };
}
