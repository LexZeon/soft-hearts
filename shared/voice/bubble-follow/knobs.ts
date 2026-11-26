/**
 * 功能：开着朗读时，她的气泡跟着声音走（I-165）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 开着朗读、声音能念时，她的气泡（桌宠窗口、桌宠用 Unbound 引擎的窗口、全屏 Unbound）在一句开始出声时才出这一句；
 *    第一句出声前气泡是"……"（三个点）。控制窗口的聊天页不变（整段马上出，那是记录）。
 *  - 声音不跟的时候照旧马上全出：没开朗读、声音出错、Drama 3 本月额度用完、被打断（说话打断、发新消息、点停止）、
 *    只演不说；还有保险：下一句该出声却迟迟没出（下面几个 Stall），剩下的一下全出。
 *  - 主进程和两个窗口读的是同一个常量，所以"跟不跟"两边总是一致的（不一致会让朗读等气泡、气泡等朗读）。
 * 这些都只是试用值，没在真机上看过。
 */

export type BubbleFollowMode = 'sentence' | 'char' | 'off';

export interface BubbleFollowKnobs {
  readonly mode: BubbleFollowMode;
  readonly firstStallMs: number;
  readonly nextStallMs: number;
  readonly sentenceMaxMs: number;
  readonly charMs: number;
  readonly charMsRange: readonly [number, number];
  readonly proofWaitMs: number;
}

export const BUBBLE_FOLLOW_KNOBS: BubbleFollowKnobs = Object.freeze<BubbleFollowKnobs>({
  // 用户可能怎么说：气泡还是比声音快／想要像字幕一样一个字一个字出／想回到原来那样字先出来
  // 怎么调：'sentence' = 念到哪一句整句出（默认）；'char' = 这一句里按念的速度一个字一个字出（试验，性能数字见 docs/claude/2026-11-20-bubble-follows-voice.md）；'off' = 回到以前：字先按阅读节奏出来，声音跟在后面
  mode: 'sentence',
  // 用户可能怎么说：开着朗读时第一句等太久才出来／一直是三个点
  // 怎么调：第一句的字齐了以后，等它出声最多多少毫秒；过了还没出声就把字全显示出来（声音照常念，只是不再等）
  firstStallMs: 10_000,
  // 用户可能怎么说：念完一句以后下一句卡住不出字
  // 怎么调：一句念完、下一句的字已经有了，等下一句出声最多多少毫秒；过了就把剩下的字全显示出来
  nextStallMs: 4_000,
  // 用户可能怎么说：一句话念到一半卡住了，后面的字一直不出
  // 怎么调：一句开始出声以后最多等它念多久（毫秒）；超过就把剩下的字全显示出来
  sentenceMaxMs: 30_000,
  // 用户可能怎么说：一个字一个字出的时候字比声音快／比声音慢
  // 怎么调：逐字模式里第一句每个字按多少毫秒算（之后的句子按她前面几句真实念的速度算）；只在 mode 是 'char' 时用
  charMs: 220,
  // 怎么调：逐字模式里每个字的毫秒数夹在这个范围里（防止一句特别短或特别长的句子把速度算歪）
  charMsRange: [60, 600],
  // 用户可能怎么说：朗读停在半路不动了
  // 怎么调：主进程等气泡显示上一句的最长时间（毫秒）；超过就当这条朗读出了问题，停下朗读、气泡全显示（防止互相等）
  proofWaitMs: 30_000,
});

/** The mode the host and both windows use. */
export function bubbleFollowMode(knobs: BubbleFollowKnobs = BUBBLE_FOLLOW_KNOBS): BubbleFollowMode {
  return knobs.mode === 'char' || knobs.mode === 'off' ? knobs.mode : 'sentence';
}
