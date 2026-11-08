/**
 * Automatic quality check for a retargeted motion on one model (adaptation
 * layer step 2). Samples the target-space tracks every 0.25 s on the target rig
 * and scores what users notice first:
 * - penetration: forearm/hand segments against the model's fitted collision
 *   proxy (pelvis/abdomen/chest/neck and head capsules from its own skinned
 *   vertices, shared/collision-proxy.ts) when the profile has one; otherwise a
 *   torso capsule and a head sphere sized from its proportions (the rough body);
 * - feet: both feet off the ground (floating), a foot below it (sinking), a
 *   planted foot moving (sliding);
 * - joint limits: a small rest-independent table (elbow/knee bend, torso/neck/
 *   head/wrist twist from rest);
 * - stretch: an IK target out of the leg's reach, or a limb bone translated
 *   away from its joint.
 * - structure (T-213): a body bone that hangs under another standard bone than
 *   in the source (the head under the center, not the neck) drifts from where
 *   the source's hierarchy would carry it, measured against the same target
 *   with that bone re-hung (structureReference).
 * - contact (universal skeleton step 4): for a library motion whose hands touch
 *   (shared/motion-contact.ts: 鼓掌's palms, 比心's fingertips), at each touch the
 *   hands still miss each other or pass through each other after the contact fit.
 * A failing penetration is first fixed by easing the upper arm away from the
 * body (baked keys); whatever still fails hides the motion on this model.
 * Pure data in, plain data out.
 */
import {
  LINEAR_INTERPOLATION, evaluatePose, identityFor, ikTarget, lostByName, qaxisAngle, qangle, qconj, qmul, qnormalize, qrotate, retargetTracks, retargetVmd,
  sampleTrack, solveTwoBone, structureReference, tracksOnRig, vadd, vdot, vlength, vnormalize, vscale, vsub, writeVmd,
  type Pose, type Quat, type RetargetPlan, type RetargetReport, type RetargetRig, type TrackKey, type Tracks, type VmdLike,
} from './motion-retarget';
import { inHeads, type StandardBone, type Vec3 } from './universal-skeleton';
import { TORSO_SEGMENTS, type ProxySegment } from './collision-proxy';
import { contactMisses, fitContacts, type ContactFit, type MotionContact } from './motion-contact';

export type MotionFitStatus = 'ok' | 'adjusted' | 'hidden';
export type FitCheck = 'penetration' | 'floating' | 'sinking' | 'sliding' | 'joint-limit' | 'stretch' | 'structure' | 'contact';
export interface FitIssue { check: FitCheck; samples: number; worst: number; where: string }
export interface MotionFit {
  status: MotionFitStatus;
  samples: number;
  /** Checks still failing (empty unless hidden). */
  issues: FitIssue[];
  /** Automatic corrections that were baked in (adjusted). */
  adjustments: string[];
  /** Checks that failed before the corrections. */
  before: FitIssue[];
  /**
   * T-213, what "ok" rests on: 'sampled' (this target was checked sample by sample) or 'source' (the identity fast path: the
   * motion plays exactly as on its reviewed source model, nothing was sampled here). Set by adaptMotion.
   */
  basis?: 'source' | 'sampled';
  /** T-213: standard and finger tracks that move in the source but bind to nothing here (the motion plays without them). */
  lost?: string[];
}

/**
 * The check's own version. Scores are stored per model (shared/motion-fit-record.ts): bump this whenever what a check flags
 * changes (a rule, a sample, an adjustment), so stored scores of the old check are scored again. The thresholds below are
 * also digested into the stored scores' stamp, so changing a number alone already invalidates them.
 * 2 (universal skeleton step 4): the 'contact' check (hands that should touch miss or pass through each other).
 */
export const MOTION_FIT_VERSION = 2;
export const FIT_SAMPLE_SECONDS = 0.25;
/** A check fails when at least this share of samples (and at least two) is flagged. */
export const FAIL_SHARE = 0.05;
/** Body proxy, in proportions of the model's own shoulder width / head size / arm and leg length. */
export const BODY = Object.freeze({
  torsoRadius: 0.27, // × shoulder width (arm joint to arm joint)
  headRadius: 0.3, // × head size (chin to crown)
  handLength: 0.6, // × forearm length, along the forearm past the wrist
  /** The limb's axis inside this share of the torso radius / head radius is penetration. */
  torsoDepth: 0.62,
  headDepth: 0.6,
  floating: 0.05, sinking: 0.05, // × leg length
  slidingHeight: 0.03, slidingSpeed: 0.35, // × leg length, × leg length per second
  reach: 1.03, translate: 0.3,
});
/**
 * Penetration with a fitted collision proxy (shared/collision-proxy.ts): the
 * limb's axis inside this share of a fitted capsule's radius, but never more
 * than `maxSink` shoulder widths under its surface (about an arm's thickness).
 * Without that cap a big capsule (a fat belly) would tolerate a whole buried
 * forearm. On Gene a clearance of 1 means the forearm axis is about 0.2 units
 * inside the real skinned surface (ray-cast check, docs/claude/2026-11-02-collision-proxy.md).
 */
export const FITTED_BODY = Object.freeze({ torsoDepth: 0.62, headDepth: 0.6, maxSink: 0.16 });
/** Degrees. Bends are the angle between consecutive segments; the rest are rotation from the bone's rest. */
/**
 * T-213: a re-hung body bone fails the structure check when its pivot drifts more than `pivot` head sizes from where the
 * source's hierarchy would carry it (the part comes off the body at the joint), or turns more than `degrees` away from the
 * way it would face. Codex's witness: a 20° neck turn with the head under the center moves the head 0.18 head sizes; the
 * neck's 2–3° share of a nod or a head tilt stays under both.
 */
export const STRUCTURE_TOLERANCE = Object.freeze({ pivot: 0.05, degrees: 10 });
export const JOINT_LIMITS: Readonly<Partial<Record<StandardBone | 'elbowBend' | 'kneeBend', number>>> = Object.freeze({
  elbowBend: 165, kneeBend: 165, neck: 85, head: 85, upperBody: 85, upperBody2: 85, lowerBody: 85, wristLeft: 110, wristRight: 110,
});

interface Body {
  torsoRadius: number; headRadius: number; headSize: number; legLength: number; height: number; shoulders: number;
  ankleRest: Partial<Record<'Left' | 'Right', number>>;
}
function bodyOf(rig: RetargetRig): Body {
  const shoulders = rig.shoulderWidth ?? rig.height * 0.13;
  const ankleRest: Body['ankleRest'] = {};
  for (const side of ['Left', 'Right'] as const) { const ankle = rig.slots[`ankle${side}`]; if (ankle !== undefined) ankleRest[side] = rig.bones[ankle].position[1]; }
  return { torsoRadius: shoulders * BODY.torsoRadius, headRadius: rig.headSize * BODY.headRadius, headSize: rig.headSize,
    legLength: rig.legLength ?? rig.height * 0.46, height: rig.height, shoulders, ankleRest };
}

/** Closest distance between segments p0-p1 and q0-q1. */
export function segmentDistance(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3): number {
  const d1 = vsub(p1, p0), d2 = vsub(q1, q0), r = vsub(p0, q0);
  const a = vdot(d1, d1), e = vdot(d2, d2), f = vdot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return vlength(r);
  if (a <= 1e-12) t = Math.min(1, Math.max(0, f / e));
  else {
    const c = vdot(d1, r);
    if (e <= 1e-12) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = vdot(d1, d2), denominator = a * e - b * b;
      s = denominator > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denominator)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return vlength(vsub(vadd(p0, vscale(d1, s)), vadd(q0, vscale(d2, t))));
}

interface Legs { ankle: Partial<Record<'Left' | 'Right', Vec3>>; knee: Partial<Record<'Left' | 'Right', Vec3>>; reach: Partial<Record<'Left' | 'Right', number>> }
/** Feet as the model will show them: its own leg IK re-solved toward the IK bones, else plain FK. */
function legs(rig: RetargetRig, pose: Pose, frame: number): Legs {
  const out: Legs = { ankle: {}, knee: {}, reach: {} };
  for (const side of ['Left', 'Right'] as const) {
    const leg = rig.slots[`leg${side}`], knee = rig.slots[`knee${side}`], ankle = rig.slots[`ankle${side}`];
    if (leg === undefined || knee === undefined || ankle === undefined) continue;
    if (rig.slots[`legIk${side}`] === undefined) { out.ankle[side] = pose.wp[ankle]; out.knee[side] = pose.wp[knee]; continue; }
    const target = ikTarget(rig, side, pose, undefined, frame)!;
    const parent = rig.bones[leg].parent, forward = qrotate(parent >= 0 ? pose.wq[parent] : [0, 0, 0, 1], [0, 0, 1]);
    const solved = solveTwoBone(pose.wp[leg], target, vlength(vsub(rig.bones[knee].position, rig.bones[leg].position)),
      vlength(vsub(rig.bones[ankle].position, rig.bones[knee].position)), forward);
    out.ankle[side] = solved.ankle; out.knee[side] = solved.knee; out.reach[side] = solved.reach;
  }
  return out;
}

/** Forearm (elbow→wrist) and hand (wrist→tip) as the penetration check sees them. */
interface ArmPoints { elbow: Vec3; wrist: Vec3; tip: Vec3 }
/** `depth`: the limb's axis closer than depth × radius to the capsule's axis is penetration. */
interface Capsule { segment: string; a: Vec3; b: Vec3; radius: number; depth: number }
/**
 * The body the arms are checked against, posed. With a fitted collision proxy
 * (model profile): its pelvis/abdomen/chest/neck capsules and its head capsule,
 * each carried by its own bone, and the hand reaching as far as the fitted hand
 * along the wrist. Without one: the rough approximation (one hip-to-neck
 * capsule of 0.27 shoulder widths, a head sphere, the hand 0.6 forearm past the
 * wrist), unchanged from before the proxy existed.
 */
interface BodyShape { fitted: boolean; torso: Capsule[]; head: Capsule | null }

const posed = (rig: RetargetRig, pose: Pose, bone: number, point: Readonly<Vec3>): Vec3 =>
  vadd(pose.wp[bone], qrotate(pose.wq[bone], vsub(point, rig.bones[bone].position)));
const fittedCapsule = (rig: RetargetRig, segment: ProxySegment) => rig.collision?.capsules.find(capsule => capsule.segment === segment && rig.slots[capsule.bone] !== undefined);
/** A fitted proxy is used when it covers the torso (and the head, if the rig has one); otherwise the whole check stays on the approximation. */
export function usesFittedBody(rig: RetargetRig): boolean {
  return !!rig.collision && TORSO_SEGMENTS.some(segment => fittedCapsule(rig, segment)) && (rig.slots.head === undefined || !!fittedCapsule(rig, 'head'));
}

function bodyShape(rig: RetargetRig, pose: Pose, sizes: Body): BodyShape {
  if (usesFittedBody(rig)) {
    const place = (segment: ProxySegment, depth: number): Capsule | null => {
      const capsule = fittedCapsule(rig, segment);
      if (!capsule) return null;
      const bone = rig.slots[capsule.bone]!;
      // The relative depth, capped at maxSink shoulder widths under the surface.
      const share = 1 - Math.min(1 - depth, FITTED_BODY.maxSink * sizes.shoulders / capsule.radius);
      return { segment, a: posed(rig, pose, bone, capsule.a), b: posed(rig, pose, bone, capsule.b), radius: capsule.radius, depth: share };
    };
    return { fitted: true, torso: TORSO_SEGMENTS.map(segment => place(segment, FITTED_BODY.torsoDepth)).filter((value): value is Capsule => !!value),
      head: place('head', FITTED_BODY.headDepth) };
  }
  const at = (slot: StandardBone) => { const index = rig.slots[slot]; return index === undefined ? null : pose.wp[index]; };
  const hipL = at('legLeft'), hipR = at('legRight'), neck = at('neck') ?? at('head');
  const bottom = hipL && hipR ? vscale(vadd(hipL, hipR), 0.5) : at('lowerBody') ?? at('center');
  const head = rig.slots.head;
  const centre = head === undefined ? null : vadd(pose.wp[head], qrotate(pose.wq[head], [0, rig.headSize * 0.45, 0]));
  return { fitted: false, torso: bottom && neck ? [{ segment: 'torso', a: bottom, b: neck, radius: sizes.torsoRadius, depth: BODY.torsoDepth }] : [],
    head: centre ? { segment: 'head', a: centre, b: centre, radius: sizes.headRadius, depth: BODY.headDepth } : null };
}

function armPoints(rig: RetargetRig, pose: Pose, side: 'Left' | 'Right', fitted: boolean): ArmPoints | null {
  const elbow = rig.slots[`elbow${side}`], wrist = rig.slots[`wrist${side}`];
  if (elbow === undefined || wrist === undefined) return null;
  const e = pose.wp[elbow], w = pose.wp[wrist];
  const hand = fitted ? fittedCapsule(rig, `hand${side}`) : undefined;
  if (!hand) return { elbow: e, wrist: w, tip: vadd(w, vscale(vsub(w, e), BODY.handLength)) };
  // The fitted hand's far end (its cap included), carried by the wrist: a bent wrist bends the hand.
  const rest = vsub(hand.b, hand.a), along = vlength(rest) > 1e-9 ? vnormalize(rest)
    : vnormalize(vsub(rig.bones[wrist].position, rig.bones[elbow].position));
  return { elbow: e, wrist: w, tip: posed(rig, pose, wrist, vadd(hand.b, vscale(along, hand.radius))) };
}

/** The closest capsule: arm axis distance over its radius (`ratio`) and its penetration depth; ratio < depth is penetration. */
interface Contact { ratio: number; depth: number; segment: string }
const NO_CONTACT: Contact = Object.freeze({ ratio: Infinity, depth: 1, segment: '' });
const clearOf = (contact: Contact, margin = 1) => contact.ratio >= contact.depth * margin;
/** Closest approach of the arm (forearm + hand) to the torso capsules and to the head, each relative to that capsule. */
function penetration(arm: ArmPoints, body: BodyShape): { torso: Contact; head: Contact } {
  let torso = NO_CONTACT, head = NO_CONTACT;
  const nearer = (current: Contact, capsule: Capsule, a: Vec3, b: Vec3): Contact => {
    const ratio = segmentDistance(a, b, capsule.a, capsule.b) / capsule.radius;
    return ratio / capsule.depth < current.ratio / current.depth ? { ratio, depth: capsule.depth, segment: capsule.segment } : current;
  };
  for (const [a, b] of [[arm.elbow, arm.wrist], [arm.wrist, arm.tip]] as const) {
    for (const capsule of body.torso) torso = nearer(torso, capsule, a, b);
    if (body.head) head = nearer(head, body.head, a, b);
  }
  return { torso, head };
}

/**
 * How clear each arm is of the body at one frame: the arm axis distance over
 * the capsule radius, divided by that capsule's penetration depth (below 1 is
 * flagged). Diagnostics and tests; the check itself uses the same numbers.
 */
export function armClearance(rig: RetargetRig, tracks: Tracks, frame: number): Partial<Record<'Left' | 'Right', { torso: number; head: number; segment: string; fitted: boolean }>> {
  const pose = evaluatePose(rig, tracks, frame), body = bodyShape(rig, pose, bodyOf(rig)), result: ReturnType<typeof armClearance> = {};
  for (const side of ['Left', 'Right'] as const) {
    const points = armPoints(rig, pose, side, body.fitted);
    if (!points || rig.slots[`arm${side}`] === undefined) continue;
    const contact = penetration(points, body);
    result[side] = { torso: contact.torso.ratio / contact.torso.depth, head: contact.head.ratio / contact.head.depth, segment: contact.torso.segment, fitted: body.fitted };
  }
  return result;
}

export interface FitSample { frame: number; flags: Partial<Record<FitCheck, { value: number; where: string }>> }
const bend = (a: Vec3, b: Vec3, c: Vec3) => {
  const u = vnormalize(vsub(b, a)), v = vnormalize(vsub(c, b));
  return Math.acos(Math.min(1, Math.max(-1, vdot(u, v)))) * 180 / Math.PI;
};
function flag(sample: FitSample, check: FitCheck, value: number, where: string) {
  const current = sample.flags[check];
  if (!current || value > current.value) sample.flags[check] = { value, where };
}

/** Sample frames: every 0.25 s from 0, and the last frame. */
export function fitFrames(lastFrame: number): number[] {
  const step = FIT_SAMPLE_SECONDS * 30, frames: number[] = [];
  for (let frame = 0; frame < lastFrame; frame += step) frames.push(frame);
  frames.push(lastFrame);
  return frames;
}

/** T-213: the target with its re-hung body bones put back where the source has them (structureReference), and which bones those are. */
export type StructureCheck = NonNullable<ReturnType<typeof structureReference>>;

/** Per-sample flags (worst value per check). `structure`: also measure how far re-hung bones drift (T-213). */
export function fitSamples(rig: RetargetRig, tracks: Tracks, lastFrame: number, structure?: StructureCheck | null): FitSample[] {
  const sizes = bodyOf(rig), samples: FitSample[] = [];
  let previous: Legs | null = null, previousFrame = 0;
  for (const frame of fitFrames(lastFrame)) {
    const pose = evaluatePose(rig, tracks, frame), sample: FitSample = { frame, flags: {} }, body = bodyShape(rig, pose, sizes), feet = legs(rig, pose, frame);
    if (structure) {
      // The bone here against the same bone re-hung where the source has it: how far its pivot drifts (head sizes), how far it turns.
      const reference = evaluatePose(structure.rig, tracks, frame);
      for (const { slot, index, difference } of structure.bones) {
        const drift = inHeads(vlength(vsub(pose.wp[index], reference.wp[index])), sizes.headSize);
        const turn = qangle(qmul(qconj(reference.wq[index]), pose.wq[index])) * 180 / Math.PI;
        if (drift > STRUCTURE_TOLERANCE.pivot || turn > STRUCTURE_TOLERANCE.degrees)
          flag(sample, 'structure', drift, `${slot} under ${difference.actual ?? 'root'}, not ${difference.expected ?? 'root'}`);
      }
    }
    for (const side of ['Left', 'Right'] as const) {
      const arm = rig.slots[`arm${side}`], elbow = rig.slots[`elbow${side}`], wrist = rig.slots[`wrist${side}`];
      if (arm === undefined || elbow === undefined || wrist === undefined) continue;
      const contact = penetration(armPoints(rig, pose, side, body.fitted)!, body);
      if (!clearOf(contact.torso)) flag(sample, 'penetration', 1 - contact.torso.ratio, `${side.toLowerCase()} arm into torso${body.fitted ? ` (${contact.torso.segment})` : ''}`);
      if (!clearOf(contact.head)) flag(sample, 'penetration', 1 - contact.head.ratio, `${side.toLowerCase()} hand into head`);
      const angle = bend(pose.wp[arm], pose.wp[elbow], pose.wp[wrist]);
      if (angle > JOINT_LIMITS.elbowBend!) flag(sample, 'joint-limit', angle - JOINT_LIMITS.elbowBend!, `elbow${side}`);
      // Wrist: how far the hand swings off the forearm line (a roll about the forearm is pronation, not a bend).
      const limit = JOINT_LIMITS[`wrist${side}`]!, line = vnormalize(vsub(rig.bones[wrist].position, rig.bones[elbow].position));
      const swing = Math.acos(Math.min(1, Math.max(-1, vdot(line, qrotate(pose.lq[wrist], line))))) * 180 / Math.PI;
      if (tracks.has(wrist) && swing > limit) flag(sample, 'joint-limit', swing - limit, `wrist${side}`);
    }
    for (const slot of ['neck', 'head', 'upperBody', 'upperBody2', 'lowerBody'] as const) {
      const index = rig.slots[slot], limit = JOINT_LIMITS[slot];
      if (index === undefined || limit === undefined || !tracks.has(index)) continue;
      const degrees = qangle(pose.lq[index]) * 180 / Math.PI;
      if (degrees > limit) flag(sample, 'joint-limit', degrees - limit, slot);
    }
    const heights: number[] = [];
    for (const side of ['Left', 'Right'] as const) {
      const ankle = feet.ankle[side], rest = sizes.ankleRest[side], knee = feet.knee[side], leg = rig.slots[`leg${side}`];
      if (!ankle || rest === undefined) continue;
      const height = (ankle[1] - rest) / sizes.legLength;
      heights.push(height);
      if (height < -BODY.sinking) flag(sample, 'sinking', -height, `foot${side}`);
      const reach = feet.reach[side];
      if (reach !== undefined && reach > BODY.reach) flag(sample, 'stretch', reach - 1, `leg${side} out of reach`);
      if (knee && leg !== undefined) { const angle = bend(pose.wp[leg], knee, ankle); if (angle > JOINT_LIMITS.kneeBend!) flag(sample, 'joint-limit', angle - JOINT_LIMITS.kneeBend!, `knee${side}`); }
      const before = previous?.ankle[side];
      if (before && rest !== undefined && (before[1] - rest) / sizes.legLength < BODY.slidingHeight && height < BODY.slidingHeight) {
        const speed = Math.hypot(ankle[0] - before[0], ankle[2] - before[2]) / sizes.legLength / ((frame - previousFrame) / 30);
        if (speed > BODY.slidingSpeed) flag(sample, 'sliding', speed, `foot${side}`);
      }
    }
    if (heights.length === 2 && Math.min(...heights) > BODY.floating) flag(sample, 'floating', Math.min(...heights), 'both feet');
    for (const [slot, index] of Object.entries(rig.slots) as [StandardBone, number][]) {
      if (/^(?:root|center|groove|legIk|toeIk)/.test(slot) || !tracks.has(index)) continue;
      const parent = rig.bones[index].parent;
      const segment = parent >= 0 ? vlength(vsub(rig.bones[index].position, rig.bones[parent].position)) : 0;
      const offset = vlength(sampleTrack(tracks.get(index)!, frame).p);
      if (segment > 0 && offset / segment > BODY.translate) flag(sample, 'stretch', offset / segment, slot);
    }
    samples.push(sample);
    previous = feet; previousFrame = frame;
  }
  return samples;
}

function failing(samples: FitSample[]): FitIssue[] {
  const minimum = Math.max(2, Math.ceil(samples.length * FAIL_SHARE)), issues: FitIssue[] = [];
  for (const check of ['penetration', 'floating', 'sinking', 'sliding', 'joint-limit', 'stretch', 'structure'] as FitCheck[]) {
    const flagged = samples.filter(sample => sample.flags[check]);
    if (flagged.length < minimum) continue;
    const worst = flagged.reduce((best, sample) => sample.flags[check]!.value > best.flags[check]!.value ? sample : best);
    issues.push({ check, samples: flagged.length, worst: Math.round(worst.flags[check]!.value * 1000) / 1000, where: worst.flags[check]!.where });
  }
  return issues;
}

/** Skeleton step 4: what the 'contact' check compares against: the source rig, the motion on it, and the motion's touches. */
export interface ContactCheck { source: RetargetRig; sourceTracks: Tracks; contact: MotionContact }

/** The 'contact' issue: each touch whose hands still miss (or pass through) each other, the worst in head sizes; null when all meet. */
function contactIssue(rig: RetargetRig, tracks: Tracks, check: ContactCheck): FitIssue | null {
  const misses = contactMisses(check.source, check.sourceTracks, rig, tracks, check.contact);
  if (!misses.length) return null;
  const worst = misses.reduce((best, miss) => miss.error > best.error ? miss : best);
  return { check: 'contact', samples: misses.length, worst: worst.error,
    where: `hands ${worst.kind === 'miss' ? 'miss each other' : 'pass through each other'} (${check.contact.parts.join(', ')})` };
}

/** Scores tracks without changing them. `contact`: also check the motion's touches (skeleton step 4). */
export function checkTracks(rig: RetargetRig, tracks: Tracks, lastFrame: number, structure?: StructureCheck | null, contact?: ContactCheck | null): { samples: number; issues: FitIssue[] } {
  const samples = fitSamples(rig, tracks, lastFrame, structure), issues = failing(samples), touch = contact ? contactIssue(rig, tracks, contact) : null;
  return { samples: samples.length, issues: touch ? [...issues, touch] : issues };
}

const MAX_ABDUCTION = 30 * Math.PI / 180, ABDUCTION_STEP = 2 * Math.PI / 180;
/** Eases each upper arm outward (about the chest's forward axis) just enough to clear the torso, smoothed over time and baked as keys. */
function easeArmsOut(rig: RetargetRig, tracks: Tracks, lastFrame: number): string[] {
  const sizes = bodyOf(rig), adjusted: string[] = [];
  const frames: number[] = [];
  for (let frame = 0; frame < lastFrame; frame += 2) frames.push(frame);
  frames.push(lastFrame);
  for (const side of ['Left', 'Right'] as const) {
    const arm = rig.slots[`arm${side}`], elbow = rig.slots[`elbow${side}`], wrist = rig.slots[`wrist${side}`];
    if (arm === undefined || elbow === undefined || wrist === undefined) continue;
    const chest = rig.slots.upperBody2 ?? rig.slots.upperBody, sign = side === 'Left' ? 1 : -1;
    const needed = frames.map(frame => {
      const pose = evaluatePose(rig, tracks, frame), body = bodyShape(rig, pose, sizes), points = armPoints(rig, pose, side, body.fitted)!;
      const pivot = pose.wp[arm], forward = qrotate(chest !== undefined ? pose.wq[chest] : [0, 0, 0, 1], [0, 0, 1]);
      for (let angle = 0; angle <= MAX_ABDUCTION + 1e-9; angle += ABDUCTION_STEP) {
        const turn = qaxisAngle(forward, sign * angle), move = (point: Vec3) => vadd(pivot, qrotate(turn, vsub(point, pivot)));
        const contact = penetration({ elbow: move(points.elbow), wrist: move(points.wrist), tip: move(points.tip) }, body);
        if (clearOf(contact.torso, 1.1) && clearOf(contact.head)) return angle;
      }
      return MAX_ABDUCTION;
    });
    if (!needed.some(angle => angle > 0)) continue;
    // Hold the peak a little around each need, then smooth, so the arm eases out and back instead of popping.
    const held = needed.map((_, k) => Math.max(...needed.slice(Math.max(0, k - 4), k + 5)));
    const smooth = held.map((_, k) => { const window = held.slice(Math.max(0, k - 4), k + 5); return window.reduce((a, b) => a + b, 0) / window.length; });
    const original = tracks.get(arm);
    const keys: TrackKey[] = frames.map((frame, k) => {
      const pose = evaluatePose(rig, tracks, frame), parent = rig.bones[arm].parent, parentQ: Quat = parent >= 0 ? pose.wq[parent] : [0, 0, 0, 1];
      const forward = qrotate(chest !== undefined ? pose.wq[chest] : [0, 0, 0, 1], [0, 0, 1]);
      const local = original ? sampleTrack(original, frame) : { p: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as Quat };
      const turn = qmul(qmul(qconj(parentQ), qaxisAngle(forward, sign * smooth[k])), parentQ);
      return { frame, p: local.p, q: qnormalize(qmul(turn, local.q)), interp: LINEAR_INTERPOLATION };
    });
    tracks.set(arm, keys);
    adjusted.push(`arm${side} eased out up to ${Math.round(Math.max(...smooth) * 180 / Math.PI)}°`);
  }
  return adjusted;
}

/**
 * Issues the target adds over how the motion already looks on its source model.
 * The library is reviewed on Gene, so an authored trait (a dance that lifts the
 * hips, a hand that rests on the chin) is not held against another model unless
 * it gets clearly worse there.
 */
export function newIssues(target: readonly FitIssue[], baseline: readonly FitIssue[] | undefined): FitIssue[] {
  return target.filter(issue => {
    const base = baseline?.find(entry => entry.check === issue.check);
    return !base || issue.samples > base.samples * 1.5 + 2;
  });
}

/**
 * Scores, auto-corrects penetration, and decides: ok (clean as converted),
 * adjusted (clean after a baked correction), hidden (still failing). May
 * replace arm tracks in `tracks` with corrected keys. `baseline` is the same
 * check on the source model (see newIssues).
 */
export function fitMotion(rig: RetargetRig, tracks: Tracks, lastFrame: number, baseline?: readonly FitIssue[], structure?: StructureCheck | null,
  contact?: ContactCheck | null): MotionFit {
  const first = checkTracks(rig, tracks, lastFrame, structure, contact), before = newIssues(first.issues, baseline);
  if (!before.length) return { status: 'ok', samples: first.samples, issues: [], adjustments: [], before: [] };
  let adjustments: string[] = [];
  if (before.some(issue => issue.check === 'penetration')) adjustments = easeArmsOut(rig, tracks, lastFrame);
  const remaining = adjustments.length ? newIssues(checkTracks(rig, tracks, lastFrame, structure, contact).issues, baseline) : before;
  return remaining.length
    ? { status: 'hidden', samples: first.samples, issues: remaining, adjustments, before }
    : { status: 'adjusted', samples: first.samples, issues: [], adjustments, before };
}

export interface AdaptedMotion<T extends VmdLike> {
  vmd: T; fit: MotionFit; report: RetargetReport;
  /** Skeleton step 4: what the contact fit did (largest hand move in head sizes); absent without a contact or on the identity path. */
  contact?: ContactFit | null;
}
/**
 * The whole step for one motion on one model: retarget, score against the
 * source baseline, correct, and write VMD data back. Identity plans return the
 * input object itself with an `ok` fit on the 'source' basis (the source model's
 * motions are reviewed; nothing is sampled here). T-213: a plan is the identity
 * only when the target's standard skeleton hangs like the source's, and this VMD
 * only when no finger track needs renaming (identityFor).
 * Skeleton step 4: `contact` (the library's annotation for this motion, shared/motion-contact.ts contactFor) moves the arms so
 * the hands meet as on the source, as part of the conversion, and adds the 'contact' check. Without it nothing changes.
 */
export function adaptMotion<T extends VmdLike>(vmd: T, plan: RetargetPlan, options: { contact?: MotionContact | null } = {}): AdaptedMotion<T> {
  const identity = identityFor(vmd, plan), touches = options.contact ?? null;
  if (identity && !touches) return sourceAsIs(vmd, plan);
  // Skeleton step 4: the contact fit runs right after the conversion. An identity plan only says every bone points and is named
  // as on the source (shoulders or arms of another width or length keep it the identity), so a motion whose hands touch is
  // converted and fitted too; it still plays as written when its hands already meet exactly as on the source.
  const result = retargetTracks(vmd, plan), sourceTracks = tracksOnRig(vmd, plan.source);
  const contact = touches ? fitContacts(plan.source, sourceTracks, plan.target, result.tracks, result.lastFrame, touches) : undefined;
  if (identity && !contact?.shift) return { ...sourceAsIs(vmd, plan), contact };
  const baseline = checkTracks(plan.source, sourceTracks, result.lastFrame).issues;
  const check = touches ? { source: plan.source, sourceTracks, contact: touches } : null;
  const reference = structureReference(plan);
  // A skeleton that hangs differently but cannot be compared (the re-hung reference would loop) is held back, never passed.
  const fit: MotionFit = plan.structure?.length && !reference
    ? { status: 'hidden', samples: 0, issues: plan.structure.map(row => ({ check: 'structure' as const, samples: 0, worst: 0,
      where: `${row.bone} under ${row.actual ?? 'root'}, not ${row.expected ?? 'root'} (not comparable)` })), adjustments: [], before: [] }
    : fitMotion(plan.target, result.tracks, result.lastFrame, baseline, reference, check);
  return { vmd: writeVmd(vmd, plan.target, result), fit: { ...fit, basis: 'sampled', lost: [...result.report.lost ?? []] }, report: result.report,
    ...(contact !== undefined ? { contact } : {}) };
}
/** The identity fast path: the input object itself, an `ok` fit on the 'source' basis (nothing sampled here). */
function sourceAsIs<T extends VmdLike>(vmd: T, plan: RetargetPlan): AdaptedMotion<T> {
  const { report } = retargetVmd(vmd, plan);
  return { vmd, fit: { status: 'ok', samples: 0, issues: [], adjustments: [], before: [], basis: 'source', lost: [...report.lost ?? lostByName(vmd, plan.source, plan.target)] }, report };
}
