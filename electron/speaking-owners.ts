/**
 * Which windows say "she is speaking right now" (the window's mouth opened; it tells the host so listening along waits).
 * A Set that forgets: a window that said "speaking" and then never said "stopped" (the message lost, the reading replaced or
 * cancelled before it began, a hidden window) used to keep listening along paused until the app was restarted
 * (2026-11-06, 朗读过后听不见了). Each "speaking" message renews the owner's lease; no renewal for the lease means it is over.
 * Same surface as the Set it replaces (size / add / delete / has).
 */
export const SPEAKING_OWNER_LEASE_MS = 5 * 60_000;

export interface SpeakingOwnersOptions {
  /** An owner's lease ran out without a "stopped" (journal it; re-evaluate whatever waited). */
  expired?(owner: number): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class SpeakingOwners {
  private readonly leases = new Map<number, unknown>();
  constructor(private readonly options: SpeakingOwnersOptions = {}) {}
  get size(): number { return this.leases.size; }
  has(owner: number): boolean { return this.leases.has(owner); }
  add(owner: number): this {
    this.drop(owner);
    const set = this.options.setTimer ?? ((run: () => void, ms: number) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; });
    this.leases.set(owner, set(() => {
      this.leases.delete(owner);
      try { this.options.expired?.(owner); } catch { /* a journal problem never changes listening */ }
    }, SPEAKING_OWNER_LEASE_MS));
    return this;
  }
  delete(owner: number): boolean { return this.drop(owner); }
  private drop(owner: number): boolean {
    if (!this.leases.has(owner)) return false;
    (this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.leases.get(owner));
    this.leases.delete(owner);
    return true;
  }
}
