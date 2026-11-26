/**
 * Lip-sync / speech-yield state for one stage, kept per writer.
 *
 * The companion stage hears "speaking" from two independent owners: its own window's
 * voice output and the other window's output (relayed over a BroadcastChannel).
 * Each owner reports `false` on every stop, even when it was not the one
 * speaking. With a single shared boolean the last writer wins, so one window's
 * stop/cancel cut the other window's live speech presentation, and a lost
 * `false` could leave the stage stuck. Each owner now only clears its own flag.
 */
/** 'filler': her short sounds in a call (src/voice/voice-call/filler-mouth.ts); a reply's end never clears it and its end never clears a reply. */
export type SpeakingSource = 'local' | 'remote' | 'filler';

import { MouthScale } from '../../shared/behaviors/voice-call/mouth';

export class SpeakingSources {
  private readonly active: Record<SpeakingSource, boolean> = { local: false, remote: false, filler: false };
  /** The flap's scale for this stage's mouth (2026-11-20): 1 for a reply, a short sound's own while only it sounds (shared/behaviors/voice-call/mouth.ts). */
  readonly scale = new MouthScale();

  /** Returns the merged state after applying one owner's report. `shape`: a short sound's mouth scale (only for 'filler'). */
  set(source: SpeakingSource, value: boolean, shape?: number): boolean {
    if (source === 'local' || source === 'remote' || source === 'filler') this.active[source] = value === true;
    if (source === 'filler') this.scale.setFiller(value === true ? shape ?? 0.5 : null);
    this.scale.setReply(this.reply);
    return this.speaking;
  }

  get speaking(): boolean { return this.active.local || this.active.remote || this.active.filler; }
  /** A reply (not a short sound) is speaking: the mouth's scale is 1 then. */
  get reply(): boolean { return this.active.local || this.active.remote; }

  /** Window teardown or scope loss: no owner may keep the stage speaking. */
  clear(): void { this.active.local = false; this.active.remote = false; this.active.filler = false; this.scale.reset(); }
}
