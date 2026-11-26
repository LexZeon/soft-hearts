// Window lifecycle (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md):
// the dispatch half of secureWindow. Each of our two windows gets its owner and id, then every subscriber registers its window and
// webContents listeners, in the order electron/main.ts gave them (wireLifecycle). Listener order on one event is registration order,
// so the subscribers' order is the order the parts are told about navigation, a crash, hiding and closing; the wiring golden pins it.
// The security half (no new windows, no navigation, no webviews) is electron/wiring/shell-wiring.ts guardWindowNavigation, called by the
// subscriber at its original place among the listeners.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { petWindow } from './shell-wiring';

/** One subscriber: registers its listeners on a window. Called once per window, in order. */
export type WindowSubscriber = (win: BrowserWindow, owner: MediaOwner, windowId: number) => void;

let subscribers: readonly WindowSubscriber[] = [];

/** electron/main.ts gives the subscribers once, in the order they were written in secureWindow. */
export function wireLifecycle(list: readonly WindowSubscriber[]): void { subscribers = Object.freeze([...list]); }

// `pet` is read once per window, when it is secured (a default parameter, so the statements below are the ones main.ts had).
export function secureWindow(win: BrowserWindow, pet: BrowserWindow | null = petWindow()): void {
  const owner: MediaOwner = win === pet ? "pet" : "controls";
  const windowId = win.webContents.id;
  for (const subscribe of subscribers) subscribe(win, owner, windowId);
}
