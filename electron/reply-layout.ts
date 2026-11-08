export type ReplySide = "left" | "right";
export interface ReplyBounds { x: number; y: number; width: number; height: number; }
export interface ReplyAnchor { x: number; y: number; visible: boolean; radius?: number; }
export interface ReplyLayout {
  bounds: ReplyBounds;
  body: ReplyBounds;
  tip: { x: number; y: number };
  side: ReplySide;
  above: boolean;
}

const SHADOW = 8, GAP = 16, TAIL_Y = 18, TAIL_DEPTH = 10;
const BODY_WIDTH = 285, BODY_HEIGHT = 165, MIN_WIDTH = 140, MIN_HEIGHT = 44;
const right = (rect: ReplyBounds) => rect.x + rect.width;
const bottom = (rect: ReplyBounds) => rect.y + rect.height;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const validBounds = (rect: ReplyBounds) => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0 && rect.width <= 100000 && rect.height <= 100000 && Math.abs(rect.x) <= 10000000 && Math.abs(rect.y) <= 10000000;

/** Place only the reply surface; the pet's viewport and native bounds stay untouched. */
export function layoutReply(
  owner: ReplyBounds,
  anchor: ReplyAnchor,
  area: ReplyBounds,
  preferredSide?: ReplySide,
  compact = false,
): ReplyLayout | null {
  if (!validBounds(owner) || !validBounds(area) || !anchor?.visible || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || (anchor.radius !== undefined && !Number.isFinite(anchor.radius))) return null;
  const usable = { x: area.x + SHADOW, y: area.y + SHADOW, width: area.width - SHADOW * 2, height: area.height - SHADOW * 2 };
  const bodyWidth = compact ? 72 : BODY_WIDTH, bodyHeight = compact ? MIN_HEIGHT : BODY_HEIGHT;
  const minWidth = compact ? 72 : MIN_WIDTH;
  if (usable.width < minWidth || usable.height < MIN_HEIGHT) return null;
  const point = { x: owner.x + clamp(anchor.x, 0, owner.width), y: owner.y + clamp(anchor.y, 0, owner.height) };
  // An off-screen character should not create an unrelated on-screen bubble.
  if (point.x < area.x || point.x > right(area) || point.y < area.y || point.y > bottom(area)) return null;
  const radius = clamp(anchor.radius ?? Math.min(owner.width * 0.2, 80), 20, 2000);
  const available = {
    left: point.x - radius - GAP - usable.x,
    right: right(usable) - point.x - radius - GAP,
  };
  let side: ReplySide | undefined;
  if (preferredSide && available[preferredSide] >= minWidth) side = preferredSide;
  else if (available.right >= bodyWidth) side = "right";
  else if (available.left >= bodyWidth) side = "left";
  else if (Math.max(available.left, available.right) >= minWidth) side = available.right >= available.left ? "right" : "left";

  let above: boolean;
  let body: ReplyBounds;
  if (side) {
    const width = Math.min(bodyWidth, available[side]);
    const up = point.y - TAIL_Y - usable.y, down = bottom(usable) - point.y - TAIL_Y;
    above = up >= MIN_HEIGHT;
    const height = Math.min(bodyHeight, above ? up : down >= MIN_HEIGHT ? down : usable.height);
    const y = above ? point.y - TAIL_Y - height : down >= MIN_HEIGHT ? point.y + TAIL_Y : usable.y;
    body = { x: side === "right" ? point.x + radius + GAP : point.x - radius - GAP - width, y, width, height };
  } else {
    const up = point.y - radius - GAP - usable.y, down = bottom(usable) - point.y - radius - GAP;
    if (Math.max(up, down) < MIN_HEIGHT) return null;
    above = up >= MIN_HEIGHT;
    const height = Math.min(bodyHeight, above ? up : down);
    const width = Math.min(bodyWidth, usable.width);
    const x = clamp(point.x + TAIL_Y, usable.x, right(usable) - width);
    body = { x, y: above ? point.y - radius - GAP - height : point.y + radius + GAP, width, height };
    side = Math.abs(point.x - body.x) <= Math.abs(point.x - right(body)) ? "right" : "left";
  }

  // The mouth selects placement and a rough direction, never a connecting line.
  // Keep a short triangle at the nearest body corner even across a large gap.
  const tip = {
    x: side === 'right' ? body.x + 6 : right(body) - 6,
    y: above ? bottom(body) + TAIL_DEPTH : body.y - TAIL_DEPTH,
  };
  const x = Math.max(Math.ceil(area.x), Math.floor(Math.min(body.x, tip.x) - SHADOW));
  const y = Math.max(Math.ceil(area.y), Math.floor(Math.min(body.y, tip.y) - SHADOW));
  const endX = Math.min(Math.floor(right(area)), Math.ceil(Math.max(right(body), tip.x) + SHADOW));
  const endY = Math.min(Math.floor(bottom(area)), Math.ceil(Math.max(bottom(body), tip.y) + SHADOW));
  return {
    bounds: { x, y, width: endX - x, height: endY - y },
    body: { ...body, x: body.x - x, y: body.y - y },
    tip: { x: tip.x - x, y: tip.y - y }, side, above,
  };
}
