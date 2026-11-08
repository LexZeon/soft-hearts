/**
 * #26 "脸红"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 原来：shared/mood.ts 的 DEFAULT_MOOD_PARAMETERS.blush（或角色卡上的那一组）：每次脸红都是同一个形状，强度 35、
 * 红起来 450 毫秒、停 1.2 秒、退 1.8 秒，红过以后 1 分钟内不再红；什么时候会红（maybeBlush 的两个门槛）也每张卡一样。
 * 现在：每次要红的那一刻，由这里按心情、性格和此刻挑这一次红成什么样，深浅和三段时长在卡上的值附近浮动；红过以后隔多久
 * 才会再红也浮动，但永远不比卡上的短；谨慎（容易害羞）的卡被摸头时更容易红。心情模型（shared/mood.ts，没改）照旧决定红不红、
 * 照旧按交给它的参数算形状：主机只是换了交给它的 parameters.blush（和摸头那一下的 fastThreshold）。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/mood.ts 的 MoodHost）是唯一的调用方（BlushHost，真实现 choose.ts 的 BlushDirector）：
 *     - 每次把参数交给心情模型（advanceMood、getMoodSnapshot……）之前，用 profile() 拿 parameters.blush：正在红的那一次
 *       用它自己的形状（快照里的 blush.profile 和红多久对得上，舞台照着它画），没在红时是卡上的形状加上一次红过以后的冷却；
 *     - 当前角色一个可能让她脸红的事件（摸头、捏脸、带"暖心"语境的聊天和尾注）交给心情模型之前，prepare() 拿这一下的参数
 *       （要是红了就红成这样；摸头时的门槛），交完以后 settle() 告诉它真的红了没有。没红的那次什么都不记。
 *     存档、导出给面板和角色卡的 parameters 永远是卡上的，抽出来的只在内存。
 *  2. 舞台（src/stage/mood-feedback.ts 的 blushResponse、MmdStage 的程序红晕或模型自己的脸红 morph）只读快照里的 blush
 *     （带着这一次的形状）：有脸颊（程序红晕找到了锚点，或者模型有核验过的脸红 morph）就画，没有就跳过。这里不碰舞台。
 *  3. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.blushWhy：最近几次红成什么样、为什么（只在开发者模式发出，只在内存）。
 *  4. #21（shared/behaviors/touch-feed-effect/）：这次摸得淡，亲近涨得慢，就不容易红。两边不互相调用。
 *
 * 假实现在 fake.ts（卡上的值原样用 = 原来的做法），守约测试在 tests/blush.test.ts：换一种实现，先过那组测试。
 */
import type { MoodBlushCue, MoodBlushParameters, MoodLabel, MoodTendency } from '../../mood';
import type { BlushMoment, BlushTrigger } from './knobs';

/** 什么让她红的，具体是哪一种接触（给"为什么"用）。 */
export type BlushContact = 'pat' | 'pinch' | 'words';

/** "此刻"：挑的时候只看这些。都是标签和数，不含任何对话内容。 */
export interface BlushNow {
  readonly mood: MoodLabel;
  /** 她这会儿最强的情绪倾向（心情快照的 companion）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  readonly trigger: BlushTrigger;
  readonly moments: readonly BlushMoment[];
}

/** 一个就要交给心情模型、可能让她脸红的事件。 */
export interface BlushChance {
  readonly contact: BlushContact;
  /** 心情模型此刻的脸红记录（MoodState.blushCue / lastBlushAt）和墙上时间。 */
  readonly cue: MoodBlushCue | null;
  readonly lastBlushAt: number | null;
  readonly at: number;
  /** 卡上的 fastThreshold（摸头那一条门槛的中心）。 */
  readonly threshold: number;
}

/** prepare() 交回来的：这一下交给心情模型的脸红参数和摸头门槛的倍数；`draw` 为 null = 这一下不会红（冷却中、正在红、卡上关了）。 */
export interface BlushPrepared {
  readonly profile: MoodBlushParameters;
  /** 这一下的 fastThreshold = 卡上的 × 这个数（只在摸头、捏脸时不为 1）。 */
  readonly thresholdScale: number;
  readonly draw: number | null;
}

/** settle() 要的：心情模型交完这个事件以后。 */
export interface BlushOutcome {
  /** 这个事件让她红了：心情模型新立的那一次脸红；没红 = null。 */
  readonly cue: MoodBlushCue | null;
  /** 这个事件让亲近涨了多少（心情模型记下的这一次）。 */
  readonly rise: number;
  /** 最近 10 秒（卡上的 fastWindowMs）里亲近一共涨了多少（摸头那一条门槛比的就是它）。 */
  readonly total: number;
}

/** 开发者面板的一行：一次脸红红成什么样、为什么。 */
export interface BlushWhy {
  readonly at: number;
  readonly contact: BlushContact;
  /** 挑中的样子（"一下子红透了"）。 */
  readonly look: string;
  /** 从此刻来的真实理由，第一条是挑中的样子和它的理由。 */
  readonly why: readonly string[];
  /** 附带：这一次的形状，"深浅 ×1.08 · 红起来 0.5 秒 · 停 1.9 秒 · 退 2.3 秒（一共 4.7 秒）"。 */
  readonly shape: string;
  /** 红过以后，下一次至少隔多少毫秒（≥ 卡上的冷却）。 */
  readonly cooldownMs: number;
  /** 附带：挑之前三种样子的分量（出错兜底时为空）。 */
  readonly weights: string;
}

/** 主机这一侧（真实现：choose.ts BlushDirector；假实现：fake.ts FixedBlush）。 */
export interface BlushHost {
  /**
   * 此刻交给心情模型的 parameters.blush：`cue` 是这次脸红时，用它自己的形状；否则卡上的形状加上一次红过以后的冷却。
   * 卡上关了脸红（enabled false 或强度 0）时原样返回卡上的。返回值永远满足 blushProfileSafe(card, 返回值)。
   */
  profile(characterId: string, card: Readonly<MoodBlushParameters>, cue: MoodBlushCue | null): MoodBlushParameters;
  /** 一个可能让她脸红的事件：要是这一下红了，红成什么样（`now` 只在这一下可能红时读）。 */
  prepare(characterId: string, card: Readonly<MoodBlushParameters>, chance: Readonly<BlushChance>, now: () => BlushNow | null): BlushPrepared;
  /** 交完以后：真的红了就记下（这次的形状一直用到它退完，冷却从这里算）；没红就丢掉。 */
  settle(characterId: string, prepared: BlushPrepared, outcome: Readonly<BlushOutcome>): void;
  /** 这个角色最近几次，最新的在前。 */
  recent(characterId: string): readonly BlushWhy[];
}
