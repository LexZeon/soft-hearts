/**
 * 2026-11-20: one of her short sounds in a call moves her mouth for exactly as long as it sounds.
 *
 * The sound itself is played by CallControls' FillerPlayer; this says when it really sounds and when it stopped, as a mouth scale
 * (shared/behaviors/voice-call/mouth.ts) given to a sink that tells every stage that shows her (this window's stage, the other
 * window, the full-screen Unbound page: src/wiring/voice-wiring.ts fillerMouth). Pure: no DOM, no audio.
 *
 * - The mouth starts when the sound starts (a clip: at once; the system voice: the utterance's own start, which may be later than
 *   the request, or never when it fails: then no mouth either) and ends when the sound ends.
 * - A newer sound replaces an older one; the older one's late end never clears the newer one's mouth.
 * - release() (her real reply sounds, a barge-in, a hang-up) clears it at once.
 * - Nothing here can break the sound: a sink that throws is ignored.
 */
import type { CallFillerId } from '../../../shared/voice/voice-call';
import { fillerMouthScale } from '../../../shared/behaviors/voice-call/mouth';

export interface FillerSounding {
  /** Resolves when the sound is really coming out (absent: it already is). */
  began?: Promise<void>;
  /** Resolves when the sound is over, for any reason. */
  ended: Promise<void>;
}

export class FillerMouthSignal {
  private token = 0;
  private shown: number | null = null;
  private last: number | null = null;
  constructor(private readonly sink: (shape: number | null) => void, private readonly random: () => number = Math.random) {}

  /** A sound was started. */
  attach(id: CallFillerId, sounding: FillerSounding): void {
    this.release();
    const token = ++this.token, shape = fillerMouthScale(id, this.random, this.last);
    this.last = shape;
    void (sounding.began ?? Promise.resolve()).then(() => { if (token === this.token) this.show(shape); }, () => {});
    void sounding.ended.then(() => { if (token === this.token) this.release(); }, () => { if (token === this.token) this.release(); });
  }

  /** Stop at once (the reply's first sound, a barge-in, a hang-up). */
  release(): void {
    this.token++;
    if (this.shown !== null) { this.shown = null; this.emit(null); }
  }

  get active(): boolean { return this.shown !== null; }

  private show(shape: number): void { this.shown = shape; this.emit(shape); }
  private emit(shape: number | null): void { try { this.sink(shape); } catch { /* the mouth never breaks the sound */ } }
}
