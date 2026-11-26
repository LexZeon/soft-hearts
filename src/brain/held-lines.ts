/**
 * Read-aloud while she is out in Unbound (docs/claude/2026-11-15-unbound-read-aloud.md): her own lines in the companion window's
 * renderer while that window is hidden. The host has already put the line in her Unbound bubble and marked the offer `held`;
 * here the line is never shown on the hidden companion. The same host acknowledgement as at home (ackVisionInitiative,
 * acknowledgeAmbientComment) waits for the bubble's display proof; only an accepted line enters her history and is read, with
 * the speech context the host gave it (the host re-checks that proof before each piece of audio).
 */
import type { VisionInitiative, VisionInitiativeEvent } from '../../shared/senses';
import { readSenseLineMessage, type AmbientComment, type SenseLineMessage } from '../../shared/senses';
import type { SpeechRequestContext } from '../../shared/voice';

export interface HeldAmbientOffer { id: string; sessionId: string; text: string; held?: true }
export interface HeldLinePorts {
  ackVision(id: string): Promise<boolean>;
  ackAmbient(id: string): Promise<{ comment: AmbientComment; context: SpeechRequestContext } | null>;
  /** Nothing else of hers is under way in this window (no reply streaming). */
  free(): boolean;
  voiceOn(): boolean;
  speak(text: string, context: SpeechRequestContext): Promise<void>;
  /** Stops whatever this window reads now. */
  stop(): void;
  /** The reading of `id` ended (or never started). */
  ended(id: string, kind: 'vision' | 'ambient'): void;
  rememberVision(message: VisionInitiative): void;
  rememberAmbient(comment: AmbientComment): void;
  /** Her sense line (held while she is out) enters this window's history. */
  rememberSense?(message: SenseLineMessage): void;
  /** I-209 stage voice: the held line `id` is someone else's on the full-screen stage (her chime-in): read it with her card's voice. */
  voiceOf?(id: string, characterId: string): void;
}

export class HeldLines {
  /** Bumped by every new held line and every cancel of the one under way: an older acknowledgement that comes back late does nothing. */
  private generation = 0;
  private current: string | null = null;
  constructor(private readonly ports: HeldLinePorts) {}

  /** The id being acknowledged or read now (null: none). */
  get active(): string | null { return this.current; }

  /** A visual or inner-loop event. True when it was a held offer (handled here, never shown on the companion). */
  vision(event: VisionInitiativeEvent): boolean {
    if (!event || typeof event !== 'object') return false;
    if (event.type === 'cancel') { this.cancel(event.id); return false; } // the companion's own handling still runs for its own lines
    if (event.type !== 'offer' || event.held !== true) return false;
    const message = event.message, silent = event.silent === true;
    void this.run(message.id, 'vision', async generation => {
      if (!await this.ports.ackVision(message.id) || generation !== this.generation) return null;
      this.ports.rememberVision(message);
      return silent ? null : { text: message.text, context: { replyId: message.id } };
    });
    return true;
  }

  /** An ambient comment offer. True when it was held. */
  ambient(offer: HeldAmbientOffer): boolean {
    if (!offer || offer.held !== true) return false;
    void this.run(offer.id, 'ambient', async generation => {
      const accepted = await this.ports.ackAmbient(offer.id);
      if (!accepted || generation !== this.generation) return null;
      this.ports.rememberAmbient(accepted.comment);
      return { text: offer.text, context: accepted.context };
    });
    return true;
  }

  /**
   * 2026-11-21: her short line after a semantic look (desk:sense-line), sent `held` while she is out: the host already put it in her Unbound bubble and
   * ended its wait, so there is nothing to acknowledge here; it enters this window's history and is read aloud, never shown on the hidden companion.
   * True when it was a held line (handled here); any other shape is left to the companion's own presenter.
   */
  sense(value: unknown): boolean {
    if (!value || typeof value !== 'object' || (value as { held?: unknown }).held !== true) return false;
    // 2026-11-25: one of her 猜拳 lines while she is out (electron/unbound/game-line.ts): read only; it never enters this window's history (a game's lines are not chat).
    if ((value as { game?: unknown }).game === true) {
      const { id, text } = value as { id?: unknown; text?: unknown };
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) && typeof text === 'string' && text.trim() && text.length <= 4_000) {
        void this.run(id, 'vision', async () => ({ text, context: { replyId: id } }));
      }
      return true; // a malformed one is dropped, never shown on the hidden companion
    }
    const { held: _held, voice, ...rest } = value as Record<string, unknown>;
    const message = readSenseLineMessage(rest);
    if (!message || (voice !== undefined && (typeof voice !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(voice)))) return true; // a malformed held line is dropped, never shown on the hidden companion
    if (typeof voice === 'string') this.ports.voiceOf?.(message.id, voice); // I-209 stage voice: someone else on stage: read in her card's voice
    void this.run(message.id, 'vision', async () => {
      this.ports.rememberSense?.(message);
      return { text: message.text, context: { replyId: message.id } };
    });
    return true;
  }

  /** A line was taken back: its reading stops (other ids: nothing). */
  cancel(id: string): void {
    if (!id || this.current !== id) return;
    this.generation++;
    this.current = null;
    try { this.ports.stop(); } catch { /* nothing was playing */ }
  }

  private async run(id: string, kind: 'vision' | 'ambient', accept: (generation: number) => Promise<{ text: string; context: SpeechRequestContext } | null>): Promise<void> {
    let free = false;
    try { free = this.ports.free() === true; } catch { free = false; }
    if (!free) return; // the host's acknowledgement window runs out; the line is not delivered
    const generation = ++this.generation;
    this.current = id;
    try { this.ports.stop(); } catch { /* a new line of hers replaces what this window was reading */ }
    let reading: { text: string; context: SpeechRequestContext } | null = null;
    try { reading = await accept(generation); } catch { reading = null; }
    if (generation !== this.generation) return;
    if (!reading || !this.ports.voiceOn()) { this.current = null; this.ports.ended(id, kind); return; }
    try { await this.ports.speak(reading.text, reading.context); } catch { /* a refused or failed reading ends like a finished one */ }
    if (generation === this.generation) this.current = null;
    this.ports.ended(id, kind);
  }
}
