import { randomUUID } from 'node:crypto';
import type { Attachment } from '../../shared/foundation/chat';
import type { CameraLookMiss } from '../../shared/senses/camera-look';

/** How long the window has to answer a request. */
export const CAMERA_SAMPLE_WAIT_MS = 2_000;

/**
 * One fresh frame from the window that already owns explicit camera consent.
 *
 * 2026-11-21 (docs/claude/2026-11-21-unbound-camera-look.md): a request that brings no frame says why, in closed words (`miss`): no window
 * could take it ('no-window', the send failed), another request was in flight ('busy'), the window's frame was refused by the host
 * ('refused', see `refuse`), or the window gave nothing within CAMERA_SAMPLE_WAIT_MS ('no-answer'). An aborted request tells nothing (the
 * caller's own end, e.g. a newer message, says what happened).
 */
export class CameraSampleBroker {
  private pending: { id: string; owner: number; generation: number; finish(value: Attachment | null, miss?: CameraLookMiss): void } | null = null;
  private generation = 0;
  constructor(private readonly send: (owner: number, id: string) => void) {}
  request(owner: number, signal: AbortSignal, miss?: (why: CameraLookMiss) => void): Promise<Attachment | null> {
    const tell = (why: CameraLookMiss) => { try { miss?.(why); } catch { /* a listener changes nothing here */ } };
    if (signal.aborted) return Promise.resolve(null);
    if (this.pending) { tell('busy'); return Promise.resolve(null); }
    return new Promise(resolve => {
      const id = `camera-${randomUUID()}`, generation = this.generation;
      const timer = setTimeout(() => finish(null, 'no-answer'), CAMERA_SAMPLE_WAIT_MS);
      const aborted = () => finish(null);
      const finish = (frame: Attachment | null, why?: CameraLookMiss) => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (this.pending?.id === id) this.pending = null;
        if (!frame && why) tell(why);
        resolve(frame);
      };
      this.pending = { id, owner, generation, finish };
      signal.addEventListener('abort', aborted, { once: true });
      try { this.send(owner, id); } catch { finish(null, 'no-window'); }
    });
  }
  accept(owner: number, id: unknown, data: unknown): boolean {
    const pending = this.pending;
    if (!pending || pending.owner !== owner || pending.id !== id || pending.generation !== this.generation) return false;
    if (typeof data !== 'string' || data.length > 4_000_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) return false;
    pending.finish({ source: 'camera', dataUrl: data });
    return true;
  }
  /** The host refused the frame this window just gave for its own pending request: that request ends now, as 'refused' (not a 2 s wait). */
  refuse(owner: number, id: unknown): void {
    const pending = this.pending;
    if (pending && pending.owner === owner && pending.id === id) pending.finish(null, 'refused');
  }
  cancel(): void { this.generation++; this.pending?.finish(null); }
}
