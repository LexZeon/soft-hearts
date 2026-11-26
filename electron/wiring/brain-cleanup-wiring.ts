// 大脑's window and quit steps (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md), moved from electron/main.ts's windowEvents
// word for word. electron/main.ts's order list (wireWindowEvents, electron/wiring/window-events-wiring.ts) says which run on which window
// event, in which order; the wiring golden pins it. A window step is called with the window's scope (win, owner, windowId).
// What they read: 大脑's own live bindings (electron/wiring/brain-wiring.ts), imported.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { chatOutage, claudeChat, companion, moduleRouter, pauseTalk, pending } from './brain-wiring';
import { herOnScreen } from './stage-wiring';
import { abortsWithClosedWindow } from '../../shared/foundation/step-away';
import { claudeLaunchesSettled } from '../brain';

// ---- window steps

/** Destroyed step: every task in flight that the closed window owns is aborted; a chat's entry goes now, authoring's when its adapter settles. */
export function abortWindowTasks(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  for (const [id, task] of pending)
    if (task.owner === windowId && abortsWithClosedWindow(task, { owner }, herOnScreen())) { // I-171: a closed control window does not cut off her reply while she is on screen
      task.controller.abort();
      // Authoring keeps the shared chat lease until its adapter actually settles.
      if (task.source !== 'language-authoring' && task.source !== 'visual-authoring') pending.delete(id);
    }
}

// ---- quit steps (electron/main.ts's wireQuit gives their order; electron/wiring/quit-wiring.ts)

/** Quit step: every task in flight is aborted (their providers settle their pending text writes; the flush waits for the chats). */
export function abortAllTasks(): void {
  for (const task of pending.values()) task.controller.abort();
}
/** Quit step: her chat process and the outage watch end. */
export function disposeChat(): void {
  claudeChat.dispose();
  chatOutage.dispose();
}
/** Quit step: the module router and 停停说说 end. */
export function disposeRouting(): void {
  moduleRouter.dispose();
  pauseTalk.dispose();
}
/**
 * Flush step, first: the chats in flight get up to 3 s to settle (counted from the flush's start); then, in what is left of those 3 s, the
 * worker that starts and ends Claude Code (electron/brain/claude-launch/) has started every taskkill asked of it, so no Claude Code process
 * outlives the app because the quit came before the worker got to it.
 */
export async function waitForChats(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while ([...pending.values()].some(task => task.kind === 'chat') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  await claudeLaunchesSettled(Math.max(250, deadline - Date.now()));
}
/** Flush step: her conversation is written. */
export async function flushCompanion(): Promise<void> {
  await companion.flush();
}
