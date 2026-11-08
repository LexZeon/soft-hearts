import type { Attachment } from '../shared/contracts';
import { DEFAULT_SCREEN_SNAPSHOT_OPTIONS, validateScreenSnapshotOptions,
  type ScreenSnapshotOptions, type ScreenSnapshotState } from '../shared/screen-snapshots';

export interface ScreenSnapshotContext {
  sharing: boolean;
  visible: boolean;
  /** Verified by the host; there is deliberately no fallback to another screen. */
  sourceId: string | null;
  scope: string;
}

export interface ScreenSnapshotDependencies {
  capture: (sourceId: string, signal: AbortSignal) => Promise<Attachment>;
  clock?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  changed?: (state: ScreenSnapshotState) => void;
}

interface Capture {
  revision: number;
  controller: AbortController;
  promise: Promise<Attachment | null>;
}

/**
 * One host-owned latest-frame cache. Timers capture only; they never call a model.
 * 屏幕只读大概: nothing turns the timer on any more (R09 is retired,
 * and the V1 morning's "keep the latest frame every 10 s while sharing is on" is gone); the host uses `sampleOnce` only, for a frame
 * the user asked for, taken right then.
 */
export class ScreenSnapshots {
  private options: ScreenSnapshotOptions = { ...DEFAULT_SCREEN_SNAPSHOT_OPTIONS };
  private context: ScreenSnapshotContext = { sharing: false, visible: false, sourceId: null, scope: '' };
  private latest: { attachment: Attachment; at: number } | null = null;
  private revision = 0;
  private disposed = false;
  private pending: Capture | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly clock: () => number;
  private readonly scheduleTimer: NonNullable<ScreenSnapshotDependencies['setTimeout']>;
  private readonly cancelTimer: NonNullable<ScreenSnapshotDependencies['clearTimeout']>;

  constructor(private readonly dependencies: ScreenSnapshotDependencies) {
    this.clock = dependencies.clock ?? Date.now;
    this.scheduleTimer = dependencies.setTimeout ?? setTimeout;
    this.cancelTimer = dependencies.clearTimeout ?? clearTimeout;
  }

  get state(): ScreenSnapshotState {
    return { ...this.options, active: this.options.enabled && this.authorized(), pending: !!this.pending,
      capturedAt: this.currentAttachment() ? this.latest!.at : null };
  }

  configure(context: ScreenSnapshotContext): void {
    if (this.disposed) return;
    if (typeof context.sharing !== 'boolean' || typeof context.visible !== 'boolean'
      || (context.sourceId !== null && (typeof context.sourceId !== 'string' || !context.sourceId || context.sourceId.length > 256))
      || typeof context.scope !== 'string' || context.scope.length > 4096) throw new Error('屏幕共享上下文不正确。');
    if (context.sharing === this.context.sharing && context.visible === this.context.visible
      && context.sourceId === this.context.sourceId && context.scope === this.context.scope) return;
    this.context = { ...context };
    this.invalidate();
    this.schedule(0);
    this.publish();
  }

  setOptions(value: unknown): ScreenSnapshotState {
    if (this.disposed) throw new Error('自动截图已经结束。');
    const options = validateScreenSnapshotOptions(value, this.options);
    if (options.enabled !== this.options.enabled || options.intervalSeconds !== this.options.intervalSeconds) {
      this.options = options;
      this.invalidate();
      this.schedule(0);
      this.publish();
    }
    return this.state;
  }

  currentAttachment(): Attachment | null {
    if (!this.options.enabled || !this.authorized() || !this.latest) return null;
    const age = this.clock() - this.latest.at;
    if (age < 0 || age >= Math.min(this.options.intervalSeconds * 2000, 60_000)) {
      this.latest = null;
      return null;
    }
    return { ...this.latest.attachment };
  }

  /** Called only for an accepted attention event or an explicit user message. */
  async sampleOnce(signal?: AbortSignal): Promise<Attachment | null> {
    if (!this.authorized() || signal?.aborted) return null;
    this.clearTimer();
    const capture = this.pending ?? this.startCapture();
    if (!capture || capture.revision !== this.revision || capture.controller.signal.aborted) return null;
    return new Promise<Attachment | null>(resolve => {
      let settled = false;
      const finish = (value: Attachment | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        capture.controller.signal.removeEventListener('abort', abort);
        resolve(value);
      };
      // Stop waiting promptly when the context is revoked, even if the native
      // capture adapter ignores abort. Its physical slot remains occupied.
      const abort = () => {
        const cancelManual = signal?.aborted && !this.options.enabled && !capture.controller.signal.aborted;
        finish(null);
        if (cancelManual) capture.controller.abort();
      };
      signal?.addEventListener('abort', abort, { once: true });
      capture.controller.signal.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || capture.controller.signal.aborted) abort();
      else void capture.promise.then(value => finish(signal?.aborted ? null : value));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.enabled = false;
    this.invalidate();
    this.publish();
  }

  private authorized(): boolean {
    return !this.disposed && this.context.sharing && this.context.visible && !!this.context.sourceId && !!this.context.scope;
  }

  private invalidate(): void {
    this.revision++;
    this.clearTimer();
    this.latest = null;
    this.pending?.controller.abort();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.cancelTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs = this.options.intervalSeconds * 1000): void {
    if (!this.options.enabled || !this.authorized() || this.pending || this.timer !== undefined) return;
    const revision = this.revision;
    this.timer = this.scheduleTimer(() => {
      this.timer = undefined;
      if (revision === this.revision) this.startCapture();
    }, delayMs);
  }

  private startCapture(): Capture | null {
    if (!this.authorized() || this.pending) return null;
    const revision = this.revision, sourceId = this.context.sourceId!;
    const controller = new AbortController();
    const capture: Capture = { revision, controller, promise: Promise.resolve(null) };
    this.pending = capture;
    this.publish();
    capture.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted || revision !== this.revision || !this.authorized()) return null;
      return this.dependencies.capture(sourceId, controller.signal);
    }).then(attachment => {
      if (!attachment || controller.signal.aborted || revision !== this.revision || !this.authorized()) return null;
      if (attachment.source !== 'screen' || attachment.dataUrl.length > 4_000_000
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(attachment.dataUrl)) return null;
      const copy = { source: 'screen' as const, dataUrl: attachment.dataUrl };
      if (this.options.enabled) this.latest = { attachment: copy, at: this.clock() };
      return copy;
    }).catch(() => null).finally(() => {
      // Keep the physical slot occupied until even an abort-ignoring adapter exits.
      if (this.pending === capture) this.pending = null;
      this.schedule();
      this.publish();
    });
    return capture;
  }

  private publish(): void {
    try { this.dependencies.changed?.(this.state); } catch { /* A closing viewer cannot retain a capture slot. */ }
  }
}
