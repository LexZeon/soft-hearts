/**
 * 功能：她自己看你一眼（I-085 第 1 步，摄像头）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法（shared/initiative/self-look.ts wantToLook，每分钟本机算一次，不调模型）：
 *  - 想看 = base + 想你（M 想念、O 亲近）+ 好奇（D）+ 担心（N 和 C 一起高）+ 无聊（B）+ 你多久没理她 + 你不在电脑前
 *    − 困（疲倦 F 和困倦阶段）− 刚看过。到 threshold 才看。
 *  - 激素都按"相对角色卡基线"读（shared/foundation/mood.ts moodLevel，50 = 正好在基线）：只有高过基线的那部分算数，rise = 0～1。
 *  - 睡着了、你正在打字或刚发完消息：想看 = 0，不看。
 *  - 聊天时（chatLook，I-085 第 5 节）另算：不看"想不想"，你发完一句、她手里没有新鲜的那句看到的话、也没在睡，就后台看一眼给下一句用。
 *  - I-168：不再有冷却、每小时次数、打字后的安静期；一次只看一眼（不重叠）。最坏每分钟一次（约每小时 60 次 haiku）。
 * 安全线不是旋钮，写在 electron/initiative/self-look/host.ts：只用「发图片」开着的摄像头（I-168 起"别看"不挡，开关才是锁）；设置关了、桌宠藏起来、
 * Claude 连不上时一次都不看；看到的话只在内存里，换角色、换对话、过期、"别看"、关摄像头就丢。
 * 这些都只是试用值，没在真机上看过。
 */

export interface SelfLookKnobs {
  readonly tickMs: number;
  readonly threshold: number;
  readonly base: number;
  readonly weights: {
    readonly longing: number;
    readonly closeness: number;
    readonly curiosity: number;
    readonly worry: number;
    readonly boredom: number;
  };
  readonly quiet: { readonly fromMinutes: number; readonly fullMinutes: number; readonly weight: number };
  readonly away: { readonly idleSeconds: number; readonly weight: number };
  readonly tired: { readonly from: number; readonly span: number; readonly weight: number; readonly lightDrowsy: number; readonly drowsy: number };
  readonly satiety: { readonly minutes: number; readonly weight: number };
  readonly lineTtlMs: number;
  readonly skipRowEveryMs: number;
  readonly captureTimeoutMs: number;
  readonly askTimeoutMs: number;
  readonly lineChars: number;
  readonly openingWaitMs: number;
  readonly chatLook: boolean;
}

export const SELF_LOOK_KNOBS: SelfLookKnobs = Object.freeze({
  // 用户可能怎么说：她反应太慢了，我不理她好久她都不看我一眼
  // 怎么调：多久算一次"想不想看"（毫秒）；越小越及时，但每次只是本机算，不调模型
  tickMs: 60_000,
  // 用户可能怎么说：她看我看得太勤了／她几乎从来不自己看我
  // 怎么调：想看到多少才看（0～1）；调高她看得少，调低看得多。I-168 起没有次数上限（不再限制），刚看过会让她想看的劲小一些（satiety）
  threshold: 0.5,
  // 用户可能怎么说：她平时就该多看看我
  // 怎么调：什么都不想时的底子（0～1）
  base: 0.15,
  weights: Object.freeze({
    // 用户可能怎么说：她想我的时候应该更想看看我
    // 怎么调：想念 M（0～100）满了时加多少
    longing: 0.5,
    // 用户可能怎么说：她跟我亲近的时候也想看看我
    // 怎么调：亲近 O 高过基线的部分满了时加多少
    closeness: 0.3,
    // 用户可能怎么说：她好奇的时候会想看我在干嘛
    // 怎么调：好奇 D 高过基线的部分满了时加多少
    curiosity: 0.35,
    // 用户可能怎么说：她紧张害怕时想确认我在不在
    // 怎么调：N 和 C 一起高过基线（取两者小的）满了时加多少
    worry: 0.4,
    // 用户可能怎么说：她无聊的时候想看看我在忙什么
    // 怎么调：无聊 B（0～100）满了时加多少
    boredom: 0.35,
  }),
  // 用户可能怎么说：我好久没理她，她该更想看看我
  // 怎么调：你多久没和她互动（聊天、摸头、喂食）开始算、到多久算满（分钟），满了加 weight
  quiet: Object.freeze({ fromMinutes: 5, fullMinutes: 30, weight: 0.2 }),
  // 用户可能怎么说：我离开电脑了她也想确认一下我在不在
  // 怎么调：键盘鼠标多少秒没动算你不在，不在时加多少（只在「知道你是不是在忙」开着时读得到）
  away: Object.freeze({ idleSeconds: 300, weight: 0.05 }),
  // 用户可能怎么说：她困了还老看我
  // 怎么调：疲倦 F 从 from 到 from + span 之间线性减到 weight；有点困、很困另外再减
  tired: Object.freeze({ from: 0.4, span: 0.5, weight: 0.4, lightDrowsy: 0.1, drowsy: 0.3 }),
  // 用户可能怎么说：她刚看过又看
  // 怎么调：看过之后想看先减 weight，在 minutes 分钟里慢慢减回 0
  satiety: Object.freeze({ minutes: 30, weight: 0.25 }),
  // 用户可能怎么说：她拿很久以前看到的样子说事
  // 怎么调：看到的那句话留多久（毫秒）；方案定的是 10 分钟
  lineTtlMs: 10 * 60_000,
  // 用户可能怎么说：体验记录里"她想看没看成"太多了
  // 怎么调：同一种"没看成"的记录至少隔多久才再写一行（毫秒）
  skipRowEveryMs: 60 * 60_000,
  // 用户可能怎么说：她看一眼卡住了
  // 怎么调：取一张画面最多等多久（毫秒）
  captureTimeoutMs: 5_000,
  // 用户可能怎么说：她看一眼要想很久
  // 怎么调：haiku 写那句话最多等多久（毫秒）
  askTimeoutMs: 25_000,
  // 用户可能怎么说：她看到的那句话太长了
  // 怎么调：那句话最多几个字
  lineChars: 40,
  // 用户可能怎么说：她想开口前看我那一眼，让她等了很久才说话／她开口前根本没看
  // 怎么调：她要先开口时，先看一眼最多等多久（毫秒）；到时没看完她就直接说（看到的那句话晚到了，下一句聊天还能用）。只对她自己先开口生效
  openingWaitMs: 8_000,
  // 用户可能怎么说：我在和她聊天，她却一直说"最近没看到你"／聊天时她别老看我
  // 怎么调：聊天时后台看一眼的总开关（I-085 第 5 节）：你发完一句、她手里没有新鲜的那句看到的话时，后台看一眼，这一句不等它，下一句就能提到（I-168 起不再隔 10 分钟、不限次数）。false = 聊天时不看
  chatLook: true,
});
