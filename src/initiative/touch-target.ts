/**
 * How big a round "touch this" target on her (her hand held out, the thing she gives you) may be on screen.
 *
 * The radius follows the model's projected size, so in a close-up it grew past the whole companion window. The target is marked as a companion
 * control (the mood-UI mark): every point inside it stops being a pat or a pinch, so she could not be patted while she held out her hand
 * (the green circle was this button's focus ring).
 */
export const TOUCH_TARGET_MAX_WINDOW_SHARE = 0.16;

/**
 * Her held-out hand (hold, pinky, high five) takes a click only in a ring round her palm.
 * The old target was 1.4 × 5% of her height round the middle of the whole hand, fingers included.
 * - centreAt: the target's centre, as a share of the hand's length from the wrist (the palm's middle, not the fingertips).
 * - ring: its radius, as a share of the hand's length (the palm and a thin ring round it).
 * - floorPx: never smaller than this (a far, small figure stays clickable).
 */
export const PALM_TARGET = Object.freeze({ centreAt: 0.3, ring: 0.42, floorPx: 16 });

/** The palm ring's radius on screen for a hand `handLengthPx` long there (window limits as `touchTargetRadius`). */
export function palmTargetRadius(handLengthPx: number, width: number, height: number): number {
  return touchTargetRadius(handLengthPx * PALM_TARGET.ring, width, height, PALM_TARGET.floorPx);
}

/** `radius` limited to a hand-sized share of the window's shorter side, never below `floor`. Unknown window size: no limit. */
export function touchTargetRadius(radius: number, width: number, height: number, floor: number): number {
  const side = Math.min(width, height);
  const limit = side > 0 ? Math.max(floor, side * TOUCH_TARGET_MAX_WINDOW_SHARE) : Infinity;
  return Math.max(floor, Math.min(radius, limit));
}
