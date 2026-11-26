/**
 * Date.now driven by a frame counter, for tests that measure a per-frame step of the real Stage frame loop.
 * The stage reads Date.now() for host timestamps (the right clock for the app: a slow frame is longer in real time), so on a busy
 * machine the real time between two fake frames can exceed one frame and a step jumps. Here one frame is exactly 1000 / fps ms.
 * Call restore() in a finally block.
 */
export function frameDrivenClock(fps: number) {
  const realNow = Date.now, start = realNow();
  let frame = 0;
  Date.now = () => start + frame * 1000 / fps;
  return { start, advance: () => { frame++; }, restore: () => { Date.now = realNow; } };
}
