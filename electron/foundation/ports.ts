// The foundation's Electron-side port types (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2).
// Types only. The platform-free ones are in shared/foundation/ports.ts.
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';

/** The companion window as a part may use it: read the window, send it one channel. */
export interface PetWindowPort {
  pet(): BrowserWindow | null;
  /** The old `!!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized()`. */
  petVisible(): boolean;
  petSender(): number | null;
}

/** A window's lifecycle as the wiring dispatches it (electron/wiring/lifecycle-wiring.ts). */
export interface WindowLifecycle {
  /** Registers the subscriber's listeners on one of our windows. */
  attach(win: BrowserWindow, owner: MediaOwner, windowId: number): void;
}
