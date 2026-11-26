/**
 * Per-sentence timing of one reply. The reading rows
 * said how long the first sound took and how the reply ended, never which sentence was slow. This collects, from the per-segment records the
 * companion window already sends (shared/voice/speech-diagnostics.ts), for each spoken sentence:
 *   - synthMs: how long the voice service took to give the first sound of it (request sent -> first audio arrived; the host's own
 *     number when the window's stages are missing);
 *   - silenceMs: the silence before it played, the synthesis time beyond the previous sentence's playback (the previous one ended ->
 *     this one's first sound; the window measured it);
 *   - the provider and how that sentence ended.
 * Numbers and closed words only. The prefetch depth is not touched here (the user decides that later).
 */
import { READING_SEGMENTS_MAX, type ReadingSegmentsFields, type ReadingSegmentTiming } from '../../shared/voice/voice-gaps-journal';
import type { SpeechDiagnosticRecord } from '../../shared/voice';

export type SegmentTimingRecord = Pick<SpeechDiagnosticRecord, 'provider' | 'outcome' | 't'> & Partial<Pick<SpeechDiagnosticRecord, 'hostFirstAudioMs' | 'interSegmentGapMs'>>;

/** One sentence's numbers from its record. */
export function segmentTiming(record: SegmentTimingRecord): ReadingSegmentTiming {
  const { request, firstPacket } = record.t;
  const window = request !== undefined && firstPacket !== undefined ? Math.max(0, firstPacket - request) : null;
  return { synthMs: window ?? record.hostFirstAudioMs ?? null, silenceMs: record.interSegmentGapMs ?? null, provider: record.provider, outcome: record.outcome };
}

export class SegmentTimings {
  private list: ReadingSegmentTiming[] = [];
  /** A sentence's record arrived (the first READING_SEGMENTS_MAX of a reply are kept). */
  add(record: SegmentTimingRecord): void { if (this.list.length < READING_SEGMENTS_MAX) this.list.push(segmentTiming(record)); }
  /** The reply's list (and forget it); null when nothing was measured (the system voice measures nothing, a reply that never reached the voice has no sentences). */
  take(reply: number | null): ReadingSegmentsFields | null {
    const segments = this.list;
    this.list = [];
    if (!segments.some(s => s.synthMs !== null || s.silenceMs !== null)) return null;
    return { ...(reply === null ? {} : { reply }), segments };
  }
  clear(): void { this.list = []; }
}
