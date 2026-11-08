/**
 * F7 停停说说的接口（b：插话时没说完的话，下一轮当作背景，提不提由她决定）。方案：docs/claude/2026-11-03-speech-rhythm-plan.md 末尾两节。
 *
 * 做什么：你每发一条消息，Opus 照常马上写她的回复；同时（和 I-023 调度台同一个入口、同一个小模型调用口）问 haiku 一次：
 * 按她的性格和此刻的心情，这条回复说到第几句停一停（想一想的小停顿）、要不要说完某一句就停下来把话递给你、等你接。
 * haiku 看不到她的回复（还在写），只知道她是谁、此刻的心情和你刚说的话。它的答案到了，窗口里还没放出去的气泡照着停；
 * 没到（或者出错、超时、答得不对），就照 R27 原来的公式出，和关掉一样。
 *
 * 谁调用它、怎么调用：
 *  1. electron/main.ts 的聊天入口：每条普通的用户消息调一次 PauseTalkHost.userTurn(请求号, 原文, 窗口报来的"上一条说到哪", 角色号)。
 *     它马上返回（返回这一轮要带的背景，或者 null），haiku 在后台起（knobs.startDelayMs 以后），从不挡第一个字。
 *  2. 聊天回调里每段放行的字（和窗口收到的同一段）调 delta(请求号, 字)：只在开关开着时记在内存里，给"没说完的话"用。
 *  3. 窗口（src/ui/reply-presentation.ts）收到 desk:pause-talk 的计划，只对还没放出去的句子生效。
 *  4. 你在她停着（或者气泡还没放完）时发新消息：窗口先停住，把"上一条说到第几个字"随请求报给 host（只是一个数）；
 *     host 用自己记下的原文算出没说出口的那段，截到 knobs.backgroundMaxChars，只放进下一轮的私有上下文一次。
 *
 * 底线（写死的，不是旋钮）：
 *  - 第一句永远不等 haiku：计划最早只能作用在"第 1 句说完以后"。
 *  - 一条回复最多问一次 haiku；新消息来了，旧的调用中止、旧答案作废；取消、出错、换了角色的答案丢掉，从不补用。
 *  - 交给 haiku 的只有：她的性格摘要（角色卡自己的文字）、四个倾向、此刻的心情标签和五个数、困不困、脸红没有、时间，
 *    以及你这条消息（和发给 Opus 的同一条，截短）。不给记忆、画像、屏幕、听到的东西，也不给她的回复。
 *  - 没说出口的话只进下一轮的私有上下文（不进记忆、日记、画像、体验记录、开发者面板），只用一次；她这条回复照旧只归档一次，
 *    这段话不会作为"她说过的话"再写一遍。
 *  - 开关关着：不问 haiku、不发计划、不带背景，气泡和朗读的时间和原来一模一样（tests/f7-pause-talk.test.ts 钉住）。
 *
 * 假实现在 fake.ts，守约测试在 tests/f7-pause-talk.test.ts。
 */
import type { MoodValues } from '../../mood';

/** 一处想一想的小停顿：第 after 句说完以后，多停 ms 毫秒再出下一句（从 1 数）。 */
export interface PauseTalkPause { readonly after: number; readonly ms: number }
/**
 * 递给你、等你接：第 after 句（或者她第一次问你问题的那一句，'question'）说完以后停下来，等你最多 ms 毫秒；
 * 你一直没接，她再接着把留着的话说完。你接了（发了新消息），留着的话就不说了，变成下一轮的背景。
 */
export interface PauseTalkWait { readonly after: number | 'question'; readonly ms: number }
/** haiku 给这一条回复定的节奏（本机已经按旋钮收过一遍）。 */
export interface PauseTalkPlan { readonly pauses: readonly PauseTalkPause[]; readonly wait: PauseTalkWait | null }
/** 发给窗口的：哪条回复 + 计划。 */
export interface PauseTalkCue extends PauseTalkPlan { readonly id: string }
/** 窗口报给 host 的：上一条回复（id）在气泡里放到了第几个字（原文的下标）就被你打断了。只有数，没有字。 */
export interface PauseTalkCut { readonly id: string; readonly shown: number }

/** "此刻"：问 haiku 那一刻的她。都是标签、数和她自己卡上的文字。 */
export interface PauseTalkNow {
  readonly characterId: string;
  /** 性格摘要（角色卡的性格和描述，截到 knobs.personaChars）。 */
  readonly persona: string;
  /** 角色卡的四个倾向（1 = 一般）。 */
  readonly personality: Readonly<Record<'playful' | 'close' | 'comfortable' | 'cautious', number>>;
  /** 心情标签的中文（"开心"）。 */
  readonly label: string;
  readonly values: MoodValues;
  /** 困不困（"清醒""犯困"……）。 */
  readonly fatigue: string;
  /** 正在脸红。 */
  readonly shy: boolean;
  /** 本地时间（墙上毫秒）。 */
  readonly at: number;
}

/** 和 electron/inner-loop/model.ts quickLineWithClaude 的文字结果同样的形状：提示词、系统提示词、中止信号 → haiku 的原文。 */
export type PauseTalkAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;

/** 这条消息没问 haiku 时为什么。'budget'：互动余额（I-010）这次没给余地（安静的角色不是每条都问）。 */
export type PauseTalkSkip = 'unavailable' | 'quota' | 'no-character' | 'budget';
/** haiku 那一次的结果。'cancelled'：回复被取消或出错；'character'：答案到的时候已经换了角色。 */
export type PauseTalkStatus = 'pending' | 'answered' | 'bad-json' | 'timeout' | 'error' | 'superseded' | 'cancelled' | 'character';

/** 开发者面板的一行：一条回复的节奏。只有时间、状态和计划的数，没有原文。 */
export interface PauseTalkWhy {
  /** 这条消息什么时候发的（墙上时间）。 */
  readonly at: number;
  readonly skipped: PauseTalkSkip | null;
  readonly status: PauseTalkStatus | null;
  /** 从发出消息到 haiku 有结果用了多久。 */
  readonly ms: number | null;
  readonly plan: PauseTalkPlan | null;
  /** 这一轮带了"上一条没说完的话"（只记带没带和多少字，不记字）。 */
  readonly carried: number;
  /** haiku 要她停下来等你，但互动余额（I-010）不够她"等你没接再接着说"，这条就没停下来等（只在这种时候有）。 */
  readonly waitDropped?: true;
}
/** 一条回复的首字：从你发出到第一个字画在气泡上（毫秒），那时停停说说开没开、这一轮带没带背景。只有数。 */
export interface PauseTalkFirstChar { readonly at: number; readonly ms: number; readonly on: boolean; readonly carried: boolean }
/** 开发者面板看到的（只在开发者模式，只在内存）。 */
export interface PauseTalkView {
  readonly enabled: boolean;
  readonly why: readonly PauseTalkWhy[];
  readonly firstChar: readonly PauseTalkFirstChar[];
}
