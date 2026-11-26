/**
 * Unbound U1: normal mode ↔ Unbound (docs/claude/2026-11-12-unbound-u1-part1.md).
 *
 * normal → entering: the Unbound window is made, hidden, while the companion stays where she is. It reports her on screen →
 * unbound: the companion window is hidden (only the window: no setting is changed or saved) and the Unbound window is shown.
 * exit → normal: the Unbound window is destroyed and the companion comes back exactly as she was (same bounds; shown again only if she
 * was shown and 显示桌宠 is still on), then the host's settings sync runs as after any change.
 * quit → normal at once, nothing restored and nothing written: the mode lives only in memory, so the next start is normal mode.
 *
 * While in Unbound, the host's settings sync must not show the companion again: `petSettings` masks 显示桌宠 for that one call.
 */
import type { Rect } from '../../shared/unbound/world';
import type { UnboundState } from '../../shared/unbound/scene';

export interface PetPort {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): Rect;
  setBounds(bounds: Rect): void;
  hide(): void;
  showInactive(): void;
}
export interface UnboundWindowPort {
  isDestroyed(): boolean;
  showInactive(): void;
  destroy(): void;
}
export interface UnboundModePorts {
  pet(): PetPort | null;
  /** The saved 显示桌宠 setting now. */
  petWanted(): boolean;
  /** Makes the Unbound window (hidden) and resolves once it has her on screen; rejects when it cannot. */
  open(): Promise<UnboundWindowPort>;
  /** After the companion is back: the host's ordinary settings sync (top-most, click-through, work area). */
  restored(): void;
  changed(state: UnboundState): void;
}

interface PetSnapshot { visible: boolean; bounds: Rect }
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class UnboundMode {
  private current: UnboundState = 'normal';
  private generation = 0;
  private window: UnboundWindowPort | null = null;
  private snapshot: PetSnapshot | null = null;
  constructor(private readonly ports: UnboundModePorts) {}

  get state(): UnboundState { return this.current; }
  /** The window shown in Unbound (null otherwise). */
  get shown(): UnboundWindowPort | null { return this.current === 'unbound' ? this.window : null; }

  /** The companion's window settings for the host's sync: hidden while she is in Unbound, unchanged otherwise. */
  petSettings<T extends { visible: boolean }>(settings: T): T {
    return this.current === 'unbound' ? { ...settings, visible: false } : settings;
  }

  /** Into Unbound (any mode since Unbound v1 step 1). Resolves when she is there, or when entering was cancelled. */
  async enter(): Promise<void> {
    if (this.current !== 'normal') return;
    const generation = ++this.generation;
    this.set('entering');
    let win: UnboundWindowPort;
    try { win = await this.ports.open(); }
    catch (error) {
      if (generation === this.generation) this.set('normal');
      throw error;
    }
    if (generation !== this.generation || (this.current as UnboundState) !== 'entering') { if (!win.isDestroyed()) win.destroy(); return; }
    const pet = this.ports.pet();
    this.snapshot = pet && !pet.isDestroyed() ? { visible: pet.isVisible() && !pet.isMinimized(), bounds: { ...pet.getBounds() } } : null;
    if (pet && !pet.isDestroyed() && pet.isVisible()) pet.hide();
    this.window = win;
    win.showInactive();
    this.set('unbound');
  }

  /** Back to normal: the companion exactly as she was. Also cancels an entry still under way. */
  exit(): void {
    if (this.current === 'normal') return;
    this.generation++;
    const win = this.window, snapshot = this.snapshot;
    this.window = null; this.snapshot = null;
    this.current = 'normal';
    if (win && !win.isDestroyed()) win.destroy();
    const pet = this.ports.pet();
    if (pet && !pet.isDestroyed() && snapshot) {
      if (!sameRect(pet.getBounds(), snapshot.bounds)) pet.setBounds(snapshot.bounds);
      if (snapshot.visible && this.ports.petWanted() && !pet.isVisible()) pet.showInactive();
    }
    this.ports.restored();
    this.ports.changed('normal');
  }

  /** The app is quitting: the window goes, nothing is restored or written (the next start is normal mode). */
  quit(): void {
    this.generation++;
    const win = this.window;
    this.window = null; this.snapshot = null; this.current = 'normal';
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** The Unbound window went away by itself (closed, its page crashed): back to normal, the companion restored. */
  windowGone(win: UnboundWindowPort): void {
    if (this.window === win) this.exit();
  }

  private set(state: UnboundState): void {
    this.current = state;
    this.ports.changed(state);
  }
}
