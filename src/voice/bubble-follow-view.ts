/**
 * I-165: the companion window's side of "her bubble
 * follows her voice". One per window (src/wiring/bubble-follow-wiring.ts); only the companion window applies it, to its native reply bubble
 * (its setVoiceCap). The state machine is shared/voice/bubble-follow/follow.ts; this adds the clock and the timer.
 *
 * - `engage(id)`: the reply is read aloud through the sentence plan (chat-wiring startStreamingReplySpeech): hold its text, "……" first.
 * - `segment(lease)`: the host's sentence lease (desk:reply-speech-segment): where that sentence ends.
 * - `heard(fact)`: the reading window's voice (src/voice/VoiceOutput.ts onSegmentHeard, here or over the speech channel).
 * - `over(id, why)`: the reading ended, was cancelled, failed or was interrupted: everything shows now and stays shown.
 * - `pause()`/`resume()`: B06 feeding pauses her voice; the stall clocks wait with it (a FeedSpeechPause target).
 * Presentation only: it decides how much of her own reply's text the bubble shows, never what is read or proven.
 */
import { BubbleFollow, type BubbleFollowRelease, type BubbleHeardPhase } from '../../shared/voice/bubble-follow';
import type { BubbleFollowMode } from '../../shared/voice/bubble-follow';

export interface BubbleFollowViewPorts {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The companion's bubble shows reply `id` up to `cap` (null: all of it, for good). */
  apply(id: string, cap: number | null): void;
  /** Read once per reply when it is engaged (the knob; tests pass their own). */
  mode?(): BubbleFollowMode;
}

export class BubbleFollowView {
  private readonly follow = new BubbleFollow();
  private timer: unknown = null;
  private applied: { id: string; cap: number | null } | null = null;
  constructor(private readonly ports: BubbleFollowViewPorts) {}

  /** The reply whose text is held back now, or null. */
  get holding(): string | null { const id = this.follow.replyId; return id && this.follow.holding(id) ? id : null; }
  /** How much of reply `id` may show now (null: all of it). */
  cap(id: string | null | undefined): number | null { return this.follow.cap(id, this.ports.now()); }

  engage(id: string): void {
    let mode: BubbleFollowMode | undefined;
    try { mode = this.ports.mode?.(); } catch { mode = 'off'; }
    if (this.follow.replyId === id) return;
    if (!this.follow.begin(id, this.ports.now(), mode)) return;
    this.sync();
  }
  segment(lease: unknown): void {
    const value = lease as { replyId?: unknown; index?: unknown; visibleText?: unknown } | null;
    if (!value || typeof value.replyId !== 'string' || typeof value.visibleText !== 'string' || typeof value.index !== 'number') return;
    this.follow.segment(value.replyId, value.index, value.visibleText.length, this.ports.now());
    this.sync();
  }
  heard(fact: unknown): void {
    const value = fact as { replyId?: unknown; segmentIndex?: unknown; phase?: unknown } | null;
    if (!value || typeof value.replyId !== 'string' || typeof value.segmentIndex !== 'number'
      || (value.phase !== 'start' && value.phase !== 'end' && value.phase !== 'skip')) return;
    this.follow.heard(value.replyId, value.segmentIndex, value.phase as BubbleHeardPhase, this.ports.now());
    this.sync();
  }
  over(id: string | null | undefined, why: BubbleFollowRelease = 'over'): void {
    if (!id || !this.follow.release(id, why)) return;
    this.sync();
  }
  pause(): void { this.follow.pause(this.ports.now()); this.sync(); }
  resume(): void { this.follow.resume(this.ports.now()); this.sync(); }

  private sync(): void {
    if (this.timer !== null) { this.ports.clearTimer(this.timer); this.timer = null; }
    const id = this.follow.replyId;
    if (!id) return;
    const now = this.ports.now(), cap = this.follow.cap(id, now);
    if (!this.applied || this.applied.id !== id || this.applied.cap !== cap) {
      this.applied = { id, cap };
      try { this.ports.apply(id, cap); } catch { /* presentation only */ }
    }
    if (cap === null) return;
    const next = this.follow.nextChange(now);
    if (next !== null) this.timer = this.ports.setTimer(() => { this.timer = null; this.sync(); }, Math.max(0, next - now));
  }
}
