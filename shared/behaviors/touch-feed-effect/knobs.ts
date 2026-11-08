/**
 * 功能：摸头、捏脸、喂点心让她心情好多少，多快会腻（写死规则清单 #21）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 每"一次"互动开始时（一次摸头 = 从按住到松手；一次捏脸；一份点心），她先挑这一次"心里受用不受用"：
 *    摸头是 正好挠到心上 / 照常受用 / 淡淡的，喂点心是 吃得很香 / 照常好吃 / 没什么胃口。
 *    base 是基础分量；mood（此刻心情）、now（她这会儿的情绪倾向）、personality（角色卡性格，weights，1 = 一般）、
 *    moments（此刻发生的事：有点累、困了）和 #11、#8 一样是倍数，personality 的倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3。
 *  - 挑中以后在它的 range 里抽一个数，这一次的效果 = 原来固定的那么多（摸头每 5 秒亲近 +10、舒适 +4；点心期待 +12、舒适 +6）× 这个数。
 *    range 的上限不能超过 1：一次互动最多加多少，和原来一样（安全线，写在 choose.ts 的 touchFeedEffectSafe，不是旋钮）。
 *  - tire："腻"的快慢跟着角色卡性格（摸头看"黏人" weights.close，点心看"随和" weights.comfortable：卡上没有"贪吃"，
 *    用最接近的"随和、会享受"）。腻的程度 = 卡上原来的 ×（1 − strength × 2 ×（性格值 − 1）），夹在 range 里；
 *    1 = 和卡上一样，小于 1 腻得慢，大于 1 腻得快。腻到底最少还有 minFloor（不会一点感觉都没有，也不会腻很久才恢复）。
 *    恢复新鲜要多久照卡上的（摸头 5 分钟、点心 30 分钟）；腻得慢的卡腻得浅，恢复得早一点，腻得快的晚一点。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';

export const TOUCH_FEED_KINDS = ['touch', 'food'] as const;
export type TouchFeedKind = typeof TOUCH_FEED_KINDS[number];
export const TOUCH_FEED_LANDING_IDS = ['full', 'usual', 'light'] as const;
export type TouchFeedLandingId = typeof TOUCH_FEED_LANDING_IDS[number];
/** 此刻发生的事：tired = 有点累（轻微困倦），sleepy = 困了（明显困倦、快睡着、睡着）。 */
export const TOUCH_FEED_MOMENTS = ['tired', 'sleepy'] as const;
export type TouchFeedMoment = typeof TOUCH_FEED_MOMENTS[number];

type Range = readonly [number, number];
export interface TouchFeedLandingKnob {
  readonly label: string;
  readonly base: number;
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly now?: Partial<Record<MoodTendency | 'wistful', number>>;
  readonly personality?: Partial<Record<MoodTendency, number>>;
  readonly moments?: Partial<Record<TouchFeedMoment, number>>;
  /** 这一次的效果 × 这个范围里的一个数（上限 ≤ 1）。 */
  readonly range: Range;
}
export interface TouchFeedKindKnobs {
  readonly label: string;
  readonly landings: Readonly<Record<TouchFeedLandingId, TouchFeedLandingKnob>>;
  readonly tire: { readonly trait: MoodTendency; readonly strength: number; readonly range: Range; readonly minFloor: number };
}
export interface TouchFeedEffectKnobs {
  readonly recent: readonly number[];
  readonly touch: TouchFeedKindKnobs;
  readonly food: TouchFeedKindKnobs;
  readonly moments: Readonly<Record<TouchFeedMoment, { readonly label: string }>>;
}

export const TOUCH_FEED_EFFECT_KNOBS: TouchFeedEffectKnobs = Object.freeze<TouchFeedEffectKnobs>({
  // 用户可能怎么说：她每次被摸头、吃点心的反应都差不多／她忽冷忽热太没准了
  // 怎么调：上一次、上上次用过的那种"受用不受用"，这次分量 × 这几个数；越小越不重复，1 = 不管重复。摸头和点心各记各的
  recent: [0.35, 0.7],

  touch: {
    label: '摸头',
    landings: {
      // 用户可能怎么说：她被摸头太容易满足了／她想我的时候摸头也没那么受用
      // 怎么调：太常 → base 调小或 mood、now 里的倍数调小；满足得太多 → range 两个数一起调小（上限不能超过 1）
      full: {
        label: '正好挠到心上', base: 1, range: [0.92, 1],
        mood: { longing: 1.8, sad: 1.6, relieved: 1.4, close: 1.5, concerned: 1.3, content: 1.2, happy: 1.1,
          upset: 0.5, disappointed: 0.6, 'tense-expectation': 0.8 },
        now: { close: 1.4, wistful: 1.4, comfortable: 1.2 }, personality: { close: 0.5 }, moments: { sleepy: 1.2 },
      },
      // 用户可能怎么说：摸头的效果平时太弱了／太强了（不是某几次，是一直都这样）
      // 怎么调：一直都弱/强 → 先改角色卡的"亲近、舒适"敏感度（要你点确认）；只是"照常受用"这一档 → 改这里的 range
      usual: {
        label: '照常受用', base: 1.6, range: [0.82, 0.95],
        mood: { calm: 1.2 },
      },
      // 用户可能怎么说：她生气的时候摸头一下就好了，太好哄了／摸头老是没什么效果
      // 怎么调：太常 → base 调小或 mood、personality 里的倍数调小；太弱 → range 下限调大
      light: {
        label: '淡淡的', base: 0.6, range: [0.6, 0.78],
        mood: { upset: 2, disappointed: 1.8, 'tense-expectation': 1.4, excited: 1.3, longing: 0.5, sad: 0.6 },
        now: { cautious: 1.4, playful: 1.2 }, personality: { close: -0.5 },
      },
    },
    // 用户可能怎么说：摸几下她就腻了／怎么摸都不腻，太像机器了
    // 怎么调：strength 越大，性格越黏人的腻得越慢、越不黏人的腻得越快（0 = 都和卡上一样）；range 是最慢和最快；minFloor 是腻到底还剩多少
    tire: { trait: 'close', strength: 0.3, range: [0.6, 1.4], minFloor: 0.05 },
  },

  food: {
    label: '喂点心',
    landings: {
      // 用户可能怎么说：她吃点心太容易满足了／她开心的时候吃东西也不怎么香
      // 怎么调：太常 → base 调小或 mood、personality 里的倍数调小；满足得太多 → range 两个数一起调小（上限不能超过 1）
      full: {
        label: '吃得很香', base: 1, range: [0.92, 1],
        mood: { happy: 1.4, excited: 1.3, content: 1.3, relieved: 1.3, close: 1.1,
          upset: 0.7, concerned: 0.7, sad: 0.7, 'tense-expectation': 0.7 },
        now: { comfortable: 1.4, playful: 1.2 }, personality: { comfortable: 0.5 }, moments: { tired: 0.8, sleepy: 0.6 },
      },
      // 用户可能怎么说：喂点心的效果平时太弱了／太强了（不是某几次，是一直都这样）
      // 怎么调：一直都弱/强 → 先改角色卡的"期待、舒适"敏感度（要你点确认）；只是"照常好吃"这一档 → 改这里的 range
      usual: {
        label: '照常好吃', base: 1.6, range: [0.82, 0.95],
        mood: { calm: 1.2 },
      },
      // 用户可能怎么说：她老是没胃口／她难过的时候喂点心一下就好了，太好哄了
      // 怎么调：太常 → base 调小或 mood、moments 里的倍数调小；太弱 → range 下限调大
      light: {
        label: '没什么胃口', base: 0.6, range: [0.6, 0.78],
        mood: { concerned: 1.5, upset: 1.5, disappointed: 1.4, sad: 1.4, 'tense-expectation': 1.5, happy: 0.7, excited: 0.7 },
        now: { cautious: 1.3 }, personality: { comfortable: -0.4 }, moments: { tired: 1.3, sleepy: 1.6 },
      },
    },
    // 用户可能怎么说：连着喂几块她就吃腻了／怎么喂都吃不腻
    // 怎么调：strength 越大，性格越随和（会享受）的腻得越慢、越不随和的腻得越快（0 = 都和卡上一样）；range 是最慢和最快；minFloor 是腻到底还剩多少
    tire: { trait: 'comfortable', strength: 0.3, range: [0.6, 1.4], minFloor: 0.05 },
  },

  moments: {
    tired: { label: '有点累' },
    sleepy: { label: '困了' },
  },
});
