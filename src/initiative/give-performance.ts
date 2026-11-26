/**
 * I-086 她也照顾你, stage side (docs/claude/2026-11-11-i086-give-and-keep.md): her arm reaches toward you with a snack on her palm
 * (a small procedural cookie, or the very picture of a snack you fed her, a little rough like a polaroid), or her hand pushes the
 * cushion (sleep-props.ts's procedural pillow) over to the edge of the window toward you. A click on it = you took it; otherwise,
 * after the wait, she takes it back quietly.
 *
 * Motion rules (R29, how-we-work 「做事方式」 2), the same layer pattern as the game's raised hand (rps-performance.ts):
 *  - one program FK layer written after the mixer and the procedural layers, before motionTransition and the continuity guard;
 *    every bone is remembered first and restored by the stage next frame; nothing in the PMX/VMD changes;
 *  - presence (reach / back) and every prop movement are minimum-jerk segments from the current value, speed and acceleration:
 *    a take, a withdraw or an interruption mid-reach turns round smoothly; the arm's segment length comes from the pose difference
 *    and a peak angular acceleration (GIVE_MOTION.armAccel);
 *  - the hand-over: on a take the prop leaves toward you first and her arm follows back a beat later; on a withdraw the arm comes
 *    back with the prop and the prop tucks away (scale and opacity) in the last part of the way;
 *  - her face is an eased activity (a soft smile, eyes on you; playful: a small head tilt), blended over her own like the game's.
 * Bones: the right arm (else the left): 腕, ひじ, 手首, optional 手捩. No arm: only the prop and the face. Grant children follow.
 */
import {
  BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshLambertMaterial, MeshBasicMaterial, PlaneGeometry, Quaternion,
  SphereGeometry, SRGBColorSpace, Vector3, type Bone, type Camera, type Material, type Object3D, type SkinnedMesh,
} from 'three';
import type { LifeActivity } from '../stage';
import { MinJerk, alignTwo } from './rps-performance';
import { touchTargetRadius } from './touch-target';
import { pillowGeometry } from '../stage';
import type { PerformerArmAim } from './arm-aim';

export type GiveStagePhase = 'idle' | 'reach' | 'hold' | 'taken' | 'back';
export type GiveStageOutcome = 'taken' | 'not-taken' | 'interrupted';
export interface GiveStageCue {
  readonly id: string;
  readonly stage: 'hand' | 'push';
  readonly prop: 'snack' | 'pillow';
  readonly playful: boolean;
  /** The snack picture (a data URL) shown on the card in her hand; null: the procedural cookie. */
  readonly picture: string | null;
  /** How long she holds it out once it has arrived (ms). */
  readonly waitMs: number;
}

export const GIVE_MOTION = Object.freeze({
  /** Peak angular acceleration of the arm (°/s²) and the segment bounds (s). Slower than the game's: a gentle offer. */
  armAccel: 220, armMin: 0.7, armMax: 1.6,
  /** The cushion slides this long to the edge (s), starting this far into the reach (0..1 of the arm's way). */
  pushSeconds: 1.2, pushAfter: 0.45,
  /** After a push her hand comes back to her own pose while the cushion stays at the edge: the arm's share kept (0..1). */
  pushHold: 0,
  /** A take: the prop goes to you over this long (s); her arm starts back after this delay (s). */
  takeSeconds: 0.55, handBackDelay: 0.22,
  /** The prop appears over the first part of the reach and tucks away over the last part of the way back (shares of presence). */
  appearUntil: 0.4, tuckFrom: 0.45,
  faceOmega: 8,
});

// ---------------------------------------------------------------- the rig

interface Grant { child: Bone; parent: Bone; ratio: number }
export interface GiveRig {
  owner: SkinnedMesh; side: 'right' | 'left'; chest: Bone;
  upper: Bone | null; elbow: Bone | null; twist: Bone | null; wrist: Bone | null; grants: Grant[];
  restUpper: Vector3; restFore: Vector3; restHand: Vector3; restPalm: Vector3; restHinge: Vector3;
  /** Rest-space frame of her body: forward (toward the viewer), up, outward on the reaching side. */
  fwd: Vector3; up: Vector3; out: Vector3;
  handLength: number; height: number;
}

function findBone(bones: readonly Bone[], names: readonly string[]): Bone | null {
  for (const name of names) { const bone = bones.find(b => b.name === name); if (bone) return bone; }
  return null;
}
function restPositions(mesh: SkinnedMesh): Map<Bone, Vector3> {
  const out = new Map<Bone, Vector3>(), matrix = new Matrix4();
  mesh.skeleton.bones.forEach((bone, i) => {
    const inverse = mesh.skeleton.boneInverses[i];
    if (inverse) out.set(bone, new Vector3().setFromMatrixPosition(matrix.copy(inverse).invert()));
  });
  return out;
}
const horizontal = (v: Vector3) => { const out = v.clone(); out.y = 0; return out.lengthSq() > 1e-12 ? out.normalize() : out; };

export function buildGiveRig(mesh: SkinnedMesh): GiveRig | null {
  const bones = mesh.skeleton?.bones ?? [];
  const chest = findBone(bones, ['上半身2', '上半身', 'spine', 'Spine', 'Chest']);
  if (!chest) return null;
  const rest = restPositions(mesh);
  const pick = (prefix: string) => ({ upper: findBone(bones, [`${prefix}腕`]), elbow: findBone(bones, [`${prefix}ひじ`]), wrist: findBone(bones, [`${prefix}手首`]) });
  let side: 'right' | 'left' = 'right', arm = pick('右');
  if (!arm.upper || !arm.elbow || !arm.wrist) { const left = pick('左'); if (left.upper && left.elbow && left.wrist) { side = 'left'; arm = left; } }
  const prefix = side === 'right' ? '右' : '左', other = side === 'right' ? '左' : '右';
  const at = (bone: Bone | null) => bone ? rest.get(bone) ?? null : null;
  const up = new Vector3(0, 1, 0);
  const head = findBone(bones, ['頭']), eyes = [findBone(bones, ['左目']), findBone(bones, ['右目'])].filter((b): b is Bone => !!b && !!rest.get(b));
  let fwd = new Vector3(0, 0, 1);
  if (head && at(head) && eyes.length) {
    const mid = eyes.reduce((sum, eye) => sum.add(rest.get(eye)!), new Vector3()).divideScalar(eyes.length);
    const candidate = horizontal(mid.sub(at(head)!));
    if (candidate.lengthSq() > 0.5) fwd = candidate;
  }
  const otherUpper = findBone(bones, [`${other}腕`]);
  let out = side === 'right' ? fwd.clone().cross(up) : up.clone().cross(fwd);
  if (arm.upper && otherUpper && at(arm.upper) && at(otherUpper)) { const c = horizontal(at(arm.upper)!.clone().sub(at(otherUpper)!)); if (c.lengthSq() > 0.5) out = c; }
  let lowest = Infinity, highest = -Infinity;
  for (const p of rest.values()) { lowest = Math.min(lowest, p.y); highest = Math.max(highest, p.y); }
  const twist = findBone(bones, [`${prefix}手捩`]);
  const rig: GiveRig = { owner: mesh, side, chest, upper: arm.upper, elbow: arm.elbow, wrist: arm.wrist,
    twist: twist && arm.wrist?.parent === twist && twist.parent === arm.elbow ? twist : null, grants: [],
    restUpper: new Vector3(), restFore: new Vector3(), restHand: new Vector3(), restPalm: new Vector3(), restHinge: new Vector3(),
    fwd, up, out: out.normalize(), handLength: 1, height: Number.isFinite(highest - lowest) && highest > lowest ? highest - lowest : 20 };
  if (!arm.upper || !arm.elbow || !arm.wrist || !at(arm.upper) || !at(arm.elbow) || !at(arm.wrist)) { rig.upper = rig.elbow = rig.wrist = rig.twist = null; return rig; }
  const A = at(arm.upper)!, E = at(arm.elbow)!, W = at(arm.wrist)!;
  rig.restUpper.subVectors(E, A).normalize(); rig.restFore.subVectors(W, E).normalize();
  const finger = (name: string, n: number) => findBone(bones, [`${prefix}${name}${n}`, `${prefix}${name}${String.fromCharCode(0xff10 + n)}`]);
  const middle1 = finger('中指', 1), index1 = finger('人指', 1), little1 = finger('小指', 1);
  const handEnd = at(middle1) ?? at(findBone(bones, [`${prefix}手先`]));
  rig.restHand.copy(handEnd ? handEnd.clone().sub(W) : rig.restFore).normalize();
  const across = at(index1) && at(little1) ? at(index1)!.clone().sub(at(little1)!) : fwd.clone();
  rig.restPalm.crossVectors(across, rig.restHand).normalize();
  if (rig.restPalm.lengthSq() < 0.5) rig.restPalm.copy(up).multiplyScalar(-1);
  if (rig.restPalm.y > 0) rig.restPalm.negate();
  const flex = fwd.clone().addScaledVector(rig.restUpper, -fwd.dot(rig.restUpper)).normalize();
  rig.restHinge.crossVectors(rig.restUpper, flex).normalize();
  rig.handLength = handEnd ? Math.max(handEnd.distanceTo(W) * 2, 0.3 * E.distanceTo(W)) : 0.4 * E.distanceTo(W);
  const written = new Set<Bone>([arm.upper, arm.elbow, arm.wrist, ...(rig.twist ? [rig.twist] : [])]);
  const grants = (mesh.geometry?.userData?.MMD?.grants ?? []) as { index: number; parentIndex: number; ratio: number; affectRotation: boolean; isLocal: boolean }[];
  for (const grant of grants) {
    const child = bones[grant.index], parent = bones[grant.parentIndex];
    if (child && parent && grant.affectRotation && !grant.isLocal && written.has(parent) && !written.has(child) && Number.isFinite(grant.ratio))
      rig.grants.push({ child, parent, ratio: grant.ratio });
  }
  return rig;
}

/** The designed arm in rest space (chest frame): a palm-up offer toward you, or a lower push with the palm forward. */
export function giveDesign(rig: Pick<GiveRig, 'fwd' | 'up' | 'out'>, stage: 'hand' | 'push') {
  const { fwd, up, out } = rig, inward = out.clone().negate();
  const mix = (a: [Vector3, number][]) => a.reduce((sum, [v, k]) => sum.addScaledVector(v, k), new Vector3()).normalize();
  if (stage === 'push') {
    const upper = mix([[up, -0.86], [fwd, 0.42], [out, 0.26]]), fore = mix([[fwd, 0.86], [up, -0.36], [inward, 0.1]]), hand = mix([[fwd, 0.9], [up, 0.3]]);
    return { upper, fore, hand, palm: fwd.clone(), hinge: upper.clone().cross(fore.clone().addScaledVector(upper, -fore.dot(upper))).normalize() };
  }
  const upper = mix([[up, -0.64], [fwd, 0.7], [out, 0.2]]), fore = mix([[fwd, 0.9], [up, 0.32], [inward, 0.14]]), hand = mix([[fwd, 0.96], [up, 0.06], [inward, 0.05]]);
  return { upper, fore, hand, palm: up.clone(), hinge: upper.clone().cross(fore.clone().addScaledVector(upper, -fore.dot(upper))).normalize() };
}

// ---------------------------------------------------------------- the props

type Doc = { createElement(tag: 'canvas'): HTMLCanvasElement } | null;
const hasDocument = (): Doc => typeof document !== 'undefined' && typeof document.createElement === 'function' ? document : null;

/** A small warm cookie with a few dark chips (original geometry made here; no asset is read). */
function cookie(size: number): Group {
  const group = new Group();
  const dough = new MeshLambertMaterial({ color: 0xd8a465, transparent: true, opacity: 0 });
  const body = new Mesh(new CylinderGeometry(size, size * 0.96, size * 0.32, 24), dough);
  group.add(body);
  const chip = new MeshLambertMaterial({ color: 0x5a3622, transparent: true, opacity: 0 });
  for (const [x, z] of [[0.35, 0.2], [-0.3, 0.32], [0.05, -0.4], [-0.42, -0.15], [0.45, -0.3]]) {
    const dot = new Mesh(new SphereGeometry(size * 0.12, 8, 6), chip);
    dot.position.set(x * size, size * 0.16, z * size); dot.scale.y = 0.55;
    group.add(dot);
  }
  return group;
}

/** The picture of a snack you fed her, on a slightly crooked white card (a little rough: the feeling matters more than polish). */
function card(size: number, picture: string): Mesh {
  const material = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: DoubleSide });
  const mesh = new Mesh(new PlaneGeometry(size * 2, size * 2.3), material);
  const doc = hasDocument();
  if (doc && typeof Image !== 'undefined') {
    const canvas = doc.createElement('canvas'); canvas.width = 220; canvas.height = 253;
    const context = canvas.getContext('2d', { willReadFrequently: true }); // kept off the graphics card: a driver reset would blank it (src/stage/textures.ts)
    const image = new Image();
    image.onload = () => {
      if (!context) return;
      context.fillStyle = '#fffdf8'; context.fillRect(0, 0, 220, 253);
      const side = 196, scale = Math.max(side / image.width, side / image.height), w = image.width * scale, h = image.height * scale;
      context.save(); context.beginPath(); context.rect(12, 12, side, side); context.clip();
      context.drawImage(image, 12 + (side - w) / 2, 12 + (side - h) / 2, w, h); context.restore();
      context.strokeStyle = 'rgba(120, 90, 60, 0.25)'; context.lineWidth = 2; context.strokeRect(1, 1, 218, 251);
      const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
      material.map = texture; material.needsUpdate = true;
    };
    image.src = picture;
  }
  return mesh;
}

// ---------------------------------------------------------------- the face

type FaceValues = Required<Pick<LifeActivity, 'smileEyes' | 'mouthSmile' | 'lookUp' | 'headZ' | 'lidSoft'>>;
const FACE: Readonly<Record<'offer' | 'playful' | 'pleased' | 'fine', FaceValues>> = {
  offer: { smileEyes: 0.25, mouthSmile: 0.22, lookUp: 0.6, headZ: 0.015, lidSoft: 0.05 },
  playful: { smileEyes: 0.35, mouthSmile: 0.32, lookUp: 0.7, headZ: 0.045, lidSoft: 0 },
  pleased: { smileEyes: 0.45, mouthSmile: 0.4, lookUp: 0.6, headZ: 0.02, lidSoft: 0.06 },
  // Not taken: a calm little smile; no pout, no hurt (user rule: no guilt).
  fine: { smileEyes: 0.12, mouthSmile: 0.12, lookUp: 0.3, headZ: 0, lidSoft: 0.05 },
};
const FACE_KEYS = ['smileEyes', 'mouthSmile', 'lookUp', 'headZ', 'lidSoft'] as const;
const NEUTRAL: LifeActivity = Object.freeze({ gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0,
  sway: 1, bodyZ: 0, blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0, lookUp: 0 });

// ---------------------------------------------------------------- the layer

export interface GivePort { remember(bone: Bone): void }
export interface GivePerformanceState {
  active: boolean; phase: GiveStagePhase; id: string | null; presence: number; prop: number; push: number; fly: number; arm: boolean; side: string | null;
}

export class GivePerformance {
  private cueValue: GiveStageCue | null = null;
  private phaseValue: GiveStagePhase = 'idle';
  private readonly presence = new MinJerk();
  private readonly faceWeight = new MinJerk();
  /** The prop's own segments: shown (0..1), the cushion's way to the edge (0..1), a take's way to you (0..1). */
  private readonly shown = new MinJerk();
  private readonly push = new MinJerk();
  private readonly fly = new MinJerk();
  private rig: GiveRig | null = null;
  private rigOwner: SkinnedMesh | null = null;
  private holdClock = 0;
  private phaseClock = 0;
  private planned = false;
  private faceKind: keyof typeof FACE = 'offer';
  private faceValues: FaceValues = { ...FACE.fine, smileEyes: 0, mouthSmile: 0, lookUp: 0 };
  private faceSpeed: Record<string, number> = {};
  private readonly group = new Group();
  private propObject: Object3D | null = null;
  private propKind: string | null = null;
  private readonly materials: Material[] = [];
  private pushFrom = new Vector3(); private pushTo = new Vector3();
  private outcome: ((id: string, outcome: GiveStageOutcome) => void) | null = null;
  private readonly sq = new Quaternion(); private readonly sq2 = new Quaternion(); private readonly sq3 = new Quaternion(); private readonly sq4 = new Quaternion();
  private readonly sv = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly v1 = new Vector3(); private readonly v2 = new Vector3(); private readonly v3 = new Vector3(); private readonly v4 = new Vector3(); private readonly v5 = new Vector3();
  private readonly m1 = new Matrix4(); private readonly m2 = new Matrix4();
  private readonly base = new Map<Bone, Quaternion>();
  private readonly baseSet = new Set<Bone>();
  private activityOut: LifeActivity = { ...NEUTRAL };
  private design: ReturnType<typeof giveDesign> | null = null;

  constructor(private readonly parent: Object3D | null = null) {
    this.group.name = 'give-props';
    parent?.add(this.group);
  }

  get active(): boolean {
    return this.phaseValue !== 'idle' || this.presence.x > 1e-4 || this.faceWeight.x > 1e-4 || this.shown.x > 1e-4;
  }
  get phase(): GiveStagePhase { return this.phaseValue; }
  get id(): string | null { return this.cueValue?.id ?? null; }

  /** A new offer (the host's desk:give offer). An offer already on the stage is withdrawn first (as interrupted). */
  start(cue: GiveStageCue, onOutcome?: (id: string, outcome: GiveStageOutcome) => void): void {
    if (this.cueValue && this.phaseValue !== 'idle' && this.phaseValue !== 'back') this.end('interrupted');
    this.cueValue = { ...cue, waitMs: Math.max(1000, Math.min(60_000, Number.isFinite(cue.waitMs) ? cue.waitMs : 15_000)) };
    this.outcome = onOutcome ?? null;
    this.phaseValue = 'reach'; this.phaseClock = 0; this.holdClock = 0; this.planned = false;
    this.faceKind = cue.playful ? 'playful' : 'offer';
    this.fly.snap(0);
    this.makeProp(cue);
  }

  /** The user clicked what she holds out (only while it is out: reaching or held). */
  take(): boolean {
    if (!this.cueValue || (this.phaseValue !== 'hold' && this.phaseValue !== 'reach')) return false;
    if (this.shown.x < 0.5 && this.phaseValue === 'reach') return false;
    this.phaseValue = 'taken'; this.phaseClock = 0; this.planned = false; this.faceKind = 'pleased';
    this.report('taken');
    return true;
  }

  /** She takes it back: not taken in time (her own clock does that), or interrupted (a pat, a snack, hidden, the host's cancel). */
  withdraw(outcome: Exclude<GiveStageOutcome, 'taken'> = 'interrupted'): void {
    if (!this.cueValue || this.phaseValue === 'idle' || this.phaseValue === 'back' || this.phaseValue === 'taken') return;
    this.end(outcome);
  }

  private end(outcome: Exclude<GiveStageOutcome, 'taken'>): void {
    this.phaseValue = 'back'; this.phaseClock = 0; this.planned = false; this.faceKind = 'fine';
    this.report(outcome);
  }

  private report(outcome: GiveStageOutcome): void {
    const id = this.cueValue?.id, callback = this.outcome;
    this.outcome = null;
    if (id && callback) { try { callback(id, outcome); } catch { /* The stage carries on either way. */ } }
  }

  /** One display frame: clocks, segments and the prop's placement inputs. Call once per rendered frame before the writers. */
  frame(delta: number, owner: SkinnedMesh | null): void {
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    if (owner !== this.rigOwner) {
      // A different model (or none): nothing of the old one is carried over; an offer on the old model ends (interrupted).
      const replaced = this.rigOwner !== null;
      this.rigOwner = owner; this.rig = null; this.design = null; this.base.clear(); this.baseSet.clear();
      this.presence.snap(0); this.faceWeight.snap(0); this.shown.snap(0); this.push.snap(0); this.fly.snap(0);
      if (replaced && this.phaseValue !== 'idle') { this.report('interrupted'); this.phaseValue = 'idle'; this.cueValue = null; }
    }
    const cue = this.cueValue;
    if (cue && !this.rig && owner) { this.rig = buildGiveRig(owner); this.design = this.rig ? giveDesign(this.rig, cue.stage) : null; }
    if (cue && this.rig && this.design && this.designStage !== cue.stage) { this.design = giveDesign(this.rig, cue.stage); }
    this.designStage = cue?.stage ?? this.designStage;
    if (!this.planned) this.plan();
    this.phaseClock += dt;
    const push = cue?.stage === 'push';
    if (this.phaseValue === 'reach') {
      // The cushion starts sliding once the hand is part of the way; the arm then goes back, the cushion stays at the edge.
      if (push && this.push.goal < 1 && this.presence.x >= GIVE_MOTION.pushAfter) this.push.to(1, GIVE_MOTION.pushSeconds);
      const arrived = push ? this.push.goal === 1 && !this.push.moving : !this.presence.moving && this.presence.x > 0.999;
      if (push && this.push.goal === 1 && this.push.x > 0.85 && this.presence.goal !== GIVE_MOTION.pushHold) this.presence.to(GIVE_MOTION.pushHold, this.armSeconds());
      if (arrived) { this.phaseValue = 'hold'; this.phaseClock = 0; this.holdClock = 0; }
    } else if (this.phaseValue === 'hold') {
      this.holdClock += dt;
      if (cue && this.holdClock * 1000 >= cue.waitMs) this.end('not-taken');
    } else if (this.phaseValue === 'taken') {
      if (this.fly.goal !== 1) this.fly.to(1, GIVE_MOTION.takeSeconds);
      if (this.phaseClock >= GIVE_MOTION.handBackDelay && this.presence.goal !== 0) this.presence.to(0, this.armSeconds());
      if (this.fly.goal === 1 && !this.fly.moving && this.presence.x < 1e-4 && !this.presence.moving) this.finishIdle();
    } else if (this.phaseValue === 'back') {
      if (this.presence.x < 1e-4 && !this.presence.moving && (!push || (this.push.x < 1e-4 && !this.push.moving)) && this.shown.x < 1e-4 && !this.shown.moving) this.finishIdle();
    }
    this.presence.step(dt); this.faceWeight.step(dt); this.push.step(dt); this.fly.step(dt);
    // The prop: appears over the first part of the reach; on the way back it tucks away over the last part of the arm's way.
    const p = this.presence.x, arm = Math.min(1, p / GIVE_MOTION.appearUntil), pushed = push && this.push.x > 0 ? 1 : 0;
    const wantShown = this.phaseValue === 'reach' || this.phaseValue === 'hold' ? Math.max(arm, pushed)
      : this.phaseValue === 'taken' ? 1 - this.fly.x
        : this.phaseValue === 'back' ? Math.max(push ? this.push.x : 0, Math.min(1, Math.max(0, (p - 0.02) / GIVE_MOTION.tuckFrom))) : 0;
    this.followShown(Math.max(0, Math.min(1, wantShown)), dt);
    this.updateFace(dt);
  }
  private designStage: 'hand' | 'push' | null = null;
  private shownSpeed = 0;
  /** The prop's visibility follows its target by a critically damped spring: a target that changes at once still eases. */
  private followShown(target: number, dt: number): void {
    const omega = 14, x = this.shown.x, v = this.shownSpeed, e = x - target, decay = Math.exp(-omega * dt), carry = v + omega * e;
    this.shownSpeed = (v - omega * carry * dt) * decay;
    let next = target + (e + carry * dt) * decay;
    if (Math.abs(next - target) < 2e-3 && Math.abs(this.shownSpeed) < 0.02) { next = target; this.shownSpeed = 0; }
    this.shown.snap(Math.max(0, Math.min(1, next)));
  }

  private plan(): void {
    this.planned = true;
    const cue = this.cueValue, push = cue?.stage === 'push';
    if (this.phaseValue === 'reach') {
      this.presence.to(1, this.armSeconds());
      this.faceWeight.to(1, 0.6);
      if (push) this.push.to(this.push.x, 0.01);
    } else if (this.phaseValue === 'back') {
      if (this.presence.goal !== 0 || this.presence.x > 0) this.presence.to(0, this.armSeconds());
      if (push) this.push.to(0, GIVE_MOTION.pushSeconds);
      this.faceWeight.to(0, 1.4);
    } else if (this.phaseValue === 'taken') {
      this.faceWeight.to(1, 0.4);
      if (push) this.push.to(1, 0.01);
    }
    if (this.phaseValue === 'taken') { /* the face eases out with finishIdle's own segment */ }
  }

  private finishIdle(): void {
    this.phaseValue = 'idle'; this.cueValue = null; this.planned = true;
    if (this.faceWeight.goal !== 0) this.faceWeight.to(0, 1.2);
    this.push.snap(0); this.fly.snap(0);
  }

  private armSeconds(): number {
    const rig = this.rig, design = this.design;
    const span = rig && design ? (rig.restUpper.angleTo(design.upper) + design.upper.angleTo(design.fore)) * 180 / Math.PI : 70;
    return Math.min(GIVE_MOTION.armMax, Math.max(GIVE_MOTION.armMin, Math.sqrt(5.77 * span / GIVE_MOTION.armAccel)));
  }

  private updateFace(dt: number): void {
    const target = FACE[this.faceKind], omega = GIVE_MOTION.faceOmega;
    for (const key of FACE_KEYS) {
      const x = this.faceValues[key], v = this.faceSpeed[key] ?? 0, e = x - target[key], decay = Math.exp(-omega * dt), carry = v + omega * e;
      this.faceSpeed[key] = (v - omega * carry * dt) * decay;
      this.faceValues[key] = target[key] + (e + carry * dt) * decay;
    }
  }

  /** Her face during the offer, blended over her own activity by the face weight. */
  activity(base: LifeActivity | null): LifeActivity | null {
    const w = this.faceWeight.x;
    if (!(w > 1e-4)) return base;
    const from = base ?? NEUTRAL, out = this.activityOut, f = this.faceValues;
    Object.assign(out, from);
    const mix = (a: number, b: number) => a + (b - a) * w;
    out.smileEyes = mix(from.smileEyes, f.smileEyes); out.mouthSmile = mix(from.mouthSmile, f.mouthSmile); out.lookUp = mix(from.lookUp, f.lookUp);
    out.headZ = mix(from.headZ, f.headZ); out.lidSoft = mix(from.lidSoft, f.lidSoft);
    out.lookAtUser = mix(from.lookAtUser, 1.6); out.pointerFollow = mix(from.pointerFollow, 0.6); out.saccade = mix(from.saccade, 0.7);
    out.gazeX = mix(from.gazeX, 0); out.headX = mix(from.headX, 0); out.headY = mix(from.headY, 0);
    return out;
  }

  /** Writes the arm (program layer: every bone remembered first, restored by the stage next frame). */
  applyPose(port: GivePort): void {
    const w = this.presence.x, rig = this.rig, design = this.design;
    if (!(w > 1e-5) || !rig || !design || rig.owner !== this.rigOwner || !rig.upper || !rig.elbow || !rig.wrist) return;
    const { upper, elbow, wrist } = rig;
    this.baseSet.clear();
    const chestQ = rig.chest.getWorldQuaternion(this.sq);
    const U = this.v1.copy(design.upper).applyQuaternion(chestQ), K = this.v2.copy(design.hinge).applyQuaternion(chestQ);
    const F = this.v3.copy(design.fore).applyQuaternion(chestQ), H = this.v4.copy(design.hand).applyQuaternion(chestQ), P = this.v5.copy(design.palm).applyQuaternion(chestQ);
    const parentQ = upper.parent ? upper.parent.getWorldQuaternion(this.sq3) : this.sq3.identity();
    this.write(port, upper, parentQ.invert().multiply(alignTwo(rig.restUpper, rig.restHinge, U, K, this.sq4, this.m1, this.m2, this.sv)), w);
    const elbowParent = elbow.parent ? elbow.parent.getWorldQuaternion(this.sq3) : this.sq3.identity();
    const local = this.sv[0].copy(F).applyQuaternion(elbowParent.invert());
    this.write(port, elbow, this.sq4.setFromUnitVectors(rig.restFore, local.normalize()), w);
    const handWorld = alignTwo(rig.restHand, rig.restPalm, H, P, this.sq2, this.m1, this.m2, this.sv);
    if (rig.twist) {
      const relative = elbow.getWorldQuaternion(this.sq3).invert().multiply(handWorld);
      const axis = rig.restFore, dot = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
      const twist = this.sq4.set(axis.x * dot, axis.y * dot, axis.z * dot, relative.w);
      if (twist.lengthSq() < 1e-9) twist.identity(); else twist.normalize();
      this.write(port, rig.twist, twist, w);
      this.write(port, wrist, this.sq2.copy(twist).invert().multiply(relative), w);
    } else {
      const wristParent = wrist.parent ? wrist.parent.getWorldQuaternion(this.sq3) : this.sq3.identity();
      this.write(port, wrist, wristParent.invert().multiply(handWorld), w);
    }
    for (const grant of rig.grants) {
      const before = this.baseSet.has(grant.parent) ? this.base.get(grant.parent) : undefined;
      if (!before) continue;
      port.remember(grant.child);
      const old = this.sq2.identity().slerp(before, grant.ratio).invert(), now = this.sq3.identity().slerp(grant.parent.quaternion, grant.ratio);
      grant.child.quaternion.multiply(old).multiply(now);
    }
  }

  /** I-154 batch 4 (arm-aim.ts): the offered arm as applyPose writes it, as a design for the window engine's arm reach; null while down. */
  armAim(): PerformerArmAim | null {
    const w = this.presence.x, rig = this.rig, design = this.design;
    if (!(w > 1e-5) || !rig || !design || rig.owner !== this.rigOwner || !rig.upper || !rig.elbow || !rig.wrist) return null;
    return { side: rig.side, weight: w, upper: design.upper.clone(), fore: design.fore.clone(), hand: design.hand.clone(), palm: design.palm.clone(), fingers: null };
  }

  private write(port: GivePort, bone: Bone, target: Quaternion, weight: number): void {
    port.remember(bone);
    if (!this.baseSet.has(bone)) {
      let saved = this.base.get(bone);
      if (!saved) this.base.set(bone, saved = new Quaternion());
      saved.copy(bone.quaternion); this.baseSet.add(bone);
    }
    bone.quaternion.slerp(target, Math.min(1, Math.max(0, weight)));
  }

  private makeProp(cue: GiveStageCue): void {
    const kind = cue.prop === 'pillow' ? 'pillow' : cue.picture ? `card:${cue.picture.length}:${cue.picture.slice(-24)}` : 'cookie';
    if (kind === this.propKind && this.propObject) return;
    this.disposeProp();
    const height = this.rig?.height ?? 20, size = height * 0.035;
    let object: Object3D;
    if (cue.prop === 'pillow') {
      const material = new MeshLambertMaterial({ color: 0xf3e3d3, transparent: true, opacity: 0 });
      object = new Mesh(pillowGeometry(height * 0.2, height * 0.13, height * 0.065), material);
    } else object = cue.picture ? card(size * 1.3, cue.picture) : cookie(size);
    object.name = `give-${cue.prop}`;
    object.visible = false;
    object.traverse(child => { const m = (child as Mesh).material as Material | undefined; if (m) this.materials.push(m); (child as Mesh).renderOrder = 2; });
    this.group.add(object);
    this.propObject = object; this.propKind = kind;
  }

  /**
   * Places the prop for this frame (after the pose is final, right before the render): in her hand, on the card facing you, or the
   * cushion on its way between her and the edge. Opacity and scale follow `shown`; a take moves it toward the camera.
   */
  place(camera: Camera | null): void {
    const object = this.propObject, cue = this.cueValue, rig = this.rig, shown = this.shown.x;
    if (!object) return;
    object.visible = shown > 0.002;
    for (const m of this.materials) { (m as MeshLambertMaterial).opacity = shown; m.transparent = shown < 0.999; }
    if (!object.visible || !rig) return;
    const height = rig.height, target = this.v1;
    const cameraPos = camera ? camera.getWorldPosition(this.v2) : null;
    if (object.name === 'give-pillow') {
      if (this.pushFrom.lengthSq() === 0 || this.phaseValue === 'reach' && this.push.x < 1e-3) this.pushEnds(camera);
      target.lerpVectors(this.pushFrom, this.pushTo, this.push.x);
      object.quaternion.identity();
    } else if (rig.wrist) {
      rig.wrist.getWorldPosition(target);
      const chestQ = rig.chest.getWorldQuaternion(this.sq);
      const hand = this.v3.copy(rig.fwd).applyQuaternion(chestQ), up = this.v4.copy(rig.up).applyQuaternion(chestQ);
      target.addScaledVector(hand, rig.handLength * 0.55).addScaledVector(up, height * (object.name === 'give-snack' && cue?.picture ? 0.045 : 0.012));
      if (cameraPos && object instanceof Mesh && object.geometry instanceof PlaneGeometry) {
        object.lookAt(cameraPos); object.rotateZ(0.09);
      } else object.quaternion.copy(chestQ);
    }
    if (this.fly.x > 0 && cameraPos) target.lerp(cameraPos, this.fly.x * 0.45);
    object.position.copy(target);
    if (object.parent) object.parent.worldToLocal(object.position);
    const s = 0.6 + 0.4 * Math.min(1, shown * 1.3) + this.fly.x * 0.5;
    object.scale.setScalar(s);
  }

  private pushEnds(camera: Camera | null): void {
    const rig = this.rig!;
    const chest = rig.chest.getWorldPosition(this.v5), height = rig.height;
    const chestQ = rig.chest.getWorldQuaternion(this.sq);
    let toward = this.v3.copy(rig.fwd).applyQuaternion(chestQ);
    if (camera) { const c = camera.getWorldPosition(this.v4).sub(chest); c.y = 0; if (c.lengthSq() > 1e-6) toward = this.v3.copy(c.normalize()); }
    const side = this.v4.copy(rig.out).applyQuaternion(chestQ);
    this.pushFrom.copy(chest).addScaledVector(toward, height * 0.16).addScaledVector(side, height * 0.06).y -= height * 0.3;
    this.pushTo.copy(chest).addScaledVector(toward, height * 0.42).addScaledVector(side, height * 0.2).y -= height * 0.42;
  }

  /** Where the prop is on screen (the click target), or null while it is not out. */
  anchor(camera: Camera | null, width: number, height: number): { x: number; y: number; r: number } | null {
    const object = this.propObject;
    if (!camera || !object?.visible || !(this.shown.x > 0.6) || (this.phaseValue !== 'reach' && this.phaseValue !== 'hold')) return null;
    const center = object.getWorldPosition(this.sv[1]), edge = this.sv[2].copy(center);
    const size = (this.rig?.height ?? 20) * (object.name === 'give-pillow' ? 0.11 : 0.06);
    edge.y += size;
    center.project(camera); edge.project(camera);
    if (![center.x, center.y, edge.y].every(Number.isFinite) || center.z < -1 || center.z > 1) return null;
    const x = (center.x + 1) * width / 2, y = (1 - center.y) * height / 2, r = touchTargetRadius(Math.abs(edge.y - center.y) * height / 2 * 1.3, width, height, 28);
    return { x, y, r };
  }

  getState(): GivePerformanceState {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return { active: this.active, phase: this.phaseValue, id: this.cueValue?.id ?? null, presence: round(this.presence.x), prop: round(this.shown.x), push: round(this.push.x),
      fly: round(this.fly.x), arm: !!this.rig?.upper, side: this.rig?.side ?? null };
  }

  /** Corners of the shown prop in world space (the stray-pixel sentinel's reach must include it). */
  corners(): { x: number; y: number; z: number }[] {
    const object = this.propObject;
    if (!object?.visible) return [];
    const out: { x: number; y: number; z: number }[] = [];
    object.updateMatrixWorld(true);
    object.traverse(child => {
      const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
      if (!geometry) return;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!, e = child.matrixWorld.elements;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
        out.push({ x: e[0] * x + e[4] * y + e[8] * z + e[12], y: e[1] * x + e[5] * y + e[9] * z + e[13], z: e[2] * x + e[6] * y + e[10] * z + e[14] });
    });
    return out;
  }

  private disposeProp(): void {
    const object = this.propObject;
    if (!object) return;
    this.group.remove(object);
    object.traverse(child => { (child as Mesh).geometry?.dispose?.(); });
    for (const m of this.materials) { (m as MeshBasicMaterial).map?.dispose?.(); m.dispose(); }
    this.materials.length = 0;
    this.propObject = null; this.propKind = null; this.pushFrom.set(0, 0, 0);
  }

  dispose(): void { this.disposeProp(); this.parent?.remove(this.group); }

  /** Test seam. */
  rigForTest(): GiveRig | null { return this.rig; }
}
