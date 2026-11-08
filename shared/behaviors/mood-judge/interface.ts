/**
 * I-027 心情调整员的接口。
 * 方案和用量：docs/claude/2026-11-04-i027-usage-estimate.md；做法和验证：docs/claude/2026-11-04-i027-mood-judge.md。
 *
 * 做什么：她身上发生的事先照本机规则马上起作用（表情、脸红、心情数都和以前一样）；同时收进一批，过一会儿交给 haiku 看一眼：
 * 按她的性格和此刻的心情，这一阵五个心情数该再往哪边动、动多少、本机这次调得合不合理。本机把答案收在安全线里，加到现在的数上。
 *
 * 谁调用它、怎么调用（electron/mood-judge/host.ts 的 MoodJudgeHost 是唯一的主机）：
 *  1. 心情主机（electron/mood.ts MoodHost.setJudgeObserver）：每个被接受的摸头、捏脸、喂食、聊天、Opus 尾注、"她被哄好了"一类的 lift
 *     → MoodJudgeHost.noteMood（MoodJudgeMoodNote：类型、编号、固定原因、本机这次实际动了多少）。
 *  2. electron/main.ts：你发出的那句话（和发给 Opus 的是同一句，host 截到 knobs.userTextChars）→ userText；猜拳结果、她主动说出口的一句
 *     → note；每次心情视图发布 → watch（从视图里看出睡着 / 醒来、很久没人理跨过一道坎、你回来了、她有了小情绪、摄像头看到的动作，
 *     以及屏幕共享时你换了在做的事、一起听完一首）。
 *  3. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.moodJudge：今天问了几次、上限、最近几次的结果（只在开发者模式，只在内存）。
 *  4. 体验记录（shared/journal.ts 'mood-judge'）：每次真的动了数写一行，原因只能是下面 MOOD_JUDGE_WHYS 里的一种（不引用你的话）。
 *
 * 底线（写死的，不是旋钮）：
 *  - 2026-11-07 起默认开（用户：心情调整员默认开启）；用户在「隐私与设置」里关掉（或对她、对自己的 Claude 说）就不再问 haiku，关着时一次都不问。
 *  - 交给 haiku 的：她的性格摘要、此刻的五个数和基线、几点、在做什么、困不困、这一批每件事一行（本机怎么调的、Opus 尾注怎么判的），
 *    和你说的那一句（截短）。不给图片、听到的原文、记忆、日记、画像。
 *  - 只动五个心情数（期待 D、亲近 O、舒适 E、激活 N、压力 C），不动无聊、想念、困、熟悉度、记忆、她的小需要。
 *  - 她睡着、桌宠藏起来或最小化、Claude 用不了、"自动表现"关着、开发者测试心情生效时，一次都不问。
 *  - 来晚的不翻旧账：每批有编号，最多生效一次；换了角色、她睡着、开了测试心情、超时、这批太旧，整条丢掉，不重试、不补。
 *
 * 假 haiku 在 fake.ts（按脚本回答、数调用次数），守约测试在 tests/i027-mood-judge.test.ts。
 */
import type { MoodChannel, MoodContext, MoodValues } from '../../mood';
import type { HerNeedId } from '../../her-needs';
import type { ScreenActivity } from '../../screen-activity';

/** haiku 的那一次调用：提示词、系统提示词、中止信号 → 它的原文（electron/inner-loop/model.ts quickLineWithClaude 的 text）。 */
export type MoodJudgeAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;

/** 喂食认图（I-019）认出来的那一个词。 */
export type MoodJudgeTaste = 'loved' | 'disliked' | 'notFood';
export type MoodJudgeGesture = 'yawn' | 'stretch' | 'wave';
export type MoodJudgeBoredLevel = 'look' | 'motion' | 'speech';
export type MoodJudgeLongingLevel = 'longing' | 'sad' | 'cry';

/**
 * 心情主机报来的一次被接受的心情变化（electron/mood.ts setJudgeObserver）。`reason` 只用来查固定表（她被哄好了、猜拳……），
 * 从不交给 haiku；`applied` 是本机这次实际动了多少（已经乘过角色卡敏感度、过了饱和）。
 */
export interface MoodJudgeMoodNote {
  readonly characterId: string;
  readonly type: 'rua' | 'food' | 'chat' | 'appraisal' | 'lift';
  readonly id: string;
  readonly reason?: string;
  readonly context?: MoodContext;
  /** 摸头、捏脸、喂食所在的那一次接触（MoodHost 的 activeSession.id）。 */
  readonly session?: string | null;
  /** 摸头的有效毫秒。 */
  readonly effectiveMs?: number;
  /** Opus 尾注回应的是哪一条消息（appraisal）。 */
  readonly responseTo?: string;
  readonly applied: MoodValues;
}

/** main.ts 和视图观察报来的其他事。都只是类别、数和时间，没有任何原文。 */
export type MoodJudgeNote =
  | { readonly kind: 'game'; readonly characterId: string; readonly result: 'her' | 'user' | 'none'; readonly rounds: number }
  | { readonly kind: 'her-line'; readonly characterId: string }
  | { readonly kind: 'her-line-answer'; readonly characterId: string; readonly answered: boolean }
  | { readonly kind: 'need-start'; readonly characterId: string; readonly need: HerNeedId }
  | { readonly kind: 'bored'; readonly characterId: string; readonly level: MoodJudgeBoredLevel }
  | { readonly kind: 'longing'; readonly characterId: string; readonly level: MoodJudgeLongingLevel }
  | { readonly kind: 'wake'; readonly characterId: string; readonly sleptMinutes: number | null }
  | { readonly kind: 'return'; readonly characterId: string; readonly via: 'interaction' | 'camera'; readonly awayMinutes: number | null }
  | { readonly kind: 'song'; readonly characterId: string }
  | { readonly kind: 'screen'; readonly characterId: string; readonly activity: ScreenActivity }
  | { readonly kind: 'camera'; readonly characterId: string; readonly gesture: MoodJudgeGesture };

/** 一批里的一件事（同一次摸头、同一份点心、同一条消息已经合成一件）。 */
export type MoodJudgeItem =
  | { readonly kind: 'message'; readonly key: string; readonly at: number; readonly voice: boolean; readonly text: string | null;
      readonly local: MoodValues; readonly opus: { readonly applied: MoodValues; readonly context: MoodContext } | null; readonly accepted: boolean }
  | { readonly kind: 'touch'; readonly key: string; readonly at: number; readonly how: 'pat' | 'pinch'; readonly count: number; readonly ms: number; readonly local: MoodValues }
  | { readonly kind: 'feed'; readonly key: string; readonly at: number; readonly taste: MoodJudgeTaste | null; readonly local: MoodValues }
  | { readonly kind: 'game'; readonly at: number; readonly result: 'her' | 'user' | 'none' | null; readonly rounds: number; readonly local: MoodValues }
  | { readonly kind: 'her-line'; readonly at: number; readonly answered: boolean | null }
  | { readonly kind: 'need'; readonly at: number; readonly phase: 'start' | 'soothed' | 'dip' | 'relief'; readonly need: HerNeedId | null; readonly local: MoodValues }
  | { readonly kind: 'bored'; readonly at: number; readonly level: MoodJudgeBoredLevel }
  | { readonly kind: 'longing'; readonly at: number; readonly level: MoodJudgeLongingLevel }
  | { readonly kind: 'wake'; readonly at: number; readonly sleptMinutes: number | null }
  | { readonly kind: 'return'; readonly at: number; readonly via: 'interaction' | 'camera'; readonly awayMinutes: number | null }
  | { readonly kind: 'song'; readonly at: number; readonly count: number }
  | { readonly kind: 'screen'; readonly at: number; readonly activity: ScreenActivity }
  | { readonly kind: 'camera'; readonly at: number; readonly gesture: MoodJudgeGesture }
  | { readonly kind: 'other'; readonly at: number; readonly local: MoodValues };

/** "此刻"：问 haiku 那一刻的她。都是标签、数和时间。 */
export interface MoodJudgeNow {
  readonly characterId: string;
  /** 性格摘要（角色卡的性格和描述，host 截到 knobs.personaChars）。 */
  readonly persona: string;
  /** 角色卡的四个倾向（1 = 一般）。 */
  readonly personality: Readonly<Record<'playful' | 'close' | 'comfortable' | 'cautious', number>>;
  readonly values: MoodValues;
  readonly baseline: MoodValues;
  /** 角色卡的敏感度：本机加修正前会除掉它（choose.ts liftDelta），haiku 说多少就是多少。 */
  readonly sensitivity: MoodValues;
  /** 心情标签的中文（"满足"）。 */
  readonly label: string;
  /** 困不困（"清醒""犯困"……）。 */
  readonly fatigue: string;
  /** 她在做什么（"陪着你""发呆"……），不知道时为空。 */
  readonly doing: string;
  /** 本地时间（墙上毫秒）。 */
  readonly at: number;
}

/** haiku 的回答（严格 JSON 解析过的）。 */
export interface MoodJudgeAnswer {
  readonly delta: Partial<Record<MoodChannel, number>>;
  /** 本机这一阵的调整合不合理。 */
  readonly fits: boolean;
  readonly why: MoodJudgeWhyId;
  readonly confidence: number;
}

/**
 * 理由只能是这几种之一（每种 20 字以内），所以体验记录和面板里永远不会出现你的原话或 haiku 自由发挥的句子。
 * 以后要加一种，在这里加一条（体验记录的白名单跟着这张表）。
 */
export const MOOD_JUDGE_WHYS = Object.freeze({
  // The first three judge the app's own first reaction; they read from her side, since "最近原因" shows them to her chat too.
  fits: '刚才的反应正好',
  'too-much': '刚才反应过了，收一点',
  'too-little': '刚才反应不够，补一点',
  warmer: '这一阵让她更想亲近你',
  calmer: '这一阵让她更安心',
  livelier: '这一阵让她更来劲',
  tense: '这一阵让她有点紧张',
  'let-down': '这一阵让她有点失落',
  subdued: '气氛低，开心收着点',
  lonely: '被晾了一阵，有点寂寞',
  sleepy: '她困了，起伏小一点',
  relieved: '你回来了，她安心了',
} as const);
export type MoodJudgeWhyId = keyof typeof MOOD_JUDGE_WHYS;
export const MOOD_JUDGE_WHY_IDS = Object.freeze(Object.keys(MOOD_JUDGE_WHYS) as MoodJudgeWhyId[]);

/** 一批为什么没问、或者问了以后为什么什么都没变。 */
export type MoodJudgeOutcome =
  | 'applied' | 'nothing' | 'low-confidence' | 'invalid' | 'timeout' | 'error'
  | 'stale' | 'character' | 'asleep' | 'test-mood' | 'hidden' | 'unavailable' | 'expressions-off' | 'quota' | 'off';

/** 开发者面板的一行：一批。只有件数、结果、动了哪几个数、固定的理由和耗时，没有任何原文。 */
export interface MoodJudgeWhy {
  readonly at: number;
  readonly events: number;
  readonly outcome: MoodJudgeOutcome;
  /** 真的加上去的修正（applied 时）。 */
  readonly delta?: Partial<Record<MoodChannel, number>>;
  readonly why?: MoodJudgeWhyId;
  readonly fits?: boolean;
  readonly confidence?: number;
  /** 这批里有你说的话、Opus 尾注已经生效，所以每个数最多 ±knobs.afterOpus。 */
  readonly afterOpus?: boolean;
  readonly ms?: number;
}

/** 开发者面板读的：开没开、今天问了几次、上限、到没到、最近几批。 */
export interface MoodJudgeView {
  readonly enabled: boolean;
  readonly today: number;
  readonly cap: number;
  readonly capReached: boolean;
  readonly recent: readonly MoodJudgeWhy[];
}

/** 控制窗口「隐私与设置」里的开关读到的。 */
/** `cap`: today's limit right now (the base plus `perChat` for each message today, at most `max`). */
export interface MoodJudgeSwitchView { readonly enabled: boolean; readonly cap: number; readonly base: number; readonly perChat: number; readonly max: number }

/** I-027: today's limit grows with the messages the user sent her today. */
export function moodJudgeDailyCap(knobs: { readonly callsPerDay: number; readonly callsPerChat: number; readonly callsPerDayMax: number }, chatsToday: number): number {
  const chats = Number.isFinite(chatsToday) && chatsToday > 0 ? Math.floor(chatsToday) : 0;
  return Math.min(knobs.callsPerDayMax, knobs.callsPerDay + knobs.callsPerChat * chats);
}
