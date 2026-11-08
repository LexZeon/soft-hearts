/**
 * I-006 第 1 步 "陪你做事"：她知道你"有没有在操作电脑"，在你专心做事时安静下来做自己的事（方案 docs/claude/2026-11-05-i006-company-plan.md，
 * 记录 docs/claude/2026-11-06-i006-step1.md）。I-020：一个功能一个文件夹，接口写清楚，换实现只换一块。
 *
 * 它知道的只有一个粗数字：距你上次动键盘鼠标过了多少秒，加上锁屏 / 睡眠、她的窗口有没有拿到焦点。不知道按了什么、在哪个窗口、鼠标往哪动。
 * 除"现在是哪一种状态、专注度多少、从几点开始"之外什么都不存：只在内存里，不写盘，不进体验记录、日记和画像。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/user-activity.ts）是唯一的写入方：已有的每秒一拍里读一次空闲秒数，交给 tick()；开关关着时一次都不读，
 *     交一个"读不到"。测试命令（开发者模式）用 pretend()，这时不看真实的操作。
 *  2. 读的一方只拿 view()：无聊节奏（electron/mood.ts rules()，只许放慢）、开口选择（electron/inner-loop/opening-host.ts）、
 *     她自己的生活（electron/companion.ts herLifeTick）、内心循环和每轮聊天的【此刻】那一行。效果的算法在 effects.ts。
 *
 * 假实现在 fake.ts（固定一种状态），守约测试在 tests/user-activity.test.ts：换一种实现，先过那组测试。
 */

/** 在忙 / 歇一下 / 不在 / 说不准（默认；开关关着、读不到、很久没操作但没锁屏都是这一种）。 */
export type UserActivityState = 'busy' | 'pause' | 'away' | 'unknown';

export interface UserActivityView {
  readonly state: UserActivityState;
  /** 专注度 0～1。 */
  readonly focus: number;
  /** 这个状态从什么时候开始（墙上时间，毫秒；说不准时为 0）。 */
  readonly since: number;
  /** 这一段专心做了多少分钟（只在 busy / pause 时有数，其余为 0）。 */
  readonly busyMinutes: number;
  /** 歇一下的来由：停手了一会儿 / 你转过来找她。 */
  readonly cause?: 'idle' | 'came';
  /** 开发者测试命令假装的（I-006 第 2 步：假装的"歇一下"一定让她伸一下，好让你看到；真实的照她自己的机会）。 */
  readonly pretended?: true;
}

/** 一秒一次的读数。`idleSeconds` 为 null（或不是有限的数）= 读不到。 */
export interface UserActivitySample {
  readonly now: number;
  readonly idleSeconds: number | null;
  readonly locked: boolean;
  readonly asleep: boolean;
  /** 她自己的窗口（桌宠或控制窗口）拿着焦点：你在她那里操作，是在"找她"，不算"在忙"。 */
  readonly windowFocused: boolean;
}

export type UserActivityPretend = 'busy' | 'pause';

export interface UserActivityHost {
  /** 交一次读数，返回此刻的状态。 */
  tick(sample: UserActivitySample): UserActivityView;
  /** 此刻的状态（不推进时间；测试假装的状态过期后回到真实的）。 */
  view(now?: number): UserActivityView;
  /** 测试命令：假装一种状态一阵子；null = 取消。假装期间 tick() 不改真实的状态。 */
  pretend(kind: UserActivityPretend | null, now: number): void;
  /** 当前是否在假装（主机据此不去读真实的操作）。 */
  pretending(now: number): boolean;
  /** 忘掉一切（开关关掉时）。 */
  reset(): void;
}

/** 隐私页的开关「知道你是不是在忙」（默认开）。 */
export interface UserActivitySwitchView { enabled: boolean }

/** 没有任何信息时的状态：说不准。 */
export const UNKNOWN_ACTIVITY: UserActivityView = Object.freeze({ state: 'unknown', focus: 0, since: 0, busyMinutes: 0 });
