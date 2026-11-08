/**
 * Ending a pose inference process (2026-11-03: after "camera on → off → quit" one packaged run left the
 * inference process behind, stuck in its own exit with one thread and impossible to kill; see
 * docs/claude/2026-11-03-pose-exit-hang.md).
 *
 * The process is asked to stop. It stops taking frames, lets the frame or self-test in flight finish, releases
 * every inference session and then ends itself (worker.ts). The main process waits for that, with a limit, and
 * only kills it when it stopped answering — never in the middle of GPU work otherwise. App quit shortens the
 * limit so quitting is never held up for long; a process that does not even go away when killed is given up on.
 * Pure (timers injected) so the order can be tested without Electron.
 */

/** Camera off / restart: a frame, a release or a session still being built may take a moment. */
export const STOP_GRACE_MS = 3_000;
/** App quit: at most this long from the quit before an inference process that has not ended is killed. */
export const QUIT_GRACE_MS = 1_500;
/** After kill(): how long to wait for the exit event before giving up on the process. */
export const KILL_WAIT_MS = 500;

export interface ExitTimers {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
/** stopped: ended by itself after the stop message; killed: did not, was killed and then exited; unresponsive: not even that. */
export type ExitOutcome = 'stopped' | 'killed' | 'unresponsive';
export interface RetiringWorker {
  /** Ask the process to stop (the "stop" message). */
  stop(): void;
  /** Last resort. */
  kill(): void;
  /** Resolves on the process's exit event. */
  exited: Promise<void>;
}

interface Entry { done: Promise<ExitOutcome>; deadline: number; killed: boolean; arm(ms: number): void }

export class WorkerExits {
  private readonly entries = new Set<Entry>();
  constructor(private readonly timers: ExitTimers) {}

  /** Inference processes asked to stop that have not ended (or been given up on) yet. */
  get pending(): number { return this.entries.size; }

  retire(worker: RetiringWorker, graceMs: number = STOP_GRACE_MS): Promise<ExitOutcome> {
    const { timers } = this;
    let timer: unknown = null, finished = false, resolve!: (outcome: ExitOutcome) => void;
    const entry: Entry = {
      done: new Promise<ExitOutcome>(r => { resolve = r; }), deadline: 0, killed: false,
      arm: ms => {
        if (timer !== null) timers.clearTimer(timer);
        entry.deadline = timers.now() + ms;
        timer = timers.setTimer(() => { timer = null; expire(); }, ms);
      },
    };
    const finish = (outcome: ExitOutcome) => {
      if (finished) return;
      finished = true;
      if (timer !== null) { timers.clearTimer(timer); timer = null; }
      this.entries.delete(entry);
      resolve(outcome);
    };
    const expire = () => {
      if (entry.killed) { finish('unresponsive'); return; }
      entry.killed = true;
      try { worker.kill(); } catch { /* already gone: the exit event follows */ }
      entry.arm(KILL_WAIT_MS);
    };
    this.entries.add(entry);
    void worker.exited.then(() => finish(entry.killed ? 'killed' : 'stopped'));
    entry.arm(graceMs);
    try { worker.stop(); } catch { /* the channel is gone: the process is ending anyway */ }
    return entry.done;
  }

  /** App quit: every process still ending gets at most `graceMs` more before it is killed. */
  hurry(graceMs: number = QUIT_GRACE_MS): void {
    const latest = this.timers.now() + graceMs;
    for (const entry of this.entries) if (!entry.killed && entry.deadline > latest) entry.arm(graceMs);
  }

  /** Resolves once every process asked to stop has ended or been given up on. */
  async settled(): Promise<void> {
    while (this.entries.size) await Promise.all([...this.entries].map(entry => entry.done));
  }
}
