/**
 * 功能：屏幕共享开着时她跟着你看视频（I-006 第 3 步）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 只在屏幕共享开着、"扫一眼"认出你在看视频（或玩游戏）时才有。共享关着，这一整套一次都不出现，浏览器也一次都不看。
 *  - 看视频：她转过去看屏幕中间（按她的窗口在哪块屏幕上算方向），眼睛晃得更轻，偶尔回头看你。
 *    玩游戏：有时跟着看、有时做自己的事，看她爱不爱玩（"她自己的生活"表里"跟着看"那一行的倍数）。
 *  - 浏览器里的视频：浏览器在前台停够 browserFrontSeconds 秒，你又有 idleSeconds 秒没操作（用"知道你是不是在忙"读到的空闲秒数）时，
 *    让小模型看一张 320×200 的小图，回一个词。你一直没回来操作就不再问；每小时的次数有上限（quota），聊得越多上限越高。
 *    上限的计数只在内存里，不写盘。
 * 绝不做的事不是旋钮：不评论屏幕上的具体内容、画面不存盘不进日志、小图只换回一个类别词。
 * 这些都只是试用值，没在真机上看过。
 */
export interface WatchAlongKnobs {
  readonly browserFrontSeconds: number;
  readonly idleSeconds: number;
  readonly quota: { readonly base: number; readonly interactionsPerExtra: number; readonly max: number; readonly windowMinutes: number };
  readonly gaze: { readonly x: number; readonly y: number; readonly down: number; readonly eyeHeight: number; readonly followSeconds: number };
}

export const WATCH_ALONG_KNOBS: WatchAlongKnobs = Object.freeze<WatchAlongKnobs>({
  // 用户可能怎么说：我刚打开网页她就以为我在看剧／我看了好一会儿剧她还不知道
  // 怎么调：浏览器要在前台连续停多少秒，才可能去看一眼小图
  browserFrontSeconds: 60,

  // 用户可能怎么说：我只是停一下手她就去看我的屏幕／我明明在看剧她迟迟不跟着看
  // 怎么调：你多少秒没碰键盘鼠标，才算"没在操作"（要比"知道你是不是在忙"的"操作中"那条线小）
  idleSeconds: 45,

  // 用户可能怎么说：看剧时额度花得太快／聊得很多她却还是很少看浏览器
  // 怎么调：base＝每小时最少几次；interactionsPerExtra＝过去一小时每多少次聊天或互动多一次；max＝最多几次；windowMinutes＝往回数多久
  quota: { base: 6, interactionsPerExtra: 5, max: 20, windowMinutes: 60 },

  // 用户可能怎么说：她看屏幕的方向不对／她转得太夸张／她看屏幕看得不够明显
  // 怎么调：x、y＝朝屏幕中间看的幅度（窗口在屏幕边上时最大）；down＝窗口正在屏幕中间时也微微往下看的量；eyeHeight＝把她的眼睛算在窗口的哪个高度（0 顶～1 底）；followSeconds＝她拖到别处后视线跟上要多久
  gaze: { x: 0.2, y: 0.12, down: 0.04, eyeHeight: 0.35, followSeconds: 0.4 },
});
