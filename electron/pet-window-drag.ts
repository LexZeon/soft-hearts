import type { Bounds } from './pet-view';
import { clampPetBounds } from './pet-view';
import type { PetWindowOperation, PointerPosition } from '../shared/contracts';

interface DragWindow {
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
}
interface DragScreen {
  getCursorScreenPoint(): PointerPosition;
  getDisplayNearestPoint(point: PointerPosition): { workArea: Bounds };
}

/** One native DIP coordinate space and a fixed origin for the whole hold. */
export class PetWindowDrag {
  private origin: { operation: PetWindowOperation; bounds: Bounds; cursor: PointerPosition; area: Bounds } | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private expected: Bounds | null = null;
  private requested: Bounds | null = null;
  private geometry: { requested: Bounds; actual: Bounds } | null = null;
  constructor(private readonly window: DragWindow, private readonly screen: DragScreen) {}
  get active(): boolean { return this.origin !== null; }
  start(operation: PetWindowOperation): void {
    if (this.origin) return;
    const actual = this.window.getBounds();
    const bounds = this.geometry && this.equal(this.geometry.actual, actual) ? { ...this.geometry.requested } : actual;
    this.expected = { ...actual }; this.requested = { ...bounds };
    this.origin = { operation, bounds, cursor: this.screen.getCursorScreenPoint(), area: this.screen.getDisplayNearestPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }).workArea };
    this.timer = setInterval(() => this.update(), 16);
  }
  stop(sample = true): { operation: PetWindowOperation; bounds: Bounds } | null {
    if (sample) this.update();
    const result = this.origin ? { operation: this.origin.operation, bounds: { ...this.requested! } } : null;
    this.cancel();
    return result;
  }
  cancel(): void { clearInterval(this.timer); this.timer = undefined; this.origin = null; this.expected = null; }
  private equal(a: Bounds, b: Bounds): boolean { return (Object.keys(a) as (keyof Bounds)[]).every(key => a[key] === b[key]); }
  private update(): void {
    const origin = this.origin;
    if (!origin) return;
    const current = this.window.getBounds();
    // A separate resize/recovery owns the new geometry; never drag it back.
    if (this.expected && Object.entries(this.expected).some(([key, value]) => current[key as keyof Bounds] !== value)) { this.cancel(); return; }
    const cursor = this.screen.getCursorScreenPoint();
    const dx = cursor.x - origin.cursor.x, dy = cursor.y - origin.cursor.y;
    let next: Bounds;
    if (origin.operation === 'move') {
      const proposed = { ...origin.bounds, x: origin.bounds.x + dx, y: origin.bounds.y + dy };
      const area = this.screen.getDisplayNearestPoint({ x: Math.round(proposed.x + proposed.width / 2), y: Math.round(proposed.y + proposed.height / 2) }).workArea;
      next = clampPetBounds(proposed, area);
    } else {
      const { bounds: b, area, operation } = origin;
      const west = operation.endsWith('w'), north = operation.startsWith('n');
      const right = b.x + b.width, bottom = b.y + b.height;
      const maxWidth = Math.max(1, Math.min(4096, west ? right - area.x : area.x + area.width - b.x));
      const maxHeight = Math.max(1, Math.min(4096, north ? bottom - area.y : area.y + area.height - b.y));
      const width = Math.round(Math.max(Math.min(200, maxWidth), Math.min(maxWidth, b.width + (west ? -dx : dx))));
      const height = Math.round(Math.max(Math.min(200, maxHeight), Math.min(maxHeight, b.height + (north ? -dy : dy))));
      next = { x: west ? right - width : b.x, y: north ? bottom - height : b.y, width, height };
    }
    // Windows fractional-DPI getBounds can round dimensions up after a move.
    // Never feed that rounded size into the next command or repeat it at rest.
    if (!this.requested || !this.equal(this.requested, next)) {
      this.window.setBounds(next); this.requested = { ...next };
      this.expected = this.window.getBounds();
      this.geometry = { requested: { ...next }, actual: { ...this.expected } };
    }
  }
}
