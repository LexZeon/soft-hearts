// Where her reply bubble hangs, as the host accepts it (electron/brain/reply-input.ts validateReplyUpdate): exactly x, y, visible and an
// optional radius, finite and inside the host's bounds. The stage's face point carries more for other users (G1: `raisedHand`,
// where her raised arm is during rock-paper-scissors); passing that object on made the host refuse every bubble update while
// her hand was up, text included. This keeps only what the
// bubble needs; a point it cannot use becomes "face not in sight" instead of a refused update.
import type { PetReplyAnchor } from '../foundation/pet-reply';

const LIMIT = 100_000, RADIUS_LIMIT = 10_000;
const usable = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

export function replyAnchorOf(point: unknown): PetReplyAnchor {
  const p = point && typeof point === 'object' && !Array.isArray(point) ? point as Record<string, unknown> : null;
  if (!p || typeof p.visible !== 'boolean' || !usable(p.x, LIMIT) || !usable(p.y, LIMIT)) return { x: 0, y: 0, visible: false };
  const radius = usable(p.radius, RADIUS_LIMIT) && (p.radius as number) >= 0 ? p.radius as number : undefined;
  return { x: p.x as number, y: p.y as number, visible: p.visible, ...(radius === undefined ? {} : { radius }) };
}
