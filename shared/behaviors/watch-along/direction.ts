/**
 * I-006 第 3 步：她的眼睛该往哪看才是"屏幕中间"。纯函数，没有 Electron：窗口和屏幕的矩形由舞台从浏览器自己的数里读（多块屏幕、
 * 屏幕在负坐标上都一样，只用"窗口相对它所在的那块屏幕"）。方向是 x 向右为正、y 向上为正，各在 -1～1。
 */
import { WATCH_ALONG_KNOBS, type WatchAlongKnobs } from './knobs';

export interface ScreenRect { x: number; y: number; width: number; height: number }
export interface WatchDirection { x: number; y: number }

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const rectOk = (r: ScreenRect | null | undefined): r is ScreenRect =>
  !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

/**
 * 从她的眼睛（窗口中间偏上）指向她所在那块屏幕中间的方向。窗口正好在屏幕中间时是 (0, 0)；在左上角时朝右下，依此类推。
 * 读不到窗口或屏幕时是 (0, 0)（眼睛不偏，只剩微微朝下）。
 */
export function watchDirection(window: ScreenRect | null | undefined, display: ScreenRect | null | undefined, knobs: WatchAlongKnobs = WATCH_ALONG_KNOBS): WatchDirection {
  if (!rectOk(window) || !rectOk(display)) return { x: 0, y: 0 };
  const eyeX = window.x + window.width / 2, eyeY = window.y + window.height * clamp(knobs.gaze.eyeHeight, 0, 1);
  const dx = (display.x + display.width / 2) - eyeX, dy = (display.y + display.height / 2) - eyeY;
  // Screen y grows downward; the gaze y grows upward. Scaled by half the display, so the far edge is about 1.
  return { x: clamp(dx / (display.width / 2), -1, 1) + 0, y: clamp(-dy / (display.height / 2), -1, 1) + 0 };
}

/** 视线偏移（和程序化生活的 gaze 同一个单位）：方向乘幅度，再加上微微朝下。 */
export function watchGaze(direction: WatchDirection, knobs: WatchAlongKnobs = WATCH_ALONG_KNOBS): { x: number; y: number } {
  return { x: clamp(direction.x, -1, 1) * knobs.gaze.x + 0, y: clamp(direction.y, -1, 1) * knobs.gaze.y - knobs.gaze.down };
}
