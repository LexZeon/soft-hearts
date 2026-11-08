import { safeLingerMs } from '../shared/behaviors/reply-linger/perform';
interface ReplyClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds now (Date.now when left out). */
  now?(): number;
}
const clock: ReplyClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Anchor movement never renews a reply; only content state controls its lifetime. How long a completed reply stays is
 * decided per reply (#5, shared/behaviors/reply-linger/: electron/reply-window.ts asks once per completion); this only keeps
 * the timer, held to the knobs' range.
 *
 * The countdown runs only while the reply can be seen (Codex T-207 2C): a completion that comes while the bubble cannot show
 * yet (its window still loading, her face not on screen) waits for it to show, and a bubble that goes out of sight keeps the
 * rest of its time for when it is back. So once it shows, a reply is on screen for its whole lifetime, never less than its
 * readable floor. The owner (electron/reply-window.ts) says when it can be seen; until it says otherwise, it can. A pat or
 * feed fade does not stop the countdown (the bubble is only faded; user-confirmed behaviour).
 */
export class ReplyLifetime {
  private timer: unknown;
  private revision = 0;
  /** What is left of the completed reply's lifetime; undefined when there is nothing to count. */
  private left: number | undefined;
  /** When the running countdown started; undefined while it waits. */
  private since: number | undefined;
  private showing = true;
  constructor(private readonly expire: () => void, private readonly timers: ReplyClock = clock) {}
  cancel(): void {
    this.stop();
    this.left = undefined;
  }
  streaming(): void { this.cancel(); }
  complete(lingerMs: number): void {
    this.cancel();
    this.left = safeLingerMs(lingerMs);
    if (this.showing) this.run();
  }
  /** Whether the reply can be seen now: the countdown runs only while it can. */
  visible(showing: boolean): void {
    if (showing === this.showing) return;
    this.showing = showing;
    if (this.left === undefined) return;
    if (showing) this.run();
    else { const left = this.remaining(); this.stop(); this.left = left; }
  }
  /** Milliseconds the completed reply still stays if it stays in sight from now on; undefined when nothing is counting. */
  remaining(): number | undefined {
    if (this.left === undefined || this.since === undefined) return this.left;
    return Math.max(0, this.left - (this.now() - this.since));
  }
  private run(): void {
    this.stop();
    const revision = this.revision, left = this.left!;
    this.since = this.now();
    this.timer = this.timers.setTimeout(() => {
      if (revision !== this.revision) return;
      this.timer = undefined;
      this.left = this.since = undefined;
      this.expire();
    }, left);
  }
  private stop(): void {
    this.revision++;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = this.since = undefined;
  }
  private now(): number { return this.timers.now ? this.timers.now() : Date.now(); }
}
