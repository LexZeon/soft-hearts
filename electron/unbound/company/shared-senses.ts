/**
 * I-209 step 3 (plan v4, 按建议: "'看你一眼'台上的人共用一次，看到的那句话每人都有"): what the characters on stage sense, they sense once.
 * No sense opens because a second character came out; nobody on stage takes her own look.
 *
 *  - SharedLook: one look for everyone on stage. Whoever asks first runs it (the camera-derived readings, a haiku look); everyone who asks
 *    while it runs, or within `freshMs` after it, gets the same answer. A failed look is not kept (the next ask runs again).
 *  - SharedFullscreen: one watcher of the program in front (one PowerShell poll), however many hosts listen; it starts with the first
 *    listener and stops with the last.
 */
import type { FullscreenProbe, FullscreenReading } from '../fullscreen-watch';

export class SharedLook<T> {
  private running: Promise<T> | null = null;
  private kept: { at: number; value: T } | null = null;
  private calls = 0;
  constructor(private readonly look: () => Promise<T> | T, private readonly clock: () => number = Date.now, private readonly freshMs = 1_000) {}

  /** The look everyone on stage gets now. */
  read(): Promise<T> {
    const now = this.clock();
    if (this.kept && now - this.kept.at < this.freshMs) return Promise.resolve(this.kept.value);
    if (this.running) return this.running;
    this.calls++;
    const run = Promise.resolve().then(() => this.look());
    this.running = run.then(value => { this.kept = { at: this.clock(), value }; return value; }).finally(() => { if (this.running === tracked) this.running = null; });
    const tracked = this.running;
    return tracked;
  }

  /** The same for a reading that never waits (the once-a-second life readings): the kept value within `freshMs`, else read now. */
  now(read: () => T): T {
    const at = this.clock();
    if (this.kept && at - this.kept.at < this.freshMs) return this.kept.value;
    this.calls++;
    const value = read();
    this.kept = { at, value };
    return value;
  }

  /** How many looks were really taken (tests, diagnostics). */
  get taken(): number { return this.calls; }
}

export class SharedFullscreen {
  private readonly listeners = new Set<(value: FullscreenReading) => void>();
  private last: FullscreenReading | null = null;
  constructor(private readonly probe: FullscreenProbe | undefined) {}

  /** One host's view of it (the host-ports' `fullscreen`). `after`: told after every listener (the stage re-sorts the windows after a raise). */
  probeFor(): FullscreenProbe | undefined {
    if (!this.probe) return undefined;
    let mine: ((value: FullscreenReading) => void) | null = null;
    return {
      start: reading => {
        if (mine) this.listeners.delete(mine);
        mine = reading;
        this.listeners.add(reading);
        if (this.listeners.size === 1) this.probe!.start(value => this.tell(value));
        else if (this.last) { const value = this.last; queueMicrotask(() => { if (mine === reading) reading(value); }); }
      },
      stop: () => {
        if (!mine) return;
        this.listeners.delete(mine); mine = null;
        if (!this.listeners.size) { this.probe!.stop(); this.last = null; }
      },
    };
  }

  /** Told after each reading reached every host (the stage puts the windows back in depth order after a raise). */
  after: ((value: FullscreenReading) => void) | null = null;

  private tell(value: FullscreenReading): void {
    this.last = value;
    for (const listener of [...this.listeners]) { try { listener(value); } catch (error) { console.error(error); } }
    try { this.after?.(value); } catch (error) { console.error(error); }
  }
}
