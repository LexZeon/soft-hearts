/** Shared by the control renderer and the isolated native reply preload. */
export const WAITING_DOTS_CSS = `
.reply-waiting{display:inline-flex;align-items:center;gap:5px;min-height:1.2em;color:#b7dfcc}
.reply-waiting>.reply-waiting-dot{display:inline-block;flex:none;width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.5;animation:soft-hearts-reply-wait 1.2s ease-in-out infinite}
.reply-waiting>.reply-waiting-dot:nth-child(2){animation-delay:.15s}
.reply-waiting>.reply-waiting-dot:nth-child(3){animation-delay:.3s}
@keyframes soft-hearts-reply-wait{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-2px);opacity:1}}
@media(prefers-reduced-motion:reduce){.reply-waiting>.reply-waiting-dot{animation:none;transform:none;opacity:.7}}
`;

const STYLE_ID = 'soft-hearts-reply-waiting-style';
const statusAttributes = ['role', 'aria-label', 'aria-live'] as const;
const previousAttributes = new WeakMap<HTMLElement, (string | null)[]>();

/** Presentation only: dots contain no text and never become a chat message. */
export function renderReplyWaiting(element: HTMLElement, waiting: boolean): void {
  const previous = previousAttributes.get(element);
  if (!waiting) {
    if (!previous) return;
    element.replaceChildren();
    element.classList.remove('reply-waiting');
    statusAttributes.forEach((name, index) => {
      const value = previous[index];
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    });
    previousAttributes.delete(element);
    return;
  }
  // Anchor/layout updates may repaint the native bubble every frame. Keep the
  // same nodes so each dot's animation continues instead of starting again.
  if (previous) return;
  const document = element.ownerDocument;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = WAITING_DOTS_CSS;
    document.head.append(style);
  }
  previousAttributes.set(element, statusAttributes.map(name => element.getAttribute(name)));
  element.classList.add('reply-waiting');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-label', '正在等待回复');
  element.setAttribute('aria-live', 'polite');
  element.replaceChildren(...Array.from({ length: 3 }, () => {
    const dot = document.createElement('span');
    dot.classList.add('reply-waiting-dot');
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }));
}
