/**
 * 功能：她自己留的心（闹钟）（I-195：她在回复里写一个看不见的记号，给自己留个"到点或某件事发生时想起来"的备注）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 到点只是把"你之前给自己留了个心"这个信息告诉她（走 I-188 的时刻那条路，同一套总闸）；说不说、怎么说由她自己定。这些只是试用值，没在真机上看过。
 */

export interface AlarmKnobs {
  readonly perCharacter: number;
  readonly minMinutes: number;
  readonly maxDays: number;
  readonly eventExpiryDays: number;
  readonly lateHours: number;
  readonly noteChars: number;
  readonly talkChars: number;
  readonly sittingMinutes: number;
  readonly markersPerReply: number;
  readonly defaultHour: number;
}

export const ALARM_KNOBS: AlarmKnobs = {
  // 用户可能怎么说：她同时最多给自己留几个心
  perCharacter: 5,
  // 用户可能怎么说：她定的时间闹钟最短隔多久（太近的当作写错，不记）
  // 怎么调：分钟
  minMinutes: 10,
  // 用户可能怎么说：她定的按日期的闹钟最远能定到多久以后
  // 怎么调：天
  maxDays: 30,
  // 用户可能怎么说：等某件事（或等我说到某个词）的留心，多久没等到就不要了
  // 怎么调：天；从可以开始等的时候算起
  eventExpiryDays: 3,
  // 用户可能怎么说：我不在时到点的闹钟，我多晚回来她还会补上
  // 怎么调：小时；比提醒（12 小时）短，因为是她自己的小事
  lateHours: 3,
  // 用户可能怎么说：她给自己留的备注最多几个字
  noteChars: 60,
  // 用户可能怎么说：她等我说到的那个词最多几个字
  talkChars: 12,
  // 用户可能怎么说：我连续用电脑多久，算"坐太久"这件事发生了
  // 怎么调：分钟；中间歇不到 5 分钟不算断
  sittingMinutes: 120,
  // 用户可能怎么说：她一条回复里最多留几个心
  markersPerReply: 2,
  // 用户可能怎么说：她只定了哪一天、没写几点时，按几点
  // 怎么调：小时，0～23
  defaultHour: 9,
};
