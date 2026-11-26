// The reply bubble keeps clear of the control window (Codex T-253 option 1; X-549: her long reply covered the
// control window's send / stop buttons). Record: docs/claude/2026-11-19-control-window-avoid.md.
//
// Rules this module keeps (tests/reply-avoid.test.ts):
// - Today's placement (layoutReply) comes first. Only when it would overlap the control window are other places scored: beside, above or
//   below her head, or slid just past the window's edge, each still near her mouth.
// - No jumping: once a place is chosen for a window rectangle it is kept while it stays clear and the window has not moved, resized or
//   reappeared; today's place comes back only when it clears the window by AVOID_HYSTERESIS.
// - Tiers: the whole control window first; when no place near her mouth clears it (her head is in front of it), at least its input /
//   send / stop band (electron/stage/companion-step-aside.ts protectedRegion).
// - Never hides her reply: no room anywhere means today's place, overlapping. (The read-aloud proof and the dwell timing count the bubble
//   as shown wherever it is; electron/brain/reply-window.ts.)
// - Nothing here is stored: the memory lives in the reply window object, and the side it remembers for next time is today's side (baseSide),
//   never the temporary one.
import { finishReplyLayout, layoutReply, REPLY_GEOMETRY, replyGeometry, validReplyBounds, type ReplyAnchor, type ReplyBounds, type ReplyGeometry,
  type ReplyLayout, type ReplySide } from './reply-layout';

const { SHADOW, GAP, TAIL_Y, TAIL_DEPTH, MIN_HEIGHT } = REPLY_GEOMETRY;
/** Space left between the bubble's shadow and the window it avoids (DIP). */
export const AVOID_GAP = 12;
/** Once avoiding a rectangle, today's place comes back only when it clears that rectangle by this much (DIP). */
export const AVOID_HYSTERESIS = 16;
/** How far from her mouth a bubble may sit to stay clear (DIP between the mouth and the nearest point of the bubble). */
export const AVOID_REACH = 320;
/** While a reply is showing its side is locked: a place on the other side scores this much worse, so it is taken only when nothing else clears the window. */
export const LOCK_PENALTY = 400;

export interface AvoidMemory { key: string; avoid: ReplyBounds }
export interface AvoidChoice {
  /** null only when today's placement is null too (no face on screen, no room on the display). */
  layout: ReplyLayout | null;
  /** The side today's placement took: the only side the reply window remembers. */
  baseSide?: ReplySide;
  memory: AvoidMemory | null;
  avoided: boolean;
}
interface Candidate { key: string; layout: ReplyLayout; score: number }

const right = (rect: ReplyBounds) => rect.x + rect.width;
const bottom = (rect: ReplyBounds) => rect.y + rect.height;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
/** Strict overlap of a and b grown by margin; touching edges do not overlap. */
export function overlapsRect(a: ReplyBounds, b: ReplyBounds, margin = 0): boolean {
  return a.x < right(b) + margin && right(a) > b.x - margin && a.y < bottom(b) + margin && bottom(a) > b.y - margin;
}
const sameRect = (a: ReplyBounds, b: ReplyBounds) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const distanceTo = (point: { x: number; y: number }, rect: ReplyBounds) => Math.hypot(Math.max(rect.x - point.x, 0, point.x - right(rect)), Math.max(rect.y - point.y, 0, point.y - bottom(rect)));

/** Every place near her mouth that stays clear of `avoid`, scored (lower is better). */
function candidates(g: ReplyGeometry, area: ReplyBounds, avoid: ReplyBounds, preferredSide: ReplySide | undefined, kept: string | undefined, lock = false): Candidate[] {
  const { point, radius, usable, bodyWidth, bodyHeight, minWidth } = g;
  const out: Candidate[] = [];
  const consider = (key: string, body: ReplyBounds, side: ReplySide, above: boolean, extra: number) => {
    if (body.width < minWidth || body.height < MIN_HEIGHT) return;
    if (body.x < usable.x - 0.5 || body.y < usable.y - 0.5 || right(body) > right(usable) + 0.5 || bottom(body) > bottom(usable) + 0.5) return;
    const distance = distanceTo(point, body);
    if (distance > AVOID_REACH) return;
    const layout = finishReplyLayout(body, side, above, area);
    const global = { ...layout.bounds };
    if (overlapsRect(global, avoid)) return;
    const squeeze = (bodyWidth * bodyHeight - body.width * body.height) / 400;
    out.push({ key, layout, score: distance + extra + squeeze - (key === kept ? 120 : 0) + (lock && preferredSide && side !== preferredSide ? LOCK_PENALTY : 0) });
  };
  // Beside her head, as today, above or below her mouth line, or slid just past the window's top or bottom edge.
  for (const side of ['right', 'left'] as const) {
    const available = side === 'right' ? right(usable) - point.x - radius - GAP : point.x - radius - GAP - usable.x;
    if (available < minWidth) continue;
    const width = Math.min(bodyWidth, available);
    const x = side === 'right' ? point.x + radius + GAP : point.x - radius - GAP - width;
    const sidePenalty = preferredSide && preferredSide !== side ? 30 : 0;
    const up = point.y - TAIL_Y - usable.y, down = bottom(usable) - point.y - TAIL_Y;
    if (up >= MIN_HEIGHT) { const h = Math.min(bodyHeight, up); consider(`${side}-above`, { x, y: point.y - TAIL_Y - h, width, height: h }, side, true, sidePenalty); }
    if (down >= MIN_HEIGHT) { const h = Math.min(bodyHeight, down); consider(`${side}-below`, { x, y: point.y + TAIL_Y, width, height: h }, side, false, sidePenalty + 10); }
    const h = Math.min(bodyHeight, usable.height);
    const overTop = clamp(avoid.y - AVOID_GAP - SHADOW - TAIL_DEPTH - h, usable.y, bottom(usable) - h);
    const underBottom = clamp(bottom(avoid) + AVOID_GAP + SHADOW + TAIL_DEPTH, usable.y, bottom(usable) - h);
    for (const [name, y] of [['over', overTop], ['under', underBottom]] as const) consider(`${side}-${name}`, { x, y, width, height: h }, side, y + h / 2 < point.y, sidePenalty + 40);
  }
  // Over or under her head, as today when neither side has room, or slid just past the window's left or right edge.
  const width = Math.min(bodyWidth, usable.width);
  const up = point.y - radius - GAP - usable.y, down = bottom(usable) - point.y - radius - GAP;
  const xs = [
    ['', clamp(point.x + TAIL_Y, usable.x, right(usable) - width)],
    ['-before', clamp(avoid.x - AVOID_GAP - SHADOW - width, usable.x, right(usable) - width)],
    ['-after', clamp(right(avoid) + AVOID_GAP + SHADOW, usable.x, right(usable) - width)],
  ] as const;
  for (const [name, x] of xs) {
    const tipSide = (bodyX: number): ReplySide => Math.abs(point.x - bodyX) <= Math.abs(point.x - (bodyX + width)) ? 'right' : 'left';
    if (up >= MIN_HEIGHT) { const h = Math.min(bodyHeight, up); consider(`top${name}`, { x, y: point.y - radius - GAP - h, width, height: h }, tipSide(x), true, 60 + (name ? 40 : 0)); }
    if (down >= MIN_HEIGHT) { const h = Math.min(bodyHeight, down); consider(`bottom${name}`, { x, y: point.y + radius + GAP, width, height: h }, tipSide(x), false, 70 + (name ? 40 : 0)); }
  }
  return out;
}

/** The scored clear places for these inputs (diagnostics and tests); empty when there is no room or no rectangle to avoid. */
export function replyCandidates(owner: ReplyBounds, anchor: ReplyAnchor, area: ReplyBounds, preferredSide: ReplySide | undefined, compact: boolean,
  avoid: ReplyBounds | null | undefined, keptKey?: string): Array<{ key: string; layout: ReplyLayout; score: number }> {
  const geometry = replyGeometry(owner, anchor, area, compact);
  return geometry && validReplyBounds(avoid) ? candidates(geometry, area, avoid, preferredSide, keptKey) : [];
}

/**
 * Where the bubble goes when a rectangle (the control window) should stay clear. `memory` is the previous answer's memory, null at first;
 * hand back the returned one next time. With no rectangle, or one today's place does not touch, the answer is today's place.
 * Several rectangles are tiers, the most wanted first (the whole control window, then its input / send / stop band): when no place near
 * her mouth clears the first, the next is tried; none cleared → today's place.
 */
export function chooseReplyPlacement(owner: ReplyBounds, anchor: ReplyAnchor, area: ReplyBounds, preferredSide: ReplySide | undefined, compact: boolean,
  avoid: ReplyBounds | readonly ReplyBounds[] | null | undefined, memory: AvoidMemory | null, lock = false): AvoidChoice {
  const tiers = Array.isArray(avoid) ? avoid : [avoid as ReplyBounds | null | undefined];
  let last: AvoidChoice | null = null;
  for (const tier of tiers) {
    if (!validReplyBounds(tier)) continue;
    const choice = chooseForRect(owner, anchor, area, preferredSide, compact, tier, memory, lock);
    if (choice.avoided || !choice.layout || !overlapsRect(choice.layout.bounds, tier)) return choice;
    last = choice;
  }
  return last ?? chooseForRect(owner, anchor, area, preferredSide, compact, null, memory, lock);
}

function chooseForRect(owner: ReplyBounds, anchor: ReplyAnchor, area: ReplyBounds, preferredSide: ReplySide | undefined, compact: boolean,
  avoid: ReplyBounds | null, memory: AvoidMemory | null, lock = false): AvoidChoice {
  const base = layoutReply(owner, anchor, area, preferredSide, compact, lock);
  if (!base) return { layout: null, memory: null, avoided: false };
  const today: AvoidChoice = { layout: base, baseSide: base.side, memory: null, avoided: false };
  if (!validReplyBounds(avoid)) return today;
  const sameAvoid = !!memory && sameRect(memory.avoid, avoid);
  // Hysteresis: while avoiding this same rectangle, today's place must clear it by a margin before it comes back.
  if (!overlapsRect(base.bounds, avoid, sameAvoid ? AVOID_HYSTERESIS : 0)) return today;
  const geometry = replyGeometry(owner, anchor, area, compact);
  if (!geometry) return today;
  const all = candidates(geometry, area, avoid, preferredSide, memory?.key, lock);
  // The window has not moved, resized or reappeared and the chosen place is still clear: keep it.
  if (sameAvoid) { const kept = all.find(candidate => candidate.key === memory!.key); if (kept) return { layout: kept.layout, baseSide: base.side, memory, avoided: true }; }
  let best: Candidate | undefined;
  for (const candidate of all) if (!best || candidate.score < best.score) best = candidate;
  // No room anywhere: today's place, overlapping. Never hide her reply to keep the window clear.
  if (!best) return today;
  return { layout: best.layout, baseSide: base.side, memory: { key: best.key, avoid: { ...avoid } }, avoided: true };
}
