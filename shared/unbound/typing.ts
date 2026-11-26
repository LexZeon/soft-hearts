/**
 * Unbound v1 step 2, typing to her (docs/claude/2026-11-15-unbound-v1-step2-typing.md): what the page tells the host about a
 * click, where the small input box goes, where her reply bubble goes, and how long a reply stays readable. Pure; the window and
 * the page only call it.
 */
import type { Rect } from './world';
import { TOUCH_PARTS } from '../mood/touch';
import type { TouchPart } from '../mood';

/** Her head on the Unbound window, in the window's CSS pixels: the middle of it and a radius that covers it. */
export interface HeadSpot { x: number; y: number; r: number }

/** What the page says when she was clicked: where on her (part, side) and where her head is, so the box can go beside it. */
export interface UnboundTouchReport { part: TouchPart; side: 'left' | 'right' | null; head: HeadSpot | null; /** I-190: a right click: open the box with the senses panel, no touch. */ menu?: true;
  /** I-194: a press held still on her: a touch, and it does not open the box. A plain click only opens the box; it is a touch only while the box is already open. */ hold?: true }

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const OFF = 100_000;

export function parseHeadSpot(value: unknown): HeadSpot | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, r } = value as Record<string, unknown>;
  if (!num(x) || !num(y) || !num(r) || Math.abs(x) > OFF || Math.abs(y) > OFF || r <= 0 || r > 5_000) return null;
  return { x, y, r };
}

/** Strict: anything that is not exactly a click report is null (the host then ignores it). */
export function parseUnboundTouch(value: unknown): UnboundTouchReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.part !== 'string' || !(TOUCH_PARTS as readonly string[]).includes(raw.part)) return null;
  const side = raw.side === 'left' || raw.side === 'right' ? raw.side : raw.side == null ? null : undefined;
  if (side === undefined) return null;
  if (raw.menu !== undefined && raw.menu !== true) return null;
  if (raw.hold !== undefined && raw.hold !== true) return null;
  if (raw.hold === true && raw.menu === true) return null;
  return { part: raw.part as TouchPart, side, head: parseHeadSpot(raw.head), ...(raw.menu === true ? { menu: true as const } : {}), ...(raw.hold === true ? { hold: true as const } : {}) };
}

/** The page's answer to "where is your head now" (the shortcut has no click to read it from). */
export interface UnboundAnchorReport { id: string; head: HeadSpot | null }
export function parseUnboundAnchor(value: unknown): UnboundAnchorReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) return null;
  return { id: raw.id, head: parseHeadSpot(raw.head) };
}

export interface BoxSize { width: number; height: number }
export const INPUT_BOX_SIZE: Readonly<BoxSize> = Object.freeze({ width: 320, height: 78 });
/** I-190: the box with its senses panel open (the line on top, the senses and their sources below). */
export const INPUT_PANEL_SIZE: Readonly<BoxSize> = Object.freeze({ width: 320, height: 480 }); // I-209 step 3: three in 谁在场 without scrolling (a 14" laptop's work area is about 590 tall)
const BOX_GAP = 14;
const EDGE = 8;

const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), Math.max(lo, hi));

/** Does the rectangle touch the head circle? */
export function rectHitsHead(rect: Rect, head: HeadSpot): boolean {
  const nx = clamp(head.x, rect.x, rect.x + rect.width), ny = clamp(head.y, rect.y, rect.y + rect.height);
  return Math.hypot(head.x - nx, head.y - ny) < head.r;
}

/**
 * Where the input box goes, in screen coordinates (`head` is already on the screen). Beside her head, never over her face: to the
 * right when it fits, else to the left, else below her chin (clamped into the work area). With no head to go by (she is out of the
 * window, or the page did not answer) the box goes to the lower right of the work area, where it covers nobody.
 */
export function placeInputBox(head: HeadSpot | null, area: Rect, size: BoxSize = INPUT_BOX_SIZE): Rect & { side: 'right' | 'left' | 'below' | 'corner' } {
  const { width, height } = size;
  const inside = (x: number, y: number) => ({ x: clamp(x, area.x + EDGE, area.x + area.width - width - EDGE), y: clamp(y, area.y + EDGE, area.y + area.height - height - EDGE) });
  if (!head) return { ...inside(area.x + area.width, area.y + area.height), width, height, side: 'corner' };
  const top = head.y - height / 2;
  const right = inside(head.x + head.r + BOX_GAP, top);
  if (right.x >= head.x + head.r + BOX_GAP - 0.5) return { ...right, width, height, side: 'right' };
  const left = inside(head.x - head.r - BOX_GAP - width, top);
  if (left.x + width <= head.x - head.r - BOX_GAP + 0.5) return { ...left, width, height, side: 'left' };
  return { ...inside(head.x - width / 2, head.y + head.r + BOX_GAP), width, height, side: 'below' };
}

/**
 * Where her reply bubble goes, in window pixels (top-left): above her head when it fits there, else to the right of her head, else
 * to the left, else clamped (a very tall reply). It always stays inside the window.
 */
export function placeBubble(head: HeadSpot, size: BoxSize, window: BoxSize): { x: number; y: number; side: 'above' | 'right' | 'left' | 'clamped' } {
  const gap = 10, { width, height } = size;
  const fit = (x: number, y: number) => x >= EDGE - 0.5 && y >= EDGE - 0.5 && x + width <= window.width - EDGE + 0.5 && y + height <= window.height - EDGE + 0.5;
  const aboveX = clamp(head.x - width / 2, EDGE, window.width - width - EDGE), aboveY = head.y - head.r - gap - height;
  if (fit(aboveX, aboveY)) return { x: aboveX, y: aboveY, side: 'above' };
  const sideY = clamp(head.y - height / 2, EDGE, window.height - height - EDGE);
  const rightX = head.x + head.r + gap;
  if (fit(rightX, sideY)) return { x: rightX, y: sideY, side: 'right' };
  const leftX = head.x - head.r - gap - width;
  if (fit(leftX, sideY)) return { x: leftX, y: sideY, side: 'left' };
  return { x: clamp(aboveX, EDGE, window.width - width - EDGE), y: clamp(aboveY, EDGE, window.height - height - EDGE), side: 'clamped' };
}

/** The box asks for Enter to send. Not while an input method is composing (Chinese input confirms a candidate with Enter). */
export function enterSends(event: { key: string; isComposing?: boolean; keyCode?: number; shiftKey?: boolean }): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.shiftKey;
}
