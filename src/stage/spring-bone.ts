/**
 * R01 物理调参台, experimental: a spring-bone solver, an alternative to Ammo for one physics group. Idea borrowed, code our own (ACKNOWLEDGEMENTS.md: VRM SpringBone, "dynamic bone" chains): each
 * bone's tail is a point mass pulled back toward where the animation points it (a damped spring), lagging when its parent moves
 * (inertia), pulled down (gravity), kept at the bone's length, kept within an angle of the animated direction, and kept out of the
 * model's own body colliders; the bone then turns to point at the tail.
 *
 * - Every rendered frame, in substeps of at most 1/120 s, so 30 and 60 fps give the same motion.
 * - Inertia comes from her animated motion only. The tail is carried along with the bone's frame (so the joints above, swinging,
 *   carry it), and then lags by `inertia` of how far her animation moved that frame. Lagging on the solved motion as well made a
 *   long chain a whip: each joint's lag drove the next one's (the braid's tip flew up on a head turn).
 * - A long chain is a cascade of identical springs, each driven by the one above: with a damping ratio under ~0.7 every stage
 *   amplifies at resonance and a 50-joint braid blew up (measured). Joints below the first are kept at least that damped; the root
 *   keeps the knob's value, so the bounce still shows.
 * - Gravity scales with the spring and the bone, so a long chain of soft bones does not sag a little at every joint and coil.
 * - Collisions never push further than the animated pose already is (hair modelled lying on the back starts inside the shapes).
 * - Model space (the companion's scale changes nothing), its own solved transforms per joint (no scene-graph updates per bone), and it
 *   writes nothing: `output` holds each bone's local rotation from the animated pose to the solved one, for the physics layer.
 */
import { Euler, Matrix4, Quaternion, Vector3, type Bone, type SkinnedMesh } from "three";
import type { SpringBoneTuning } from "../../shared/stage/physics-tuning";

const MAX_SUBSTEP = 1 / 120;
const MAX_DT = 0.05;
const CHAIN_DAMPING_FLOOR = 0.75;
/** Below the first joint, a bone lags only this share of its own animated motion (the joints above already lag and carry it). */
const CHAIN_LAG = 0.15;

interface Collider { bone: Bone; offset: Vector3; rotation: Quaternion; radius: number; half: number }

interface Joint {
  bone: Bone;
  index: number;
  /** Nearest ancestor joint (its solved frame carries this bone), or -1. */
  ancestor: number;
  /** Tail in the bone's local space. */
  tail: Vector3;
  radius: number;
  position: Vector3;
  velocity: Vector3;
  valid: boolean;
  /** Last frame's base frame (after the joints above) and animated frame, model space. */
  previousBase: Matrix4;
  previousAnim: Matrix4;
  anim: Matrix4;
  solved: Matrix4;
}

/** Rotation from the animated pose to the solved one, per output bone (local, ready for the physics layer). */
export type SpringOutput = Map<number, Quaternion>;

export class SpringBoneChain {
  private readonly joints: Joint[] = [];
  private readonly colliders: Collider[] = [];
  private readonly inverse = new Matrix4();
  readonly output: SpringOutput = new Map();
  stepMs = 0;

  /**
   * `bones`: the group's output bones (any order). `bodies`: the loader's rigid bodies (a leaf bone's tail and each joint's hit
   * radius). `colliderBodies`: indices of kinematic bodies on other bones to collide with.
   */
  constructor(private readonly mesh: SkinnedMesh, bones: readonly number[], bodies: readonly Record<string, unknown>[], colliderBodies: readonly number[]) {
    const all = mesh.skeleton.bones;
    const depth = (bone: Bone) => { let d = 0, node = bone.parent; while (node && d < 512) { d++; node = node.parent; } return d; };
    const set = new Set(bones);
    const sorted = [...bones].filter(index => all[index]).sort((a, b) => depth(all[a]) - depth(all[b]) || a - b);
    const bodyOf = new Map<number, Record<string, unknown>>();
    for (const body of bodies) if (typeof body?.boneIndex === "number" && !bodyOf.has(body.boneIndex)) bodyOf.set(body.boneIndex, body);
    for (const index of sorted) {
      const bone = all[index];
      // The tail: the first child in the group, else any child, else the bone's own rigid body offset.
      const children = bone.children.filter((child): child is Bone => (child as Bone).isBone === true);
      const child = children.find(c => set.has(all.indexOf(c))) ?? children[0];
      const tail = new Vector3();
      if (child && child.position.lengthSq() > 1e-8) tail.copy(child.position);
      else {
        const position = bodyOf.get(index)?.position;
        if (Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)) tail.set(position[0], position[1], position[2]);
      }
      if (tail.lengthSq() < 1e-8) continue;
      let ancestor = -1;
      for (let node = bone.parent; node && ancestor < 0; node = node.parent) ancestor = this.joints.findIndex(joint => joint.bone === node);
      const width = Number(bodyOf.get(index)?.width);
      this.joints.push({ bone, index, ancestor, tail, radius: Number.isFinite(width) && width > 0 ? Math.min(width, tail.length()) : tail.length() * 0.25,
        position: new Vector3(), velocity: new Vector3(), valid: false, anim: new Matrix4(), solved: new Matrix4(), previousBase: new Matrix4(), previousAnim: new Matrix4() });
    }
    for (const index of colliderBodies) {
      const body = bodies[index];
      if (!body || body.type !== 0 || typeof body.boneIndex !== "number" || !all[body.boneIndex]) continue;
      const position = body.position as number[], rotation = body.rotation as number[];
      const w = Number(body.width), h = Number(body.height), d = Number(body.depth), shape = Number(body.shapeType);
      if (!Array.isArray(position) || !Array.isArray(rotation) || ![w, h, d].every(Number.isFinite)) continue;
      const q = new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2]));
      if (shape === 1) {
        // A box as a capsule along its longest axis with the middle extent as radius.
        const extents = [w, h, d], longest = extents.indexOf(Math.max(...extents)), sizes = [...extents].sort((a, b) => b - a);
        const axis = longest === 0 ? new Vector3(1, 0, 0) : longest === 2 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
        this.colliders.push({ bone: all[body.boneIndex], offset: new Vector3(...position), rotation: q.multiply(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis)),
          radius: sizes[1], half: Math.max(0, sizes[0] - sizes[1]) });
      } else this.colliders.push({ bone: all[body.boneIndex], offset: new Vector3(...position), rotation: q, radius: w, half: shape === 2 ? h / 2 : 0 });
    }
  }

  get size(): number { return this.joints.length; }

  /** Forget the motion (a pose jump, a rebuilt group): the next step starts from the animated pose with no velocity. */
  reset(): void { for (const joint of this.joints) joint.valid = false; }

  /**
   * One rendered frame. Bones must hold the final animated pose (their matrixWorld is refreshed here). Fills `output` with
   * base⁻¹ · solved per bone; writes no bone.
   */
  step(dt: number, settings: SpringBoneTuning): void {
    const started = performance.now();
    const delta = Math.min(MAX_DT, Math.max(0, dt));
    this.mesh.updateMatrixWorld(true);
    this.inverse.copy(this.mesh.matrixWorld).invert();
    const omega = 2 * Math.PI * (0.4 + 5.6 * settings.elastic), stiffness = omega * omega;
    const limit = settings.angleLimit * Math.PI / 180, inertia = settings.inertia;
    // At 1, a level bone settles about 27° below its direction.
    const gravityPerLength = 0.5 * settings.gravity * stiffness;
    const substeps = delta > 0 ? Math.max(1, Math.ceil(delta / MAX_SUBSTEP)) : 0, h = substeps ? delta / substeps : 0;
    const frame = new Matrix4(), relative = new Matrix4(), position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
    const head = new Vector3(), rest = new Vector3(), carried = new Vector3(), lag = new Vector3(), move = new Matrix4();
    const before = new Vector3(), from = new Vector3(), to = new Vector3(), turn = new Quaternion(), out = new Quaternion();
    for (const joint of this.joints) {
      joint.anim.multiplyMatrices(this.inverse, joint.bone.matrixWorld);
      // This bone's frame after the joints above it moved: their solved frame times the animated way down to this bone.
      if (joint.ancestor >= 0) {
        const above = this.joints[joint.ancestor];
        frame.multiplyMatrices(above.solved, relative.copy(above.anim).invert().multiply(joint.anim));
      } else frame.copy(joint.anim);
      frame.decompose(position, rotation, scale);
      head.copy(position);
      rest.copy(joint.tail).applyMatrix4(frame);
      const length = rest.distanceTo(head);
      if (!joint.valid || length < 1e-6) {
        joint.position.copy(rest); joint.velocity.set(0, 0, 0); joint.valid = length >= 1e-6;
      } else if (substeps) {
        // Carried with the bone's frame; then the animated motion's share of lag.
        carried.copy(joint.position).applyMatrix4(move.copy(joint.previousBase).invert()).applyMatrix4(frame);
        lag.copy(joint.position).sub(before.copy(joint.position).applyMatrix4(move.copy(joint.previousAnim).invert()).applyMatrix4(joint.anim));
        joint.position.copy(carried).addScaledVector(lag, joint.ancestor >= 0 ? inertia * CHAIN_LAG : inertia);
        joint.velocity.applyQuaternion(turn.setFromRotationMatrix(move.copy(joint.previousBase).invert().premultiply(frame)));
        const damping = 2 * (joint.ancestor >= 0 ? Math.max(CHAIN_DAMPING_FLOOR, settings.damping) : settings.damping) * omega;
        for (let i = 0; i < substeps; i++) {
          before.copy(joint.position);
          joint.velocity.addScaledVector(to.copy(rest).sub(joint.position), stiffness * h);
          joint.velocity.y -= gravityPerLength * length * h;
          joint.velocity.multiplyScalar(Math.exp(-damping * h));
          joint.position.addScaledVector(joint.velocity, h);
          this.constrain(joint, head, rest, length, limit);
          joint.velocity.copy(joint.position).sub(before).divideScalar(h);
        }
      }
      joint.previousBase.copy(frame); joint.previousAnim.copy(joint.anim);
      // Turn the bone so its tail points at the solved position.
      from.copy(rest).sub(head).normalize(); to.copy(joint.position).sub(head).normalize();
      turn.setFromUnitVectors(from, to);
      joint.solved.compose(position, out.copy(turn).multiply(rotation), scale);
      // Local delta: rotation⁻¹ · turn · rotation (the turn seen from the bone's own frame).
      const delta = this.output.get(joint.index) ?? new Quaternion();
      this.output.set(joint.index, delta.copy(rotation).invert().multiply(turn).multiply(rotation).normalize());
    }
    this.stepMs = performance.now() - started;
  }

  private constrain(joint: Joint, head: Vector3, rest: Vector3, length: number, limit: number): void {
    const direction = new Vector3().copy(joint.position).sub(head);
    if (direction.lengthSq() < 1e-12) direction.copy(rest).sub(head);
    direction.normalize();
    const restDirection = new Vector3().copy(rest).sub(head).normalize();
    const angle = restDirection.angleTo(direction);
    if (angle > limit && angle > 1e-6) {
      const axis = new Vector3().crossVectors(restDirection, direction);
      if (axis.lengthSq() > 1e-12) direction.copy(restDirection).applyAxisAngle(axis.normalize(), limit);
    }
    joint.position.copy(head).addScaledVector(direction, length);
    if (this.colliders.length && this.push(joint.position, joint.radius, rest)) {
      const back = direction.copy(joint.position).sub(head);
      if (back.lengthSq() > 1e-12) joint.position.copy(head).addScaledVector(back.normalize(), length);
    }
  }

  /** Out of the body colliders, but never further than the animated pose already is. True when it moved the point. */
  private push(point: Vector3, radius: number, rest: Vector3): boolean {
    const axis = new Vector3(), center = new Vector3(), nearest = new Vector3(), restNearest = new Vector3(), away = new Vector3();
    const bonePosition = new Vector3(), boneRotation = new Quaternion(), boneScale = new Vector3(), m = new Matrix4();
    let moved = false;
    for (const collider of this.colliders) {
      m.multiplyMatrices(this.inverse, collider.bone.matrixWorld).decompose(bonePosition, boneRotation, boneScale);
      center.copy(collider.offset).applyQuaternion(boneRotation).add(bonePosition);
      nearest.copy(center); restNearest.copy(center);
      if (collider.half > 0) {
        axis.set(0, 1, 0).applyQuaternion(collider.rotation).applyQuaternion(boneRotation);
        const along = (p: Vector3) => Math.max(-collider.half, Math.min(collider.half, axis.dot(away.copy(p).sub(center))));
        nearest.addScaledVector(axis, along(point));
        restNearest.addScaledVector(axis, along(rest));
      }
      away.copy(point).sub(nearest);
      const distance = away.length(), reach = Math.min(collider.radius + radius, rest.distanceTo(restNearest));
      if (distance < reach && distance > 1e-6) { point.copy(nearest).addScaledVector(away, reach / distance); moved = true; }
    }
    return moved;
  }
}
