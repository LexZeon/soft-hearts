/** Throws when a queued change must not take effect any more (e.g. the agent channel was closed). */
export type MutationGuard = () => void;

/**
 * The host's single mutation queue (main.ts `mutate`): changes run one at a time, in order.
 * A guarded change re-checks its guard right before it starts, after waiting for its turn, so
 * something that became invalid while it waited fails with the guard's error instead of
 * taking effect. Unguarded changes behave exactly as before.
 */
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private ambient: MutationGuard | null = null;

  /** Queues a change. Without an explicit guard it takes the one of an enclosing `guarded()` call, if any. */
  run<T>(operation: () => Promise<T>, guard?: MutationGuard | null): Promise<T> {
    const check = guard === undefined ? this.ambient : guard;
    const start = () => { check?.(); return operation(); };
    const result = this.tail.then(start, start);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Settles once everything queued so far has finished (failures included). */
  idle(): Promise<void> { return this.tail.then(() => {}); }

  /**
   * Runs `fn` (an existing IPC handler reused by the agent channel) so that every change it
   * queues synchronously, before its first await, carries `guard`. All handlers the channel
   * reuses queue their change as their first step (see agent-channel/bridge.ts).
   */
  guarded<T>(guard: MutationGuard, fn: () => T): T {
    const previous = this.ambient;
    this.ambient = guard;
    try { return fn(); } finally { this.ambient = previous; }
  }
}
