import { randomUUID } from 'node:crypto';
import type { Attachment } from '../shared/contracts';

/** One fresh frame from the window that already owns explicit camera consent. */
export class CameraSampleBroker {
  private pending: { id: string; owner: number; generation: number; finish(value: Attachment | null): void } | null = null;
  private generation = 0;
  constructor(private readonly send: (owner: number, id: string) => void) {}
  request(owner: number, signal: AbortSignal): Promise<Attachment | null> {
    if (signal.aborted || this.pending) return Promise.resolve(null);
    return new Promise(resolve => {
      const id = `camera-${randomUUID()}`, generation = this.generation;
      const timer = setTimeout(() => finish(null), 2_000);
      const aborted = () => finish(null);
      const finish = (frame: Attachment | null) => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (this.pending?.id === id) this.pending = null;
        resolve(frame);
      };
      this.pending = { id, owner, generation, finish };
      signal.addEventListener('abort', aborted, { once: true });
      try { this.send(owner, id); } catch { finish(null); }
    });
  }
  accept(owner: number, id: unknown, data: unknown): boolean {
    const pending = this.pending;
    if (!pending || pending.owner !== owner || pending.id !== id || pending.generation !== this.generation) return false;
    if (typeof data !== 'string' || data.length > 4_000_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) return false;
    pending.finish({ source: 'camera', dataUrl: data });
    return true;
  }
  cancel(): void { this.generation++; this.pending?.finish(null); }
}
