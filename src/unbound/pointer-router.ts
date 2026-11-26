/**
 * The full-screen page's mouse buttons, routed to the three things a press on her can be (the page keeps only this one call):
 * a click (reported once, opens the chat box: src/unbound/click-reporter.ts), a pull (the joystick or an arm: src/unbound/pull-input.ts)
 * and, held still, a touch (pull-input.ts asks the click reporter through `holdTouch`). A press on her cheek is a pinch and belongs to
 * the touch input (src/unbound/her/out-touch.ts), so `pagePress` leaves the click and the pull out of it.
 */
import type { ClickReporter } from './click-reporter';
import type { UnboundPull } from './pull-input';

export interface PointerParts {
  clicks: ClickReporter;
  pulls: UnboundPull;
  /** Runs `press` unless the press is a pinch or the game's (her/out-page.ts pagePress). */
  pagePress(press: () => void, target: EventTarget | null): void;
  /** A press that took her ends the near return (she is yours now). */
  pressTaken(): void;
}

/** A mousedown, mousemove or mouseup event the page saw. */
export function routePointer(event: MouseEvent, parts: PointerParts): void {
  const { clientX: x, clientY: y } = event;
  if (event.type === 'mousedown' && event.button === 0) parts.pagePress(() => { parts.clicks.down(x, y); if (parts.pulls.down(x, y)) parts.pressTaken(); }, event.target);
  else if (event.type === 'mousemove') parts.pulls.move(x, y);
  else if (event.type === 'mouseup' && event.button === 0) { parts.clicks.up(x, y); parts.pulls.up(); }
  else if (event.type === 'mousedown' && event.button === 2) parts.clicks.menu(x, y); // I-190
}
