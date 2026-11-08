/**
 * 功能：停停说说：haiku 按她的性格和心情决定说到哪停、停多久、要不要停下来等你（F7，默认关）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：开关（设置 → 连接与声音 → 声音 →「停停说说」）开着时，你每发一条消息，Opus 照常写她的回复，同时问 haiku 一次。
 * haiku 只回一个小计划（第几句后停多久、第几句后等你多久）；本机按下面的范围收一收，交给窗口。
 * 第一句永远马上出来；计划到得晚，已经放出去的句子不补停，没到就照 R27 原来的公式出。
 * 你在她停着时插话，没说出口的那段截短后放进下一轮的私有上下文一次，提不提由她决定。
 * 这些都只是试用值，没在真机上看过；haiku 的判断合不合理、实际多久能答，也还没用真的 haiku 试过。
 */

export interface PauseTalkKnobs {
  readonly startDelayMs: number;
  readonly timeoutMs: number;
  readonly pauseMinMs: number;
  readonly pauseMaxMs: number;
  readonly maxPauses: number;
  readonly waitMinMs: number;
  readonly waitMaxMs: number;
  readonly maxAfter: number;
  readonly typingRecheckMs: number;
  readonly typingMaxMs: number;
  readonly backgroundMaxChars: number;
  readonly userChars: number;
  readonly personaChars: number;
  readonly callsPerDay: number;
  readonly whyKept: number;
}

export const PAUSE_TALK_KNOBS: PauseTalkKnobs = Object.freeze<PauseTalkKnobs>({
  // 用户可能怎么说：开了停停说说以后，发消息她第一个字好像慢了
  // 怎么调：你发出消息后，等多少毫秒再起 haiku 的进程（和调度台一样：起进程占主线程约 20 毫秒，晚一点起，Opus 那一轮先写出去）；太大则 haiku 更常来不及
  startDelayMs: 300,

  // 用户可能怎么说：haiku 卡住了，她的节奏一直是老样子
  // 怎么调：从你发出消息算起，haiku 多少毫秒还没答就放弃这一次（之后的气泡照 R27 原来的公式出）
  timeoutMs: 12_000,

  // 用户可能怎么说：她停一下的时候太短了，看不出来在想
  // 怎么调：一处小停顿最短多少毫秒；haiku 给得比这还短就当没停
  pauseMinMs: 300,

  // 用户可能怎么说：她停一下停得太久了，像卡住了
  // 怎么调：一处小停顿最长多少毫秒；haiku 给得更长就按这个算
  pauseMaxMs: 2_500,

  // 用户可能怎么说：她一条回复里停得太多了，说一句停一句
  // 怎么调：一条回复最多几处小停顿（多出来的不用）
  maxPauses: 3,

  // 用户可能怎么说：她停下来等我，没等一会儿就又自己说下去了
  // 怎么调：停下来等你，最少等多少毫秒
  waitMinMs: 3_000,

  // 用户可能怎么说：她停下来等我太久了，后面的话半天不出来
  // 怎么调：停下来等你，最多等多少毫秒；过了还没人接，她就把留着的话接着说完
  waitMaxMs: 20_000,

  // 用户可能怎么说：（一般不用改）
  // 怎么调：haiku 最多能说"第几句"以后停；更大的数当答得不对
  maxAfter: 12,

  // 用户可能怎么说：我正在打字回她，她却自己接着说下去了
  // 怎么调：她等你接话时，等完发现你输入框里有字，再隔多少毫秒看一次
  typingRecheckMs: 1_500,

  // 用户可能怎么说：我输入框里留着字，她就一直不往下说
  // 怎么调：因为你在打字而多等的时间，最多加多少毫秒
  typingMaxMs: 30_000,

  // 用户可能怎么说：我打断她以后，她下一句老是提上一条没说完的话／提得太长
  // 怎么调：没说出口的那段，最多带多少个字进下一轮的背景（多的截掉，加"……"）
  backgroundMaxChars: 120,

  // 用户可能怎么说：（一般不用改）
  // 怎么调：你这条消息最多给 haiku 看多少个字
  userChars: 200,

  // 用户可能怎么说：（一般不用改）
  // 怎么调：她的性格摘要（角色卡的性格和描述）最多给 haiku 看多少个字
  personaChars: 200,

  // 用户可能怎么说：怕它出错把额度刷光
  // 怎么调：一天最多问 haiku 多少次（只在内存里数，重启从 0 数）；平时每条回复一次，普通的一天 30～80 次，只防出错时刷额度
  callsPerDay: 300,

  // 用户可能怎么说：开发者面板里停停说说那一行想多看几条
  // 怎么调：开发者面板最多留几条回复的节奏
  whyKept: 5,
});
