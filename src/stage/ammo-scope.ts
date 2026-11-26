// The Ammo objects one physics world owns (moved unchanged from model-physics.ts, R01 2026-11-17, to keep that file small).
import type { AmmoModule } from "./ammo-runtime";

export type NativeObject = Record<string, unknown>;
export type NativeMethod = (...args: unknown[]) => unknown;

export function nativeMethod(value: NativeObject, name: string): NativeMethod {
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

