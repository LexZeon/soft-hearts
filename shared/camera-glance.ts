/**
 * I-036 「发图片」: the sizes and timings the camera's
 * owner window and the host agree on. Pure numbers, no persona or user data.
 *
 * While 「发图片」 is on, the owner window keeps one small frame ready (it draws one every GLANCE_INTERVAL_MS and hands it to the
 * host, which keeps only the latest, in memory). Each message the user sends carries that frame as it is: nothing is captured on
 * send, so the first word does not wait for the camera. When the user asks her to look ("你看看我") a clear frame is taken from the
 * stream that is already open (CLEAR_* below, the size 「拍一张给她看」 uses).
 */

/** About 320×240: enough to see whether the user is there, their expression and rough posture, not fine detail. */
export const GLANCE_WIDTH = 320;
export const GLANCE_HEIGHT = 240;
export const GLANCE_JPEG_QUALITY = 0.6;
/** How often the owner window refreshes the kept small frame. */
export const GLANCE_INTERVAL_MS = 3_000;
/** A kept frame older than this is not attached (the camera stalled, the window was throttled): no picture rather than an old one. */
export const GLANCE_MAX_AGE_MS = 10_000;
/** A small frame is a few kilobytes; anything near this is not one. */
export const GLANCE_MAX_CHARS = 200_000;
/** With 「姿势识别」 also on, a small frame goes only when the pose changed, or after this long without one (she does not go blind). */
export const GLANCE_BLIND_MS = 10 * 60_000;
/** The clear frame (asked for, or 「拍一张给她看」): at most 1280 on the long side, JPEG 0.8 (src/ui/capture.ts). */
export const CLEAR_MAX_SIDE = 1280;
export const CLEAR_JPEG_QUALITY = 0.8;

/** The size a frame of `width`×`height` is drawn at for the small frame: fits in 320×240, never enlarged. */
export function glanceSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, GLANCE_WIDTH / width, GLANCE_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
