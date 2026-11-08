/**
 * #21 "摸头、捏脸、喂点心让她心情好多少，多快会腻"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 原来：shared/mood.ts 的 applyMoodEvent 里写死：摸头每 5 秒算一剂，亲近 +10、舒适 +4；一份点心期待 +12、舒适 +6；
 * 连着来按卡上的 freshness（保留 0.6、最低 0.2）一剂比一剂弱，摸头 5 分钟、点心 30 分钟完全恢复。同样的互动永远同样的效果。
 * 现在：每"一次"互动（一次摸头、一次捏脸、一份点心）开始时，这里按心情、性格和此刻挑她这一次受用不受用，在一个范围里抽
 * 这一次的效果（不超过原来的那么多）；"腻"的快慢按角色卡性格。心情模型（shared/mood.ts，没改）照旧去算，只是这一次的
 * 事件拿到的参数换了两处：
 *   - sensitivity 里这次事件动到的两个通道（摸头：亲近 O、舒适 E；点心：期待 D、舒适 E）× scale；
 *   - freshness.retention、freshness.floor 换成按性格调过的（腻得快慢）。
 * 别的参数、别的事件（聊天、尾注、在场、托举……）一律是卡上的。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/mood.ts 的 MoodHost）是唯一的调用方（TouchFeedEffectHost，真实现 choose.ts 的 TouchFeedEffectDirector）：
 *     当前角色的一个新的摸头、捏脸或点心事件交给心情模型之前，用 effect() 拿这次的效果，用 perform.ts 的
 *     withTouchFeedEffect() 换进这一次的参数。存档、导出给面板和角色卡的 parameters 永远是卡上的，抽出来的只在内存。
 *  2. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.touchFeedWhy：最近几次受用不受用、为什么（只在开发者模式发出，只在内存）。
 *  3. 喂食认图（I-019，shared/feed-recognition.ts 的 feedMoodLift，写死规则 #47）：它按"这一口实际给了多少"再加减（爱吃 +50%、
 *     不爱吃 −50%、不是吃的 −100%），读的是心情模型记下的这一口（MoodHost.lastAcceptedFood），所以自动跟着这次的效果走，
 *     两边不互相调用。叠起来最多 = 这一口 × 1.5 ≤ 原来一口最多的 × 1.5。
 *  4. 脸红（#26，shared/behaviors/blush/）：摸头让亲近涨得够快才会红，这次摸得淡，涨得慢，就不容易红。两边不互相调用。
 *
 * 假实现在 fake.ts（卡上的值原样用 = 原来的做法），守约测试在 tests/touch-feed-effect.test.ts：换一种实现，先过那组测试。
 */
import type { MoodLabel, MoodParameters, MoodTendency } from '../../mood';
import type { TouchFeedKind, TouchFeedLandingId, TouchFeedMoment } from './knobs';

/** 卡上的"腻"：MoodParameters.freshness。 */
export type TouchFeedFreshness = MoodParameters['freshness'];
/** 哪种接触：摸头、捏脸（心情模型里都是摸头那一种事件、同一份新鲜感）、喂点心。 */
export type TouchFeedContact = 'pat' | 'pinch' | 'food';

/** "此刻"：挑的时候只看这些。都是标签和数，不含任何对话内容。 */
export interface TouchFeedNow {
  readonly mood: MoodLabel;
  /** 她这会儿最强的情绪倾向（心情快照的 companion）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  readonly moments: readonly TouchFeedMoment[];
}

/** 一个就要交给心情模型的事件。 */
export interface TouchFeedEvent {
  readonly kind: TouchFeedKind;
  readonly contact: TouchFeedContact;
  /** 这一次互动（MoodHost 的互动会话）：同一次里的事件共用一次挑选。 */
  readonly sessionId: string;
  /** 这个事件算几剂（摸头：有效毫秒 ÷ 卡上的每剂毫秒；点心：1）。 */
  readonly doses: number;
  /** 这之前已经攒下的剂数（心情模型的新鲜感记录，恢复到这一刻）。 */
  readonly taken: number;
  /** 墙上时间。 */
  readonly at: number;
}

/** 这一次交给心情模型的：效果倍数（≤ 1）和按性格调过的"腻"。 */
export interface TouchFeedEffect {
  /** 这次事件动到的两个通道的敏感度 × 这个数（0～1）。 */
  readonly scale: number;
  /** 换进 freshness.retention / freshness.floor。 */
  readonly retention: number;
  readonly floor: number;
}

/** 开发者面板的一行：一次互动受用不受用、为什么。 */
export interface TouchFeedWhy {
  /** 这一次从什么时候开始（墙上时间）。 */
  readonly at: number;
  readonly kind: TouchFeedKind;
  readonly contact: TouchFeedContact;
  /** 挑中的那种（"正好挠到心上"）。 */
  readonly landing: string;
  /** 这一次的效果 = 原来固定的那么多 × 这个数（两位小数）。 */
  readonly scale: number;
  /** 从此刻来的真实理由，第一条是挑中的那种和它的理由。 */
  readonly why: readonly string[];
  /** 新鲜感：这一次第一下和最近一下各还剩原来的百分之多少（腻了就低）。 */
  readonly fresh: { readonly first: number; readonly last: number };
  /** 这一次一共算了几剂（摸头 1 剂 = 卡上的每剂毫秒，默认 5 秒）。 */
  readonly doses: number;
  /** 附带：挑之前三种的分量，"正好挠到心上 1.9 · 照常受用 1.6 · 淡淡的 0.3"（出错兜底时为空）。 */
  readonly weights: string;
}

/** 主机这一侧（真实现：choose.ts TouchFeedEffectDirector；假实现：fake.ts FixedTouchFeedEffect）。 */
export interface TouchFeedEffectHost {
  /**
   * 这个事件这一次的效果。同一次互动（同一个 sessionId）里挑选只做一次、倍数不变；`now` 只在一次互动开始时读。
   * 返回值永远满足 touchFeedEffectSafe(card, 返回值)：效果不比原来大，"腻"在合法范围里。
   */
  effect(characterId: string, event: Readonly<TouchFeedEvent>, card: Readonly<TouchFeedFreshness>, now: () => TouchFeedNow | null): TouchFeedEffect;
  /** 这个角色最近几次，最新的在前。 */
  recent(characterId: string): readonly TouchFeedWhy[];
  /**
   * #32（shared/behaviors/feed-cue/）读的：这个角色这一次（sessionId）这种互动挑中的受用不受用；不是这一次、没挑过就是 null。
   * 可选：没有它的实现（假实现）等于"不知道"，喂食的声音就不看这一块受不受用。
   */
  landing?(characterId: string, kind: TouchFeedKind, sessionId: string): TouchFeedLandingId | null;
}
