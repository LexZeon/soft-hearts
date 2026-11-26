// I-112 B: while the app runs, "更真实的情绪" is turned off at the card's end time. The check always compares the wall clock
// with the stored end time (never counts elapsed time), so sleep and clock changes cannot make it late for long or wrong:
// a short poll (30 s) plus an exact wake-up when the end is closer than that, and `wake()` for resume-from-sleep.
// No Electron import; electron/main.ts passes the store's methods and powerMonitor's resume.

export const REALER_EXPIRY_POLL_MS = 30_000;

export interface RealerExpiryDeps {
  /** The store's expireRealerEmotions(now): ids that just expired (one write only when some did). */
  expire(now: number): Promise<string[]>;
  /** The store's earliest end time among cards that are on; null when none. */
  next(): number | null;
  now(): number;
  /** Called after cards expired (main.ts: the usual character sync so the chat and the editor see it). Never throws into the loop. */
  onExpired(ids: string[]): void | Promise<void>;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface RealerExpiryWatcher {
  /** Check now (resume from sleep, a changed clock) and re-arm the timer. */
  wake(): Promise<void>;
  /** Re-arm after the switch changed (a nearer end time). */
  rearm(): void;
  stop(): void;
}

export function startRealerExpiryWatcher(deps: RealerExpiryDeps): RealerExpiryWatcher {
  const setTimer = deps.setTimer ?? ((run, ms) => { const handle = setTimeout(run, ms); (handle as { unref?: () => void }).unref?.(); return handle; });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let handle: unknown, stopped = false;
  const arm = (): void => {
    if (stopped) return;
    if (handle !== undefined) clearTimer(handle);
    const next = deps.next();
    const delay = next === null ? REALER_EXPIRY_POLL_MS : Math.min(REALER_EXPIRY_POLL_MS, Math.max(250, next - deps.now()));
    handle = setTimer(() => { handle = undefined; void check(); }, delay);
  };
  const check = async (): Promise<void> => {
    try {
      const ids = await deps.expire(deps.now());
      if (ids.length) { try { await deps.onExpired(ids); } catch { /* The card is already off; telling the windows is best effort. */ } }
    } catch { /* The next tick tries again. */ }
    arm();
  };
  arm();
  return { wake: check, rearm: arm, stop: () => { stopped = true; if (handle !== undefined) clearTimer(handle); handle = undefined; } };
}
