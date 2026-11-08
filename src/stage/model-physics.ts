import { Quaternion, Vector3, type Bone, type Camera, type SkinnedMesh } from "three";
import { MMDPhysics } from "three/examples/jsm/animation/MMDPhysics.js";
import {
  normalizeModelPhysicsSettings,
  type ModelPhysicsPart,
  type ModelPhysicsQuality,
  type ModelPhysicsSettings,
  type ModelPhysicsState,
} from "../../shared/model-physics";
import type { AmmoModule } from "./ammo-runtime";
import { buildPhysicsRigPlan, type PhysicsPartRig, type PhysicsRigPlan } from "./physics-rig";

export { buildPhysicsRigPlan, probeModelPhysicsSupport } from "./physics-rig";

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
const IDENTITY = new Quaternion();

type NativeObject = Record<string, unknown>;
type NativeMethod = (...args: unknown[]) => unknown;

function nativeMethod(value: NativeObject, name: string): NativeMethod {
  const method = value[name];
  if (typeof method !== "function") throw new Error(`Local physics requires ${name}.`);
  return method as NativeMethod;
}

interface OwnedWorld {
  object: NativeObject;
  bodies: Set<unknown>;
  constraints: Set<unknown>;
  solverIterations: number;
}

/**
 * r170 has no physics disposer. Only constructor results are owned; borrowed
 * getters/wrapPointer results are intentionally never tracked or destroyed.
 */
export class OwnedAmmoScope {
  readonly module: AmmoModule;
  private readonly allocations: object[] = [];
  private readonly owned = new Set<object>();
  private readonly worlds: OwnedWorld[] = [];
  private readonly constructors = new Map<PropertyKey, unknown>();
  private disposed = false;
  created = 0;
  destroyed = 0;
  steps = 0;
  iterationWork = 0;
  cleanupFailures = 0;

  constructor(private readonly ammo: AmmoModule) {
    this.module = new Proxy(ammo, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (key === "destroy") return (object: object) => this.destroyOwned(object);
        if (typeof key !== "string" || !key.startsWith("bt") || typeof value !== "function") return value;
        if (!this.constructors.has(key)) {
          this.constructors.set(key, new Proxy(value, {
            construct: (constructor, args) => {
              if (this.disposed) throw new Error("Local physics scope has been disposed.");
              const object = Reflect.construct(constructor, args) as object;
              this.allocations.push(object);
              this.owned.add(object);
              this.created++;
              if (key === "btDiscreteDynamicsWorld") this.trackWorld(object as NativeObject);
              return object;
            },
          }));
        }
        return this.constructors.get(key);
      },
    });
  }

  get liveObjects(): number { return this.owned.size; }
  get solverIterations(): number { return this.worlds[0]?.solverIterations ?? 0; }

  setSolverIterations(iterations: number): void {
    if (!this.worlds.length) throw new Error("Local physics has no owned solver world.");
    for (const world of this.worlds) {
      const info = Reflect.apply(nativeMethod(world.object, "getSolverInfo"), world.object, []) as NativeObject;
      Reflect.apply(nativeMethod(info, "set_m_numIterations"), info, [iterations]);
      const actual = Reflect.apply(nativeMethod(info, "get_m_numIterations"), info, []);
      if (actual !== iterations) throw new Error("Local physics solver budget could not be verified.");
      // getSolverInfo is a borrowed world-owned view, not a new allocation.
      world.solverIterations = iterations;
    }
  }

  /** Synchronous only: no global module is installed across an await boundary. */
  run<T>(callback: () => T): T {
    if (this.disposed) throw new Error("Local physics scope has been disposed.");
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Ammo");
    try {
      // Classic Ammo can leave a nonconfigurable but writable global var.
      if (previous) Object.defineProperty(globalThis, "Ammo", { value: this.module });
      else Object.defineProperty(globalThis, "Ammo", { value: this.module, configurable: true, writable: true });
      return callback();
    } finally {
      if (previous) Object.defineProperty(globalThis, "Ammo", previous);
      else Reflect.deleteProperty(globalThis, "Ammo");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Remove world references before releasing bodies, shapes, motion states,
    // constraint frames, cached vectors, dispatchers, solver, or the world.
    for (const world of this.worlds) {
      for (const constraint of [...world.constraints]) this.clean(() => {
        Reflect.apply(nativeMethod(world.object, "removeConstraint"), world.object, [constraint]);
      });
      for (const body of [...world.bodies]) this.clean(() => {
        Reflect.apply(nativeMethod(world.object, "removeRigidBody"), world.object, [body]);
      });
    }
    // If native removal failed, retaining these objects is safer than freeing a
    // body still referenced by Bullet. The nonzero diagnostic remains visible.
    if (this.worlds.some(world => world.bodies.size || world.constraints.size)) return;
    for (let index = this.allocations.length - 1; index >= 0; index--) {
      const object = this.allocations[index];
      if (!this.owned.has(object)) continue;
      try { this.destroyOwned(object); } catch { this.cleanupFailures++; break; }
    }
    this.allocations.length = 0;
    this.worlds.length = 0;
    this.constructors.clear();
  }

  private clean(callback: () => void): void {
    try { callback(); } catch { this.cleanupFailures++; }
  }

  private destroyOwned(object: object): void {
    if (!this.owned.has(object)) return;
    this.ammo.destroy(object);
    this.owned.delete(object);
    this.destroyed++;
  }

  private trackWorld(object: NativeObject): void {
    const world: OwnedWorld = { object, bodies: new Set(), constraints: new Set(), solverIterations: 0 };
    // Register before wrapping: a partial constructor/setup failure is owned too.
    this.worlds.push(world);
    for (const [addName, removeName, members] of [
      ["addRigidBody", "removeRigidBody", world.bodies],
      ["addConstraint", "removeConstraint", world.constraints],
    ] as const) {
      const add = nativeMethod(object, addName), remove = nativeMethod(object, removeName);
      object[addName] = (...args: unknown[]) => {
        const result = Reflect.apply(add, object, args);
        members.add(args[0]);
        return result;
      };
      object[removeName] = (...args: unknown[]) => {
        const result = Reflect.apply(remove, object, args);
        members.delete(args[0]);
        return result;
      };
    }
    const step = nativeMethod(object, "stepSimulation");
    object.stepSimulation = (...args: unknown[]) => {
      const result = Reflect.apply(step, object, args);
      const limit = typeof args[1] === "number" ? args[1] : 1;
      if (typeof result === "number" && Number.isFinite(result)) {
        const steps = Math.max(0, Math.min(limit, result));
        this.steps += steps;
        this.iterationWork += steps * world.solverIterations;
      }
      return result;
    };
  }
}

export interface LocalPhysicsBackend {
  unitStep: number;
  maxStepNum: number;
  update(dt: number): unknown;
  reset(): unknown;
}

/** Internal synchronous dependency seam for lifecycle tests; no renderer input. */
export type LocalPhysicsFactory = (
  mesh: SkinnedMesh, rig: PhysicsPartRig, budget: typeof MODEL_PHYSICS_BUDGETS[ModelPhysicsQuality],
) => LocalPhysicsBackend;

const defaultFactory: LocalPhysicsFactory = (mesh, rig, budget) => new MMDPhysics(
  mesh, [...rig.rigidBodies], [...rig.constraints], { unitStep: budget.unitStep, maxStepNum: budget.maxSteps },
);

interface BoneLayer {
  index: number;
  output: boolean;
  bone: Bone;
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
  maxDisplacement: number;
}

interface PartRuntime {
  rig: PhysicsPartRig;
  layers: BoneLayer[];
  scope?: OwnedAmmoScope;
  backend?: LocalPhysicsBackend;
  fade: number;
  strength: number;
  elapsed: number;
  scheduled: number;
  stepMs: number;
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
  private readonly rig: PhysicsRigPlan;
  private readonly parts: Record<ModelPhysicsPart, PartRuntime>;
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
    this.rig = buildPhysicsRigPlan(mesh);
    const make = (part: ModelPhysicsPart): PartRuntime => ({
      rig: this.rig[part], fade: 0, strength: this.settings[part].strength,
      elapsed: 0, scheduled: 0, stepMs: 0, needsReset: true, failed: false, applied: false, anchorPositions: [], anchorRotations: [],
      maxFrameAngle: 0, maxFrameDisplacement: 0, maxWorldFrameDisplacement: 0,
      targetSolverIterations: MODEL_PHYSICS_BUDGETS[this.settings.quality].solverIterations, qualityJustChanged: false,
      layers: this.rig[part].dynamicBoneIndices.map(index => {
        const bone = mesh.skeleton.bones[index];
        return { index, output: this.rig[part].outputBoneIndices.includes(index), bone,
          basePosition: bone.position.clone(), baseQuaternion: bone.quaternion.clone(), baseWorldPosition: bone.getWorldPosition(new Vector3()),
          appliedPosition: bone.position.clone(), appliedQuaternion: bone.quaternion.clone(),
          previousOutputRotation: new Quaternion(), previousOutputOffset: new Vector3(),
          previousWorldPosition: new Vector3(), worldFrameDelta: new Vector3(), previousWorldValid: false,
          offset: new Vector3(), rotation: new Quaternion(),
          targetOffset: new Vector3(), targetRotation: new Quaternion(),
          filteredOffset: new Vector3(), filteredRotation: new Quaternion(),
          maxDisplacement: Math.max(0.02, bone.position.length() * (part === "hair" ? 0.35 : 0.12)) };
      }),
    });
    this.parts = { hair: make("hair"), chest: make("chest") };
  }

  configure(settings: ModelPhysicsSettings): void {
    if (this.disposed) return;
    const previous = this.settings;
    this.settings = normalizeModelPhysicsSettings(settings, previous);
    for (const part of PARTS) {
      const runtime = this.parts[part];
      if (this.settings[part].enabled && !previous[part].enabled) runtime.failed = false;
      if (previous.quality !== this.settings.quality) {
        runtime.elapsed = 0;
        runtime.scheduled = 0;
        if (runtime.backend) {
          const budget = MODEL_PHYSICS_BUDGETS[this.settings.quality];
          runtime.backend.unitStep = budget.unitStep;
          runtime.backend.maxStepNum = budget.maxSteps;
          runtime.targetSolverIterations = budget.solverIterations;
          runtime.qualityJustChanged = true;
        }
      }
    }
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
        if (!runtime.backend || runtime.fade <= 0) continue;
        for (const layer of runtime.layers) {
          layer.basePosition.copy(layer.bone.position);
          layer.baseQuaternion.copy(layer.bone.quaternion);
          layer.bone.getWorldPosition(layer.baseWorldPosition);
        }
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
      if (!requested && !runtime.backend) continue;
      if (requested && !runtime.backend && !this.createRuntime(runtime)) continue;
      const step = dt / FADE_SECONDS;
      runtime.fade = requested ? Math.min(1, runtime.fade + step) : Math.max(0, runtime.fade - step);
      runtime.strength += (this.settings[part].strength - runtime.strength) * Math.min(1, dt / 0.12);
      if (!requested && runtime.fade <= 0) {
        this.releaseRuntime(runtime);
        continue;
      }
      for (const layer of runtime.layers) {
        layer.basePosition.copy(layer.bone.position);
        layer.baseQuaternion.copy(layer.bone.quaternion);
        layer.bone.getWorldPosition(layer.baseWorldPosition);
      }
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
          this.clearRuntimeVelocity(runtime);
          runtime.elapsed = 0;
          runtime.scheduled = 0;
          this.freezeOutputTargets(runtime);
        }

        if (part === 'hair') {
          const budget = MODEL_PHYSICS_BUDGETS[this.settings.quality];
          const quantum = 1 / budget.updateHz;
          runtime.elapsed = 0;
          runtime.scheduled = Math.min(quantum + MAX_FRAME_DT, runtime.scheduled + dt);
          const due = Math.min(Math.ceil(MAX_FRAME_DT / quantum), Math.floor((runtime.scheduled + 1e-8) / quantum));
          let advanced = 0;
          for (let solve = 0; solve < due; solve++) {
            if (solve > 0) {
              for (const layer of runtime.layers) {
                layer.bone.position.copy(layer.basePosition); layer.bone.quaternion.copy(layer.baseQuaternion);
              }
              this.mesh.updateMatrixWorld(true);
            }

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
        } else {
        runtime.elapsed = Math.min(0.1, runtime.elapsed + dt);
        runtime.scheduled += dt;
        const budget = MODEL_PHYSICS_BUDGETS[this.settings.quality];
        if (requested && runtime.scheduled + 1e-8 >= 1 / budget.updateHz) {
          const elapsed = runtime.elapsed;
          runtime.elapsed = 0; // At most one bounded solve; never catch up in a loop.
          runtime.scheduled = Math.max(0, runtime.scheduled - 1 / budget.updateHz) % (1 / budget.updateHz);
          // Retain the existing constraint solution for the first new-quality
          // solve, then change its iteration budget gradually. This bounds the
          // abrupt warm-start transient without changing the final quality.
          if (runtime.qualityJustChanged) runtime.qualityJustChanged = false;
          else {
            const current = runtime.scope!.solverIterations, target = runtime.targetSolverIterations;
            if (current !== target) runtime.scope!.setSolverIterations(current + Math.sign(target - current) * Math.min(2, Math.abs(target - current)));
          }
          const started = performance.now();
          this.inPhysicsSpace(() => {
            runtime.scope!.run(() => runtime.backend!.update(elapsed));
          });
          runtime.stepMs = Math.max(0, performance.now() - started);
          this.measuredMs += runtime.stepMs;
          this.measurements++;
          this.solved = true;
          this.readResult(runtime, part, elapsed);
        }

        }
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
    const active = runtimes.filter(runtime => runtime.backend);
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
      bodyCount: active.reduce((sum, runtime) => sum + runtime.rig.rigidBodies.length, 0),
      constraintCount: active.reduce((sum, runtime) => sum + runtime.rig.constraints.length, 0),
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

  /** Actual weighted display deltas, suitable for bounded native QA evidence. */
  getDiagnostics(camera?: Camera, viewport?: { width: number; height: number }): Record<ModelPhysicsPart, {
    weight: number; maxAngle: number; maxDisplacement: number; stepMs: number; solverIterations: number;
    frameSerial: number; maxFrameAngle: number; maxFrameDisplacement: number;
    /** Actual scene/world units at the current model scale, not screen pixels. */
    maxWorldDownward: number; maxWorldFrameDisplacement: number; outputBoneCount: number;
    maxScreenFrameDisplacementDip: number | null; screenSampleCount: number;
    samples: { boneIndex: number; localQuatDelta: number[]; positionDelta: number[] }[];
  }> {
    const part = (key: ModelPhysicsPart) => {
      const runtime = this.parts[key];
      const weight = runtime.applied && runtime.backend ? runtime.fade * runtime.strength : 0;
      let maxAngle = 0, maxDisplacement = 0, maxWorldDownward = 0;
      const worldPosition = new Vector3();
      const currentScreen = new Vector3(), previousScreen = new Vector3();
      const projectionAvailable = camera && viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
        && viewport.width > 0 && viewport.height > 0;
      let maxScreenFrameDisplacementDip: number | null = null, screenSampleCount = 0;
      const samples: { boneIndex: number; localQuatDelta: number[]; positionDelta: number[] }[] = [];
      for (const layer of runtime.layers) {
        if (!layer.output) continue;
        const rotation = weight > 0 ? layer.baseQuaternion.clone().invert().multiply(layer.appliedQuaternion).normalize() : new Quaternion();
        const offset = weight > 0 ? layer.appliedPosition.clone().sub(layer.basePosition) : new Vector3();
        maxAngle = Math.max(maxAngle, IDENTITY.angleTo(rotation));
        maxDisplacement = Math.max(maxDisplacement, offset.length());
        if (weight > 0) maxWorldDownward = Math.max(maxWorldDownward,
          layer.baseWorldPosition.y - layer.bone.getWorldPosition(worldPosition).y);
        if (projectionAvailable && layer.previousWorldValid && runtime.applied) {
          currentScreen.copy(layer.previousWorldPosition).project(camera);
          previousScreen.copy(layer.previousWorldPosition).sub(layer.worldFrameDelta).project(camera);
          const inView = (p: Vector3) => validPosition(p) && p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
          if (inView(currentScreen) && inView(previousScreen)) {
            const distance = Math.hypot((currentScreen.x - previousScreen.x) * viewport.width / 2,
              (currentScreen.y - previousScreen.y) * viewport.height / 2);
            maxScreenFrameDisplacementDip = Math.max(maxScreenFrameDisplacementDip ?? 0, distance);
            screenSampleCount++;
          }
        }
        if (samples.length < 4) samples.push({ boneIndex: layer.index, localQuatDelta: rotation.toArray(), positionDelta: offset.toArray() });
      }
      return { weight, maxAngle, maxDisplacement, stepMs: runtime.stepMs, solverIterations: runtime.scope?.solverIterations ?? 0, samples,
        frameSerial: this.frameSerial, maxFrameAngle: runtime.maxFrameAngle, maxFrameDisplacement: runtime.maxFrameDisplacement,
        maxWorldDownward, maxWorldFrameDisplacement: runtime.maxWorldFrameDisplacement,
        maxScreenFrameDisplacementDip, screenSampleCount,
        outputBoneCount: runtime.rig.outputBoneIndices.length };
    };
    return { hair: part("hair"), chest: part("chest") };
  }

  private createRuntime(runtime: PartRuntime): boolean {
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
      runtime.backend = scope.run(() => this.factory(this.mesh, runtime.rig, MODEL_PHYSICS_BUDGETS[this.settings.quality]));
      scope.setSolverIterations(MODEL_PHYSICS_BUDGETS[this.settings.quality].solverIterations);
      runtime.targetSolverIterations = MODEL_PHYSICS_BUDGETS[this.settings.quality].solverIterations;
      runtime.qualityJustChanged = false;
      runtime.needsReset = true;
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

  private resetRuntime(runtime: PartRuntime): void {
    this.inPhysicsSpace(() => runtime.scope!.run(() => runtime.backend!.reset()));
    this.clearRuntimeVelocity(runtime);
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
      layer.targetRotation.copy(layer.rotation); layer.filteredRotation.copy(layer.rotation);
      layer.targetOffset.copy(layer.offset); layer.filteredOffset.copy(layer.offset);
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
    const targetRotation = new Quaternion(), targetOffset = new Vector3();
    const maxAngle = part === "hair" ? 0.7 : 0.3;
    for (const layer of runtime.layers) {
      if (!validPosition(layer.bone.position) || !validQuaternion(layer.bone.quaternion)) {
        runtime.needsReset = true;
        layer.targetRotation.copy(layer.rotation); layer.filteredRotation.copy(layer.rotation);
        layer.targetOffset.copy(layer.offset); layer.filteredOffset.copy(layer.offset);
        continue;
      }
      // Auxiliary bodies stay dynamic in Bullet, but their unweighted bones do
      // not become another presentation channel. All writes are still restored.
      if (!layer.output) { layer.offset.set(0, 0, 0); layer.rotation.identity(); continue; }
      targetRotation.copy(layer.baseQuaternion).invert().multiply(layer.bone.quaternion).normalize();
      const angle = IDENTITY.angleTo(targetRotation);
      if (angle > maxAngle) targetRotation.slerpQuaternions(IDENTITY, targetRotation, maxAngle / angle);
      targetOffset.copy(layer.bone.position).sub(layer.basePosition).clampLength(0, layer.maxDisplacement);
      if (part === "hair") {
        // Capture only at solver ticks. Every displayed frame resamples this
        // bounded target, including frames between low-quality solver calls.
        layer.targetRotation.copy(targetRotation);
        layer.targetOffset.copy(targetOffset);
        continue;
      }
      layer.rotation.rotateTowards(targetRotation, Math.min(0.35, dt * 8));
      const distance = layer.offset.distanceTo(targetOffset);
      const speed = layer.maxDisplacement * 8 * dt;
      layer.offset.lerp(targetOffset, distance > speed && distance > 0 ? speed / distance : 1);
    }
  }

  private applyResult(runtime: PartRuntime, recordFrame = true, dt = 0): void {
    const weight = runtime.fade * runtime.strength;
    const outputRotation = new Quaternion(), outputOffset = new Vector3();
    for (const layer of runtime.layers) {
      if (runtime.rig.part === "hair" && layer.output && dt > 0) {
        const alpha = 1 - Math.exp(-dt / HAIR_FILTER_SECONDS);
        layer.filteredRotation.slerp(layer.targetRotation, alpha);
        layer.filteredOffset.lerp(layer.targetOffset, alpha);
        const angle = layer.rotation.angleTo(layer.filteredRotation);
        layer.rotation.rotateTowards(layer.filteredRotation, Math.min(0.35, dt * 8, angle * alpha));
        const distance = layer.offset.distanceTo(layer.filteredOffset);
        const speed = layer.maxDisplacement * 8 * dt;
        layer.offset.lerp(layer.filteredOffset, distance > 0 ? Math.min(alpha, speed / distance) : 0);
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

  private releaseRuntime(runtime: PartRuntime): void {
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
    runtime.applied = false;
    runtime.zeroVelocity = undefined;
    runtime.fade = 0;
    runtime.elapsed = 0;
    runtime.scheduled = 0;
    runtime.stepMs = 0;
    runtime.needsReset = true;
    runtime.anchorPositions = [];
    runtime.anchorRotations = [];
    runtime.maxFrameAngle = 0;
    runtime.maxFrameDisplacement = 0;
    runtime.maxWorldFrameDisplacement = 0;
    runtime.qualityJustChanged = false;
    for (const layer of runtime.layers) {
      layer.offset.set(0, 0, 0); layer.rotation.identity();
      layer.targetOffset.set(0, 0, 0); layer.targetRotation.identity();
      layer.filteredOffset.set(0, 0, 0); layer.filteredRotation.identity();
      layer.previousOutputRotation.identity(); layer.previousOutputOffset.set(0, 0, 0);
      layer.previousWorldValid = false;
      layer.worldFrameDelta.set(0, 0, 0);
    }
  }
}
