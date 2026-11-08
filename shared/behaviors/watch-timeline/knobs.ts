/**
 * 功能：陪看时间线：听到什么、看到什么、按时间排好（I-048）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 四部分：
 *  - timeline：内存里的时间线留多久、交给她的那一块多大。
 *  - haiku：陪看时 haiku 的活（描述画面、压摘要）最多做多少、隔多久。
 *  - frame：画面变化到什么程度才值得描述。
 *  - notes：看剧笔记和截图放在硬盘上的规矩。
 * 这些都只是试用值，没在真机上看过。
 */

export interface WatchTimelineKnobs {
  readonly timeline: {
    readonly windowMinutes: number;
    readonly recentSeconds: number;
    readonly blockChars: number;
    readonly entryChars: number;
    readonly pendingSeconds: number;
    readonly compactAfterSeconds: number;
    readonly compactMinEntries: number;
  };
  readonly haiku: {
    readonly framesPerHour: number;
    readonly summaryGapMinutes: number;
    readonly queuedFrames: number;
    readonly parallel: number;
  };
  readonly frame: {
    readonly pixelDelta: number;
    readonly changedShare: number;
    readonly minGapSeconds: number;
    readonly remembered: number;
  };
  readonly notes: {
    readonly screenshotMinutes: number;
    readonly keptNotes: number;
  };
  readonly session: {
    readonly enabled: boolean;
    readonly sampleSeconds: number;
    readonly describeSeconds: number;
    readonly sweepMinutes: number;
    readonly compactCheckSeconds: number;
    readonly pictureWidth: number;
    readonly pictureQuality: number;
  };
}

export const WATCH_TIMELINE_KNOBS: WatchTimelineKnobs = Object.freeze<WatchTimelineKnobs>({
  timeline: {
    // 用户可能怎么说：她记不住刚才看的／陪看的时候她占内存太多了
    // 怎么调：内存里的时间线保留多少分钟（更早的只留在硬盘上的笔记里）
    windowMinutes: 10,
    // 用户可能怎么说：她只记得最后一句／她老是拿很久以前的剧情说事
    // 怎么调：每次回你带最近多少秒的听到和看到
    recentSeconds: 90,
    // 用户可能怎么说：带的陪看内容太长，她回得慢／太短，她没看到关键的
    // 怎么调：交给她的那一块最多多少字（先留最近的，再留概要）
    blockChars: 450,
    // 用户可能怎么说：一句话占了太多地方
    // 怎么调：时间线里每一条最多多少字
    entryChars: 200,
    // 用户可能怎么说：画面描述老是"描述中"卡着
    // 怎么调：画面描述等了多少秒还没写好，就放弃这一帧
    pendingSeconds: 90,
    // 用户可能怎么说：概要压得太早／太晚
    // 怎么调：一条记录至少过了多少秒才可以被压进概要
    compactAfterSeconds: 180,
    // 用户可能怎么说：只有两三句也压一次概要，浪费额度
    // 怎么调：可以压的记录少于几条就先不压
    compactMinEntries: 6,
  },

  haiku: {
    // 用户可能怎么说：陪看时用的额度太多了／她不怎么看画面
    // 怎么调：一小时最多描述几帧画面（每帧一次 haiku）
    framesPerHour: 30,
    // 用户可能怎么说：概要写得太频繁
    // 怎么调：两次写概要之间至少隔多少分钟
    summaryGapMinutes: 5,
    // 用户可能怎么说：画面一连串变，描述排了一长队
    // 怎么调：排着等描述的画面最多几帧，再多的这一帧就跳过
    queuedFrames: 3,
    // 用户可能怎么说：陪看时 haiku 同时干几件事
    // 怎么调：同一时间最多几个 haiku 活在跑
    parallel: 1,
  },

  frame: {
    // 用户可能怎么说：画面稍微亮一点暗一点她就去看
    // 怎么调：缩略图里一个点变了多少（0～255）才算这个点变了
    pixelDelta: 40,
    // 用户可能怎么说：换场景了她没发现／没换场景她老是去看
    // 怎么调：缩略图里多大一部分的点变了（0～1）才算画面变了；调小 = 更爱看
    changedShare: 0.3,
    // 用户可能怎么说：画面一闪一闪她一直在看
    // 怎么调：两次描述之间至少隔多少秒
    minGapSeconds: 8,
    // 用户可能怎么说：同一个画面她又描述了一遍
    // 怎么调：记住最近几个描述过的画面，一模一样的不再描述
    remembered: 16,
  },

  notes: {
    // 用户可能怎么说：截图留在硬盘上太久了／我想让她回头再看刚才的画面
    // 怎么调：截图在硬盘上留多少分钟，到点自动删（画面描述和概要不受影响）
    screenshotMinutes: 30,
    // 用户可能怎么说：看剧笔记越攒越多
    // 怎么调：每个角色最多留多少条看剧笔记（画面描述和概要），超了删最旧的
    keptNotes: 3000,
  },

  session: {
    // 用户可能怎么说：我不想让她在我们一起看的时候自己去看画面（总开关）
    // 怎么调：false = 整套陪看时间线不运行：不截图、不描述、不压概要，她这一轮也不带时间线（回到只带最近转写）。
    //        只有「和她一起看」开着（一起听 + 屏幕共享都开）时才会运行，这个开关关了就连那时也不运行
    enabled: true,
    // 用户可能怎么说：她看画面太勤／太懒
    // 怎么调：「和她一起看」开着时，每隔多少秒从屏幕共享取一张小图比一比（比完画面没变够就丢掉，不调模型）
    sampleSeconds: 10,
    // 用户可能怎么说：画面描述老是超时
    // 怎么调：一帧画面描述最多等多少秒，超过就放弃这一帧
    describeSeconds: 40,
    // 用户可能怎么说：硬盘上过期的截图没删干净
    // 怎么调：每隔多少分钟清一次过期的截图（启动时也清一次）
    sweepMinutes: 5,
    // 用户可能怎么说：概要压得不及时
    // 怎么调：每隔多少秒看一眼有没有够老的内容可以压成概要
    compactCheckSeconds: 20,
    // 用户可能怎么说：画面描述太糊／太费流量
    // 怎么调：交给 haiku 看的那张图宽多少像素（也是硬盘上缓存的那张）
    pictureWidth: 768,
    // 用户可能怎么说：画面描述太糊／太费流量
    // 怎么调：那张图的 JPEG 质量（1～100）
    pictureQuality: 60,
  },
});
