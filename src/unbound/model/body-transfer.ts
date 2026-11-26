/**
 * I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): the standard skeleton's pose onto the model's own bones, once per frame,
 * after everything the engine writes (motion, residuals, IK, mouth). The correspondence table, applied:
 *
 * - Turns, by direction in the world, not by local numbers: each driven model bone b gets the world turn of its standard bone times
 *   its own rest orientation, W_b = P_s · K_s · R_b (the standard bones rest at identity, so P_s is exactly "how far it has turned";
 *   K_s is the turn the standard skeleton laid that bone in with, a T-pose arm brought to Gene's angle, else identity); its
 *   local rotation is then its parent's posed world turn inverted times that. A model bone's rest orientation (a VRM's T pose, its
 *   own bone axes, a 0.x model turned to face the stage) therefore never matters, and standard bones a model lacks (センター,
 *   グルーブ, twist bones) reach it through the bones below them. Model bones nobody drives keep their own local rotation.
 * - Her hips' place: the hips sit where the standard 下半身 is (センター's motion, her breath and the gait's pelvis shift land here).
 * - Eyes: a VRM looks around with its eye bones or with look expressions, by its own range maps (rangeMap*: how far the eyes turn
 *   for a look so many degrees off); the standard eyes' turn in the head is the look.
 * - Faces, in proportion: each standard morph's weight × the expression's own bind weight, nothing scaled up
 *   to another model's size. Every morph target an expression writes is rewritten each frame (no leftovers).
 * Pure three.js math, no DOM.
 */
import { Euler, Matrix4, Quaternion, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';
import type { LoadedModel, MorphBind } from '../../stage';

type VrmLookAtRange = NonNullable<LoadedModel['lookAt']>['ranges']['horizontalInner'];
import type { StandardBoneSpec, StandardMorphSpec } from './standard-skeleton';

interface Driven { bone: Bone; standard: number; rest: Quaternion; eye: 'left' | 'right' | null }
interface Chained { bone: Bone; parent: number; parentRest: Quaternion; driven: Driven | null }

const DEG = 180 / Math.PI;
/** output = scale × min(1, |angle| / input max), with the angle's sign. */
export const lookRange = (range: VrmLookAtRange, degrees: number): number =>
  Math.sign(degrees) * range.outputScale * Math.min(1, Math.abs(degrees) / range.inputMaxValue);

/** The model's binds a standard morph writes: its slot's expression, or (I-164) the named face shape it stands for. */
export function standardMorphBinds(model: Pick<LoadedModel, 'expression' | 'faceShape'>, morph: StandardMorphSpec): readonly MorphBind[] {
  return morph.slot ? model.expression(morph.slot) : morph.shape ? model.faceShape?.(morph.shape) ?? [] : [];
}

/** I-164: the smaller of a range map's eye turn and the room's share of the look (degrees, the turn's own sign). */
export const roomTurn = (mapped: number, look: number, room: number): number =>
  Math.sign(mapped) * Math.min(Math.abs(mapped), Math.abs(look) * Math.max(0, Math.min(1, room)));

export class BodyTransfer {
  private readonly chain: Chained[] = [];
  private readonly world: Quaternion[] = [];
  private readonly parents: number[];
  private readonly standardQ: Quaternion[];
  private readonly standardP: Vector3[];
  private readonly hips: { bone: Bone; standard: number; parentInverse: Matrix4 } | null;
  private readonly faces: { index: number; binds: readonly MorphBind[] }[] = [];
  private readonly looks: { left: readonly MorphBind[]; right: readonly MorphBind[]; up: readonly MorphBind[]; down: readonly MorphBind[] } | null;
  private readonly owned: { mesh: SkinnedMesh; index: number }[] = [];
  private readonly headIndex: number;
  private readonly eyeIndices: number[];
  private readonly q = new Quaternion();
  private readonly e = new Euler(0, 0, 0, 'YXZ');
  private readonly v = new Vector3();
  /** The look the eyes were given on the last frame (degrees, yaw + = her left, pitch + = down), for tests. */
  look = { yaw: 0, pitch: 0 };
  /**
   * I-164 (docs/claude/2026-11-20-vrm-gaps.md): the share of a look her eye bones may take on this model's own lids and eyes
   * (vrm-eye-room.ts, the rule eye-turn-gain.ts gives every MMD model; 1: room enough). Each eye bone turns the smaller of the range map's
   * turn and this share of the look.
   */
  eyeRoom = 1;

  constructor(private readonly standard: SkinnedMesh, specs: readonly StandardBoneSpec[], morphs: readonly StandardMorphSpec[],
    private readonly model: Pick<LoadedModel, 'object' | 'lookAt' | 'expression' | 'expressionNamed' | 'faceShape'>) {
    // Everything is measured in the standard mesh's frame: the model hangs under it at rest (identity), so world = mesh frame now.
    standard.updateMatrixWorld(true);
    const toMesh = new Matrix4().copy(standard.matrixWorld).invert();
    const restOf = (object: Object3D) => { const q = new Quaternion(); new Matrix4().multiplyMatrices(toMesh, object.matrixWorld).decompose(new Vector3(), q, new Vector3()); return q; };
    const bones = standard.skeleton.bones;
    this.parents = bones.map((b, i) => { const p = (b.parent as Bone | null)?.isBone ? bones.indexOf(b.parent as Bone) : -1; return p < i ? p : -1; });
    this.standardQ = specs.map(() => new Quaternion());
    this.standardP = specs.map(() => new Vector3());
    this.headIndex = specs.findIndex(spec => spec.slot === 'head');
    this.eyeIndices = specs.flatMap((spec, i) => spec.slot === 'eyeLeft' || spec.slot === 'eyeRight' ? [i] : []);
    const bone = (spec: StandardBoneSpec) => spec.drives;
    const driven = new Map<Bone, Driven>();
    specs.forEach((spec, i) => {
      const target = bone(spec);
      if (!target || driven.has(target)) return;
      const eye = spec.slot === 'eyeLeft' ? 'left' : spec.slot === 'eyeRight' ? 'right' : null;
      if (eye && model.lookAt?.type === 'expression') return; // the look is expressions: the eye bones stay as they are
      // A bone laid into the standard skeleton turned (a T-pose arm at Gene's angle): at its standard rest the model's bone is turned the same.
      const rest = restOf(target).normalize();
      if (spec.restTurn) rest.premultiply(spec.restTurn).normalize();
      driven.set(target, { bone: target, standard: i, rest, eye });
    });
    // The model bones on the way: every driven bone and its ancestors below the model's root, parents first.
    const root = model.object, members = new Set<Bone>();
    for (const target of driven.keys()) for (let at: Object3D | null = target; at && at !== root && (at as Bone).isBone; at = at.parent) members.add(at as Bone);
    const depth = (o: Object3D) => { let d = 0; for (let at = o.parent; at; at = at.parent) d++; return d; };
    const ordered = [...members].sort((a, b) => depth(a) - depth(b));
    const position = new Map(ordered.map((member, i) => [member, i]));
    for (const member of ordered) {
      const parent = member.parent && position.has(member.parent as Bone) ? position.get(member.parent as Bone)! : -1;
      this.chain.push({ bone: member, parent, parentRest: member.parent ? restOf(member.parent).normalize() : new Quaternion(), driven: driven.get(member) ?? null });
      this.world.push(new Quaternion());
    }
    const hipsSpec = specs.findIndex(spec => spec.slot === 'lowerBody'), hips = specs[hipsSpec]?.drives ?? null;
    this.hips = hips && hips.parent
      ? { bone: hips, standard: hipsSpec, parentInverse: new Matrix4().multiplyMatrices(toMesh, hips.parent.matrixWorld).invert() } : null;
    // Faces: standard morph → the model's expression for that slot.
    const owned = new Set<string>();
    const own = (binds: readonly MorphBind[]) => { for (const b of binds) { const key = `${b.mesh.uuid}:${b.index}`; if (!owned.has(key)) { owned.add(key); this.owned.push({ mesh: b.mesh, index: b.index }); } } };
    morphs.forEach((morph, index) => { const binds = standardMorphBinds(model, morph); if (binds.length) { this.faces.push({ index, binds }); own(binds); } });
    if (model.lookAt?.type === 'expression') {
      this.looks = { left: model.expressionNamed('lookLeft'), right: model.expressionNamed('lookRight'), up: model.expressionNamed('lookUp'), down: model.expressionNamed('lookDown') };
      for (const binds of Object.values(this.looks)) own(binds);
    } else this.looks = null;
  }

  /** The model bones this writes, for tests. */
  get drivenBones(): Bone[] { return this.chain.flatMap(entry => entry.driven ? [entry.driven.bone] : []); }

  /** Writes this frame's pose and face onto the model. */
  apply(): void {
    // The standard skeleton in its mesh's frame: product of the local turns from its root (every bone rests at identity).
    const bones = this.standard.skeleton.bones;
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i], p = this.parents[i];
      if (p >= 0) {
        this.standardQ[i].copy(this.standardQ[p]).multiply(bone.quaternion);
        this.standardP[i].copy(bone.position).applyQuaternion(this.standardQ[p]).add(this.standardP[p]);
      } else { this.standardQ[i].copy(bone.quaternion); this.standardP[i].copy(bone.position); }
    }
    this.applyLook();
    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i], parentWorld = entry.parent >= 0 ? this.world[entry.parent] : entry.parentRest;
      const driven = entry.driven;
      if (!driven) { this.world[i].copy(parentWorld).multiply(entry.bone.quaternion); continue; }
      const target = this.world[i];
      if (driven.eye) target.copy(this.standardQ[this.headIndex]).multiply(this.eyeTurn(driven.eye)).multiply(driven.rest);
      else target.copy(this.standardQ[driven.standard]).multiply(driven.rest);
      entry.bone.quaternion.copy(this.q.copy(parentWorld).invert().multiply(target)).normalize();
    }
    if (this.hips) this.hips.bone.position.copy(this.v.copy(this.standardP[this.hips.standard]).applyMatrix4(this.hips.parentInverse));
    this.applyFaces();
  }

  /** Puts every face target the transfer owns back to 0 (a model leaving). */
  reset(): void { for (const { mesh, index } of this.owned) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = 0; }

  /** The standard eyes' turn in the head, as a look (degrees). */
  private applyLook(): void {
    let yaw = 0, pitch = 0;
    const bones = this.standard.skeleton.bones;
    for (const index of this.eyeIndices) { this.e.setFromQuaternion(bones[index].quaternion, 'YXZ'); yaw += this.e.y; pitch += this.e.x; }
    const n = this.eyeIndices.length || 1;
    this.look = { yaw: yaw / n * DEG, pitch: pitch / n * DEG };
  }
  private readonly eyeQ = new Quaternion();
  /** One eye's turn in the head by the model's range maps (inner/outer by which way that eye turns). */
  private eyeTurn(eye: 'left' | 'right'): Quaternion {
    const ranges = this.model.lookAt?.ranges, room = this.eyeRoom;
    if (!ranges) return this.eyeQ.setFromEuler(this.e.set(roomTurn(this.look.pitch, this.look.pitch, room) / DEG, roomTurn(this.look.yaw, this.look.yaw, room) / DEG, 0, 'YXZ'));
    const outward = eye === 'left' ? this.look.yaw > 0 : this.look.yaw < 0;
    const yaw = roomTurn(lookRange(outward ? ranges.horizontalOuter : ranges.horizontalInner, this.look.yaw), this.look.yaw, room);
    const pitch = roomTurn(lookRange(this.look.pitch > 0 ? ranges.verticalDown : ranges.verticalUp, this.look.pitch), this.look.pitch, room);
    return this.eyeQ.setFromEuler(this.e.set(pitch / DEG, yaw / DEG, 0, 'YXZ'));
  }

  /** I-164: only the face again (a face shape the face exclusive wrote after the frame was presented; the pose is left as it is). */
  applyFace(): void { this.applyFaces(); }

  private applyFaces(): void {
    for (const { mesh, index } of this.owned) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = 0;
    const weights = this.standard.morphTargetInfluences ?? [];
    const add = (binds: readonly MorphBind[], weight: number) => {
      if (!(weight > 0)) return;
      for (const bind of binds) { const values = bind.mesh.morphTargetInfluences; if (values) values[bind.index] = (values[bind.index] ?? 0) + weight * bind.weight; }
    };
    for (const face of this.faces) add(face.binds, weights[face.index] ?? 0);
    if (this.looks) {
      const ranges = this.model.lookAt!.ranges, { yaw, pitch } = this.look;
      add(yaw > 0 ? this.looks.left : this.looks.right, Math.abs(lookRange(ranges.horizontalOuter, yaw)));
      add(pitch > 0 ? this.looks.down : this.looks.up, Math.abs(lookRange(pitch > 0 ? ranges.verticalDown : ranges.verticalUp, pitch)));
    }
    for (const { mesh, index } of this.owned) {
      const values = mesh.morphTargetInfluences;
      if (values) values[index] = Math.min(1, Math.max(0, Number.isFinite(values[index]) ? values[index] : 0));
    }
  }
}
