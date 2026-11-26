/**
 * I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): a close moment's end frame written as where her face sits ON THE SCREEN, the way the
 * user drew it, not as a distance on the lens axis. The kiss
 * storyboard ("这个分镜差不多了") and the hug's last frame ("这个差不多是抱抱最终的样子").
 *
 *   kiss   both eyes in the upper part (`kissEyesV`), the mouth in the lower part (`kissMouthV`), both centred: the eyes-to-mouth drop fixes
 *          how far she is; the top edge then cuts through her fringe (some hair shows), her face about as wide as the screen
 *   hug    her ear (the one the camera sees: her face is turned OUTWARD, toward the screen's right) at (`hugEarU`, `hugEarV`), her head about
 *          `hugHeadShare` of the screen's width, the top of her head out of frame, the front of her face cut by the right edge
 *   steps  on the way: her head `normalHeadShare` of the width where she stands to begin (centred), `stepHeadShare` after the step in
 * Window coordinates: u across (−1 the left edge … +1 the right edge), v up (−1 bottom … +1 top), as frame.ts inWindow. Head frame from her two
 * eyes (any model, any turn): across = toward her left eye, up = world up made square to it, forward = across × up (where her face points).
 * Pure: plain numbers.
 */
import type { V3 } from './solve';
import { type ArrivalLens } from './solve';
import { FACE_PER_EYE_SPAN, type FaceGeometry } from './face';
import { ARRIVAL_KNOBS, type ArrivalKnobs } from './knobs';
import type { ArrivalWindow, FramedLens } from './frame';

/** A place in the window (u across, v up; ±1 the edges). */
export interface ScreenSpot { u: number; v: number }
/** A point of her head relative to the midpoint of her eyes, in her head's own frame (m): toward her left, up, forward. */
export interface HeadOffset { across: number; up: number; forward: number }

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const unit = (v: V3): V3 | null => { const l = Math.hypot(v.x, v.y, v.z); return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : null; };
const finite = (...v: number[]) => v.every(Number.isFinite);
const usable = (w: ArrivalWindow | undefined): w is ArrivalWindow => !!w && finite(w.left, w.right, w.top, w.bottom) && w.right > w.left && w.top > w.bottom;

/** Her head's axes now, from her two eyes (world). null when an eye is unknown. */
export function headAxes(left: V3 | null, right: V3 | null): { mid: V3; across: V3; up: V3; forward: V3 } | null {
  if (!left || !right) return null;
  const across = unit(sub(left, right));
  if (!across) return null;
  const d = across.y, up = unit({ x: -d * across.x, y: 1 - d * across.y, z: -d * across.z });
  if (!up) return null;
  const forward = { x: across.y * up.z - across.z * up.y, y: across.z * up.x - across.x * up.z, z: across.x * up.y - across.y * up.x };
  return { mid: { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, z: (left.z + right.z) / 2 }, across, up, forward };
}

/** A head point now (world): `offset` from her eyes' midpoint along her head's axes. null when an eye is unknown. */
export function headPointNow(eyes: { left: V3 | null; right: V3 | null }, offset: HeadOffset): V3 | null {
  const a = headAxes(eyes.left, eyes.right);
  if (!a) return null;
  const at = (k: 'x' | 'y' | 'z') => a.mid[k] + a.across[k] * offset.across + a.up[k] * offset.up + a.forward[k] * offset.forward;
  return { x: at('x'), y: at('y'), z: at('z') };
}

/** Which way her face points as seen from the camera (rad): 0 straight at it, + toward the screen's right, − toward its left. */
export function faceTurnSeen(eyes: { left: V3 | null; right: V3 | null }): number | null {
  const a = headAxes(eyes.left, eyes.right);
  return a ? Math.atan2(a.forward.x, a.forward.z) : null;
}

/**
 * How wide her head is (m), as the user's "头大概占比" reads it: her face's width from her eye span (FACE_PER_EYE_SPAN). Hair is not counted:
 * hairstyles differ too much (measured: the public Gene's side locks make her head with hair 0.25 m, about twice her face), and the user's
 * pictures size the head, not the hair around it. Kept within 0.6–1× the side-to-side extent of her measured head points at the height of
 * her face (hair included), for faces whose eyes sit unusually close or far (measured: the synthetic VRM's eyes are 2.4 cm apart on a
 * 14.8 cm head, which alone would bring her hug's body through the viewer's eye plane). Without either: a 13 cm face.
 */
export function headWidthM(face: FaceGeometry, eyeSpanM: number): number {
  const lo = face.eyes.y - 1.3 * face.mouthDropM, hi = face.eyes.y + 0.6 * face.mouthDropM;
  let min = Infinity, max = -Infinity;
  for (const p of face.points) if (p.y >= lo && p.y <= hi && p.z > face.eyes.z - 0.25) { if (p.x < min) min = p.x; if (p.x > max) max = p.x; }
  const band = Number.isFinite(max - min) && max - min > 0.05 ? max - min : null;
  const fromEyes = Number.isFinite(eyeSpanM) && eyeSpanM > 0.01 && eyeSpanM < 0.2 ? FACE_PER_EYE_SPAN * eyeSpanM : null;
  if (fromEyes !== null && band !== null) return Math.min(band, Math.max(0.6 * band, fromEyes));
  return fromEyes ?? band ?? FACE_PER_EYE_SPAN * 0.06;
}

/**
 * Her ear on `side` (+1 her left, −1 her right) from her eyes' midpoint (head frame): beside her face at about the height between her eyes
 * and her mouth, back by about half her face's width (an estimate from the eye span and the eyes-to-mouth drop; hair usually covers it).
 */
export function earOffset(face: FaceGeometry, eyeSpanM: number, side: 1 | -1): HeadOffset {
  const faceW = FACE_PER_EYE_SPAN * (Number.isFinite(eyeSpanM) && eyeSpanM > 0 ? eyeSpanM : 0.06);
  return { across: side * 0.46 * faceW, up: -0.3 * face.mouthDropM, forward: -0.55 * faceW };
}

/** The window's size per metre ahead (across, up). */
export function windowPerM(lens: FramedLens): { width: number; height: number } | null {
  return usable(lens.window) ? { width: lens.window.right - lens.window.left, height: lens.window.top - lens.window.bottom } : null;
}

/** Depth (m ahead of the camera, along −z) → distance along the axis. */
const alongFor = (lens: ArrivalLens, depth: number) => depth / Math.max(1e-3, -lens.axis.z);

/** How far along the axis her head is `share` of the screen's width (a head `headM` wide). null without a window. */
export function shareDistance(lens: FramedLens, headM: number, share: number): number | null {
  const per = windowPerM(lens);
  return per && share > 0 ? alongFor(lens, headM / (share * per.width)) : null;
}

export interface KissFrame {
  /** The aim point below her eyes' midpoint (m, along her head's down): it goes onto the axis, so her eyes sit at kissEyesV and her mouth at kissMouthV. */
  dropM: number;
  /** How far along the axis (m) for that (before the clip guard). */
  fitM: number;
}
/** The kiss's end frame: from her eyes-to-mouth drop and the window's height. null without a window. */
export function kissFrame(face: FaceGeometry, lens: FramedLens, knobs: ArrivalKnobs = ARRIVAL_KNOBS): KissFrame | null {
  const per = windowPerM(lens), span = knobs.kissEyesV - knobs.kissMouthV;
  if (!per || !(span > 0.05) || !(face.mouthDropM > 0)) return null;
  // v = 2y / (depth · height per metre): the drop spans `span` of v at depth = 2·drop / (span · height); the axis (v = 0) sits `eyesV / span` of the way down.
  return { dropM: face.mouthDropM * knobs.kissEyesV / span, fitM: alongFor(lens, 2 * face.mouthDropM / (span * per.height)) };
}

export interface HugFrame {
  /** The point that goes to `spot`: her ear on the camera's side (head frame, from her eyes' midpoint). */
  offset: HeadOffset;
  spot: ScreenSpot;
  /** How far along the axis (m) so her head is hugHeadShare of the width. */
  fitM: number;
  /** Her head turns this way (+1: toward her left, so her face points to the screen's right): her right ear is the one the camera sees. */
  turn: 1 | -1;
}
/** The hug's end frame (`side` +1: her head on the screen's right, as the user's picture). null without a window. */
export function hugFrame(face: FaceGeometry, eyeSpanM: number, lens: FramedLens, side: 1 | -1 = 1, knobs: ArrivalKnobs = ARRIVAL_KNOBS): HugFrame | null {
  const fitM = shareDistance(lens, headWidthM(face, eyeSpanM), knobs.hugHeadShare);
  if (fitM === null) return null;
  // Her head on the screen's right with her face turned outward (to the right, toward her left): the camera sees her right ear.
  const turn: 1 | -1 = side === 1 ? 1 : -1;
  return { offset: earOffset(face, eyeSpanM, side === 1 ? -1 : 1), spot: { u: side * knobs.hugEarU, v: knobs.hugEarV }, fitM, turn };
}
