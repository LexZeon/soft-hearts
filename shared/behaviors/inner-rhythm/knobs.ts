/**
 * 功能：她自己想事情（内心循环）的节奏：忽长忽短，深夜和你不在时拉长（I-013 少一点程序感，L1）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 她"问一次小模型、想一想要不要动一下"之间，原来至少隔 2 × 角色卡的"动一下间隔"，实测 49 次里有 36 次正好 12.0 分钟，
 *    你睡觉的 8 小时里还问了 35 次。现在这段最短间隔 = 卡上的 2 × 间隔 ×【这一次的随机倍数】×【深夜倍数】×【你不在倍数】，三个倍数都 ≥ 1：
 *    永远不会比原来的最短间隔更早，只会更晚，所以不会多问。
 *  - 随机倍数：每问完一次，抽下一次的倍数，范围 1 ～ 1 + spread；偏向短的一边（shape 越大越偏），性格偏爱玩（playful 权重大）的卡 spread 更小，
 *    偏安静、谨慎的卡更大；和上一次抽的太接近就换一个远一点的（不是每次都一个样）。
 *  - 深夜倍数：她处在"深夜"（角色卡的作息算出来的那一段，默认约 22:26～07:34）× night，只是"有点困"× drowsy。睡着时本来就不问。
 *  - 你不在倍数：你上次和她互动（聊天、摸、喂）到现在越久越大：不到 awayFromMinutes 分钟 × 1，之后每多 awayRampMinutes 分钟多一倍，最多 awayMax；
 *    系统读到你人不在（锁屏、很久没动键盘鼠标）时至少 × awayState。深夜 × 不在 叠加，所以你睡觉的八小时只剩寥寥几次。
 *  - 「她主动找你说话」设置（少一点 / 适中 / 多一点）：在上面三个倍数的乘积上再乘 talkLess / 1 / talkMore，
 *    再夹回 ≥ 1。适中 = 1，和没有这个设置时一模一样；多一点最多只能把倍数压回 1（也就是原来的最短间隔 2 × 动一下间隔），不会比原来更密；
 *    少一点除了拉长"动一下、看一眼"，也让她想说话的那些次隔得更开。她每小时最多说几次、两次之间至少隔多久、深夜安静，仍然只归卡上的上限管，这里不碰。
 *  - 不变的：深夜还醒着时"提醒你休息一次"照旧（不受这些倍数影响）；她能说话的白天、你刚理过她的时候不受影响；
 *    只对"没有话可说"的那些次（动一下、看一眼、深夜安静时的小心情）起作用，不会让她少说该说的话。
 * 这些都只是试用值，没在真机上看过。
 */

/** 设置里「她主动找你说话」的三档；缺省、认不出的值都当作 'normal'。 */
export type ProactiveTalk = 'less' | 'normal' | 'more';
export const PROACTIVE_TALK_VALUES: readonly ProactiveTalk[] = Object.freeze(['less', 'normal', 'more'] as const);
export function proactiveTalk(value: unknown): ProactiveTalk { return value === 'less' || value === 'more' ? value : 'normal'; }

export interface InnerRhythmKnobs {
  readonly spread: number;
  readonly shape: number;
  readonly spreadByPlayful: readonly [number, number];
  readonly differentBy: number;
  readonly night: number;
  readonly drowsy: number;
  readonly awayFromMinutes: number;
  readonly awayRampMinutes: number;
  readonly awayMax: number;
  readonly awayState: number;
  readonly talkLess: number;
  readonly talkMore: number;
}

export const INNER_RHYTHM_KNOBS: InnerRhythmKnobs = Object.freeze<InnerRhythmKnobs>({
  // 用户可能怎么说：她隔多久想一次太有规律／她想事情的节奏忽快忽慢太乱了
  // 怎么调：随机倍数最多再长多少（1.1 = 最长是原来最短间隔的约 2 倍；0 = 不随机，回到每次一样）
  spread: 1.1,

  // 用户可能怎么说：她总是隔很久才想一次／总是隔差不多的时间
  // 怎么调：越大越偏向短的一边（1 = 平均；2 = 多数接近原来的最短间隔，偶尔隔很久）
  shape: 1.5,

  // 用户可能怎么说：爱玩的她应该更勤快／安静的她应该更慢
  // 怎么调：spread 再 ÷ playful 权重，夹在这两个数之间（第一个数越小，爱玩的卡越勤快）
  spreadByPlayful: [0.7, 1.5],

  // 用户可能怎么说：她这次和上次想事情的间隔怎么又一样
  // 怎么调：新抽的倍数和上一次差得不到这个比例（占 spread），就再抽一次取离上次更远的
  differentBy: 0.15,

  // 用户可能怎么说：我睡觉的时候她还一直在想事情／深夜她太安静了
  // 怎么调：深夜（她的作息算出的那一段）里最短间隔 × 几；1 = 不拉长
  night: 3,

  // 用户可能怎么说：她一犯困就该安静下来
  // 怎么调：只是"有点困"（还没到深夜）时 × 几
  drowsy: 1.8,

  // 用户可能怎么说：我出去半天了她还在隔十几分钟想一次
  // 怎么调：你离开多少分钟之后才开始拉长
  awayFromMinutes: 45,

  // 用户可能怎么说：我走了之后她安静得太快／太慢
  // 怎么调：过了上面那个时间，每多这么多分钟，倍数多 1
  awayRampMinutes: 90,

  // 用户可能怎么说：我一整天不在，她还是隔挺久就问一次
  // 怎么调：你不在时倍数的上限
  awayMax: 3,

  // 用户可能怎么说：我锁屏离开了她还在想事情
  // 怎么调：系统读到你人不在（锁屏、很久没碰键盘鼠标）时，不在倍数至少是几
  awayState: 2.5,

  // 用户可能怎么说：你少说点话吧／她太安静了，多找我聊聊
  // 怎么调：设置选「少一点」时，最短间隔再 × 几（2 = 约一半的次数）
  talkLess: 2,

  // 用户可能怎么说：她能不能多找我说说话
  // 怎么调：设置选「多一点」时，最短间隔 × 几（0.6 = 更勤快；结果最低夹回原来的最短间隔，所以只会压掉随机拉长和深夜/不在的那部分）
  talkMore: 0.6,
});
