/**
 * Drama 3 (Fish) network failures get one more try (the journal showed a speech row with failure
 * network and then an unread reading nobody retried). The 2026-11-03 rule ("a failed paid reading
 * is not retried") was about not spending twice on a refusal; a request that never connected has not been accepted, so it is not billed
 * (electron/voice/tts.ts only counts a request once the service accepted it), and the second try costs nothing extra.
 *
 * Written so that nothing doubles and nothing hangs:
 * - Only a failure of kind `network` (the request never connected), and only before any audio was handed on: after the first sound a
 *   second try would repeat words she had already said.
 * - The same sentence, the same words, once. After a short pause (a range, so two failures never look like a machine), cut short by a stop.
 * - A stop or a new reply (the signal) ends it at once and is never retried.
 * - When the second try fails too, its error is the one that comes out, marked `retried`, so the speech row and the reply's reading
 *   row can say "failed after a retry".
 *
 * Electron-free; the clock and the pause are injected.
 */
import { budgetedFishSynthesizer, type FishBudget, type FishSynthesizer } from './fish-voice-host';
import { synthesizeFishSpeech, TtsError } from './tts';

/** The pause before the second try, in ms: somewhere in this range (not a fixed number). */
export const FISH_RETRY_PAUSE_MS: readonly [number, number] = [350, 900];

export interface FishRetryOptions {
  /** The pause in ms; the default draws from FISH_RETRY_PAUSE_MS. */
  pauseMs?(): number;
  /** Waits ms, resolving early (false) when the signal aborts; the default is a timer. */
  wait?(ms: number, signal: AbortSignal): Promise<boolean>;
}

const defaultPause = () => FISH_RETRY_PAUSE_MS[0] + Math.random() * (FISH_RETRY_PAUSE_MS[1] - FISH_RETRY_PAUSE_MS[0]);
function defaultWait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Whether this failure is the kind a second try can fix: the request never connected (and says so). */
export function worthRetrying(error: unknown): boolean { return error instanceof TtsError && error.kind === 'network'; }

export function retryingFishSynthesizer(inner: FishSynthesizer, options: FishRetryOptions = {}): FishSynthesizer {
  const pause = options.pauseMs ?? defaultPause, wait = options.wait ?? defaultWait;
  return async (config, text, signal, emit, context) => {
    let handedOn = false;
    const watched: typeof emit = event => { handedOn = true; return emit(event); };
    try {
      return await inner(config, text, signal, watched, context);
    } catch (first) {
      if (handedOn || signal.aborted || !worthRetrying(first)) throw first;
      if (!(await wait(Math.max(0, Math.round(pause())), signal)) || signal.aborted) throw first;
      try {
        return await inner(config, text, signal, emit, context);
      } catch (second) {
        if (second instanceof TtsError) second.retried = true;
        throw second;
      }
    }
  };
}

/** Drama 3 as the host uses it: under the monthly limit (refused once it is used up, counted once the service accepted a request), and a request that never connected tried once more. */
export function fishVoiceSynthesizer(budget: FishBudget, synthesize: typeof synthesizeFishSpeech = synthesizeFishSpeech, retry?: FishRetryOptions): FishSynthesizer {
  return retryingFishSynthesizer(budgetedFishSynthesizer(budget, synthesize), retry);
}
