// I-139 A3, security review 2026-11-15: what a quote must be before it can sit at the top of every new opening (layer 2). The handoff checks a
// new quote with these; the store checks every version it loads with `looksLikeInstruction`; a deletion re-checks with `quoteStillThere`.
// Kept narrow on purpose: words like 不要 / 可以 / 需要 are in many touching lines, so they are not here (unlike reply-self-note's DIRECTIVE).

/** Words that address a model rather than tell of a day. A quote holding any of them is never used. */
export const INSTRUCTION_LIKE = /忽略|无视|设定|指令|提示词|系统|扮演|你现在是|从现在起|ignore|instruction|system|prompt|pretend|you are now/iu;

export function looksLikeInstruction(text: string): boolean { return INSTRUCTION_LIKE.test(text); }

/** Where a quote may start or end inside its record (besides the record's own start and end). '.' is there for English cards. */
const BOUNDARY = /[。！？!?…\n，,~～.]/u;
const isBoundary = (char: string | undefined) => char !== undefined && BOUNDARY.test(char);

/**
 * True when `quote` occurs in `content` starting at the record's start or right after a sentence mark (spaces between are allowed), and
 * ending at the record's end or right before one (or with a mark of its own as its last character). A piece cut out of the middle of a
 * sentence is not a line from that day.
 */
export function onNaturalBoundary(content: string, quote: string): boolean {
  if (!quote) return false;
  for (let at = content.indexOf(quote); at >= 0; at = content.indexOf(quote, at + 1)) {
    const before = content.slice(0, at).replace(/[ \t　]+$/u, ''), after = content.slice(at + quote.length).replace(/^[ \t　]+/u, '');
    const startOk = before === '' || isBoundary(before.at(-1));
    const endOk = after === '' || isBoundary(after[0]) || isBoundary(quote.at(-1));
    if (startOk && endOk) return true;
  }
  return false;
}

/** The two quotes overlap: one holds the other. */
export function overlaps(a: string, b: string): boolean { return !!a && !!b && (a.includes(b) || b.includes(a)); }
