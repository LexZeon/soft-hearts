/**
 * I-091 step 4: a paid voice (Bailian, Drama 3) bills per synthesis call, and one reading piece is one call. In a call her first
 * sentence is a few words long on purpose ("嗯，我在。"), so a piece under `minChars` is held and joined with the piece after it:
 * never more than one call per piece, and the joined piece is exactly the two source slices side by side (the host checks every
 * piece against the reply text). The free system voice does not use this. Whatever is held when the reply ends is sent as it is.
 */
export interface MergePiece { start: number; end: number; text: string }
export interface MergePieceParser { push(delta: string): MergePiece[]; finish(): MergePiece[]; cancel(): void }

export class MergeShortPieces implements MergePieceParser {
  private held: MergePiece | null = null;
  constructor(private readonly inner: MergePieceParser, private readonly minChars: number) {}

  push(delta: string): MergePiece[] { return this.take(this.inner.push(delta), false); }
  finish(): MergePiece[] { return this.take(this.inner.finish(), true); }
  cancel(): void { this.held = null; this.inner.cancel(); }

  private take(pieces: MergePiece[], final: boolean): MergePiece[] {
    const out: MergePiece[] = [];
    for (const piece of pieces) {
      let current = piece;
      const held = this.held; this.held = null;
      if (held) current = held.end === piece.start ? { start: held.start, end: piece.end, text: held.text + piece.text } : (out.push(held), piece);
      if (current.text.trim().length < this.minChars) this.held = current; else out.push(current);
    }
    if (final && this.held) { out.push(this.held); this.held = null; }
    return out;
  }
}
