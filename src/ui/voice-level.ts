/**
 * How loud is "someone is speaking" for this microphone in this room, and is the microphone delivering anything at all.
 * (the one fixed level — 0.01, about -40 dBFS — was never crossed by a
 * quiet laptop array microphone, so no sentence was ever sent to recognition and nothing was said about it.)
 *
 * Pure, no DOM: src/ui/MediaInput.ts feeds it one chunk level at a time.
 */

/** The level every microphone had to cross before 2026-11-06; still the ceiling, so a noisy room is never treated more leniently. */
export const DEFAULT_SPEECH_LEVEL = 0.01;
/** Below this the gate would trigger on a microphone's own hiss (-50 dBFS); a floor of safety, not a tuning knob. */
const MIN_SPEECH_LEVEL = 0.003;

export function chunkRms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (let index = 0; index < samples.length; index++) energy += samples[index] * samples[index];
  return Math.sqrt(energy / samples.length);
}

/** Follows the room: a few times the quietest level recently heard between utterances, never above the old fixed level. */
export class SpeechLevelGate {
  private floor = DEFAULT_SPEECH_LEVEL / 4;
  get threshold(): number { return Math.min(DEFAULT_SPEECH_LEVEL, Math.max(MIN_SPEECH_LEVEL, this.floor * 4)); }
  /** `inUtterance`: speech is being collected, so this level says nothing about the room. */
  observe(rms: number, inUtterance: boolean): void {
    if (inUtterance || !(rms >= 0)) return;
    // Down quickly (a quieter room is believed at once), up slowly (a passing noise does not raise the bar).
    this.floor = rms < this.floor ? this.floor * 0.6 + rms * 0.4 : this.floor * 0.98 + rms * 0.02;
  }
}

/**
 * A microphone that delivers digital silence (muted, a virtual "stereo mix" with nothing playing, the wrong default device):
 * true exactly once, after `seconds` of audio whose loudest chunk stayed below `peak`. A real microphone in a quiet room
 * always has some hiss (about 0.001) and even a noise-suppressed quiet room is not exact zero (measured -84 dBFS, 2026-11-06), so
 * this fires only for essentially exact zeros (-94 dBFS), not for a merely quiet room. One real sound ends the doubt.
 */
export class SilenceWatch {
  private quiet = 0;
  private done = false;
  constructor(private readonly seconds = 8, private readonly peak = 0.00002) {}
  reset(): void { this.quiet = 0; this.done = false; }
  feed(rms: number, seconds: number): boolean {
    if (this.done) return false;
    if (rms >= this.peak) { this.done = true; return false; }
    this.quiet += seconds;
    if (this.quiet < this.seconds) return false;
    this.done = true;
    return true;
  }
}
