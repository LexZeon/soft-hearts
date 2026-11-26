// A change that has to restart or clear something her reply is using waits until the reply and its voice are done (only the user cutting in interrupts her; a setting that must restart the Claude process waits). Pure: the busy check, the timer and
// the journal note are ports. Same shape as the character switch gate (electron/cards/character-switch.ts), but nothing is dropped:
// every waiting change runs once, in the order it came, when she is quiet, when you cut in with a new message (`flush`: you cut her
// off yourself then), or at the safety cap (a turn that never ends must not hold a change for ever).
import type { DeferredWhile, SettingDeferral } from '../../shared/voice/interrupt-policy';

export interface SettleWhenQuietPorts {
  /** What she is doing now, or null when she is quiet (a chat turn running: 'replying'; her voice reading it: 'speaking'). */
  busy(): DeferredWhile | null;
  /** Called once per waiting change (closed words only; the experience journal row). */
  note?(what: SettingDeferral, during: DeferredWhile): void;
  /** Calls `run` every `ms` until the returned stop is called. */
  every(ms: number, run: () => void): () => void;
  now?(): number;
  /** Safety cap in ms (default 10 minutes). */
  capMs?: number;
  /** How often to look (default 250 ms). */
  pollMs?: number;
}

interface Waiting { what: SettingDeferral; action: () => void | Promise<void> }

export class SettleWhenQuiet {
  private waiting: Waiting[] = [];
  private since = 0;
  private stopPoll: (() => void) | null = null;
  /** What was already written while she has been busy (one row per kind per busy stretch, however many steps of one save ask). */
  private readonly noted = new Set<SettingDeferral>();
  constructor(private readonly ports: SettleWhenQuietPorts) {}

  /** How many changes are waiting. */
  get pending(): number { return this.waiting.length; }

  /** Runs `action` now when she is quiet; else after she is. A second change of the same kind replaces the first (the action reads current settings when it runs). */
  run(what: SettingDeferral, action: () => void | Promise<void>): void | Promise<void> {
    const during = this.ports.busy();
    if (!during && this.waiting.length === 0) { this.noted.clear(); return action(); }
    const at = this.waiting.findIndex(item => item.what === what);
    if (at >= 0) this.waiting[at] = { what, action };
    else this.waiting.push({ what, action });
    if (during) this.note(what, during);
    this.watch();
  }

  /**
   * For a change that goes on by itself (a sense turned off: what she was shown goes now, her reply and the page stay): true when she is busy,
   * and the journal row is written once for this busy stretch; false when she is quiet.
   * 2026-11-26 (I-221): the stretch ends when she is quiet even if nobody asks again (before, a second switch-off in a later reply wrote no row).
   */
  waitsFor(what: SettingDeferral): boolean {
    const during = this.ports.busy();
    if (!during) { this.noted.clear(); return false; }
    this.note(what, during);
    this.watch();
    return true;
  }

  /** Looks until she is quiet (then what waited runs and the busy stretch ends). */
  private watch(): void {
    if (this.stopPoll) return;
    this.since = (this.ports.now ?? Date.now)();
    this.stopPoll = this.ports.every(this.ports.pollMs ?? 250, () => this.look());
  }

  private note(what: SettingDeferral, during: DeferredWhile): void {
    if (this.noted.has(what)) return;
    this.noted.add(what);
    try { this.ports.note?.(what, during); } catch { /* the journal never holds a change */ }
  }

  /** You cut in (a new message): what waited runs now, before the new turn starts. */
  flush(): Promise<void> {
    const items = this.take();
    return items.reduce<Promise<void>>((done, item) => done.then(() => item.action()).catch(() => {}), Promise.resolve());
  }

  /** The app is quitting: what waited is dropped (the settings are saved already; nothing is lost but the restart). */
  cancel(): void { this.take(); }

  private look(): void {
    const capped = (this.ports.now ?? Date.now)() - this.since >= (this.ports.capMs ?? 10 * 60_000);
    if (this.ports.busy() && !capped) return;
    void this.flush();
  }

  private take(): Waiting[] {
    this.stopPoll?.(); this.stopPoll = null;
    this.noted.clear(); // the busy stretch is over (quiet, you cut in, the cap, or quitting)
    const items = this.waiting; this.waiting = [];
    return items;
  }
}
