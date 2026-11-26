import type { Attachment } from '../../shared/foundation/chat';
import { SEE_AND_SAY } from '../../shared/senses/see-and-say/knobs';

/**
 * I-166: the small frames that are not
 * kept by a window.
 *
 * The screen: one 320×200 JPEG thumbnail of the shared screen (the same size and quality as 屏幕只读大概's look: about 85 image tokens,
 * roughly 8–20 KB). Taken when the user starts typing (`prefetch`, so a typed message does not wait) or when a turn asks and none is fresh
 * (`take`; the turn waits at most SEE_AND_SAY.smallWaitMs, LookAttachments.small). Only one is kept, in memory, for `screenSmallFreshMs`,
 * and only under the key it was taken for (sharing on, the same opening and media revision, no "别看"): a key change forgets it, an empty
 * key (sharing off or a "别看") takes nothing. Never written anywhere.
 *
 * The camera: the owner window keeps a small frame ready (electron/senses/camera-glance.ts), but out in full-screen that window is hidden
 * and throttled, so the kept frame is often stale. Then one sample is asked of the window (the same path as a clear look, which works
 * while hidden) and shrunk to 320×240 here (`freshSmallCamera`).
 */
export interface SmallScreenPorts {
  /** A 320×200 JPEG data URL of the shared screen; null when it cannot be taken. */
  capture(signal: AbortSignal): Promise<string | null>;
  /** What a kept frame is valid for: sharing on, its opening and revision, no "别看". '' takes and keeps nothing. */
  key(): string;
  now?(): number;
  freshMs?(): number;
}

export class SmallScreenFrames {
  private kept: { key: string; at: number; dataUrl: string } | null = null;
  private running: { key: string; promise: Promise<string | null>; controller: AbortController } | null = null;
  readonly stats = { taken: 0, reused: 0, failed: 0 };
  constructor(private readonly ports: SmallScreenPorts) {}

  private key(): string { try { return this.ports.key() || ''; } catch { return ''; } }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private fresh(key: string): string | null {
    const kept = this.kept, ms = this.ports.freshMs?.() ?? SEE_AND_SAY.screenSmallFreshMs, now = this.now();
    if (!kept) return null;
    if (kept.key !== key || now < kept.at || now - kept.at > ms) { this.kept = null; return null; }
    return kept.dataUrl;
  }

  /** The user started typing: take one now if none is fresh and none is being taken (never waits). */
  prefetch(): void {
    const key = this.key();
    if (!key) { this.forget(); return; }
    if (this.fresh(key) || this.running?.key === key) return;
    void this.start(key);
  }

  /** A small screen frame for this turn: the fresh one, the one being taken, or a new one (the caller bounds the wait). */
  async take(signal: AbortSignal): Promise<Attachment | null> {
    const key = this.key();
    if (!key) { this.forget(); return null; }
    const ready = this.fresh(key);
    if (ready) { this.stats.reused++; return { source: 'screen', dataUrl: ready }; }
    const running = this.running?.key === key ? this.running.promise : this.start(key);
    const dataUrl = await new Promise<string | null>(resolve => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
      running.then(resolve, () => resolve(null));
    });
    if (signal.aborted || !dataUrl || this.key() !== key) return null;
    return { source: 'screen', dataUrl };
  }

  /** Sharing off, "别看", a cleared vision context: nothing kept, a capture under way is dropped. */
  forget(): void {
    this.kept = null;
    this.running?.controller.abort();
    this.running = null;
  }

  private start(key: string): Promise<string | null> {
    this.running?.controller.abort();
    const controller = new AbortController();
    const promise = this.ports.capture(controller.signal).then(dataUrl => {
      if (this.running?.promise !== promise) return null;
      this.running = null;
      if (controller.signal.aborted || !dataUrl || this.key() !== key) { this.stats.failed++; return null; }
      this.kept = { key, at: this.now(), dataUrl };
      this.stats.taken++;
      return dataUrl;
    }, () => { if (this.running?.promise === promise) this.running = null; this.stats.failed++; return null; });
    this.running = { key, promise, controller };
    return promise;
  }
}

/** I-166: a small camera frame taken now (full-screen: the kept one is stale): one sample from the owner window, shrunk. */
export async function freshSmallCamera(ports: { sample(signal: AbortSignal): Promise<Attachment | null>; shrink(dataUrl: string): string | null }, signal: AbortSignal): Promise<Attachment | null> {
  const frame = await ports.sample(signal);
  if (!frame || signal.aborted) return null;
  let small: string | null = null;
  try { small = ports.shrink(frame.dataUrl); } catch { small = null; }
  return small ? { source: 'camera', dataUrl: small } : null;
}
