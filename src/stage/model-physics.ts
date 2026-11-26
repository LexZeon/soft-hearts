import { Quaternion, Vector3, type Bone, type Camera, type SkinnedMesh } from "three";
import { MMDPhysics } from "three/examples/jsm/animation/MMDPhysics.js";
import {
  normalizeModelPhysicsSettings,
  type ModelPhysicsPart,
  type ModelPhysicsQuality,
  type ModelPhysicsSettings,
  type ModelPhysicsState,
} from "../../shared/stage/model-physics";
import { tuningSignature } from "../../shared/stage/physics-tuning";
import type { AmmoModule } from "./ammo-runtime";
import { OwnedAmmoScope, type NativeMethod, type NativeObject } from "./ammo-scope";
import { buildPhysicsRigPlan, type PhysicsPartRig, type PhysicsRigPlan } from "./physics-rig";
import { tunePart, type TunedPart } from "./physics-tuning-apply";
import { SpringBoneChain } from "./spring-bone";
import { partDiagnostics, type PartDiagnostics } from "./physics-diagnostics";
import { boundAroundRest, capAngle } from "./physics-rest-split";

export { buildPhysicsRigPlan, probeModelPhysicsSupport } from "./physics-rig";
export { OwnedAmmoScope } from "./ammo-scope";
// I-147 全身果冻: the jelly layers ride on this module for the Unbound window, which already imports it (no new edge into the stage).
export { StageJelly } from "./jelly/stage-jelly";
// Unbound step 6 (src/unbound/jelly-warm.ts): the same patch, to compile the jelly's programs ahead of the first touch.
export { JellyMaterialPatch, createJellyUniforms } from "./jelly/soft-shader";
// I-136 step 5 拉她: Unbound's figure takes the pull from here too (one door into the stage for what rides on her body after the pose).
export { StagePull } from "./pull/stage-pull";
export type { StagePullHit, StageView } from "./pull/stage-pull";

/** Trial budgets: scheduling and Bullet work differ; output strength does not. */
export const MODEL_PHYSICS_BUDGETS = Object.freeze({
  low: Object.freeze({ updateHz: 20, unitStep: 1 / 65, maxSteps: 8, solverIterations: 4 }),
  standard: Object.freeze({ updateHz: 30, unitStep: 1 / 65, maxSteps: 8, solverIterations: 10 }),
  high: Object.freeze({ updateHz: 60, unitStep: 1 / 65, maxSteps: 8, solverIterations: 20 }),
});

const PARTS: readonly ModelPhysicsPart[] = ["hair", "chest"];
const FADE_SECONDS = 0.22;
const MAX_FRAME_DT = 0.05;
const LONG_FRAME_DT = 0.15;
// Two small presentation poles attenuate persistent high-frequency solver
// chatter without changing gravity, authored springs, or quality budgets.
const HAIR_FILTER_SECONDS = 0.12;
/** R01: the chest's slowly tracked rest offset (its authored preload) is bounded apart from the motion around it. */
const CHEST_REST_SECONDS = 1.0;
/** A group that starts (or restarts) on the spring solver blends in over this long, from what is shown. */
const SPRING_BLEND_SECONDS = 0.25;
const IDENTITY = new Quaternion();

export interface LocalPhysicsBackend {
  unitStep: number;
  maxStepNum: number;
  update(dt: number): unknown;
  reset(): unknown;
}

/** Internal synchronous dependency seam for lifecycle tests; no renderer input. */
export type LocalPhysicsFactory = (
  mesh: SkinnedMesh, rig: PhysicsPartRig, budget: { readonly updateHz: number; readonly unitStep: number; readonly maxSteps: number; readonly solverIterations: number },
) => LocalPhysicsBackend;

const defaultFactory: LocalPhysicsFactory = (mesh, rig, budget) => new MMDPhysics(
  mesh, [...rig.rigidBodies], [...rig.constraints], { unitStep: budget.unitStep, maxStepNum: budget.maxSteps },
);

export interface BoneLayer {
  index: number;
  output: boolean;
  bone: Bone;
  /** The lab group this bone belongs to (null: a helper bone). */
  group: string | null;
  /** This bone's eased output blend (the part's strength, or the group's when the lab set one). */
  strength: number;
  maxAngle: number;
  basePosition: Vector3;
  baseQuaternion: Quaternion;
  baseWorldPosition: Vector3;
  appliedPosition: Vector3;
  appliedQuaternion: Quaternion;
  previousOutputRotation: Quaternion;
  previousOutputOffset: Vector3;
  previousWorldPosition: Vector3;
  worldFrameDelta: Vector3;
  previousWorldValid: boolean;
  offset: Vector3;
  rotation: Quaternion;
  targetOffset: Vector3;
  targetRotation: Quaternion;
  filteredOffset: Vector3;
  filteredRotation: Quaternion;
  /** Chest: the shown output at the last solve (display interpolates from here to the target over one quantum). */
  fromOffset: Vector3;
  fromRotation: Quaternion;
  restOffset: Vector3;
  restRotation: Quaternion;
  restValid: boolean;
  maxDisplacement: number;
}

interface PartRuntime {
  part: ModelPhysicsPart;
  rig: PhysicsPartRig;
  tuned: TunedPart;
  layers: BoneLayer[];
  scope?: OwnedAmmoScope;
  backend?: LocalPhysicsBackend;
  springs: { id: string; chain: SpringBoneChain; blend: number }[];
  live: boolean;
  fade: number;
  strength: number;
  elapsed: number;
  scheduled: number;
  sinceSolve: number;
  stepMs: number;
  springMs: number;
  needsReset: boolean;
  failed: boolean;
  applied: boolean;
  anchorPositions: Vector3[];
  anchorRotations: Quaternion[];
  zeroVelocity?: object;
  maxFrameAngle: number;
  maxFrameDisplacement: number;
  maxWorldFrameDisplacement: number;
  targetSolverIterations: number;
  qualityJustChanged: boolean;
}

function validQuaternion(value: Quaternion): boolean {
  return [value.x, value.y, value.z, value.w].every(Number.isFinite) && value.lengthSq() > 0.000001;
}

function validPosition(value: Vector3): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}

/**
 * Stage contract: restore() before any animation/input pose writers, then frame()
 * after their final pose. This class never advances an Action or touches morphs.
 */
export class LocalModelPhysics {
  private settings: ModelPhysicsSettings;
  private rig: PhysicsRigPlan;
  private readonly parts: Record<ModelPhysicsPart, PartRuntime>;
  private tuningKey: string;
  private visible = true;
  private disposed = false;
  private applied = false;
  private solved = false;
  private retiredCreated = 0;
  private retiredDestroyed = 0;
  private retiredSteps = 0;
  private retiredIterationWork = 0;
  private retiredLiveObjects = 0;
  private cleanupFailures = 0;
  private measuredMs = 0;
  private measurements = 0;
  private frameSerial = 0;

  constructor(
    private readonly mesh: SkinnedMesh,
    private readonly ammo: AmmoModule,
    settings?: ModelPhysicsSettings,
    private readonly factory: LocalPhysicsFactory = defaultFactory,
  ) {
    this.settings = normalizeModelPhysicsSettings(settings);
    this.tuningKey = this.applicableTuningKey();
    this.rig = buildPhysicsRigPlan(mesh, this.rigOptions());
    const make = (part: ModelPhysicsPart): PartRuntime => {
      const tuned = tunePart(this.rig[part], part, this.tuning());
      return { part, rig: this.rig[part], tuned, springs: [], live: false, fade: 0, strength: this.settings[part].strength,
        elapsed: 0, scheduled: 0, sinceSolve: 0, stepMs: 0, springMs: 0, needsReset: true, failed: false, applied: false, anchorPositions: [], anchorRotations: [],
        maxFrameAngle: 0, maxFrameDisplacement: 0, maxWorldFrameDisplacement: 0,
        targetSolverIterations: MODEL_PHYSICS_BUDGETS[this.settings.quality].solverIterations, qualityJustChanged: false,
        layers: this.rig[part].dynamicBoneIndices.map(index => {
          const bone = mesh.skeleton.bones[index];
          return { index, output: this.rig[part].outputBoneIndices.includes(index), bone, group: tuned.boneGroup.get(index) ?? null,
            strength: this.settings[part].strength, maxAngle: part === "hair" ? 0.7 : 0.3,
            basePosition: bone.position.clone(), baseQuaternion: bone.quaternion.clone(), baseWorldPosition: bone.getWorldPosition(new Vector3()),
            appliedPosition: bone.position.clone(), appliedQuaternion: bone.quaternion.clone(),
            previousOutputRotation: new Quaternion(), previousOutputOffset: new Vector3(),
            previousWorldPosition: new Vector3(), worldFrameDelta: new Vector3(), previousWorldValid: false,
            offset: new Vector3(), rotation: new Quaternion(),
            targetOffset: new Vector3(), targetRotation: new Quaternion(),
            filteredOffset: new Vector3(), filteredRotation: new Quaternion(),
            fromOffset: new Vector3(), fromRotation: new Quaternion(), restOffset: new Vector3(), restRotation: new Quaternion(), restValid: false,
            maxDisplacement: Math.max(0.02, bone.position.length() * (part === "hair" ? 0.35 : 0.12)) };
        }) };
    };
    this.parts = { hair: make("hair"), chest: make("chest") };
    for (const part of PARTS) this.applyGroupLimits(this.parts[part]);
  }

  /** The tuning, only when it was made for this model's rig (a stale one from a model switch is ignored). */
  private tuning() {
    const tuning = this.settings.tuning;
    return tuning && tuning.rig === this.rigSignature() ? tuning : undefined;
  }
  private rigSignature(): string {
    const meta = this.mesh.geometry.userData.MMD as { rigidBodies?: unknown[]; constraints?: unknown[] } | undefined;
    return `${meta?.rigidBodies?.length ?? 0}/${meta?.constraints?.length ?? 0}/${this.mesh.skeleton?.bones.length ?? 0}`;
  }
  private applicableTuningKey(): string { return tuningSignature(this.tuning()); }
  private rigOptions() { const collisions = this.tuning()?.collisions; return { chestArms: collisions?.chestArms, hairBody: collisions?.hairBody }; }
  private applyGroupLimits(runtime: PartRuntime): void {
    for (const layer of runtime.layers) {
      const group = layer.group ? runtime.tuned.groups.get(layer.group) : undefined;
      const base = runtime.part === "hair" ? 0.7 : 0.3;
      layer.maxAngle = group && group.engine === "ammo" ? Math.min(1.2, base * group.ammo.angleLimit) : base;
    }
  }

  configure(settings: ModelPhysicsSettings): void {
    if (this.disposed) return;
    const previous = this.settings;
    this.settings = normalizeModelPhysicsSettings(settings, previous);
    const key = this.applicableTuningKey();
    if (key !== this.tuningKey) this.retune(key);
    for (const part of PARTS) {
      const runtime = this.parts[part];
      if (this.settings[part].enabled && !previous[part].enabled) runtime.failed = false;
      if (previous.quality !== this.settings.quality) {
        runtime.elapsed = 0;
        runtime.scheduled = 0;
        if (runtime.backend) {
          const budget = this.budget(runtime);
          runtime.backend.unitStep = budget.unitStep;
          runtime.backend.maxStepNum = budget.maxSteps;
          runtime.targetSolverIterations = budget.solverIterations;
          runtime.qualityJustChanged = true;
        }
      }
    }
  }

  /**
   * The lab changed this model's tuning: rebuild the worlds and the spring chains, but keep what is shown (fade, current output);
   * the new solution eases in from there (R29: never snap). The simulated bone set is the model's, so the layers stay.
   */
  private retune(key: string): void {
    this.tuningKey = key;
    this.rig = buildPhysicsRigPlan(this.mesh, this.rigOptions());
    for (const part of PARTS) {
      const runtime = this.parts[part];
      runtime.rig = this.rig[part];
      runtime.tuned = tunePart(runtime.rig, part, this.tuning());
      for (const layer of runtime.layers) layer.group = runtime.tuned.boneGroup.get(layer.index) ?? null;
      this.applyGroupLimits(runtime);
      if (runtime.live) { this.releaseWorld(runtime); runtime.failed = false; }
    }
  }

  /**
   * R01: Bullet's fixed step must divide the solve quantum. MMD's 1/65 s does not divide 1/20, 1/30 or 1/60, so successive solves
   * advanced 2 or 3 steps (at 1/60: 1 or 0) and the result, read without interpolation, juddered: the braid's per-frame offset
   * change jumped up to 0.45 model units in a drag-and-stop at 30 fps. The step is now the largest that is at least as fine as
   * the requested rate (65 Hz, or the lab's) and fits the quantum a whole number of times (standard: 1/90 s, low 1/80, high 1/120);
   * a hair under exact so float rounding never drops a step.
   */
  private budget(runtime: PartRuntime) {
    const budget = MODEL_PHYSICS_BUDGETS[this.settings.quality], quantum = 1 / budget.updateHz;
    const steps = Math.max(1, Math.ceil(quantum / runtime.tuned.unitStep - 1e-9)), unitStep = quantum / steps * (1 - 1e-4);
    return { ...budget, unitStep, maxSteps: Math.max(budget.maxSteps, Math.ceil(MAX_FRAME_DT / unitStep) + 2) };
  }

  restore(): void {
    if (!this.applied) return;
    for (const part of PARTS) {
      const runtime = this.parts[part];
      if (!runtime.applied) continue;
      for (const layer of runtime.layers) {
        // The stage owns the writer order. Equality additionally avoids erasing
        // a replacement pose installed synchronously between animation ticks.
        if (layer.bone.position.equals(layer.appliedPosition)) layer.bone.position.copy(layer.basePosition);
        if (layer.bone.quaternion.equals(layer.appliedQuaternion)) layer.bone.quaternion.copy(layer.baseQuaternion);
      }
      runtime.applied = false;
    }
    this.applied = false;
    this.mesh.updateMatrixWorld(true);
  }

  frame(delta: number): void {
    this.solved = false;
    if (this.disposed || !this.visible) return;
    // Defensive duplicate-frame support. Normal stage order restores explicitly.
    this.restore();
    if (!Number.isFinite(delta) || delta < 0) return;
    if (delta === 0) {
      // Immediate outer-bridge rebuild: preserve output progress on the new
      // final base without a solver call, clock advance, or world allocation.
      for (const part of PARTS) {
        const runtime = this.parts[part];
        if (!runtime.live || runtime.fade <= 0) continue;
        this.captureBase(runtime);
        this.applyResult(runtime, false);
      }
      this.mesh.updateMatrixWorld(true);
      return;
    }
    const dt = Math.min(MAX_FRAME_DT, delta);
    const longFrame = delta > LONG_FRAME_DT;
    this.frameSerial++;
    this.mesh.updateMatrixWorld(true);
    for (const part of PARTS) {
      const runtime = this.parts[part];
      runtime.maxFrameAngle = 0;
      runtime.maxFrameDisplacement = 0;
      const requested = this.settings[part].enabled && this.settings[part].strength > 0 && runtime.rig.support.supported && !runtime.failed;
      if (!requested && !runtime.live) continue;
      if (requested && !runtime.live && !this.createRuntime(runtime)) continue;
      const step = dt / FADE_SECONDS;
      runtime.fade = requested ? Math.min(1, runtime.fade + step) : Math.max(0, runtime.fade - step);
      runtime.strength += (this.settings[part].strength - runtime.strength) * Math.min(1, dt / 0.12);
      for (const layer of runtime.layers) {
        const group = layer.group ? runtime.tuned.groups.get(layer.group) : undefined;
        const target = group?.strength ?? this.settings[part].strength;
        layer.strength += (target - layer.strength) * Math.min(1, dt / 0.12);
      }
      if (!requested && runtime.fade <= 0) {
        this.releaseRuntime(runtime);
        continue;
      }
      this.captureBase(runtime);
      if (!requested) {
        runtime.elapsed = 0;
        runtime.scheduled = 0;
        this.applyResult(runtime, true, dt);
        this.mesh.updateMatrixWorld(true);
        continue;
      }
      try {
        if (this.anchorJumped(runtime)) runtime.needsReset = true;
        if (runtime.needsReset) this.resetRuntime(runtime);
        else if (longFrame) {
          // Time passed, not necessarily a pose discontinuity. Keep settled
          // body transforms, discard stale momentum/time, and sample only the
          // bounded new tick. Re-seeding from the bind pose would kick hair.
          if (runtime.backend) this.clearRuntimeVelocity(runtime);
          runtime.elapsed = 0;
          runtime.scheduled = 0;
          this.freezeOutputTargets(runtime);
        }
        if (runtime.backend) this.solveAmmo(runtime, part, dt);
        this.solveSprings(runtime, dt);
        this.applyResult(runtime, true, dt);
      } catch {
        // Partial upstream writes are rolled back before the owner is released.
        for (const layer of runtime.layers) {
          layer.bone.position.copy(layer.basePosition);
          layer.bone.quaternion.copy(layer.baseQuaternion);
        }
        runtime.failed = true;
        this.releaseRuntime(runtime);
      }
      this.mesh.updateMatrixWorld(true);
    }
    // World motion includes the authored base. Interpret it as solver chatter
    // only during a deliberately held pose, never during a moving VMD.
    const worldPosition = new Vector3();
    for (const runtime of Object.values(this.parts)) {
      runtime.maxWorldFrameDisplacement = 0;
      for (const layer of runtime.layers) {
        if (!layer.output || !runtime.applied) continue;
        layer.bone.getWorldPosition(worldPosition);
        layer.worldFrameDelta.set(0, 0, 0);
        if (layer.previousWorldValid) {
          layer.worldFrameDelta.copy(worldPosition).sub(layer.previousWorldPosition);
          runtime.maxWorldFrameDisplacement = Math.max(runtime.maxWorldFrameDisplacement, layer.worldFrameDelta.length());
        }
        layer.previousWorldPosition.copy(worldPosition);
        layer.previousWorldValid = true;
      }
    }
  }

  private captureBase(runtime: PartRuntime): void {
    for (const layer of runtime.layers) {
      layer.basePosition.copy(layer.bone.position);
      layer.baseQuaternion.copy(layer.bone.quaternion);
      layer.bone.getWorldPosition(layer.baseWorldPosition);
    }
  }

  /**
   * Both parts advance Bullet in fixed quanta of 1/updateHz (Codex's P007: variable solver inputs excite chatter), at most
   * MAX_FRAME_DT per frame, re-seeding the part's bones from the final pose between batched solves, and read once.
   * R01: the chest used to solve with the variable elapsed time and show each result unchanged until the next solve: at 60 fps it
   * moved every other frame ("动了也比较卡"). It now interpolates between solves (applyResult).
   */
  private solveAmmo(runtime: PartRuntime, part: ModelPhysicsPart, dt: number): void {
    const quantum = 1 / MODEL_PHYSICS_BUDGETS[this.settings.quality].updateHz;
    runtime.elapsed = 0;
    runtime.scheduled = Math.min(quantum + MAX_FRAME_DT, runtime.scheduled + dt);
    const due = Math.min(Math.ceil(MAX_FRAME_DT / quantum), Math.floor((runtime.scheduled + 1e-8) / quantum));
    let advanced = 0;
    for (let solve = 0; solve < due; solve++) {
      if (solve > 0) {
        for (const layer of runtime.layers) { layer.bone.position.copy(layer.basePosition); layer.bone.quaternion.copy(layer.baseQuaternion); }
        this.mesh.updateMatrixWorld(true);
      }
      // Retain the existing constraint solution for the first new-quality
      // solve, then change its iteration budget gradually. This bounds the
      // abrupt warm-start transient without changing the final quality.
      if (runtime.qualityJustChanged) runtime.qualityJustChanged = false;
      else {
        const current = runtime.scope!.solverIterations, target = runtime.targetSolverIterations;
        if (current !== target) runtime.scope!.setSolverIterations(current + Math.sign(target - current) * Math.min(2, Math.abs(target - current)));
      }
      const started = performance.now();
      this.inPhysicsSpace(() => runtime.scope!.run(() => runtime.backend!.update(quantum)));
      runtime.stepMs = Math.max(0, performance.now() - started);
      this.measuredMs += runtime.stepMs; this.measurements++; this.solved = true;
      runtime.scheduled = Math.max(0, runtime.scheduled - quantum); advanced += quantum;
    }
    if (advanced > 0) this.readResult(runtime, part, advanced);
  }

  /** The lab's spring-bone groups (experimental): every rendered frame, from the final pose, after Ammo wrote its bones. */
  private solveSprings(runtime: PartRuntime, dt: number): void {
    if (!runtime.springs.length) return;
    // Spring bones read the animated pose of their own bones (kinematic in Ammo, so untouched there).
    const started = performance.now();
    for (const spring of runtime.springs) {
      const settings = runtime.tuned.groups.get(spring.id)!.springBone;
      spring.chain.step(dt, settings);
      spring.blend = Math.min(1, spring.blend + dt / SPRING_BLEND_SECONDS);
    }
    runtime.springMs = performance.now() - started;
    this.measuredMs += runtime.springMs; this.measurements++; this.solved = true;
    for (const spring of runtime.springs) {
      for (const layer of runtime.layers) {
        if (layer.group !== spring.id) continue;
        const solved = spring.chain.output.get(layer.index);
        if (!solved) continue;
        const angle = IDENTITY.angleTo(solved), limit = layer.maxAngle * 2;
        const target = angle > limit ? solved.clone().slerp(IDENTITY, 1 - limit / angle) : solved;
        // Blend in from what is shown, then follow exactly (the solver itself is continuous).
        layer.rotation.slerp(target, spring.blend);
        layer.targetRotation.copy(layer.rotation); layer.filteredRotation.copy(layer.rotation);
        layer.offset.set(0, 0, 0); layer.targetOffset.set(0, 0, 0); layer.filteredOffset.set(0, 0, 0);
      }
    }
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.restore();
    this.visible = visible;
    this.solved = false;
    if (!visible) for (const part of PARTS) this.releaseRuntime(this.parts[part]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore();
    for (const part of PARTS) this.releaseRuntime(this.parts[part]);
    this.disposed = true;
    this.solved = false;
  }

  getState(): ModelPhysicsState & {
    readonly createdObjects: number; readonly destroyedObjects: number; readonly cleanupFailures: number;
    readonly solverIterationWork: number; readonly totalStepMs: number; readonly solveCalls: number;
    /** Retained WASM capacity, not live allocation size or operating-system RSS. */
    readonly heapCapacityBytes: number | null;
  } {
    const runtimes = PARTS.map(part => this.parts[part]);
    const active = runtimes.filter(runtime => runtime.live);
    const enabled = { hair: this.settings.hair.enabled, chest: this.settings.chest.enabled };
    const requested = PARTS.filter(part => enabled[part]);
    const supportedRequested = requested.some(part => this.rig.support[part].supported);
    const failed = runtimes.some(runtime => runtime.failed) || this.cleanupFailures > 0;
    const heap = this.ammo.HEAP8;
    const status = this.disposed ? "disposed" : !this.visible ? "hidden" : failed ? "error"
      : !requested.length ? "off" : !supportedRequested ? "unsupported" : this.solved ? "running" : "ready";
    return {
      support: { hair: { ...this.rig.support.hair }, chest: { ...this.rig.support.chest } }, enabled,
      running: !this.disposed && this.visible && active.length > 0 && supportedRequested,
      quality: this.settings.quality, status,
      bodyCount: active.reduce((sum, runtime) => sum + (runtime.backend ? runtime.rig.rigidBodies.length : 0), 0),
      constraintCount: active.reduce((sum, runtime) => sum + (runtime.backend ? runtime.rig.constraints.length : 0), 0),
      liveObjects: this.retiredLiveObjects + runtimes.reduce((sum, runtime) => sum + (runtime.scope?.liveObjects ?? 0), 0),
      createdObjects: this.retiredCreated + runtimes.reduce((sum, runtime) => sum + (runtime.scope?.created ?? 0), 0),
      destroyedObjects: this.retiredDestroyed + runtimes.reduce((sum, runtime) => sum + (runtime.scope?.destroyed ?? 0), 0),
      steps: this.retiredSteps + runtimes.reduce((sum, runtime) => sum + (runtime.scope?.steps ?? 0), 0),
      solverIterationWork: this.retiredIterationWork + runtimes.reduce((sum, runtime) => sum + (runtime.scope?.iterationWork ?? 0), 0),
      avgStepMs: this.measurements ? this.measuredMs / this.measurements : 0,
      totalStepMs: this.measuredMs,
      solveCalls: this.measurements,
      cleanupFailures: this.cleanupFailures,
      heapCapacityBytes: ArrayBuffer.isView(heap) ? heap.byteLength : null,
    };
  }

  /** Actual weighted display deltas, suitable for bounded native QA evidence (physics-diagnostics.ts). */
  getDiagnostics(camera?: Camera, viewport?: { width: number; height: number }): Record<ModelPhysicsPart, PartDiagnostics> {
    const part = (key: ModelPhysicsPart) => {
      const runtime = this.parts[key];
      return partDiagnostics(runtime.layers, runtime.applied && runtime.live ? runtime.fade * runtime.strength : 0, runtime.applied, camera, viewport, {
        stepMs: runtime.stepMs, springMs: runtime.springMs, solverIterations: runtime.scope?.solverIterations ?? 0, frameSerial: this.frameSerial,
        maxFrameAngle: runtime.maxFrameAngle, maxFrameDisplacement: runtime.maxFrameDisplacement,
        maxWorldFrameDisplacement: runtime.maxWorldFrameDisplacement, outputBoneCount: runtime.rig.outputBoneIndices.length });
    };
    return { hair: part("hair"), chest: part("chest") };
  }

  private createRuntime(runtime: PartRuntime): boolean {
    runtime.live = true;
    runtime.needsReset = true;
    if (!runtime.tuned.ammoNeeded) { this.createSprings(runtime); return true; }
    const scope = new OwnedAmmoScope(this.ammo);
    runtime.scope = scope;
    const parent = this.mesh.parent;
    const position = this.mesh.position.clone(), quaternion = this.mesh.quaternion.clone(), scale = this.mesh.scale.clone();
    const bones = this.mesh.skeleton.bones.map(bone => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }));
    try {
      // Joint frames are specified in the bind pose. Construct there, restore the
      // live final pose, then reset only the fresh world to its current anchors.
      this.mesh.skeleton.pose();
      this.mesh.updateMatrixWorld(true);
      const budget = this.budget(runtime);
      runtime.backend = scope.run(() => this.factory(this.mesh, runtime.tuned.rig, budget));
      this.applyGravity(runtime);
      scope.setSolverIterations(budget.solverIterations);
      runtime.targetSolverIterations = budget.solverIterations;
      runtime.qualityJustChanged = false;
      this.createSprings(runtime);
      return true;
    } catch {
      runtime.failed = true;
      this.releaseRuntime(runtime);
      return false;
    } finally {
      this.mesh.parent = parent;
      this.mesh.position.copy(position);
      this.mesh.quaternion.copy(quaternion);
      this.mesh.scale.copy(scale);
      for (const saved of bones) {
        saved.bone.position.copy(saved.position);
        saved.bone.quaternion.copy(saved.quaternion);
        saved.bone.scale.copy(saved.scale);
      }
      this.mesh.updateMatrixWorld(true);
    }
  }

  /** The lab's per-group gravity (Bullet sets a body's gravity when it is added; this overrides it after). */
  private applyGravity(runtime: PartRuntime): void {
    const factors = runtime.tuned.gravity;
    if (factors.every(factor => factor === 1)) return;
    const backend = runtime.backend as LocalPhysicsBackend & { bodies?: { body: NativeObject }[]; gravity?: Vector3 };
    const gravity = backend.gravity ?? new Vector3(0, -98, 0);
    runtime.scope!.run(() => {
      const Vector = runtime.scope!.module.btVector3;
      if (typeof Vector !== "function" || !backend.bodies) return;
      backend.bodies.forEach(({ body }, index) => {
        const factor = factors[index] ?? 1;
        if (factor === 1 || typeof body.setGravity !== "function") return;
        const vector = Reflect.construct(Vector, [gravity.x * factor, gravity.y * factor, gravity.z * factor]);
        Reflect.apply(body.setGravity as NativeMethod, body, [vector]);
      });
    });
  }

  private createSprings(runtime: PartRuntime): void {
    runtime.springs = [];
    const raw = (this.mesh.geometry.userData.MMD as { rigidBodies?: Record<string, unknown>[] } | undefined)?.rigidBodies ?? [];
    // The model's own body colliders, except the ones the part hangs from (hair roots start inside the head).
    const anchors = new Set(runtime.rig.anchorBoneIndices);
    const colliders = runtime.rig.sourceBodyIndices.filter((source, index) => runtime.rig.rigidBodies[index].type === 0 && raw[source]?.type === 0
      && !anchors.has(runtime.rig.rigidBodies[index].boneIndex));
    for (const [id, group] of runtime.tuned.groups) {
      if (!group.enabled || group.engine !== "spring") continue;
      const bones = runtime.tuned.groupBones.get(id) ?? [];
      const chain = new SpringBoneChain(this.mesh, bones, raw, colliders);
      if (chain.size) runtime.springs.push({ id, chain, blend: 0 });
    }
  }

  private resetRuntime(runtime: PartRuntime): void {
    if (runtime.backend) {
      this.inPhysicsSpace(() => runtime.scope!.run(() => runtime.backend!.reset()));
      this.clearRuntimeVelocity(runtime);
    }
    for (const spring of runtime.springs) spring.chain.reset();
    runtime.elapsed = 0;
    runtime.scheduled = 0;
    runtime.needsReset = false;
    // A pose discontinuity resets the solver, not the bounded visible layer.
    // Fresh worlds already start at zero; existing output eases to the new pose.
    this.freezeOutputTargets(runtime);
    runtime.anchorPositions = runtime.rig.anchorBoneIndices.map(index => this.mesh.skeleton.bones[index].getWorldPosition(new Vector3()));
    runtime.anchorRotations = runtime.rig.anchorBoneIndices.map(index => this.mesh.skeleton.bones[index].getWorldQuaternion(new Quaternion()));
  }

  private freezeOutputTargets(runtime: PartRuntime): void {
    for (const layer of runtime.layers) {
      layer.targetRotation.copy(layer.rotation); layer.filteredRotation.copy(layer.rotation); layer.fromRotation.copy(layer.rotation);
      layer.targetOffset.copy(layer.offset); layer.filteredOffset.copy(layer.offset); layer.fromOffset.copy(layer.offset);
    }
  }

  private clearRuntimeVelocity(runtime: PartRuntime): void {
    // reset() sets transforms but upstream retains velocity. Clear it through
    // body handles owned by this scope, rather than advancing hidden time.
    const backend = runtime.backend as LocalPhysicsBackend & { bodies?: { body: NativeObject }[] };
    runtime.scope!.run(() => {
      const Vector = runtime.scope!.module.btVector3;
      if (typeof Vector !== "function" || !backend.bodies) return;
      const zero = runtime.zeroVelocity ??= Reflect.construct(Vector, [0, 0, 0]);
      for (const { body } of backend.bodies) {
        for (const name of ["setLinearVelocity", "setAngularVelocity", "clearForces"]) {
          if (typeof body[name] === "function") Reflect.apply(body[name] as NativeMethod, body, name === "clearForces" ? [] : [zero]);
        }
      }
      // The scope owns zero until world teardown; all resets reuse this object.
    });
  }

  private inPhysicsSpace<T>(callback: () => T): T {
    const parent = this.mesh.parent, scale = this.mesh.scale.clone();
    const worldScale = this.mesh.getWorldScale(new Vector3());
    const normalize = worldScale.x !== 1 || worldScale.y !== 1 || worldScale.z !== 1;
    try {
      // Match r170 update() for reset() as well; do not seed dynamic bodies in
      // scaled space while the next kinematic update uses an unscaled space.
      if (normalize) {
        this.mesh.parent = null;
        this.mesh.scale.set(1, 1, 1);
        this.mesh.updateMatrixWorld(true);
      }
      return callback();
    } finally {
      this.mesh.parent = parent;
      this.mesh.scale.copy(scale);
      this.mesh.updateMatrixWorld(true);
    }
  }

  private anchorJumped(runtime: PartRuntime): boolean {
    let jumped = false;
    const position = new Vector3(), rotation = new Quaternion();
    const limit = Math.max(0.5, ...runtime.layers.map(layer => layer.maxDisplacement * 8));
    runtime.rig.anchorBoneIndices.forEach((index, i) => {
      const bone = this.mesh.skeleton.bones[index];
      bone.getWorldPosition(position);
      bone.getWorldQuaternion(rotation);
      const oldPosition = runtime.anchorPositions[i], oldRotation = runtime.anchorRotations[i];
      if (oldPosition && (oldPosition.distanceTo(position) > limit || oldRotation.angleTo(rotation) > Math.PI / 3)) jumped = true;
      if (oldPosition) oldPosition.copy(position);
      if (oldRotation) oldRotation.copy(rotation);
    });
    return jumped;
  }

  private readResult(runtime: PartRuntime, part: ModelPhysicsPart, dt: number): void {
    const targetRotation = new Quaternion(), targetOffset = new Vector3(), raw = new Vector3();
    const rest = Math.min(1, dt / CHEST_REST_SECONDS);
    for (const layer of runtime.layers) {
      if (!validPosition(layer.bone.position) || !validQuaternion(layer.bone.quaternion)) {
        runtime.needsReset = true;
        layer.targetRotation.copy(layer.rotation); layer.filteredRotation.copy(layer.rotation); layer.fromRotation.copy(layer.rotation);
        layer.targetOffset.copy(layer.offset); layer.filteredOffset.copy(layer.offset); layer.fromOffset.copy(layer.offset);
        continue;
      }
      // Auxiliary bodies stay dynamic in Bullet, but their unweighted bones do
      // not become another presentation channel. All writes are still restored.
      if (!layer.output) { layer.offset.set(0, 0, 0); layer.rotation.identity(); continue; }
      if (runtime.springs.some(spring => spring.id === layer.group)) continue;
      targetRotation.copy(layer.baseQuaternion).invert().multiply(layer.bone.quaternion).normalize();
      raw.copy(layer.bone.position).sub(layer.basePosition);
      if (part === "hair") {
        // Capture only at solver ticks. Every displayed frame resamples this
        // bounded target, including frames between low-quality solver calls.
        layer.targetRotation.copy(capAngle(targetRotation, layer.maxAngle));
        layer.targetOffset.copy(raw).clampLength(0, layer.maxDisplacement);
        continue;
      }
      // R01 chest: the bound applies to the motion around the part's own (slowly tracked) rest offset, and separately to that
      // offset. A model whose joints hold the chest off the bone at rest (the private model: 0.2 units, beyond the 0.126 bound)
      // otherwise sat pinned at the bound and every bit of motion was clipped away ("几乎不动"). T-251: the rotation the same way
      // (the private model's bust rests turned 0.245 rad of its 0.3 rad bound), physics-rest-split.ts.
      if (!layer.restValid) { layer.restOffset.copy(raw); layer.restRotation.copy(targetRotation); layer.restValid = true; }
      else { layer.restOffset.lerp(raw, rest); layer.restRotation.slerp(targetRotation, rest); }
      boundAroundRest(raw, layer.restOffset, layer.maxDisplacement, targetOffset);
      layer.fromRotation.copy(layer.rotation); layer.fromOffset.copy(layer.offset);
      boundAroundRest(targetRotation, layer.restRotation, layer.maxAngle, layer.targetRotation); layer.targetOffset.copy(targetOffset);
    }
    runtime.sinceSolve = 0;
  }

  private applyResult(runtime: PartRuntime, recordFrame = true, dt = 0): void {
    const outputRotation = new Quaternion(), outputOffset = new Vector3(), shown = new Quaternion();
    const spring = new Set(runtime.springs.map(entry => entry.id));
    let blend = 1;
    if (runtime.rig.part === "chest" && dt > 0) {
      runtime.sinceSolve += dt;
      blend = Math.min(1, runtime.sinceSolve * MODEL_PHYSICS_BUDGETS[this.settings.quality].updateHz);
    }
    for (const layer of runtime.layers) {
      const weight = runtime.fade * layer.strength;
      if (layer.output && dt > 0 && !(layer.group && spring.has(layer.group))) {
        if (runtime.rig.part === "hair") {
          const alpha = 1 - Math.exp(-dt / HAIR_FILTER_SECONDS);
          layer.filteredRotation.slerp(layer.targetRotation, alpha);
          layer.filteredOffset.lerp(layer.targetOffset, alpha);
          const angle = layer.rotation.angleTo(layer.filteredRotation);
          layer.rotation.rotateTowards(layer.filteredRotation, Math.min(0.35, dt * 8, angle * alpha));
          const distance = layer.offset.distanceTo(layer.filteredOffset);
          const speed = layer.maxDisplacement * 8 * dt;
          layer.offset.lerp(layer.filteredOffset, distance > 0 ? Math.min(alpha, speed / distance) : 0);
        } else {
          // Chest: from the shown output at the last solve to the new target, across one solver quantum (one quantum late,
          // never a step), with the old per-frame rate bound as a guard.
          shown.slerpQuaternions(layer.fromRotation, layer.targetRotation, blend);
          layer.rotation.rotateTowards(shown, Math.min(0.35, dt * 8));
          const target = outputOffset.copy(layer.fromOffset).lerp(layer.targetOffset, blend);
          const distance = layer.offset.distanceTo(target), speed = layer.maxDisplacement * 8 * dt;
          layer.offset.lerp(target, distance > speed && distance > 0 ? speed / distance : 1);
        }
      }
      layer.bone.position.copy(layer.basePosition).addScaledVector(layer.offset, weight);
      layer.bone.quaternion.slerpQuaternions(IDENTITY, layer.rotation, weight).premultiply(layer.baseQuaternion).normalize();
      layer.appliedPosition.copy(layer.bone.position);
      layer.appliedQuaternion.copy(layer.bone.quaternion);
      if (recordFrame && layer.output) {
        outputRotation.slerpQuaternions(IDENTITY, layer.rotation, weight);
        outputOffset.copy(layer.offset).multiplyScalar(weight);
        runtime.maxFrameAngle = Math.max(runtime.maxFrameAngle, layer.previousOutputRotation.angleTo(outputRotation));
        runtime.maxFrameDisplacement = Math.max(runtime.maxFrameDisplacement, layer.previousOutputOffset.distanceTo(outputOffset));
        layer.previousOutputRotation.copy(outputRotation);
        layer.previousOutputOffset.copy(outputOffset);
      }
    }
    this.applied = true;
    runtime.applied = true;
  }

  /** Frees the Ammo world and the spring chains; the shown output stays (a retune eases from it). */
  private releaseWorld(runtime: PartRuntime): void {
    if (runtime.scope) {
      runtime.scope.dispose();
      this.retiredCreated += runtime.scope.created;
      this.retiredDestroyed += runtime.scope.destroyed;
      this.retiredSteps += runtime.scope.steps;
      this.retiredIterationWork += runtime.scope.iterationWork;
      this.retiredLiveObjects += runtime.scope.liveObjects;
      this.cleanupFailures += runtime.scope.cleanupFailures;
    }
    runtime.scope = undefined;
    runtime.backend = undefined;
    runtime.springs = [];
    runtime.live = false;
    runtime.zeroVelocity = undefined;
    runtime.elapsed = 0;
    runtime.scheduled = 0;
    runtime.stepMs = 0;
    runtime.springMs = 0;
    runtime.needsReset = true;
    runtime.anchorPositions = [];
    runtime.anchorRotations = [];
    runtime.qualityJustChanged = false;
    for (const layer of runtime.layers) layer.restValid = false;
  }

  private releaseRuntime(runtime: PartRuntime): void {
    this.releaseWorld(runtime);
    runtime.applied = false;
    runtime.fade = 0;
    runtime.maxFrameAngle = 0;
    runtime.maxFrameDisplacement = 0;
    runtime.maxWorldFrameDisplacement = 0;
    for (const layer of runtime.layers) {
      layer.offset.set(0, 0, 0); layer.rotation.identity();
      layer.targetOffset.set(0, 0, 0); layer.targetRotation.identity();
      layer.filteredOffset.set(0, 0, 0); layer.filteredRotation.identity();
      layer.fromOffset.set(0, 0, 0); layer.fromRotation.identity();
      layer.previousOutputRotation.identity(); layer.previousOutputOffset.set(0, 0, 0);
      layer.previousWorldValid = false;
      layer.worldFrameDelta.set(0, 0, 0);
    }
  }
}
