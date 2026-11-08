import { ipcRenderer } from 'electron';
import type { ReplyLayout } from './reply-layout';
import { renderReplyWaiting } from '../shared/reply-waiting-presentation';
import type { PetReplyPieces } from '../shared/contracts';
import { renderReplyPieces, replyPiecesKey } from './reply-pieces-dom';

// No contextBridge API, Node access or inbound host capability is exposed to this surface.
let pending: { text: string; waiting: boolean; segmented: boolean; pieces: PetReplyPieces | null; layout: ReplyLayout; interactionOpacity: number; presentationToken: string | null } | undefined;
let paintToken: string | null = null;
let presentedToken: string | null = null;
let paintFrame: number | undefined;
let renderedBody = false;
let renderedSegmented = false;
let renderedPieces = '';
function renderReplyText(body: HTMLElement, text: string, segmented: boolean, pieces: PetReplyPieces | null): void {
  if (!segmented && pieces) { renderReplyPieces(body, text, pieces); return; }
  if (!segmented) { body.textContent = text; return; }
  const fragment = body.ownerDocument.createDocumentFragment();
  const separator = /(?:\r\n|\r|\n){2,}/g;
  let start = 0, count = 0, match: RegExpExecArray | null;
  const append = (value: string, className: string) => {
    if (!value) return;
    const node = body.ownerDocument.createElement('div'); node.className = className; node.textContent = value; fragment.append(node);
  };
  while (count < 127 && (match = separator.exec(text))) {
    append(text.slice(start, match.index), 'reply-piece');
    append(match[0], 'reply-gap');
    start = match.index + match[0].length; count++;
  }
  append(text.slice(start), 'reply-piece');
  body.replaceChildren(fragment);
}

function cancelPaint(): void {
  if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
  paintFrame = undefined; paintToken = null;
}
function queuePresentation(body: HTMLElement): void {
  const current = pending, token = current?.presentationToken;
  if (!current || !token || current.waiting || !current.text.trim() || current.interactionOpacity <= 0) { cancelPaint(); return; }
  if (presentedToken === token || paintToken === token) return;
  cancelPaint(); paintToken = token;
  const text = current.text, segmented = current.segmented, startedAt = performance.now();
  const sameRevision = () => paintToken === token && pending?.presentationToken === token && !pending.waiting
    && pending.interactionOpacity > 0 && pending.text === text && pending.segmented === segmented && body.textContent === text;
  const visible = () => {
    const rect = body.getBoundingClientRect(), style = getComputedStyle(body), page = getComputedStyle(document.body);
    return document.visibilityState === 'visible' && rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && Number(page.opacity) > 0;
  };
  const firstFrame = () => {
    if (!sameRevision() || performance.now() - startedAt > 5000) { cancelPaint(); return; }
    if (!visible()) { paintFrame = requestAnimationFrame(firstFrame); return; }
    // The second frame runs after the first visible paint opportunity. The host
    // independently checks actual native visibility and this exact nonce again.
    paintFrame = requestAnimationFrame(() => {
      if (!sameRevision() || performance.now() - startedAt > 5000) { cancelPaint(); return; }
      if (!visible()) { paintFrame = requestAnimationFrame(firstFrame); return; }
      presentedToken = token; paintFrame = undefined; paintToken = null;
      ipcRenderer.send('desk:reply-presented', token);
    });
  };
  paintFrame = requestAnimationFrame(firstFrame);
}
function render(): void {
  if (!pending) return;
  const body = document.getElementById('reply-body');
  const tail = document.querySelector('#reply-tail path');
  if (!body || !tail) return;
  const { text, waiting, segmented, layout, interactionOpacity } = pending;
  const segmentedBody = !waiting && segmented;
  // R27 pieces only lay out this exact text; anything else keeps the original rendering.
  const piecesKey = waiting || segmentedBody ? '' : replyPiecesKey(pending.pieces, text);
  body.dataset.segmented = String(segmentedBody);
  if (piecesKey) body.dataset.pieces = pending.pieces!.mode; else delete body.dataset.pieces;
  document.body.style.opacity = String(interactionOpacity);
  body.dataset.side = layout.side;
  body.dataset.above = String(layout.above);
  const svg = document.getElementById('reply-tail')!;
  svg.dataset.tipX = String(layout.tip.x); svg.dataset.tipY = String(layout.tip.y);
  svg.dataset.layoutX = String(layout.bounds.x); svg.dataset.layoutY = String(layout.bounds.y);
  svg.dataset.layoutWidth = String(layout.bounds.width); svg.dataset.layoutHeight = String(layout.bounds.height);
  const hadBody = renderedBody;
  renderedBody = !waiting && !!text.trim();
  renderReplyWaiting(body, waiting);
  const changedText = !waiting && body.textContent !== text;
  if (!waiting && (changedText || renderedSegmented !== segmentedBody || renderedPieces !== piecesKey)) renderReplyText(body, text, segmentedBody, piecesKey ? pending.pieces : null);
  renderedSegmented = segmentedBody;
  renderedPieces = waiting ? '' : piecesKey;
  body.style.left = `${layout.body.x}px`;
  body.style.width = `${layout.body.width}px`;
  body.style.maxHeight = `${layout.body.height}px`;
  body.style.top = layout.above ? 'auto' : `${layout.body.y}px`;
  body.style.bottom = layout.above ? `${layout.bounds.height - layout.body.y - layout.body.height}px` : 'auto';
  // This auxiliary window is mouse-transparent. Follow arriving text here; the
  // owner's full reader keeps every character and a user's own scroll position.
  if (changedText) body.scrollTop = hadBody ? body.scrollHeight : 0;
  const rect = body.getBoundingClientRect();
  // A bounded corner triangle indicates direction without reaching the mouth.
  const base = layout.side === 'right' ? rect.left + 11 : rect.right - 11;
  const inward = layout.side === 'right' ? 17 : -17;
  const y = layout.above ? rect.bottom - 1 : rect.top + 1;
  tail.setAttribute('d', `M ${base} ${y} L ${layout.tip.x} ${layout.tip.y} L ${base + inward} ${y} Z`);
  queuePresentation(body);
}
ipcRenderer.on('desk:reply-render', (_event, value: { text?: string; waiting?: boolean; segmented?: boolean; pieces?: PetReplyPieces | null; layout: ReplyLayout; interactionOpacity?: number; presentationToken?: string | null }) => {
  const token = typeof value.presentationToken === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.presentationToken) ? value.presentationToken : null;
  pending = { text: value.text ?? pending?.text ?? '', waiting: value.waiting ?? pending?.waiting ?? false, segmented: value.segmented === true, pieces: value.pieces ?? null, layout: value.layout,
    interactionOpacity: value.interactionOpacity ?? 1, presentationToken: token }; render();
});
window.addEventListener('DOMContentLoaded', render, { once: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); else cancelPaint(); });
window.addEventListener('beforeunload', cancelPaint, { once: true });
