/**
 * Round 16: which of the head bone's vertices count as her face for the hand-clearance measure. Locks of hair weighted to the head
 * bone that hang below the chin line are not face. Two more rules were tried (behind the cheeks, beside the lower face) and left
 * out: on Gene they dropped the side hair that the "hair behind the ear" gesture is meant to keep off, and changed the clearance
 * of 79 frames within 3 cm of her (up to 5.9 cm), against the rule that Gene stays as it was. What made a far hand read inside
 * her on a long-haired model was the sign of the measure, now fixed in arm-reach.ts (only a tip near her surface can be inside it).
 * Pure (head-local, model units).
 */
export interface FaceRegionRef {
  /** Head-local rest frame, model units. */
  chinY: number; unitM: number;
}
/** Slack (m) below the chin line before a point stops counting as face. */
export const FACE_REGION = Object.freeze({ belowChinM: 0.01 });

export function inFaceRegion(p: { x: number; y: number; z: number }, ref: FaceRegionRef): boolean {
  return p.y >= ref.chinY - FACE_REGION.belowChinM / ref.unitM;
}

/** A fingertip is never this far (m) inside her: farther from the nearest surface point than this, it is outside whichever way that point faces. */
export const INSIDE_REACH_M = 0.03;
/** The signed distance (m) from the nearest surface point: negative (inside) only when the point faces away from the tip AND is near. */
export function signedSurfaceDistanceM(distanceUnits: number, along: number, unitM: number): number {
  const inside = along < 0 && distanceUnits * unitM <= INSIDE_REACH_M;
  return (inside ? -distanceUnits : distanceUnits) * unitM;
}
