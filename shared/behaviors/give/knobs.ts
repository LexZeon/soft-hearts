/**
 * 功能：她也照顾你（I-086）——递一块点心、把靠垫推到你那边、偶尔留一张她自己的图
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"。方案见
 * docs/claude/2026-11-11-i086-give-and-keep-plan.md，做了什么见 docs/claude/2026-11-11-i086-give-and-keep.md。
 *
 * 东西的清单是数据（GIVE_ITEMS）：加一件新东西只在这里加一行（它在舞台上怎么出现：'hand' 手里递 / 'push' 推过去，
 * 用哪个道具），不需要新的代码路径。
 *
 * 什么时候递不在这里：开口的时机、间隔、每小时上限都还是心情时钟给的那一个（"她想找你说话"的同一份），这里只多一条
 * "一天最多递几次"。这些都只是试用值，没在真机上看过。
 */

/** 舞台上怎么出现：手里递过来，或把东西推到窗口边上。 */
export type GiveStage = 'hand' | 'push';
/** 用哪个道具：程序画的一块小点心、睡觉功能里那只程序画的靠垫，或你喂过她的那张点心图。 */
export type GiveProp = 'snack' | 'pillow';

export interface GiveItemSpec {
  readonly label: { readonly 'zh-CN': string; readonly en: string };
  readonly stage: GiveStage;
  readonly prop: GiveProp;
  /**
   * 这件东西更合适的时候（倍数，1 = 不管）：她自己困（A 高）、深夜、你刚说累、你很久没动、她这会儿调皮（D 高）。
   * pickGiveItem 把此刻成立的那几项乘起来当分量。
   */
  readonly leans: Readonly<Partial<Record<GiveLeanMoment, number>>>;
  /** 可以拿你喂过她的点心图来递（"递点心"就是把那张图递回给你）。 */
  readonly pictures?: boolean;
}

export const GIVE_LEAN_MOMENTS = ['sleepy', 'night', 'tired', 'still', 'playful'] as const;
export type GiveLeanMoment = (typeof GIVE_LEAN_MOMENTS)[number];

export const GIVE_ITEM_IDS = ['snack', 'cushion'] as const;
export type GiveItemId = (typeof GIVE_ITEM_IDS)[number];

export const GIVE_ITEMS: Readonly<Record<GiveItemId, GiveItemSpec>> = Object.freeze({
  // 用户可能怎么说：她老递点心／她都不递点心
  // 怎么调：leans 里的倍数；你熬夜、刚说累的时候更常递靠垫 → cushion 的 night、tired
  snack: { label: { 'zh-CN': '点心', en: 'snack' }, stage: 'hand', prop: 'snack', pictures: true,
    leans: { sleepy: 0.5, night: 0.8, tired: 0.8, still: 1.3, playful: 1.4 } },
  cushion: { label: { 'zh-CN': '靠垫', en: 'cushion' }, stage: 'push', prop: 'pillow',
    leans: { sleepy: 2.2, night: 1.8, tired: 2, still: 1.2, playful: 0.8 } },
});

export const GIVE_KNOBS = Object.freeze({
  // 用户可能怎么说：她一天递得太多了／她很少递
  // 怎么调：一天最多几次（本地日期），两次之间至少隔多久（再加上她自己挑的时机，所以不会准点）
  perDay: 3,
  minGapMs: 75 * 60_000,
  // 用户可能怎么说：她举着点心太久了／我还没看见她就收回去了
  // 怎么调：手伸到位以后等你多久（毫秒），没接就悄悄收回
  offerMs: 15_000,
  /** 主机这边：舞台没回话也最多等这么久（伸手 + 等你 + 收回），之后当作没接。 */
  answerMs: 30_000,
  /** 挑中以后，她那句话最晚多久内说出来，过了这次的打算就作废（不扣次数）。 */
  planMs: 90_000,

  // ---- 想不想递（"她想找你说话"里"递给你点东西"这一项的分量倍数，读激素和心情数值，都相对角色卡基线）
  // 用户可能怎么说：她很黏我的时候也不太递／她心里不安的时候还老递东西
  // 怎么调：O（亲近）、M（想念）每高出基线一档让分量 × 多少；N（紧张）、C（压力）高过 high 以后压到多低
  lean: {
    /** O 的 level 每比 50 高 10，× (1 + oStep)；低于 50 同样往下（最低 floor）。 */
    oStep: 0.12,
    /** M（想念，0–100）每 10，× (1 + mStep)。 */
    mStep: 0.08,
    /** N 或 C 的 level 高过这个值以后开始往下压，到 100 时只剩 calm 倍。 */
    high: 62,
    calm: 0.35,
    /** D 的 level 到这个值以上算"调皮"：递得俏皮些（假装要自己吃又递给你），点心更常见。 */
    playfulD: 62,
    floor: 0.25,
    ceil: 2.5,
  },

  // ---- 你的状态（选递什么）
  moments: {
    /** 她自己困：A（0–1）到这里算困。 */
    sleepyA: 0.55,
    /** 深夜：本地时间在这段里（分钟，跨午夜）。她自己的安静时段里根本不递（内心循环的规矩）。 */
    nightFrom: 22 * 60 + 30,
    nightTo: 5 * 60,
    /** 你很久没动：离上次和她互动或电脑上有动静至少这么久（分钟）。 */
    stillMinutes: 50,
  },

  // ---- 送你一张图：只在特别的时候，一天最多一次
  // 用户可能怎么说：她老送图／她从来不送图
  // 怎么调：perDay；"很晚"从几点算（分钟）；"很想你"是 M 到多少
  picture: {
    perDay: 1,
    lateFrom: 23 * 60 + 30,
    lateTo: 4 * 60,
    missM: 70,
    /** 图的最长边（像素）和 PNG 最多多少字节（再大就缩小一档重画）。 */
    edge: 384,
    maxBytes: 190 * 1024,
  },
});

/** 她每次递东西写回心情的那一个心情小瞬间（shared/foundation/mood-moments.ts 'gave-taken'）。 */
export const GIVE_MOMENT_KIND = 'gave-taken' as const;
