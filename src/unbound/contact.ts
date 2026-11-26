/**
 * Unbound U1 part 2: her feet on her floor (docs/claude/2026-11-12-unbound-u1-part2.md).
 *
 * The model's own leg IK does the bending: each foot's 足ＩＫ target is put where the gait (gait.ts, the one owner of contact)
 * says the ankle is, with the foot's yaw, and its つま先ＩＫ at rest under it (the foot flat on the floor). This module is the
 * only writer of those targets, and it writes them last: after the motion, the dynamics residuals, her place and the centre
 * offsets, right before the IK and grant solve. Nothing writes a leg after the solve (only hair/chest physics, which leave the
 * legs alone). Codex c228 §4: "IK 之后还会有 root/骨骼写入，所以需要'最终接触约束'合同".
 *
 * Also here: finding the bones (MMD names first, then common English), the COM proxy (balance.ts segments), and the reach
 * guard (if a hip ends up farther from its ankle target than the straight leg, the hips come down by just that much, smoothly,
 * instead of the foot coming off its point).
 */
import { Bone, Quaternion, Vector3, type SkinnedMesh } from 'three';
import { COM_SEGMENTS, centerOfMass, type FootSize, type Point2 } from './balance';
import type { FootState, GaitBody } from './gait';
import { figureBone } from './model/figure-bones';

interface Solver { update(): unknown }
/** The usual MMD knee range about its hinge (radians; Gene's own limits are −0.17..2.88). */
const KNEE_MIN = -0.17, KNEE_MAX = 2.88;
const AXIS_X = new Vector3(1, 0, 0);
export interface LegBones { ik: Bone; toeIk: Bone | null; hip: Bone; knee: Bone; ankle: Bone; toe: Bone | null }

/** Exact names first, then the standard part they stand for (I-152 step 2, model/figure-bones.ts). */
const byName = (mesh: SkinnedMesh, names: readonly string[]) => figureBone(mesh, names);
const LEG_NAMES = (side: '左' | '右') => ({
  ik: [`${side}足ＩＫ`, `${side}足IK`], toeIk: [`${side}つま先ＩＫ`, `${side}つま先IK`],
  hip: [`${side}足`], knee: [`${side}ひざ`], ankle: [`${side}足首`], toe: [`${side}足先`, `${side}つま先`],
});

/** Where the bones she stands with are, and the COM proxy. null when the model has no MMD leg IK (she then cannot plant). */
export class BodyRig {
  readonly legs: readonly [LegBones, LegBones];
  readonly center: Bone | null;
  private readonly segments: { a: Bone; b: Bone; share: number }[];
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  /** Leg geometry from the bind pose (mesh-local units): the straight leg, the ankle's and hip's heights, the foot's length. */
  private readonly rest: { legLength: number; ankleY: number; hipY: number; toeLength: number | null };

  private constructor(readonly mesh: SkinnedMesh, legs: [LegBones, LegBones], center: Bone | null) {
    this.legs = legs; this.center = center;
    this.segments = COM_SEGMENTS.flatMap(s => {
      const a = byName(mesh, s.from), b = byName(mesh, s.to);
      return a && b && a !== b ? [{ a, b, share: s.share }] : [];
    });
    // Measured once, before any motion has played (find() is called on the freshly loaded mesh).
    mesh.updateMatrixWorld(true);
    const local = (bone: Bone) => mesh.worldToLocal(bone.getWorldPosition(new Vector3()));
    const ankle = local(legs[0].ankle), hip = local(legs[0].hip);
    const toe = legs[0].toeIk ? local(legs[0].toeIk) : legs[0].toe ? local(legs[0].toe) : null;
    this.rest = {
      legLength: Math.min(...legs.map(leg => local(leg.hip).distanceTo(local(leg.ankle)))),
      ankleY: ankle.y, hipY: hip.y, toeLength: toe ? Math.hypot(toe.x - ankle.x, toe.z - ankle.z) : null,
    };
  }

  static find(mesh: SkinnedMesh): BodyRig | null {
    const leg = (side: '左' | '右'): LegBones | null => {
      const n = LEG_NAMES(side);
      const ik = byName(mesh, n.ik), hip = byName(mesh, n.hip), knee = byName(mesh, n.knee), ankle = byName(mesh, n.ankle);
      if (!ik || !hip || !knee || !ankle) return null;
      // It must really be the IK that moves this ankle (the model's own IK list), not a bone that only shares the name.
      const iks = (mesh.geometry.userData as { MMD?: { iks?: { target: number; effector: number }[] } }).MMD?.iks ?? [];
      const bones = mesh.skeleton.bones;
      if (!iks.some(entry => bones[entry.target] === ik && bones[entry.effector] === ankle)) return null;
      return { ik, toeIk: byName(mesh, n.toeIk), hip, knee, ankle, toe: byName(mesh, n.toe) };
    };
    const left = leg('左'), right = leg('右');
    return left && right ? new BodyRig(mesh, [left, right], byName(mesh, ['センター', 'center', 'Center'])) : null;
  }

  /**
   * What the gait needs to know about her legs (meters): each foot's home is where the motion has its IK target now (her first
   * frame: she starts in the motion's own stance), the rest from the bind pose. The mesh must be placed.
   */
  gaitBody(unitsPerM: number, floorUnits: number): GaitBody {
    const m = 1 / unitsPerM, local = (bone: Bone) => this.mesh.worldToLocal(bone.getWorldPosition(new Vector3()));
    const home = this.legs.map(leg => { const p = local(leg.ik); return { x: p.x * m, z: p.z * m }; }) as [Point2, Point2];
    const toeLength = this.rest.toeLength !== null ? Math.max(0.05, this.rest.toeLength * m) : 0.12;
    const foot: FootSize = { heel: toeLength * 0.3, toe: toeLength, halfWidth: toeLength * 0.3 };
    const toeIk = this.legs[0].toeIk?.position;
    const toe = toeIk ? { forward: toeIk.z * m, drop: -toeIk.y * m } : { forward: toeLength, drop: (this.rest.ankleY + floorUnits) * m };
    // Heights above her floor: the mesh's own origin sits floorUnits above the floor.
    return { home, ankleHeight: (this.rest.ankleY + floorUnits) * m, legLength: this.rest.legLength * m, hipHeight: (this.rest.hipY + floorUnits) * m, foot, toe };
  }

  /** The COM proxy, world (scene units), or null when no segment was found. */
  com(out: Vector3): Vector3 | null {
    const points = this.segments.map(s => {
      s.a.getWorldPosition(this.a); s.b.getWorldPosition(this.b);
      return { a: { x: this.a.x, y: this.a.y, z: this.a.z }, b: { x: this.b.x, y: this.b.y, z: this.b.z }, share: s.share };
    });
    const c = centerOfMass(points);
    return c ? out.set(c.x, c.y, c.z) : null;
  }
}

export interface FootReport { planted: boolean; pitch: number; target: Vector3; ankle: Vector3; toe: Vector3 | null; ikWorld: Vector3 }

/**
 * The one writer of her foot targets. `mode`: 'ground' plants her feet where the gait says; 'motion' writes nothing, so a
 * motion's own foot IK plays as authored (for dances later, and the pass-through test).
 */
export class ContactOwner {
  mode: 'ground' | 'motion' = 'ground';
  private readonly toeRest: (Vector3 | null)[];
  private readonly toeRestQ: (Quaternion | null)[];
  private readonly targets = [new Vector3(), new Vector3()];
  private readonly planted = [true, true];
  private readonly pitch = [0, 0];
  private readonly q = new Quaternion();
  private readonly parentQ = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly hipPoint = new Vector3();
  private written = false;

  constructor(private readonly rig: BodyRig, private readonly unitsPerM: number, private readonly ik: Solver | null, private readonly grant: Solver | null) {
    this.toeRest = rig.legs.map(leg => leg.toeIk?.position.clone() ?? null);
    this.toeRestQ = rig.legs.map(leg => leg.toeIk?.quaternion.clone() ?? null);
  }

  /** Bones this owner writes (callers save and restore them with their other residuals). */
  get bones(): Bone[] { return this.rig.legs.flatMap(leg => leg.toeIk ? [leg.ik, leg.toeIk] : [leg.ik]); }

  /**
   * The hips come down by just enough that every foot target is within `reachFactor` of its straight leg (smooth: a C¹ ramp
   * over a few millimetres, so the guard never starts with a jolt). Returns the drop (m). Call with the mesh placed and the
   * centre's offsets applied; it moves the centre bone and updates the matrices.
   */
  guardReach(feet: readonly FootState[], ankleHeightM: number, legLengthM: number, reachFactor = 0.995): number {
    const center = this.rig.center;
    if (this.mode !== 'ground' || !center) return 0;
    const k = this.unitsPerM, reach = legLengthM * reachFactor;
    this.rig.mesh.updateMatrixWorld(true);
    let need = -Infinity;
    for (let i = 0; i < 2; i++) {
      const hip = this.rig.legs[i].hip.getWorldPosition(this.hipPoint).divideScalar(k);
      const foot = feet[i], targetY = ankleHeightM + foot.lift;
      const horizontal = Math.hypot(hip.x - foot.x, hip.z - foot.z), vertical = hip.y - targetY;
      const within = Math.sqrt(Math.max(0, reach * reach - horizontal * horizontal));
      need = Math.max(need, vertical - within);
    }
    const w = 0.004, drop = need <= -w ? 0 : need >= w ? need : (need + w) ** 2 / (4 * w);
    if (drop > 0) { center.position.y -= drop * k; this.rig.mesh.updateMatrixWorld(true); }
    return drop;
  }

  /** Puts the IK targets where the feet are (world meters), last, then solves IK and grants. */
  writeAndSolve(feet: readonly FootState[], ankleHeightM: number): void {
    const k = this.unitsPerM;
    this.written = this.mode === 'ground';
    if (this.written) {
      this.rig.mesh.updateMatrixWorld(true);
      this.rig.legs.forEach((leg, i) => {
        const foot = feet[i], target = this.targets[i].set(foot.x * k, (ankleHeightM + foot.lift) * k, foot.z * k);
        this.planted[i] = foot.phase === 'planted'; this.pitch[i] = foot.pitch;
        const parent = leg.ik.parent!;
        leg.ik.position.copy(parent.worldToLocal(target.clone()));
        parent.getWorldQuaternion(this.parentQ);
        leg.ik.quaternion.copy(this.parentQ.invert().multiply(this.q.setFromAxisAngle(this.up, foot.yaw)));
        // The toe target under the foot at its pitch (0: flat, as at rest; heel up: rolled about the toe, which stays put).
        if (leg.toeIk && this.toeRest[i]) {
          leg.toeIk.position.copy(this.toeRest[i]!);
          if (foot.pitch) leg.toeIk.position.applyAxisAngle(AXIS_X, foot.pitch);
          leg.toeIk.quaternion.copy(this.toeRestQ[i]!);
        }
      });
      this.rig.mesh.updateMatrixWorld(true);
      this.rig.legs.forEach((leg, i) => this.seed(leg, this.targets[i]));
    }
    this.rig.mesh.updateMatrixWorld(true);
    this.ik?.update();
    this.grant?.update();
    this.rig.mesh.updateMatrixWorld(true);
  }

  /**
   * A starting pose for the model's CCD IK. CCD barely moves a knee that is almost straight (the knee, the ankle and the target
   * are nearly on one line, so each knee step is close to zero), so a standing leg stops millimetres short. The two-bone answer
   * (Codex c228 §3: κ from the law of cosines) bends the knee about its own hinge (the model's limit axis, local x) to the right
   * hip-to-ankle distance, then turns the thigh the least way that points the leg at the target, keeping the knee's direction
   * from the motion. The model's CCD then runs from there with its own limits (and has almost nothing left to do).
   */
  private seed(leg: LegBones, target: Vector3): void {
    const a = leg.knee.position, b = leg.ankle.position; // rest offsets: knee in the thigh's frame, ankle in the shin's
    const hip = leg.hip.getWorldPosition(this.seedHip);
    const scale = leg.hip.getWorldScale(this.seedScale).x || 1;
    const d = hip.distanceTo(target) / scale;
    const P = a.y * b.y + a.z * b.z, Q = a.z * b.y - a.y * b.z;
    const C = (d * d - a.lengthSq() - b.lengthSq()) / 2 - a.x * b.x, R = Math.hypot(P, Q);
    if (R < 1e-9) return;
    // P cosθ + Q sinθ = C: the knee angles that give distance d; a forward bend (θ ≥ 0, the knee in front) in the knee's range.
    const phi = Math.atan2(Q, P), spread = Math.acos(Math.max(-1, Math.min(1, C / R)));
    const candidates = [phi + spread, phi - spread].map(t => Math.atan2(Math.sin(t), Math.cos(t))).filter(t => t >= KNEE_MIN && t <= KNEE_MAX);
    if (!candidates.length) return;
    const forward = candidates.filter(t => t >= 0);
    const theta = forward.length ? Math.min(...forward) : Math.max(...candidates);
    leg.knee.quaternion.setFromAxisAngle(AXIS_X, theta);
    leg.knee.updateMatrixWorld(true);
    // Aim the thigh: the least rotation taking hip→ankle onto hip→target.
    const ankle = leg.ankle.getWorldPosition(this.seedAnkle);
    const from = ankle.sub(hip).normalize(), to = this.seedTo.copy(target).sub(hip).normalize();
    const turn = this.seedTurn.setFromUnitVectors(from, to);
    const world = leg.hip.getWorldQuaternion(this.seedWorld);
    const parent = leg.hip.parent!.getWorldQuaternion(this.parentQ);
    leg.hip.quaternion.copy(parent.invert().multiply(turn.multiply(world)));
    leg.hip.updateMatrixWorld(true);
  }
  private readonly seedHip = new Vector3();
  private readonly seedScale = new Vector3();
  private readonly seedAnkle = new Vector3();
  private readonly seedTo = new Vector3();
  private readonly seedTurn = new Quaternion();
  private readonly seedWorld = new Quaternion();

  /** After the frame: where each IK target and each ankle ended up (world scene units), for tests and the debug line. */
  report(): FootReport[] {
    return this.rig.legs.map((leg, i) => ({
      planted: this.written && this.planted[i], pitch: this.pitch[i],
      target: this.targets[i].clone(),
      ankle: leg.ankle.getWorldPosition(new Vector3()),
      toe: leg.toe ? leg.toe.getWorldPosition(new Vector3()) : null,
      ikWorld: leg.ik.getWorldPosition(new Vector3()),
    }));
  }
}
