// 体验记录 (the experience journal): the small field checks every part's journal slice uses (shared/<part>/journal-entries.ts,
// shared/memory/journal.ts), the panel translator's type, and the two closed lists that slices of two parts both use (fatigue
// phases: mood and brain; Claude process kinds: brain and voice). Moved out of shared/memory/journal.ts on 2026-11-16 unchanged
// (docs/claude/2026-11-16-journal-split.md) and exported, so that no slice imports another part.

const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const round = (value: number, places = 1) => { const f = 10 ** places; return Math.round(value * f) / f; };
export const count = (value: unknown, max = 1_000_000): number | undefined => finite(value) && value >= 0 ? Math.min(max, Math.round(value)) : undefined;
export const unit = (value: unknown): number | undefined => finite(value) ? round(Math.min(1, Math.max(0, value)), 2) : undefined;
export const level = (value: unknown): number => finite(value) ? round(Math.min(100, Math.max(0, value))) : 0;
/** A millisecond span kept as a whole number, or null (a missing or impossible one). */
export const ms = (value: unknown): number | null => finite(value) && value >= 0 && value <= 3_600_000 ? Math.round(value) : null;
export const id = (value: unknown): string | null => typeof value === 'string' && ID.test(value) ? value : null;

/** The UI's translator (src/foundation/ui-language.ts uiText); tests pass a plain formatter. */
export type JournalTranslate = (source: string, ...values: readonly unknown[]) => string;

// ---- Closed lists two parts' slices share (a slice imports no other part, so they live here).
export const FATIGUE_PHASES = ['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'] as const;
/** First-char measuring: the Claude process a reply ran on (electron/brain/claude-session.ts ClaudeTimingInfo.process). */
export const FIRST_CHAR_PROCESSES = ['cold', 'prewarmed', 'warm'] as const;
export type FirstCharProcess = (typeof FIRST_CHAR_PROCESSES)[number];
