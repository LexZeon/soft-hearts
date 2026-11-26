/**
 * I-136 被点、被捏、被拉时她怎么回应（Unbound v1 第 2 步，第 5 步拉她时再用；稿 5、6、7）。
 * 记录：docs/claude/2026-11-15-unbound-v1-step2-touch.md。
 *
 * 要求：表情从心情激素数值来、不调用 Claude，但 Claude 也要知道状态日志；是否发起对话看心情数值、按角色不按设置；被点不能程序写死，而是作为"用户点击了你"这件事反馈给角色。
 *
 * 一圈（读 → 表现 → 写回 → 回落）：
 *  1. 读：五个激素（相对角色卡基线）、困意 A、心情数值 B（无聊）和 M（想念）、角色的反应倾向、困不困、刚做过什么，加一点随机。
 *  2. 表现（都在本机，不调 Claude）：
 *     - 脸（face.ts pickTouchFace）：从 knobs.ts 的 TOUCH_FACES 里按 I-037 同一套打分挑一个（眯眼笑、抿嘴笑、愣一下、皱眼躲、懒懒眯眼）。
 *       捏脸时脸上的笑和眯眼就来自它（原来按心情名字写死的去掉了，物理的那一下保留）。
 *     - 小反应（I-037 反应清单，electron/mood/reactions/host.ts touched）：脸红、害羞、歪头、撅嘴……分数够才做。
 *     - 开不开口（speak.ts decideTouchSpeech）：按心情数值和性格掷一次，没有开关；连着的合成一件，刚说过就更不容易再说。
 *       决定开口才走原来的主动开口那条路（内心循环，一次 Claude 调用）：桌宠照桌宠的次数上限，Unbound 不设上限。
 *  3. 写回（mood.ts touchLift）：轻轻点、轻轻拉 → 亲近 O 涨一点；连着戳、拉得重、拉得久 → 紧张 N、压力 C 涨一点。都很小，
 *     乘角色卡敏感度，按各激素自己的半衰期回落（O 40 分钟、N 3 分钟、C 20 分钟）。她开口说的话之后照旧由心情账（haiku）记。
 *  4. 告诉 Claude（words.ts）：下一轮聊天和那次主动开口都知道"用户刚才点了你一下（肩膀），你抿嘴笑了一下"。只有事实，不是指令。
 *
 * 纯数据和纯函数：没有计时器、没有文件、不知道 Claude。主机是 electron/mood/touch/brain.ts。
 */
import type { MoodValues } from '../../foundation/mood';
import type { Dispositions } from '../reactions/dispositions';
import type { PullEnd, PullResponse, TouchPart, TouchPlace } from '../../mood/touch';

/** What kind of touch one episode is: the new ones (click, pull) and the old ones the brain hears about (pinch, pat, food). */
export const TOUCH_EPISODE_KINDS = ['click', 'pull', 'pinch', 'pat', 'food'] as const;
export type TouchEpisodeKind = typeof TOUCH_EPISODE_KINDS[number];
/** The kinds whose face is picked here (a pat and a snack keep their own faces). */
export type TouchFaceEvent = Extract<TouchEpisodeKind, 'click' | 'pinch' | 'pull'>;

/** Her face for one touch (knobs.ts TOUCH_FACES). */
export const TOUCH_FACE_IDS = ['beam', 'smile', 'blank', 'wince', 'drowsy'] as const;
export type TouchFaceId = typeof TOUCH_FACE_IDS[number];

/**
 * The picked face as the stages read it (MoodView.touchFace): names, numbers and times only. `smile` and `eyelids` are 0–1 morph
 * weights before the card's expression strength; the companion's cheek pinch layer uses them while the pinch lasts, a click's face holds
 * until `until`.
 */
export interface TouchFaceView {
  readonly id: string;
  readonly kind: TouchFaceEvent;
  readonly face: TouchFaceId;
  readonly smile: number;
  readonly eyelids: number;
  readonly at: number;
  readonly until: number;
  readonly part?: TouchPart;
}

/** One merged touch: the same kind and part close together count as one, with a count. */
export interface TouchEpisode {
  readonly id: string;
  readonly kind: TouchEpisodeKind;
  readonly part: TouchPart | null;
  readonly side: 'left' | 'right' | null;
  readonly where: TouchPlace;
  readonly characterId: string;
  readonly firstAt: number;
  lastAt: number;
  /** How many touches (a pull's "still holding" report and its end are one pull). */
  count: number;
  /** Pull only: the hardest and the longest so far, and how the last one ended. */
  strength: number;
  heldMs: number;
  ended: PullEnd | null;
  /** Pull only (I-136 step 5c/5e): what her body did (pulled back sticks), and the most steps she walked along. */
  response?: PullResponse | null;
  steps?: number;
}

/** What the speak decision reads (all numbers, closed names and times; never a word). */
export interface TouchSpeechInput {
  readonly kind: TouchEpisodeKind;
  readonly part: TouchPart | null;
  readonly count: number;
  readonly strength: number;
  readonly heldMs: number;
  readonly values: MoodValues | null;
  readonly baseline: MoodValues | null;
  readonly evidence?: number;
  readonly boredom: number;
  readonly longing: number;
  readonly dispositions: Dispositions;
  readonly sleepy: boolean;
  readonly asleep: boolean;
  /** How long ago she last spoke because of a touch (null: not recently). */
  readonly sinceSpokeMs: number | null;
}

export interface TouchSpeechDecision {
  readonly speak: boolean;
  /** The chance she rolled against, 0–max. */
  readonly chance: number;
  /** Each term, for the developer and tests. */
  readonly parts: Readonly<{ base: number; mood: number; lean: number; repeat: number; strength: number; sleepy: number; recent: number }>;
}

/**
 * How the mood host (electron/mood/mood.ts MoodHost.setTouchPort) talks to the touch brain: a pinch began (pick her face now), a pat / pinch /
 * snack was accepted (remember it, maybe say something), and the face to publish in the view. Every call is wrapped: a failing brain
 * never blocks a touch.
 */
export interface MoodTouchPort {
  started?(kind: 'pinch', session: string, characterId: string): void;
  contacted?(kind: 'pat' | 'pinch' | 'food', at: number, characterId: string, session: string | null): void;
  /** The face for the view now; `cheek` is the cheek session in progress (null: none). */
  face?(characterId: string, now: number, cheek: string | null): TouchFaceView | null;
}

/** How a touch episode's "say something?" ended (the journal's closed words). */
export const TOUCH_SPEAK_OUTCOMES = ['quiet', 'asked', 'held', 'asleep', 'off'] as const;
export type TouchSpeakOutcome = typeof TOUCH_SPEAK_OUTCOMES[number];

/** The journal row (shared/memory/journal.ts 'touch'): counts and choices only, never a word. */
export interface TouchJournalRow {
  readonly characterId: string;
  readonly kind: TouchEpisodeKind;
  readonly part: TouchPart | null;
  readonly where: TouchPlace;
  readonly count: number;
  readonly face: TouchFaceId | 'none';
  readonly reaction: string | null;
  readonly speak: TouchSpeakOutcome;
  /** The chance she rolled, in tenths (0–9); absent when she did not roll. */
  readonly chance?: number;
}
