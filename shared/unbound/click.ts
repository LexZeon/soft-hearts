/**
 * Unbound v1 step 2: what counts as "a single click on her" (docs/claude/2026-11-15-unbound-v1-step2-typing.md).
 *
 * A press and release on her that stay in place and are quick. A press that is held or dragged is not a click: holding and
 * pulling are step 5's, and must not also report a click and open the box. The second click of a double click is not reported:
 * double click stays free (I-136), so a double click reports once (its first click), never twice.
 *
 * These numbers only separate the three gestures; they are not about her and are the fallback the user's long press (step 5)
 * will be measured against.
 */
export const CLICK_RULES = Object.freeze({
  /** The pointer may move this far (CSS px) between press and release. */
  maxMovePx: 8,
  /** Press to release at most this long (ms); longer is a hold. */
  maxHoldMs: 450,
  /** A second click this soon (ms) and this near (px) after a reported one belongs to a double click. */
  doubleMs: 450,
  doublePx: 12,
});

export class ClickClassifier {
  private press: { x: number; y: number; at: number } | null = null;
  private last: { x: number; y: number; at: number } | null = null;

  /** A mouse press that started on her (`onHer`); a press elsewhere is never a click on her. */
  down(x: number, y: number, at: number, onHer: boolean): void {
    this.press = onHer && finite(x, y, at) ? { x, y, at } : null;
  }

  /** The release: true exactly once for a click that should be reported. */
  up(x: number, y: number, at: number): boolean {
    const press = this.press;
    this.press = null;
    if (!press || !finite(x, y, at)) return false;
    if (Math.hypot(x - press.x, y - press.y) > CLICK_RULES.maxMovePx || at - press.at > CLICK_RULES.maxHoldMs || at < press.at) return false;
    const last = this.last;
    if (last && at - last.at <= CLICK_RULES.doubleMs && Math.hypot(x - last.x, y - last.y) <= CLICK_RULES.doublePx) { this.last = { x, y, at: -Infinity }; return false; }
    this.last = { x, y, at };
    return true;
  }

  /** The press was lost (the window hid, the pointer left): nothing pending. */
  cancel(): void { this.press = null; }
}

const finite = (...values: number[]) => values.every(Number.isFinite);
