/**
 * I-091 step 1: while she reads aloud during a call, is the user starting to talk over her? Pure (no DOM): MediaInput feeds
 * it the microphone's chunks while her "speaking" flag is up.
 *
 * Her own voice comes back through the speakers into the microphone. Echo cancellation removes most of it; what is left must
 * not count. So the gate is the largest of: a fixed floor, a few times the room's speech gate, and a few times the echo level
 * learnt while she speaks (a slow follower that rises slowly, so a burst of the user's voice barely lifts it). The user is
 * talking when enough of the last short window was above that gate. True once per speaking episode.
 */
import { VOICE_CALL_KNOBS, type VoiceCallKnobs } from '../../../shared/behaviors/voice-call/knobs';
import { chunkRms } from '../voice-level';

export class BargeInDetector {
  private echo = 0;
  private heardMs = 0;
  private fired = false;
  private recent: { ms: number; voiced: boolean }[] = [];
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  constructor(private knobs: VoiceCallKnobs['bargeIn'] = VOICE_CALL_KNOBS.bargeIn) {}

  /** I-177 batch 2: this call's gate (with headphones lower: src/voice/voice-call/call-duck.ts callKnobsFor); none = the defaults. */
  use(knobs: VoiceCallKnobs['bargeIn'] | null | undefined): void { this.knobs = knobs ?? VOICE_CALL_KNOBS.bargeIn; }

  /** A new speaking episode (her reading started again): forget the echo and the window. */
  reset(): void { this.echo = 0; this.heardMs = 0; this.fired = false; this.recent = []; this.preroll = []; this.prerollSamples = 0; }

  /** The gate a chunk must reach now. */
  gate(roomThreshold: number): number {
    return Math.max(this.knobs.floor, roomThreshold * this.knobs.gateFactor, this.echo * this.knobs.echoFactor);
  }

  /**
   * One microphone chunk while she speaks. True exactly once, when the user is talking over her.
   * `speech` (I-099, the call's VAD): whether the chunk is a person speaking. Given, a chunk must pass the echo gate AND be
   * speech (a cough or a knock over the gate is not); undefined (no VAD answer), the gate alone decides, as before.
   */
  push(samples: Float32Array, sampleRate: number, roomThreshold: number, speech?: boolean): boolean {
    if (this.fired || !(sampleRate > 0) || !samples.length) return false;
    const ms = samples.length / sampleRate * 1000, level = chunkRms(samples);
    this.keep(samples, sampleRate);
    const learning = this.heardMs < this.knobs.learnMs;
    const gate = this.gate(roomThreshold), overGate = !learning && level >= gate, voiced = overGate && speech !== false;
    // The echo follower: up slowly, down a little faster; a chunk over the gate is not learnt as echo.
    if (!overGate) this.echo = level > this.echo ? this.echo + (level - this.echo) * (learning ? 0.5 : 0.08) : this.echo + (level - this.echo) * 0.15;
    this.heardMs += ms;
    this.recent.push({ ms, voiced });
    let span = this.recent.reduce((sum, item) => sum + item.ms, 0);
    while (this.recent.length > 1 && span - this.recent[0].ms >= this.knobs.windowMs) span -= this.recent.shift()!.ms;
    const loud = this.recent.reduce((sum, item) => sum + (item.voiced ? item.ms : 0), 0);
    if (loud < this.knobs.minVoicedMs) return false;
    this.fired = true;
    return true;
  }

  /** The last prerollMs of microphone audio (so the first words of the interruption reach recognition). */
  takePreroll(): Float32Array[] { const value = this.preroll; this.preroll = []; this.prerollSamples = 0; return value; }

  private keep(samples: Float32Array, sampleRate: number): void {
    this.preroll.push(samples.slice()); this.prerollSamples += samples.length;
    const limit = sampleRate * this.knobs.prerollMs / 1000;
    while (this.preroll.length > 1 && this.prerollSamples - this.preroll[0].length >= limit) this.prerollSamples -= this.preroll.shift()!.length;
  }
}
