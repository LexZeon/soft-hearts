/**
 * 功能：脸红：红成什么样、多久才会再红、害羞的更容易红（写死规则清单 #26）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 什么时候会红还是心情模型定（shared/mood.ts 的 maybeBlush，没改）：你说了暖心的话、亲近涨了 1 点以上（并且亲近涨 2 或舒适涨 1），
 *    或者被摸头、亲近在 10 秒里一下子涨够卡上的 fastThreshold（默认 6）。冷却期内、正在红的时候不会再红。
 *  - 每次要红的那一刻，她挑这一次红成什么样：一下子红透了 / 红一下 / 微微一红。base、mood、now、personality、moments 和 #11、#8
 *    一样是倍数（personality 的倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3）；triggers 是"被摸头"和"你说了暖心的话"各 × 多少。
 *  - 挑中以后在它的范围里各抽一个数，都乘在角色卡的脸红参数上（卡上的值是中心）：depth 深浅（intensity）、rise 红起来多快、
 *    hold 停多久、fade 退多慢。
 *  - cooldown：红过以后，下一次至少隔多久 = 卡上的冷却 × 这个范围里的一个数 × 性格倍数，再保证不小于卡上的（永远不比原来更频繁）。
 *  - ease：被摸头时，亲近要涨够多少才红 = 卡上的 fastThreshold × 性格倍数（夹在 range 里）。谨慎（容易害羞）的卡更小，更容易红。
 *    只在摸头、捏脸的那一下用；"说了暖心的话"那一条是心情模型里的固定门槛，这里不动。
 * 很多模型（包括没有脸红 morph 的）用的是程序红晕，找不到脸颊时舞台会跳过：这里只定"红成什么样"，看不看得见由舞台和模型定。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';

export const BLUSH_LOOK_IDS = ['deep', 'usual', 'faint'] as const;
export type BlushLookId = typeof BLUSH_LOOK_IDS[number];
/** 什么让她红的：被摸头（或捏脸），你说了暖心的话。 */
export const BLUSH_TRIGGERS = ['touch', 'words'] as const;
export type BlushTrigger = typeof BLUSH_TRIGGERS[number];
/** 此刻发生的事：sleepy = 困了（明显困倦、快睡着、睡着）。 */
export const BLUSH_MOMENTS = ['sleepy'] as const;
export type BlushMoment = typeof BLUSH_MOMENTS[number];

type Range = readonly [number, number];
export interface BlushLookKnob {
  readonly label: string;
  readonly base: number;
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly now?: Partial<Record<MoodTendency | 'wistful', number>>;
  readonly personality?: Partial<Record<MoodTendency, number>>;
  readonly triggers?: Partial<Record<BlushTrigger, number>>;
  readonly moments?: Partial<Record<BlushMoment, number>>;
  readonly depth: Range;
  readonly rise: Range;
  readonly hold: Range;
  readonly fade: Range;
}

export interface BlushKnobs {
  readonly recent: readonly number[];
  readonly looks: Readonly<Record<BlushLookId, BlushLookKnob>>;
  readonly cooldown: { readonly range: Range; readonly personality: Partial<Record<MoodTendency, number>> };
  readonly ease: { readonly range: Range; readonly personality: Partial<Record<MoodTendency, number>> };
  readonly moments: Readonly<Record<BlushMoment, { readonly label: string }>>;
  readonly procedural: { readonly boost: number };
}

export const BLUSH_KNOBS: BlushKnobs = Object.freeze<BlushKnobs>({
  // 用户可能怎么说：她每次脸红都一个样／她脸红的样子变来变去太没准了
  // 怎么调：上一次、上上次红成的那种样子，这次分量 × 这几个数；越小越不重复，1 = 不管重复
  recent: [0.35, 0.7],

  looks: {
    // 用户可能怎么说：她脸红得太厉害了／她害羞的时候脸红得不够明显
    // 怎么调：太常 → base 调小或 mood、personality 里的倍数调小；太深太久 → depth、hold 的上限调小
    deep: {
      label: '一下子红透了', base: 0.8, depth: [1, 1.15], rise: [1, 1.4], hold: [1.3, 1.9], fade: [1.1, 1.5],
      mood: { close: 1.5, happy: 1.3, relieved: 1.3, longing: 1.3, excited: 1.2, content: 1.1,
        upset: 0.4, disappointed: 0.5, concerned: 0.7, 'tense-expectation': 0.8 },
      now: { close: 1.3, cautious: 1.3 }, personality: { cautious: 0.5, close: 0.25 }, triggers: { words: 1.3 }, moments: { sleepy: 0.6 },
    },
    // 用户可能怎么说：脸红平时太明显了／太淡了（不是某几次，是一直都这样）
    // 怎么调：一直都明显/淡 → 先改角色卡的脸红强度（中心值，控制窗口里也能按模型校准）；只是"红一下"这一档 → 改这里的范围
    usual: {
      label: '红一下', base: 1.5, depth: [0.9, 1.05], rise: [0.85, 1.15], hold: [0.8, 1.2], fade: [0.9, 1.15],
      mood: { calm: 1.2, content: 1.1 },
    },
    // 用户可能怎么说：她脸红一闪就没了，看不清／她生气的时候还脸红很奇怪
    // 怎么调：太常 → base 调小或 mood、personality 里的倍数调小；看不清 → depth、hold 的下限调大
    faint: {
      label: '微微一红', base: 0.8, depth: [0.7, 0.85], rise: [0.8, 1.1], hold: [0.4, 0.8], fade: [0.7, 1],
      mood: { upset: 1.8, disappointed: 1.6, concerned: 1.3, 'tense-expectation': 1.2 },
      now: { playful: 1.2 }, personality: { cautious: -0.5 }, moments: { sleepy: 1.5 },
    },
  },

  // 用户可能怎么说：她脸红太频繁了／她好久才脸红一次
  // 怎么调：红过以后至少隔"卡上的冷却 × range 里的一个数 × 性格倍数"，永远不小于卡上的；太频繁 → range 调大或先改卡上的冷却；太少 → range 的上限调小（下限是 1，不能更小）
  cooldown: { range: [1, 1.4], personality: { cautious: -0.3 } },

  // 用户可能怎么说：她那么害羞，摸头却不怎么脸红／她摸一下头就脸红
  // 怎么调：被摸头时亲近要涨够"卡上的 fastThreshold × 性格倍数"才红；cautious 的数越负，谨慎（容易害羞）的卡越容易红、大胆的越难红；range 是最容易和最难
  ease: { range: [0.7, 1.3], personality: { cautious: -0.25 } },

  moments: {
    sleepy: { label: '困了' },
  },

  // 用户可能怎么说：Gene（没有自带脸红表情、靠程序在两颊画红晕的模型）红了也看不出来／程序画的红晕太浓了
  // 怎么调：程序红晕的深浅 = 1 −（1 − 原来的深浅）^ boost；1 = 原样，2 = 淡的明显加深（0.35 → 0.58）、深的几乎不变。只管程序红晕，模型自带的脸红表情不受影响（2026-11-07：Gene 红了看不出来）
  procedural: { boost: 2 },
});
