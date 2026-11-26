// Markdown emphasis in her words ("**晶莹**", "__晶莹__"): the markers are not shown and not read aloud, the words stay
// (docs/claude/2026-11-18-t250-fixes.md, Codex T-250). One scanner for a finished text (stripEmphasis) and for a stream
// that arrives in pieces (EmphasisStream, used in the host right after the reply protocol, so the bubble, the voice proofs
// and the archive all get the same text). Only the doubled markers are taken: a single "*动作*" is her stage-direction
// convention (shown, not read: speakable-text.ts) and stays as it is. A lone "*", "2**3**4", "a ** b" and "foo__bar__baz" are kept.

const MARK = /\*\*|__/u;
/** A marked run longer than this (or across a line break) is not emphasis; the text goes out as written. */
const MAX_RUN = 160;
const WORD = /[A-Za-z0-9]/u;

interface Scanned { out: string; rest: string }

/** `final`: nothing more comes, so whatever is held goes out as written. */
function scan(input: string, final: boolean): Scanned {
  let out = '', at = 0;
  for (;;) {
    const found = MARK.exec(input.slice(at));
    if (!found) break;
    const open = at + found.index, mark = found[0];
    const before = open > 0 ? input[open - 1] : '';
    const after = input.slice(open + 2);
    // Not an opening marker: a word character in front ("2**3", "foo__bar__baz"), or blank / nothing / another mark after it.
    if (WORD.test(before) || before === mark[0] || /^[\s*_]/u.test(after)) {
      out += input.slice(at, open + 2); at = open + 2; continue;
    }
    // The closing marker: same one, on the same line, close enough, no blank just inside it, no word character after it.
    let close = -1;
    for (let from = open + 2; ;) {
      const next = input.indexOf(mark, from);
      if (next < 0 || next - open > MAX_RUN) break;
      if (input.slice(open + 2, next).includes('\n')) break;
      if (next > open + 2 && !/\s/u.test(input[next - 1]) && !WORD.test(input[next + 2] ?? '') && input[next + 2] !== mark[0]) { close = next; break; }
      from = next + 1;
    }
    if (close >= 0) { out += input.slice(at, open) + input.slice(open + 2, close); at = close + 2; continue; }
    const dead = after.includes('\n') || after.length > MAX_RUN || final;
    if (dead) { out += input.slice(at, open + 2); at = open + 2; continue; }
    // Might still close: hold from the opening marker.
    return { out: out + input.slice(at, open), rest: input.slice(open) };
  }
  const tail = input.slice(at);
  // A single "*" or "_" at the very end may be the first half of a marker that the next piece completes.
  if (!final && /[*_]$/u.test(tail)) return { out: out + tail.slice(0, -1), rest: tail.slice(-1) };
  return { out: out + tail, rest: '' };
}

/** A finished text without the doubled emphasis markers. */
export function stripEmphasis(text: string): string {
  if (!/\*\*|__/u.test(text)) return text;
  return scan(text, true).out;
}

/** The same for a stream; push() sends what is settled to `emit`, flush() the rest at the end of the reply. */
export class EmphasisStream {
  private held = '';
  constructor(private readonly emit: (text: string) => void) {}
  push(text: string): void {
    if (!text) return;
    if (!this.held && !/[*_]/u.test(text)) { this.emit(text); return; } // the usual case: nothing to look at
    const { out, rest } = scan(this.held + text, false);
    this.held = rest;
    if (out) this.emit(out);
  }
  flush(): void {
    if (!this.held) return;
    const { out } = scan(this.held, true);
    this.held = '';
    if (out) this.emit(out);
  }
}
