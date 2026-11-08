/**
 * I-010 "互动余额"的接口（I-020：一个功能一个文件夹，接口写清楚，换实现只换一块）。
 * 她主动的多少同时看她的性格和你们最近的互动多少，不再是"每天最多几次"。
 * 方案 docs/claude/2026-11-03-interaction-budget-plan.md，做了什么 docs/claude/2026-11-05-i010-interaction-budget.md。
 *
 * 余额只是"调控"（心情循环第②步，docs/claude/2026-11-03-mood-loop-design.md）：它只能把她已经想做的事往下压、让她这会儿
 * 没余地，不能凭空让她做什么。每个功能照旧按自己的理由（心情、性格、此刻的事）决定想不想做，再问这里"这会儿有没有余地"。
 *
 * 谁调用它、怎么调用：
 *  1. 记分（credit）：主要一处。electron/mood.ts 的 MoodHost 收下一件你真的做了的事（一条消息、一次摸头或捏脸、喂一次点心、
 *     一局猜拳玩完的那个心情事件）时，告诉 electron/companion.ts，由它记一次。另一处：你在她的猜拳邀请上点"来！/下次吧"
 *     （点按钮不经过心情，electron/rps/host.ts respond() 记一次"接住她的话"）。同一件事（同一个编号；摸头按一次接触算）只记一次，
 *     晚到的事按它真正发生的时间衰减后再记，所以永远不会比准时到多。
 *  2. 问余地（room）、花（spend）、退回（refund）：
 *     - 主动开口（electron/inner-loop/opening-host.ts）：一次说话时机来了，先按余额掷一次；没余地就这次不说（次数退回）。
 *       挑中说话的那件（她的小情绪、邀你玩、看一看屏幕、聊刚听完的）花一次；后来没说出口（内心循环选了不说、出错、做不成），退回。
 *     - 她也会需要你（shared/her-needs.ts 的软压低）：余地代替原来"今天已经有过几次"那一项；开始一件小需要时花。
 *     - 猜拳（electron/rps/）：邀请按"上次邀请/玩完以后你们又互动了几次"（againAfter + interactionsSince）代替原来的隔 2 小时、
 *       玩完 1 小时、每天 2 次；她在局里说一句话的机会按余地代替原来"今天说过几句"，说出来时花。
 *     - 一起听（electron/listen-together/）：停顿点那一句由主动开口那一处管，原来"最近 3 小时说过几次"那一项不再压。
 *     - 停停说说 F7（electron/pause-talk/host.ts，开着时）：每条消息问不问 haiku（安静的角色问得少一点）、等你没接时接着说不说。
 *  3. 开发者面板（src/ui/MoodPanel.ts）只读 view()：现在的余额、性格倍数、最近加了什么花了什么。只在开发者模式，只在内存。
 *
 * 只在内存里（不存文件）：重开应用时从"只有保底"开始，和你很久没来时一样安静。
 * 假实现在 fake.ts（永远有余地 = 原来的做法），守约测试在 tests/interaction-budget.test.ts。
 */
import type { MoodTendency } from '../../mood';
import type { BudgetCreditKind, BudgetSpendKind } from './knobs';

export type { BudgetCreditKind, BudgetSpendKind } from './knobs';

/** 这会儿做一件事有没有余地。 */
export interface BudgetRoom {
  /** 0～1：这件事这会儿的机会要乘的数（1 = 完全不压）。 */
  readonly factor: number;
  /** 现在的余额（攒下的 + 保底）。 */
  readonly balance: number;
  /** 这一件这会儿要花多少（已经乘过性格和深夜）。 */
  readonly cost: number;
  /** 强烈的心情越过了软上限。 */
  readonly strong: boolean;
  /** 一句给开发者面板的话："余额 0.6，要 1：这次不说"。 */
  readonly words: string;
}

/** 问余地时的"此刻"（都可以不给）。 */
export interface BudgetAsk {
  /** 她此刻的心情标签（MoodSnapshot.primary）：很想你、很兴奋可以越过软上限。 */
  readonly mood?: string | null;
  /** 或者直接给"有多想"（0～1），两个都给时取大的。 */
  readonly want?: number | null;
}

/** 开发者面板的一行"最近加了什么、花了什么"。 */
export interface BudgetLogEntry {
  readonly at: number;
  readonly kind: BudgetCreditKind | BudgetSpendKind;
  /** 加了（正）或花了（负）多少。 */
  readonly delta: number;
  /** 这一笔后来退回了（没说出口）。 */
  readonly refunded?: boolean;
}

export interface InteractionBudgetView {
  readonly balance: number;
  readonly earned: number;
  readonly floor: number;
  /** 性格倍数（花费 × 这个数）。 */
  readonly scale: number;
  readonly night: boolean;
  /** 最近一小时你们之间记下的互动次数。 */
  readonly lastHour: number;
  /** 最新的在前。 */
  readonly recent: readonly BudgetLogEntry[];
}

/** 主机这一侧（真实现：electron/interaction-budget/host.ts；假实现：fake.ts）。 */
export interface InteractionBudget {
  /** 你真的做了一件事：记一次。同一个编号只记一次；`at` 比现在早时按衰减记。返回这次有没有记。 */
  credit(characterId: string, kind: BudgetCreditKind, id: string, at?: number): boolean;
  /** 这会儿做 `kind` 有没有余地。不改任何东西。 */
  room(characterId: string, kind: BudgetSpendKind, ask?: BudgetAsk): BudgetRoom;
  /** 她真的去做了：花一次。同一个编号只花一次。返回这次有没有花。 */
  spend(characterId: string, kind: BudgetSpendKind, id: string): boolean;
  /** 那一次后来没做成（没说出口）：退回。每一笔只退一次。 */
  refund(characterId: string, id: string): boolean;
  /** `at` 以后（不含）你们之间记下了几次互动。`at` 早于这次开应用时，只数这次开应用以后的（宁可少算）。 */
  interactionsSince(characterId: string, at: number): number;
  /** 上次邀请玩 / 上次玩完以后，要再有几次互动才可能再邀请（按性格）。 */
  againAfter(characterId: string, after: 'invite' | 'game'): number;
  /** 开发者面板。 */
  view(characterId: string): InteractionBudgetView | null;
}

/** 主机每秒从心情那边拿到的"她现在"（角色卡性格和是不是深夜）。 */
export interface BudgetCharacterNow {
  readonly weights: Readonly<Partial<Record<MoodTendency, number>>> | null | undefined;
  readonly night: boolean;
}
