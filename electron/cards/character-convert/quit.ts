// I-071 v2 第三步 转换, quitting while a conversion runs (Codex X-435, 2026-11-12). Before this, `app.quit()` neither cancelled nor
// waited for a running conversion: its `claude -p` call could keep running (and spending) after the app was gone, and only the next
// start cleaned the data. Now `before-quit` holds the quit once: the conversion is cancelled exactly as the user's 「取消」 does
// (ConversionService.cancel → its AbortController → streamClaude's own stop → terminateClaude: taskkill /T /F on Windows), and the
// quit continues when the conversion has ended (the call settles only after its process closed) or after CONVERSION_QUIT_LIMIT_MS,
// whichever is first. No new kill path. Same shape as electron/senses/pose/quit-gate.ts; the two holds run side by side.
// What a quit leaves is what fix 8's recovery expects: a cancelled conversion that settled in time removed its own backup and
// marker; one that did not (still ending, or already saving, which a cancel no longer stops) leaves its marker, and the next start
// rolls it back (ConversionService.ensureRecovered).
export const CONVERSION_QUIT_LIMIT_MS = 3_000;

export interface ConversionQuitTarget {
  /** A conversion is running (translating or saving). */
  readonly running: boolean;
  /** The user's 「取消」 (false once saving began: then it finishes or rolls back by itself). */
  cancel(): boolean;
  /** Resolves once the running conversion has ended (its cleanup included). */
  idle(): Promise<void>;
}

export function createConversionQuitGate(target: () => ConversionQuitTarget | null, quit: () => void,
  setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms).unref?.(), limitMs = CONVERSION_QUIT_LIMIT_MS) {
  let state: 'open' | 'waiting' | 'done' = 'open';
  let ended: Promise<void> = Promise.resolve();
  return {
    /** Call from `before-quit`: true means "prevent this quit; it is called again once the conversion has ended (or the limit passed)". */
    hold(): boolean {
      if (state === 'done') return false;
      if (state === 'waiting') return true;
      let conversion: ConversionQuitTarget | null = null;
      try { conversion = target(); } catch { conversion = null; }
      if (!conversion?.running) { state = 'done'; return false; }
      state = 'waiting';
      try { conversion.cancel(); } catch { /* a cancel that throws still waits, bounded */ }
      let finished = false, release!: () => void;
      ended = new Promise<void>(resolve => { release = resolve; });
      const finish = () => { if (finished) return; finished = true; state = 'done'; release(); quit(); };
      let idle: Promise<void>;
      try { idle = Promise.resolve(conversion.idle()); } catch { idle = Promise.resolve(); }
      idle.then(finish, finish);
      setTimer(finish, limitMs);
      return true;
    },
    /** Resolves when the held conversion has ended or the limit passed (at once when nothing was held). */
    ended(): Promise<void> { return ended; },
  };
}
