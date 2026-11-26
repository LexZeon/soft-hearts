/**
 * 功能：全屏 Unbound 里的"亲近的一下"：凑近看、亲亲、抱抱（I-184；之后的那一下"按性格定"）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 规则在同一个文件夹（chooser.ts 选哪一个、after-beat.ts 之后那一下、plan.ts 怎么做）。这些都只是试用值，没在真机上看过。
 */
export interface CloseMomentKnobs {
  readonly ownPerDay: number;
  readonly ownKissPerDay: number;
  readonly cooldownMinutes: number;
  readonly pulledCooldownMinutes: number;
  readonly pullHoldMs: number;
  readonly ownShare: number;
}

export const CLOSE_MOMENT_KNOBS: CloseMomentKnobs = Object.freeze<CloseMomentKnobs>({
  // 用户可能怎么说：她自己过来亲亲抱抱太勤了／一天都没自己来过
  // 怎么调：她自己来（不是你拉近的）的亲亲加抱抱一天最多几次（定的是两三次）
  ownPerDay: 3,
  // 用户可能怎么说：她一天自己来亲好几次，腻了
  // 怎么调：其中亲亲最多几次（抱抱占剩下的）
  ownKissPerDay: 2,
  // 用户可能怎么说：刚亲完没多久她又自己来了
  // 怎么调：亲过或抱过以后多少分钟内她不自己再来（拉近的另算，见下一个）
  cooldownMinutes: 45,
  // 用户可能怎么说：我一直把她拉近，她就一直亲／拉近好几次她都只是看
  // 怎么调：亲过或抱过以后多少分钟内，再把她拉近她不亲也不抱（会凑近看、害羞躲开或者什么都不做）
  pulledCooldownMinutes: 10,
  // 用户可能怎么说：一拉近她就做反应，我还没停稳／拉近停了很久她才有反应
  // 怎么调：把她拉到最近（脸几乎占满屏幕）停多久（毫秒）才算"拉近了"，短于这个就照以前那样凑近看一下
  pullHoldMs: 600,
  // 用户可能怎么说：她自己凑过来时几乎都是看，从来不亲／每次凑过来都是亲
  // 怎么调：她自己凑过来的那一次里，亲亲和抱抱最多能占几成（再乘心情、熟悉度、性格；0 = 她自己来只看不亲）
  ownShare: 0.45,
  // 亲亲、抱抱停多久（I-192 起由她自己定）在 shared/unbound/arrival/knobs.ts：kissHoldS、hugHoldS、holdCapS。
  // 她在回复里写的亲亲抱抱（I-185）没有冷却：原来的 chatCooldownMinutes（3 分钟）删了。
});

export const CLOSE_MOMENT_KNOB_RANGES = Object.freeze({
  ownPerDay: Object.freeze([0, 10] as const), ownKissPerDay: Object.freeze([0, 10] as const), cooldownMinutes: Object.freeze([1, 600] as const),
  pulledCooldownMinutes: Object.freeze([0, 120] as const), pullHoldMs: Object.freeze([0, 5_000] as const), ownShare: Object.freeze([0, 1] as const),
});

/** I-203 frames (frames.ts): how long her ⟦pause⟧ holds her words; a hug she is in goes on holding through it. */
export const CLOSE_FRAME_KNOBS = Object.freeze({
  // 用户可能怎么说：她回复里写的"停一会"停得太短（或太长）
  // 怎么调：⟦pause⟧ 让话停多少秒（I-203，大约 2 秒）
  pauseS: 2,
  // 用户可能怎么说：她写的"停久一点"（pause long）停得不够久（或太久）
  // 怎么调：⟦pause long⟧ 让话停多少秒（I-203，大约 4 秒）
  pauseLongS: 4,
});
