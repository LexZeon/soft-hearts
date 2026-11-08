// D2 / I-008 "测试：xxx" (docs/claude/2026-11-03-test-commands.md): in developer mode, a chat message that starts with
// "测试：" (or "测试:") is a test command, not a chat. Pure helpers only: recognising the prefix, normalising text for
// alias matching, and the closed shapes the window and the host exchange. No Electron, no model, no I/O.

/** The longest explanation after "测试：" that is still a command; anything longer is an ordinary message. */
export const TEST_COMMAND_MAX_BODY = 120;
/** Longest note line the window accepts from the host. */
export const TEST_NOTE_MAX = 4000;

const PREFIX = /^\s*测试\s*[:：︰﹕]\s*/u;

export interface TestCommandText {
  /** What follows the prefix: trimmed, whitespace collapsed (possibly empty). */
  body: string;
}

/**
 * "测试：去忙自己的事" → { body: '去忙自己的事' }. Only the very start of the message counts, with a full-width or half-width
 * colon and optional spaces around it. Not a command (null): no prefix, or an explanation too long to be one.
 */
export function parseTestCommand(text: unknown): TestCommandText | null {
  if (typeof text !== 'string') return null;
  const match = PREFIX.exec(text.slice(0, TEST_COMMAND_MAX_BODY * 4 + 64));
  if (!match) return null;
  const body = text.slice(match[0].length).replace(/\s+/gu, ' ').trim();
  return [...body].length > TEST_COMMAND_MAX_BODY ? null : { body };
}

/**
 * The window's cheap gate before it asks the host: developer mode is on, nothing is attached, and the text has the prefix.
 * False in every other case, which is how a "测试：…" message stays an ordinary chat message outside developer mode.
 */
export function asksTestCommand(developerMode: boolean, hasAttachments: boolean, text: unknown): boolean {
  return developerMode === true && !hasAttachments && parseTestCommand(text) !== null;
}

/**
 * The form aliases are compared in: Unicode compatibility folded (full-width letters and digits become ordinary ones),
 * lower-cased, with spaces and every punctuation or symbol character removed.
 */
export function normalizeTestText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** What the window asks for, and what the host answers. Only `text` leaves the window; the host decides everything else. */
export interface TestCommandOutcome {
  /** False: not a test command here (developer mode is off, or no prefix); the window sends it as ordinary chat. */
  handled: boolean;
  /** Names this command's note lines (late notes arrive on the same id). */
  id: string;
}

/** One line shown under the user's own "测试：…" line. It is not her speech and is never archived. */
export interface TestCommandNote {
  id: string;
  text: string;
}

/** Things a test command can ask a window to do on the stage. A closed set; nothing carries text or paths. */
export type TestEffect = 'music-rejudge';
export const TEST_EFFECTS: readonly TestEffect[] = ['music-rejudge'];
export const isTestEffect = (value: unknown): value is TestEffect => typeof value === 'string' && (TEST_EFFECTS as readonly string[]).includes(value);
