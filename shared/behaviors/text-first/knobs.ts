/**
 * 功能：文字为主，细看才附图（I-085 第 3 步）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 「和她一起看」和「发图片」开着时，平常的一句话不再附原图，她这一轮拿到的是文字：
 *  - 一起看：陪看时间线里最新的画面描述（带"多久以前"）；
 *  - 发图片：她最近自己看你一眼记下的那句话（10 分钟内，带"几分钟前"），没有就照实说"最近没看到"。
 * 带图的轮次会换掉常驻进程（旧画面不留在上下文里），所以平常不附图，第一个字能快约 0.9 秒。
 * 只在需要时附一张原图：你叫她看、指着屏幕问（"这是谁""屏幕上那个"）、问你的样子、按按钮、答应她要看；
 * 或者一起看时她特别好奇、最新的画面描述又旧又不清楚（下面 curious 这几个旋钮）。
 * 安全线不是旋钮，写在 electron/senses/look-attachments.ts：说过"别看"什么都不给（文字也不给）；画面不存。
 * 这些都只是试用值，没在真机上看过。
 */

export interface TextFirstKnobs {
  readonly enabled: boolean;
  readonly curious: {
    readonly enabled: boolean;
    readonly minRise: number;
    readonly staleMs: number;
    readonly cooldownMs: number;
  };
}

export const TEXT_FIRST_KNOBS: TextFirstKnobs = Object.freeze({
  // 用户可能怎么说：一起看的时候她看得不够清楚，我宁愿慢一点也要她每句都看原图
  // 怎么调：false 就回到以前（一起看每句带一帧屏幕，「发图片」每句带一张小图；第一个字每句慢约 0.9 秒）
  enabled: true,
  curious: Object.freeze({
    // 用户可能怎么说：一起看的时候她从来不自己凑近看看／她老是自己凑过来看
    // 怎么调：false 就只在你叫她看时才附图
    enabled: true,
    // 用户可能怎么说：她好奇心那么重都不凑近看一眼
    // 怎么调：好奇（D）高过角色卡基线多少才算"特别好奇"（0～1，0.4 约等于明显高于平时）；调低她更常凑近看
    minRise: 0.4,
    // 用户可能怎么说：画面描述都过时了她还不看一眼
    // 怎么调：最新的画面描述旧了多久（毫秒）才算"不新鲜"；看不清的描述不等这个时间
    staleMs: 2 * 60_000,
    // 用户可能怎么说：她凑过来看得太勤了
    // 怎么调：她自己凑近看两次之间至少隔多久（毫秒）
    cooldownMs: 10 * 60_000,
  }),
});
