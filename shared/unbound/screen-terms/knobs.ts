/**
 * 功能：全屏 Unbound 里她站哪、走多远都按你屏幕上看到的样子定（I-212）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * "多大"是她整个人的高度占屏幕可用高度（去掉任务栏，从脚下那条线到屏幕顶）的比例；1 = 正好从任务栏站到屏幕顶。换算在 convert.ts。
 * 这些都只是试用值，没在真机上看过。
 */
export interface ScreenTermsKnobs {
  readonly firstSize: number;
  readonly toldViewAngleDeg: number;
}

export const SCREEN_TERMS_KNOBS: ScreenTermsKnobs = Object.freeze<ScreenTermsKnobs>({
  // 用户可能怎么说：第一次进全屏她太大／太小（了"按屏幕占一半高"）
  // 怎么调：没设默认位置、也没有上次的位置时，第一次出场她占屏幕可用高度的多少（0.5 = 一半高）
  firstSize: 0.5,
  // 用户可能怎么说：她说离我几米，听着比看起来远／近
  // 怎么调：告诉她"离用户约几米"时，把可用屏幕当成多大竖直视角的取景框（度）；越大说的米数越小。同样的画面在哪台电脑上都是同一个米数
  toldViewAngleDeg: 45,
});
