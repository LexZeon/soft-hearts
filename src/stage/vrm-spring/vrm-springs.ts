/**
 * I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): a natively loaded VRM's hair and clothes move with her, from the model's own
 * spring-bone data. Our own solver: the VRM spec and other implementations were read for ideas only (ACKNOWLEDGEMENTS.md), no code
 * copied, no dependency.
 *
 * The spec's step, per joint: the tail keeps what is left of its last motion after drag, is pushed along the bone's animated direction
 * by stiffness and along gravityDir by gravityPower, is kept at the bone's length, kept out of colliders, and the bone turns to point at
 * it. Its numbers mean what they do at 60 steps a second (how authors tune them in UniVRM). Here they become a drag rate and two
 * accelerations, so any step size gives the same motion (exactly the spec's at 1/60 s), and every rendered frame runs fixed substeps
 * (quality: 1/60, 1/120, 1/240 s at most). Within a frame each substep sees her body (each chain's root and the colliders) part of the
 * way from last frame's pose to this one's, so 30 fps swings like 60.
 *
 * R29 rules (never jump, never freeze):
 *  - she is placed somewhere else (a jump of more than TELEPORT_M or a turn of more than 60° in one frame), or a frame comes after a gap
 *    (hidden, a stall): the chain is carried rigidly with its root, keeping its shape, so nothing whips across the screen; a gap also
 *    drops the motion it had;
 *  - a tail never spins round its head faster than MAX_SPIN (a safety bound: no explosion, whatever the input);
 *  - switched off, the chain eases back to its rest pose over FADE_SECONDS (and eases in when switched on), never a snap;
 *  - a chain that has been still for SLEEP_AFTER sleeps (no work) and wakes as soon as its root or a collider moves, from the pose shown.
 *
 * Switches (the companion's physics settings, shared/stage/model-physics.ts): hair (every chain that is not the bust: hair, coat,
 * skirt, ribbons) and chest (chains named for the bust), each with its strength, and the quality. Strength is how much she swings: the
 * share of her own motion the tails lag behind (1: the file's physics exactly; 0: they ride along rigidly); gravity, stiffness and
 * colliders always hold, so a weaker swing never puts the coat inside her legs.
 *
 * Order: after the pose transfer has written her bones (StandardBody.present); `frame(dt)` writes only the spring joints' own local
 * rotations and refreshes their world matrices.
 */
import { Quaternion, Vector3, type Bone, type Object3D } from 'three';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings, type ModelPhysicsSupport, type PhysicsQuality } from '../../../shared/stage/model-physics';
import type { LoadedModel } from '../model-adapter/types';
import { uiText } from '../../foundation/ui-language';
import { buildSpringRig, nearestOnSegment, type RigChain, type RigCollider, type RigJoint, type SpringPart, type SpringRig, type SpringRigOptions } from './spring-rig';

/** The spec's numbers mean what they do at this step. */
export const REFERENCE_STEP = 1 / 60;
export const MAX_SUBSTEP: Readonly<Record<PhysicsQuality, number>> = Object.freeze({ low: 1 / 60, standard: 1 / 120, high: 1 / 240 });
/** A frame longer than this is a gap: the chain is carried with her and its motion dropped. Frames up to it are simulated in full. */
export const GAP_SECONDS = 0.25;
/** A root moving further than this in one frame (file metres), or turning more than TELEPORT_TURN: she was placed, not moved. */
export const TELEPORT_M = 0.6;
export const TELEPORT_TURN = Math.PI / 3;
/** A tail's spin round its head, at most (rad/s): a bound, far above what her motion asks (a fast turn is about 6). */
export const MAX_SPIN = 25;
export const FADE_SECONDS = 0.4;
/** A starting chain settles this long (in steps, unseen) before it is shown. */
export const WARM_SECONDS = 1.5;
/** The soft layer outside her runtime body colliders (file metres): an incoming hem is braked to her leg's speed within it. */
export const CUSHION_M = 0.04;
const COLLIDE_PASSES = 4;
/** Still means: every tail slower than this relative to its head (file metres/s), and nothing that drives it moved. */
const SLEEP_SPEED = 0.003;
const SLEEP_AFTER = 0.6;
const STILL_M = 1e-5;
const STILL_TURN = 1e-5;

interface JointState {
  readonly rig: RigJoint;
  readonly tail: Vector3;
  readonly velocity: Vector3;
  /** Last substep's head and animated rotation (for the strength's ride-along share). */
  readonly headOld: Vector3;
  readonly animOld: Quaternion;
  /** The solved local rotation (written, blended by the fade). */
  readonly solvedLocal: Quaternion;
}
interface ChainState {
  readonly rig: RigChain;
  readonly joints: JointState[];
  readonly headPrev: Vector3;
  readonly headNow: Vector3;
  readonly parentPrev: Quaternion;
  readonly parentNow: Quaternion;
  valid: boolean;
  asleep: boolean;
  still: number;
  /** Its bones hold something other than their rest rotation. */
  written: boolean;
}
interface ColliderState { readonly rig: RigCollider; readonly aPrev: Vector3; readonly aNow: Vector3; readonly bPrev: Vector3; readonly bNow: Vector3; moved: boolean; valid: boolean }

const PARTS: readonly SpringPart[] = ['hair', 'chest'];
const scratch = { v: new Vector3(), w: new Vector3(), n: new Vector3(), dir: new Vector3(), rest: new Vector3(), head: new Vector3(), q: new Quaternion(),
  p: new Quaternion(), anim: new Quaternion(), turn: new Quaternion(), solved: new Quaternion(), a: new Vector3(), b: new Vector3(),
  toward: new Vector3(), legSpeed: new Vector3() };

export class VrmSpringPhysics {
  readonly rig: SpringRig;
  private readonly chains: ChainState[];
  private readonly colliders: ColliderState[];
  private settings: ModelPhysicsSettings = normalizeModelPhysicsSettings(undefined);
  private readonly blend: Record<SpringPart, number> = { hair: 0, chest: 0 };
  private visible = true;
  private resume = false;
  private disposed = false;
  /** Time spent in the last frame (ms) and the substeps it ran (for the numbers). */
  lastMs = 0;
  lastSubsteps = 0;

  /** `root`: the VRM's own object (model.object); its world scale is world units per file metre. */
  constructor(private readonly root: Object3D, rig: SpringRig) {
    this.rig = rig;
    this.colliders = rig.colliders.map(collider => ({ rig: collider, aPrev: new Vector3(), aNow: new Vector3(), bPrev: new Vector3(), bNow: new Vector3(), moved: false, valid: false }));
    this.chains = rig.chains.map(chain => ({ rig: chain, valid: false, asleep: false, still: 0, written: false,
      headPrev: new Vector3(), headNow: new Vector3(), parentPrev: new Quaternion(), parentNow: new Quaternion(),
      joints: chain.joints.map(joint => ({ rig: joint, tail: new Vector3(), velocity: new Vector3(), headOld: new Vector3(), animOld: new Quaternion(), solvedLocal: joint.restLocal.clone() })) }));
  }

  /** The springs of a loaded VRM (null when it has none). Build at rest: the body colliders' reach is measured from the rest pose. */
  static of(model: Pick<LoadedModel, 'physics' | 'bone' | 'object' | 'meshes'>, options: SpringRigOptions = {}): VrmSpringPhysics | null {
    const rig = buildSpringRig(model, options);
    return rig.chains.length ? new VrmSpringPhysics(model.object, rig) : null;
  }

  configure(settings: ModelPhysicsSettings): void { if (!this.disposed) this.settings = normalizeModelPhysicsSettings(settings, this.settings); }
  get currentSettings(): ModelPhysicsSettings { return structuredClone(this.settings); }

  /** What the control window's physics form shows for this model. */
  support(): ModelPhysicsSupport {
    const part = (name: SpringPart) => {
      const chains = this.rig.chains.filter(chain => chain.part === name), bones = chains.reduce((sum, chain) => sum + chain.joints.length, 0);
      const bodies = new Set(chains.flatMap(chain => chain.colliderIndices)).size;
      return { supported: bones > 0, bones, bodies, reason: bones > 0 ? null : name === 'hair' ? uiText('这个 VRM 没有头发或衣服的弹簧骨') : uiText('这个 VRM 没有胸部的弹簧骨') };
    };
    return { hair: part('hair'), chest: part('chest') };
  }

  private requested(part: SpringPart): boolean { const s = this.settings[part]; return s.enabled && s.strength > 0; }
  /** Some chain is switched on or still easing back. */
  get running(): boolean {
    return !this.disposed && PARTS.some(part => (this.blend[part] > 0 || this.requested(part)) && this.rig.chains.some(chain => chain.part === part));
  }
  /** Every chain asleep (nothing to compute) or nothing running. */
  get sleeping(): boolean { return !this.running || this.chains.every(chain => chain.asleep || this.blend[chain.rig.part] <= 0); }

  /** The bones it moves now (switched-on parts), for the frame pace (hair still swinging keeps the full pace). */
  bones(): readonly Bone[] {
    const key = `${this.requested('hair')}|${this.requested('chest')}`;
    if (this.bonesOf?.key !== key) this.bonesOf = { key, bones: this.chains.filter(chain => this.requested(chain.rig.part)).flatMap(chain => chain.joints.map(joint => joint.rig.bone)) };
    return this.bonesOf.bones;
  }
  private bonesOf: { key: string; bones: readonly Bone[] } | null = null;

  /** Nothing is drawn: no work; the next frame after showing again is a gap (carried, motion dropped). */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (!visible) this.resume = true;
  }

  /** One frame, after her pose is final. `dt` in seconds (0: no time passes, the shown pose is kept). */
  frame(dt: number): void {
    if (this.disposed || !this.visible || !(dt >= 0)) return;
    const started = performance.now();
    this.lastSubsteps = 0;
    for (const part of PARTS) this.blend[part] = this.requested(part) ? Math.min(1, this.blend[part] + dt / FADE_SECONDS) : Math.max(0, this.blend[part] - dt / FADE_SECONDS);
    if (!this.chains.some(chain => chain.written || this.blend[chain.rig.part] > 0)) { this.lastMs = 0; return; }
    this.root.updateWorldMatrix(true, true);
    const scale = this.root.matrixWorld.getMaxScaleOnAxis() || 1;
    const gap = this.resume || dt > GAP_SECONDS;
    this.resume = false;
    const step = Math.min(dt, GAP_SECONDS), h = MAX_SUBSTEP[this.settings.quality] ?? MAX_SUBSTEP.standard;
    this.readColliders(scale, gap);
    for (const chain of this.chains) {
      const part = chain.rig.part, blend = this.blend[part];
      if (blend <= 0) { if (chain.written) this.writeRest(chain); continue; }
      this.readRoot(chain);
      if (!chain.valid) this.warm(chain, h, scale);
      else if (gap || this.placed(chain, scale)) this.carry(chain, gap);
      const moved = chain.headNow.distanceTo(chain.headPrev) > STILL_M * scale || chain.parentNow.angleTo(chain.parentPrev) > STILL_TURN
        || chain.rig.colliderIndices.some(index => this.colliders[index].moved);
      if (chain.asleep && !moved && blend >= 1) { this.endFrame(chain); continue; }
      if (chain.asleep) { chain.asleep = false; this.seed(chain, true, scale); } // woken from the pose shown (the hierarchy carried it)
      let fastest = 0;
      if (step > 0 && !gap) {
        const count = Math.max(1, Math.ceil(step / h - 1e-9));
        fastest = this.simulate(chain, step, count, this.settings[part].strength, scale);
        this.lastSubsteps = Math.max(this.lastSubsteps, count);
      }
      this.write(chain, blend);
      chain.still = !moved && fastest < SLEEP_SPEED * scale && blend >= 1 && step > 0 ? chain.still + step : 0;
      if (chain.still >= SLEEP_AFTER) chain.asleep = true;
      this.endFrame(chain);
    }
    this.lastMs = performance.now() - started;
  }

  /** Back to the rest pose at once (a model leaving); the springs do nothing more. */
  dispose(): void {
    if (this.disposed) return;
    for (const chain of this.chains) if (chain.written) this.writeRest(chain);
    this.disposed = true;
  }

  // ---- the frame's inputs -----------------------------------------------------------------------------------------------------
  private readColliders(scale: number, gap: boolean): void {
    for (const collider of this.colliders) {
      const { bone, offset, tail } = collider.rig;
      collider.aPrev.copy(collider.aNow); collider.bPrev.copy(collider.bNow);
      collider.aNow.copy(offset).applyMatrix4(bone.matrixWorld);
      if (tail) collider.bNow.copy(tail).applyMatrix4(bone.matrixWorld);
      const jump = Math.max(collider.aNow.distanceTo(collider.aPrev), tail ? collider.bNow.distanceTo(collider.bPrev) : 0);
      if (!collider.valid || gap || jump > TELEPORT_M * scale) { collider.aPrev.copy(collider.aNow); collider.bPrev.copy(collider.bNow); collider.moved = collider.valid; collider.valid = true; }
      else collider.moved = jump > STILL_M * scale;
    }
  }
  private readRoot(chain: ChainState): void {
    const parent = chain.rig.rootParent;
    parent.matrixWorld.decompose(scratch.a, chain.parentNow, scratch.b); // matrices are current (refreshed at the frame's start, and by each chain written above)
    chain.headNow.copy(chain.rig.joints[0].bone.position).applyMatrix4(parent.matrixWorld);
  }
  private placed(chain: ChainState, scale: number): boolean {
    return chain.headNow.distanceTo(chain.headPrev) > TELEPORT_M * scale || chain.parentNow.angleTo(chain.parentPrev) > TELEPORT_TURN;
  }
  private endFrame(chain: ChainState): void { chain.headPrev.copy(chain.headNow); chain.parentPrev.copy(chain.parentNow); }

  /** Tails where the bones point now: at rest (`shown` false) or as last written (`shown`: woken, the hierarchy carried them); no motion. */
  private seed(chain: ChainState, shown: boolean, scale: number): void {
    const { head, p, anim } = scratch;
    p.copy(chain.parentNow); head.copy(chain.headNow);
    for (const joint of chain.joints) {
      const rig = joint.rig;
      if (!shown) joint.solvedLocal.copy(rig.restLocal);
      anim.copy(p).multiply(shown ? rig.bone.quaternion : rig.restLocal);
      joint.tail.copy(rig.axis).applyQuaternion(anim).multiplyScalar(rig.length * scale).add(head);
      joint.velocity.set(0, 0, 0); joint.headOld.copy(head); joint.animOld.copy(anim);
      if (shown) joint.solvedLocal.copy(rig.bone.quaternion);
      p.copy(anim); head.copy(joint.tail);
    }
    chain.headPrev.copy(chain.headNow); chain.parentPrev.copy(chain.parentNow);
    chain.valid = true; chain.still = 0;
  }

  /**
   * A chain starting (loaded, switched on): from its rest pose it settles where it hangs (gravity, colliders) in WARM_SECONDS of steps
   * with her held as she is, before anything is shown; what is shown then eases from the rest pose into it (the fade), never a drop.
   */
  private warm(chain: ChainState, h: number, scale: number): void {
    this.seed(chain, false, scale); // its root's last pose is this one: the steps below hold her still
    this.simulate(chain, WARM_SECONDS, Math.ceil(WARM_SECONDS / h - 1e-9), 1, scale);
    for (const joint of chain.joints) joint.velocity.set(0, 0, 0);
  }

  /** She was placed (or a gap passed): the chain rides rigidly with its root from last frame's pose to this one's, keeping its shape. */
  private carry(chain: ChainState, dropMotion: boolean): void {
    const turn = scratch.q.copy(chain.parentNow).multiply(scratch.p.copy(chain.parentPrev).invert());
    for (const joint of chain.joints) {
      joint.tail.sub(chain.headPrev).applyQuaternion(turn).add(chain.headNow);
      joint.headOld.sub(chain.headPrev).applyQuaternion(turn).add(chain.headNow);
      joint.animOld.premultiply(turn);
      if (dropMotion) joint.velocity.set(0, 0, 0); else joint.velocity.applyQuaternion(turn);
    }
    chain.headPrev.copy(chain.headNow); chain.parentPrev.copy(chain.parentNow);
  }

  // ---- the step -----------------------------------------------------------------------------------------------------------------
  /** `count` substeps over `dt`; returns the fastest tail speed relative to its head at the end (file metres/s, for sleeping). */
  private simulate(chain: ChainState, dt: number, count: number, swing: number, scale: number): number {
    const h = dt / count, ride = 1 - Math.min(1, Math.max(0, swing));
    const { head, p, anim, turn, solved, rest, dir, v, n, w } = scratch;
    let fastest = 0;
    for (let k = 1; k <= count; k++) {
      const alpha = k / count;
      head.lerpVectors(chain.headPrev, chain.headNow, alpha);
      p.slerpQuaternions(chain.parentPrev, chain.parentNow, alpha);
      for (let j = 0; j < chain.joints.length; j++) {
        const joint = chain.joints[j], rig = joint.rig, length = rig.length * scale;
        anim.copy(p).multiply(rig.restLocal);
        rest.copy(rig.axis).applyQuaternion(anim);
        if (ride > 0) {
          // The strength's share: this much of the head's own motion carries the tail along rigidly.
          w.copy(joint.tail).sub(joint.headOld).applyQuaternion(turn.copy(anim).multiply(solved.copy(joint.animOld).invert())).add(head);
          joint.tail.lerp(w, ride);
          joint.velocity.lerp(v.copy(joint.velocity).applyQuaternion(turn), ride);
        }
        const before = n.copy(joint.tail);
        // The spec's step as rates: drag per reference step, stiffness and gravity as the speed they add per reference step.
        joint.velocity.multiplyScalar(Math.pow(1 - rig.drag, h / REFERENCE_STEP));
        joint.velocity.addScaledVector(rest, rig.stiffness * scale * h / REFERENCE_STEP).addScaledVector(rig.gravityDir, rig.gravityPower * scale * h / REFERENCE_STEP);
        this.cushion(joint, alpha, h, dt, scale);
        joint.tail.addScaledVector(joint.velocity, h);
        keepLength(joint.tail, head, length, rest);
        // A bound on its spin round the head (relative to the head's own motion this substep); the colliders still have the last word.
        v.copy(joint.tail).sub(before).sub(dir.copy(head).sub(joint.headOld));
        const limit = MAX_SPIN * length * h, moved = v.length();
        if (moved > limit) { joint.tail.copy(before).add(dir).addScaledVector(v, limit / moved); keepLength(joint.tail, head, length, rest); }
        this.collide(joint, head, length, rest, alpha, dt, scale);
        const contact = this.contact, along = contact ? joint.velocity.dot(contact.normal) : 0; // its speed into the collider before the push
        joint.velocity.copy(joint.tail).sub(before).divideScalar(h);
        if (contact) {
          // Out of the collider at most as fast as it came in or the collider moves (no kick from the depth it was in).
          const out = joint.velocity.dot(contact.normal), limit = Math.max(along, contact.speed);
          if (out > limit) joint.velocity.addScaledVector(contact.normal, limit - out);
        }
        if (k === count) fastest = Math.max(fastest, v.copy(joint.tail).sub(before).sub(dir.copy(head).sub(joint.headOld)).length() / h / scale);
        if (![joint.tail.x, joint.tail.y, joint.tail.z].every(Number.isFinite)) { this.seed(chain, false, scale); return 0; }
        // Turn the bone to point at its tail.
        turn.setFromUnitVectors(rest, dir.copy(joint.tail).sub(head).normalize());
        solved.copy(turn).multiply(anim);
        joint.solvedLocal.copy(p).invert().multiply(solved).normalize();
        joint.headOld.copy(head); joint.animOld.copy(anim);
        p.copy(solved); head.copy(joint.tail);
      }
    }
    return fastest;
  }

  /**
   * Out of each collider (a runtime capsule no further than the rest pose allowed), then back to the bone's length; again while that
   * put it back in (COLLIDE_PASSES at most: a joint rooted inside a collider, as hair often is, needs a few to settle on the edge).
   */
  /**
   * Her runtime body colliders are soft on the outside (R29: a leg sweeping into the hem gives it her speed over a few frames, not in
   * one): within CUSHION_M outside the hard surface, never past where the tail rests, the tail's speed toward the leg (relative to the
   * leg's own) is taken away the faster the deeper it is. It never pushes out by itself, so a coat at rest stays as it hangs; the hard
   * surface (collide) still holds. The file's own colliders follow the spec (hard only).
   */
  private cushion(joint: JointState, alpha: number, h: number, dt: number, scale: number): void {
    const { a, b, w, toward, legSpeed } = scratch;
    for (const { index, reach, rest } of joint.rig.colliders) {
      const collider = this.colliders[index];
      if (rest === null || reach !== null || dt <= 0) continue;
      const capsule = collider.rig.tail !== null;
      a.lerpVectors(collider.aPrev, collider.aNow, alpha);
      if (capsule) b.lerpVectors(collider.bPrev, collider.bNow, alpha);
      nearestOnSegment(joint.tail, a, capsule ? b : null, w);
      const hard = (collider.rig.radiusM + joint.rig.hitRadius) * scale, outer = Math.min(hard + CUSHION_M * scale, rest * scale), away = joint.tail.distanceTo(w);
      if (away >= outer || away <= hard || away < 1e-9) continue;
      toward.copy(joint.tail).sub(w).divideScalar(away); // outward
      legSpeed.copy(collider.aNow).sub(collider.aPrev);
      if (capsule) legSpeed.add(w.copy(collider.bNow).sub(collider.bPrev)).multiplyScalar(0.5);
      const closing = legSpeed.dot(toward) / dt - joint.velocity.dot(toward); // how fast the gap closes
      if (closing <= 0) continue;
      // Brakes so the gap closes to nothing at the hard surface, starting gently at the cushion's edge: the closing speed follows
      // u² = u₀²·x(2 − x) over the share x of the cushion still left, so the braking is u²(1 − x)/(W·x(2 − x)) (0 at the edge).
      const width = outer - hard, x = (away - hard) / width;
      const braking = closing * closing * (1 - x) / (width * x * (2 - x));
      joint.velocity.addScaledVector(toward, Math.min(closing, braking * h));
    }
  }

  /**
   * The last contact's outward normal and the collider's own speed along it (world units/s), for the velocity after a push: the push
   * moves the tail out of the collider, but must not turn the depth it was in into speed (a hem kicked away from her leg at the depth
   * over one substep: 1 cm at 1/120 s is 1.2 m/s). null: no contact this substep.
   */
  private contact: { normal: Vector3; speed: number } | null = null;
  private readonly contactNormal = new Vector3();
  private readonly contactHit = { normal: this.contactNormal, speed: 0 };

  private collide(joint: JointState, head: Vector3, length: number, rest: Vector3, alpha: number, dt: number, scale: number): void {
    const { a, b, w, legSpeed } = scratch;
    this.contact = null;
    for (let pass = 0; pass < COLLIDE_PASSES; pass++) {
      let pushed = false;
      for (const { index, reach } of joint.rig.colliders) {
        const collider = this.colliders[index], capsule = collider.rig.tail !== null;
        a.lerpVectors(collider.aPrev, collider.aNow, alpha);
        if (capsule) b.lerpVectors(collider.bPrev, collider.bNow, alpha);
        nearestOnSegment(joint.tail, a, capsule ? b : null, w);
        const full = (collider.rig.radiusM + joint.rig.hitRadius) * scale, radius = reach === null ? full : Math.min(full, reach * scale);
        const away = joint.tail.distanceTo(w);
        if (away >= radius) continue;
        if (away > 1e-9) this.contactNormal.copy(joint.tail).sub(w).divideScalar(away); else this.contactNormal.copy(rest);
        joint.tail.copy(w).addScaledVector(this.contactNormal, radius);
        // The collider's speed at that point this frame (its ends' motion, averaged for a capsule).
        legSpeed.copy(collider.aNow).sub(collider.aPrev);
        if (capsule) legSpeed.add(w.copy(collider.bNow).sub(collider.bPrev)).multiplyScalar(0.5);
        this.contactHit.speed = dt > 0 ? legSpeed.dot(this.contactNormal) / dt : 0;
        this.contact = this.contactHit;
        pushed = true;
      }
      if (!pushed) return;
      keepLength(joint.tail, head, length, rest);
    }
  }

  // ---- writing --------------------------------------------------------------------------------------------------------------------
  private write(chain: ChainState, fade: number): void {
    const blend = fade * fade * (3 - 2 * fade); // eased: the fade starts and ends at rest speed
    for (const joint of chain.joints) {
      const bone = joint.rig.bone;
      if (blend >= 1) bone.quaternion.copy(joint.solvedLocal); else bone.quaternion.slerpQuaternions(joint.rig.restLocal, joint.solvedLocal, blend);
    }
    chain.written = true;
    chain.rig.joints[0].bone.updateMatrixWorld(true);
  }
  private writeRest(chain: ChainState): void {
    for (const joint of chain.joints) { joint.rig.bone.quaternion.copy(joint.rig.restLocal); joint.solvedLocal.copy(joint.rig.restLocal); }
    chain.written = false; chain.valid = false; chain.asleep = false; chain.still = 0;
    chain.rig.joints[0].bone.updateMatrixWorld(true);
  }
}

/** The tail back onto the sphere of the bone's length round its head (along the rest direction if it sits on the head). */
function keepLength(tail: Vector3, head: Vector3, length: number, rest: Vector3): void {
  const d = scratch.w.copy(tail).sub(head), distance = d.length();
  if (distance > 1e-9) tail.copy(head).addScaledVector(d, length / distance);
  else tail.copy(head).addScaledVector(rest, length);
}
