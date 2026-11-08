/**
 * #5 回复说完以后气泡留多久的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 只有一个地方决定，另一边用它的结果：
 *  1. 主机的回复窗口（electron/reply-window.ts 的 PetReplyWindow）是唯一问"留多久"的一方：每次收到 'complete'（回复显示完，
 *     或朗读完）就把它此刻显示的文字和分泡交给 `ReplyLingerHost.decide`（electron/main.ts 接到 MoodHost.decideReplyLinger，
 *     它补上心情和角色卡），拿到的毫秒数就是这条回复的寿命（electron/reply-lifetime.ts 只管计时）。
 *     流式、等待、朗读中都不计时；鼠标悬停、摸头喂食时的淡出（interactionOpacity）不重新计时，也不暂停。
 *     气泡真能被看见时才计时（Codex T-207 2C）：气泡窗口还没载好、她的脸不在屏幕上时先不走，看不见了就停，回来接着走，
 *     所以一旦显示出来，屏幕上总能留满这条回复的寿命，绝不短于可读下限。
 *  2. 桌宠窗口（src/ui/PetUI.ts）不自己定：它把 'complete' 发给主机，主机把这次的毫秒数作为 updatePetReply 的返回值
 *     交回来（PetReplyLingerAnswer），桌宠窗口按它对齐自己的期限；答复到之前按最长的算（perform.ts）。之后每次位置、淡出
 *     更新，主机都答"从现在起还留多久"，桌宠窗口跟着挪期限，不会比主机先收。
 *  3. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.replyLingerWhy：最近几次留了多久、为什么（只在开发者模式发出，
 *     只在内存，只有标签和数，不含回复的字）。
 *
 * 假实现在 fake.ts，守约测试在 tests/reply-linger.test.ts：换一种实现，先过那组测试。
 */
import type { MoodLabel, MoodTendency } from '../../mood';
import type { PetReplyPieces } from '../../contracts';

/** 回复窗口交出来的：它此刻显示的那段字，和它怎么分泡（R27 的分句 / 分段，或主动发言的空行分段）。 */
export interface ReplyLingerBubble {
  readonly text: string;
  readonly pieces: PetReplyPieces | null;
  readonly segmented: boolean;
}

/** 最后一句在等你回话：在问你（"？""吗"结尾），或把话递给你（"你呢""跟我说说"……）。 */
export type ReplyLingerWaiting = 'question' | 'handover';

/** 她此刻的心情和角色卡（MoodHost 给；没有角色时为 null）。只有标签和数。 */
export interface ReplyLingerMood {
  readonly mood: MoodLabel;
  /** 她这会儿最强的情绪倾向（心情快照的 companion）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  /** 有点困、困了。 */
  readonly drowsy: boolean;
}

/** "此刻"：定留多久时只看这些。字只留数，回复的原文不进来。 */
export interface ReplyLingerNow {
  /** 最后一个气泡里读的字数（汉字、假名、表情各 1，几个字母算 1，标点和空格不算）。 */
  readonly chars: number;
  readonly waiting: ReplyLingerWaiting | null;
  readonly mood: ReplyLingerMood | null;
}

/** 一次的结果。 */
export interface ReplyLingerChoice {
  readonly ms: number;
  /** 读得完要多久（可读下限）。 */
  readonly readMs: number;
  /** 读完以后再留的（已乘心情、性格、等你回话）。 */
  readonly afterMs: number;
  /** 从此刻来的真实理由。 */
  readonly why: readonly string[];
}

/** 开发者面板的一行。 */
export interface ReplyLingerWhy {
  readonly at: number;
  readonly ms: number;
  readonly why: readonly string[];
}

/** 主机这一侧（真实现：choose.ts ReplyLingerDirector；假实现：fake.ts FakeReplyLingerHost）。 */
export interface ReplyLingerHost {
  /** 这条回复显示完了：留多少毫秒（总在旋钮 range 里）。每次调用记一行"为什么"（characterId 为空时不记）。 */
  decide(characterId: string, bubble: ReplyLingerBubble, mood: ReplyLingerMood | null): number;
  /** 这个角色最近几次，最新的在前。 */
  recent(characterId: string): readonly ReplyLingerWhy[];
}

/** updatePetReply 对一次 'complete' 的答复：主机定下的这条回复的寿命；对之后的位置、淡出更新：从现在起还留多久（T-207 2C）。 */
export interface PetReplyLingerAnswer {
  readonly lingerMs: number;
}
