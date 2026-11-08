/**
 * 功能：你不理她时，多久看你一眼、动一下、想开口（写死规则清单 #8）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 每一轮"你不理她"开始时（你刚和她互动完、刚打开她、或者换了角色卡），她先挑这一轮的节奏：早一点来找你 / 照常 / 慢一点。
 *    base 是基础分量；mood（此刻心情）、now（她这会儿的情绪倾向）、personality（角色卡性格，weights，1 = 一般）、
 *    moments（此刻发生的事：有点累、困了）和 #11 一样是倍数，personality 的倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3。
 *  - 挑中节奏后，在它的范围里各抽一个数，都是乘在角色卡的值上（卡上的值是中心）：
 *      grace  宽限 × 多少（≥ 1：永远不比卡上短）；
 *      pace   无聊每分钟涨多少 × 多少。超过 1 的部分不让无聊涨得更快（安全线：她的无聊在任何时刻都不比卡上的多，Codex T-207），
 *             只让"看你一眼"的门槛 ÷ 这个数，看你一眼照样早同样的比例；
 *      later  "动一下"和"想开口"一起比卡上原来的时刻晚多少：卡上开口的时刻 × 这个数（≥ 0：永远不比卡上早）。
 *             两个晚同样多，所以动一下到开口之间隔多久照卡上的（内心循环问模型的次数跟着它，见 choose.ts 文件头）。
 *  - look："看你一眼"的门槛 × 多少，每轮在这个范围里抽，和节奏无关（再加上 pace 超过 1 的那轮看你早一点）。
 *  - 两处会互相带一下（"为什么"里会写出来）：涨得慢的那轮，动一下、开口的门槛不低于卡上的，所以会比 later 定的更晚；
 *    开口定得晚的那轮，开口门槛最多 100，所以晚不了那么多。动一下、开口最少也比卡上晚一次提示的时长加一拍（默认 4 秒）。
 * 安全线不是旋钮，写在 choose.ts 的 boredomRulesNoEarlier：动一下、开口永远不早于卡上原来的时刻，宽限不短于卡上的、
 * 涨速不快于卡上的，两个门槛比卡上的高出一次提示的时长；主动开口的冷却、每小时上限、没人回就不再说、深夜和困了安静，
 * 都在别处（frequency、内心循环），这里不碰。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';

export const BOREDOM_TEMPO_IDS = ['eager', 'usual', 'unhurried'] as const;
export type BoredomTempoId = typeof BOREDOM_TEMPO_IDS[number];
/** 此刻发生的事：tired = 有点累（轻微困倦），sleepy = 困了（明显困倦、快睡着、睡着）。 */
export const BOREDOM_MOMENTS = ['tired', 'sleepy'] as const;
export type BoredomMoment = typeof BOREDOM_MOMENTS[number];

type Range = readonly [number, number];
export interface BoredomTempoKnob {
  readonly label: string;
  readonly base: number;
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly now?: Partial<Record<MoodTendency | 'wistful', number>>;
  readonly personality?: Partial<Record<MoodTendency, number>>;
  readonly moments?: Partial<Record<BoredomMoment, number>>;
  readonly grace: Range;
  readonly pace: Range;
  readonly later: Range;
}

export interface BoredomTimingKnobs {
  readonly recent: readonly number[];
  readonly apartMinutes: number;
  readonly look: Range;
  readonly tempos: Readonly<Record<BoredomTempoId, BoredomTempoKnob>>;
  readonly moments: Readonly<Record<BoredomMoment, { readonly label: string }>>;
}

export const BOREDOM_TIMING_KNOBS: BoredomTimingKnobs = Object.freeze<BoredomTimingKnobs>({
  // 用户可能怎么说：她每次来找我的节奏都差不多／她忽早忽晚太没规律了
  // 怎么调：上一轮、上上轮她真的来找你时用的节奏，这次分量 × 这几个数；越小越不重复，1 = 不管重复
  recent: [0.35, 0.7],

  // 用户可能怎么说：她看我、动一下、开口的时间还是能掐表
  // 怎么调：同一种时机和上一次真的发生的那次至少隔几分钟（太近就往后或往前挪开；动一下和开口一起挪，不会早于卡上的时刻）
  apartMinutes: 1.5,

  // 用户可能怎么说：她看我一眼的时间太固定了／她看我一眼忽早忽晚差太多
  // 怎么调："看你一眼"的门槛每轮 × 这个范围里的一个数；范围越宽越不固定。只管看你一眼，不管动一下和开口
  look: [0.85, 1.15],

  tempos: {
    // 用户可能怎么说：她太黏了，老是很早就来找我／她开心的时候也不急着找我
    // 怎么调：太常 → base 调小或 mood 里的倍数调小；"早"得太多 → pace 上限调小（只影响看你一眼）；动一下、开口最早就是卡上的时刻，这一档的 later 只是更贴近它
    eager: {
      label: '早一点来找你', base: 1, grace: [1, 1.1], pace: [1.08, 1.2], later: [0, 0.06],
      mood: { happy: 1.5, excited: 1.5, close: 1.6, longing: 1.8, relieved: 1.3, content: 1.1, 'tense-expectation': 1.2,
        concerned: 0.9, sad: 0.8, disappointed: 0.5, upset: 0.5 },
      now: { close: 1.4, playful: 1.2, wistful: 1.4 }, personality: { close: 0.5, playful: 0.25 }, moments: { tired: 0.6, sleepy: 0.3 },
    },
    // 用户可能怎么说：她平时找我找得太早了／太晚了（不是某几次，是一直都这样）
    // 怎么调：一直都早/晚 → 先改角色卡里的无聊参数（宽限、涨速、三个门槛是中心，要你点确认）；只是"照常"这一档 → 改这里的范围
    usual: {
      label: '照常', base: 1.5, grace: [1, 1.25], pace: [0.92, 1.08], later: [0.02, 0.18],
      mood: { calm: 1.2 },
    },
    // 用户可能怎么说：她找我找得太晚了／她累了、不高兴的时候还是那么早来找我
    // 怎么调：太常 → base 调小或 mood、moments 里的倍数调小；太晚 → later、grace 的上限调小，或 pace 的下限调大（涨得慢时门槛不低于卡上的，会更晚）
    unhurried: {
      label: '慢一点', base: 1, grace: [1.1, 1.4], pace: [0.8, 0.95], later: [0.12, 0.4],
      mood: { upset: 1.6, disappointed: 1.6, sad: 1.2, content: 1.2, calm: 1.05, happy: 0.7, excited: 0.6, close: 0.6, longing: 0.5 },
      now: { comfortable: 1.3, cautious: 1.4 }, personality: { cautious: 0.5, comfortable: 0.25 }, moments: { tired: 1.6, sleepy: 2.2 },
    },
  },

  moments: {
    tired: { label: '有点累' },
    sleepy: { label: '困了' },
  },
});
