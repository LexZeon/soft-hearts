/**
 * 功能：通话用的声音设备：出现一组没见过的设备时，请你的 Claude（haiku）看一眼（I-177 第 2 批）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 *
 * 读法（主进程那端在 electron/voice/call-device-judge.ts）：
 *  - 打电话开始时，窗口先按设备名里的关键词给出建议（马上出、不花用量）；这组设备第一次出现时，再问一次 haiku。
 *  - 交过去的只有去掉机主名的设备名和种类（输入 / 输出），没有设备编号；同一组设备只问一次，答案记住。
 *  - haiku 的回答只留真插着的设备名、三种类型（耳机 / 外放 / 麦克风）；不对、超时、Claude 没连上，都照关键词的建议。
 *  - 用你 Claude 的用量（和心情调整员、新的反应方式一样走 haiku）；Claude 暂时用不了时不问。
 * 这些都只是试用值，没用真的 haiku 试过。
 */

export interface CallDevicesKnobs {
  readonly callsPerDay: number;
  readonly timeoutMs: number;
}

export const CALL_DEVICES_KNOBS: CallDevicesKnobs = Object.freeze<CallDevicesKnobs>({
  // 用户可能怎么说：我老插拔耳机，会不会一直在用我的 Claude 额度
  // 怎么调：一天最多问 haiku 几次（每组新设备最多一次；到了上限就只用关键词的建议）
  callsPerDay: 6,

  // 用户可能怎么说：Claude 的建议半天才出来
  // 怎么调：haiku 多少毫秒还没答就放弃这一次（照关键词的建议；打电话本身从不等它）
  timeoutMs: 20_000,
});
