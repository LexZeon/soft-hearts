import { randomUUID } from 'node:crypto';

export interface ReplyPresentationClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ReplyPresentationOptions {
  createToken?: () => string;
  timeoutMs?: number;
  clock?: ReplyPresentationClock;
}
interface Revision { text: string; recipient: object; token: string; presented: boolean; consumed: boolean; invalidated: boolean; }
interface Waiter { revision: Revision; resolve(value: boolean): void; timer?: unknown; signal?: AbortSignal; abort(): void; }
const clock: ReplyPresentationClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One host-owned text revision and one bounded receipt. No display replay or renderer capability. */
export class ReplyPresentation {
  private revision: Revision | null = null;
  private waiter: Waiter | null = null;
  private disposed = false;
  private usedTokens = new Set<string>();
  private readonly createToken: () => string;
  private readonly timers: ReplyPresentationClock;
  private readonly timeoutMs: number;
  constructor(options: ReplyPresentationOptions = {}) {
    this.createToken = options.createToken ?? randomUUID;
    this.timers = options.clock ?? clock;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5000) throw new Error('回答展示回执期限不正确。');
  }
  /** Every explicit text update is a new revision, even when its bytes equal the preceding one. */
  begin(text: string, recipient: object): string | null {
    this.clear();
    if (this.disposed || typeof text !== 'string' || !text.trim() || text.length > 32000 || !recipient || typeof recipient !== 'object') return null;
    const token = this.createToken();
    if (typeof token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(token) || this.usedTokens.has(token)) return null;
    this.usedTokens.add(token);
    while (this.usedTokens.size > 64) this.usedTokens.delete(this.usedTokens.values().next().value!);
    this.revision = { text, recipient, token, presented: false, consumed: false, invalidated: false };
    return token;
  }
  currentToken(recipient: object): string | null {
    const revision = this.revision;
    return !this.disposed && revision?.recipient === recipient && !revision.invalidated && !revision.consumed ? revision.token : null;
  }
  /** A consumed successful receipt still describes the same painted revision until it changes. */
  isCurrent(token: unknown, recipient: object): boolean {
    const revision = this.revision;
    return !this.disposed && !!revision && revision.token === token && revision.recipient === recipient
      && revision.presented && !revision.invalidated;
  }
  async waitForPresentation(expectedText: string, signal?: AbortSignal): Promise<boolean> {
    const revision = this.revision;
    if (this.disposed || !revision || revision.text !== expectedText || revision.invalidated || revision.consumed || this.waiter) return false;
    if (signal?.aborted) { revision.consumed = true; return false; }
    let pending: Promise<boolean>;
    if (revision.presented) { revision.consumed = true; pending = Promise.resolve(true); }
    else {
      pending = new Promise<boolean>(resolve => {
        const waiter: Waiter = { revision, resolve, signal, abort: () => { if (this.waiter === waiter) this.finish(false); } };
        this.waiter = waiter;
        waiter.timer = this.timers.setTimeout(() => { if (this.waiter === waiter) this.finish(false); }, this.timeoutMs);
        if (this.waiter !== waiter) { this.timers.clearTimeout(waiter.timer); return; }
        signal?.addEventListener('abort', waiter.abort, { once: true });
        if (signal?.aborted) waiter.abort();
      });
    }
    const presented = await pending;
    // Resolving the receipt schedules a continuation: a synchronous clear/new
    // text/hide/abort can invalidate it before that continuation actually runs.
    return presented && this.revision === revision && !revision.invalidated && !this.disposed && !signal?.aborted;
  }
  /** Caller validates its exact native sender/main-frame and freshly computed visibility first. */
  acknowledge(token: unknown, recipient: object, visible: boolean): boolean {
    const revision = this.revision;
    if (this.disposed || !revision || revision.token !== token || revision.recipient !== recipient || revision.invalidated || revision.consumed || revision.presented) return false;
    if (!visible) { this.invalidate(); return false; }
    revision.presented = true;
    if (this.waiter?.revision === revision) this.finish(true);
    return true;
  }
  invalidate(): void {
    if (this.revision) { this.revision.invalidated = true; this.revision.consumed = true; }
    this.finish(false);
  }
  clear(): void { this.invalidate(); this.revision = null; }
  dispose(): void { this.disposed = true; this.clear(); }
  private finish(value: boolean): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null; waiter.revision.consumed = true;
    if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve(value);
  }
}
