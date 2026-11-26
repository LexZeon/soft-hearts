/**
 * Full-screen Unbound: where a dragged picture counts as a snack (docs/claude/2026-11-21-drop-zone.md). The page covers the whole screen, so
 * a picture the user drags across it on its way to another program must not be taken by her. The zone is her body (the same capsules the
 * click-through hit test uses) with a small margin; anywhere else the page is not a drop target and a stray drop does nothing. The companion
 * window keeps its own rule (its whole window is her).
 */

/** How far outside her silhouette (CSS px) a dragged picture still counts as being at her. */
export const DROP_MARGIN_PX = 28;

/** `distance` is the signed distance from the point to her silhouette (≤ 0 on her; NaN or absent: unknown, so not at her). */
export function atHerBody(distance: number | undefined, margin: number = DROP_MARGIN_PX): boolean {
  return typeof distance === 'number' && Number.isFinite(distance) && distance <= margin;
}

/** The touch input's drop zone from the page's body-distance function; undefined without one (the input's own default). */
export function dropZoneOf(bodyDistance: ((x: number, y: number) => number) | undefined, margin: number = DROP_MARGIN_PX): ((x: number, y: number) => boolean) | undefined {
  return bodyDistance ? (x, y) => atHerBody(bodyDistance(x, y), margin) : undefined;
}
