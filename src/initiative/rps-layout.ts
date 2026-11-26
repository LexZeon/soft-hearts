/**
 * G1 猜拳: where the buttons and the score may sit so her chat bubble never covers them.
 * Pure geometry, no DOM: RpsOverlay.place asks for the spot nearest to where the buttons belong (beside her raised hand) that no bubble
 * touches. The buttons stay near her hand as designed; only when a bubble would sit on them do they step aside, by the smallest move.
 */
export interface LayoutRect { x: number; y: number; w: number; h: number }

/** The overlay box (buttons, call, score) before it is measured: 160 px wide (rps.css), about this tall with the score showing. */
export const RPS_BOX_FALLBACK = { w: 160, h: 112 } as const;
/** Air kept between the buttons and a bubble. */
export const RPS_BUBBLE_GAP_PX = 8;
const SCAN_STEP_PX = 12;

const overlaps = (a: LayoutRect, b: LayoutRect, gap: number) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * The box's top-left corner: `preferred` when no `avoid` rectangle touches it (within the gap), else the nearest free spot inside `bounds`
 * (window size). Candidates are the four sides of every rectangle, then a coarse scan of the window; the nearest one to `preferred` wins,
 * ties by the order of the candidates, so the same input always gives the same spot (no flicker). When nothing in the window is free
 * (a bubble as big as the window), the preferred spot clamped into the window.
 */
export function rpsClearSpot(input: { preferred: { x: number; y: number }; size: { w: number; h: number }; bounds: { w: number; h: number }; avoid: readonly LayoutRect[]; gap?: number }): { x: number; y: number } {
  const { size, bounds } = input, gap = input.gap ?? RPS_BUBBLE_GAP_PX;
  const maxX = Math.max(0, bounds.w - size.w), maxY = Math.max(0, bounds.h - size.h);
  const clamp = (x: number, y: number) => ({ x: Math.round(Math.min(maxX, Math.max(0, x))), y: Math.round(Math.min(maxY, Math.max(0, y))) });
  const want = clamp(input.preferred.x, input.preferred.y);
  const avoid = input.avoid.filter(r => r.w > 0 && r.h > 0 && [r.x, r.y, r.w, r.h].every(Number.isFinite));
  const free = (p: { x: number; y: number }) => !avoid.some(r => overlaps({ x: p.x, y: p.y, w: size.w, h: size.h }, r, gap));
  if (free(want)) return want;
  const candidates: { x: number; y: number }[] = [];
  for (const r of avoid) {
    candidates.push(clamp(r.x - size.w - gap, want.y), clamp(r.x + r.w + gap, want.y), clamp(want.x, r.y - size.h - gap), clamp(want.x, r.y + r.h + gap));
  }
  for (let y = 0; y <= maxY + SCAN_STEP_PX; y += SCAN_STEP_PX) for (let x = 0; x <= maxX + SCAN_STEP_PX; x += SCAN_STEP_PX) candidates.push(clamp(x, y));
  let best: { x: number; y: number } | null = null, bestDistance = Infinity;
  for (const candidate of candidates) {
    if (!free(candidate)) continue;
    const distance = Math.hypot(candidate.x - want.x, candidate.y - want.y);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best ?? want;
}

/** The boxes of `elements` that show now (not hidden, with a size), in `origin`'s coordinates (the overlay's parent). */
export function shownRects(elements: Iterable<Element>, origin: { left: number; top: number } = { left: 0, top: 0 }): LayoutRect[] {
  const out: LayoutRect[] = [];
  for (const element of elements) {
    const box = (element as { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } }).getBoundingClientRect?.();
    if (box && box.width > 0 && box.height > 0) out.push({ x: box.left - origin.left, y: box.top - origin.top, w: box.width, h: box.height });
  }
  return out;
}
