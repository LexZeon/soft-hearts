/**
 * Batch C (docs/claude/2026-11-21-unbound-full-ACH.md): while she walks, her one-shot clips use her upper body only. User rule (R29): "可叠加的叠加，
 * 有优先级的按优先级" — her gait owns her hips and legs while she walks (her feet and IK are written after this layer anyway), so what a clip
 * would do to them is laid back toward what was under it, by a weight that eases in as she starts walking and out as she stops (smootherstep
 * over WALK_MASK_S, never a cut). Her chat gestures are upper body only by their own track list; this holds the rest (her actions' clips, the
 * hand-back bridge) to the same rule. The automatic body motion plays inside the figure's own mixer, under this: the walking gate keeps a new
 * one from starting and hands a playing one back (window-motions.ts bodyGates `walking`).
 *
 * A FigureMotionLayer around the one writer at the figure's mixer level (window-under-layer.ts with the clips over it): restore and the weights
 * pass straight through; frame() remembers her hips and legs as the mixer left them, lets the inner layer write, then lays them back by the
 * weight. The inner layer's own restore puts back what it wrote (and with it this), so nothing accumulates. No allocation per frame.
 */
import { Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';
import type { FigureMotionLayer } from '../figure';

/** How long the hold on her hips and legs takes to come in or go out (s). */
export const WALK_MASK_S = 0.35;
/** Her hips and legs (MMD names and a standard skeleton's), the bones her gait owns while she walks. */
// ui-zh-ok: MMD bone names inside the model file, not interface text
const LOWER = /^(?:センター|グルーブ|腰|下半身|全ての親|[左右](?:足|ひざ|足首|つま先|足IK|足ＩＫ|つま先IK|つま先ＩＫ|足D|ひざD|足首D|足先EX)|(?:left|right)?(?:hips?|pelvis|upperleg|lowerleg|thigh|calf|knee|foot|ankle|toes?)(?:left|right|[lr])?)$/i;
const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

/** Whether a bone is one her gait owns while she walks (exported for the test). */
export const isGaitBone = (name: string): boolean => LOWER.test(name.normalize('NFKC').replace(/[\s_.-]/g, '')) || LOWER.test(name);

export class WalkMask implements FigureMotionLayer {
  private inner: FigureMotionLayer | null = null;
  private bones: { bone: Bone; quaternion: Quaternion; position: Vector3 }[] = [];
  private progress = 0;
  private walking = false;

  /** The layer it holds to the rule, on this model's bones (null: none). Returns this for the figure. */
  over(inner: FigureMotionLayer | null, mesh: SkinnedMesh | null): this {
    this.inner = inner;
    this.bones = mesh ? mesh.skeleton.bones.filter(bone => isGaitBone(bone.name)).map(bone => ({ bone, quaternion: new Quaternion(), position: new Vector3() })) : [];
    return this;
  }
  /** She walks now (her gait): the hold eases toward it every frame. */
  setWalking(walking: boolean): void { this.walking = walking; }
  /** How many of her bones the hold covers on this model (her hips and legs by name; diagnostics and tests). */
  get heldBones(): number { return this.bones.length; }
  /** 0..1: how much of her hips and legs the hold keeps now (eased). */
  get weight(): number { return smooth(this.progress); }

  get armsHeld(): number { return this.inner?.armsHeld ?? 0; }
  restore(): void { this.inner?.restore(); }
  beforeUpdate(delta: number): void { this.inner?.beforeUpdate(delta); }
  frame(delta: number): void {
    const step = Number.isFinite(delta) && delta > 0 ? delta / WALK_MASK_S : 0;
    this.progress = this.walking ? Math.min(1, this.progress + step) : Math.max(0, this.progress - step);
    const weight = this.weight;
    if (weight > 0) for (const held of this.bones) { held.quaternion.copy(held.bone.quaternion); held.position.copy(held.bone.position); }
    this.inner?.frame(delta);
    if (weight <= 0) return;
    for (const held of this.bones) { held.bone.quaternion.slerp(held.quaternion, weight); held.bone.position.lerp(held.position, weight); }
  }
  /** A model goes away. */
  forget(): void { this.inner = null; this.bones = []; this.progress = 0; this.walking = false; }
}
