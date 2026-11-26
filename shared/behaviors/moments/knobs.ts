/**
 * 功能：她认出的时刻（I-188：深夜还在用电脑、屏幕上出事了、约好的提醒到点、从全屏程序里出来、今天第一次见、离开座位回来、她困得快睡着）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 这里只管什么时候把哪件事告诉她、多久一次；她怎么反应由她自己定。
 * 读法（shared/behaviors/moments/recognise.ts，每秒本机算一次，不调模型）：本机规则先认出"这是个时刻"，再借现有的主动开口那条路
 * （心情时钟给一次说话机会 → 开场选择 → 内心循环，haiku 结合她的性格、心情和最近聊的决定说不说、怎么说）。所有时刻都过同一套总闸：
 * 互动余额（约定的提醒除外）、说话间隔和每小时次数、你在打字或通话时不插嘴、她睡着不说、主动开口的那道关。
 * 这些都只是试用值，没在真机上看过。
 */

export interface MomentKnobs {
  readonly lateNight: {
    readonly marginMinutes: number; readonly fallbackBedMinute: number; readonly earliestBedMinute: number; readonly latestBedMinute: number;
    readonly lastMinute: number; readonly minNights: number; readonly useNights: number; readonly keepNights: number;
  };
  readonly active: { readonly idleSeconds: number; readonly interactionMinutes: number };
  readonly screen: { readonly youngSeconds: number; readonly stuckSeconds: number; readonly cooldownMinutes: number; readonly perDay: number };
  readonly reminder: { readonly retryMinutes: number; readonly tries: number; readonly lateHours: number; readonly perCharacter: number; readonly whatChars: number };
  readonly fullscreen: { readonly minMinutes: number; readonly cooldownMinutes: number };
  readonly firstToday: { readonly awayHours: number; readonly dayStartMinute: number };
  readonly back: { readonly fromMinutes: number; readonly toMinutes: number; readonly chance: number; readonly cooldownMinutes: number };
  readonly goodnight: { readonly enabled: boolean };
  readonly ask: { readonly windowSeconds: number; readonly retrySeconds: number };
}

export const MOMENT_KNOBS: MomentKnobs = {
  lateNight: {
    // 用户可能怎么说：过了我平时睡觉的点多久，她才关心我一句
    // 怎么调：分钟；越大越晚才说
    marginMinutes: 45,
    // 用户可能怎么说：她还不知道我几点睡的时候，按几点算
    // 怎么调：从午夜算起的分钟，30 = 00:30
    fallbackBedMinute: 30,
    // 用户可能怎么说：学到的睡觉时间最早算到几点
    // 怎么调：从午夜算起的分钟，负数是前一天晚上，-150 = 21:30
    earliestBedMinute: -150,
    // 用户可能怎么说：学到的睡觉时间最晚算到几点
    // 怎么调：从午夜算起的分钟，180 = 03:00
    latestBedMinute: 180,
    // 用户可能怎么说：过了几点就当是早上，不再按深夜关心
    // 怎么调：从午夜算起的分钟，330 = 05:30
    lastMinute: 330,
    // 用户可能怎么说：要看到几个晚上才相信学到的睡觉时间
    minNights: 3,
    // 用户可能怎么说：按最近几个晚上算平常几点睡
    useNights: 14,
    // 用户可能怎么说：最多记几个晚上（只记几点还在用电脑，不记别的）
    keepNights: 21,
  },
  active: {
    // 用户可能怎么说：键鼠多久没动就不算"还在用电脑"
    // 怎么调：秒
    idleSeconds: 120,
    // 用户可能怎么说：和她说过话多久以内也算"还醒着"
    // 怎么调：分钟
    interactionMinutes: 5,
  },
  screen: {
    // 用户可能怎么说：屏幕上的事发生多久以内她还会提
    // 怎么调：秒
    youngSeconds: 90,
    // 用户可能怎么说：屏幕一直在转圈加载多久才算卡住
    // 怎么调：秒
    stuckSeconds: 90,
    // 用户可能怎么说：屏幕上出事她说完一句后，多久才会再为屏幕上的事开口
    // 怎么调：分钟
    cooldownMinutes: 20,
    // 用户可能怎么说：一天最多为屏幕上的事开口几次
    perDay: 6,
  },
  reminder: {
    // 用户可能怎么说：提醒时她没说出来，多久后再试
    // 怎么调：分钟
    retryMinutes: 5,
    // 用户可能怎么说：一个提醒最多试几次
    tries: 3,
    // 用户可能怎么说：我不在时到点的提醒，我多晚回来她还会补上
    // 怎么调：小时
    lateHours: 12,
    // 用户可能怎么说：一个角色最多记几条还没到点的提醒
    perCharacter: 20,
    // 用户可能怎么说：提醒的事最多记几个字
    whatChars: 40,
  },
  fullscreen: {
    // 用户可能怎么说：全屏玩了多久出来她才问一句
    // 怎么调：分钟
    minMinutes: 3,
    // 用户可能怎么说：从全屏出来她问过一次后，多久才会再问
    // 怎么调：分钟
    cooldownMinutes: 30,
  },
  firstToday: {
    // 用户可能怎么说：离开多久再来才算"今天第一次见"
    // 怎么调：小时
    awayHours: 4,
    // 用户可能怎么说：几点以后才算新的一天
    // 怎么调：从午夜算起的分钟，300 = 05:00
    dayStartMinute: 300,
  },
  back: {
    // 用户可能怎么说：离开座位多久回来，才把"你回来了"告诉她
    // 怎么调：分钟；比这短的不看
    fromMinutes: 5,
    // 用户可能怎么说：离开多久以上就交给原来"你回来了"的招呼（今天第一次见另算）
    // 怎么调：分钟
    toMinutes: 30,
    // 用户可能怎么说：我回座位时把这件事告诉她的机会（少一点就调小）
    // 怎么调：0～1
    chance: 0.5,
    // 用户可能怎么说：告诉过她一次"你回来了"后，多久才会再告诉
    // 怎么调：分钟
    cooldownMinutes: 30,
  },
  goodnight: {
    // 用户可能怎么说：她困得快睡着时我还在，要不要把这件事告诉她（她可能说句晚安，也可能不说）
    // 怎么调：true 开、false 关；每晚最多一次
    enabled: true,
  },
  ask: {
    // 用户可能怎么说：认出一个时刻后，最多等多久找机会开口
    // 怎么调：秒；过了就算这次不说
    windowSeconds: 180,
    // 用户可能怎么说：一次没轮到开口，隔多久再试
    // 怎么调：秒
    retrySeconds: 15,
  },
};
