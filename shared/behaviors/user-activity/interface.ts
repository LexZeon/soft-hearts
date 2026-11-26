/**
 * I-006 第 1 步 "陪你做事"：她知道你"有没有在操作电脑"，在你专心做事时安静下来做自己的事（方案 docs/claude/2026-11-05-i006-company-plan.md，
 * 记录 docs/claude/2026-11-06-i006-step1.md）。I-020：一个功能一个文件夹，接口写清楚，换实现只换一块。
 *
 * 它知道的只有一个粗数字：距你上次动键盘鼠标过了多少秒，加上锁屏 / 睡眠、她的窗口有没有拿到焦点。不知道按了什么、在哪个窗口、鼠标往哪动。
 * 除"现在是哪一种状态、专注度多少、从几点开始"之外什么都不存：只在内存里，不写盘，不进体验记录、日记和画像。
 *
 * 谁调用它、怎么调用：
 *  1. 主机（electron/senses/user-activity.ts）是唯一的写入方：已有的每秒一拍里读一次空闲秒数，交给 tick()；开关关着时一次都不读，
 *     交一个"读不到"。测试命令（开发者模式）用 pretend()，这时不看真实的操作。
 *  2. 读的一方只拿 view()：无聊节奏（electron/mood/mood.ts rules()，只许放慢）、开口选择（electron/brain/opening-host.ts）、
 *     她自己的生活（electron/brain/companion.ts herLifeTick）、内心循环和每轮聊天的【此刻】那一行。效果的算法在 effects.ts。
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

/**
 * 隐私页的开关「知道你是不是在忙」（默认开）。`away` (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md): while the switch is on, the
 * user has not touched the keyboard or mouse for STAGE_AWAY_IDLE_SECONDS, or the screen is locked, or the computer sleeps; the companion window's
 * stage then draws at its away pace (src/stage/stage-pace.ts, 24 fps). Present only while true; nothing else is said about the user.
 */
export interface UserActivitySwitchView { enabled: boolean; away?: true }
/** Plan section 4 (docs/claude/2026-11-16-wiring-rewrite-plan.md): the stage's "不在" after this long without keyboard or mouse input. */
export const STAGE_AWAY_IDLE_SECONDS = 120;

/** 没有任何信息时的状态：说不准。 */
export const UNKNOWN_ACTIVITY: UserActivityView = Object.freeze({ state: 'unknown', focus: 0, since: 0, busyMinutes: 0 });

/*
 * I-066 你现在方便吗 (plan docs/claude/2026-11-10-proactive-presence-plan.md, record docs/claude/2026-11-10-i066-presence.md): one shared
 * judgment every feature that may interrupt the user asks first. It builds on the readings above (idle seconds, lock, sleep, busy) and
 * adds two optional, opt-in sources: one haiku look at the shared screen when the input alone cannot tell, and the local camera's
 * "somebody is in front". The logic is presence.ts; the thresholds are knobs.ts `presence`. The state above (busy / pause / away /
 * unknown) stays as it was for its readers.
 */

/** 闲着 / 在忙 / 开会 / 刚回来 / 不在 / 说不准. */
export type Presence = 'idle' | 'busy' | 'meeting' | 'back' | 'away' | 'unknown';
/** 可以 / 只能轻轻的 / 不行. "no" only for a meeting or call, a locked or asleep computer, the user away (or not known to be there). */
export type Interrupt = 'yes' | 'gently' | 'no';
/** Where the judgment came from: the keyboard and mouse (or her own interactions), the screen look, the local camera. */
export type PresenceSource = 'input' | 'screen' | 'camera';

/** The one closed answer of a screen look. Never a description. */
export const SCREEN_LOOKS = ['meeting', 'watching', 'gaming', 'working', 'browsing', 'desktop', 'unknown'] as const;
export type ScreenLook = typeof SCREEN_LOOKS[number];

/** Why "no", closed: for the journal and the developer "why". */
export const PRESENCE_WHYS = ['locked', 'idle-long', 'meeting', 'desktop', 'look-unknown', 'looking', 'nobody', 'not-known'] as const;
export type PresenceWhy = typeof PRESENCE_WHYS[number];

export interface PresenceView {
  readonly presence: Presence;
  readonly interrupt: Interrupt;
  readonly source: PresenceSource;
  /** Only when interrupt is 'no'. */
  readonly why?: PresenceWhy;
  /** 'back' only: how long the user was away (whole minutes). */
  readonly awayMinutes?: number;
  /** The input alone cannot tell and a screen look could (sharing on, within the hourly count, nothing cached): ask for one. */
  readonly lookWanted?: true;
  /** A developer test command pretends this. */
  readonly pretended?: true;
}

/** 测试：假装我不在 / 回来了 / 在开会. */
export type PresencePretend = 'away' | 'back' | 'meeting';

/** What the judgment reads besides the one-second sample. */
export interface PresenceContext {
  /** The 「知道你是不是在忙」 switch is on (and known). Off: only her recent interactions count. */
  readonly switchOn: boolean;
  /** The user's last interaction with her (chat, touch), wall-clock ms, or null. */
  readonly lastInteractionAt: number | null;
  /** The existing tracker's state (busy → gently). */
  readonly activity: Pick<UserActivityView, 'state'> | null;
  /** The local camera (P1, only while its sensing runs): somebody in front (true), nobody (false), not known (null / absent). */
  readonly person?: boolean | null;
  /** A screen look is possible now: the user's screen sharing is on (and not refused). */
  readonly screenOn?: boolean;
}

/** Nothing known: she does not start talking. */
export const NOT_PRESENT: PresenceView = Object.freeze({ presence: 'unknown', interrupt: 'no', source: 'input', why: 'not-known' });
