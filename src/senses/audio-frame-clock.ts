// I-187 陪看深度修: when each block of the computer's sound really ended, for the clip cutter (src/senses/ambient-audio-segments.ts).
//
// The system-audio tap is a ScriptProcessor whose callbacks run on the companion window's main thread. They used to be stamped with
// performance.now() at delivery: a busy frame (a 300-500 ms stall happens while the stage renders, a model loads or a reply streams)
// delivered the next blocks late, the cutter saw a "gap" over 250 ms and threw away the clip it was building — up to 12 s of dialogue
// each time, silently. The blocks themselves are continuous: the audio clock (AudioProcessingEvent.playbackTime) moves exactly one
// block per block. This maps that clock onto performance.now() with the smallest delivery delay seen, so a late delivery keeps its
// true time, and a real hole (lost blocks, a suspended context, a clock that drifted more than `resyncMs`) still shows as a gap.

export const AUDIO_FRAME_CLOCK_KNOBS = Object.freeze({
  /** A block whose mapped time lags its delivery by more than this re-anchors (the cutter then sees a gap and starts over). */
  resyncMs: 2000,
});

export class AudioFrameClock {
  /** performance.now() minus the audio clock, the smallest seen (the least delayed delivery). */
  private offset: number | null = null;
  private lastEnd = Number.NEGATIVE_INFINITY;

  constructor(private readonly knobs = AUDIO_FRAME_CLOCK_KNOBS) {}

  /**
   * The end of one block on the performance.now() clock. `playbackTime` is the event's audio-clock time (seconds); a missing or
   * non-finite one falls back to the delivery time, as before. Always increasing.
   */
  frameEnd(playbackTime: number | undefined, frames: number, sampleRate: number, deliveredAt: number): number {
    let end = deliveredAt;
    if (typeof playbackTime === 'number' && Number.isFinite(playbackTime) && playbackTime >= 0 && frames > 0 && sampleRate > 0 && Number.isFinite(deliveredAt)) {
      const audioEnd = playbackTime * 1000 + frames / sampleRate * 1000;
      const seen = deliveredAt - audioEnd;
      if (this.offset === null || seen < this.offset) this.offset = seen;
      end = audioEnd + this.offset;
      if (deliveredAt - end > this.knobs.resyncMs) { this.offset = seen; end = deliveredAt; }
    }
    if (end <= this.lastEnd) end = this.lastEnd + 0.001;
    this.lastEnd = end;
    return end;
  }

  reset(): void { this.offset = null; this.lastEnd = Number.NEGATIVE_INFINITY; }
}
