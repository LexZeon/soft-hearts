/**
 * The one owner of the control window's background throttling while she is out in full screen (2026-11-23, answering
 * whether the hidden control window should also not be throttled while she answers in full screen).
 *
 * Her reply, the pacing of its bubble and the read-aloud all run in the control window, which is hidden while she is out; Electron throttles a
 * hidden window (a 2 s timer ran after 4-21 s, measured), so her answer would stutter. Rather than chase each edge (line handed over, reply
 * streaming, bubble hold, read-aloud, a line she says on her own, a call), the rule is simple: the window is not throttled while she is out
 * (entering or in Unbound) or while a line from her box is on its way, and it is put back the moment neither holds.
 *
 * Reference-counted: each reason is a named hold (`hold` returns its release; releasing twice is harmless). Throttling is on again when the
 * last hold ends, and `releaseAll` (quit, a crash path) puts it back whatever is held. This is the only place that calls setBackgroundThrottling
 * for the control window. Ports only: tests drive it with a fake window.
 */
export interface ThrottledWindow { isDestroyed(): boolean; webContents: { setBackgroundThrottling(allowed: boolean): void } }

export interface ControlAwake {
  /** A reason to keep the window awake; the returned function ends it (once). */
  hold(reason: string): () => void;
  /** Whether a reason is held now. */
  held(reason: string): boolean;
  /** Re-applies the current state to the window (it may have been recreated with throttling on). */
  refresh(): void;
  /** Ends every hold and puts throttling back. */
  releaseAll(): void;
  /** How many holds are open (tests, diagnostics). */
  readonly count: number;
}

export function createControlAwake(controls: () => ThrottledWindow | null): ControlAwake {
  const holds = new Map<string, number>();
  let applied: boolean | null = null; let appliedTo: ThrottledWindow | null = null;
  const total = () => { let n = 0; for (const v of holds.values()) n += v; return n; };
  const apply = () => {
    const awake = total() > 0;
    let win: ThrottledWindow | null = null;
    try { win = controls(); } catch { win = null; }
    if (!win || win.isDestroyed()) { appliedTo = null; applied = null; return; }
    if (win === appliedTo && awake === applied) return;
    try { win.webContents.setBackgroundThrottling(!awake); appliedTo = win; applied = awake; } catch { /* a closing window */ }
  };
  return {
    hold(reason) {
      holds.set(reason, (holds.get(reason) ?? 0) + 1); apply();
      let done = false;
      return () => {
        if (done) return; done = true;
        const n = (holds.get(reason) ?? 1) - 1; if (n > 0) holds.set(reason, n); else holds.delete(reason);
        apply();
      };
    },
    held: reason => (holds.get(reason) ?? 0) > 0,
    refresh: apply,
    releaseAll() { holds.clear(); apply(); },
    get count() { return total(); },
  };
}

/** Unbound's mode as a hold: out (entering or unbound) keeps the control window awake; back to normal puts it back. */
export function followUnboundMode(awake: ControlAwake): (state: 'normal' | 'entering' | 'unbound') => void {
  let release: (() => void) | null = null;
  return state => {
    if (state === 'normal') { release?.(); release = null; return; }
    release ??= awake.hold('out-in-unbound');
  };
}

/** The ledger's awake port (electron/unbound/say-ack.ts): open lines are one hold, however many; none open ends it. */
export function lineAwake(awake: ControlAwake | null): (on: boolean) => void {
  let release: (() => void) | null = null;
  return on => {
    if (on) release ??= awake?.hold('line') ?? null;
    else { release?.(); release = null; }
  };
}
