/**
 * 功能：最近聊得多，她主动开口的上限跟着提高（I-039）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 数的是过去 windowMinutes 分钟里你发给她的消息条数（打字、语音都算；摸头、喂食、玩游戏不算），只记时刻、不记内容，只在内存里（重启后从零数）。
 *  - 三档：条数少于 busyAt 条按卡上的值；busyAt 条以上，两次主动开口的最短间隔 × busyInterval、每小时上限 + busyExtra；
 *    veryBusyAt 条以上用 veryBusyInterval、veryBusyExtra。消息过了窗口就不算，所以停聊以后慢慢回到卡上的值。
 *  - 不设下限和上限：间隔就是卡上的值乘倍数，每小时就是卡上的值加几句。
 *  - 性格：黏人的多加、克制的少加。倍数的"缩短部分"和"加几句"都 × 性格系数（黏人 / 克制来自角色卡推出的倾向，没读用户在角色页拖过的滑块）。
 *  - 同时把"没回应只说 1 句"的硬停改成"大幅降低接着说的欲望"：没回应的句数达到卡上的 speechWithoutReply 以后不再拒绝，
 *    而是把下一次主动开口的间隔 × unansweredFactor，每多一句没回应再乘一次，但拉长后的间隔最多 unansweredCapMinutes 分钟（用户同日补充：封顶 90 分钟；卡自己的间隔更长就用卡的）
 *    （先算上面的热聊放宽，再乘这个再封顶）；你一回应就恢复。
 *    另外她自己也会在内心循环的提示里读到"已经说了 N 句你都没回"，多半选择安静（只是一句事实和倾向，不是"必须不说"）。
 *    这是兜底：不靠写死的次数，靠大倍数加她自己的意愿，保证不追着你说话（原则 6 不施压）。
 *  - 不变的：深夜安静、睡着不说话、每晚一次休息提醒；设置「她主动找你说话：少一点」时热聊完全不加。
 * 这些都只是试用值，没在真机上看过。
 */
export interface BusyChatKnobs {
  readonly windowMinutes: number;
  readonly busyAt: number;
  readonly veryBusyAt: number;
  readonly busyInterval: number;
  readonly veryBusyInterval: number;
  readonly busyExtra: number;
  readonly veryBusyExtra: number;
  readonly clingyWeight: number;
  readonly restrainedWeight: number;
  readonly scaleRange: readonly [number, number];
  readonly unansweredFactor: number;
  readonly unansweredCapMinutes: number;
}

export const BUSY_CHAT_KNOBS: BusyChatKnobs = Object.freeze<BusyChatKnobs>({
  // 用户可能怎么说：我刚才聊了半天她怎么还是那么安静／聊完很久她还是话多
  // 怎么调：只数最近多少分钟里你发的消息（越长，聊完以后"热乎劲"退得越慢）
  windowMinutes: 60,

  // 用户可能怎么说：我才聊了几句就开始变话多／聊了好多她还是老样子
  // 怎么调：最近这么多条消息起算"聊得多"
  busyAt: 3,

  // 用户可能怎么说：聊得特别热的时候她还可以更主动
  // 怎么调：最近这么多条消息起算"聊得很热"
  veryBusyAt: 10,

  // 用户可能怎么说：聊得多时她两次主动开口隔得还是太久
  // 怎么调：两次主动开口的最短间隔 × 几（0.75 = 缩短四分之一；1 = 不缩）
  busyInterval: 0.75,

  // 用户可能怎么说：聊得特别热时她还是隔很久才主动说一句
  // 怎么调：同上，聊得很热那一档（0.5 = 缩短一半）
  veryBusyInterval: 0.5,

  // 用户可能怎么说：聊得多时她一小时还是说得太少
  // 怎么调：每小时主动开口上限加几句
  busyExtra: 1,

  // 用户可能怎么说：聊得特别热时一小时还能多说几句
  // 怎么调：同上，聊得很热那一档
  veryBusyExtra: 2,

  // 用户可能怎么说：黏人的她聊得多时应该更主动
  // 怎么调：黏人倾向每高 50 点，系数多几（0.6 = 倾向 100 时系数 1.6）
  clingyWeight: 0.6,

  // 用户可能怎么说：克制的她聊得多也不该一下子话多
  // 怎么调：克制倾向每高 50 点，系数少几
  restrainedWeight: 0.4,

  // 用户可能怎么说：性格对话多话少的影响太大／太小
  // 怎么调：性格系数最低、最高各是几（1 = 不受性格影响）
  scaleRange: [0.4, 1.6],

  // 用户可能怎么说：我没回她，她还是隔不久就又来一句／我没回她，她就彻底不说了
  // 怎么调：你一直没回应时，她下一次主动开口的最短间隔 × 几（3 = 30 分钟变 90 分钟；你还没回、她又说了一句就再 × 一次：270 分钟）。1 = 不拉长；你一回应就恢复。热聊放宽先算，这个倍数乘在后面
  unansweredFactor: 3,

  // 用户可能怎么说：我一直不回，她隔太久才又来一句／我没回她，她还是隔不久就来
  // 怎么调：你一直没回应时，拉长后的间隔最多这么多分钟（默认 90：30 分钟的卡没回应 1 句后 90 分钟，之后再不回也是 90）。卡自己的间隔已经更长就用卡的，不会因为封顶变短
  unansweredCapMinutes: 90,
});
