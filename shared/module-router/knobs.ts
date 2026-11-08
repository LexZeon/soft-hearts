/**
 * 功能：haiku 调度台：你这句话是不是在叫某个模块（I-023，现在只登记了猜拳）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：你每发一条消息，先看本机规则（每个模块自己的词表）认不认得出；认不出、而且粗筛命中了某个模块的字，
 * 才和 Opus 同时问一次 haiku。回复说完后，模块拿 haiku 的结论决定做不做。
 * 模块清单在 modules.ts（每个模块登记一条"我管什么、什么话算叫我"），不是旋钮。
 * 这些都只是试用值，没在真机上看过。
 */

export interface ModuleRouterKnobs {
  readonly prefilter: boolean;
  readonly minConfidence: number;
  readonly graceAfterReplyMs: number;
  readonly startDelayMs: number;
  readonly timeoutMs: number;
  readonly maxChars: number;
  readonly callsPerDay: number;
  readonly whyKept: number;
}

export const MODULE_ROUTER_KNOBS: ModuleRouterKnobs = Object.freeze<ModuleRouterKnobs>({
  // 用户可能怎么说：我换了个说法叫她玩，她没反应／额度用得太多了
  // 怎么调：true = 消息里有某个模块登记的那些字（猜拳：猜拳、石头、剪刀、布、拳、比划、玩一把……）才问 haiku，省额度，但完全不带这些字的说法会漏；false = 每条消息都问（每天多 30～80 次 haiku）
  prefilter: true,

  // 用户可能怎么说：我随口提一句石头，她就开局了／我明明在叫她玩，她没开局
  // 怎么调：haiku 的把握至少多少才算叫到（0～1）；调高更少误开局，调低更少漏
  minConfidence: 0.7,

  // 用户可能怎么说：回复说完好一会儿才开局／haiku 慢了一点就不开局了
  // 怎么调：她的回复说完后，最多再等 haiku 多少毫秒；等不到就当没叫（本机规则照旧）
  graceAfterReplyMs: 2500,

  // 用户可能怎么说：发消息以后她第一个字好像慢了一点
  // 怎么调：你发出消息后，等多少毫秒再起 haiku 的进程。起进程会占住主线程约 20 毫秒（2026-11-04 本机实测中位 20.7，最多约 60），晚一点起，Opus 那一轮先写出去，第一个字不受影响；太大则回复说完时 haiku 还没答完
  startDelayMs: 300,

  // 用户可能怎么说：haiku 卡住了，好久都没结论
  // 怎么调：从你发出消息算起，haiku 多少毫秒还没答就放弃这一次
  timeoutMs: 12_000,

  // 用户可能怎么说：我说了一大段话，中间说要玩猜拳，她没开局
  // 怎么调：消息超过这么多字就不问（长消息几乎不会是在叫她玩）
  maxChars: 200,

  // 用户可能怎么说：怕它出错把额度刷光
  // 怎么调：一天最多问 haiku 多少次（只在内存里数，重启从 0 数）；只防出错时刷额度，正常用远到不了
  callsPerDay: 150,

  // 用户可能怎么说：开发者面板里调度台那一行想多看几条
  // 怎么调：开发者面板"调度台"那一行最多留几条消息
  whyKept: 5,
});
