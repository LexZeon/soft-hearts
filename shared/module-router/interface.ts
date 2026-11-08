/**
 * I-023 haiku 调度台的接口。
 *
 * 做什么：你每发一条消息，Opus 照常马上回你；同时问 haiku 一次"这句话在叫哪个模块"，结论在 Opus 说完前后到，
 * 由各模块自己决定做不做（猜拳：回复说完后开局）。haiku 知道有哪些模块，靠的是这里的登记：每个模块登记一条
 * "我管什么事、什么话算叫我"（RoutedModule），调度台把所有登记拼成清单交给 haiku（choose.ts 的 routerModuleList）。
 * 新模块接上只要在 modules.ts 的清单里加一条。
 *
 * 谁调用它、怎么调用：
 *  1. electron/main.ts 的聊天入口：每条用户消息（不是"停止朗读"这类本机控制）调一次 ModuleRouter.userTurn(请求号, 原文)。
 *     它马上返回，不等 haiku；haiku 的调用在后台跑，和 Opus 并行，不挡第一个字。
 *  2. 模块（现在只有猜拳，electron/rps/host.ts）：回复说完后用 verdict(请求号, 模块号) 拿结论（最多再等 knobs.graceAfterReplyMs），
 *     做完决定后用 decided(…) 告诉调度台"最后谁说了算"，开发者面板的"为什么"那一行就写这个。
 *  3. 开发者面板（src/ui/MoodPanel.ts）只读 MoodView.moduleRouterWhy：最近几条消息 haiku 判断了什么、用了多久、谁说了算
 *     （只在开发者模式记，只在内存，不写文件，不记原文）。
 *
 * 底线（写死的，不是旋钮）：
 *  - 交给 haiku 的只有这一条用户消息（和发给 Opus 的是同一条）加模块清单，不多给任何资料（不给记忆、画像、屏幕、听到的东西）。
 *  - 新消息来了，旧结论作废（还在跑的那次调用被中止）。haiku 出错、超时、答的不是要求的 JSON：什么都不做，本机规则照旧兜底。
 *  - 隐私类（截屏、带不带听到的原文）不经过这里：那些事 Opus 开口前就要定，照旧本机规则，haiku 不能放行（README 补充原则 I-023）。
 *
 * 假实现在 fake.ts（不问 haiku = 只有本机规则，也就是原来的做法；或者按脚本回答），守约测试在 tests/module-router.test.ts。
 */

/** 一个模块在调度台上的登记：我管什么事、什么话算叫我。 */
export interface RoutedModule {
  /** 编号：小写字母、数字和短横线（haiku 的回答里用它）。 */
  readonly id: string;
  /** 给人看的名字（"猜拳"）。 */
  readonly name: string;
  /** 我管什么事（一句话）。 */
  readonly handles: string;
  /** 什么话算叫我（一两句，可以带几个说法的例子）。 */
  readonly calledWhen: string;
  /** 什么话不算（讲故事、问规则、拒绝……）。 */
  readonly notCalled: string;
  /** 本机粗筛：消息里有这些字，才可能是在叫我（knobs.prefilter 开着时，粗筛一个模块都没命中就不问 haiku）。 */
  readonly hints: RegExp;
  /** 叫到我时 haiku 还要带一个名字（"name"，用户原话里的那个称呼）。没写 = 只回答叫没叫到（昵称模块用，猜拳不用）。 */
  readonly carriesName?: boolean;
  /**
   * 本机规则已经认出来了，就不用为我问 haiku：'called' 叫了（本机快路）、'refused' 本机认出是拒绝（拒绝优先）、null 认不出。
   * 没写 = 本机认不出任何东西。
   */
  local?(text: string): 'called' | 'refused' | null;
}

/** haiku 说这个模块被叫到了，把握多大（0～1）。 */
export interface RouterCall { readonly module: string; readonly confidence: number; /** 只有 carriesName 的模块：haiku 带来的名字（还没校验）。 */ readonly name?: string }

/** 这条消息问没问 haiku；没问时为什么。 */
export type RouterSkip = 'prefilter' | 'local' | 'unavailable' | 'empty' | 'long' | 'quota';

/** haiku 那一次调用的结果。 */
export type RouterAnswerStatus = 'answered' | 'timeout' | 'error' | 'bad-json' | 'superseded';
export interface RouterAnswer {
  readonly status: RouterAnswerStatus;
  /** 只在 answered 时有：被叫到的模块（已经按 knobs.minConfidence 筛过的和没筛的都在，模块自己看 confidence）。 */
  readonly called: readonly RouterCall[];
  /** 从发出消息到有结果用了多久（毫秒）。 */
  readonly ms: number;
}

/**
 * 一个模块拿到的结论。
 *  - called：haiku 说叫到了，把握够（≥ knobs.minConfidence）；
 *  - not-called：haiku 答了，没叫到这个模块，或者把握不够；
 *  - unknown：没问（粗筛没命中、本机已经认出来、Claude 不能用……）、出错、超时、坏 JSON、被新消息作废、回复说完后等不到。
 */
export type RouterVerdict =
  | { readonly kind: 'called'; readonly confidence: number; readonly ms: number; readonly name?: string }
  | { readonly kind: 'not-called'; readonly confidence: number | null; readonly ms: number }
  | { readonly kind: 'unknown'; readonly reason: RouterSkip | Exclude<RouterAnswerStatus, 'answered'> | 'late' | 'other-turn' };

/** 最后谁说了算：本机快路、haiku、本机认出的拒绝、谁都没叫（什么都不做）。 */
export type RouterDecider = 'local' | 'haiku' | 'refusal' | 'nobody';
export interface RouterDecision {
  readonly by: RouterDecider;
  /** 模块做了什么（给人看的短语："开局""推一推，不开局""不开局"）。 */
  readonly action: string;
}

/** 开发者面板的一行：一条消息。只有模块名、结论和耗时，没有原文。 */
export interface ModuleRouterWhy {
  /** 这条消息什么时候发的（墙上时间）。 */
  readonly at: number;
  /** 为哪些模块问了 haiku（模块名）；没问时为空。 */
  readonly asked: readonly string[];
  /** 没问时为什么。 */
  readonly skipped: RouterSkip | null;
  /** 本机规则认出来的（模块名 → 叫了 / 拒绝）。 */
  readonly local: readonly { readonly module: string; readonly kind: 'called' | 'refused' }[];
  /** haiku 的结果；还在等时 status 为 'pending'。没问时为 null。 */
  readonly answer: { readonly status: RouterAnswerStatus | 'pending'; readonly called: readonly { readonly module: string; readonly confidence: number }[]; readonly ms: number | null } | null;
  /** 每个模块最后谁说了算、做了什么。 */
  readonly decisions: readonly { readonly module: string; readonly by: RouterDecider; readonly action: string }[];
}
