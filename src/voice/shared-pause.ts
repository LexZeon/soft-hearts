/**
 * I-189: two owners may pause her reading now: B06 feeding (src/initiative/feed-speech-pause.ts) and the user turning away
 * (src/voice/away-read-pause.ts). Each holds the same targets (her voice, the reply's reveal, her bubble). This joins them: the targets
 * pause when the first owner holds and resume only when the last one lets go, so one owner's resume never starts her talking over
 * the other's pause. Pure (no DOM).
 *
 * `release` (a system-voice feeding cue needs the engine): honoured when it comes with the first hold; a later owner asking for it while
 * another already holds is not upgraded (her voice is already quiet; the cue then waits for the engine like any other system utterance).
 */
/** The same shape as FeedSpeechPause's targets (VoiceOutput, the reply reveal, her bubble). */
export interface PausableSpeech { pause(release?: boolean): void; resume(): void }

export class SharedPause {
  private readonly holders = new Set<string>();
  constructor(private readonly targets: readonly PausableSpeech[]) {}

  /** A handle that looks like one target to its owner. */
  as(owner: string): PausableSpeech {
    return { pause: release => this.hold(owner, release === true), resume: () => this.free(owner) };
  }

  get held(): boolean { return this.holders.size > 0; }
  holds(owner: string): boolean { return this.holders.has(owner); }

  hold(owner: string, release = false): void {
    if (this.holders.has(owner)) return;
    const first = this.holders.size === 0;
    this.holders.add(owner);
    if (first) for (const target of this.targets) { try { target.pause(release); } catch { /* one target never stops the others */ } }
  }

  free(owner: string): void {
    if (!this.holders.delete(owner) || this.holders.size) return;
    for (const target of this.targets) { try { target.resume(); } catch { /* as above */ } }
  }
}
