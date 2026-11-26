// The foundation's port types (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2 "基础层的接口").
// Types only: what one part may ask of the rest of the app through the wiring, without importing another part. A part's wiring
// (electron/wiring/<part>-wiring.ts) is handed objects of these shapes; nothing here has a value or a module-level effect.
// Electron-side shapes (windows) are in electron/foundation/ports.ts.
import type { AppSettings } from './settings';
import type { CharacterCard } from './character-card';

/** A journal line: a closed type and numbers or closed words, never text (electron/memory/journal/). */
export interface JournalLine { readonly type: string; readonly characterId?: string | null; readonly [field: string]: unknown }
/** Where the experience journal goes; off, record() does nothing. */
export interface JournalSink { record(line: JournalLine): void }

/** Whether a chat turn runs now (the old `[...pending.values()].some(task => task.kind === 'chat')`). */
export interface ChatActivity { chatBusy(): boolean }
/** Whether she is reading aloud or the window still plays her voice. */
export interface SpeechActivity { replySpeechBusy(): boolean; playbackBusy(): boolean }

/** The current character, connection and conversation as one opaque key, and the memory scope. */
export interface ScopePort {
  speechScope(): string;
  currentScope(): { readonly characterId: string; readonly providerScope: string };
}
/** The active character card (read at the moment of use). */
export interface ActiveCardPort { activeCard(): CharacterCard; activeCardId(): string }
/** Recent chat lines for a part that needs the conversation's context (read only). */
export interface HistoryWindowPort { recentLines(count: number): readonly string[] }

/**
 * One line from Claude for a part (a quick line, a judge, a look). The wiring adds what every companion call has: no tools and no
 * write access. There is deliberately no `writable` and no `tools` here (CLAUDE.md: companion chat stays tool-free).
 */
export interface ClaudeLinePort {
  line(prompt: string, systemPrompt: string, signal: AbortSignal): Promise<{ readonly text: string }>;
}

/** A settings change, in the order saveSettings tells the parts (the wiring golden pins the order). */
export type SettingsChangeHook = (next: AppSettings, previous: AppSettings) => void;
/** One claimant of her mood cue, asked in the order of the cue chain (electron/main.ts companion mood callback). */
export interface CueClaimant<C = unknown> { readonly id: string; claims(cue: C): boolean }

/** What the senses report that other parts may read (closed facts, never a picture or words). */
export interface PerceptionFacts {
  readonly screenSharing: boolean;
  readonly cameraFrames: boolean;
  readonly voiceInput: boolean;
  readonly systemAudio: boolean;
}
/** What her inner loop reads each tick. */
export interface InnerLoopInputs {
  readonly asleep: boolean;
  readonly chatBusy: boolean;
  readonly userInputUntil: number;
  readonly petOnScreen: boolean;
}

/** One unit the part runner switched off (step 7, docs/claude/2026-11-17-isolation-step7.md): only closed words, never an error message. */
export interface PartOffView {
  readonly part: string;
  readonly unit: string;
  /** What failed: its start, or a tick or a callback three times in a row. */
  readonly category: 'start' | 'tick' | 'callback';
  /** 'start': it did not start this time; 'running': it failed while running. */
  readonly when: 'start' | 'running';
  /** `<category>:<error.name>`, nothing else (the journal's part-off line keeps this). */
  readonly reason: string;
  readonly at: number;
}
/** Which parts the runner started, and which units are off (strict mode: never any). */
export interface PartHealthView {
  readonly mode: 'strict' | 'isolate';
  readonly started: readonly string[];
  readonly off: readonly PartOffView[];
}
