/**
 * Unbound U4: plane geometry for windows on the glass (display DIP). No Three.js, no Electron, no her body (body.ts).
 *
 * Her visibility depends only on the UNION of the windows on the display (all of them are in front of her), so z does not enter
 * here; z only decides who is painted over whom and which window an edge is credited to.
 */
import type { Rect } from '../world';
import type { SurfaceWindow } from './windows';

export type Interval = readonly [number, number];
export const right = (r: Rect) => r.x + r.width;
export const bottom = (r: Rect) => r.y + r.height;

export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(right(a), right(b)), y1 = Math.min(bottom(a), bottom(b));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Sorted, merged intervals. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter(i => i[1] > i[0]).map(i => [i[0], i[1]] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const i of sorted) { const last = out[out.length - 1]; if (last && i[0] <= last[1]) last[1] = Math.max(last[1], i[1]); else out.push(i); }
  return out;
}
/** `within` minus `cut`. */
export function subtractIntervals(within: Interval, cut: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let at = within[0];
  for (const c of mergeIntervals(cut)) {
    if (c[1] <= at) continue;
    if (c[0] >= within[1]) break;
    if (c[0] > at) out.push([at, c[0]]);
    at = Math.max(at, c[1]);
  }
  if (at < within[1]) out.push([at, within[1]]);
  return out;
}

/** Area of `rect` covered by the union of `covers` (exact: coordinate compression). */
export function coveredArea(rect: Rect, covers: readonly Rect[]): number {
  const parts = covers.map(c => intersect(rect, c)).filter((c): c is Rect => !!c);
  if (!parts.length) return 0;
  const xs = [...new Set(parts.flatMap(p => [p.x, right(p)]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i], x1 = xs[i + 1];
    const ys = mergeIntervals(parts.filter(p => p.x <= x0 && right(p) >= x1).map(p => [p.y, bottom(p)] as Interval));
    area += (x1 - x0) * ys.reduce((sum, y) => sum + (y[1] - y[0]), 0);
  }
  return area;
}

/**
 * The union of rectangles as disjoint rectangles (same area, no overlaps): what a drawing mask needs. A mask made of overlapping
 * shapes with the even-odd rule would punch holes where two windows overlap; disjoint pieces cannot. Row-merged, so a plain
 * layout of a few windows gives a few pieces.
 */
export function maskRects(rects: readonly Rect[]): Rect[] {
  const usable = rects.filter(r => r.width > 0 && r.height > 0);
  const ys = [...new Set(usable.flatMap(r => [r.y, bottom(r)]))].sort((a, b) => a - b);
  const out: Rect[] = [];
  let open: Rect[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    const row = mergeIntervals(usable.filter(r => r.y <= y0 && bottom(r) >= y1).map(r => [r.x, right(r)] as Interval));
    const next: Rect[] = [];
    for (const [x0, x1] of row) {
      const same = open.find(o => o.x === x0 && o.width === x1 - x0 && Math.abs(bottom(o) - y0) < 1e-9);
      if (same) { same.height = y1 - same.y; next.push(same); }
      else { const piece = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }; out.push(piece); next.push(piece); }
    }
    open = next;
  }
  return out;
}

export type EdgeSide = 'left' | 'right' | 'top';
/** A piece of the outline of the union of windows that has free glass just outside it: somewhere she can show herself from. */
export interface SurfaceEdge {
  side: EdgeSide;
  windowId: number;
  /** The coordinate of the edge line (x for left/right, y for top), DIP. */
  at: number;
  /** The usable stretch along the edge (y for left/right, x for top), DIP. */
  span: Interval;
}

/** How far outside an edge we look to decide it is free glass (DIP). */
export const OUTSIDE_PROBE_DIP = 1.5;

/**
 * The edges of windows that are boundary of the union with free display just outside: the strip next to the edge is on the display
 * and no other window covers it. An edge on the display's border is not an edge (there is nothing outside to peek into); an edge
 * hidden inside another window is not either. Stretches shorter than `minSpanDip` are dropped. Bottom edges are not offered
 * (she stands on her floor; a window's bottom edge is a ceiling she cannot look from under).
 */
export function findEdges(windows: readonly SurfaceWindow[], display: Rect, minSpanDip = 8): SurfaceEdge[] {
  const edges: SurfaceEdge[] = [];
  const dx0 = display.x, dx1 = right(display), dy0 = display.y;
  for (const w of windows) {
    const others = windows.filter(o => o !== w).map(o => o.rect);
    const r = w.rect;
    const consider = (side: EdgeSide, at: number, outside: number, along: Interval) => {
      const onDisplay = side === 'top' ? outside >= dy0 : outside >= dx0 && outside <= dx1;
      if (!onDisplay) return;
      const blocked = others.filter(o => side === 'top' ? o.y <= outside && bottom(o) >= outside : o.x <= outside && right(o) >= outside)
        .map(o => (side === 'top' ? [o.x, right(o)] : [o.y, bottom(o)]) as Interval);
      for (const span of subtractIntervals(along, blocked)) if (span[1] - span[0] >= minSpanDip) edges.push({ side, windowId: w.id, at, span });
    };
    consider('left', r.x, r.x - OUTSIDE_PROBE_DIP, [r.y, bottom(r)]);
    consider('right', right(r), right(r) + OUTSIDE_PROBE_DIP, [r.y, bottom(r)]);
    consider('top', r.y, r.y - OUTSIDE_PROBE_DIP, [r.x, right(r)]);
  }
  return edges;
}

/**
 * Free horizontal stretches of the display along a horizontal band: x ranges where no window touches the band [y0, y1] (a window
 * that covers only part of the band counts as blocking: conservative, she would be half behind it).
 */
export function freeIntervals(windows: readonly SurfaceWindow[], display: Rect, band: Interval): Interval[] {
  const blocking = windows.filter(w => w.rect.y < band[1] && bottom(w.rect) > band[0]).map(w => [w.rect.x, right(w.rect)] as Interval);
  return subtractIntervals([display.x, right(display)], blocking);
}
