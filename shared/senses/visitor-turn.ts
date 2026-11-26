// I-135: a line someone other than the user sent (the face check said clearly not them; docs/claude/2026-11-15-i135-face-chat.md).
// It stays in the archive and in her window, but the window shows it marked, so she reads it as not his and never as the user's words.
// Same style as the time markers of the long-chat window (electron/brain/long-chat/history.ts): a short 【…】 in front of the line.

export const VISITOR_MARK = '【不是他本人说的】';

/**
 * How a visitor's line reads in a window sent to Claude (and in the refilled chat after a switch). `mark`: I-139's
 * (shared/foundation/i139-texts.ts VISITOR_MARK_RELAXED) under its switch. Nothing reads the mark back: the archive keeps `speaker` instead.
 */
export function visitorContent(text: string, mark: string = VISITOR_MARK): string {
  return mark + text;
}

/** The speaker field as stored: only 'visitor' means anything; everything else (older archives, odd values) is the user. */
export function speakerOf(value: unknown): 'visitor' | undefined {
  return value === 'visitor' ? 'visitor' : undefined;
}
