import type { MoodParameters, MoodPhase, MoodSnapshot } from './mood';
import type { ChatGestureCue } from './chat-gesture';
import type { BehaviorMotionPlan } from './behavior-motion';
import type { BodyMotionPlan } from './body-motion';
import type { FatigueView } from './fatigue-runtime';
import type { UserStateView } from './user-state';
import type { RelationshipView } from './relationship';
import type { HerLifeView } from './her-life';
import type { HerNeedView } from './her-needs';
import type { PoseReactionView } from './pose-reactions';
import type { ReplyRhythmView } from './reply-rhythm';
import type { IdleGestureView, IdleGestureWhy } from './behaviors/idle-gesture/interface';
import type { BoredomTimingWhy } from './behaviors/boredom-timing/interface';
import type { ReplyLingerWhy } from './behaviors/reply-linger/interface';
import type { TouchFeedWhy } from './behaviors/touch-feed-effect/interface';
import type { BlushWhy } from './behaviors/blush/interface';
import type { FeedCueView, FeedCueWhy } from './behaviors/feed-cue/interface';
import type { ModuleRouterWhy } from './module-router/interface';
import type { MoodJudgeView } from './behaviors/mood-judge/interface';
import type { PauseTalkView } from './behaviors/pause-talk/interface';
import type { InteractionBudgetView } from './behaviors/interaction-budget/interface';

export interface MoodParameterIdentity { characterId: string; token: string }
/** A retired direct contact only; it never invalidates the character/chat context. */
export interface DirectContactCancellation extends MoodParameterIdentity { sessionId: string }

export interface MoodView {
  characterId: string;
  revision: number;
  token: string;
  developerMode: boolean;
  expressions: boolean;
  /** Transient native lifecycle notification, carried by the existing typed mood bridge. */
  directContactCancellation?: DirectContactCancellation;
  storageError?: string;
  parameters: MoodParameters;
  snapshot: MoodSnapshot;
  /** Separate host sidecar; never added to portable mood/card values. */
  fatigue?: FatigueView;
  /** Her current read of how the user is (electron/user-state.ts). Developer mode only, memory only, no reason text. */
  userState?: UserStateView;
  /** How long she has known the user and which days counted (electron/relationship/). Developer mode only; numbers, never the nickname. */
  relationship?: RelationshipView;
  /** 她自己的生活 (electron/her-life/host.ts): what she is doing while the user is away. State names and times only. */
  herLife?: HerLifeView;
  /** 她也会需要你 (electron/her-needs/host.ts): the small feeling she has now, or the warmth after she was soothed. A name, times and a strength. Only while 自动表现 is on. */
  herNeed?: HerNeedView;
  /**
   * P1 第二阶段 (electron/pose-reactions/host.ts): where her eyes are drawn while local camera sensing sees the user, and the
   * latest reaction to play (a yawn, a stretch or a wave she caught, her own stretch, a glance when the user arrives). Numbers,
   * names and times only; absent while sensing is off and nothing is playing.
   */
  pose?: PoseReactionView;
  /** F7 说话节奏 (electron/reply-rhythm-host.ts): the latest reply's pace and what set it, and the voice listening trial. Developer mode only; numbers and names, never text. */
  replyRhythm?: ReplyRhythmView;
  /**
   * M1: the user's latest "跳一个" in chat (host-issued marker; memory only, dropped after a minute). The stage reads it
   * as a request that adds to her own want to dance for a while (shared/music-desire.ts); it grants nothing.
   */
  danceRequest?: { id: string; at: number };
  /**
   * #11 动一动、看你一眼 (shared/behaviors/idle-gesture/): how she does the look or small motion showing now, as the host
   * picked it from her mood and card. Names and numbers only; absent when no such cue shows (the stage keeps its old sway).
   */
  idleGesture?: IdleGestureView;
  /** Developer mode only: why the last few were picked (memory only; labels and numbers, never user data). */
  idleGestureWhy?: readonly IdleGestureWhy[];
  /**
   * #8 你不理她时多久看你、动一下、想开口 (shared/behaviors/boredom-timing/), developer mode only: this round's and the last few
   * rounds' tempo, minutes and why (memory only; labels and numbers, never user data, never in the journal or a save).
   */
  boredomTimingWhy?: readonly BoredomTimingWhy[];
  /**
   * #5 回复说完气泡留多久 (shared/behaviors/reply-linger/): developer mode only, why the last few replies stayed as long as they
   * did (memory only; labels and numbers, never the reply's words).
   */
  replyLingerWhy?: readonly ReplyLingerWhy[];
  /**
   * #21 摸头、捏脸、喂点心让她心情好多少 (shared/behaviors/touch-feed-effect/), developer mode only: the last few, how much each
   * landed and why (memory only; labels and numbers, never user data, never in the journal or a save).
   */
  touchFeedWhy?: readonly TouchFeedWhy[];
  /** #26 脸红 (shared/behaviors/blush/), developer mode only: the last few blushes, how they looked and why (memory only). */
  blushWhy?: readonly BlushWhy[];
  /**
   * #32 喂点心时的语气词和吃法 (shared/behaviors/feed-cue/): how she sounds and eats for the snack being fed now, as the host
   * picked it. Sound names and numbers only; absent while 自动表现 is off or no snack is being fed (stage and cues keep the old way).
   */
  feedCue?: FeedCueView;
  /** Developer mode only: the last few snacks, what she said and how she ate, and why (memory only; never in the journal or a save). */
  feedCueWhy?: readonly FeedCueWhy[];
  /**
   * I-023 haiku 调度台 (electron/module-router/), developer mode only: the last few messages, what haiku judged, how long it took
   * and who decided (memory only; module names, verdicts and times, never the message).
   */
  moduleRouterWhy?: readonly ModuleRouterWhy[];
  /**
   * I-027 心情调整员 (electron/mood-judge/), developer mode only: on or off, how many times haiku was asked today and the cap, and the
   * last few batches (event counts, outcome, which numbers moved and a fixed reason; memory only, never a word).
   */
  moodJudge?: MoodJudgeView;
  /**
   * F7 停停说说 (electron/pause-talk/), developer mode only: whether it is on, the last few replies' plans from haiku (status, time,
   * pauses and where she waited) and their first visible characters (ms, switch, carried background). Numbers only, never a word.
   */
  pauseTalk?: PauseTalkView;
  /**
   * I-010 互动余额 (electron/interaction-budget/), developer mode only: the balance now (earned + floor), the card's cost multiplier,
   * whether it is her night, and the last few things that added to it or drew from it (kinds and numbers only; memory only).
   */
  interactionBudget?: InteractionBudgetView;
  /** Ephemeral host-selected performance; never persisted with the character. */
  gesture: ChatGestureCue | null;
  /** Optional, host-owned presentation. Never part of saved mood/card data. */
  behavior?: BehaviorMotionPlan;
  /** Fixed host presentation lease; normal candidate pool remains closed. */
  body?: BodyMotionPlan;
  /** Same accepted host cue and content-qualified static FK properties; never a new reward. */
  bodyPose?: import('./personalize-body-presentation').BodyPosePresentation | null;
}
export type MoodInput =
  | { token: string; sessionId: string; type: 'wake'; id: string }
  | { token: string; sessionId: string; type: 'phase'; phase: MoodPhase }
  | { token: string; sessionId: string; type: 'rua'; id: string; activeMs: number }
  /** One normal-release report; the host shares rua freshness and bounds by its own clock. */
  | { token: string; sessionId: string; type: 'cheek'; id: string; activeMs: number }
  | { token: string; sessionId: string; type: 'food'; id: string };

export const MOOD_LABELS: Record<MoodSnapshot['primary'], string> = {
  calm: '平静', close: '亲近', content: '满足', happy: '愉快', excited: '兴奋',
  concerned: '担心', disappointed: '失落', upset: '不满', longing: '想念',
  sad: '伤感', relieved: '释然', 'tense-expectation': '紧张期待',
};
