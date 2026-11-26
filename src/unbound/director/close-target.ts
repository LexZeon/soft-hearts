/**
 * I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): where a full-screen kiss or hug takes her, decided once when she has noticed you.
 * The end frames are where her face sits on the screen (shared/unbound/arrival/screen-frame.ts): the kiss storyboard ("这个分镜差不多了") and
 * the hug's last frame ("这个差不多是抱抱最终的样子"); the start is where her head is about a fifth of the screen's width, centred (the
 * storyboard's 01), and she comes back there after the hold (05).
 *
 *   kiss   the point between her eyes and her mouth on the axis, as far as puts her eyes in the upper part and her mouth in the lower part
 *          (kissFrame), never so near that any of her head comes into the camera (the clip guard), never nearer than minFaceM
 *   hug    her ear (the one the camera sees: her face turned outward, to the screen's right) at the screen's right, her head hugHeadShare of
 *          the width (hugFrame)
 *   stand  where she stands for that, leaning as the plan says (solveHeadArrival)
 *   start  where her head is normalHeadShare of the width on the axis: she walks there first when she is farther (or off to the side);
 *          when she is already nearer she begins where she is
 * Without a window (an older lens) the I-192 fit is used (the span from her eyes to below her mouth fills faceFill of the screen's height).
 */
import {
  ARRIVAL_KNOBS, faceAim, faceDistance, fallbackFace, headWidthM, hugFrame, kissFrame, shareDistance, solveHeadArrival, turnHead, usableFace,
  type FaceGeometry, type HeadOffset, type ScreenSpot, type V3,
} from '../../../shared/unbound/arrival';
import type { CloseMomentPlan } from '../../../shared/unbound/close-moments';
import type { BodySense } from '../motion/generator';
import { toHerFrame, type LensView } from '../motion/lens-align';

export interface CloseTarget {
  /** Along the axis (m) where her point stops (before the arrival check's push) and the fit before the clip guard; clipped: the guard decided. */
  distanceM: number; fitM: number; clipped: boolean;
  /** The kiss's point below her eyes (m) and her mouth below them (m). */
  dropM: number; mouthDropM: number;
  /** The hug's point: her ear (head frame, from her eyes' midpoint); null: `dropM` below her eyes (the kiss). */
  point: HeadOffset | null;
  /** Where in the window the point goes ({0, 0}: on the axis). */
  spot: ScreenSpot;
  /** The lean the stand solve allows (rad); where she stands for it; where she begins (and comes back to). */
  lean: number; stand: { x: number; z: number }; start: { x: number; z: number };
  /** She walks to `start` first (she is farther than it, or off to the side). */
  walkToStart: boolean;
  /** Her head's width at her face's height (m) and her eye span (m), for the record. */
  headM: number; eyeSpanM: number;
}

/** Closer than this (m) to the start point, or nearer the camera than it: she begins where she is. */
export const START_NEAR_M = 0.15;

/** The target for `plan` (a kiss or a hug) from her body now; null without her eyes (the caller falls back to the old face station). */
export function closeTarget(plan: CloseMomentPlan, lens: LensView, sense: BodySense, yaw: number, tiptoeShare: number): CloseTarget | null {
  const frame = sense.frame, root = sense.root;
  if (!frame || !sense.head || plan.kind === 'shy') return null;
  const head = toHerFrame({ x: sense.head.x - root.x, y: sense.head.y, z: sense.head.z - root.z }, root.heading);
  const eyes: V3 = { x: (frame.eyes.left.x + frame.eyes.right.x) / 2 - head.x, y: (frame.eyes.left.y + frame.eyes.right.y) / 2 - head.y, z: (frame.eyes.left.z + frame.eyes.right.z) / 2 - head.z };
  const face: FaceGeometry = usableFace(sense.face) ?? fallbackFace(head.y / 0.92, eyes, sense.eyeSizeM);
  const span = Math.hypot(frame.eyes.left.x - frame.eyes.right.x, frame.eyes.left.y - frame.eyes.right.y, frame.eyes.left.z - frame.eyes.right.z);
  const roll = plan.tiltRad, k = ARRIVAL_KNOBS, guardM = k.minClearM + k.hairSwingM;
  const old = faceDistance(face, lens.heightPerM, { yaw, roll });
  let dropM = face.eyes.y - faceAim(face).y, fitM = old.fitM, point: HeadOffset | null = null, spot: ScreenSpot = { u: 0, v: 0 };
  if (plan.kind === 'kiss') {
    const kf = kissFrame(face, lens);
    if (kf) { dropM = kf.dropM; fitM = kf.fitM; }
  } else {
    const hf = hugFrame(face, span, lens, 1);
    if (hf) { point = hf.offset; spot = hf.spot; fitM = hf.fitM; }
  }
  // The point at rest (from her head bone, her frame), and how far any of her head comes in front of it with her head turned as it will be.
  const at: V3 = point ? { x: face.eyes.x + point.across, y: face.eyes.y + point.up, z: face.eyes.z + point.forward } : { x: face.eyes.x, y: face.eyes.y - dropM, z: face.eyes.z };
  const anchor = turnHead(at, yaw, roll);
  let reach = 0;
  for (const p of face.points) reach = Math.max(reach, turnHead(p, yaw, roll).z - anchor.z);
  const clipM = guardM + reach, distanceM = Math.max(fitM, clipM, k.minFaceM);
  // A kiss may also dip the viewer's eye (close-moment.ts cameraDipM, at most kissDipMaxM): she keeps her lean toward you and the camera meets her.
  const rise = sense.tiptoeRise * tiptoeShare + (plan.kind === 'kiss' ? k.kissDipMaxM : 0);
  const solve = solveHeadArrival({ head, offset: anchor, pivot: frame.pivot, lens, distanceM, wantedLean: Math.max(0, plan.leanRad), rise, spot });
  // Where she begins: her head a fifth of the width, centred, standing straight (the storyboard's 01).
  const headM = headWidthM(face, span), startAlong = shareDistance(lens, headM, k.normalHeadShare);
  let start = { x: root.x, z: root.z }, walkToStart = false;
  if (startAlong !== null && startAlong > distanceM + 0.1) {
    const begin = solveHeadArrival({ head, offset: face.eyes, pivot: frame.pivot, lens, distanceM: startAlong, wantedLean: 0, rise: 0 }).stand;
    // Nearer the camera than the start already (she was close): she begins where she is, never steps back first.
    const nearer = (root.z - begin.z) * Math.sign(lens.camera.z - begin.z) > 0;
    if (!nearer && Math.hypot(root.x - begin.x, root.z - begin.z) > START_NEAR_M) { start = begin; walkToStart = true; }
  }
  return { distanceM, fitM, clipped: clipM > Math.max(fitM, k.minFaceM), dropM, mouthDropM: face.mouthDropM, point, spot, lean: solve.lean, stand: solve.stand, start, walkToStart, headM, eyeSpanM: span };
}
