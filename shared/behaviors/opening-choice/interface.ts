/**
 * #10 她想找你说话时"这次说什么"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 * 方案和用户决定见 docs/claude/2026-11-04-opening-choice-plan.md，做了什么见 docs/claude/2026-11-04-opening-choice.md。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/inner-loop/opening-host.ts 的 OpeningHost，electron/main.ts 心情回调里那一处）是唯一调用"挑"的一方
 *     （OpeningChoiceHost，真实现 choose.ts 的 OpeningChoiceDirector）。一次说话时机来了：
 *       - 睡着时谁都不说（不挑）；她自己提出的纪念邀请先问（不挑）；代办提议 R20（默认关）照旧；
 *       - 深夜"醒着时提醒一次休息"走内心循环原来那条路（不挑）；
 *       - 其余的：主机只看不拿地问一遍此刻有哪些候选（屏幕、一起听只在用户开着对应开关时才有），交给 choose() 挑一件，
 *         挑中的再照它原来的方式去说。挑这一步不截图、不录音、不调模型。
 *       - 备选：挑中的那件做不成，在剩下的里再挑一次；
 *         还不行就这次不说，次数退回（间隔照算）。
 *     小动作时机（look / motion）不经过这里，照旧交给内心循环。
 *  2. 开发者面板（src/ui/inner-loop-panel.ts）只读 InnerLoopView.opening：最近几次挑了什么、为什么。
 *     只在开发者模式发出，只在内存，只有类别和理由的字，不进体验记录和存档。
 *
 * 假实现在 fake.ts，守约测试在 tests/opening-choice.test.ts：换一种实现，先过那组测试。
 */
import type { MoodLabel, MoodTendency } from '../../mood';
import type { OpeningCandidateId, OpeningMoment } from './knobs';

export type { OpeningCandidateId, OpeningMoment } from './knobs';

/** "此刻"：挑的时候只看这些。都是标签和数，不含任何对话、画面或声音内容。 */
export interface OpeningNow {
  /** 此刻真有的候选（"这次不说"一直都有，不在这里）。 */
  readonly available: Readonly<Record<Exclude<OpeningCandidateId, 'quiet'>, boolean>>;
  readonly mood: MoodLabel;
  /** 她这会儿真的够强的那项情绪倾向（shared/mood-tendency.ts）。 */
  readonly tendency: MoodTendency | 'wistful' | null;
  /** 角色卡性格（MoodParameters.weights，1 = 一般）。 */
  readonly personality: Readonly<Record<MoodTendency, number>>;
  /** 此刻的事：正好有一件小需要、闲了很久、深夜、有点困、上次想找你说话以后你还没来过。 */
  readonly moments: readonly OpeningMoment[];
}

/** 一次挑选的结果。 */
export interface OpeningChoice {
  readonly id: OpeningCandidateId;
  readonly label: string;
  /** 从此刻来的真实理由（加上"上次也是它"这类最近挑过的调整）。 */
  readonly why: readonly string[];
  /** 附带：挑之前的分量，"聊刚听完的 2.1 · 这次不说 0.4"。 */
  readonly weights: string;
}

/** 开发者面板的一行"这次挑了什么、为什么"。只有类别和理由的字。 */
export interface OpeningWhy {
  readonly at: number;
  /** 这次时机从哪来：一起听的停顿点，还是闲着时的说话时机。 */
  readonly from: 'pause' | 'idle';
  /** 最后由谁说（候选名、"纪念邀请""提醒休息""睡着了"）。 */
  readonly label: string;
  readonly why: readonly string[];
  /** 挑之前的分量；不挑的路（纪念邀请、提醒休息、睡着了）为空。 */
  readonly weights: string;
}

/** 主机这一侧（真实现：choose.ts OpeningChoiceDirector；假实现：fake.ts FixedOpeningChoice）。 */
export interface OpeningChoiceHost {
  /**
   * 从此刻真有的候选里挑一件；`without` 是这次已经试过、做不成的（备选时）。"这次不说"一直都在，除非它也在 without 里；
   * 一件都没有时返回 null（主机当"这次不说"）。不记账：挑完由主机 settle。
   */
  choose(characterId: string, now: OpeningNow, without?: readonly OpeningCandidateId[]): OpeningChoice | null;
  /** 这次最后真的由它去做了：记进"最近挑过"。 */
  settle(characterId: string, id: OpeningCandidateId, at: number): void;
  /** 上一次最后由谁去做、什么时候（算"上次想找你说话以后你还没来过"用）。 */
  last(characterId: string): { readonly id: OpeningCandidateId; readonly at: number } | null;
  /** 记一行"为什么"（主机只在开发者模式调用）。 */
  note(characterId: string, why: OpeningWhy): void;
  /** 这个角色最近几行，最新的在前。 */
  recent(characterId: string): readonly OpeningWhy[];
}
