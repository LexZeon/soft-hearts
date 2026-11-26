/**
 * 功能：I-136 被点、被捏、被拉时她露出什么、开不开口（Unbound v1 第 2 步）
 *
 * 能调的值都在这里，全是试用值，要用户在开发版和 Unbound 里试过才算数。
 *
 * 脸（TOUCH_FACES）的读法和 I-037 反应清单一样（shared/behaviors/reactions/knobs.ts）：events = 各事件的基础分；lean = 倾向每比 50 高 1 点
 * 加多少；hormones = 心情的数每比 50 高 1 点加多少（激素按相对基线的档位，B、M 按 50 + 数值 / 2，A 按 100 × A）；parts = 点 / 拉在哪儿
 * 加减；strength = 拉满时加减；sleepy = 犯困时加减；recent = 刚露过同一种脸的"近期惩罚"。得分全是加减，最高分的那张脸就是她的脸。
 * smile / eyelids 是这张脸的笑和眯眼有多深（0–1，舞台再乘角色卡的表情强度）。
 */
import type { MoodValues } from '../../foundation/mood';
import type { ReactionRow } from '../reactions/knobs';
import type { TouchFaceEvent, TouchFaceId } from './interface';

export interface TouchFaceRow extends ReactionRow {
  readonly smile: number;
  readonly eyelids: number;
  /** "你当时……" for her context line (words.ts). */
  readonly words: string;
}

export const TOUCH_FACES: Readonly<Record<TouchFaceId, TouchFaceRow>> = Object.freeze({
  // 用户可能怎么说：捏她的时候她笑得太多／太少
  beam: { label: '眯眼笑', describe: '眯起眼笑开', performer: 'face', words: '眯着眼笑了', smile: 0.26, eyelids: 0.32,
    events: { click: 40, pinch: 44, pull: 34 },
    lean: { lively: 0.3, restrained: -0.3, shy: -0.1 },
    hormones: { O: 0.6, E: 0.4, D: 0.3, C: -0.5, N: -0.1 }, parts: { face: 6, head: 4, torso: -8, leg: -6, foot: -6 }, strength: -15,
    sleepy: -10, recent: { penalty: 12, halfLifeMs: 60_000 } },
  // 用户可能怎么说：她被点了只会抿嘴笑
  smile: { label: '抿嘴笑', describe: '抿着嘴笑一下', performer: 'face', words: '抿嘴笑了一下', smile: 0.14, eyelids: 0.12,
    events: { click: 45, pinch: 46, pull: 42 },
    lean: { shy: 0.4, restrained: 0.2 },
    hormones: { O: 0.4, E: 0.2, C: -0.5 }, parts: { hand: 6, head: 3 }, strength: -10,
    sleepy: -4, recent: { penalty: 10, halfLifeMs: 60_000 } },
  // 用户可能怎么说：点她身上她都没反应／一点她就愣住
  blank: { label: '愣一下', describe: '愣一下，看着你', performer: 'face', words: '愣了一下', smile: 0, eyelids: 0.04,
    events: { click: 38, pinch: 30, pull: 30 },
    lean: { restrained: 0.2, lively: -0.1 },
    hormones: { N: 0.4, C: 0.2, O: -0.3 }, parts: { torso: 8, leg: 6, foot: 6, other: 4 },
    recent: { penalty: 8, halfLifeMs: 60_000 } },
  // 用户可能怎么说：她心情不好时被捏还在笑／捏一下就皱眉
  wince: { label: '皱眼躲', describe: '皱起眼往回躲一下', performer: 'face', words: '皱着眼躲了一下', smile: 0, eyelids: 0.36,
    events: { click: 20, pinch: 30, pull: 30 },
    lean: { volatile: 0.3, shy: 0.1 },
    hormones: { C: 0.6, N: 0.4, E: -0.4, O: -0.2 }, parts: { face: 4 }, strength: 30,
    recent: { penalty: 15, halfLifeMs: 90_000 } },
  // 用户可能怎么说：她困的时候被点还很精神
  drowsy: { label: '懒懒眯眼', describe: '困得懒懒地眯一下眼', performer: 'face', words: '懒懒地眯了下眼', smile: 0.05, eyelids: 0.45,
    events: { click: 15, pinch: 15, pull: 10 },
    hormones: { A: 0.4 },
    sleepy: 40, recent: { penalty: 10, halfLifeMs: 60_000 } },
} satisfies Record<TouchFaceId, TouchFaceRow>);

export interface TouchResponseKnobs {
  readonly mergeMs: number;
  readonly decideAfterMs: number;
  readonly decideMaxWaitMs: number;
  readonly repeatAt: number;
  readonly faceJitter: number;
  readonly faceHoldMs: number;
  readonly pinchFaceMs: number;
  readonly speak: {
    readonly base: Readonly<Record<TouchFaceEvent | 'pat' | 'food', number>>;
    readonly mood: Readonly<Partial<Record<keyof MoodValues | 'B' | 'M', number>>>;
    readonly lean: Readonly<Partial<Record<'lively' | 'clingy' | 'volatile' | 'restrained' | 'shy' | 'soothable', number>>>;
    readonly perExtra: number;
    readonly extraMax: number;
    readonly strength: number;
    readonly sleepy: number;
    readonly recent: { readonly penalty: number; readonly halfLifeMs: number };
    readonly max: number;
  };
  readonly lift: {
    readonly gentleO: number;
    readonly pokeN: number;
    readonly pokeC: number;
    readonly pokeEvery: number;
    readonly hardAt: number;
    readonly longMs: number;
    readonly hardN: number;
    readonly hardC: number;
    readonly brokeFreeC: number;
  };
  readonly recentMs: number;
  readonly wordsMax: number;
}

export const TOUCH_RESPONSE_KNOBS: TouchResponseKnobs = Object.freeze<TouchResponseKnobs>({
  // 用户可能怎么说：连着点她，她每一下都当成新的一件事
  // 说明：同一种、同一个部位，离上一下不到这么多毫秒，算同一件事（次数加一）
  mergeMs: 10_000,

  // 用户可能怎么说：点完她过好久才开口／还没点完她就说话了
  // 说明：最后一下之后等这么多毫秒再决定开不开口（连着点就一直往后等），但从第一下算起最多等 decideMaxWaitMs
  decideAfterMs: 1_200,
  decideMaxWaitMs: 4_000,

  // 用户可能怎么说：我一直戳她，她都不说话
  // 说明：同一件事里点到第几下时，她（这件事里还没开口的话）再掷一次要不要开口
  repeatAt: 3,

  // 用户可能怎么说：同样点她，脸每次都一样
  // 说明：挑脸时每张脸加减一个不超过这么多的随机数
  faceJitter: 4,

  // 用户可能怎么说：点完她，脸上的样子一下就没了／挂得太久
  // 说明：点她、拉她挑出的脸留多少毫秒（捏脸的脸只在捏着时用）
  faceHoldMs: 2_500,
  // 说明：一次捏脸挑的脸最多留多少毫秒（一次捏脸通常远比这短）
  pinchFaceMs: 120_000,

  speak: {
    // 用户可能怎么说：点她一下她太爱说话了／从来不说
    // 说明：每种事件开口的基础机会（0–1）；摸头、喂点心不在这里开口（它们有自己的反应和声音）
    base: { click: 0.22, pinch: 0.1, pull: 0.3, pat: 0, food: 0 },
    // 用户可能怎么说：她心情好的时候被点也不搭理我
    // 说明：心情的数每比 50 高 1 点加多少机会（激素按相对基线的档位；B 无聊、M 想念按数值，0 就不加）
    mood: { O: 0.006, D: 0.004, N: 0.003, C: 0.002, B: 0.003, M: 0.004 },
    // 用户可能怎么说：活泼的角色被点也不吭声／克制的角色话太多
    // 说明：反应倾向每比 50 高 1 点加多少机会（负数是减）
    lean: { lively: 0.004, clingy: 0.003, volatile: 0.002, soothable: 0.001, restrained: -0.005, shy: -0.002 },
    // 说明：同一件事里每多一下加多少机会，最多加 extraMax
    perExtra: 0.06,
    extraMax: 0.18,
    // 说明：拉满（力度 1）时加多少机会
    strength: 0.25,
    // 说明：犯困时减多少
    sleepy: 0.3,
    // 用户可能怎么说：她刚说完又因为我点她说话
    // 说明：刚因为被碰开过口，减 penalty，每过 halfLifeMs 减半
    recent: { penalty: 0.6, halfLifeMs: 60_000 },
    // 说明：机会最多到这么多（总留一点不开口的可能）
    max: 0.85,
  },

  lift: {
    // 用户可能怎么说：点她、轻轻拉她，她心情变化太大／没变化
    // 说明：一件轻轻的点或拉让亲近 O 涨多少（再乘角色卡敏感度，40 分钟回落一半）
    gentleO: 1,
    // 用户可能怎么说：一直戳她她也不烦
    // 说明：同一件事里每 pokeEvery 下，紧张 N、压力 C 各涨多少
    pokeN: 1,
    pokeC: 0.5,
    pokeEvery: 3,
    // 用户可能怎么说：用力拉她她也不紧张
    // 说明：拉的力度到 hardAt 或拉住超过 longMs 算重 / 久，N、C 按力度涨到这么多；她挣开时 C 再涨 brokeFreeC
    hardAt: 0.6,
    longMs: 5_000,
    hardN: 3,
    hardC: 2,
    brokeFreeC: 1.5,
  },

  // 说明：多久以内的被碰算"刚才"，会告诉她（和摸头、捏脸、喂点心一样 30 秒）
  recentMs: 30_000,
  // 说明："用户刚才……"这一段最多多少字
  wordsMax: 100,
});
