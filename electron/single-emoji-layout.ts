/** Native DIP rectangles only. The entire pet viewport conservatively contains
 * every visible model projection and the pet's input/toolbar surfaces. */
export interface EmojiRect { x: number; y: number; width: number; height: number }
export interface EmojiPlacement { bounds: EmojiRect; slot: string }
export const EMOJI_SURFACE_SIZE = 80;
const GAP = 14;
const MARGIN = 8;
export function validEmojiRect(rect: EmojiRect): boolean {
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
}
function overlaps(a: EmojiRect, b: EmojiRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width > b.x - gap
    && a.y < b.y + b.height + gap && a.y + a.height > b.y - gap;
}
/** An absent/invalid geometry suppresses this cue rather than guessing or moving
 * the pet, its camera, or its reply window. No renderer coordinates are accepted. */
export function layoutSingleEmoji(owner: EmojiRect, area: EmojiRect, exclusions: readonly EmojiRect[],
  preferredSlot?: string): EmojiPlacement | null {
  if (!validEmojiRect(owner) || !validEmojiRect(area) || exclusions.some(rect => !validEmojiRect(rect))) return null;
  const size = EMOJI_SURFACE_SIZE;
  const ys = [owner.y, owner.y + owner.height * .25 - size / 2, owner.y + owner.height - size];
  const xs = [owner.x, owner.x + owner.width / 2 - size / 2, owner.x + owner.width - size];
  const candidates: EmojiPlacement[] = [];
  for (let i = 0; i < ys.length; i++) {
    candidates.push({ slot: 'right-' + i, bounds: { x: owner.x + owner.width + GAP, y: ys[i], width: size, height: size } });
    candidates.push({ slot: 'left-' + i, bounds: { x: owner.x - GAP - size, y: ys[i], width: size, height: size } });
  }
  for (let i = 0; i < xs.length; i++) {
    candidates.push({ slot: 'above-' + i, bounds: { x: xs[i], y: owner.y - GAP - size, width: size, height: size } });
    candidates.push({ slot: 'below-' + i, bounds: { x: xs[i], y: owner.y + owner.height + GAP, width: size, height: size } });
  }
  const allowed = candidates.map(candidate => ({ ...candidate, bounds: {
    ...candidate.bounds, x: Math.round(candidate.bounds.x), y: Math.round(candidate.bounds.y),
  } })).filter(({ bounds: rect }) =>
    rect.x >= area.x + MARGIN && rect.y >= area.y + MARGIN
    && rect.x + size <= area.x + area.width - MARGIN && rect.y + size <= area.y + area.height - MARGIN
    && ![owner, ...exclusions].some(obstacle => overlaps(rect, obstacle, GAP)));
  return allowed.find(candidate => candidate.slot === preferredSlot) ?? allowed[0] ?? null;
}
