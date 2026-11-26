/**
 * 功能：打的字不会悄悄丢掉（在全屏里打字时反馈：回答像是等了太久，而且是打字、不是语音）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 一句话没发出去时，字回到你打字的地方并提示"没发出去，再试一次"（shared/brain/send-drop/drop.ts）。这些时长都只是试用值，没在真机上量过。
 */
export interface SendDropKnobs {
  readonly readoutControlTimeoutMs: number;
  readonly unboundStopTimeoutMs: number;
  readonly unboundAckWaitMs: number;
  readonly unboundAckGiveUpMs: number;
  readonly saveWaitMs: number;
}

export const SEND_DROP_KNOBS: SendDropKnobs = Object.freeze<SendDropKnobs>({
  // 用户可能怎么说：说了"停一下"之类的小指令以后，好一阵子打什么都发不出去
  // 怎么调：小指令（停止朗读、取景、呼吸）或开发者测试指令发出后，最多等主进程回音多少毫秒，过了就不再挡后面的消息
  readoutControlTimeoutMs: 10_000,
  // 用户可能怎么说：全屏里她说话时我打字，要过好久才发出去
  // 怎么调：全屏输入框发话时先停她这条回复，最多等停下多少毫秒，过了就照发
  unboundStopTimeoutMs: 2_000,
  // 用户可能怎么说：全屏里按了回车，输入框要过一会儿才关／一按回车输入框就关了，结果没发出去
  // 怎么调：按回车后输入框留着等控制窗口回话"发出去了"最多多少毫秒；过了先关上，之后要是没发出去再带着这句重新打开
  unboundAckWaitMs: 3_000,
  // 用户可能怎么说：全屏里打的话没发出去，等了很久输入框才带着原话重新出来
  // 怎么调：一句话交出去后多少毫秒还没发出，就把它收回（之后再到也不发，不会重复），带着原话重新打开输入框；平时一句话一秒内就发出（2026-11-23）
  unboundAckGiveUpMs: 20_000,
  // 用户可能怎么说：打电话中途或刚挂断时打字，要等好久才发出去
  // 怎么调：发消息前顺手保存窗口设置，最多等它多少毫秒；过了就照发（保存在后面接着做，这一句用主进程已有的设置）
  saveWaitMs: 2_000,
});
