import type { PetReplyPieces } from '../shared/contracts';
import { planReplyPieces, validReplyPieces, type PlannedReplyPiece } from '../shared/reply-bubbles';

/**
 * Native reply-window rendering of R27 pieces (shared/reply-bubbles.ts).
 * The body's textContent stays exactly the host text revision, so the paint
 * receipt and completed-prefix speech proof are unchanged. Existing nodes are
 * reused while the stream grows: earlier text never re-renders, and only a
 * genuinely new piece gets the entry animation.
 */
const pieceRaw = new WeakMap<Element, string>();
const bodyMode = new WeakMap<Element, string>();

/** Stable render key, or '' when the pieces do not describe this exact text. */
export function replyPiecesKey(pieces: PetReplyPieces | null | undefined, text: string): string {
  return pieces && validReplyPieces(pieces, text) ? `${pieces.mode}:${pieces.ends.join(',')}` : '';
}

function fill(node: HTMLElement, piece: PlannedReplyPiece): void {
  const document = node.ownerDocument;
  const space = (value: string) => { const span = document.createElement('span'); span.className = 'reply-space'; span.textContent = value; return span; };
  node.replaceChildren(space(piece.lead), document.createTextNode(piece.core), space(piece.trail));
}

export function renderReplyPieces(body: HTMLElement, text: string, pieces: PetReplyPieces): void {
  const document = body.ownerDocument;
  let nodes = Array.from(body.children) as HTMLElement[];
  if (bodyMode.get(body) !== pieces.mode || body.childNodes.length !== nodes.length || nodes.some(node => !pieceRaw.has(node))) {
    body.replaceChildren(); nodes = [];
  }
  bodyMode.set(body, pieces.mode);
  const plan = planReplyPieces(text, pieces);
  let current = -1;
  plan.forEach((piece, index) => { if (!piece.blank) current = index; });
  plan.forEach((piece, index) => {
    const raw = piece.lead + piece.core + piece.trail;
    let node = nodes[index];
    const previous = node ? pieceRaw.get(node) : undefined;
    if (!node || previous === undefined || !raw.startsWith(previous)) {
      const fresh = document.createElement('div');
      fresh.className = 'reply-chunk reply-chunk-new';
      if (node) node.replaceWith(fresh); else body.append(fresh);
      nodes[index] = node = fresh;
    }
    if (pieceRaw.get(node) !== raw) { fill(node, piece); pieceRaw.set(node, raw); }
    node.classList.toggle('reply-chunk-blank', piece.blank);
    node.classList.toggle('reply-chunk-gap', piece.gap);
    node.classList.toggle('reply-chunk-past', pieces.mode === 'bubbles' && index !== current);
  });
  for (const extra of nodes.slice(plan.length)) extra.remove();
}

