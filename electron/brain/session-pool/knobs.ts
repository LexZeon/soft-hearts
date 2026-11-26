/**
 * 功能：每个角色一个热着的聊天进程（I-186 第 0 步，docs/claude/2026-11-22-i186-step0-session-pool.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 每个角色（加连接和模型）各有一个 Claude Code 聊天进程，切走再切回来不用重新"醒一次"（electron/brain/session-pool/pool.ts）。
 *  - 闲置规则各算各的：台上那位被看见时 10 分钟、看不见时 3 分钟；切走的角色按"看不见"算，从切走那一刻起 3 分钟
 *    （这两个时长在 electron/brain/claude-session.ts 的 CLAUDE_SESSION_IDLE_MS / CLAUDE_SESSION_HIDDEN_IDLE_MS）。
 *  - 同时最多热着 maxWarm 个；再多一个时，先关最久没说话的那一个，正在说话的那位永远不关。
 * 3 个。
 */

export const SESSION_POOL_KNOBS = Object.freeze({
  // 用户可能怎么说：切回原来那个角色，第一句又慢了 / 开了几个角色以后电脑变卡
  // 怎么调：同时最多热着几个角色的聊天进程（≥ 1）；多了来回切都快，但每个进程都占内存（3 个大约是 1 个的三倍）
  maxWarm: 3,
});
