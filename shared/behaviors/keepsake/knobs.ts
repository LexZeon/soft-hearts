/**
 * 功能：给你留点东西（I-050 她的文件夹，第 2 步：特别的日子提前准备、平时偶尔留一份）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 她开口说话的次数不在这里：留东西被挑中后，和别的主动说话共用同一个间隔、每小时上限（shared/behaviors/opening-choice/）。
 * 这里的"至少隔多久""最多试几次"只是怕太花额度的兜底。这些都只是试用值，没在真机上看过。
 */
export interface KeepsakeKnobs {
  readonly prepLeadDays: { readonly min: number; readonly max: number };
  readonly occasionalGapHours: { readonly min: number; readonly max: number };
  readonly maxAttempts: number;
  readonly retryGapMs: number;
  readonly mentionKeepMs: number;
  readonly contentMaxChars: number;
  readonly contentMinChars: number;
}

export const KEEPSAKE_KNOBS: KeepsakeKnobs = Object.freeze<KeepsakeKnobs>({
  // 用户可能怎么说：她提前好多天就准备了／我生日到了她还没准备
  // 怎么调：快到特别的日子前几天开始准备，在这个范围里按日子随机定一个数（每个日子每年定一次，不会变来变去）
  prepLeadDays: { min: 2, max: 6 },
  // 用户可能怎么说：她老往文件夹里放东西／她很久都不放东西
  // 怎么调：她自己想留东西（不是特别的日子）时，两次之间至少隔多少小时，在这个范围里随机；爱黏人、爱玩的卡隔得短一点，「她主动找你说话」选少一点会拉长
  occasionalGapHours: { min: 10, max: 36 },
  // 用户可能怎么说：她准备失败了就不再试／她老是重试
  // 怎么调：同一个日子同一年最多试几次（兜底：模型出错时不无限花额度）
  maxAttempts: 2,
  // 用户可能怎么说：她失败了过好久才重试／重试得太快
  // 怎么调：同一个日子两次尝试之间至少隔多少毫秒
  retryGapMs: 6 * 3_600_000,
  // 用户可能怎么说：她过了好几天才告诉我／她提了一句我已经看到文件了
  // 怎么调：她顺口提一句的话在这么久（毫秒）之内还有机会说，过了就不说了，文件仍在；特别的日子的话留到当天过完的第二天结束
  mentionKeepMs: 6 * 3_600_000,
  // 用户可能怎么说：她写得太长了／写得太短了
  // 怎么调：一份东西的字数上限（字符），提示词里说的是几百到一千多字
  contentMaxChars: 12_000,
  // 用户可能怎么说：她只写了一两句就放进来了
  // 怎么调：太短的东西不放（字符）
  contentMinChars: 12,
});
