/**
 * I-048「陪看时间线」的接口（I-020：一个功能一个文件夹，接口写清楚）。记录：docs/claude/2026-11-08-i048-step1.md。
 *
 * 四块，都是不碰时钟、文件和模型的纯逻辑（时间由调用的人传进来），所以能单独测：
 *  1. timeline.ts：内存里的时间线。听到（转写）、看到（画面描述，按截图那一刻插入，没写好先占位）、概要（压缩旧的）。
 *     render 出交给她这一轮的那一块文字。
 *  2. scheduler.ts：haiku 的活怎么排（排队的人）。优先级、每小时/每几分钟的额度、该作废时全部作废。
 *  3. frame-change.ts：小灰度缩略图比一比，画面变得够大才值得描述；同一个画面不描述两次。
 *  4. knobs.ts：上面所有的数字。
 * 硬盘上的看剧笔记和截图缓存在 electron/watch-notes/；关键词在 shared/memory-keywords/。
 * 这一步没接进任何窗口、没调任何模型；接线是第二步。
 */

export type TimelineKind = 'heard' | 'seen' | 'summary';

export interface TimelineEntry {
  readonly id: number;
  readonly kind: TimelineKind;
  /** 发生的时间：听到 = 转写那一段的时间；看到 = 截图那一刻（不是 haiku 写完的时间）；概要 = 它压到的最后时刻。 */
  readonly at: number;
  readonly text: string;
  /** 看到：画面描述还没写好，先占着位置。 */
  readonly pending: boolean;
}

/** 一帧还没写好的画面描述的凭据：写好以后拿它填回原来的位置。时间线换了一代（关了陪看）它就作废。 */
export interface SeenTicket {
  readonly id: number;
  readonly generation: number;
  readonly at: number;
}

export type HaikuJobKind = 'look' | 'frame' | 'summary';

export interface HaikuJob {
  readonly id: number;
  readonly kind: HaikuJobKind;
  /** 排进来时的一代：作废以后，这一代的结果都不能再用。 */
  readonly epoch: number;
}
