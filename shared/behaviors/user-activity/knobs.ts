/**
 * 功能：你在专心做事时，她安静下来做自己的事（I-006 第 1 步）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - "专注度"是 0～1 的一个数：你一直在动键盘鼠标（每次停顿不到 operatingBelowSec 秒）就往上涨，涨满要 riseMinutes 分钟；
 *    停下来（或在她的窗口里找她）就往回落。到 busyAt 才算"在忙"，掉到 busyLeaveAt 以下才算不忙，所以停 30 秒看资料不会跳出"在忙"。
 *  - "歇一下"：专心够久（专注度到过 pause.needsPeak）以后，你有 pause.fromIdleSec～pause.toIdleSec 秒没动；或者你忙完直接转到她的窗口。
 *    每忙一段只算一次；你一动键盘鼠标，或者过了 pause.endsAfterMinutes 分钟就结束。
 *  - 她怎么变：quiet 是无聊涨得多慢（只许慢、不许快）；herLife.longer 是她每件事做得久多少；
 *    "开口选择"偏向"这次不说"的倍数在 opening-choice 的旋钮里（moments.busy）；她自己的生活里每件事的"你在忙"倍数在 shared/her-life.ts 的表里。
 * 绝不做的事不是旋钮：不评论屏幕、不说"你工作两小时了"、不催休息、不把没操作当离开、不问"你还在吗"、除当前状态外什么都不存。
 * 这些都只是试用值，没在真机上看过。
 */
import type { MoodTendency } from '../../mood';

export interface UserActivityKnobs {
  readonly operatingBelowSec: number;
  readonly riseMinutes: number;
  readonly fallMinutes: number;
  readonly returnFallMinutes: number;
  readonly busyAt: number;
  readonly busyLeaveAt: number;
  readonly tickCapSec: number;
  readonly pretendMinutes: number;
  readonly pause: { readonly needsPeak: number; readonly fromIdleSec: number; readonly toIdleSec: number; readonly endsAfterMinutes: number };
  readonly quiet: { readonly base: number; readonly min: number; readonly max: number; readonly personality: Readonly<Partial<Record<MoodTendency, number>>> };
  readonly herLife: { readonly longer: number };
}

export const USER_ACTIVITY_KNOBS: UserActivityKnobs = Object.freeze<UserActivityKnobs>({
  // 用户可能怎么说：我停一小会儿看资料，她就觉得我不忙了／我明明在打字她却当我没在忙
  // 怎么调：两次操作之间停多少秒以内还算"一直在忙"；越大越不容易跳出"在忙"
  operatingBelowSec: 60,

  // 用户可能怎么说：我才忙了一会儿她就安静了／我忙了很久她还是老来找我
  // 怎么调：连续操作多少分钟专注度涨满；越小她越早安静下来（"在忙"要到 busyAt，默认约 6 分钟）
  riseMinutes: 10,

  // 用户可能怎么说：我歇了好一会儿她还一直很安静／我刚歇一下她就开始闹了
  // 怎么调：不操作时专注度多少分钟落完；越大她安静得越久
  fallMinutes: 8,

  // 用户可能怎么说：我忙完转头找她，她还一副我在忙的样子
  // 怎么调：你在她的窗口里操作（聊天、点她）时，专注度多少分钟落完
  returnFallMinutes: 1,

  // 用户可能怎么说：她多快才发现我在忙
  // 怎么调：专注度到多少算"在忙"（0～1）
  busyAt: 0.6,

  // 用户可能怎么说：她多快才发现我不忙了
  // 怎么调：专注度掉到多少以下才算不忙（要比 busyAt 小）
  busyLeaveAt: 0.3,

  // 用户可能怎么说：电脑睡醒以后她的判断怪怪的
  // 怎么调：两次读数隔得再久，最多按这么多秒算（防止一次睡眠把专注度一下算满或算空）
  tickCapSec: 5,

  // 用户可能怎么说：测试"假装我在忙"持续多久
  // 怎么调：只在开发者模式的测试命令里用
  pretendMinutes: 10,

  // 用户可能怎么说：我忙了很久停一下，她有时候也跟着歇一歇／她在我刚停手时就跟着动
  // 怎么调：needsPeak＝专心到什么程度才算"忙了一段"；fromIdleSec～toIdleSec＝停手多少秒算歇一下；endsAfterMinutes＝最多持续多久
  pause: { needsPeak: 0.95, fromIdleSec: 60, toIdleSec: 180, endsAfterMinutes: 5 },

  // 用户可能怎么说：我专心的时候她还是老来找我／我专心的时候她完全不理我了
  // 怎么调：base＝专注度满了以后，她的无聊涨得只有平时的多少倍（1＝不放慢，越小越安静）；personality＝按角色卡性格加减（黏人加、慢热和随和减）；min、max＝夹在这个范围里（max 小于 1，所以永远是放慢，不会比平时更早开口）
  quiet: { base: 0.45, min: 0.15, max: 0.85, personality: { close: 0.2, playful: 0.05, comfortable: -0.1, cautious: -0.15 } },

  // 用户可能怎么说：我专心的时候她老换来换去／她发呆发得太短
  // 怎么调：你在忙时她每件自己的事比平时久多少（0.8＝久八成；专注度没满时按比例）
  herLife: { longer: 0.8 },
});
