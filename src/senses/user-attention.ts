/**
 * I-189 #1, #2: this window's view of the host's attention reading (electron/senses/pose-uses/host.ts): facing the screen, turned away or
 * gone, sure, and for how long. The companion window gets it with its userGaze poll (fromGaze) and hands it to the control window over a
 * channel (receive) on every change and about once a second, so whichever window reads aloud or holds the call sees the same thing.
 * Memory only; a reading older than `staleMs` is no reading (sensing off, the window that polls went away). Pure: injected clock and post.
 */
import { parseUserAttention, turnedFromScreen, type UserAttention, type UserAttentionState } from '../../shared/senses';

export interface UserAttentionMessage { attention: UserAttention | null }

export class UserAttentionStore {
  private held: { state: Exclude<UserAttentionState, 'unsure'>; since: number; at: number } | null = null;
  private lastPost = -Infinity;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => performance.now(), private readonly post?: (message: UserAttentionMessage) => void,
    private readonly staleMs = 3_000) {}

  /** The companion window's userGaze answer (the whole reading; only its `attention` is read here). */
  fromGaze(reading: unknown): void {
    const value = reading && typeof reading === 'object' ? (reading as { attention?: unknown }).attention : undefined;
    this.set(value === undefined ? null : parseUserAttention(value), true);
  }

  /** The other window's message. */
  receive(message: unknown): void {
    if (!message || typeof message !== 'object' || !('attention' in message)) return;
    const value = (message as { attention: unknown }).attention;
    this.set(value === null ? null : parseUserAttention(value), false);
  }

  /** The reading now (forMs counted on this window's clock), or null. */
  current(): UserAttention | null {
    const held = this.held, now = this.now();
    if (!held || now - held.at > this.staleMs || now < held.since) return null;
    return { state: held.state, forMs: Math.round(now - held.since) };
  }

  /** #2: the user's face is turned from the screen (sure, held a moment). */
  turned(): boolean { return turnedFromScreen(this.current()); }

  /** Called after every reading (the read pause checks then). */
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private set(attention: UserAttention | null, local: boolean): void {
    const now = this.now(), before = this.held;
    if (!attention || attention.state === 'unsure') this.held = null;
    else {
      const since = now - attention.forMs;
      const same = !!before && before.state === attention.state && Math.abs(before.since - since) <= 1_000;
      this.held = { state: attention.state, since: same ? before!.since : since, at: now };
    }
    const changed = (before === null) !== (this.held === null) || (!!before && !!this.held && (before.state !== this.held.state || before.since !== this.held.since));
    if (local && this.post && (changed || now - this.lastPost >= 1_000)) {
      this.lastPost = now;
      const current = this.current();
      try { this.post({ attention: current }); } catch { /* the other window is gone */ }
    }
    for (const listener of this.listeners) { try { listener(); } catch { /* a listener never breaks the store */ } }
  }
}
