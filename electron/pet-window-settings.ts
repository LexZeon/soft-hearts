import { applyPetTopmost, type TopmostOutcome, type TopmostWindow } from './pet-topmost';
import { clampPetBounds } from './pet-view';
import type { Bounds } from './pet-view';

/**
 * The pet window's native effects of the saved settings ("显示桌宠", "保持置顶", "穿透模式"), in one function that the
 * startup and every change go through (electron/main.ts sync()), so the two cannot drift.
 *
 * Order: show first, then on top, then the mouse. A window that is not shown yet keeps its z-order from creation; raising it
 * after it is shown puts it where a toggle would. The ignore-mouse flag (and its forwarding of moves to the renderer) is set on
 * the shown window, the same state a toggle sets. Never activates the window (showInactive, no focus).
 */
export interface PetSettingsWindow extends TopmostWindow {
  showInactive(): void;
  hide(): void;
}
export interface PetPointerSync { sync(clickThrough: boolean): void }
export interface PetWindowSettings { visible: boolean; alwaysOnTop: boolean; clickThrough: boolean }

export interface PetBoundsWindow {
  isDestroyed(): boolean;
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
}
export interface WorkAreaSource { getDisplayMatching(bounds: Bounds): { workArea: Bounds } }

/**
 * Her window stays inside the work area of the display she is on, never over the taskbar strip: kept on top, any overlap would
 * hide the tray. Shrinks to the area when larger, then moves the least needed. Used at startup, after every settings sync and
 * on display changes (taskbar moved or resized, DPI, a display removed). Returns whether the window was moved.
 */
export function keepPetInWorkArea(win: PetBoundsWindow, screen: WorkAreaSource): boolean {
  if (win.isDestroyed()) return false;
  const current = win.getBounds();
  if (![current.x, current.y, current.width, current.height].every(Number.isFinite)) return false;
  const area = screen.getDisplayMatching(current).workArea;
  const next = clampPetBounds({ ...current, width: Math.max(1, Math.min(current.width, area.width)), height: Math.max(1, Math.min(current.height, area.height)) }, area);
  if (next.x === current.x && next.y === current.y && next.width === current.width && next.height === current.height) return false;
  win.setBounds(next);
  return true;
}

export function applyPetWindowSettings(win: PetSettingsWindow, pet: PetWindowSettings, pointer: PetPointerSync): TopmostOutcome {
  if (pet.visible) { if (!win.isVisible() && !win.isMinimized()) win.showInactive(); }
  else if (win.isVisible()) win.hide();
  const outcome = applyPetTopmost(win, pet.alwaysOnTop);
  pointer.sync(pet.clickThrough);
  return outcome;
}
