/**
 * I-037 新的反应方式的接口。
 *
 * 一件能引出反应的事（events.ts 登记的类别）发生时：
 *  1. 打分（choose.ts scoreReactions）：清单（knobs.ts REACTION_TABLE）里每种能被这件事引出的反应，
 *     得分 = 基础分 + 倾向加减（dispositions.ts）+ 此刻状态加减（心情、困、近期做过同类）+ 整体偏移 + 一点随机。
 *     做不到的（表现自己的硬门槛：模型没那个部位、睡着、脸红正在红、她在别的互动里）不进候选。留前几个。
 *  2. 身体互动（摸头、捏脸、喂点心）：最高分到了 actAt 就马上做（不等 haiku）。
 *  3. 说的话：和 Opus 的回复并行问 haiku 一次（electron/reactions/judge.ts）：它判断是哪一类、在那一类的候选里挑 0–2 个、
 *     轻中重，再给心情变化。只能在候选里挑；做之前再过一遍门槛。haiku 失败、超时、没额度：等她回复的尾注，
 *     语境是暖心的（positive / support）就按"暖心的话"做最高分那个。
 *  4. 心情：haiku 给的和 Opus 尾注给的按比例合（MoodBlend：起点 haiku 0.7 / Opus 0.3），只有一边给就用那一边。
 *  5. 体验记录（shared/journal.ts 'reaction'）：类别、候选和分数、谁挑的、做了还是被挡和原因。没有原文。
 *
 * 谁调用：electron/reactions/host.ts 的 ReactionHost 是唯一的主机（打分、执行、记录）；electron/mood.ts MoodHost 通过
 * MoodReactionPort 告诉它身体互动和尾注，并把脸红交给它决定（开关开着时，心情模型自己的脸红门槛不再起作用）。
 * 开关"新的反应方式"关着时：一次 haiku 也不问，MoodHost 不接这个口子，行为和原来完全一样。
 *
 * 假 haiku 在 fake.ts；守约测试 tests/i037-reactions.test.ts。
 */
import type { MoodChannel, MoodLabel, MoodValues } from '../../mood';
import type { SenseId } from '../../sense-router';
import type { Dispositions } from './dispositions';
import type { ReactionEventId } from './events';
import type { ReactionLevel, ReactionRow } from './knobs';

/** haiku 的那一次调用（electron/inner-loop/model.ts quickLineWithClaude 的 text）。 */
export type ReactionAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;

/** 打分那一刻的她：都是数和标签，没有任何原文。 */
export interface ReactionNow {
  readonly characterId: string;
  readonly dispositions: Dispositions;
  readonly mood: MoodLabel;
  /** 明显犯困（有点困、犯困、快睡着）。睡着时根本不打分。 */
  readonly sleepy: boolean;
  readonly at: number;
  /** 这个角色最近做过的反应（算近期惩罚）。 */
  readonly recent: readonly ReactionDoneMark[];
}
export interface ReactionDoneMark { readonly id: string; readonly at: number }

/** 一个反应为什么这次做不了（硬门槛，表现自己说）。体验记录和测试只认这几种。 */
export const REACTION_BLOCKS = ['asleep', 'off', 'model', 'card-off', 'showing', 'busy', 'hidden', 'no-performer', 'failed', 'stale'] as const;
export type ReactionBlock = typeof REACTION_BLOCKS[number];
export const REACTION_BLOCK_WORDS: Readonly<Record<ReactionBlock, string>> = Object.freeze({
  asleep: '她在睡觉', off: '自动表现关着', model: '这个模型做不了', 'card-off': '角色卡把它关了', showing: '正在红着',
  busy: '她正忙着别的动作或互动', hidden: '桌宠没在显示', 'no-performer': '没有这个表现', failed: '没能交给舞台', stale: '已经过时了',
});

export interface ReactionScoreParts {
  readonly base: number; readonly lean: number; readonly mood: number; readonly sleepy: number;
  readonly recent: number; readonly offset: number; readonly jitter: number;
}
/** 一个打过分的反应。`blocked` 不为空 = 过不了门槛，不进候选。 */
export interface ReactionCandidate {
  readonly id: string;
  readonly score: number;
  readonly parts: ReactionScoreParts;
  readonly blocked: ReactionBlock | null;
}
/** 一类事件打完分：能做的候选（分数从高到低、过了 floor、最多 knobs.candidates 个）和被挡的。 */
export interface ReactionScoring {
  readonly event: ReactionEventId;
  readonly candidates: readonly ReactionCandidate[];
  readonly blocked: readonly ReactionCandidate[];
}

export interface ReactionPick { readonly id: string; readonly level: ReactionLevel }

/** haiku 的回答（严格 JSON 解析、只认候选里的）。 */
export interface ReactionAnswer {
  readonly event: ReactionEventId | 'none';
  readonly picks: readonly ReactionPick[];
  readonly delta: Partial<Record<MoodChannel, number>>;
  readonly confidence: number;
  /** I-040: the senses this message needs (shared/sense-router.ts), only when the prompt asked; null: not asked or unreadable. */
  readonly senses?: readonly SenseId[] | null;
}

/** 这件事的反应是谁定的。 */
export const REACTION_DECIDERS = ['top', 'haiku', 'fallback', 'none'] as const;
export type ReactionDecider = typeof REACTION_DECIDERS[number];
/** haiku 那一路怎么了（说的话才有）。 */
export const REACTION_HAIKU_OUTCOMES = ['answered', 'none', 'invalid', 'low-confidence', 'timeout', 'error', 'quota', 'quiet', 'superseded'] as const;
export type ReactionHaikuOutcome = typeof REACTION_HAIKU_OUTCOMES[number];

/** 表现做完的回答。 */
export type ReactionPerformed = { readonly done: true } | { readonly done: false; readonly why: ReactionBlock };

/** 一个表现（electron/reactions/performers.ts；测试可以注入假的）。 */
export interface ReactionPerformer {
  /** 占不占舞台：两个占舞台的反应一前一后做（第二个在第一个做完后）。 */
  readonly stage: boolean;
  /** 占舞台时大概多久（毫秒）。 */
  readonly durationMs?: number;
  /** 此刻做不做得到（硬门槛）；null = 能做。打分时和真做之前各问一次。 */
  gate(row: ReactionRow, context: ReactionGateContext): ReactionBlock | null;
  perform(row: ReactionRow, level: ReactionLevel, context: ReactionPerformContext): Promise<ReactionPerformed> | ReactionPerformed;
}
export interface ReactionGateContext { readonly characterId: string; readonly event: ReactionEventId }
export interface ReactionPerformContext extends ReactionGateContext { readonly id: string; readonly key: string }

/** 心情主机告诉反应主机的一件事（MoodReactionPort.observe）。 */
export interface MoodReactionNote {
  readonly characterId: string;
  readonly type: 'rua' | 'food' | 'chat' | 'appraisal';
  readonly id: string;
  /** 摸头、捏脸、喂食所在的那一次接触。 */
  readonly session: string | null;
  /** 捏脸（rua 事件 id 以 cheek: 开头）。 */
  readonly pinch: boolean;
  /** 摸头：这一下之前和之后，最近 fastWindowMs 里亲近一共涨了多少，和卡上的门槛。 */
  readonly oBefore: number;
  readonly oAfter: number;
  readonly threshold: number;
  /** 尾注回应的是哪一条消息、它的语境。 */
  readonly responseTo?: string;
  readonly context?: string;
}

/**
 * MoodHost 通过它和反应主机说话（electron/mood.ts setReactionPort）。开关关着时主机不接（null），一切照旧。
 */
export interface MoodReactionPort {
  /** 这个角色的脸红由反应清单决定（心情模型自己的脸红门槛这时不起作用）。 */
  ownsBlush(characterId: string): boolean;
  /** Opus 尾注到了：这一刻该加多少（MoodBlend 的 Opus 那一份）。 */
  appraisal(characterId: string, responseTo: string, delta: Partial<MoodValues>, context: string | undefined): Partial<MoodValues>;
  /** 一件被接受的事（摸头、捏脸、喂食、聊天、尾注）。在心情模型更新以后同步调用；反应主机自己排到下一拍再做。 */
  observe(note: MoodReactionNote): void;
}
