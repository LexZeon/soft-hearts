/**
 * 通用骨架第 4 步 (docs/claude/2026-11-06-skeleton-step4.md): contact points. Some library motions bring the two hands
 * together: 鼓掌 claps the palms three times, 比心 puts the thumb tips together and the index and middle tips together. They
 * are authored and reviewed on Gene (the standard pose); the conversion keeps every segment's world direction, so on a body
 * with wider shoulders or longer arms the same rotations leave the hands apart in the air, or push them through each other.
 *
 * What is here:
 * - the library's contact metadata (MOTION_CONTACTS): per motion, which part of the two hands touches, at which source frames,
 *   and over which frames the fit eases in and out. Keyed by the catalog's pinned sha256; the VMD bytes are never touched.
 * - fitContacts: after the conversion, moves each arm just enough that the vector between the two hands' contact points is
 *   Gene's at the same frame (in the chest's frame, scaled by the hand size). Each hand moves by half the difference and keeps
 *   its world orientation (a two-bone reach on upper arm and forearm, the wrist turned back), weighted by a smooth envelope
 *   that is 0 at the motion's start and end (entry and exit are exactly the plain conversion's) and 1 from the first touch to
 *   the last, so nothing jumps at a touch. On Gene, or any body that matches it, the difference is 0 and nothing is changed.
 * - contactMisses: the quality check's measure (shared/motion-fit.ts 'contact'): at each touch, how far the hands still are
 *   from meeting as on Gene, in head sizes, and whether they miss (too far apart) or pass through each other (too close).
 *
 * Pure math on plain arrays, no Three, no I/O. Only motions listed here are changed (her other motions and the user's own
 * VMDs keep the plain conversion, or none).
 */
import {
  evaluatePose, qarc, qaxisAngle, qconj, qmul, qnormalize, qrotate, sampleTrack, vadd, vcross, vdot, vlength, vnormalize, vscale, vsub,
  LINEAR_INTERPOLATION, type Pose, type Quat, type RetargetRig, type TrackKey, type Tracks,
} from './motion-retarget';
import { tipOf } from './hand-alignment';
import { FINGER_JOINTS, inHeads, type Finger, type FingerSlot, type Vec3 } from './universal-skeleton';

/** What touches, by standard part: the palm (wrist and the four finger bases), or a finger's tip. */
export type ContactPart = 'palm' | `${Finger}Tip`;
export interface MotionContact {
  pack: string;
  motion: string;
  /** The catalog's pinned content hash (shared/motion-catalog.json): the annotation belongs to these bytes only. */
  sha256: string;
  /** The same part of both hands touches the other hand's (left palm on right palm, left thumb tip on right thumb tip). */
  parts: readonly ContactPart[];
  /** Source frames (30 fps) where the parts touch, one [from, to] per touch (a clap, the heart's hold). */
  touches: readonly (readonly [number, number])[];
  /** The fit eases in over these source frames before the first touch and out over these after the last (full in between). */
  easeIn: readonly [number, number];
  easeOut: readonly [number, number];
}

/**
 * The library's contact metadata (only 鼓掌 and 比心 for now). Frames read off Gene (docs/claude/2026-11-06-skeleton-step4.md):
 * 鼓掌's palms close at f55–58, f82–85, f109–112 (0.661 apart at the closest: Codex leaves a small gap on purpose); the
 * hands rise from f0 and are open and still by f39, open again at f123 and back at rest by f162. 比心 holds the heart from f75
 * to f102 (thumb tips 0.17 apart, index 0.18, middle 0.25); the hands close in from f46 and part after f102. The eases sit
 * where the hands already move, never on a still frame and never at the first or last frame.
 */
export const MOTION_CONTACTS: readonly MotionContact[] = Object.freeze(([
  { pack: 'soft-hearts-actions', motion: 'clap', sha256: '852bbcfd502172fd7f9a9801540ec43580c633f0287d6191527a7950b9c5f576',
    parts: ['palm'], touches: [[55, 58], [82, 85], [109, 112]], easeIn: [6, 39], easeOut: [123, 156] },
  { pack: 'soft-hearts-actions', motion: 'two-hand-heart', sha256: 'ca14e77390e7dc5efb4ffc1ab48ca40a3ce7cf6ea6208c616c5bb83edb15b643',
    parts: ['thumbTip', 'indexTip', 'middleTip'], touches: [[75, 102]], easeIn: [46, 75], easeOut: [102, 131] },
] satisfies MotionContact[]).map(entry => Object.freeze(entry)));
const BY_SHA = new Map(MOTION_CONTACTS.map(entry => [entry.sha256, entry]));
/** The contact annotation of a library motion by its content hash; null for every other motion (and any VMD not in the library). */
export const contactFor = (sha256: string | null | undefined): MotionContact | null => (sha256 && BY_SHA.get(sha256)) || null;

/**
 * The quality check's tolerance (shared/motion-fit.ts 'contact', digested into the stored scores' stamp): a touch whose
 * contact points end up more than this many head sizes from where they meet on Gene (scaled by the hand) fails. The fit
 * itself brings a reachable touch to ~0; what is left is an arm too short to reach, or a correction undone by another fix.
 */
export const CONTACT_TOLERANCE = Object.freeze({ heads: 0.05 });

// ---------------------------------------------------------------- contact points

type Side = 'Left' | 'Right';
const SIDES: readonly Side[] = ['Left', 'Right'];
/** Each side's bones whose rest points (posed) average to the contact point; the two rigs' lists name the same parts. */
interface PointPair { part: ContactPart; source: Record<Side, number[]>; target: Record<Side, number[]> }

function partBones(source: RetargetRig, target: RetargetRig, part: ContactPart, side: Side): [number[], number[]] | null {
  const lower = side === 'Left' ? 'left' : 'right';
  if (part === 'palm') {
    const ws = source.slots[`wrist${side}`], wt = target.slots[`wrist${side}`];
    if (ws === undefined || wt === undefined) return null;
    const s = [ws], t = [wt];
    for (const finger of ['index', 'middle', 'ring', 'little'] as const) {
      const slot = `${finger}1${side}` as FingerSlot, a = source.fingers?.[slot], b = target.fingers?.[slot];
      if (a !== undefined && b !== undefined) { s.push(a); t.push(b); }
    }
    return [s, t];
  }
  const finger = part.slice(0, -3) as Finger, joints = FINGER_JOINTS[finger];
  const slot = `${finger}${joints[joints.length - 1]}${side}` as FingerSlot, a = source.fingers?.[slot], b = target.fingers?.[slot];
  if (a === undefined || b === undefined) return null;
  const tipS = tipOf(source, a, finger, lower), tipT = tipOf(target, b, finger, lower);
  // Tip to tip when both have one, else the last joint on both: never a tip measured against a joint.
  return tipS !== null && tipT !== null ? [[tipS], [tipT]] : [[a], [b]];
}
/** The contact points both rigs have, part by part (a part either rig lacks on either hand is left out). */
export function contactPairs(source: RetargetRig, target: RetargetRig, contact: Pick<MotionContact, 'parts'>): PointPair[] {
  const pairs: PointPair[] = [];
  for (const part of contact.parts) {
    const left = partBones(source, target, part, 'Left'), right = partBones(source, target, part, 'Right');
    if (left && right) pairs.push({ part, source: { Left: left[0], Right: right[0] }, target: { Left: left[1], Right: right[1] } });
  }
  return pairs;
}
const mean = (points: readonly Vec3[]): Vec3 => vscale(points.reduce((sum, point) => vadd(sum, point), [0, 0, 0] as Vec3), 1 / points.length);
/** Left contact point minus right, averaged over the pairs. */
function gapOf(pose: Pose, pairs: readonly PointPair[], which: 'source' | 'target'): Vec3 {
  return mean(pairs.map(pair => vsub(mean(pair[which].Left.map(index => pose.wp[index])), mean(pair[which].Right.map(index => pose.wp[index])))));
}
/** Hand size of the target over the source's (wrist → middle or index base at rest, both hands), else head size: scales Gene's gap. */
export function handScale(source: RetargetRig, target: RetargetRig): number {
  const palm = (rig: RetargetRig) => {
    const lengths: number[] = [];
    for (const side of SIDES) {
      const wrist = rig.slots[`wrist${side}`], base = rig.fingers?.[`middle1${side}`] ?? rig.fingers?.[`index1${side}`];
      if (wrist !== undefined && base !== undefined) lengths.push(vlength(vsub(rig.bones[base].position, rig.bones[wrist].position)));
    }
    return lengths.length === 2 ? (lengths[0] + lengths[1]) / 2 : null;
  };
  const s = palm(source), t = palm(target);
  const ratio = s && t ? t / s : target.headSize / source.headSize;
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(4, Math.max(0.25, ratio)) : 1;
}
/** The chest's turn from the source's pose to the target's (identity without a chest): Gene's gap is read in the body's frame. */
function chestTurn(source: RetargetRig, sourcePose: Pose, target: RetargetRig, targetPose: Pose): Quat {
  const s = source.slots.upperBody2 ?? source.slots.upperBody, t = target.slots.upperBody2 ?? target.slots.upperBody;
  return s !== undefined && t !== undefined ? qnormalize(qmul(targetPose.wq[t], qconj(sourcePose.wq[s]))) : [0, 0, 0, 1];
}
/** Where the target's hands should be relative to each other at this frame: Gene's gap, turned with the chest, scaled by the hand. */
function wantedGap(source: RetargetRig, sourcePose: Pose, target: RetargetRig, targetPose: Pose, pairs: readonly PointPair[], scale: number): Vec3 {
  return qrotate(chestTurn(source, sourcePose, target, targetPose), vscale(gapOf(sourcePose, pairs, 'source'), scale));
}

// ---------------------------------------------------------------- envelope

const smoother = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
/** The fit's weight at a source frame: 0 before the ease-in, smoothly (C2) up to 1, 1 through the touches, smoothly down to 0. */
export function contactWeight(contact: Pick<MotionContact, 'easeIn' | 'easeOut'>, frame: number): number {
  const [a, b] = contact.easeIn, [c, d] = contact.easeOut;
  if (frame <= a || frame >= d) return 0;
  if (frame < b) return smoother((frame - a) / Math.max(1e-9, b - a));
  if (frame > c) return 1 - smoother((frame - c) / Math.max(1e-9, d - c));
  return 1;
}

// ---------------------------------------------------------------- the fit

/** What the fit did: the largest move of one hand (head sizes), and how many frames needed more reach than the arm has. */
export interface ContactFit { shift: number; unreachable: number; pairs: ContactPart[] }

interface ArmChain { arm: number; elbow: number; wrist: number }
function armChain(rig: RetargetRig, side: Side): ArmChain | null {
  const arm = rig.slots[`arm${side}`], elbow = rig.slots[`elbow${side}`], wrist = rig.slots[`wrist${side}`];
  if (arm === undefined || elbow === undefined || wrist === undefined) return null;
  // The chain must really hang arm → elbow → wrist (twist bones in between are fine).
  const under = (child: number, ancestor: number) => {
    for (let at = rig.bones[child].parent, steps = 0; at >= 0 && steps <= rig.bones.length; at = rig.bones[at].parent, steps++) if (at === ancestor) return true;
    return false;
  };
  return under(wrist, elbow) && under(elbow, arm) ? { arm, elbow, wrist } : null;
}

/**
 * New local rotations of one arm that move its wrist by `delta` and keep the hand's world orientation: the elbow bends (about
 * its own bend axis) to the distance the wrist needs from the shoulder, then the whole arm swings about the shoulder by the
 * shortest arc. A wrist out of reach is brought as far as the straightened arm goes (`reached` false).
 */
function reach(rig: RetargetRig, pose: Pose, chain: ArmChain, delta: Readonly<Vec3>): { arm: Quat; elbow: Quat; wrist: Quat; reached: boolean } {
  const S = pose.wp[chain.arm], E = pose.wp[chain.elbow], W = pose.wp[chain.wrist], goal = vadd(W, delta);
  const upper = vsub(E, S), lower = vsub(W, E), a = vlength(upper), b = vlength(lower), want = vlength(vsub(goal, S));
  const shortest = Math.abs(a - b) + 1e-6 * (a + b), longest = (a + b) * (1 - 1e-4);
  const c = Math.min(longest, Math.max(shortest, want));
  let axis = vcross(upper, lower);
  if (vlength(axis) < 1e-9 * a * b) {
    // A straight arm has no bend plane: bend the way the chest's forward axis would fold it.
    axis = vcross(upper, [0, 0, 1]);
    if (vlength(axis) < 1e-9 * a) axis = vcross(upper, [1, 0, 0]);
  }
  const bend = Math.acos(Math.min(1, Math.max(-1, vdot(vnormalize(upper), vnormalize(lower)))));
  const wanted = Math.PI - Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - c * c) / (2 * a * b))));
  const turnElbow = qaxisAngle(vnormalize(axis), wanted - bend);
  const moved = vadd(E, qrotate(turnElbow, lower));
  const swing = qarc(vsub(moved, S), vsub(goal, S));
  const parentQ = (index: number) => { const parent = rig.bones[index].parent; return parent >= 0 ? pose.wq[parent] : [0, 0, 0, 1] as Quat; };
  const both = qmul(swing, turnElbow);
  return {
    arm: qnormalize(qmul(qconj(parentQ(chain.arm)), qmul(swing, pose.wq[chain.arm]))),
    elbow: qnormalize(qmul(qconj(parentQ(chain.elbow)), qmul(turnElbow, pose.wq[chain.elbow]))),
    wrist: qnormalize(qmul(qconj(parentQ(chain.wrist)), qmul(qconj(both), pose.wq[chain.wrist]))),
    reached: Math.abs(c - want) <= 1e-6 * (a + b),
  };
}

/**
 * Moves the target's arms so the annotated parts meet as on the source (see the header), in place on `tracks` (the
 * conversion's target-space tracks). Returns null when the rigs lack the parts or an arm chain (nothing is changed then).
 */
export function fitContacts(source: RetargetRig, sourceTracks: Tracks, target: RetargetRig, tracks: Tracks, lastFrame: number, contact: MotionContact): ContactFit | null {
  const pairs = contactPairs(source, target, contact);
  const chains = { Left: armChain(target, 'Left'), Right: armChain(target, 'Right') };
  if (!pairs.length || !chains.Left || !chains.Right) return null;
  const scale = handScale(source, target);
  const start = Math.max(0, Math.min(lastFrame, contact.easeIn[0])), end = Math.max(start, Math.min(lastFrame, contact.easeOut[1]));
  const bones = SIDES.flatMap(side => [chains[side]!.arm, chains[side]!.elbow, chains[side]!.wrist]);
  // Every frame any of the six bones is keyed on inside the envelope, and both ends (where the weight is 0: the values stay).
  const frames = new Set<number>([start, end]);
  for (const index of bones) for (const key of tracks.get(index) ?? []) if (key.frame > start && key.frame < end) frames.add(key.frame);
  const ordered = [...frames].sort((x, y) => x - y);
  const out = new Map<number, TrackKey[]>(bones.map(index => [index, []]));
  let shift = 0, unreachable = 0;
  for (const frame of ordered) {
    const pose = evaluatePose(target, tracks, frame), weight = contactWeight(contact, frame);
    let delta: Vec3 = [0, 0, 0];
    if (weight > 0) {
      const sourcePose = evaluatePose(source, sourceTracks, frame);
      const error = vsub(wantedGap(source, sourcePose, target, pose, pairs, scale), gapOf(pose, pairs, 'target'));
      delta = vscale(error, weight / 2);
    }
    shift = Math.max(shift, vlength(delta));
    for (const side of SIDES) {
      const chain = chains[side]!, move = side === 'Left' ? delta : vscale(delta, -1);
      const keyAt = (index: number) => tracks.get(index)?.find(key => key.frame === frame);
      const sampled = (index: number) => { const keys = tracks.get(index); return keys?.length ? sampleTrack(keys, frame) : { p: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as Quat }; };
      const solved = vlength(move) > 0 ? reach(target, pose, chain, move) : null;
      if (solved && !solved.reached) unreachable++;
      for (const [index, q] of [[chain.arm, solved?.arm], [chain.elbow, solved?.elbow], [chain.wrist, solved?.wrist]] as const) {
        const own = keyAt(index), value = sampled(index);
        out.get(index)!.push({ frame, p: [...value.p] as Vec3, q: q ?? [...value.q] as Quat, interp: own?.interp ?? LINEAR_INTERPOLATION });
      }
    }
  }
  const result: ContactFit = { shift: Math.round(inHeads(shift, target.headSize) * 1e4) / 1e4, unreachable, pairs: pairs.map(pair => pair.part) };
  // On Gene (or a body that matches it) the hands already meet: leave the tracks exactly as converted.
  if (!(shift > 1e-6 * target.headSize)) return { ...result, shift: 0 };
  for (const index of bones) {
    const keys = tracks.get(index) ?? [];
    tracks.set(index, [...keys.filter(key => key.frame < start), ...out.get(index)!, ...keys.filter(key => key.frame > end)]);
  }
  return result;
}

// ---------------------------------------------------------------- the check

export interface ContactMiss {
  /** Which touch (0-based, in the annotation's order). */
  touch: number;
  /** The largest distance of the hands' gap from the wanted one over the touch's frames, in the target's head sizes. */
  error: number;
  /** miss: farther apart than on Gene; pass: closer (into or through each other). */
  kind: 'miss' | 'pass';
}
/** Each touch whose hands end up more than CONTACT_TOLERANCE from meeting as on the source; [] without comparable parts. */
export function contactMisses(source: RetargetRig, sourceTracks: Tracks, target: RetargetRig, tracks: Tracks, contact: MotionContact): ContactMiss[] {
  const pairs = contactPairs(source, target, contact);
  if (!pairs.length) return [];
  const scale = handScale(source, target), misses: ContactMiss[] = [];
  contact.touches.forEach(([from, to], touch) => {
    let worst: ContactMiss | null = null;
    for (let frame = Math.ceil(from); frame <= to; frame++) {
      const sourcePose = evaluatePose(source, sourceTracks, frame), pose = evaluatePose(target, tracks, frame);
      const want = wantedGap(source, sourcePose, target, pose, pairs, scale), got = gapOf(pose, pairs, 'target');
      const error = inHeads(vlength(vsub(got, want)), target.headSize);
      if (worst && error <= worst.error) continue;
      worst = { touch, error, kind: vlength(got) < vlength(want) || vdot(got, want) < 0 ? 'pass' : 'miss' };
    }
    if (worst && worst.error > CONTACT_TOLERANCE.heads) misses.push({ ...worst, error: Math.round(worst.error * 1000) / 1000 });
  });
  return misses;
}
