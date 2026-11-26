/**
 * 2026-11-20: her short sounds in a call move her mouth for exactly as long as they sound.
 *
 * The mouth of a reply follows the voice output's "she is speaking" flag through the speech hold and the flap
 * (src/voice/speech-hold.ts, src/stage/mmd/idle.ts, src/unbound/mouth.ts). A short sound goes the same way as a second, separate source
 * ('filler': a reply's end can never clear it and its end can never clear a reply) with one more number: how wide that sound opens.
 * 啊 / 哦 / 诶 open the mouth; 嗯 / 唔 stay nearly closed and only hum. The number is a scale on the flap, eased, so a reply that
 * follows takes the mouth over without a jump.
 *
 * No real audio level: the system voice has none to read, and the reply's own lip-sync is a flap too, so the short sounds look the
 * same kind of mouth as her replies. The clip's length is exact (cached clips) or the utterance's own start / end (system voice).
 *
 * Pure. Used by both window stages, the full-screen Unbound page and the call controls.
 */
import type { CallFillerId } from '../../voice/voice-call';

export type FillerMouthKind = 'open' | 'hum';

/** What each sound does to the mouth: an open vowel or a closed hum (the texts are in shared/voice/voice-call.ts CALL_FILLER_TEXT). */
export const FILLER_MOUTH_KIND: Readonly<Record<CallFillerId, FillerMouthKind>> = Object.freeze({
  mm: 'hum', mmmm: 'hum', eh: 'open', en: 'hum', oh: 'open', wu: 'hum', ahmm: 'open',
});

/**
 * How wide each kind opens, as a scale on the flap (a reply is 1). A range, not a number: every time a different value inside it
 * (personality, not a table), so two 嗯 in a row are never the same mouth. Fallback ranges only; the kinds themselves are physics.
 */
export const FILLER_MOUTH_SCALE: Readonly<Record<FillerMouthKind, readonly [number, number]>> = Object.freeze({
  open: [0.7, 0.95], hum: [0.2, 0.34],
});
/** How fast the scale moves (per second) when the mouth is already showing: a filler into a reply, a reply into a filler. */
export const MOUTH_SCALE_RATE = 8;
/** Below this the mouth counts as closed: a new scale may be taken at once (nothing visible to jump). */
export const MOUTH_CLOSED_BELOW = 0.02;

/** This sound's mouth scale (0.2..0.95). `last`: the scale of the previous one; a value too close to it is taken again once. */
export function fillerMouthScale(id: CallFillerId, random: () => number = Math.random, last: number | null = null): number {
  const [low, high] = FILLER_MOUTH_SCALE[FILLER_MOUTH_KIND[id] ?? 'hum'];
  const pick = () => low + (high - low) * Math.min(1, Math.max(0, random()));
  let value = pick();
  if (last !== null && Math.abs(value - last) < (high - low) * 0.2) value = pick();
  return value;
}

/** A shape that came over a channel (IPC, BroadcastChannel): a number in 0..1, or null for "stopped"; anything else is "stopped". */
export function sanitizeFillerShape(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(1, value) : null;
}

/**
 * The flap's scale for one stage: 1 for a reply, the sound's own while only a short sound sounds, and the last one kept while the
 * mouth is fading shut (so it never grows back to 1 as it closes). Eased, except while the mouth is closed.
 */
export class MouthScale {
  private reply = false;
  private filler: number | null = null;
  private target = 1;
  private value = 1;

  setReply(active: boolean): void { this.reply = active === true; }
  /** A short sound began (its scale) or ended (null). */
  setFiller(shape: number | null): void { this.filler = shape === null ? null : sanitizeFillerShape(shape) ?? 0.5; }
  /** The scale for this frame. `mouth`: how open the mouth was on the last frame. */
  frame(delta: number, mouth: number): number {
    if (this.reply) this.target = 1;
    else if (this.filler !== null) this.target = this.filler;
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.25) : 0;
    this.value = mouth < MOUTH_CLOSED_BELOW ? this.target : this.value + (this.target - this.value) * (1 - Math.exp(-MOUTH_SCALE_RATE * dt));
    return this.value;
  }
  reset(): void { this.reply = false; this.filler = null; this.target = 1; this.value = 1; }
}
