/**
 * I-019, pet window: her one line after a recognized feed goes where her words go — the ordinary answer bubble and the
 * ordinary voice (rps-speech.ts petSayPorts, the same calls G1 猜拳 and her other unprompted lines use; the speakable-text
 * step skips bracketed actions as always). Shown only when she is free (no chat reply running, nothing typed, the pet shown);
 * otherwise reported not shown and dropped (never queued, never late). Shown: the host archives it once and the control
 * window adds it to its chat; this window adds it to its own history here, so the next chat turn knows "you fed her X".
 */
import { readFeedLineMessage, type FeedLineDone, type FeedLineMessage } from '../../shared/feed-recognition';
import type { RpsSayPorts } from './rps-speech';

export interface FeedLineApi {
  onFeedLine?(callback: (message: FeedLineMessage) => void): () => void;
  feedLineDone?(input: FeedLineDone): Promise<boolean>;
}
export interface FeedLineOptions {
  say: RpsSayPorts;
  /** The message reader (default: I-019's readFeedLineMessage; I-040's sense line passes readSenseLineMessage). */
  read?(value: unknown): FeedLineMessage | null;
  /** src/main.ts rememberInitiative: "[角色主动观察：喂食：X] her line" in this window's chat history. */
  remember?(message: FeedLineMessage): void;
}

export class FeedLinePresenter {
  private readonly seen: string[] = [];
  private readonly unsubscribe: (() => void) | null;
  constructor(private readonly api: FeedLineApi, private readonly options: FeedLineOptions) {
    let off: (() => void) | null = null;
    try { off = api.onFeedLine?.(message => { void this.present(message); }) ?? null; } catch { off = null; }
    this.unsubscribe = off;
  }

  async present(value: unknown): Promise<boolean> {
    const message = (this.options.read ?? readFeedLineMessage)(value);
    if (!message || this.seen.includes(message.id)) return false;
    this.seen.push(message.id);
    if (this.seen.length > 64) this.seen.shift();
    const ports = this.options.say;
    let free = false, voice = false;
    try { free = ports.free(); voice = free && ports.voiceOn(); } catch { free = false; }
    if (!free) { this.report(message.id, false); return false; }
    try { ports.show(message.id, message.text, voice); } catch { this.report(message.id, false); return false; }
    try { this.options.remember?.(structuredClone(message)); } catch { /* The bubble is shown; only this window's history misses it. */ }
    this.report(message.id, true);
    if (voice) {
      try { await ports.speak(message.id, message.text); } catch { /* A failed voice leaves the bubble as usual. */ }
      try { ports.ended(message.id); } catch { /* The bubble keeps its own timer. */ }
    }
    return true;
  }

  dispose(): void { try { this.unsubscribe?.(); } catch { /* Already gone. */ } }

  private report(id: string, shown: boolean): void {
    try { void this.api.feedLineDone?.({ id, shown })?.catch(() => {}); } catch { /* The host's wait runs out by itself. */ }
  }
}
