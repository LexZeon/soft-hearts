import type { WindowVisibilityState } from '../../shared/contracts';

/** Per-renderer lifetime only. No state survives a page/host restart. */
export class WindowVisibilityTracker {
  private current: WindowVisibilityState | null = null;
  accept(value: WindowVisibilityState): boolean {
    if (!value || !Number.isSafeInteger(value.windowId) || value.windowId <= 0 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.visible !== 'boolean' || typeof value.petVisible !== 'boolean') return false;
    const old = this.current;
    if (old && (value.windowId !== old.windowId || value.revision < old.revision || value.revision === old.revision && (value.visible !== old.visible || value.petVisible !== old.petVisible))) return false;
    if (old && value.revision === old.revision) return false;
    this.current = { windowId:value.windowId, revision:value.revision, visible:value.visible, petVisible:value.petVisible };
    return true;
  }
  get visible(): boolean { return this.current?.visible ?? false; }
  get petVisible(): boolean | null { return this.current?.petVisible ?? null; }
}

/** Serialize calls only; authoritative visibility comes from the revisioned state. */
export class PetVisibilityIntent {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly send: (visible: boolean) => Promise<void>, private readonly failed: (error: unknown) => Promise<void>) {}
  request(value: boolean): Promise<void> {
    const task = this.queue.then(async () => {
      try { await this.send(value); } catch (error) { await this.failed(error); }
    });
    this.queue = task; return task;
  }
}
