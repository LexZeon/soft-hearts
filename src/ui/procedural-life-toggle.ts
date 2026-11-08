import { uiText } from './ui-language';

interface LifePort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
  unref?(): void;
}
export interface ProceduralLifeToggleOptions {
  /** Applies the value to this window's stage. */
  onChange(enabled: boolean): void;
  createPort?(): LifePort | null;
}
const CHANNEL = 'soft-hearts-procedural-life-v1';

/**
 * Developer-panel comparison switch "程序化小动作与表情" (default on). Runtime
 * only, like the interaction-feel tuning: it is not saved to a card or
 * settings. Both application renderers show it; a change in one is relayed to
 * the other over a same-origin BroadcastChannel, and a newly opened window asks
 * once for the value the other window is using.
 */
export class ProceduralLifeToggle {
  readonly element: HTMLLabelElement;
  private readonly input: HTMLInputElement;
  private port: LifePort | null = null;
  private enabled = true;
  private disposed = false;

  constructor(parent: HTMLElement, private readonly options: ProceduralLifeToggleOptions) {
    const owner = parent.ownerDocument;
    this.element = owner.createElement('label'); this.element.className = 'mood-procedural-life';
    this.input = owner.createElement('input'); this.input.type = 'checkbox'; this.input.checked = true; this.input.id = 'mood-procedural-life';
    this.input.setAttribute('aria-label', uiText('程序化小动作与表情'));
    const caption = owner.createElement('span'); caption.textContent = uiText('程序化小动作与表情');
    this.element.title = uiText('呼吸、视线、小动作、眨眼节奏和连续表情；关闭后回到原来的固定呼吸与眨眼，便于对比');
    this.element.append(this.input, caption);
    this.input.addEventListener('change', this.changed);
    parent.append(this.element);
  }

  get value(): boolean { return this.enabled; }

  /** Opens the cross-window relay (called from the owner's init, so constructing the panel never opens a channel). */
  connect(): void {
    if (this.disposed || this.port) return;
    try { this.port = this.options.createPort ? this.options.createPort()
      : typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) as unknown as LifePort : null; }
    catch { this.port = null; }
    if (!this.port) return;
    try { this.port.unref?.(); } catch { /* browsers have no unref */ }
    this.port.onmessage = event => this.receive(event.data);
    this.post({ kind: 'procedural-life-query' });
  }

  set(enabled: boolean, broadcast = true): void {
    if (this.disposed) return;
    this.enabled = enabled === true; this.input.checked = this.enabled;
    this.options.onChange(this.enabled);
    if (broadcast) this.post({ kind: 'procedural-life', enabled: this.enabled });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeEventListener('change', this.changed);
    if (this.port) { this.port.onmessage = null; try { this.port.close(); } catch { /* already closed */ } this.port = null; }
  }

  private readonly changed = () => this.set(this.input.checked === true);

  private receive(value: unknown): void {
    if (this.disposed || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>, keys = Object.keys(record);
    if (record.kind === 'procedural-life-query' && keys.length === 1) this.post({ kind: 'procedural-life', enabled: this.enabled });
    else if (record.kind === 'procedural-life' && keys.length === 2 && typeof record.enabled === 'boolean' && record.enabled !== this.enabled) this.set(record.enabled, false);
  }

  private post(message: unknown): void {
    try { this.port?.postMessage(message); } catch { /* the other window keeps its own value */ }
  }
}
