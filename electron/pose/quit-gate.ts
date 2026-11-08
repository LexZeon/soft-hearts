/**
 * App quit and the pose inference process (2026-11-03, exit hang). Left to Electron, a live inference process
 * is torn down by the app's own shutdown, possibly in the middle of GPU work. Instead, `before-quit` holds the
 * quit once: the process is stopped the normal way (finish the frame, release the sessions, end itself; killed
 * after QUIT_GRACE_MS) and then the quit continues. Bounded by `limitMs` whatever happens, so quitting never
 * hangs on it; with no inference process there is nothing to wait for and the quit is not held at all.
 */
export const POSE_QUIT_LIMIT_MS = 2_500;

export interface PoseQuitTarget {
  /** An inference process is alive or still ending. */
  readonly busy: boolean;
  /** Stop and resolve once the inference process has ended (or been given up on). */
  shutdown(): Promise<void>;
}

export function createPoseQuitGate(target: () => PoseQuitTarget | null, quit: () => void,
  setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms), limitMs = POSE_QUIT_LIMIT_MS) {
  let state: 'open' | 'waiting' | 'done' = 'open';
  return {
    /** Call from `before-quit`: true means "prevent this quit; it is called again once the process has ended". */
    hold(): boolean {
      if (state === 'done') return false;
      if (state === 'waiting') return true;
      const pose = target();
      if (!pose) { state = 'done'; return false; }
      const waiting = pose.busy;
      const ended = pose.shutdown(); // always: nothing new may start once quitting has begun
      if (!waiting) { state = 'done'; return false; }
      state = 'waiting';
      let finished = false;
      const finish = () => { if (finished) return; finished = true; state = 'done'; quit(); };
      ended.then(finish, finish);
      setTimer(finish, limitMs);
      return true;
    },
  };
}
