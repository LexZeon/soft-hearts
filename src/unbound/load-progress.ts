/**
 * The Unbound page's side of the entry's wait (shared/unbound/entry-wait.ts, docs/claude/2026-11-19-unbound-entry-load.md): tells
 * the host how far her first load has got, so a slow but moving load is not cut off at a flat 20 s. Each new step is sent at once;
 * bytes of the model file at most every `gapMs`. After `finish` nothing more is sent. Sending never throws into the load.
 */
import type { LoadProgress, LoadStep } from '../../shared/unbound/entry-wait';

export class LoadReporter {
  private lastBytesAt = -Infinity;
  private over = false;
  constructor(private readonly send: (progress: LoadProgress) => Promise<unknown> | void, private readonly now: () => number = () => performance.now(), private readonly gapMs = 250) {}

  step(step: LoadStep): void { this.emit({ step }); }

  /** Bytes of the file being read now (the loader's onProgress). */
  bytes(step: LoadStep, loaded: number, total?: number): void {
    const at = this.now();
    if (at - this.lastBytesAt < this.gapMs) return;
    this.lastBytesAt = at;
    this.emit(total && total > 0 ? { step, loaded, total } : { step, loaded });
  }

  finish(): void { this.over = true; }

  private emit(progress: LoadProgress): void {
    if (this.over) return;
    try { void Promise.resolve(this.send(progress)).catch(() => { /* a report only */ }); } catch { /* a report only */ }
  }
}
