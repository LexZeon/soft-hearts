// 只有插话会打断她: the one place where a change that has to restart or clear something her reply is using waits until the
// reply and its voice are done (electron/voice/settle-when-quiet.ts). Made once by wireBrain; the connection / persona save step
// (brain-wiring savedCompanionContext), the vision reset (senses-look-wiring) and the new chat turn (brain-chat-wiring: you cut in, so what
// waited runs first) read it. No module-level side effects.
import { SettleWhenQuiet } from '../voice';
import type { DeferredWhile, SettingDeferral } from '../../shared/voice/interrupt-policy';

export interface QuietNeeds {
  /** A chat turn is running. */
  replying(): boolean;
  /** Her reply is being read aloud. */
  speaking(): boolean;
  /** The experience journal row (closed words). */
  record(what: SettingDeferral, during: DeferredWhile): void;
}

let settle: SettleWhenQuiet | null = null;

export function wireQuiet(needs: QuietNeeds): SettleWhenQuiet {
  settle = new SettleWhenQuiet({
    busy: () => needs.replying() ? 'replying' : needs.speaking() ? 'speaking' : null,
    note: (what, during) => needs.record(what, during),
    every: (ms, run) => { const timer = setInterval(run, ms); return () => clearInterval(timer); },
  });
  return settle;
}

/** Runs `action` now when she is quiet, else once she is. Before wireBrain made the gate: now. */
export function settleWhenQuiet(what: SettingDeferral, action: () => void | Promise<void>): void | Promise<void> {
  return settle ? settle.run(what, action) : action();
}
/** You cut in with a new message: what waited runs now. */
export function flushSettled(): Promise<void> { return settle ? settle.flush() : Promise.resolve(); }
/** Quitting: what waited is dropped. */
export function dropSettled(): void { settle?.cancel(); }
/** True when she is busy (the row is written): the change then waits by itself; false: do it now. */
export function waitsForHer(what: SettingDeferral): boolean { return settle?.waitsFor(what) ?? false; }
