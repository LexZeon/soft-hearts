// 主动's window steps (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md), moved from electron/main.ts's windowEvents
// word for word. electron/main.ts's order list (wireWindowEvents, electron/wiring/window-events-wiring.ts) says which run on which window
// event, in which order; the wiring golden pins it. A window step is called with the window's scope (win, owner, windowId).
// What they read: 主动's own live bindings, imported.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { surprisePreviewHost } from './initiative-handlers-wiring';
import { feeding, give, hands, innerLoopHost, keepsake, proactiveSpeechGate, r20ProactiveOffers, rps, specialDay } from './initiative-wiring';

// ---- window steps

/** Window step: the control window's surprise / shy preview stops (a new page, its page gone, minimized, closed). */
export function stopSurprisePreview(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if(owner==='controls')surprisePreviewHost?.stop(windowId);
}

// ---- quit steps (electron/main.ts's wireQuit gives their order; electron/wiring/quit-wiring.ts)

/** Quit step: R20's offers stop. */
export function disposeR20Offers(): void {
  r20ProactiveOffers?.dispose();
}
/** Quit step: the inner loop, the keepsakes, special days and the proactive-speech gate stop. */
export function disposeInitiative(): void {
  innerLoopHost.loop.dispose();
  keepsake.dispose(); // I-050 第 2 步
  specialDay.dispose(); // I-059
  proactiveSpeechGate.dispose();
}
/** Quit step: 猜拳 ends. */
export function disposeGame(): void {
  rps.dispose();
}
/** Quit step: feeding, giving and her hand end. */
export function disposeTogether(): void {
  feeding.dispose();
  give.dispose();
  if (typeof hands!=='undefined') hands.dispose();
}
