/**
 * #32 "喂点心时的语气词和吃法"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 原来：shared/feed-cue.ts 的 FEED_CUE_TEXT 固定两条（"啊～""嗯～"）；src/stage/mood-feedback.ts 的 FEED_OPEN、CHEW_OPEN、
 * CHEW_RATE 固定张多大、嚼多快。零食到嘴边就张嘴、同一声"啊～"，吃到同一声"嗯～"，嚼法一样；第十块和第一块一样。
 * 现在：每一份点心她来挑这两声（各五种声音，或者不出声）和吃法（不腻照旧；吃腻了张嘴、嚼都慢一点，偶尔轻轻摇头）。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/mood.ts 的 MoodHost）是唯一的调用方（FeedCueHost，真实现 choose.ts 的 FeedCueDirector）：
 *     - 一份新点心开始（桌宠报来这一次的 'food-wait'，点心刚拖进来）时 open()：挑张嘴前那一声、张嘴的快慢大小、要不要摇头。
 *     - 这一口咬下去（'food' 事件交给心情模型以后，#21 已经挑了这一块受用不受用）时 bite()：挑吃到后那一声和嚼法。
 *     - 视图里 MoodView.feedCue = view()（只在自动表现开着时有），开发者模式多一行 MoodView.feedCueWhy = recent()。
 *     "此刻"（FeedCueNow）在 open() 时读一次：心情、倾向、角色卡性格、累不累、吃腻了多少（#21 的新鲜感，跟着卡上"腻得快慢"）、
 *     不久前认图认出的口味、这一口之后认图会不会说一句。
 *  2. 舞台（src/stage/mood-feedback.ts，通过 MmdStage 交来的 state.feed）用 perform.ts 的 FeedEatPerformer 照着做：张嘴、嚼、摇头。
 *     没有 feedCue（自动表现关着、旧主机、假实现给的照常）时逐位和原来一样。
 *  3. 桌宠窗口的声音（src/ui/feed-cue-choice.ts 的 ChosenFeedCues，包在 FeedCuePlayer 外面）：到嘴边那一刻放 open.sound，
 *     咬下去那一刻放 eat.sound；还没合成好就先放已缓存的原来那一声，再没有就只演动作，后台合成好了下次用。
 *
 * 和别的功能的关系（都不互相调用）：
 *  - #21（shared/behaviors/touch-feed-effect/）：bite() 收到它这一块挑的受用不受用（TouchFeedEffectHost.landing），
 *    吃腻了多少用它的"腻"的算法和卡上的腻得快慢（choose.ts feedSatiety）。
 *  - 喂食认图（I-019，electron/feed-recognition/）：认图认出口味后给心情的那一下（MoodHost.lift，id 以 feed-taste- 开头）
 *    让主机记下"不久前认出的口味"，影响下一块；认图开着、这一口之后她会说一句时，吃到后那一声只出声、不说话（不抢话）。
 *    认图本身发生在咬下去以后，所以这一块是什么，这两声都不知道。
 *
 * 假实现在 fake.ts（每次都是原来的"啊～""嗯～"、照常的吃法），守约测试在 tests/feed-cue.test.ts：换一种实现，先过那组测试。
 */
import type { MoodLabel, MoodTendency } from '../../mood';
import type { FeedEatSoundId, FeedOpenSoundId } from '../../feed-cue';
import type { TouchFeedLandingId } from '../touch-feed-effect/knobs';
import type { FeedCueMoment, FeedTaste } from './knobs';

/** "此刻"：挑的时候只看这些。都是标签和数，不含任何对话内容、图片或吃的名字。 */
export interface FeedCueNow {
  readonly mood: MoodLabel;
  /** 她这会儿最强的情绪倾向（心情快照的 companion，够强才算）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  readonly moments: readonly FeedCueMoment[];
  /** 吃腻了多少：0 不腻 … 1 腻到底（#21 的新鲜感，按卡上"腻得快慢"）。 */
  readonly satiety: number;
  /** 这一口之前新鲜感还剩多少（0～1，给"为什么"）。 */
  readonly fresh: number;
  /** 不久前认图认出的口味（分钟数在旋钮 tasteMinutes 里），没有就是 null。 */
  readonly taste: FeedTaste | null;
  /** 这一口之后认图会不会说一句（认图开着、Claude 能用）：会的话吃到后那一声只出声、不说话。 */
  readonly lineFollows: boolean;
}

/** 张嘴前（点心到嘴边）那一份的打算。sound null = 不出声。 */
export interface FeedOpenPlan {
  /** 这一份唯一（桌宠用它分清新旧）。 */
  readonly id: string;
  readonly sound: FeedOpenSoundId | null;
  /** 张嘴快慢、张多大（1 = 照旧，只会更小）。 */
  readonly mouth: { readonly rate: number; readonly size: number };
  /** 点心到嘴边时轻轻摇一下头（弧度、毫秒、来回几下），没有就是 null。 */
  readonly shake: { readonly amplitude: number; readonly ms: number; readonly swings: number } | null;
}
/** 吃到后（咬下去）那一份的打算。 */
export interface FeedEatPlan {
  readonly id: string;
  readonly sound: FeedEatSoundId | null;
  /** 嚼的快慢、幅度（1 = 照旧，只会更小）。 */
  readonly chew: { readonly rate: number; readonly size: number };
}
/** MoodView.feedCue：这一份点心（主机的喂食互动会话）她怎么出声、怎么吃。 */
export interface FeedCueView {
  readonly sessionId: string;
  readonly open: FeedOpenPlan;
  /** 咬下去以后才有。 */
  readonly eat?: FeedEatPlan;
}

/** 开发者面板的一行：一份点心两声挑了什么、为什么，吃法和为什么。 */
export interface FeedCueWhy {
  /** 这一份点心从什么时候开始（墙上时间）。 */
  readonly at: number;
  /** 张嘴前那一声（"哇～"或"不出声"）和为什么。 */
  readonly open: { readonly sound: string; readonly why: readonly string[]; readonly weights: string };
  /** 吃到后那一声，咬下去以后才有。 */
  readonly eat?: { readonly sound: string; readonly why: readonly string[]; readonly weights: string };
  /** 吃法："照常" / "慢慢吃" / "小心地"，为什么，和这次的数（"张嘴 ×0.58 · 张开 ×0.86 · 嚼 ×0.70 · 轻轻摇了下头"）。 */
  readonly manner: { readonly label: string; readonly why: readonly string[]; readonly numbers: string };
}

/** 主机这一侧（真实现：choose.ts FeedCueDirector；假实现：fake.ts FixedFeedCue）。 */
export interface FeedCueHost {
  /** 一份新点心开始：挑张嘴前那一声和吃法。同一份（sessionId）只挑一次，`now` 最多读一次。 */
  open(characterId: string, sessionId: string, at: number, now: () => FeedCueNow | null): void;
  /**
   * 这一口咬下去：按 #21 这一块挑的受用不受用，挑吃到后那一声和嚼法。同一份只挑一次；没有 open() 过的这一份先补一次 open()。
   * `now` 只在补 open() 时读（"此刻"跟着这一份点心开始的那一刻）。
   */
  bite(characterId: string, sessionId: string, at: number, landing: TouchFeedLandingId | null, now: () => FeedCueNow | null): void;
  /** 这个角色眼下这一份点心的打算（MoodView.feedCue）；太久以前的（咬下去以后一分钟、或开始以后两分钟还没咬）不再给。 */
  view(characterId: string, at: number): FeedCueView | null;
  /** 这个角色最近几份，最新的在前（开发者面板）。 */
  recent(characterId: string): readonly FeedCueWhy[];
}

/** 舞台这一侧这一帧要用的（perform.ts FeedEatPerformer）：全是 1 / 0 时和原来逐位一样。 */
export interface FeedEatFrame {
  readonly openRate: number;
  readonly openSize: number;
  readonly chewRate: number;
  readonly chewSize: number;
  /** 加到头的左右转动目标上（弧度），不摇时正好是 0。 */
  readonly yaw: number;
}
/** 这一帧喂食到哪一步（src/stage/mood-feedback.ts 算好的）。 */
export interface FeedEatMoment {
  /** 正在喂（点心在窗口里）。 */
  readonly feeding: boolean;
  /** 点心在嘴边（到了嘴边、或准备好了），还没咬。 */
  readonly holding: boolean;
  /** 咬下去了、在嚼。 */
  readonly eating: boolean;
}
export interface FeedEatStage {
  reset(): void;
  frame(dt: number, moment: FeedEatMoment, plan: FeedCueView | null | undefined, headAllowed: boolean): FeedEatFrame;
}
