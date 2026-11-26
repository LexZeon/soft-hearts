/**
 * Unbound U4 (docs/claude/2026-11-14-unbound-night-e4-surfaces.md): windows as surfaces. Pure data and plane geometry.
 *
 * The model: every window is an opaque board lying ON the glass (the plane z = 0 of her world, drawn on the display). She lives
 * behind the glass, so every window is in front of her: where a window covers her on the display, she is hidden. A window is
 * only a rectangle in display DIP and its place in the stacking order. Deliberately NO title, NO program name, NO content: this
 * is the whole of the new perception (docs/claude/2026-11-12-unbound-system-design.md, "隐私和边界").
 */
import type { Rect } from '../world';

export interface SurfaceWindow {
  /** An opaque number (the source's own; not a window handle that could be used on the system). */
  id: number;
  /** Display DIP, same coordinates as DisplayFacts.bounds. */
  rect: Rect;
  /** Stacking order: bigger = nearer to you. Used for painting and for ties; her hiding does not depend on it (see geometry.ts). */
  z: number;
}

/**
 * Where windows come from. Tonight there is ONE implementation: `SyntheticWindowSource` (a layout the test or the preview made up).
 *
 * A real source (reading the system's window rectangles) is NOT written and must not be added without the user's explicit consent
 * (a new perception; I-014 style: switched on by the user in settings, to her, or to their own Claude). When it exists it may read
 * ONLY position, size and stacking order, never a title, a process name, a path or a pixel of content, and it must stay behind
 * this interface so the rest (geometry, planning, pose targets) never learns where the numbers came from. Cost: U0 measured the
 * reading (docs/claude/2026-11-12-unbound-u0.md); poll slowly while she is not near a window, and not at all when perception is off.
 */
export interface WindowSource {
  /** The current windows, any order. Synchronous: a real source would cache its last reading. */
  read(): readonly SurfaceWindow[];
}

export class SyntheticWindowSource implements WindowSource {
  constructor(private windows: readonly SurfaceWindow[]) {}
  set(windows: readonly SurfaceWindow[]): void { this.windows = windows; }
  read(): readonly SurfaceWindow[] { return this.windows; }
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** Smaller than this in either direction (DIP) is not a surface (tooltips, slivers). */
export const MIN_WINDOW_DIP = 8;

/**
 * Whatever a source gives: finite numbers only, clipped to the display, slivers dropped, back-to-front by z (stable). Extra fields
 * (a careless source might add a title) are dropped here: only id, rect, z survive.
 */
export function sanitizeWindows(input: readonly SurfaceWindow[], display: Rect): SurfaceWindow[] {
  const out: SurfaceWindow[] = [];
  const dx1 = display.x + display.width, dy1 = display.y + display.height;
  for (const w of input ?? []) {
    const r = w?.rect;
    if (!r || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || !finite(w.z)) continue;
    const x0 = Math.max(display.x, r.x), y0 = Math.max(display.y, r.y), x1 = Math.min(dx1, r.x + r.width), y1 = Math.min(dy1, r.y + r.height);
    if (x1 - x0 < MIN_WINDOW_DIP || y1 - y0 < MIN_WINDOW_DIP) continue;
    out.push({ id: finite(w.id) ? w.id : out.length, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, z: w.z });
  }
  return out.sort((a, b) => a.z - b.z);
}
