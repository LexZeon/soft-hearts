/** `value` kept so that a box of `size` lies inside [0, limit]; no limit known: unchanged. */
export function clampInto(value: number, limit: number | undefined, size: number): number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= size ? Math.min(Math.max(value, 0), limit - size) : value;
}

/** An owned DOM cursor overlay. It never changes a pointer sample or global style. */
export class PetInteractionCursor {
  private follower: HTMLSpanElement | null = null;
  private originalCursor = '';
  private originalPriority = '';
  private showing = false;
  private disposed = false;

  constructor(private readonly surface: HTMLElement) {}

  show(clientX: number, clientY: number, emoji: '👋' | '👉' | '🤏' | '🫱' | '🤝' | '🤙' | '🤞' | '✋' | '🙌' = '👋'): void { // I-087: the hands' hints use the same follower
    if (this.disposed || !Number.isFinite(clientX) || !Number.isFinite(clientY)) { this.hide(); return; }
    const element = this.element();
    const style = this.surface.style;
    if (!element || !style) return;
    element.textContent = emoji;
    if (!this.showing) {
      this.originalCursor = typeof style.getPropertyValue === 'function' ? style.getPropertyValue('cursor') : style.cursor;
      this.originalPriority = typeof style.getPropertyPriority === 'function' ? style.getPropertyPriority('cursor') : '';
      if (typeof style.setProperty === 'function') style.setProperty('cursor', 'none', 'important');
      else style.cursor = 'none';
      this.showing = true;
    }
    // Segoe UI Emoji's leading fingertips sit near the upper middle of the
    // 32px glyph. The overlay follows client coordinates without moving input.
    // While the system cursor is hidden the emoji is the only pointer there is: keep it inside the window (a pointer at the very
    // edge would otherwise be half or wholly out of sight).
    const view = this.surface.ownerDocument.defaultView;
    element.style.left = `${clampInto(clientX - 20, view?.innerWidth, 36)}px`;
    element.style.top = `${clampInto(clientY - 4, view?.innerHeight, 36)}px`;
    element.hidden = false; element.style.display = 'block';
  }

  hide(): void {
    if (this.follower) { this.follower.hidden = true; this.follower.style.display = 'none'; }
    if (!this.showing) return;
    const style = this.surface.style;
    if (typeof style?.setProperty === 'function') {
      if (this.originalCursor) style.setProperty('cursor', this.originalCursor, this.originalPriority);
      else style.removeProperty('cursor');
    } else if (style) style.cursor = this.originalCursor;
    this.showing = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.hide(); this.follower?.remove(); this.follower = null; this.disposed = true;
  }

  private element(): HTMLSpanElement | null {
    if (this.follower) return this.follower;
    const owner = this.surface.ownerDocument;
    const parent = owner.body ?? owner.documentElement;
    // Narrow non-browser fixtures can exercise accounting without a DOM cursor.
    if (typeof owner.createElement !== 'function' || !parent || typeof parent.append !== 'function' || !this.surface.style) return null;
    const element = owner.createElement('span');
    element.textContent = '👋'; element.setAttribute('aria-hidden', 'true');
    element.dataset.petInteractionCursor = 'true';
    Object.assign(element.style, {
      position: 'fixed', pointerEvents: 'none', userSelect: 'none', zIndex: '2147483647',
      display: 'none', width: '36px', height: '36px', fontSize: '32px', lineHeight: '36px',
      fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", sans-serif',
    });
    element.hidden = true; parent.append(element); this.follower = element;
    return element;
  }
}
