/**
 * #8 "你不理她：多久看你一眼、动一下、想开口"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 原来：shared/mood.ts 的 DEFAULT_MOOD_PARAMETERS.boredom（或角色卡上的那一组）是固定的五个数，你不理她 5 分钟后无聊按
 * 每分钟 +2 直线涨，第 20 分钟看你、第 32.5 分钟动一下、第 42.5 分钟想开口，每轮都在同一刻。
 * 现在：每一轮"你不理她"开始时，由这里按角色卡倾向和此刻心情在一个范围里抽这一轮的宽限、涨速和三个门槛（卡上的值是中心），
 * 心情模型（shared/mood.ts，没改）照旧拿这五个数去涨、去比门槛。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/mood.ts 的 MoodHost）是唯一的调用方（BoredomTimingHost，真实现 choose.ts 的 BoredomTimingDirector）：
 *     - 每次要把参数交给心情模型（advanceMood、applyMoodEvent、getMoodAttentionCandidate、getMoodSnapshot……）之前，
 *       用 rules() 拿这一轮的五个数，只替换 parameters.boredom，别的参数（frequency 冷却和上限、longing……）一律是卡上的；
 *     - 一秒一次的规则时机真的发出了 look / motion / speech（不是测试命令、不是陪听点评、不是内心循环认领后改的）→ happened()；
 *     - 你回到电脑前、她没那么无聊了（在场，shared/mood-presence.ts，只在摄像头感知开着时）→ relieved()。
 *     存档、导出给面板和角色卡的 parameters 永远是卡上的值，抽出来的只在内存。
 *  2. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.boredomTimingWhy：这一轮和前几轮的节奏、时刻、为什么（只在开发者模式发出，只在内存）。
 *  3. #11（shared/behaviors/idle-gesture/）：什么时候"动一动""看你一眼"来自这里，样子和表情来自 idle-gesture。两边不互相调用。
 *
 * 假实现在 fake.ts（卡上的值原样用 = 原来的做法），守约测试在 tests/boredom-timing.test.ts：换一种实现，先过那组测试。
 */
import type { MoodLabel, MoodParameters, MoodTendency } from '../../mood';
import type { BoredomMoment } from './knobs';

/** 一轮的宽限、涨速和三个门槛：和 MoodParameters.boredom 一模一样的形状。 */
export type BoredomRules = MoodParameters['boredom'];
export type BoredomKind = 'look' | 'motion' | 'speech';

/** "此刻"：挑节奏时只看这些。都是标签和数，不含任何对话内容。 */
export interface BoredomTimingNow {
  readonly mood: MoodLabel;
  /** 她这会儿最强的情绪倾向（心情快照的 companion）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  readonly moments: readonly BoredomMoment[];
}

/** 心情模型此刻的无聊和"你不理她"的时长（MoodState.boredom / onlineIdleMs / updatedAt）。 */
export interface BoredomIdle {
  readonly idleMs: number;
  readonly boredom: number;
  readonly at: number;
  /**
   * 卡上一次看你 / 动一下 / 开口的提示占多久（MoodParameters.interaction.attentionMs）：提示还在时下一个时机等着，
   * 所以卡上自己的提示会把卡上的动一下、开口压后这么久（安全线第 2 条，choose.ts 文件头）。没给 = 0（只留一拍）。
   */
  readonly holdMs?: number;
}

/** 开发者面板的一行：一轮的节奏、时刻和为什么。分钟都从这一轮开始（你最后一次互动）算起。 */
export interface BoredomTimingWhy {
  /** 这一轮从什么时候开始（墙上时间）。 */
  readonly startedAt: number;
  /** 是不是正在进行的这一轮。 */
  readonly current: boolean;
  readonly tempo: string;
  /** 打算第几分钟看你、动一下、想开口（一位小数）；null = 这一轮不会（卡上无聊不涨）。 */
  readonly plan: Readonly<Record<BoredomKind, number | null>>;
  /** 真的发生在第几分钟（只记这一轮每种的第一次）。 */
  readonly happened: Readonly<Partial<Record<BoredomKind, number>>>;
  /** 从此刻来的真实理由，第一条是节奏和它的理由。 */
  readonly why: readonly string[];
  /** 附带：这一轮的五个数，"宽限 5.3 分 · 每分钟 +2.3 · 门槛 看你 28 / 动一下 58 / 开口 92"。 */
  readonly rules: string;
  /** 附带：挑节奏之前三种节奏的分量，"早一点来找你 1.6 · 照常 1.8 · 慢一点 0.6"（卡上无聊不涨时也照样有；出错兜底时为空）。 */
  readonly weights: string;
}

/** 主机这一侧（真实现：choose.ts BoredomTimingDirector；假实现：fake.ts FixedBoredomTiming）。 */
export interface BoredomTimingHost {
  /**
   * 这个角色这一轮的五个数。同一轮每次返回同一组；新的一轮在这些时候开始：第一次见到这个角色、`idle.idleMs` 比上次小
   * （互动过、重新打开、休眠醒来）、卡上的五个数或 `idle.holdMs` 变了。`now` 只在新的一轮开始时读。
   * 返回值永远满足 boredomRulesNoEarlier(card, 返回值, boredomHoldMinutes(idle.holdMs))：涨速不快于卡上的，所以她的无聊
   * 在任何时刻都不比卡上的多。
   */
  rules(characterId: string, card: Readonly<BoredomRules>, idle: Readonly<BoredomIdle>, now: () => BoredomTimingNow | null): Readonly<BoredomRules>;
  /** 规则时机真的发出了：这一轮每种只记第一次（`at` 墙上时间）。 */
  happened(characterId: string, kind: BoredomKind, at: number): void;
  /** 无聊没重新开始就被减掉了（在场）：五个数不变（涨速本来就不快于卡上的），只把面板上的打算重算一次、"为什么"里记一句。 */
  relieved(characterId: string): void;
  /** 这个角色这一轮和前几轮，正在进行的在前。 */
  recent(characterId: string): readonly BoredomTimingWhy[];
}
