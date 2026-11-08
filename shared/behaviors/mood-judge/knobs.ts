/**
 * 功能：心情调整员：haiku 在后台按"此刻"再微调一下她的心情（I-027，2026-11-07 起默认开）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：她身上发生的事（你说的话、摸头、喂食、睡醒、很久没人理……）先照本机规则马上起作用；同时收进一批。
 * 第一件事来了先等 gatherMs，离上一次问 haiku 不够 spacingMs 就接着收；她回你的话说完、Claude 能用、她醒着、桌宠在屏幕上，
 * 才把这一批交给 haiku 看一眼。haiku 只回五个心情数各加减多少（严格 JSON），本机再按下面的上限收一收，
 * 走"她被哄好了"那条路加到现在的数上（不算一次新互动，不重置无聊，不额外做表情）。
 * 安全线不是旋钮，写在 choose.ts：只动五个心情数；格式不对、把握不够、来晚了、换了角色，一律什么都不变；
 * 同一批最多生效一次，不重试；修正是在现在的数上加减，不是改回某个旧值。
 * 这些都只是试用值，没在真机上看过；haiku 的判断合不合理也还没用真的 haiku 试过。
 */
import type { MoodChannel } from '../../mood';

export interface MoodJudgeKnobs {
  readonly gatherMs: number;
  readonly spacingMs: number;
  readonly busyRecheckMs: number;
  readonly timeoutMs: number;
  readonly staleMs: number;
  readonly callsPerDay: number;
  readonly callsPerChat: number;
  readonly callsPerDayMax: number;
  readonly perCall: Readonly<Record<MoodChannel, number>>;
  readonly afterOpus: number;
  readonly totalPerCall: number;
  readonly hourlyNet: number;
  readonly minConfidence: number;
  readonly reversal: { readonly windowMs: number; readonly factor: number };
  readonly maxEvents: number;
  readonly userTextChars: number;
  readonly herLineAnswerMs: number;
  readonly returnAfterMs: number;
  readonly screenHoldMs: number;
  readonly personaChars: number;
  readonly whyKept: number;
}

export const MOOD_JUDGE_KNOBS: MoodJudgeKnobs = Object.freeze<MoodJudgeKnobs>({
  // 用户可能怎么说：她想了想以后的变化来得太慢了／问得太勤了
  // 怎么调：第一件事来了以后先等多少毫秒再问，把挨得近的事收成一批（喂食和认图结果、你的话和她的尾注）
  gatherMs: 30_000,

  // 用户可能怎么说：一天问 haiku 的次数太多了／她的心情跟不上发生的事
  // 怎么调：两次问 haiku 至少隔多少毫秒（隔得越久次数越少，但期待、激活这种几分钟就回落的数就赶不上了）
  spacingMs: 120_000,

  // 用户可能怎么说：她回我话的时候电脑好像卡了一下
  // 怎么调：她正在回你话（或上一次还没答完）时，过多少毫秒再看一次能不能问；她这条回复说完才问，不和第一个字抢
  busyRecheckMs: 5_000,

  // 用户可能怎么说：haiku 卡住了，好久都没结论
  // 怎么调：问出去多少毫秒还没答就放弃这一批（不重试）
  timeoutMs: 60_000,

  // 用户可能怎么说：很久以前的事她现在才"想了想"，接不上
  // 怎么调：一批收完（到了该问的时候）以后，过了多少毫秒还没问出去、或答案还没回来，就整批丢掉
  staleMs: 180_000,

  // 用户可能怎么说：怕它出错把额度刷光／聊得少的一天她也该"想一想"
  // 怎么调：一天问 haiku 的打底次数（本地零点重置，重启不清零）；当天的上限 = 这个数 + 下面的"每聊一句加几次"× 今天和她聊的句数，不超过再下面的"最多"。超了当天只用本机规则。
  callsPerDay: 120,

  // 用户可能怎么说：聊得多的一天傍晚以后她就不"想一想"了／聊得多的时候问得太勤
  // 怎么调：今天和她每聊一句（打字或语音），当天的上限多几次。2 = 聊 50 句的普通一天上限约 220，聊 120 句约 360（模拟的实际用量约 78 和 180）
  callsPerChat: 2,

  // 用户可能怎么说：怕哪天聊得特别多把额度刷光
  // 怎么调：不管聊多少，一天最多问 haiku 多少次
  callsPerDayMax: 800,

  // 用户可能怎么说：她想了想以后变化太大了／几乎看不出变化
  // 怎么调：每次每个数最多加减多少。期待（D）、激活（N）几分钟就回落一半，晚到的修正留不住，所以只给 ±3；haiku 主要调亲近（O）、舒适（E）、压力（C）
  perCall: { D: 3, O: 6, E: 6, N: 3, C: 6 },

  // 用户可能怎么说：我说的话 Opus 已经判断过了，haiku 又改了一遍，改反了
  // 怎么调：这一批里有你说的话、而且 Opus 的尾注已经生效时，每个数最多再修这么多（Opus 先生效，haiku 在旁边看合不合理）
  afterOpus: 3,

  // 用户可能怎么说：她想了想以后整个人都变了
  // 怎么调：一次五个数加减的绝对值合起来最多多少；超了按比例一起缩小
  totalPerCall: 12,

  // 用户可能怎么说：她被 haiku 越调越低（或越高），回不来了
  // 怎么调：一小时内，haiku 对同一个数的修正合起来最多加减多少（越接近满分越难再加，这条照用）
  hourlyNet: 15,

  // 用户可能怎么说：haiku 自己都拿不准还乱改
  // 怎么调：haiku 的把握低于这个数（0～1），整条答案不用
  minConfidence: 0.7,

  // 用户可能怎么说：她的心情被 haiku 来回拉扯
  // 怎么调：windowMs 毫秒内把自己上一次的修正反过来时，幅度乘 factor（0.5 = 减半）
  reversal: { windowMs: 600_000, factor: 0.5 },

  // 用户可能怎么说：事情一多，haiku 看漏了
  // 怎么调：一批最多交给 haiku 看几件事，再多的只说"还有几件小事"（越多每次越费 token）
  maxEvents: 12,

  // 用户可能怎么说：我说了一大段话，haiku 只看到开头
  // 怎么调：你说的话最多交给 haiku 多少个字（和发给 Opus 的是同一句，只截短，不多给）
  userTextChars: 200,

  // 用户可能怎么说：我隔了一会儿才回她，haiku 却当我没理她
  // 怎么调：她主动说了一句以后，多少毫秒内你发了消息就算"你回了"，过了就算"没人回"
  herLineAnswerMs: 600_000,

  // 用户可能怎么说：我只是去倒了杯水，她就当我"回来了"
  // 怎么调：离开多少毫秒以后第一次互动，才算"你回来了"
  returnAfterMs: 1_800_000,

  // 用户可能怎么说：我切了一下窗口，她就以为我换了事做
  // 怎么调：屏幕共享开着时，新的事（写代码、看视频……）要做满多少毫秒才算"你换了在做的事"
  screenHoldMs: 120_000,

  // 用户可能怎么说：haiku 不了解她的性格，调得不像她
  // 怎么调：交给 haiku 的性格摘要最多多少个字（取自角色卡的性格和描述；越长越费 token）
  personaChars: 240,

  // 用户可能怎么说：开发者面板里心情调整员那一行想多看几条
  // 怎么调：开发者面板"心情调整员"那一行最多留几次
  whyKept: 6,
});
