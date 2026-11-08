/**
 * #5 照着做的一侧：主机的计时器（electron/reply-lifetime.ts）和桌宠窗口（src/ui/PetUI.ts）怎么用主机定下的毫秒数。
 * 这里不做决定：只把数夹进旋钮的 range，读主机的答复。
 */
import { REPLY_LINGER_KNOBS, type ReplyLingerKnobs } from './knobs';

/** 最长留多久（旋钮 range 的上限）。桌宠窗口在主机答复之前按这个算：主机定的不会比它更长。 */
export const replyLingerLongestMs = (knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): number => knobs.range[1];

/** 主机计时用的毫秒数：夹进 range；不是数（只有出错时才会）就按最长的留，宁可多留一会儿让你读完。 */
export function safeLingerMs(value: unknown, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): number {
  const [low, high] = knobs.range;
  if (typeof value !== 'number' || !Number.isFinite(value)) return high;
  return Math.round(Math.min(high, Math.max(low, value)));
}

/** 桌宠窗口读主机对 'complete' 的答复（PetReplyLingerAnswer）；不像样就返回 null（照旧按最长的算）。 */
export function readReplyLingerAnswer(value: unknown, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): number | null {
  const ms = answerMs(value);
  return ms === null || ms < knobs.range[0] || ms > knobs.range[1] ? null : ms;
}

/**
 * 桌宠窗口读主机对其他更新（位置、淡出）的答复：这条已说完的回复从现在起还留多久。主机只在气泡真能被看见时才计时
 * （Codex T-207 2C），所以桌宠窗口靠它把自己的期限往后挪，不会比主机先收；她的脸不在屏幕上时，桌宠窗口自己的倒计时也停
 * （第二轮：首个可见锚点晚到 2.8 秒、中间没有答复时，桌宠窗口曾先收）。不像样就返回 null（期限不动）。
 */
export function readReplyLingerLeft(value: unknown, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): number | null {
  const ms = answerMs(value);
  return ms === null || ms < 0 || ms > knobs.range[1] ? null : ms;
}

function answerMs(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ms = (value as { lingerMs?: unknown }).lingerMs;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}
