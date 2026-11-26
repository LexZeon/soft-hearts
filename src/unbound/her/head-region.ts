/**
 * I-154 follow-up, the shared set (docs/claude/2026-11-20-unbound-full-shares.md): the head region her touch input reads (the scalp for a
 * pat, the mouth for a snack, the cheeks for a pinch), projected through whichever camera shows her. The companion window uses its own
 * camera (window-view.ts); full-screen Unbound its world camera (an off-axis frustum, so the size of a unit on screen is asked of the
 * caller rather than read from a field of view). Moved out of window-view.ts unchanged in what it returns for the window.
 */
import { Vector3, type Bone, type PerspectiveCamera } from 'three';
import { clamp, projectHeadContact, type BlushAnchors, type probeHeadContact, type StageSurface } from '../../stage';
import { projectCheekRegions } from '../../mood';

export type HeadContact = ReturnType<typeof probeHeadContact>;
export type HeadRegion = NonNullable<ReturnType<StageSurface['getInteractionRegion']>>;

/** Her head as the projections need it (null fields: the model has none). */
export interface HeadAt {
  head: Bone | null;
  contact: HeadContact | null;
  /**
   * The bone the head contact was measured against (the figure's head; for a VRM, the model's own head). The cheeks too (I-164: a VRM's are
   * measured in its own head's space, src/unbound/her/vrm-blush.ts); for an MMD model it is the figure's head either way.
   */
  contactHead: Bone | null;
  /** Her cheeks measured on her rest pose (the painted blush's anchors), and whether they are the reviewed Gene's. */
  cheeks?: { anchors: BlushAnchors | null; reviewed: boolean } | null;
}

export interface HeadView {
  camera: PerspectiveCamera;
  /** The surface's size (CSS px) the region is in. */
  width: number; height: number;
  /** Her model's height at rest (model units). */
  boundsHeight: number;
  /** `units` model units at `point` (world), in CSS px on this surface. */
  radiusPx(units: number, point: Vector3): number;
}

/** The region in CSS px relative to the surface, or null (no head, no scalp measured, or her scalp is not on the surface). */
export function headRegion(at: HeadAt, view: HeadView): HeadRegion | null {
  const head = at.head;
  if (!head || !at.contact) return null;
  const { width, height, camera } = view, h = view.boundsHeight;
  const forehead = head.localToWorld(new Vector3(0, h * 0.035, h * 0.02));
  const radius = clamp(view.radiusPx(h * 0.07, forehead), 12, width * 0.3);
  const mouth = head.localToWorld(new Vector3(0, -h * 0.01, h * 0.05)).project(camera);
  const scalp = projectHeadContact(at.contact, at.contactHead ?? head, camera, width, height);
  if (!scalp) return null;
  // Batch 3: the cheeks, the companion's projection (projectCheekRegions) of the anchors measured on her rest pose.
  const cheeks = at.cheeks?.anchors ? projectCheekRegions(at.cheeks.anchors, at.contactHead ?? head, camera, width, height, radius * 2, at.cheeks.reviewed) : [];
  return { ...scalp, radius, referenceWidth: radius * 2, mouthRadius: radius * 0.7, cheeks,
    mouthX: (mouth.x + 1) * width / 2, mouthY: (1 - mouth.y) * height / 2 };
}
