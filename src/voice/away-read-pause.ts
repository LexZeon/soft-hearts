/**
 * I-189 #1: you turn away or walk out of the camera's view while she reads aloud → her reading pauses
 * where a sentence ends (her bubble stays as it is), and goes on when you face the screen again. If you stay away long, it ends quietly:
 * the rest stays in her bubble unread, and her next turn is told so (the host's line, after the 'ended' fact).
 *
 * The attention reading comes from the host (electron/senses/pose-uses/host.ts, via userGaze): sure readings only, held for
 * readPause.awaySeconds; a single low-confidence frame is 'unsure' there and never pauses anything. 'unsure' (sensing off, a stale
 * reading) while paused lets her go on: not knowing never keeps her quiet. A new reading, a stop or a new message cancels the pause.
 * Only her reply's sentences (the voice output's onSegmentHeard facts) pause here. Pure: injected ports, clock and timers.
 */
import { awayForReading, POSE_USES_KNOBS, type PoseUsesKnobs, type UserAttention } from '../../shared/senses';
import type { PausableSpeech } from './shared-pause';

export type AwayReadEvent = 'paused' | 'resumed' | 'ended';

export interface AwayReadPorts {
  /** Her voice, the reveal and her bubble together (SharedPause.as('away')). */
  pause: PausableSpeech;
  /** The latest attention reading (null: not known). */
  attention(): UserAttention | null;
  /** The reply being read aloud in this window now (null: none: the queue ended or never started). */
  reading(): string | null;
  /** End this reply's reading quietly: stop the voice, show the rest of her bubble. */
  end(replyId: string): void;
  now(): number;
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** One closed fact (the host journals it; 'ended' also gives her next turn a line). */
  fact?(event: AwayReadEvent, seconds?: number): void;
  knobs?: PoseUsesKnobs['readPause'];
}

export class AwayReadPause {
  private paused: { replyId: string; at: number } | null = null;
  private resumeTimer: unknown = null;
  private endTimer: unknown = null;
  /** Pauses and how they ended, for tests and the developer line. */
  readonly counts = { paused: 0, resumed: 0, ended: 0, cancelled: 0 };
  constructor(private readonly ports: AwayReadPorts) {}

  private get knobs(): PoseUsesKnobs['readPause'] { return this.ports.knobs ?? POSE_USES_KNOBS.readPause; }
  get active(): boolean { return this.paused !== null; }

  /** A sentence of her reply ended (or had nothing to say) in this window: the place to pause, if you are away now. */
  segment(fact: { replyId?: unknown; phase?: unknown } | null | undefined): void {
    if (this.paused || !fact || typeof fact.replyId !== 'string' || (fact.phase !== 'end' && fact.phase !== 'skip')) return;
    if (!awayForReading(this.read(() => this.ports.attention(), null), this.knobs)) return;
    if (this.read(() => this.ports.reading(), null) !== fact.replyId) return; // that reply is not being read here any more
    this.paused = { replyId: fact.replyId, at: this.ports.now() };
    this.counts.paused++;
    this.call(() => this.ports.pause.pause());
    this.call(() => this.ports.fact?.('paused'));
    this.endTimer = this.ports.timers.set(() => { this.endTimer = null; this.endQuietly(); }, this.knobs.endAfterSeconds * 1000);
  }

  /** A new attention reading (or any moment worth a look): back → go on after a short beat; still away → stay; reading gone → let go. */
  check(): void {
    const paused = this.paused;
    if (!paused) return;
    if (this.read(() => this.ports.reading(), null) !== paused.replyId) { this.release(null); return; } // nothing of it left to read
    if (awayForReading(this.read(() => this.ports.attention(), null), { ...this.knobs, awaySeconds: 0 })) { this.clearResume(); return; }
    if (this.resumeTimer !== null) return;
    this.resumeTimer = this.ports.timers.set(() => {
      this.resumeTimer = null;
      if (!this.paused || awayForReading(this.read(() => this.ports.attention(), null), { ...this.knobs, awaySeconds: 0 })) return;
      this.release('resumed');
    }, this.knobs.resumeDelayMs);
  }

  /** Her reading was stopped or replaced (a stop, a new message, a new line): the pause goes with it, nothing more. */
  cancel(): void {
    if (!this.paused) return;
    this.counts.cancelled++;
    this.release(null);
  }

  private endQuietly(): void {
    const paused = this.paused;
    if (!paused) return;
    if (this.read(() => this.ports.reading(), null) !== paused.replyId) { this.release(null); return; }
    const seconds = this.seconds(paused.at);
    this.paused = null; this.clearResume(); // first: end() stops her reading, which cancels here
    this.call(() => this.ports.end(paused.replyId));
    this.call(() => this.ports.pause.resume());
    this.counts.ended++;
    this.call(() => this.ports.fact?.('ended', seconds));
  }

  private release(event: 'resumed' | null): void {
    const paused = this.paused;
    if (!paused) return;
    this.paused = null;
    this.clearResume();
    if (this.endTimer !== null) { this.ports.timers.clear(this.endTimer); this.endTimer = null; }
    this.call(() => this.ports.pause.resume());
    if (event) { this.counts.resumed++; this.call(() => this.ports.fact?.(event, this.seconds(paused.at))); }
  }

  private clearResume(): void { if (this.resumeTimer !== null) { this.ports.timers.clear(this.resumeTimer); this.resumeTimer = null; } }
  private seconds(at: number): number { return Math.max(0, Math.round((this.ports.now() - at) / 1000)); }
  private read<T>(get: () => T, fallback: T): T { try { return get(); } catch { return fallback; } }
  private call(run: () => void): void { try { run(); } catch { /* one port never breaks the pause's own state */ } }
}
