/**
 * 功能：她闲着时"动一动""看你一眼"的样子和表情（写死规则清单 #11）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - base：基础分量，分"看你一眼"（look）和"动一动"（motion）两种时机；0 = 这种时机不用它。
 *  - mood：她此刻的心情让分量 × 多少（没写的心情 = 1）。
 *  - now：她这会儿的情绪倾向（心情快照里最强的那一项：调皮、黏人、放松、拘谨、想念的余韵）× 多少。
 *  - personality：角色卡性格（weights，1 = 一般）的影响有多大：倍数 = 1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3。
 *  - moments：此刻发生过的事（见下面 moments）× 多少。
 *  - amplitude：幅度范围（弧度，头的转动），每次在里面挑一个；pace：快慢范围（> 1 更慢）。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodLabel, MoodTendency } from '../../mood';

export const IDLE_SHAPE_IDS = ['tilt', 'nod', 'glance', 'lift', 'stretch', 'sway'] as const;
export type IdleShapeId = typeof IDLE_SHAPE_IDS[number];
export const IDLE_FACE_IDS = ['plain', 'convinced', 'smile', 'shy', 'happy', 'mood'] as const;
export type IdleFaceId = typeof IDLE_FACE_IDS[number];
export const IDLE_MOMENTS = ['pat', 'pinch', 'food', 'bored', 'drowsy'] as const;
export type IdleMoment = typeof IDLE_MOMENTS[number];

type Range = readonly [number, number];
type Lean = {
  readonly base: { readonly look: number; readonly motion: number };
  readonly mood?: Partial<Record<MoodLabel, number>>;
  readonly now?: Partial<Record<MoodTendency | 'wistful', number>>;
  readonly personality?: Partial<Record<MoodTendency, number>>;
  readonly moments?: Partial<Record<IdleMoment, number>>;
};
export type IdleShapeKnob = Lean & { readonly label: string; readonly amplitude: Range; readonly pace: Range };
export type IdleFaceKnob = Lean & {
  readonly label: string;
  /**
   * 脸上演哪一段预装表情（只在核验过的 Gene 上有）：null = 不演表情片段；'mood' = 她此刻心情的那张脸（原来的做法，
   * 只在担心、难过这类心情里用）。
   */
  readonly bindingId: 'face.convinced' | 'face.smile' | 'face.embarrassed-smile' | 'face.happy' | 'mood' | null;
  /** 嘴角那点笑（所有模型都有）× 多少；1 = 原来的样子。 */
  readonly smile: number;
  /** 她此刻心情沉重（担心、失落、不满、想念、伤感、紧张期待，或刚遇到让人担心、失望、冒犯的事）时 × 多少；其他时候 × 第二个数。 */
  readonly serious: readonly [number, number];
};

export interface IdleGestureKnobs {
  readonly size: number;
  readonly recent: readonly number[];
  readonly shapes: Readonly<Record<IdleShapeId, IdleShapeKnob>>;
  readonly faces: Readonly<Record<IdleFaceId, IdleFaceKnob>>;
  readonly moments: {
    readonly pat: { readonly label: string; readonly withinMs: number };
    readonly pinch: { readonly label: string; readonly withinMs: number };
    readonly food: { readonly label: string; readonly withinMs: number };
    readonly bored: { readonly label: string; readonly from: number };
    readonly drowsy: { readonly label: string };
  };
}

export const IDLE_GESTURE_KNOBS: IdleGestureKnobs = Object.freeze<IdleGestureKnobs>({
  // 用户可能怎么说：她动来动去太多了、动作太大太明显；她动得太小，看不出她在动
  // 怎么调：所有样子的幅度一起 × 这个数（1 是现在，0.5 是一半）。要是说的是"多久动一次"，那是 #8 无聊门槛（还没改），不在这里
  size: 1,

  // 用户可能怎么说：她老重复同一个动作／她太刻意地不重复了
  // 怎么调：上一次、上上次、再上一次挑过的样子和表情，分量 × 这几个数；越小越不重复，1 = 不管重复
  recent: [0.2, 0.55, 0.85],

  shapes: {
    // 用户可能怎么说：她老是歪头／她怎么不歪头了／歪头歪得太厉害了
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace
    tilt: { label: '歪头', base: { look: 0.8, motion: 1 }, amplitude: [0.06, 0.09], pace: [0.9, 1.15],
      mood: { happy: 1.4, excited: 1.5, content: 1.2, close: 1.3, relieved: 1.2, longing: 0.9, concerned: 0.7, disappointed: 0.6, upset: 0.4, sad: 0.5, 'tense-expectation': 0.8 },
      now: { playful: 1.5, close: 1.2 }, personality: { playful: 0.8 }, moments: { pat: 1.4, pinch: 1.3, food: 1.2, drowsy: 0.7 } },
    // 用户可能怎么说：她老点头／她怎么从来不点头／点头太用力了
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace
    nod: { label: '轻轻点头', base: { look: 0.4, motion: 1 }, amplitude: [0.045, 0.07], pace: [0.9, 1.15],
      mood: { content: 1.4, close: 1.3, calm: 1.2, relieved: 1.3, happy: 1.1, sad: 0.6, upset: 0.4, disappointed: 0.7, 'tense-expectation': 0.7 },
      now: { comfortable: 1.3, close: 1.2 }, personality: { close: 0.4, comfortable: 0.3 }, moments: { pat: 1.3, food: 1.5, drowsy: 0.6 } },
    // 用户可能怎么说：她老往旁边看／她看向一边太远了
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace
    glance: { label: '看向一边再看回来', base: { look: 1, motion: 0.8 }, amplitude: [0.08, 0.12], pace: [0.9, 1.15],
      mood: { 'tense-expectation': 1.5, concerned: 1.3, upset: 1.4, disappointed: 1.3, longing: 1.2, calm: 1.1, happy: 0.8, excited: 0.7 },
      now: { cautious: 1.5, wistful: 1.2 }, personality: { cautious: 0.8 }, moments: { bored: 1.3, drowsy: 0.6 } },
    // 用户可能怎么说：她老抬眼看我／她都不看我
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace
    lift: { label: '抬眼看你', base: { look: 1.4, motion: 0.5 }, amplitude: [0.03, 0.05], pace: [0.9, 1.15],
      mood: { longing: 1.8, close: 1.4, sad: 1.2, happy: 1.1, relieved: 1.2, upset: 0.7 },
      now: { close: 1.3, wistful: 1.4 }, personality: { close: 0.6 }, moments: { bored: 1.4, pat: 1.2 } },
    // 用户可能怎么说：她老伸脖子／伸得太夸张了
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace
    stretch: { label: '伸伸脖子', base: { look: 0, motion: 0.8 }, amplitude: [0.055, 0.08], pace: [0.95, 1.2],
      mood: { calm: 1.3, content: 1.3, upset: 0.6, 'tense-expectation': 0.5, sad: 0.7, concerned: 0.7 },
      now: { comfortable: 1.4 }, personality: { comfortable: 0.6 }, moments: { bored: 1.8, drowsy: 1.6 } },
    // 用户可能怎么说：原来那个轻轻晃一下头太多了／太少了
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；太厉害/太轻 → amplitude（幅度范围，弧度）；太快/太慢 → pace
    sway: { label: '轻轻晃一下头', base: { look: 0.5, motion: 0.5 }, amplitude: [0.012, 0.02], pace: [0.95, 1.1] },
  },

  faces: {
    // 用户可能怎么说：她闲着时太没表情了／太多表情了
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile
    plain: { label: '只是看着', bindingId: null, smile: 0.35, serious: [0.6, 1], base: { look: 1.4, motion: 0.8 },
      mood: { calm: 1.3, concerned: 1.2, 'tense-expectation': 1.2 } },
    // 用户可能怎么说：她老是一副若有所思的样子
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile
    convinced: { label: '若有所思', bindingId: 'face.convinced', smile: 0.6, serious: [0, 1], base: { look: 0.5, motion: 1 },
      mood: { calm: 1.4, content: 1.1 } },
    // 用户可能怎么说：她笑得太多了／她闲着时都不笑
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile
    smile: { label: '浅浅一笑', bindingId: 'face.smile', smile: 1, serious: [0, 1], base: { look: 0.8, motion: 1 },
      mood: { content: 1.5, relieved: 1.4, happy: 1.3, close: 1.2, calm: 0.7 }, moments: { pat: 1.3, food: 1.2 } },
    // 用户可能怎么说：她老是害羞地笑／不够害羞
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile
    shy: { label: '有点害羞地笑', bindingId: 'face.embarrassed-smile', smile: 0.85, serious: [0, 1], base: { look: 0.5, motion: 0.6 },
      mood: { close: 1.6, happy: 1.1 }, now: { cautious: 1.4, close: 1.3 }, personality: { cautious: 0.6 }, moments: { pat: 1.5, pinch: 1.5 } },
    // 用户可能怎么说：她闲着时太开心了／不够开心
    // 怎么调：太多/太少 → base（多常用，0 = 不用它）；笑多笑少 → smile
    happy: { label: '开心', bindingId: 'face.happy', smile: 1.15, serious: [0, 1], base: { look: 0.35, motion: 0.6 },
      mood: { happy: 1.7, excited: 1.9, relieved: 1.2, calm: 0.4, content: 0.9 }, now: { playful: 1.4 }, moments: { food: 1.3 } },
    // 用户可能怎么说：她难过的时候闲着也太丧了
    // 怎么调：太丧 → base 调小（她更常"只是看着"）；这是原来的做法，serious 第二个数 0 = 心情不沉重时从不用它
    mood: { label: '心情写在脸上', bindingId: 'mood', smile: 0, serious: [1, 0], base: { look: 0.8, motion: 1.2 } },
  },

  moments: {
    // 用户可能怎么说：摸完头好一会儿了，她还当是刚被摸过
    // 怎么调：多久以内算"不久前被摸过头"（毫秒）
    pat: { label: '不久前被摸过头', withinMs: 10 * 60_000 },
    // 用户可能怎么说：捏完脸好一会儿了，她还当是刚被捏过
    // 怎么调：多久以内算"不久前被捏过脸"（毫秒）
    pinch: { label: '不久前被捏过脸', withinMs: 10 * 60_000 },
    // 用户可能怎么说：喂完点心好一会儿了，她还当是刚吃过
    // 怎么调：多久以内算"不久前吃过点心"（毫秒）
    food: { label: '不久前吃过点心', withinMs: 10 * 60_000 },
    // 用户可能怎么说：她才闲了一会儿就开始伸脖子
    // 怎么调：无聊到多少（0～100）算"闲了很久"
    bored: { label: '闲了很久', from: 70 },
    drowsy: { label: '有点困' },
  },
});
