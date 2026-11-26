/**
 * Read-aloud while she is out (docs/claude/2026-11-15-unbound-read-aloud.md): tells the host which text her reply bubble has
 * painted. Each frame that places the bubble `observe`s what that frame will draw; at the next animation frame (by then it has
 * been painted) `flush` sends it, once per change, in order. A hidden window runs no animation frames, so it reports nothing;
 * when it is shown again `reset` makes it say the current state once more (the host dropped its proof meanwhile).
 */
import type { UnboundShownReport } from '../../shared/unbound/shown';

export class ShownReporter {
  private pending: UnboundShownReport | null = null;
  private last = '';
  constructor(private readonly send: (report: UnboundShownReport) => void) {}

  /** After a frame placed the bubble: what that frame will paint (null: no bubble with a revision yet). */
  observe(state: UnboundShownReport | null): void { this.pending = state ? { ...state } : null; }

  /** At the next animation frame: the observed state is on screen now; send it if it differs from the last one sent. */
  flush(): void {
    const state = this.pending;
    if (!state) return;
    const key = JSON.stringify([state.id, state.rev, state.visible, state.text]);
    if (key === this.last) return;
    this.last = key;
    try { this.send({ ...state }); } catch { /* the host may be going; the next change reports again */ }
  }

  /** The window was hidden (or shown again): forget what was sent, so the next painted frame is reported again. */
  reset(): void { this.last = ''; }
}
