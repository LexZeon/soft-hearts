/**
 * Unbound U1: is the cursor on her? (docs/claude/2026-11-12-unbound-u1-part1.md)
 *
 * The full-screen window lets every click through to the windows below, except where she is. Her silhouette is approximated by
 * one capsule per skinned bone (src/foundation/body-capsules.ts measures each bone's own vertices once), projected to the window's
 * pixels every time the cursor moves. Pure math and a small state machine; the window does the switching.
 */

/** A capsule on the screen: the segment a-b (pixels) and a radius (pixels). A point capsule (a = b) is a circle. */
export interface Capsule2D { ax: number; ay: number; bx: number; by: number; r: number; /** The skinned bone this piece of her belongs to (step 2: which part was clicked). */ bone?: number }

/** The capsule nearest to the point (smallest signed distance, ≤ 0 inside) and that distance; null with no capsules. */
export function nearestCapsule(px: number, py: number, capsules: readonly Capsule2D[]): { capsule: Capsule2D; distance: number } | null {
  let best: { capsule: Capsule2D; distance: number } | null = null;
  for (const c of capsules) {
    const distance = segmentDistance(px, py, c.ax, c.ay, c.bx, c.by) - c.r;
    if (!best || distance < best.distance) best = { capsule: c, distance };
  }
  return best;
}

/** Distance from p to the segment a-b. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
  const t = length2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Signed distance from p to the nearest capsule's surface (≤ 0 inside her); Infinity with no capsules. */
export function silhouetteDistance(px: number, py: number, capsules: readonly Capsule2D[]): number {
  let best = Infinity;
  for (const c of capsules) {
    // Cheap reject: a box around the capsule grown by the best distance so far.
    const reach = c.r + (best === Infinity ? 1e9 : Math.max(0, best));
    if (px < Math.min(c.ax, c.bx) - reach || px > Math.max(c.ax, c.bx) + reach || py < Math.min(c.ay, c.by) - reach || py > Math.max(c.ay, c.by) + reach) continue;
    const value = segmentDistance(px, py, c.ax, c.ay, c.bx, c.by) - c.r;
    if (value < best) best = value;
  }
  return best;
}

/** The cursor must leave her silhouette by this many pixels before clicks go through again (no flicker on the edge). */
export const LEAVE_MARGIN_PX = 8;

/**
 * Click-through on or off. On her (distance ≤ 0): the window takes the mouse. It gives it back once the cursor is more than
 * the margin away and no button is held (a press that started on her stays hers until it is released). `apply` is called only
 * on a change.
 */
export class InteractiveToggle {
  private on = false;
  constructor(private readonly apply: (interactive: boolean) => void, private readonly leaveMarginPx = LEAVE_MARGIN_PX) {}
  get interactive(): boolean { return this.on; }
  /** A cursor reading: its distance to her silhouette (pixels, ≤ 0 inside) and whether a button is held. Returns whether it changed. */
  pointer(distancePx: number, buttonsHeld: boolean): boolean {
    const next = this.on ? buttonsHeld || distancePx <= this.leaveMarginPx : distancePx <= 0;
    return this.set(next);
  }
  /** The cursor left the window, the window was hidden, or she is gone: clicks go through again (a held button keeps her). */
  release(buttonsHeld = false): boolean { return this.set(this.on && buttonsHeld); }
  private set(next: boolean): boolean {
    if (next === this.on) return false;
    this.on = next;
    this.apply(next);
    return true;
  }
}
