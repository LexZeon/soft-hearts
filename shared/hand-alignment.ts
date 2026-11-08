/**
 * 通用骨架第 3 步 (docs/claude/2026-11-06-skeleton-step3.md): rest frames of the hands and finger segments, so the motion
 * conversion (shared/motion-retarget.ts planRetarget) can align a hand whose rest orientation differs from the standard pose's
 * (Gene's) the way it already aligns the arms.
 *
 * An MMD bone has no rest rotation, only joint positions, so a segment's direction fixes two of its three axes; the roll about
 * the segment is what makes a finger curl toward the palm or sideways. The palm supplies it: the hand's "across" axis runs from
 * the little-finger side to the index side over the finger bases. Each frame here is three orthonormal columns:
 *   x: along the segment (wrist → finger bases for the hand; joint → next joint, or the tip, for a finger segment),
 *   y: the palm's across axis made perpendicular to x,
 *   z: x × y.
 * The conversion then aligns each bone by A = F_source · F_targetᵀ (A maps the target's rest frame onto the source's), exactly
 * the q_t = A_p⁻¹ q_s A_b correction the arms use, only with the roll included.
 *
 * Only parts both rigs have are paired, and each pair compares like with like: the same two finger bases, the same joint to
 * the same next joint (a joint one model lacks is skipped on both sides, never measured against a different segment). A hand
 * without two comparable finger bases gets no frame at all (its wrist and fingers inherit the forearm's alignment, as before).
 * Pure geometry on plain arrays: no Three, no I/O.
 */
import { FINGER_JOINTS, fingerPartOfName, type Finger, type FingerSlot, type StandardBone, type Vec3 } from './universal-skeleton';

/** What the frames need from a rig (shared/motion-retarget.ts RetargetRig has all of it). */
export interface HandRig {
  bones: readonly { name: string; parent: number; position: Vec3 }[];
  slots: Partial<Record<StandardBone, number>>;
  fingers?: Partial<Record<FingerSlot, number>>;
}
/** Orthonormal columns: along the segment, across the palm, their cross product. */
export type RestFrame = readonly [Vec3, Vec3, Vec3];
export type HandPart = 'wristLeft' | 'wristRight' | FingerSlot;
export interface HandFramePair {
  part: HandPart;
  /** The target bone this frame belongs to. */
  bone: number;
  source: RestFrame;
  target: RestFrame;
}

/** A frame whose across axis is within asin(0.2) ≈ 11.5° of its segment is too unsure to roll by: left out. */
export const HAND_FRAME_MIN_SINE = 0.2;
const SIDES = ['Left', 'Right'] as const;
/** Index side first, little side first: the outermost pair both hands have spans the palm. */
const INDEX_SIDE: readonly Finger[] = ['index', 'middle'];
const LITTLE_SIDE: readonly Finger[] = ['little', 'ring'];
const BASE_FINGERS: readonly Finger[] = ['index', 'middle', 'ring', 'little'];

const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Readonly<Vec3>) => Math.hypot(a[0], a[1], a[2]);
const scaled = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** The frame of a segment along `along`, rolled by `across`; null when either is degenerate or they nearly line up. */
export function restFrame(along: Readonly<Vec3>, across: Readonly<Vec3>): RestFrame | null {
  const alongLength = length(along), acrossLength = length(across);
  if (!(alongLength > 1e-9 && acrossLength > 1e-9) || !Number.isFinite(alongLength + acrossLength)) return null;
  const x = scaled(along, 1 / alongLength);
  const side = sub(across, scaled(x, dot(x, across))), sideLength = length(side);
  if (!(sideLength >= HAND_FRAME_MIN_SINE * acrossLength)) return null;
  const y = scaled(side, 1 / sideLength);
  return [x, y, cross(x, y)];
}

function descends(rig: HandRig, child: number, ancestor: number): boolean {
  for (let at = rig.bones[child]?.parent ?? -1, steps = 0; at >= 0 && steps <= rig.bones.length; at = rig.bones[at]?.parent ?? -1, steps++) if (at === ancestor) return true;
  return false;
}

/** The end of a finger's last joint: its one tip child (先, tip, end), else its only child; null when unsure. */
export function tipOf(rig: HandRig, joint: number, finger: Finger, side: 'left' | 'right'): number | null {
  const children: number[] = [];
  rig.bones.forEach((bone, index) => { if (bone.parent === joint) children.push(index); });
  const tips = children.filter(index => { const part = fingerPartOfName(rig.bones[index].name); return !!part?.tip && part.finger === finger && part.side === side; });
  if (tips.length === 1) return tips[0];
  return !tips.length && children.length === 1 ? children[0] : null;
}

/**
 * Matching rest frames of the two rigs' hands and finger segments: the wrist (hand frame) and every finger joint both rigs
 * have whose segment can be measured the same way on both. Indices of `bone` are the target's.
 */
export function handRestFramePairs(source: HandRig, target: HandRig): HandFramePair[] {
  const pairs: HandFramePair[] = [];
  for (const side of SIDES) {
    const wristS = source.slots[`wrist${side}`], wristT = target.slots[`wrist${side}`];
    if (wristS === undefined || wristT === undefined) continue;
    const lower = side === 'Left' ? 'left' : 'right';
    const slot = (finger: Finger, joint: number) => `${finger}${joint}${side}` as FingerSlot;
    /** A joint both rigs map, each under its own wrist. */
    const both = (key: FingerSlot): [number, number] | null => {
      const s = source.fingers?.[key], t = target.fingers?.[key];
      return s !== undefined && t !== undefined && descends(source, s, wristS) && descends(target, t, wristT) ? [s, t] : null;
    };
    const bases = BASE_FINGERS.filter(finger => both(slot(finger, 1)));
    const indexSide = INDEX_SIDE.find(finger => bases.includes(finger)), littleSide = LITTLE_SIDE.find(finger => bases.includes(finger));
    if (!indexSide || !littleSide) continue;
    const handOf = (rig: HandRig, wrist: number, pick: 0 | 1) => {
      const at = (finger: Finger) => rig.bones[both(slot(finger, 1))![pick]].position;
      const across = sub(at(indexSide), at(littleSide));
      const reach = bases.includes('middle') ? at('middle')
        : scaled([at(indexSide)[0] + at(littleSide)[0], at(indexSide)[1] + at(littleSide)[1], at(indexSide)[2] + at(littleSide)[2]], 0.5);
      return { across, frame: restFrame(sub(reach, rig.bones[wrist].position), across) };
    };
    const handS = handOf(source, wristS, 0), handT = handOf(target, wristT, 1);
    if (!handS.frame || !handT.frame) continue;
    pairs.push({ part: `wrist${side}`, bone: wristT, source: handS.frame, target: handT.frame });
    for (const finger of ['thumb', ...BASE_FINGERS] as const) {
      const joints = FINGER_JOINTS[finger].filter(joint => both(slot(finger, joint)));
      const last = FINGER_JOINTS[finger][FINGER_JOINTS[finger].length - 1];
      joints.forEach((joint, k) => {
        const [jS, jT] = both(slot(finger, joint))!;
        let ends: [number, number] | null = null;
        const next = joints[k + 1];
        if (next !== undefined) {
          const [nS, nT] = both(slot(finger, next))!;
          if (descends(source, nS, jS) && descends(target, nT, jT)) ends = [nS, nT];
        } else if (joint === last) {
          const tS = tipOf(source, jS, finger, lower), tT = tipOf(target, jT, finger, lower);
          if (tS !== null && tT !== null) ends = [tS, tT];
        }
        if (!ends) return;
        const frameS = restFrame(sub(source.bones[ends[0]].position, source.bones[jS].position), handS.across);
        const frameT = restFrame(sub(target.bones[ends[1]].position, target.bones[jT].position), handT.across);
        if (frameS && frameT) pairs.push({ part: slot(finger, joint), bone: jT, source: frameS, target: frameT });
      });
    }
  }
  return pairs;
}
