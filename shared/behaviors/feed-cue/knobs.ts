/**
 * 功能：喂点心时的语气词和吃法（写死规则清单 #32）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 一份点心有两声：点心到嘴边、她张嘴的那一声（open），和咬下去以后嚼着的那一声（eat）。每一声都由她从这一组里挑，
 *    "不出声"也是一种（quiet）。text 是她说的字（固定的，不让模型写；百炼每种声音合成一次就缓存），tone 是给百炼的语气说明。
 *  - 分量 = base × 各条此刻的理由的倍数：mood（此刻心情）、now（她这会儿的情绪倾向）、personality（角色卡性格 weights，
 *    倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3）、moments（有点累、困了）、full（吃腻了：不腻时 × 1，腻到底时 × 这个数，
 *    中间按腻的程度线性变）、taste（不久前认图认出她爱吃 / 不合口味 / 不是吃的）、landing（只有 eat：这一块 #21 挑的
 *    吃得很香 / 照常好吃 / 没什么胃口）。
 *  - word: true 的是一句话（"好吃～"），不只是一个声音：认图（I-019）开着、这一口之后她会自己说一句时，这一声不出现，不和她抢话。
 *  - 上一次刚出过的那一声，这一次不会再出（写死在 choose.ts，不是旋钮）；上上次的分量 × recentBefore。
 *  - 吃法（manner）：不腻的时候和原来一模一样（张嘴、嚼、头都不变）。吃腻了（#21 的新鲜感，跟着角色卡"腻得快慢"）才慢下来：
 *    腻的程度 s（0 不腻 … 1 腻到底）超过 start 以后，k =（s − start）÷（1 − start），张嘴的快慢 × (1 − k ×（1 − 抽到的数）)，
 *    抽到的数在 open.rate 里；张开多大、嚼的快慢和幅度同理；还有 shake.chance × k 的机会在点心到嘴边时轻轻摇一下头。
 *  - 不久前喂过不是吃的（wary），这一次她张嘴小心：张得小、张得慢（不管腻不腻）。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';
import type { FeedEatSoundId, FeedOpenSoundId } from '../../feed-cue';
import type { TouchFeedLandingId } from '../touch-feed-effect/knobs';

/** 此刻发生的事：tired = 有点累（轻微困倦），sleepy = 困了（明显困倦、快睡着、睡着）。 */
export const FEED_CUE_MOMENTS = ['tired', 'sleepy'] as const;
export type FeedCueMoment = typeof FEED_CUE_MOMENTS[number];
/** 不久前认图（I-019）认出的：爱吃、不太合口味、不是吃的（"一般"和"看不清"不算）。 */
export const FEED_TASTES = ['loved', 'disliked', 'notFood'] as const;
export type FeedTaste = typeof FEED_TASTES[number];

type Range = readonly [number, number];
interface FeedChoiceLean {
  readonly base: number;
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly now?: Partial<Record<MoodTendency | 'wistful', number>>;
  readonly personality?: Partial<Record<MoodTendency, number>>;
  readonly moments?: Partial<Record<FeedCueMoment, number>>;
  /** 腻到底时的倍数（不腻时 1，中间线性）。 */
  readonly full?: number;
  readonly taste?: Partial<Record<FeedTaste, number>>;
  /** 只有 eat：这一块 #21 挑的受用不受用。 */
  readonly landing?: Partial<Record<TouchFeedLandingId, number>>;
}
export interface FeedSoundKnob extends FeedChoiceLean {
  /** 她说的字（固定）。 */
  readonly text: string;
  /** 百炼的语气说明（只给能按说明说话的模型）。 */
  readonly tone: string;
  /** 一句话而不只是一个声音：认图会说一句时不出现。 */
  readonly word?: boolean;
}
export interface FeedQuietKnob extends FeedChoiceLean { readonly label: string }

export interface FeedCueKnobs {
  readonly recentBefore: number;
  readonly open: Readonly<Record<FeedOpenSoundId, FeedSoundKnob>> & { readonly quiet: FeedQuietKnob };
  readonly eat: Readonly<Record<FeedEatSoundId, FeedSoundKnob>> & { readonly quiet: FeedQuietKnob };
  readonly manner: {
    readonly start: number;
    readonly open: { readonly rate: Range; readonly size: Range };
    readonly chew: { readonly rate: Range; readonly size: Range };
    readonly shake: { readonly chance: number; readonly mood: Partial<Record<MoodLabel, number>>; readonly amplitude: Range; readonly ms: Range; readonly swings: number };
    readonly wary: { readonly rate: number; readonly size: number };
  };
  readonly tasteMinutes: number;
  readonly moments: Readonly<Record<FeedCueMoment, { readonly label: string }>>;
}

const ONE_WORD = '只读给你的这几个字，不要加别的。';

export const FEED_CUE_KNOBS: FeedCueKnobs = Object.freeze<FeedCueKnobs>({
  // 用户可能怎么说：她吃东西的声音太单调了／她老是两种声音换着来
  // 怎么调：上上次出过的那一声，这次分量 × 这个数（上一次的那一声这次一定不出，写死）；越小越不重复，1 = 不管上上次
  recentBefore: 0.5,

  open: {
    // 用户可能怎么说：她张嘴老是"啊～"／"啊～"太少了
    // 怎么调：太常 → base 调小或 mood 里的倍数调小；这是原来那一声，平静的时候最常见
    ah: { text: '啊～', tone: '可爱、轻柔、短促的语气词，像小口吃东西时自然发出的声音；只读这一个字，不要加别的。', base: 1.6,
      mood: { calm: 1.2, close: 1.2, longing: 1.1 }, now: { close: 1.2 }, personality: { close: 0.3 }, full: 0.8 },
    // 用户可能怎么说：她看到吃的不够惊喜／她老是"哇"太夸张了
    // 怎么调：太常 → base 调小或 mood、taste 里的倍数调小；太少 → 反过来
    wa: { text: '哇～', tone: `开心、惊喜的短促语气词，像看到好吃的眼睛一亮时自然发出的声音；${ONE_WORD}`, base: 0.8,
      mood: { happy: 1.8, excited: 2, content: 1.3, relieved: 1.3, sad: 0.4, upset: 0.4, concerned: 0.5, disappointed: 0.4, 'tense-expectation': 0.7 },
      now: { playful: 1.3 }, taste: { loved: 2.2, disliked: 0.4, notFood: 0.2 }, full: 0.3, moments: { tired: 0.7, sleepy: 0.4 } },
    // 用户可能怎么说：她吃东西太斯文了，不够调皮／"嗷呜"不像她
    // 怎么调：personality.playful 是"爱玩的卡更常这样"；不像她 → base 调小（或改 text）
    aowu: { text: '嗷呜～', tone: `调皮、可爱的一声，像张大嘴假装一口咬下去；${ONE_WORD}`, base: 0.5,
      mood: { excited: 1.8, happy: 1.4, sad: 0.3, upset: 0.4, concerned: 0.4, disappointed: 0.3, longing: 0.6 },
      now: { playful: 2, cautious: 0.5 }, personality: { playful: 0.6, cautious: -0.3 }, taste: { loved: 1.5, notFood: 0.2 }, full: 0.2,
      moments: { tired: 0.6, sleepy: 0.3 } },
    // 用户可能怎么说：她吃东西太大声了／她害羞的时候也太放得开了
    // 怎么调：personality.cautious 是"谨慎（容易害羞）的卡更常小声"；太常 → base 调小
    soft: { text: '啊…', tone: `很轻、有点害羞的小声，像小口张嘴；${ONE_WORD}`, base: 0.7,
      mood: { sad: 1.6, concerned: 1.3, longing: 1.4, disappointed: 1.3, excited: 0.5 }, now: { cautious: 1.6, close: 1.2 },
      personality: { cautious: 0.5 }, moments: { tired: 1.4, sleepy: 1.8 }, full: 1.4 },
    // 用户可能怎么说：上次喂了不是吃的，她这次一点都不怀疑／她老是"嗯？"像不信任我
    // 怎么调：taste.notFood 是"不久前喂过不是吃的"时的倍数；full 是吃腻了时的倍数；太常 → base 调小
    huh: { text: '嗯？', tone: `有点疑惑、迟疑的短促语气词，像在问"这个？"；${ONE_WORD}`, base: 0.25,
      mood: { upset: 1.6, 'tense-expectation': 1.4, disappointed: 1.2, happy: 0.6, excited: 0.5 }, now: { cautious: 1.3 },
      taste: { notFood: 6, disliked: 2.5, loved: 0.3 }, full: 3 },
    // 用户可能怎么说：她每次都要出声，太吵了／她张嘴老是不出声
    // 怎么调：太常 → base 调小或 moments、full 里的倍数调小；想更安静 → 调大
    quiet: { label: '不出声', base: 0.45,
      mood: { upset: 1.8, sad: 1.4, disappointed: 1.5, concerned: 1.2, excited: 0.5 }, now: { cautious: 1.3 }, personality: { cautious: 0.4 },
      moments: { sleepy: 2 }, full: 1.6 },
  },

  eat: {
    // 用户可能怎么说：她吃到老是"嗯～"／"嗯～"太少了
    // 怎么调：这是原来那一声；太常 → base 调小
    mm: { text: '嗯～', tone: '可爱、轻柔、短促的语气词，像小口吃东西时自然发出的声音；只读这一个字，不要加别的。', base: 1.6,
      mood: { calm: 1.2 }, landing: { usual: 1.3 } },
    // 用户可能怎么说：她吃到好吃的不够开心／她吃什么都"嗯嗯！"太夸张了
    // 怎么调：landing.full 是"这一块吃得很香"时的倍数；太常 → base 调小
    yum: { text: '嗯嗯！', tone: `满足、轻快的两声"嗯嗯"，像吃到好吃的连连点头；${ONE_WORD}`, base: 0.7,
      mood: { happy: 1.6, excited: 1.7, content: 1.3, sad: 0.5, upset: 0.4, disappointed: 0.5 }, now: { playful: 1.4 },
      personality: { playful: 0.5 }, landing: { full: 2, light: 0.3 }, taste: { loved: 1.6, disliked: 0.5 }, full: 0.4, moments: { sleepy: 0.4 } },
    // 用户可能怎么说：她从来不说好吃／她老是说好吃，敷衍
    // 怎么调：word 表示认图会说一句时不出现（不抢话）；太常 → base 调小或 landing.full 调小
    haochi: { text: '好吃～', tone: `开心、满足、带着笑意的小声，像嘴里还有东西时说"好吃"；${ONE_WORD}`, base: 0.6, word: true,
      mood: { happy: 1.6, content: 1.5, relieved: 1.3, excited: 1.4, upset: 0.4, sad: 0.6, disappointed: 0.5 }, now: { comfortable: 1.4 },
      personality: { comfortable: 0.5 }, landing: { full: 2.2, usual: 0.9, light: 0.15 }, taste: { loved: 2, disliked: 0.2, notFood: 0.05 }, full: 0.5 },
    // 用户可能怎么说：她嚼东西的声音不够满足／"唔嗯"太闷了
    // 怎么调：personality.comfortable 是"随和（会享受）的卡更常这样"；太常 → base 调小
    wuen: { text: '唔嗯…', tone: `含着东西、满足的闷闷一声，像嘴里塞着点心在嚼；${ONE_WORD}`, base: 0.9,
      mood: { content: 1.4, close: 1.3, calm: 1.1, excited: 0.6 }, now: { comfortable: 1.4, close: 1.2 }, personality: { comfortable: 0.4 },
      moments: { tired: 1.3, sleepy: 1.4 }, full: 1.3 },
    // 用户可能怎么说：她吃腻了也不表现出来／她老是勉强的样子
    // 怎么调：landing.light 是"这一块没什么胃口"时的倍数，full 是吃腻了时的倍数；太常 → base 调小
    wu: { text: '唔…', tone: `有点勉强、没什么兴致的短短一声，像吃饱了还在嚼；${ONE_WORD}`, base: 0.3,
      mood: { upset: 1.8, disappointed: 1.6, concerned: 1.4, sad: 1.3, happy: 0.5, excited: 0.4 }, landing: { light: 3, full: 0.3 },
      taste: { disliked: 2.5, notFood: 2, loved: 0.3 }, full: 3, moments: { sleepy: 1.3 } },
    // 用户可能怎么说：她吃东西每次都出声，太吵了／她嚼着嚼着不出声了
    // 怎么调：太常 → base 调小或 landing、moments 里的倍数调小
    quiet: { label: '不出声', base: 0.4,
      mood: { upset: 1.5, sad: 1.4, excited: 0.6 }, now: { cautious: 1.4 }, personality: { cautious: 0.4 }, landing: { light: 1.8 },
      moments: { sleepy: 1.8 }, full: 1.6 },
  },

  manner: {
    // 用户可能怎么说：她吃多了还那么积极／她第三块就慢吞吞的
    // 怎么调：腻到这个程度（0～1，#21 的新鲜感算出来的）才开始慢下来；越大越晚，1 = 永远照旧
    start: 0.35,
    // 用户可能怎么说：她吃饱了张嘴还是那么快／她张嘴慢得像卡住了
    // 怎么调：腻到底时张嘴快慢 × rate 里抽的数、张多大 × size 里抽的数（1 = 照旧）；只会更慢、更小，不会比原来快
    open: { rate: [0.45, 0.65], size: [0.8, 0.92] },
    // 用户可能怎么说：她吃饱了嚼得还是那么快
    // 怎么调：腻到底时嚼的快慢 × rate 里抽的数、嚼的幅度 × size 里抽的数（1 = 照旧）
    chew: { rate: [0.6, 0.78], size: [0.75, 0.95] },
    // 用户可能怎么说：她吃撑了也不摇头／她老是摇头，像不想吃
    // 怎么调：chance × 腻的程度 = 这次摇头的机会（再乘 mood 里的倍数）；amplitude 是摇多大（弧度，0.03 ≈ 1.7 度），ms 是摇多久
    shake: { chance: 0.45, mood: { upset: 1.4, disappointed: 1.3, sad: 1.2, happy: 0.7, excited: 0.6 }, amplitude: [0.022, 0.035], ms: [750, 1000], swings: 2 },
    // 用户可能怎么说：上次喂了不是吃的，她这次还是张大嘴
    // 怎么调：不久前喂过不是吃的时，张嘴快慢 × rate、张多大 × size（再叠在吃腻上）
    wary: { rate: 0.6, size: 0.55 },
  },

  // 用户可能怎么说：她早就忘了上次喂的是什么，还在怀疑
  // 怎么调：认图认出的口味（爱吃、不合口味、不是吃的）在这么多分钟里影响下一块的声音和张嘴
  tasteMinutes: 10,

  moments: {
    tired: { label: '有点累' },
    sleepy: { label: '困了' },
  },
});
