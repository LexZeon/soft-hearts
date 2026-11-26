/**
 * 功能：全屏 Unbound 的地面线跟着她走，凑近时照旧是脸的特写
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 三段（shared/unbound/framing/floor.ts）：放得下全身时脚踩在工作区底边上方那条线上，远近只是大小；近到放不下全身时头顶贴着上沿、
 * 脚慢慢沉下去；再近就交给"脸的特写"（相机在她脸的高度，凑镜头、拉到最近时脸几乎占满屏幕）。这些都只是试用值，没在真机上看过。
 */
export interface FloorFramingKnobs {
  readonly topMarginShare: number;
  readonly closeShare: number;
  readonly followRate: number;
}

export const FLOOR_FRAMING_KNOBS: FloorFramingKnobs = Object.freeze<FloorFramingKnobs>({
  // 用户可能怎么说：她走近时头顶被屏幕上沿切掉了／走近时她头上空出来太多
  // 怎么调：她大到放不下全身时，头顶离工作区上沿留多少（工作区高度的几成，0.05 = 5%）
  topMarginShare: 0.05,
  // 用户可能怎么说：凑近时脸还不够大、不像以前那样占满屏／还没走多近就已经换成大特写了
  // 怎么调：在多近交完给脸的特写：刚好放得下全身的那个距离乘几（0.4 = 四成），越小交得越晚
  closeShare: 0.4,
  // 用户可能怎么说：换了模型或换了屏幕以后，画面上下挪得太快／太慢
  // 怎么调：她的位置一下子变了（换模型、换屏幕）时，画面跟上她的快慢（弹簧系数，4 ≈ 1 秒左右跟上），越大越快
  followRate: 4,
});
