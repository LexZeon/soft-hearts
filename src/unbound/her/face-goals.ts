/**
 * I-154 follow-up, the shared set (docs/claude/2026-11-20-unbound-full-shares.md): how her face's goals lay over whatever else drives her
 * body this frame, in both modes. In the companion window the owner is the window's own life (window-life.ts: her look at the cursor, her
 * blinks); out in full-screen Unbound it is whoever drives her there (a peek, her own life, a speech beat, an act) or nobody (rest).
 *
 * Goals only: everything here is added or merged into PoseTargets, and the figure's springs carry the result, so a face goal that starts,
 * stops or changes owner never makes her jump (R29). The rules:
 *  - head, upper body, neck, hips: the face's offsets are added to the owner's (a pat lifts her head into your hand while she walks);
 *  - expression slots and named shapes: per slot the larger of the owner's and the face's (an owner without any keeps the face's object
 *    itself, so the window frame is exactly what it was before this file);
 *  - hands: the face's (a beat's hand at her cheek) when it has any, otherwise the owner's;
 *  - where she looks, her lids, her place, her facing, her gait: the owner's (the window's life already folded the face's look and lids in;
 *    full-screen lays them with `layLook` / the lids in out-face.ts).
 * Pure: no three.js objects, no DOM.
 */
import type { MorphSlot } from '../../../shared/actions';
import type { PoseTargets, Rot } from '../motion/generator';
import type { WindowFaceFrame } from '../window-mode/window-face';
import { headHeld } from '../../../shared/behaviors/part-mix/lids-head';

/** The part of her face's frame the body takes as goals (window-face.ts WindowFaceFrame). */
export type FaceGoals = Pick<WindowFaceFrame, 'expr' | 'exprNamed' | 'head' | 'torso' | 'neck' | 'pelvis' | 'hands'>;

/** The owner's targets with her face's goals laid over them (a new object; the owner's is not changed). */
export function layFace(owner: PoseTargets, face: FaceGoals | null | undefined): PoseTargets {
  if (!face) return owner;
  const out: PoseTargets = { ...owner, head: addRot(owner.head, face.head), torso: addRot(owner.torso, face.torso) };
  // I-175 step 4, who holds her head (shared/behaviors/part-mix/lids-head.ts HEAD_ORDER): a nod or a beat's tilt on her face holds it; the
  // idle layer's own sway yields by this (unbound-idle.ts), in both modes.
  const held = headHeld(face.head);
  if (held > 0 || owner.headHeld !== undefined) out.headHeld = Math.max(owner.headHeld ?? 0, held);
  out.expr = owner.expr ? maxSlots(owner.expr, face.expr) : face.expr;
  out.exprNamed = owner.exprNamed ? maxNamed(owner.exprNamed, face.exprNamed) : face.exprNamed;
  if (face.neck) out.neck = addRot(owner.neck, face.neck);
  if (face.pelvis) out.pelvis = { lateral: owner.pelvis.lateral + face.pelvis.lateral, forward: owner.pelvis.forward + face.pelvis.forward,
    vertical: owner.pelvis.vertical + face.pelvis.vertical };
  if (face.hands) out.hands = face.hands;
  return out;
}

export const addRot = (a: Rot, b: Rot): Rot => ({ pitch: a.pitch + b.pitch, yaw: a.yaw + b.yaw, roll: a.roll + b.roll });

function maxSlots(a: Partial<Record<MorphSlot, number>>, b: Partial<Record<MorphSlot, number>>): Partial<Record<MorphSlot, number>> {
  const out: Partial<Record<MorphSlot, number>> = { ...a };
  for (const [slot, value] of Object.entries(b) as [MorphSlot, number][]) if (Number.isFinite(value)) out[slot] = Math.max(out[slot] ?? 0, value);
  return out;
}
function maxNamed(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [name, value] of Object.entries(b)) if (Number.isFinite(value)) out[name] = Math.max(out[name] ?? 0, value);
  return out;
}
