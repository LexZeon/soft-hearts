/**
 * 2026-11-10 face/head twitch (docs/claude/2026-11-10-face-head-twitch.md): the stage's "she is speaking" flag comes
 * straight from the voice output's lip-sync callback. Streamed speech (Bailian, src/voice/EmotionalVoice.ts) closes it every
 * time its queue runs dry for a moment (`silence()`: the next chunk was late, or the next sentence is still being
 * synthesised) and opens it again ~30 ms after the next chunk lands. So one reply's flag flickers: off for 50–150 ms
 * several times a second.
 *
 * Every owner that gives way to speech followed each flicker: the procedural lip-sync shut the mouth half way and opened
 * it again within 0.1 s, the mood's mouth smile (procedural life speechOwner: back in 0.35 s, away in 0.08 s) blinked
 * back between syllables, her own activity and the reply-thinking head started to come back and were sent away again, and
 * a mouth face shape could start in the gap and be handed back a frame later. Seen as the mouth, the face and the head
 * twitching ("抽搐") while she talks and right around it.
 *
 * This keeps one answer per frame for two readers:
 *  - `mouth` / `flap`: the lip-sync keeps moving through a gap shorter than SPEECH_HOLD_S.mouth (a stall inside a word is
 *    not a pause); a longer gap ends the syllable: `flap` (the lip-sync's size) eases from 1 to 0 over SPEECH_HOLD_S.fade
 *    (smootherstep), so the mouth closes from wherever it was without a jump, as before only a little later.
 *  - `owner`: the owners that give way to speech (procedural life's mouth and gaze, her own activity, reply thinking,
 *    a new mouth face shape, new body motions, the music nod) keep treating her as speaking through a gap shorter than
 *    SPEECH_HOLD_S.owner. It stays below the host's quiet window for a waiting mouth shape (electron/brain/chat-actions-host.ts
 *    CHAT_ACTION_AFTER_SPEECH_MS, 500 ms), so a pout the host sends after she finished is never refused for this.
 * Speech starting is never delayed: `true` is seen on the same frame. Pure, allocation-free.
 */
export const SPEECH_HOLD_S = Object.freeze({ mouth: 0.12, fade: 0.2, owner: 0.4 });
const smoother = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (t * 6 - 15) + 10); };

export class SpeechHold {
  /** Seconds since the flag was last seen true; Infinity before any speech. */
  private quiet = Infinity;
  /** Raw flag seen true since the last frame (a flicker shorter than one frame still counts). */
  private pulse = false;
  readonly out = { mouth: false, flap: 0, owner: false };

  /** The raw flag changed (between frames). A true seen here holds even if it is false again by the next frame. */
  note(speaking: boolean): void { if (speaking) { this.pulse = true; this.quiet = 0; } }

  /** One rendered frame with the current raw flag. */
  frame(delta: number, speaking: boolean): Readonly<{ mouth: boolean; flap: number; owner: boolean }> {
    const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.25) : 0;
    if (speaking || this.pulse) this.quiet = 0;
    else this.quiet += dt;
    this.pulse = false;
    this.out.flap = speaking ? 1 : 1 - smoother((this.quiet - SPEECH_HOLD_S.mouth) / SPEECH_HOLD_S.fade);
    this.out.mouth = this.out.flap > 0;
    this.out.owner = speaking || this.quiet < SPEECH_HOLD_S.owner;
    return this.out;
  }

  /** Nothing on screen (hidden window, another model): no hold carries over. */
  reset(): void { this.quiet = Infinity; this.pulse = false; this.out.mouth = this.out.owner = false; this.out.flap = 0; }
}
