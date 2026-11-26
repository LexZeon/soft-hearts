// What a window's events do (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md): one ordered list, given by electron/main.ts
// (wireWindowEvents), says which steps run on which window event and in which order. secureWindow (electron/wiring/lifecycle-wiring.ts)
// calls windowEvents for each of our two windows; it registers every listener in the list's order, so one event's listeners run in that
// order (Electron calls them in registration order) and each listener runs its steps in order. A step is a named function in its part's
// wiring file (electron/wiring/<part>-cleanup-wiring.ts and a few in the part's own wiring file), called with the window's scope
// (win, owner, windowId) and the event's arguments. A part that needs another cleanup writes the step in its file and adds it to the list.
// The shared helpers are steps several listeners run (the old per-window closures): a part calls one with the window's scope,
// `revokeVisionOwner(win, owner, windowId)`; the wiring golden lists each once, by name (order.secureWindow.locals).
// The wiring golden (scripts/dev/wiring-golden.mjs) reads the list in place and pins every listener, its event and its steps.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { stepAs } from './parts-wiring';

/** One window step: a part's lines for a window event, called with the window's scope (and, as a listener, the event's arguments). */
export type WindowStep = (win: BrowserWindow, owner: MediaOwner, windowId: number, ...args: any[]) => void;
/** One listener: on the window ('win') or its page ('webContents'), for one event: its steps in order, or one shared helper. */
export type WindowListener = readonly [target: 'win' | 'webContents', event: string, run: readonly WindowStep[] | WindowStep];
/** The order electron/main.ts gives (wireWindowEvents). */
export interface WindowEventOrder {
  /** The shared helpers: a listener of one helper is written as the helper itself; a part calls one with the window's scope. */
  readonly helpers: readonly WindowStep[];
  /** Every listener in registration order; a bare step runs once, when the window is secured (the shell's navigation guard, the companion's republish). */
  readonly listeners: readonly (WindowListener | WindowStep)[];
  /** A new main-frame document (a reload or a navigation, not an in-page one): the steps, in order (onNewDocument). */
  readonly newDocument: readonly WindowStep[];
  /** publishVisibility: these steps first, */
  readonly visible: readonly WindowStep[];
  /** then, while the window exists, these. */
  readonly visibleWhileOpen: readonly WindowStep[];
}

let listeners: WindowEventOrder['listeners'] = [];
let newDocumentSteps: readonly WindowStep[] = [];
let visibleSteps: readonly WindowStep[] = [];
let visibleWhileOpenSteps: readonly WindowStep[] = [];
/** Unbound v1 step 1 (electron/unbound/entry.ts): the companion window's visibility, told again when she goes out or comes back. */
export let republishPetVisibility: (() => void) | null = null;

/** electron/main.ts gives the order once, while it is evaluated (before any window is secured). */
export function wireWindowEvents(order: WindowEventOrder): void {
  for (const listener of order.listeners)
    if (typeof listener !== 'function' && typeof listener[2] === 'function' && !order.helpers.includes(listener[2]))
      throw new Error(`window events: the ${listener[1]} listener ${listener[2].name} is one step but not a shared helper`);
  // Overhaul step 7: each step runs as its unit's cleanup (always; a throw is caught and the next step runs: electron/wiring/steps-wiring.ts).
  listeners = Object.freeze([...order.listeners].map(listener => typeof listener === 'function' ? listener
    : [listener[0], listener[1], typeof listener[2] === 'function' ? stepAs(listener[2], 'cleanup') : listener[2].map(step => stepAs(step, 'cleanup'))] as const));
  newDocumentSteps = Object.freeze([...order.newDocument].map(step => stepAs(step, 'cleanup')));
  visibleSteps = Object.freeze([...order.visible].map(step => stepAs(step, 'cleanup')));
  visibleWhileOpenSteps = Object.freeze([...order.visibleWhileOpen].map(step => stepAs(step, 'cleanup')));
}

/** secureWindow's subscriber: every listener of the list, registered in its order, each running its steps in order. */
export function windowEvents(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  for (const listener of listeners) {
    if (typeof listener === 'function') { listener(win, owner, windowId); continue; }
    const [target, event, run] = listener;
    const steps = typeof run === 'function' ? [run] : run;
    const emitter: { on(event: string, listener: (...args: unknown[]) => void): unknown } = target === 'win' ? win : win.webContents;
    emitter.on(event, (...args: unknown[]) => { for (const step of steps) step(win, owner, windowId, ...args); });
  }
}

/** Listener step: a new main-frame document (not an in-page navigation): every part's newDocument step, in order. */
export function onNewDocument(win: BrowserWindow, owner: MediaOwner, windowId: number, details: { readonly isMainFrame: boolean; readonly isSameDocument: boolean }): void {
  if (details.isMainFrame && !details.isSameDocument) for (const step of newDocumentSteps) step(win, owner, windowId);
}

/** Shared helper: the window was shown, hidden, minimized, restored or loaded: the visible steps, then (while it exists) the rest. */
export function publishVisibility(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  for (const step of visibleSteps) step(win, owner, windowId);
  if (!win.isDestroyed()) for (const step of visibleWhileOpenSteps) step(win, owner, windowId);
}

/** Runs once per window: the companion window's publishVisibility is the one Unbound tells again. */
export function notePetWindow(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === 'pet') republishPetVisibility = () => publishVisibility(win, owner, windowId); // Unbound v1 step 1: told again when she goes out or comes back
}
