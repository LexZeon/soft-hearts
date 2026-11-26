/**
 * 功能：新聊天——一个角色一段长对话（I-134，docs/claude/2026-11-14-i134-new-chat-plan.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 开着时，她看到的聊天不再是界面送来的最近 24 条，而是软件从本机记录里拼的一段：今天（每天从 dayStartHour 点算起）的全部，
 *    再加今天之前最近 beforeDay 条；跨天或隔了 3 小时以上的地方加【几月几日 几点】；以前漏出草稿的回复不送；
 *    总字数超过 windowMaxChars 时从最早的整条开始丢（electron/brain/long-chat/window.ts）。
 *  - 常驻进程不再按 12 轮换新；每轮私下给她的东西堆到 sessionMaxChars 字就换一个干净的进程，用上面那段重新接上，一句聊天都不丢。
 *  - 换进程前先准备（docs/claude/2026-11-15-prewarm-restart.md）：累计到 sessionMaxChars 的 restartPrepareAt 时，趁她闲着在后台起好新进程、
 *    用一次看不见的请求把开场（角色卡、关系、笔记、档案窗口）的缓存热好，再在她回完一句后换过去，换进程后的第一句就不慢。
 *  - 软件打开、切到另一个角色时也这样热一次（docs/claude/2026-11-23-prewarm-paid.md）：空闲进程起好后发一次看不见的请求（只有开场，不带任何用户的话），
 *    之后她的第一句的开场直接读缓存；同一个角色 5 分钟内最多一次。
 *  - 被拒、而且一个字还没显示：马上用界面那 24 条（不带长窗口和笔记）再答一次；已经显示了字：保留那句，不再补。
 *  - 开关：开发版、源码运行、稳定版和发布版都开（LONG_CHAT_STABLE，2026-11-25 起）；环境变量 SOFT_HEARTS_LONG_CHAT=0 / 1 强制关 / 开。
 * 这些都只是试用值，N（beforeDay）由第 0 步回放量出来后定。
 */

export interface LongChatKnobs {
  /** Resolved for this app run (see resolveLongChatKnobs); false: today's chat, byte for byte. */
  readonly enabled: boolean;
  readonly beforeDay: number;
  readonly dayStartHour: number;
  readonly windowMaxChars: number;
  readonly sessionMaxChars: number;
  /** Prewarm: share of sessionMaxChars at which the replacement is prepared (0 = never: the restart is cold, as before). */
  readonly restartPrepareAt: number;
  /** The paid prewarm step: at least this long (ms) between two warms of one character (the user's usage); 0 = never warm at start and switch. */
  readonly startWarmMinGapMs: number;
}

export const LONG_CHAT_KNOBS: Omit<LongChatKnobs, 'enabled'> = Object.freeze({
  // 用户可能怎么说：她记不住前几天聊的 / 她第一句太慢、老被拒
  // 怎么调：今天之前带多少条原话（今天的全部总是带上）；多了更记得，但首字慢、更容易被拒。第 0 步回放量完再定
  beforeDay: 60,

  // 用户可能怎么说：半夜聊的她当成第二天的了
  // 怎么调：一天从几点算起（本地时间，0～23）；凌晨这几个小时还算前一天晚上
  dayStartHour: 4,

  // 用户可能怎么说：聊了一整天以后她回得越来越慢
  // 怎么调：送给她的原话最多多少字，超了从最早的整条开始丢
  windowMaxChars: 40_000,

  // 用户可能怎么说：聊久了她开始乱、或者回得慢
  // 怎么调：一个常驻进程里累计多少字就换一个干净的进程重新接上（平时的旧做法是 6 万字或 12 轮）
  sessionMaxChars: 120_000,

  // 换进程前多早开始准备：累计到 sessionMaxChars 的几成时，在后台把新进程和开场缓存准备好、等她闲着时换过去（0～1）。
  // 填 0 关掉：到上限才换，换后第一句慢 2～3 秒（旧做法）。开着时每次换进程多一次看不见的请求（约每 12 万字一次）。
  restartPrepareAt: 0.85,

  // 用户可能怎么说：一打开软件或切到这个角色，她的第一句还是慢 / 软件一打开就在花我的 Claude 用量
  // 怎么调：软件打开、切到某个角色时，在后台发一次看不见的请求，把开场的缓存热好，第一句就快；同一个角色两次之间至少隔多少毫秒（默认 5 分钟，保住用量）。填 0 关掉
  startWarmMinGapMs: 300_000,
});

/** The stable channel's value. On since; was off until tried in development. */
export const LONG_CHAT_STABLE = true;

/** The installed channel as electron/desktop-channel.ts names it; null or undefined for a source run. */
export type LongChatChannel = 'stable' | 'development' | null | undefined;

/**
 * Same rule as speak-only (electron/brain/speak-only/rules.ts): the development channel and a source run (not packaged) are on, the
 * stable channel and any other packaged build take LONG_CHAT_STABLE (on since 2026-11-25). SOFT_HEARTS_LONG_CHAT=0 / 1 overrides all of them.
 */
export function longChatEnabled(channel: LongChatChannel, packaged: boolean, env: Record<string, string | undefined> = {}): boolean {
  const forced = env.SOFT_HEARTS_LONG_CHAT;
  if (forced === '0') return false;
  if (forced === '1') return true;
  if (channel === 'development') return true;
  if (channel === 'stable') return LONG_CHAT_STABLE;
  return packaged ? LONG_CHAT_STABLE : true; // a packaged build outside both managed channels (the public release) takes the stable value
}

/** The knobs for this app run. Modules take the result as an option; without one they keep today's behaviour. */
export function resolveLongChatKnobs(channel: LongChatChannel, packaged: boolean, env: Record<string, string | undefined> = {}): LongChatKnobs {
  return Object.freeze({ ...LONG_CHAT_KNOBS, enabled: longChatEnabled(channel, packaged, env) });
}
