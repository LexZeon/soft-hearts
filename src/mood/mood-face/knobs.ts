/**
 * 功能：她的脸怎么跟着心情走：通用表情滑块、心情换名字时的过渡、余温和细小漂移（抽搐第三轮、I-073，怎么调见 docs/claude/how-to-tune-mood-face.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法（细节和例子在 docs/claude/how-to-tune-mood-face.md）：
 *  - 脸由一组通用滑块组成（笑眼、嘴角笑、难过眉、生气眉、眯眼、挑眉、脸红、头的俯仰），所有模型同一套，模型没有的那个滑块就跳过。
 *  - 心情的五个数（奖励 D、亲近 O、安心 E、兴奋 N、压力 C）和想念，先变成"脸读到的心情"：跟上去要一点时间（follow），
 *    一件事让她高兴以后先保持几秒再回落（hold），平时还有很慢的细小漂移（drift）。
 *  - 滑块的值按"脸读到的心情"离几个典型状态（平静、亲近、满足、开心、兴奋、担心、失落、想念、难过、又紧张又期待）有多近来混合；
 *    正好在某个典型状态上就是那个状态的样子（和以前按名字查表一样），中间平滑过渡。心情的名字只在这之上加一点风格（labelStyle）。
 *  - 名字换了，那一点风格按 S 曲线过渡（driftSeconds）。被摸头、喂食、脸红那一下、反应、小表情、说话都不走这些，还是原来的快慢。
 * 这些都只是试用值，没在真机上看过。
 */

export interface MoodFaceKnobs {
  readonly driftSeconds: number;
  readonly labelStyle: number;
  readonly anchorWidth: number;
  readonly follow: number;
  readonly hold: { readonly base: number; readonly perPoint: number; readonly max: number; readonly release: number };
  readonly drift: { readonly face: number; readonly headX: number; readonly speed: number };
  readonly regions: Readonly<Record<'eyes' | 'mouth' | 'brows' | 'blush' | 'head', readonly [rise: number, fall: number]>>;
}

export const MOOD_FACE_KNOBS: MoodFaceKnobs = Object.freeze<MoodFaceKnobs>({
  // 用户可能怎么说：她不说话的时候脸和头自己抽一下／心情变了脸变得太慢了，像没反应
  // 怎么调：心情换名字时，名字带来的那一点风格从旧到新用几秒（S 曲线）。调大 = 更慢更柔；0 = 当帧换
  driftSeconds: 1.2,
  // 用户可能怎么说：心情名字变了脸却没什么变化／脸太跟着名字走，数字差不多时样子却差很多
  // 怎么调：心情明显时，名字自己的样子占多少（0～1）。0 = 只看心情的数；1 = 心情明显时完全按名字
  labelStyle: 0.3,
  // 用户可能怎么说：她的表情在几种样子之间切得太明显／几种心情看起来都差不多
  // 怎么调：混合典型状态时看多远（心情数的差，按 50 点 = 1 算）。调小 = 更像离得最近的那一种，中间过渡更短；调大 = 更多地混在一起
  anchorWidth: 0.27,
  // 用户可能怎么说：开心的事发生后，她的脸过好一会儿才笑起来／一下子就变了脸，太突然
  // 怎么调：脸跟上心情数字有多快（1/秒，临界阻尼）。2 = 约 2 秒到 90%；调大 = 更快
  follow: 2,
  hold: {
    // 用户可能怎么说：开心完一下子就收了，没有余韵／高兴的样子停留太久了
    // 怎么调：一件事让她心情变了以后，脸先保持多少秒再跟着回落：base + 每点变化 perPoint 秒，最多 max 秒；之后用 release 秒慢慢放开
    base: 1.5,
    perPoint: 0.35,
    max: 8,
    release: 2,
  },
  drift: {
    // 用户可能怎么说：她平时脸一动不动，像僵住了／她平时脸上的小变化太多，像在抽
    // 怎么调：平时那点很慢的细小漂移：face = 脸上正在显示的表情最多增减几成（0.15 = ±15%，没显示的表情不会被漂出来）；headX = 头的俯仰最多多少弧度（0.002 约 0.1°）；speed 越小越慢（0.02 约半分钟一个来回）
    face: 0.15,
    headX: 0.002,
    speed: 0.02,
  },
  // 用户可能怎么说：她的眉毛动得太快／脸红来得太突然／嘴角变化太慢
  // 怎么调：每个区域的显示值追目标的时间常数（秒）：[变大时, 变小时]。调大 = 更慢更柔
  regions: { eyes: [0.35, 0.5], mouth: [0.3, 0.45], brows: [0.45, 0.65], blush: [0.6, 0.9], head: [0.5, 0.7] },
});
