// A clock the test moves by hand: `now` and `timers` have the shapes PersistentClaudeOptions takes, so the timeouts the code under
// test sets (prepare delay, hidden-request limit, idle limit) fire when the test calls advance(), never because a busy machine was slow.
// Anything outside the code under test (a fake child process, real I/O) still runs in real time.
export interface ManualClock {
  now: () => number;
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** Moves time forward by `ms`, firing due timers in time order (ties in the order they were set), including ones they set. */
  advance(ms: number): void;
  /** Timers still waiting. */
  readonly pending: number;
}

export function manualClock(start = 1_000_000): ManualClock {
  let current = start;
  let serial = 0;
  const waiting = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => current,
    timers: {
      set(callback, ms) { const id = ++serial; waiting.set(id, { at: current + Math.max(0, ms), callback }); return id; },
      clear(handle) { waiting.delete(handle as number); },
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let next: [number, { at: number; callback: () => void }] | null = null;
        for (const entry of waiting) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        waiting.delete(next[0]);
        current = Math.max(current, next[1].at);
        next[1].callback();
      }
      current = target;
    },
    get pending() { return waiting.size; },
  };
}
