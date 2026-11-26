// I-098 on (docs/claude/2026-11-12-i098-on.md): which haiku keeps a message's mood book after her reply.
//
// With the reaction judge on, its warm haiku (electron/mood/reactions/wiring.ts, one long-lived `claude -p` process) already answered
// this message's reactions while she was talking. The book is then a second, short step on that same process: no process start
// (the experiment's one-off call took a median 4.2 s, mostly the start), and no second process beside her reply. Order:
//  1. wait until this message's reaction call is over (asked and answered, failed, timed out or never asked) and the warm process
//     is free: the reactions are never delayed or displaced by the book;
//  2. the warm process still alive and free: the book is asked there (speakOnlyWarmStepPrompt); a failure there is the book's
//     failure (the tailless lift stands in), never a second call;
//  3. no reaction judge, or its warm process is not alive (switched off, hidden, Claude down, still starting): the one-off call, as
//     before.
// Brain interface (docs/claude/brain-interface.md): the calls themselves stay in electron/initiative/inner-loop/ (model.ts, warm-line.ts).
import { speakOnlyWarmStepPrompt } from './judge';
import type { SpeakOnlyAnswer } from './judge-host';

/** The reactions' warm haiku as the book uses it (electron/mood/reactions/wiring.ts createReactions().speakOnlyWarm). */
export interface SpeakOnlyWarmPort {
  /** The reaction judge is on and its warm process is alive. */
  alive(): boolean;
  /** A call is running on the warm process right now. */
  calling(): boolean;
  /** Resolves when this message's reaction call is over and no call runs on the warm process (at once when there is none). */
  idle(): Promise<void>;
  ask(prompt: string, signal: AbortSignal): Promise<string>;
}

export interface SpeakOnlyRouteOptions {
  /** The one-off haiku call (electron/initiative/inner-loop/model.ts quickLineWithClaude in the app). */
  oneShot(prompt: string, systemPrompt: string, signal: AbortSignal): Promise<string>;
  /** The reactions' warm haiku; null when the reaction judge does not exist. */
  warm(): SpeakOnlyWarmPort | null;
}

/** Rejects when `signal` aborts (a no-op catch is attached, so an abort after the race was won is never an unhandled rejection). */
const aborted = (signal: AbortSignal) => {
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  promise.catch(() => {});
  return promise;
};

/** The book's ask: a second step on the reactions' warm haiku when it is there, else the one-off call. One call either way. */
export function speakOnlyRoute(options: SpeakOnlyRouteOptions): (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<SpeakOnlyAnswer> {
  const port = (): SpeakOnlyWarmPort | null => { try { return options.warm(); } catch { return null; } };
  const usable = (warm: SpeakOnlyWarmPort | null) => { try { return !!warm && warm.alive(); } catch { return false; } };
  return async (prompt, systemPrompt, signal): Promise<SpeakOnlyAnswer> => {
    signal.throwIfAborted();
    const warm = port();
    if (warm && usable(warm)) {
      // The reaction call first (it started early, beside her reply); a newer message aborts this wait through `signal`.
      await Promise.race([Promise.resolve().then(() => warm.idle()).catch(() => {}), aborted(signal)]);
      let free = false;
      try { free = warm.alive() && !warm.calling(); } catch { free = false; }
      if (free) return { text: await warm.ask(speakOnlyWarmStepPrompt(prompt), signal), via: 'warm' };
    }
    signal.throwIfAborted();
    return { text: await options.oneShot(prompt, systemPrompt, signal), via: 'one-shot' };
  };
}
