/**
 * I-147 全身果冻 (docs/claude/2026-11-17-whole-body-jelly.md): the experimental layers 2 and 3 as one object a frame loop holds.
 * The companion (src/stage/mmd/physics.ts), Unbound (src/unbound/figure.ts) and the physics lab all use this same class.
 *
 * Per rendered frame, in this order:
 *   frame(mesh, dt, resetSerial)  after the final pose and the continuity guard, before local physics
 *   remove()                      right after render (the companion), or at the start of the next frame (Unbound, the lab)
 * plus hide() when nothing is drawn, configure(tuning) when the lab's tuning changes, dispose() when the owner goes.
 * Layer 2 (follow-through.ts) moves bones and is removed after render; layer 3 (soft-jelly.ts) moves no bone: it sets the vertex
 * shader's offsets, computed from the final pose (layer 2 included).
 *
 * Off is exactly today: a holder only creates this once a tuning turns a layer on; and while both layers are off (or the tuning
 * was made for another model's rig) frame() touches no bone, material or geometry.
 */
import type { SkinnedMesh, Vector3 } from 'three';
import type { ModelPhysicsTuning } from '../../../shared/stage/physics-tuning';
import { jellyOff, type JellyTuning, type SoftRegion } from '../../../shared/stage/jelly-tuning';
import { buildPhysicsRigPlan, physicsRigSignature } from '../physics-rig';
import { FollowThrough, type FollowState } from './follow-through';
import { SoftJelly, type SoftState } from './soft-jelly';

export interface StageJellyState {
  follow: FollowState | null;
  soft: SoftState | null;
}

/** Bones a physics part simulates (nothing else may write them), and whether the model's physics moves the chest. */
export function physicsOwnership(mesh: SkinnedMesh): { bones: Set<number>; chest: boolean } {
  try {
    const plan = buildPhysicsRigPlan(mesh);
    return { bones: new Set([...plan.hair.dynamicBoneIndices, ...plan.chest.dynamicBoneIndices]), chest: plan.chest.dynamicBoneIndices.length > 0 };
  } catch { return { bones: new Set(), chest: false }; }
}

export class StageJelly {
  private mesh: SkinnedMesh | null = null;
  private rig = '';
  private owned: { bones: Set<number>; chest: boolean } | null = null;
  private tuning: ModelPhysicsTuning | null = null;
  private follow: FollowThrough | null = null;
  private soft: SoftJelly | null = null;
  private resets: number | null = null;
  private touch = { enabled: false, strength: 1 };

  /** For a holder: the jelly object for this tuning. Created only when the tuning turns a layer on; kept (and reconfigured) once it exists. */
  static next(current: StageJelly | null, tuning: ModelPhysicsTuning | null | undefined, touch?: { enabled: boolean; strength: number } | null): StageJelly | null {
    if (!current && jellyOff(tuning?.jelly) && !touch?.enabled) return null;
    const jelly = current ?? new StageJelly(); jelly.configure(tuning); jelly.configureTouch(touch?.enabled === true, touch?.strength ?? 1); return jelly;
  }

  /** The model's lab tuning (or none). Takes effect in place on the next frame; layers fade, they never jump. */
  configure(tuning: ModelPhysicsTuning | null | undefined): void {
    this.tuning = tuning ? structuredClone(tuning) : null;
    const jelly = this.jelly();
    this.follow?.configure(jelly?.follow);
    this.soft?.configure(jelly?.soft);
  }

  /** After the final pose and the guard, before physics. `resetSerial`: the guard's count of hard resets (a change is a cut). */
  frame(mesh: SkinnedMesh | null, dt: number, resetSerial = 0): void {
    if (mesh !== this.mesh) this.bind(mesh);
    if (!mesh) return;
    if (this.resets !== resetSerial) { if (this.resets !== null) { this.follow?.reset(); this.soft?.reset(); } this.resets = resetSerial; }
    const jelly = this.jelly();
    if (!this.follow && jelly?.follow.enabled) { this.follow = new FollowThrough(mesh, this.ownership(mesh).bones); this.follow.configure(jelly.follow); }
    if (this.follow) {
      this.follow.apply(dt);
      if (this.follow.idle) this.follow = null;
    }
    if (!this.soft && jelly?.soft.enabled) { this.soft = new SoftJelly(mesh, this.ownership(mesh).chest); this.soft.configure(jelly.soft); this.soft.configureTouch(this.touch.enabled, this.touch.strength); }
    if (this.soft) {
      this.soft.update(dt);
      if (this.soft.idle) { this.soft.dispose(); this.soft = null; }
    }
  }

  remove(): void { this.follow?.remove(); }

  hide(): void { this.follow?.hide(); this.soft?.hide(); }

  /** True when nothing is running and the tuning turns nothing on (for any model): the holder may drop this object. */
  get idle(): boolean { return !this.follow && !this.soft && jellyOff(this.tuning?.jelly) && !this.touch.enabled; }

  getState(): StageJellyState { return { follow: this.follow?.getState() ?? null, soft: this.soft?.getState() ?? null }; }

  /** Layer 3 itself (the lab's region list; tests). */
  get softLayer(): SoftJelly | null { return this.soft; }

  /**
   * Step 5d「碰了才软」(docs/claude/2026-11-18-unbound-step5.md): the switch and its strength (the host resolves the default per
   * channel: on in development and source runs, off in stable until the user tries it). On costs nothing until a touch: layer 3's
   * object, its patch and its vertex data come only with a touch, and go again once it has settled.
   */
  configureTouch(enabled: boolean, strength = 1): void {
    this.touch = { enabled: enabled === true, strength };
    this.soft?.configureTouch(this.touch.enabled, strength);
  }
  get touchEnabled(): boolean { return this.touch.enabled; }

  /** A press on her at `point` (world), pushing along `into`: the soft region there dents (its index), or -1. */
  touchPress(point: Vector3, into: Vector3): number { return this.touchSoft()?.press(point, into) ?? -1; }

  /** The same for a region known by kind and side (1 her left, -1 her right): a pinch on her cheek. */
  touchPressKind(kind: SoftRegion, side: -1 | 0 | 1, into: Vector3): number {
    const soft = this.touchSoft();
    return soft ? soft.pressRegion(soft.regions.findIndex(region => region.kind === kind && region.side === side), into) : -1;
  }

  private touchSoft(): SoftJelly | null {
    if (!this.touch.enabled || !this.mesh) return null;
    if (!this.soft) {
      this.soft = new SoftJelly(this.mesh, this.ownership(this.mesh).chest);
      this.soft.configure(this.jelly()?.soft);
      this.soft.configureTouch(true, this.touch.strength);
    }
    return this.soft;
  }

  /** Holding that region: its rest point moves by `offset` (world); null lets go, from what shows. */
  touchHold(region: number, offset: Vector3 | null): void { if (region >= 0) this.soft?.hold(region, offset); }

  dispose(): void { this.bind(null); this.tuning = null; }

  /** This tuning's jelly part, only when it was made for the bound model's rig (a stale one from a model switch is ignored). */
  private jelly(): JellyTuning | null {
    const tuning = this.tuning;
    return tuning?.jelly && this.mesh && tuning.rig === this.rig ? tuning.jelly : null;
  }

  private ownership(mesh: SkinnedMesh) { return this.owned ??= physicsOwnership(mesh); }

  private bind(mesh: SkinnedMesh | null): void {
    this.follow?.remove(); this.follow = null;
    this.soft?.dispose(); this.soft = null;
    this.mesh = mesh; this.rig = mesh ? physicsRigSignature(mesh) : ''; this.resets = null; this.owned = null;
  }
}
