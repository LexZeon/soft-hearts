// A stray full stop in front of an echoed tag line (docs/claude/2026-11-21-tag-leak.md). Dev build 8d32d394, 2026-11-21 12:51: the reply
// began ".\n</thinking_mode>\n\n…her words…". The tag line alone is already cut at the head of the reply (TAG_ONLY_LINE in
// reply-draft-guard.ts), but the "." in front of it made the head look like an ordinary start, so both were shown and kept in the record.
// Language-independent. Only a lone punctuation mark on its own line, directly followed by a line of bare tags, goes with the tag line;
// a "." that is followed by anything else is released as before.

/** A lone mark on the first line: a full stop (also 。 ·) or an ellipsis, up to three of them. */
const LEAD_MARK = /^([.。·…]{1,3})[ \t]*(\r?\n)?/u;
const BLANK_LINES = /^(?:[ \t]*\r?\n)*/u;

/**
 * body is the head so far (blank trimmed at the start); tagLine returns the length of a whole line of bare tags at the start of a text
 * (0: not one), tagStart tells whether an unfinished first line could still become one. Returns 'none' (not this shape: release as
 * today), 'wait' (it could still become this shape: a lone "." or "。" with nothing behind it yet, or a tag line that is not
 * complete) or the number of characters to drop (the mark, its line break, and the tag line with its own break).
 */
export function strayMarkBeforeTagLine(
  body: string,
  final: boolean,
  tagLine: (text: string) => number,
  tagStart: (line: string) => boolean,
): 'none' | 'wait' | number {
  const lead = LEAD_MARK.exec(body);
  if (!lead) return 'none';
  const rest0 = body.slice(lead[0].length);
  if (!lead[2]) {
    // No line break yet: only a single full stop can still turn into the shape. An ellipsis is never held (a reply may open with one).
    return (rest0 === '' || rest0 === '\r') && !final && lead[1].length === 1 && lead[1] !== '…' ? 'wait' : 'none';
  }
  const blank = BLANK_LINES.exec(rest0)![0].length;
  const rest = rest0.slice(blank);
  if (!rest) return final ? 'none' : 'wait';
  const own = tagLine(rest);
  if (own > 0) return lead[0].length + blank + own;
  const line = /^[^\r\n]*/u.exec(rest)![0];
  return !final && line.length === rest.length && tagStart(line) ? 'wait' : 'none';
}
