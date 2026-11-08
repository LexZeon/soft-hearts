import type { fatigueSnapshot } from './fatigue';

/** Host state only; separate from the portable five-channel card and MoodSnapshot. */
export type FatigueSnapshot = ReturnType<typeof fatigueSnapshot>;
export type FatigueView = Readonly<FatigueSnapshot & {
  /** Remains false until the host supplies current chat/TTS/manual ownership. */
  sleepEntryReady: boolean;
  storageError?: string;
  /** I-022, developer mode only (electron/mood.ts): the last time off screen counted as rest. Memory only. */
  rest?: FatigueRestNote;
}>;

/**
 * I-022 (shared/behaviors/sleep-rhythm/): one time she was off screen and it counted as rest. `kind`: 'closed' the app was closed
 * (the previous run had her on screen; `exact` false when it did not quit normally, then `awayMs` is an upper bound), 'away' she
 * was not on screen (another character, or her own last save), 'paused' the app stayed open but both clocks jumped (the computer
 * slept). `countedMs` ≤ the longest rest (maxOfflineMs). A and F before and after, 0–1.
 */
export interface FatigueRestNote {
  readonly kind: 'closed' | 'away' | 'paused';
  readonly at: number;
  readonly awayMs: number;
  readonly countedMs: number;
  readonly exact: boolean;
  readonly before: Readonly<{ A: number; F: number }>;
  readonly after: Readonly<{ A: number; F: number }>;
}
