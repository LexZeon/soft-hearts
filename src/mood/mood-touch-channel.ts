import { validatePetInteractionConfig, type PetInteractionConfig } from './PetInteraction';

interface TouchPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}
interface PendingTouch {
  token: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: PetInteractionConfig): void;
  reject(error: Error): void;
}
type TouchAck = { kind: 'mood-touch-ack'; id: string; token: string; ok: true; config: PetInteractionConfig }
  | { kind: 'mood-touch-ack'; id: string; token: string; ok: false };
export interface MoodTouchChannelOptions {
  isPet: boolean;
  token(): string | null;
  apply?(config: PetInteractionConfig): PetInteractionConfig;
  createPort?(): TouchPort;
  timeoutMs?: number;
}

/** Only six runtime feel settings cross the two trusted application renderers. */
export class MoodTouchChannel {
  private readonly port: TouchPort | null;
  private readonly pending = new Map<string, PendingTouch>();
  private readonly handled = new Map<string, TouchAck>();
  private disposed = false;
  private serial = 0;

  constructor(private readonly options: MoodTouchChannelOptions) {
    let port: TouchPort | null = null;
    try { port = options.createPort ? options.createPort()
      : typeof BroadcastChannel === 'function' ? new BroadcastChannel('soft-hearts-mood-touch-v1') : null; }
    catch { /* Applying will report an unavailable channel; the observer still works. */ }
    this.port = port;
    if (this.port) this.port.onmessage = event => this.receive(event.data);
  }

  request(value: unknown): Promise<PetInteractionConfig> {
    if (this.options.isPet || this.disposed || !this.port) return Promise.reject(new Error('手感通道不可用，本次应用未确认。'));
    const token = this.options.token();
    if (!token || token.length > 256) return Promise.reject(new Error('角色或模型尚未就绪，本次应用未确认。'));
    let config: PetInteractionConfig;
    try { config = validatePetInteractionConfig(value); } catch (error) { return Promise.reject(error); }
    if (this.pending.size >= 4) return Promise.reject(new Error('已有手感设置等待确认，请稍后再试。'));
    const id = `touch-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${++this.serial}`}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('桌宠尚未确认，本次手感应用未确认。'));
      }, Math.max(100, Math.min(10_000, this.options.timeoutMs ?? 3_000)));
      this.pending.set(id, { token, timer, resolve, reject });
      try { this.port!.postMessage({ kind: 'mood-touch-request', id, token, config }); }
      catch { this.finish(id, new Error('手感通道发送失败，本次应用未确认。')); }
    });
  }

  invalidate(): void {
    for (const id of this.pending.keys()) this.finish(id, new Error('角色或模型已改变，本次手感应用未确认。'));
    this.handled.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.invalidate();
    if (this.port) { this.port.onmessage = null; this.port.close(); }
  }

  private receive(value: unknown): void {
    if (this.disposed || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(record.id)
      || typeof record.token !== 'string' || !record.token || record.token.length > 256
      || record.token !== this.options.token()) return;
    if (record.kind === 'mood-touch-request' && this.options.isPet) {
      if (!this.exact(record, ['kind', 'id', 'token', 'config'])) return;
      const previous = this.handled.get(record.id);
      if (previous?.token === record.token) { try { this.port?.postMessage(previous); } catch { /* The requester will time out honestly. */ } return; }
      let ack: TouchAck;
      try {
        const config = validatePetInteractionConfig(record.config);
        if (!this.options.apply) return;
        const applied = validatePetInteractionConfig(this.options.apply(config));
        if (this.disposed || record.token !== this.options.token()) return;
        ack = { kind: 'mood-touch-ack', id: record.id, token: record.token, ok: true, config: applied };
      } catch { ack = { kind: 'mood-touch-ack', id: record.id, token: record.token, ok: false }; }
      this.handled.set(record.id, ack);
      if (this.handled.size > 32) this.handled.delete(this.handled.keys().next().value!);
      try { this.port?.postMessage(ack); } catch { /* Never report an unacknowledged application as confirmed. */ }
    } else if (record.kind === 'mood-touch-ack' && !this.options.isPet) {
      if (!this.exact(record, record.ok === true ? ['kind', 'id', 'token', 'ok', 'config'] : ['kind', 'id', 'token', 'ok'])) return;
      const pending = this.pending.get(record.id);
      if (!pending || pending.token !== record.token) return;
      if (record.ok !== true) { this.finish(record.id, new Error('桌宠未能应用，本次手感应用未确认。')); return; }
      try { this.finish(record.id, validatePetInteractionConfig(record.config)); } catch { /* A malformed acknowledgement cannot report success. */ }
    }
  }

  private exact(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  }
  private finish(id: string, value: PetInteractionConfig | Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id);
    if (value instanceof Error) pending.reject(value); else pending.resolve(value);
  }
}
