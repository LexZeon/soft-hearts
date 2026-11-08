/**
 * Lip-sync / speech-yield state for one stage, kept per writer.
 *
 * The pet stage hears "speaking" from two independent owners: its own window's
 * voice output and the other window's output (relayed over a BroadcastChannel).
 * Each owner reports `false` on every stop, even when it was not the one
 * speaking. With a single shared boolean the last writer wins, so one window's
 * stop/cancel cut the other window's live speech presentation, and a lost
 * `false` could leave the stage stuck. Each owner now only clears its own flag.
 */
export type SpeakingSource = 'local' | 'remote';

export class SpeakingSources {
  private readonly active: Record<SpeakingSource, boolean> = { local: false, remote: false };

  /** Returns the merged state after applying one owner's report. */
  set(source: SpeakingSource, value: boolean): boolean {
    if (source === 'local' || source === 'remote') this.active[source] = value === true;
    return this.speaking;
  }

  get speaking(): boolean { return this.active.local || this.active.remote; }

  /** Window teardown or scope loss: no owner may keep the stage speaking. */
  clear(): void { this.active.local = false; this.active.remote = false; }
}
