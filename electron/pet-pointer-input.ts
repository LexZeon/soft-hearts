/**
 * Click-through that keeps her touchable.
 *
 * With click-through on, the pet window ignores the mouse and only forwards moves
 * (`setIgnoreMouseEvents(true, { forward: true })`). The pet renderer hit-tests those
 * forwarded moves (src/ui/pointer-passthrough.ts: her pixels and the visible controls)
 * and asks, through one narrow boolean channel, to receive the mouse while the pointer
 * is over something of hers. Off click-through the window takes the mouse everywhere,
 * exactly as before.
 *
 * The renderer gets no other window control: a request only toggles this one window's
 * ignore flag, only while click-through is on, only while the window is shown and only
 * while the cursor is inside its bounds.
 */
export interface PointerInputBounds { x: number; y: number; width: number; height: number }
export interface PointerInputWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): PointerInputBounds;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
}
export interface PetPointerInputPorts {
  window(): PointerInputWindow | null;
  /** Screen cursor in the same DIP space as getBounds(). */
  cursor(): { x: number; y: number };
}

/** Slack for DIP rounding at the window edge (DIP). */
const EDGE_SLACK = 2;

export class PetPointerInput {
  private clickThrough = false;
  /** The renderer's last accepted wish to receive the mouse at the current pointer. */
  private receiving = false;
  private applied: boolean | null = null;
  constructor(private readonly ports: PetPointerInputPorts) {}

  /** Native ignore flag this module wants now. */
  get ignoring(): boolean { return this.clickThrough && !this.receiving; }

  /**
   * Settings sync. Re-applies every time, as the old single `setIgnoreMouseEvents`
   * call in sync() did. Turning click-through on or off forgets any earlier wish, so
   * a fresh click-through always starts by letting the mouse through.
   */
  sync(clickThrough: boolean): void {
    if (clickThrough !== this.clickThrough) { this.clickThrough = clickThrough; this.receiving = false; }
    this.apply(true);
  }

  /**
   * Pet renderer only (the caller checks the sender). Returns whether the window now
   * receives the mouse at all: always true off click-through.
   */
  request(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('鼠标接收状态不正确。');
    const win = this.ports.window();
    if (!win || win.isDestroyed()) return false;
    if (!this.clickThrough) return true;
    const accept = value && win.isVisible() && !win.isMinimized() && cursorInside(win.getBounds(), this.ports.cursor());
    this.receiving = accept;
    this.apply(false);
    return !this.ignoring;
  }

  /** Hide, minimize, reload or a lost renderer: let the mouse through again until asked. */
  reset(): void {
    if (!this.receiving) return;
    this.receiving = false;
    this.apply(false);
  }

  private apply(force: boolean): void {
    const win = this.ports.window();
    if (!win || win.isDestroyed()) { this.applied = null; return; }
    const ignore = this.ignoring;
    if (!force && this.applied === ignore) return;
    win.setIgnoreMouseEvents(ignore, { forward: true });
    this.applied = ignore;
  }
}

export function cursorInside(bounds: PointerInputBounds, cursor: { x: number; y: number }): boolean {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, cursor.x, cursor.y].every(Number.isFinite)) return false;
  return cursor.x >= bounds.x - EDGE_SLACK && cursor.y >= bounds.y - EDGE_SLACK
    && cursor.x < bounds.x + bounds.width + EDGE_SLACK && cursor.y < bounds.y + bounds.height + EDGE_SLACK;
}
