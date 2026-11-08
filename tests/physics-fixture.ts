import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from "three";
import type { AmmoModule } from "../src/stage/ammo-runtime";
import type { LocalPhysicsFactory } from "../src/stage/model-physics";
import type { PhysicsConstraint, PhysicsRigidBody } from "../src/stage/physics-rig";

export function body(boneIndex: number, type: number): PhysicsRigidBody {
  return { boneIndex, type, shapeType: 0, width: 0.2, height: 0, depth: 0, weight: type ? 1 : 0,
    position: [0, 0, 0], rotation: [0, 0, 0], friction: 0.5, restitution: 0,
    positionDamping: 0.5, rotationDamping: 0.5, groupIndex: 0, groupTarget: 65535 };
}

export function joint(a: number, b: number): PhysicsConstraint {
  return { rigidBodyIndex1: a, rigidBodyIndex2: b, position: [0, 0, 0], rotation: [0, 0, 0],
    translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0],
    rotationLimitation1: [-0.5, -0.5, -0.5], rotationLimitation2: [0.5, 0.5, 0.5],
    springPosition: [0, 0, 0], springRotation: [5, 5, 5] };
}

export function physicsMesh(): SkinnedMesh {
  const specs: [string, number][] = [
    ["センター", -1], ["上半身", 0], ["首", 1], ["頭", 2], ["髪1", 3], ["髪2", 4],
    ["乳.L", 1], ["目.L", 3], ["スカート", 0], ["髪飾り", 3],
  ];
  const bones = specs.map(([name]) => { const bone = new Bone(); bone.name = name; bone.position.set(0, 1, 0); return bone; });
  specs.forEach(([, parent], i) => { if (parent >= 0) bones[parent].add(bones[i]); });
  const geometry = new BufferGeometry();
  const weighted = [4, 5, 6, 7, 8];
  geometry.setAttribute("position", new Float32BufferAttribute(weighted.flatMap((_, i) => [i, 1, 0]), 3));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(weighted.flatMap(index => [index, 0, 0, 0]), 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(weighted.flatMap(() => [1, 0, 0, 0]), 4));
  geometry.userData.MMD = {
    rigidBodies: [body(3, 0), body(4, 1), body(5, 1), body(6, 2), body(1, 0), body(7, 1), body(8, 1), body(9, 1)],
    constraints: [joint(0, 1), joint(1, 2), joint(4, 3), joint(0, 5), joint(4, 6), joint(0, 7)],
  };
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return mesh;
}

export function mockAmmo() {
  const alive = new Set<object>();
  const events: string[] = [];
  let next = 0;
  let updates = 0;
  let resets = 0;
  const deltas: number[] = [];
  class Native {
    id = ++next;
    constructor(readonly kind = "object") { alive.add(this); events.push(`new:${kind}:${this.id}`); }
  }
  class Vector extends Native {
    constructor(public a = 0, public b = 0, public c = 0) { super("vector"); }
    setValue(a: number, b: number, c: number) { this.a = a; this.b = b; this.c = c; }
    getOrigin() { return { borrowed: true }; }
  }
  class World extends Native {
    bodies = new Set<object>();
    constraints = new Set<object>();
    iterations = 10;
    constructor() { super("world"); }
    addRigidBody(value: object) { this.bodies.add(value); events.push("addBody"); }
    removeRigidBody(value: object) { this.bodies.delete(value); events.push("removeBody"); }
    addConstraint(value: object) { this.constraints.add(value); events.push("addConstraint"); }
    removeConstraint(value: object) { this.constraints.delete(value); events.push("removeConstraint"); }
    stepSimulation(dt: number, max: number, unit: number) { deltas.push(dt); return Math.min(max, Math.floor(dt / unit) + 1); }
    getSolverInfo() {
      return { set_m_numIterations: (value: number) => { this.iterations = value; }, get_m_numIterations: () => this.iterations };
    }
  }
  const ammo: AmmoModule = {
    btVector3: Vector,
    btDiscreteDynamicsWorld: World,
    btRigidBody: class extends Native { constructor() { super("body"); } },
    btGeneric6DofSpringConstraint: class extends Native { constructor() { super("constraint"); } },
    destroy(value: unknown) {
      if (!value || typeof value !== "object" || !alive.has(value)) throw new Error("Double/borrowed destroy");
      const native = value as Native;
      if (native instanceof World && (native.bodies.size || native.constraints.size)) throw new Error("World still owns members");
      events.push(`destroy:${native.kind}:${native.id}`);
      alive.delete(value);
    },
  };
  type Constructor<T> = new (...args: never[]) => T;
  const factory: LocalPhysicsFactory = (mesh, rig, budget) => {
    const module = (globalThis as typeof globalThis & { Ammo: AmmoModule }).Ammo;
    const world = new (module.btDiscreteDynamicsWorld as Constructor<World>)();
    const nativeBody = new (module.btRigidBody as Constructor<Native>)();
    world.addRigidBody(nativeBody);
    const constraint = new (module.btGeneric6DofSpringConstraint as Constructor<Native>)();
    world.addConstraint(constraint);
    return {
      unitStep: budget.unitStep, maxStepNum: budget.maxSteps,
      reset() { resets++; },
      update(dt) {
        updates++;
        world.stepSimulation(dt, this.maxStepNum, this.unitStep);
        for (const index of rig.dynamicBoneIndices) {
          mesh.skeleton.bones[index].rotation.z += rig.part === "hair" ? 0.45 : 0.2;
          mesh.skeleton.bones[index].position.x += 0.5;
        }
      },
    };
  };
  return { ammo, alive, events, deltas, factory, get updates() { return updates; }, get resets() { return resets; } };
}
