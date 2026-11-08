import { EMOJI_CATALOG, getEmoji, type EmojiId, type EmojiSettings } from '../shared/single-emoji';

export interface SingleEmojiCue { id: string; catalogId: EmojiId; context: string; expiresAt: number }
interface Ports {
  context(): string;
  settings(): EmojiSettings;
  available(): boolean;
  show(cue: SingleEmojiCue): boolean;
  hide(): void;
  onInvalidate?():void;
}
/** One host-selected transient cue, no queue/model/reward or renderer event authority. */
export class SingleEmojiCues {
  private readonly consumed = new Set<string>();
  private current: SingleEmojiCue | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastShownAt = -Infinity;
  private serial = 0;
  private disposed = false;
  constructor(private readonly ports: Ports, private readonly now = Date.now) {}
  /** Current conversational context takes priority over a lingering mood. */
  offerReply(eventId: string, mood: { primary: string; context: string }, context: string): boolean {
    const primary = mood.context === 'support' || mood.context === 'concern' ? 'concerned'
      : mood.context === 'offense' ? 'upset' : mood.context === 'disappointment' ? 'sad'
        : mood.context === 'positive' ? 'happy' : mood.primary;
    return this.offerMood(eventId, primary, context);
  }
  offerMood(eventId: string, primary: string, context: string): boolean {
    try {
      const selected = this.ports.settings().selected;
      const entry = EMOJI_CATALOG.find(emoji => selected.includes(emoji.id) && emoji.hints.includes(primary));
      return entry ? this.offer(eventId, entry.id, context) : this.consumeWithoutShowing(eventId, context);
    } catch { this.clear(); return false; }
  }
  /** Also used by the explicit local settings preview, never by a model/tool. */
  offer(eventId: string, catalogId: EmojiId, context: string): boolean {
    if (!this.claimEvent(eventId, context)) return false;
    const settings = this.ports.settings(), now = this.now();
    if (!settings.enabled || !settings.selected.includes(catalogId) || !getEmoji(catalogId)
      || !this.ports.available() || !Number.isFinite(now) || now - this.lastShownAt < 8_000) return false;
    this.clear();
    const cue: SingleEmojiCue = { id: 'single-emoji-' + ++this.serial, catalogId, context, expiresAt: now + 2_600 };
    try { if (!this.ports.show(cue)) return false; }
    catch { this.clear(); return false; } // Cosmetic failure never fails an archived reply.
    this.current = cue; this.lastShownAt = now;
    this.timer = setTimeout(() => { if (this.current === cue) this.clear(); }, 2_600);
    this.timer.unref?.();
    return true;
  }
  private claimEvent(eventId: string, context: string): boolean {
    if (this.disposed || typeof eventId !== 'string' || !eventId || eventId.length > 160
      || !context || context !== this.ports.context()) return false;
    const key = context + '\0' + eventId;
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    if (this.consumed.size > 128) this.consumed.delete(this.consumed.values().next().value!);
    return true;
  }
  private consumeWithoutShowing(eventId: string, context: string): false { this.claimEvent(eventId, context); return false; }
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined; this.current = null;
    try { this.ports.hide(); } catch { /* Retire the cue even if its owned window already died. */ }
  }
  /** Context loss/hide cancels, never pauses for a later replay. */
  invalidate(): void { this.clear(); this.ports.onInvalidate?.(); }
  dispose(): void { this.disposed = true; this.clear(); this.consumed.clear(); }
}
