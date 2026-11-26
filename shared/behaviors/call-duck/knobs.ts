/**
 * 功能：打电话时你一开口，她先把声音放低听你，再判断要不要停（I-177 第 2 批，"先侧耳听，再判断"）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 起因：打电话时她正在说，你想打断也很难；方案第 4 条按推荐；11-19 的规矩不变：明确、成句的话才打断。
 *
 * 读法（src/voice/voice-call/call-duck.ts）：
 *  - 通话里她在读、你开口（麦克风声音过了回声门槛、语音检测认成人声，约 0.2～0.3 秒）：她的声音平滑地降低 duckDb 分贝，停在那里等你，但照常往下读。
 *  - 识别出的是成句的话或"等一下"这类叫停话：她照 11-19 的规矩停下来听你说（判断在 shared/behaviors/interrupt/judge.ts，没改）。
 *  - 只是"嗯"、半截话、她自己的回声、或什么字都没认出来：她的声音平滑地回到原来的音量，接着说。
 *  - 光是放低声音从不让她停；等太久（maxHoldMs）还没结果，也照样回到原来的音量。
 *  - 只有 Drama 3 / 百炼的声音能放低；系统声音放不低（一句话交给系统后就改不了音量），照旧。
 *  - 戴耳机时没有回声，"你开口"的门槛可以低一点（headphonesFloor、headphonesGateFactor）；外放照旧按回声算。
 * 这些都只是试用值，没在真机上听过。
 */

export interface CallDuckKnobs {
  readonly duckDb: number;
  readonly downMs: number;
  readonly upMs: number;
  readonly maxHoldMs: number;
  readonly verdictWaitMs: number;
  readonly headphonesFloor: number;
  readonly headphonesGateFactor: number;
}

export const CALL_DUCK_KNOBS: CallDuckKnobs = Object.freeze<CallDuckKnobs>({
  // 用户可能怎么说：我一开口她声音降得太多，像被打断了 / 降得太少，我还是听不清自己说什么
  // 怎么调：你开口时她的声音放低多少分贝（负数；-12 约为原来的四分之一；不要设成很大的负数，放低不等于停）
  duckDb: -12,

  // 用户可能怎么说：她的声音降得太突然 / 太慢
  // 怎么调：放低用多少毫秒（平滑地降，开头和结尾都缓）
  downMs: 180,

  // 用户可能怎么说：我只是"嗯"了一声，她的声音回来得太猛 / 太慢
  // 怎么调：回到原来的音量用多少毫秒
  upMs: 450,

  // 用户可能怎么说：我开口后她的声音一直很小，没回来
  // 怎么调：放低以后最多等多少毫秒；还没判断出结果就回到原来的音量（保险，不让她一直小声）
  maxHoldMs: 6000,

  // 用户可能怎么说：我说完"嗯"以后，她要过一会儿声音才回来
  // 怎么调：你这一段话说完、交给识别以后，最多再等多少毫秒的识别结果；等不到就回到原来的音量
  verdictWaitMs: 3000,

  // 用户可能怎么说：戴耳机打电话，我小声说她也不放低声音
  // 怎么调：戴耳机时（没有回声），"你开口"的最低音量（0～1；外放是 0.03）
  headphonesFloor: 0.015,

  // 用户可能怎么说：戴耳机时旁边一点声音她就放低了
  // 怎么调：戴耳机时，"你开口"要比平时"算说话"的门槛大几倍（外放是 3）
  headphonesGateFactor: 2,
});
