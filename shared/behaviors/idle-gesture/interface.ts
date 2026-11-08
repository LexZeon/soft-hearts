/**
 * #11 "动一动""看你一眼"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/mood.ts 的 MoodHost）是唯一调用"挑"的一方（IdleGestureHost，真实现 choose.ts 的 IdleGestureDirector）：
 *     - 规则时机：MoodHost.tick 到了无聊门槛发出 look / motion 时机 → 来源 'rule'；
 *     - 她自己选：内心循环（electron/inner-loop/）认领了时机、模型选了 look 或 motion，经 realize 发回一个带 `claimed` 的
 *       attention 事件 → MoodHost.event 记下来源 'inner'；开发者测试命令（forceAttention）→ 'test'。
 *     两种来源走同一个挑法，只是"为什么"里写的时机不同。问模型的频率不变（内心循环自己的节流）。
 *     MoodHost 在每次生成视图时 present()，把挑中的样子放进 MoodView.idleGesture，把表情交给 BehaviorMotionController；
 *     发给窗口之后 settle() 才记进"最近挑过"。被内心循环认领、窗口看不到的时机由 hide() 撤掉（electron/inner-loop/claim.ts），
 *     不记进"最近挑过"，"为什么"里也不会出现没演出来的东西。
 *  2. 舞台（src/stage/mood-feedback.ts 的 MoodFeedback）是唯一调用"演"的一方（IdleGestureStage，真实现 perform.ts）：
 *     每帧把 MoodView.idleGesture 交给它（只在时机还亮着时），拿回头和眼睛的小偏移、嘴角笑的倍数。
 *  3. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.idleGestureWhy：最近几次挑了什么、为什么（只在内存，只有标签和分钟数）。
 *
 * 假实现在 fake.ts，守约测试在 tests/idle-gesture.test.ts：换一种实现，先过那组测试。
 */
import type { MoodCue, MoodLabel, MoodTendency } from '../../mood';
import type { BehaviorFaceBindingId } from '../../behavior-motion';
import type { IdleFaceId, IdleMoment, IdleShapeId } from './knobs';

export type IdleGestureKind = 'look' | 'motion';
/** 时机从哪来：规则（无聊门槛）、她自己（内心循环选了 look / motion）、开发者测试命令。 */
export type IdleGestureSource = 'rule' | 'inner' | 'test';

/** "此刻"：挑的时候只看这些。都是标签和数，不含任何对话内容。 */
export interface IdleGestureNow {
  readonly kind: IdleGestureKind;
  readonly source: IdleGestureSource;
  readonly mood: MoodLabel;
  /** 心情沉重：担心、失落、不满、想念、伤感、紧张期待，或刚遇到让人担心、失望、冒犯的事。这时不笑。 */
  readonly serious: boolean;
  /** 她这会儿最强的情绪倾向（心情快照的 companion）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  /** 此刻发生过的事（窗口由旋钮 moments 定）。 */
  readonly moments: readonly IdleMoment[];
  /** 心情写在脸上那张脸（原来的做法：她此刻心情的表情，没有就是为难）。 */
  readonly moodFace: BehaviorFaceBindingId;
}

/** 舞台按这个演。只有名字和数。 */
export interface IdleGestureView {
  /** 这个样子属于哪个时机（MoodSnapshot.cue.id）。 */
  readonly cueId: string;
  readonly kind: IdleGestureKind;
  readonly shape: IdleShapeId;
  /** 往哪边（歪头、看向一边、伸脖子）：1 或 -1。 */
  readonly side: 1 | -1;
  /** 头转多少（弧度，已乘"动作幅度"旋钮）。 */
  readonly amplitude: number;
  /** 眼睛那一点点偏移 × 多少（= "动作幅度"旋钮）。 */
  readonly eyes: number;
  /** 快慢（> 1 更慢）。 */
  readonly pace: number;
  /** 嘴角那点笑 × 多少（1 = 原来的样子）。 */
  readonly smile: number;
}

/** 主机拿到的：舞台演的样子，加上脸上演哪段预装表情（null = 不演表情片段）。 */
export interface IdleGesturePresentation {
  readonly view: IdleGestureView;
  readonly bindingId: BehaviorFaceBindingId | null;
}

/** 开发者面板的一行："为什么挑这个"。 */
export interface IdleGestureWhy {
  readonly at: number;
  readonly kind: IdleGestureKind;
  readonly source: IdleGestureSource;
  /** 样子和表情的名字（"歪头""浅浅一笑"）。 */
  readonly shape: string;
  readonly face: string;
  /** 从此刻来的真实理由，第一条是时机。 */
  readonly why: readonly string[];
  /** 附带：挑之前的分量，"歪头 1.9 · 点头 0.3 · …"。 */
  readonly weights: string;
}

/** 主机这一侧（真实现：choose.ts IdleGestureDirector；假实现：fake.ts FakeIdleGestureHost）。 */
export interface IdleGestureHost {
  /** 记下一个时机的来源（在它变成心情里的 cue 之前调用）；没记的算 'rule'。 */
  note(cueId: string, source: IdleGestureSource): void;
  /**
   * 现在亮着的时机该怎么演。同一个时机每次返回同一个结果；不是 look / motion、或已经 hide 的返回 null。
   * `now` 只在第一次见到这个时机时调用。
   */
  present(characterId: string, cue: MoodCue | null, now: (source: IdleGestureSource) => IdleGestureNow | null): IdleGesturePresentation | null;
  /** 这个时机窗口看不到（被内心循环认领了）：撤掉，不记进最近挑过。 */
  hide(cueId: string): void;
  /** 视图已经发给窗口：把还没撤掉的那次记进"最近挑过"和"为什么"。 */
  settle(): void;
  /** 这个角色最近几次，最新的在前。 */
  recent(characterId: string): readonly IdleGestureWhy[];
}

/** 舞台一帧拿到的偏移（弧度）。owns = 这个时机由新写法演（原来的轻摆头让开）。 */
export interface IdleGestureFrame {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly eyeYaw: number;
  readonly eyePitch: number;
  /** 嘴角那点笑 × 多少（没在演时 1）。 */
  readonly smile: number;
  readonly owns: boolean;
}

/** 舞台这一侧（真实现：perform.ts IdleGesturePerformer；假实现：fake.ts FakeIdleGestureStage）。 */
export interface IdleGestureStage {
  /**
   * 一帧。`gesture`：MoodView.idleGesture（只在 look / motion 时机亮着时传，否则 undefined），不合法就当没有；
   * `allowed`：自动头部动作此刻可以动（不可以时平滑让开）。已经开始的样子演完为止，不会被时机结束截断。
   */
  frame(dt: number, gesture: unknown, allowed: boolean): IdleGestureFrame;
  reset(): void;
}

export const IDLE_GESTURE_REST: IdleGestureFrame = Object.freeze({ x: 0, y: 0, z: 0, eyeYaw: 0, eyePitch: 0, smile: 1, owns: false });
