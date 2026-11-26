/**
 * I-193: where the pointer is across the screen, as this page already sees it (hover and hair read the same mouse moves; the window is click-through with
 * moves forwarded). Kept only for her "到你鼠标旁边" (go-cursor) word: its horizontal place (0..1 of the width) goes to the host for that one decision and
 * nowhere else; no new sense, nothing stored. Not known (never moved here, or not for a long while): null — she does not guess.
 */
import { HER_POSITION_KNOBS } from '../../shared/unbound/her-position';

export class CursorAcross {
  private x = Number.NaN;
  private at = -Infinity;
  constructor(private readonly width: () => number, private readonly now: () => number = () => performance.now(), private readonly freshMs: number = HER_POSITION_KNOBS.cursorFreshMs) {}

  /** The pointer moved (clientX in the page's own pixels). */
  move(clientX: number): void {
    if (!Number.isFinite(clientX)) return;
    this.x = clientX; this.at = this.now();
  }

  /** Across the screen 0..1, or null when the pointer is not known now. */
  across(): number | null {
    const w = this.width();
    if (!(w > 0) || !Number.isFinite(this.x) || this.now() - this.at > this.freshMs) return null;
    return Math.min(1, Math.max(0, this.x / w));
  }

  /** Listens to the page's mouse moves (passive; nothing else is read from the event). */
  listen(target: Pick<Window, 'addEventListener'>): this {
    target.addEventListener('mousemove', event => this.move((event as MouseEvent).clientX), { passive: true });
    return this;
  }
}
