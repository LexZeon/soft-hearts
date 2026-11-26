/**
 * I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): a model that is not MMD (a VRM, as it is) in Unbound's engine. The
 * engine drives the standard skeleton (standard-skeleton.ts) exactly as it drives an MMD model; once per frame, after the engine's
 * last write, `present()` puts that pose and face onto the model's own bones and expressions (body-transfer.ts). The model hangs
 * under the standard skeleton's mesh, so wherever the engine places her, the model goes too.
 *
 * Use: `const body = StandardBody.of(loaded)`; give `body.mesh` to UnboundFigure as if it were an MMD mesh; load clips with
 * `body.transform` (the motion conversion onto the standard skeleton); call `body.present()` after each frame; `body.dispose()`.
 */
import { Box3, Vector3, type Bone, type SkinnedMesh } from 'three';
import { VrmSpringPhysics, type LoadedModel } from '../../stage';
import type { ModelPhysicsSettings } from '../../../shared/stage';
import type { MorphSlot, StandardBone } from '../../../shared/foundation/universal-skeleton';
import type { VmdDataTransform } from '../../foundation/vmd';
import { BodyTransfer } from './body-transfer';
import { vrmEyeRoomGain } from './vrm-eye-room';
import { standardMesh, standardMorphSpec, standardSkeletonSpec, type StandardBoneSpec, type StandardMorphSpec } from './standard-skeleton';
import { StandardMotionRetarget, standardRetargetRig } from './standard-retarget';
import { setBodyCapsuleSource, type BoneCapsule } from '../../foundation/body-capsules';
import { measureStandardCapsules } from './standard-capsules';

export class StandardBody {
  readonly mesh: SkinnedMesh;
  readonly specs: readonly StandardBoneSpec[];
  readonly morphs: readonly StandardMorphSpec[];
  readonly retarget: StandardMotionRetarget;
  readonly transfer: BodyTransfer;
  /**
   * I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): the model's own spring bones (hair, coat, skirt; src/stage/vrm-spring/), run
   * by present() right after the pose transfer; null when it has none. Off until configurePhysics switches a part on.
   */
  readonly springs: VrmSpringPhysics | null;
  private disposed = false;
  private capsuleCache: BoneCapsule[] | null = null;
  private static readonly byMesh = new WeakMap<SkinnedMesh, StandardBody>();
  /** The standard body whose skeleton this mesh is (full-screen's physics setting finds a VRM's springs by her figure's mesh). */
  static ofMesh(mesh: SkinnedMesh): StandardBody | null { return StandardBody.byMesh.get(mesh) ?? null; }

  private constructor(readonly model: LoadedModel) {
    // The model's own rest pose, at its own origin (it is not in a scene yet).
    model.object.position.set(0, 0, 0);
    model.object.updateMatrixWorld(true);
    this.specs = standardSkeletonSpec(model);
    this.morphs = standardMorphSpec(slot => model.expression(slot).length > 0, shape => (model.faceShape?.(shape).length ?? 0) > 0); // I-164: her face actions' shapes too
    this.mesh = standardMesh(this.specs, this.morphs);
    this.mesh.add(model.object);
    this.mesh.updateMatrixWorld(true);
    this.transfer = new BodyTransfer(this.mesh, this.specs, this.morphs, model);
    this.transfer.eyeRoom = vrmEyeRoomGain(model, this.mesh); // I-164: her eyes turn no further than her own lids leave room for
    this.retarget = new StandardMotionRetarget(standardRetargetRig(this.specs, this.morphs, restHeight(model)));
    setBodyCapsuleSource(this.mesh, () => this.capsules()); // I-164 interaction: whoever measures her capsules gets the model's own
    this.springs = VrmSpringPhysics.of(model); // built at rest: the body colliders are measured from it
    StandardBody.byMesh.set(this.mesh, this);
  }

  /** The companion's physics switches (hair, chest, quality) for the model's springs. */
  configurePhysics(settings: ModelPhysicsSettings): void { this.springs?.configure(settings); }
  /** Nothing is drawn: the springs pause; the next present() resumes them (carried, their motion dropped). */
  hidePhysics(): void { this.springs?.setVisible(false); }

  /**
   * I-164 interaction (standard-capsules.ts): her body capsules from the model's own meshes, placed by its own bones and named by the
   * standard skeleton's; measured once. measureBodyCapsules(body.mesh) returns these.
   */
  capsules(): BoneCapsule[] { return this.capsuleCache ??= measureStandardCapsules(this.mesh, this.specs, this.model); }

  /** The standard body for a loaded model; throws (in English, for the log) when the model lacks a humanoid part. */
  static of(model: LoadedModel): StandardBody { return new StandardBody(model); }

  /** VMD → the standard skeleton (for loadClip). */
  get transform(): VmdDataTransform { return this.retarget.transform as VmdDataTransform; }
  /** The model's head and eyes (its own bones, posed by present()), for the head-contact probe. */
  get head(): Bone | null { return this.model.bone('head') ?? null; }
  get eyes(): Bone[] { return [this.model.bone('eyeLeft'), this.model.bone('eyeRight')].filter((bone): bone is Bone => !!bone); }
  /** I-164: the standard skeleton's bone for a standard part (what the engine drives; the sleep body plans on these), or undefined. */
  standardBone(slot: StandardBone): Bone | undefined {
    const index = this.specs.findIndex(spec => spec.slot === slot);
    return index >= 0 ? this.mesh.skeleton.bones[index] : undefined;
  }
  /** Which expression slots the model can show (the standard face has a morph for each). */
  has(slot: MorphSlot): boolean { return this.morphs.some(morph => morph.slot === slot); }

  /** After the engine's frame: the pose and face onto the model, then its springs (`physicsDelta` s; 0: no time passes). */
  present(physicsDelta = 0): void {
    if (this.disposed) return;
    this.transfer.apply();
    if (this.springs) { this.springs.setVisible(true); this.springs.frame(physicsDelta); }
  }
  /** I-164: the face onto the model again, after a face shape wrote the standard morphs late in the frame (window-motions.ts afterBody). */
  presentFace(): void { if (!this.disposed) this.transfer.applyFace(); }

  /**
   * Her bounds as shown now (model units, the standard mesh at the origin), measured from the model's posed vertices: after her
   * first frame her arms are down, so the framing sees her standing, not her T pose.
   */
  measureShown(): { height: number; width: number; baseY: number; centerX: number } {
    const saved = this.mesh.position.clone();
    this.mesh.position.set(0, 0, 0);
    this.mesh.updateMatrixWorld(true);
    for (const mesh of this.model.meshes) { mesh.skeleton?.update(); mesh.computeBoundingBox(); }
    const box = new Box3().setFromObject(this.model.object);
    this.mesh.position.copy(saved);
    this.mesh.updateMatrixWorld(true);
    const size = box.getSize(new Vector3());
    return { height: Math.max(1, size.y), width: Math.max(1, size.x), baseY: box.min.y, centerX: (box.min.x + box.max.x) / 2 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setBodyCapsuleSource(this.mesh, null);
    StandardBody.byMesh.delete(this.mesh);
    this.springs?.dispose();
    this.transfer.reset();
    this.model.object.removeFromParent();
    this.model.dispose();
  }
}

function restHeight(model: LoadedModel): number {
  const box = new Box3().setFromObject(model.object);
  return Number.isFinite(box.max.y - box.min.y) && box.max.y > box.min.y ? box.max.y - box.min.y : 20;
}
