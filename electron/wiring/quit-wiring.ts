// Before quitting (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md): what every part does when the app quits, as two
// ordered lists electron/main.ts gives (wireQuit). The quit steps run on every before-quit, in order: each part stops, disposes or holds
// the quit (a step calls event.preventDefault() while something it owns still has to end; the app quits again when it has). The flush
// steps run once, from holdForFlush, after the quit steps above it disposed what could still write: first the chats in flight get their
// time (≤3 s), then a conversion still saving, then her conversation, then the stores. A part that needs another quit step writes it in its
// file (electron/wiring/<part>-cleanup-wiring.ts or its wiring file) and adds it to the list. The wiring golden reads both lists in place
// (order.beforeQuit).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app } from 'electron';
import { companion } from './brain-wiring';
import { stepAs } from './parts-wiring';

/** A quit step: called with the before-quit event, on every before-quit. */
export type QuitStep = (event: { preventDefault(): void }) => void;
/** A flush step: run once, in order, each awaited. */
export type FlushStep = () => void | Promise<void>;

let quitSteps: readonly QuitStep[] = [];
let flushSteps: readonly FlushStep[] = [];
/** The app is quitting: the control window's close quits instead of hiding; the parts read it (the table's exiting). */
export let exiting = false;
let flushedCompanion = false;
let flushingCompanion = false;

/** electron/main.ts gives the two lists once, where its before-quit listener was registered. */
export function wireQuit(steps: readonly QuitStep[], flush: readonly FlushStep[]): void {
  // Overhaul step 7: each step runs as its unit's cleanup (always; a throw or a rejected flush is caught and the next one runs: steps-wiring.ts).
  quitSteps = Object.freeze([...steps].map(step => stepAs(step, 'cleanup')));
  flushSteps = Object.freeze([...flush].map(step => stepAs(step, 'cleanup')));
  app.on("before-quit", event => { for (const step of quitSteps) step(event); });
}

/** Quit step (trunk): from here on the app is exiting. */
export function markExiting(): void {
  exiting = true;
}
/** Quit step (trunk): while her conversation has not been flushed, the quit waits; the flush steps run once, then the app quits again. */
export function holdForFlush(event: { preventDefault(): void }): void {
  if (companion && !flushedCompanion) {
    event.preventDefault();
    if (!flushingCompanion) {
      flushingCompanion = true;
      // Aborting providers settles their pending text writes before closing the archive.
      void (async () => {
        for (const step of flushSteps) await step();
      })().catch(error => console.error('Private companion state could not be flushed:', error))
        .finally(() => { flushedCompanion = true; app.quit(); });
    }
  }
}
