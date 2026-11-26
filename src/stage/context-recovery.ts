// 显卡重置后她自己回来 (docs/claude/2026-11-22-gpu-reset.md): what a WebGL stage does when its context is lost and comes back.
// Every stage that draws her (the desktop stage src/stage/MmdStage.ts, the window engine src/unbound/window-mode/window-stage.ts, the
// full-screen Unbound page src/unbound/main.ts) attaches one of these to its canvas.
//
// - Lost: `preventDefault()` (without it the browser never gives the context back), then the stage's own `lost` step (stop what only makes
//   sense while drawing). Nothing is shown yet: a driver reset usually gives the context back within a second or two (measured: 0.2 s after
//   each GPU process crash once the host lifted Chromium's limits, electron/foundation/gpu-reset/), so she only flickers.
// - Restored: three.js rebuilds its own GL state on the same event (WebGLRenderer onContextRestore) and uploads her again from the CPU copies
//   on the next frame; the stage's `restored` step drops what it kept of the old context (pixel read-back buffers) and asks for a frame.
// - Still lost after `stuckMs`: the stage's `stuck` step (the old message, "显卡上下文已丢失…"); if the context comes back after all,
//   `recovered` clears it. The page is never reloaded here (a reload would end the chat on screen and a running call).
// Pure apart from the canvas it listens to; timers are injected for tests (tests/gpu-reset-stage.test.ts).

export const CONTEXT_RECOVERY = Object.freeze({
  /** How long a lost context may take to come back before the stage says so. */
  stuckMs: 8_000,
});

export interface ContextRecoveryTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface ContextRecoveryPorts {
  /** The context is gone (she is not drawn now). */
  lost?(): void;
  /** The context is back: drop GL objects made on the old one, ask for a frame. */
  restored?(): void;
  /** Still lost after `stuckMs`. */
  stuck?(): void;
  /** Back after `stuck` was told. */
  recovered?(): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class StageContextRecovery {
  private lostNow = false;
  private stuckTold = false;
  private timer: unknown = null;
  private disposed = false;
  /** Counts for diagnostics (never shown to the user). */
  readonly counts = { lost: 0, restored: 0, stuck: 0 };

  constructor(private readonly target: ContextRecoveryTarget, private readonly ports: ContextRecoveryPorts = {}, private readonly knobs = CONTEXT_RECOVERY) {
    target.addEventListener('webglcontextlost', this.onLost);
    target.addEventListener('webglcontextrestored', this.onRestored);
  }

  get lost(): boolean { return this.lostNow; }

  readonly onLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed || this.lostNow) return;
    this.lostNow = true;
    this.counts.lost++;
    this.call(this.ports.lost);
    this.clear();
    const set = this.ports.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = null;
      if (this.disposed || !this.lostNow || this.stuckTold) return;
      this.stuckTold = true;
      this.counts.stuck++;
      this.call(this.ports.stuck);
    }, this.knobs.stuckMs);
  };

  readonly onRestored = (): void => {
    if (this.disposed || !this.lostNow) return;
    this.lostNow = false;
    this.counts.restored++;
    this.clear();
    this.call(this.ports.restored);
    if (this.stuckTold) { this.stuckTold = false; this.call(this.ports.recovered); }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.target.removeEventListener('webglcontextlost', this.onLost);
    this.target.removeEventListener('webglcontextrestored', this.onRestored);
  }

  private clear(): void {
    if (this.timer === null) return;
    (this.ports.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private call(step: (() => void) | undefined): void {
    try { step?.(); } catch { /* one stage step never stops the others */ }
  }
}
