import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { normalizeModelPhysicsSettings, type ModelPhysicsQuality } from "../shared/model-physics";
import { LocalModelPhysics, MODEL_PHYSICS_BUDGETS, OwnedAmmoScope } from "../src/stage/model-physics";
import type { AmmoModule } from "../src/stage/ammo-runtime";
import { joint, mockAmmo, physicsMesh } from "./physics-fixture";

function enabled(quality: ModelPhysicsQuality = "standard") {
  return normalizeModelPhysicsSettings({ hair: { enabled: true }, quality });
}

test("owned scope restores global descriptors and destroys only constructor results in reverse order", () => {
  const mock = mockAmmo();
  const scope = new OwnedAmmoScope(mock.ammo);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Ammo");
  scope.run(() => {
    const module = (globalThis as typeof globalThis & { Ammo: AmmoModule }).Ammo;
    const Vector = module.btVector3 as new () => { getOrigin(): object };
    const vector = new Vector();
    const borrowed = vector.getOrigin();
    module.destroy(borrowed);
    module.destroy(vector);
    module.destroy(vector);
    new Vector();
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "Ammo"), previous);
  assert.equal(scope.created, 2);
  assert.equal(scope.destroyed, 1);
  scope.dispose();
  scope.dispose();
  assert.equal(scope.destroyed, 2);
  assert.equal(scope.liveObjects, 0);
  assert.equal(mock.alive.size, 0);
  assert.throws(() => scope.run(() => undefined), /disposed/);
});

test("partially constructed worlds remove members before destroying native objects", () => {
  const mock = mockAmmo();
  const scope = new OwnedAmmoScope(mock.ammo);
  assert.throws(() => scope.run(() => {
    const module = (globalThis as typeof globalThis & { Ammo: AmmoModule }).Ammo;
    const World = module.btDiscreteDynamicsWorld as new () => { addRigidBody(body: object): void; addConstraint(constraint: object): void };
    const Body = module.btRigidBody as new () => object;
    const Constraint = module.btGeneric6DofSpringConstraint as new () => object;
    const world = new World();
    world.addRigidBody(new Body());
    world.addConstraint(new Constraint());
    throw new Error("constructor failed");
  }), /constructor failed/);
  scope.dispose();
  assert.equal(mock.alive.size, 0);
  const removed = mock.events.indexOf("removeConstraint");
  const destroyed = mock.events.findIndex(value => value.startsWith("destroy:"));
  assert.ok(removed >= 0 && removed < destroyed);
  assert.equal(scope.cleanupFailures, 0);
});

test("default off and zero strength allocate no world, unsupported request remains explicit", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const physics = new LocalModelPhysics(mesh, mock.ammo, undefined, mock.factory);
  physics.frame(1 / 30);
  assert.equal(physics.getState().status, "off");
  assert.equal(physics.getState().liveObjects, 0);
  physics.configure(normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 0 } }));
  physics.frame(1 / 30);
  assert.equal(mock.updates, 0);
  assert.equal(mock.alive.size, 0);
  const unsupportedMesh = physicsMesh();
  unsupportedMesh.skeleton.bones[6].name = "upperChest";
  const unsupported = new LocalModelPhysics(unsupportedMesh, mock.ammo,
    normalizeModelPhysicsSettings({ chest: { enabled: true } }), mock.factory);
  unsupported.frame(1 / 30);
  assert.equal(unsupported.getState().enabled.chest, true);
  assert.equal(unsupported.getState().status, "unsupported");
  unsupported.dispose();
  physics.dispose();
});

test("relative output is bounded and restore preserves a nonzero base plus independent head/face", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const hair = mesh.skeleton.bones[4], head = mesh.skeleton.bones[3], eye = mesh.skeleton.bones[7];
  hair.rotation.x = 0.25;
  hair.position.x = 0.2;
  head.rotation.z = 0.3;
  eye.rotation.y = 0.4;
  const basePosition = hair.position.clone(), baseQuaternion = hair.quaternion.clone();
  const headQuaternion = head.quaternion.clone(), eyeQuaternion = eye.quaternion.clone();
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), mock.factory);
  for (let i = 0; i < 30; i++) { physics.restore(); physics.frame(1 / 30); }
  assert.ok(hair.quaternion.angleTo(baseQuaternion) > 0);
  assert.ok(hair.quaternion.angleTo(baseQuaternion) <= 0.7 * 0.65 + 1e-8);
  assert.ok(hair.position.distanceTo(basePosition) <= basePosition.length() * 0.35 * 0.65 + 1e-8);
  assert.ok(head.quaternion.equals(headQuaternion));
  assert.ok(eye.quaternion.equals(eyeQuaternion));
  physics.restore();
  physics.restore();
  assert.ok(hair.position.equals(basePosition));
  assert.ok(hair.quaternion.equals(baseQuaternion));
  physics.dispose();
  assert.equal(mock.alive.size, 0);
});

test("zero delta reapplies the same weighted local output to a replacement base without advancing", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), mock.factory);
  for (let i = 0; i < 20; i++) physics.frame(1 / 30);
  const before = physics.getDiagnostics().hair;
  const updates = mock.updates, steps = physics.getState().steps;
  physics.restore();
  mesh.skeleton.bones[4].rotation.y = 0.4;
  const replacement = mesh.skeleton.bones[4].quaternion.clone();
  physics.frame(0);
  const after = physics.getDiagnostics().hair;
  assert.equal(mock.updates, updates);
  assert.equal(physics.getState().steps, steps);
  assert.equal(after.weight, before.weight);
  assert.ok(Math.abs(after.maxAngle - before.maxAngle) < 1e-7);
  physics.restore();
  assert.ok(mesh.skeleton.bones[4].quaternion.equals(replacement));
  physics.dispose();
});

test("disable fades out without more solves and each part owns an independent lifetime", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const physics = new LocalModelPhysics(mesh, mock.ammo,
    normalizeModelPhysicsSettings({ hair: { enabled: true }, chest: { enabled: true } }), mock.factory);
  for (let i = 0; i < 15; i++) physics.frame(1 / 30);
  const before = physics.getDiagnostics().hair.weight;
  physics.configure(normalizeModelPhysicsSettings({ hair: { enabled: false }, chest: { enabled: true } }));
  physics.frame(1 / 30);
  assert.ok(physics.getDiagnostics().hair.weight < before);
  assert.ok(physics.getDiagnostics().chest.weight > 0);
  for (let i = 0; i < 12; i++) physics.frame(1 / 30);
  assert.equal(physics.getDiagnostics().hair.weight, 0);
  assert.ok(physics.getState().liveObjects > 0, "chest world remains active");
  physics.configure(normalizeModelPhysicsSettings({ hair: { enabled: false }, chest: { enabled: false } }));
  const updates = mock.updates;
  for (let i = 0; i < 12; i++) physics.frame(1 / 30);
  assert.equal(mock.updates, updates);
  assert.equal(mock.alive.size, 0);
  physics.dispose();
  assert.equal(physics.getState().createdObjects, physics.getState().destroyedObjects);
});

test("hide destroys worlds, restoration skips hidden time and repeated toggles balance objects", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const base = mesh.skeleton.bones[4].quaternion.clone();
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), mock.factory);
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let i = 0; i < 12; i++) physics.frame(1 / 30);
    physics.setVisible(false);
    assert.ok(mesh.skeleton.bones[4].quaternion.equals(base));
    assert.equal(mock.alive.size, 0);
    const updates = mock.updates;
    physics.frame(120);
    assert.equal(mock.updates, updates);
    physics.setVisible(true);
    physics.frame(120);
    assert.ok(mock.deltas.every(delta => delta <= 0.1));
  }
  physics.dispose();
  assert.equal(physics.getState().liveObjects, 0);
  assert.equal(physics.getState().createdObjects, physics.getState().destroyedObjects);
  assert.equal(physics.getState().cleanupFailures, 0);
  assert.equal(physics.getState().status, "disposed");
});

test("all hair qualities keep a bounded uniform quantum under uneven display batches without slowing their clock", () => {
  const displayDeltas = [0.0358, 0.0341, 0.0392, 0.0295];
  for (const [part, quality] of [["hair", "low"], ["chest", "low"], ["hair", "standard"], ["hair", "high"]] as const) {
    const mock = mockAmmo();
    const physics = new LocalModelPhysics(physicsMesh(), mock.ammo,
      normalizeModelPhysicsSettings({ [part]: { enabled: true }, quality }), mock.factory);
    let displayTime = 0;
    const quantum = 1 / MODEL_PHYSICS_BUDGETS[quality].updateHz;
    for (let i = 0; i < 240; i++) {
      const delta = displayDeltas[i % displayDeltas.length], before = mock.updates;
      displayTime += delta; physics.frame(delta);
      if (part === "hair") assert.ok(mock.updates - before <= Math.ceil(0.05 / quantum));
    }
    if (part === "hair") {
      assert.ok(mock.deltas.length > 100 && mock.deltas.every(delta => delta === quantum));
      const simulatedTime = mock.deltas.reduce((sum, delta) => sum + delta, 0);
      assert.ok(displayTime - simulatedTime >= -1e-8 && displayTime - simulatedTime < quantum + 1e-8,
        "Uniform solves retain the elapsed average clock, not one short quantum per render frame.");
      const calls = mock.updates;
      physics.frame(0.6);
      assert.equal(mock.updates, calls + Math.floor((0.05 + 1e-8) / quantum), "A real stall drops backlog and advances only the bounded new frame.");
      assert.equal(mock.deltas.at(-1), quantum);
    } else assert.ok(mock.deltas.some(delta => Math.abs(delta - 0.05) > 0.001), "Chest retains its independent elapsed clock.");
    physics.dispose(); assert.equal(mock.alive.size, 0);
  }
});

test("quality changes real scheduling budgets while strength leaves scheduling unchanged", () => {
  const calls: number[] = [];
  for (const quality of ["low", "standard", "high"] as const) {
    const mock = mockAmmo(), physics = new LocalModelPhysics(physicsMesh(), mock.ammo, enabled(quality), mock.factory);
    for (let i = 0; i < 120; i++) physics.frame(1 / 60);
    calls.push(mock.updates);
    physics.dispose();
  }
  assert.ok(calls[0] < calls[1] && calls[1] < calls[2]);
  assert.notEqual(MODEL_PHYSICS_BUDGETS.low.solverIterations, MODEL_PHYSICS_BUDGETS.high.solverIterations);
  const mock = mockAmmo(), physics = new LocalModelPhysics(physicsMesh(), mock.ammo, enabled(), mock.factory);
  for (let i = 0; i < 30; i++) physics.frame(1 / 30);
  const callsBefore = mock.updates;
  physics.configure(normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 0.2 } }));
  for (let i = 0; i < 30; i++) physics.frame(1 / 30);
  assert.equal(mock.updates - callsBefore, callsBefore);
  physics.dispose();
});

test("constructor failure restores all live transforms and rolls back partial native allocations", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  mesh.position.set(1, 2, 3);
  mesh.scale.setScalar(1.2);
  mesh.skeleton.bones[4].quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
  const saved = mesh.skeleton.bones.map(bone => [bone.position.clone(), bone.quaternion.clone()] as const);
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), () => {
    const module = (globalThis as typeof globalThis & { Ammo: AmmoModule }).Ammo;
    new (module.btVector3 as new () => object)();
    mesh.position.set(0, 0, 0);
    throw new Error("failure");
  });
  physics.frame(1 / 30);
  assert.deepEqual(mesh.position.toArray(), [1, 2, 3]);
  assert.deepEqual(mesh.scale.toArray(), [1.2, 1.2, 1.2]);
  mesh.skeleton.bones.forEach((bone, i) => {
    assert.ok(bone.position.equals(saved[i][0]));
    assert.ok(bone.quaternion.equals(saved[i][1]));
  });
  assert.equal(mock.alive.size, 0);
  assert.equal(physics.getState().status, "error");
  physics.dispose();
});

test("restore does not erase a newer synchronous replacement pose", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), mock.factory);
  for (let i = 0; i < 15; i++) physics.frame(1 / 30);
  const replacement = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
  mesh.skeleton.bones[4].quaternion.copy(replacement);
  physics.restore();
  assert.ok(mesh.skeleton.bones[4].quaternion.equals(replacement));
  physics.dispose();
});

test("a released chest layer cannot restore an old snapshot while hair remains active", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const physics = new LocalModelPhysics(mesh, mock.ammo,
    normalizeModelPhysicsSettings({ hair: { enabled: true }, chest: { enabled: true } }), mock.factory);
  for (let i = 0; i < 15; i++) physics.frame(1 / 30);
  const oldAppliedChest = mesh.skeleton.bones[6].quaternion.clone();
  physics.configure(normalizeModelPhysicsSettings({ hair: { enabled: true }, chest: { enabled: false } }));
  for (let i = 0; i < 15; i++) {
    physics.frame(1 / 30);
    if (physics.getDiagnostics().chest.weight > 0) oldAppliedChest.copy(mesh.skeleton.bones[6].quaternion);
  }
  mesh.skeleton.bones[6].quaternion.copy(oldAppliedChest);
  physics.frame(1 / 30);
  physics.restore();
  assert.ok(mesh.skeleton.bones[6].quaternion.equals(oldAppliedChest));
  physics.dispose();
});

test("reset and update share unscaled solver space while preserving host scale on success", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  mesh.scale.setScalar(1.2);
  const spaces: number[][] = [];
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), (target, rig, budget) => {
    const backend = mock.factory(target, rig, budget);
    return { ...backend,
      reset() { spaces.push(target.getWorldScale(new Vector3()).toArray()); return backend.reset(); },
      update(dt) { spaces.push(target.getWorldScale(new Vector3()).toArray()); return backend.update(dt); },
    };
  });
  for (let i = 0; i < 15; i++) physics.frame(1 / 30);
  assert.ok(spaces.length > 1 && spaces.every(space => space.every(value => value === 1)));
  assert.deepEqual(mesh.scale.toArray(), [1.2, 1.2, 1.2]);
  physics.dispose();
});

test("missing verifiable solver iteration controls fail explicitly and release the partial world", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  const World = mock.ammo.btDiscreteDynamicsWorld as { prototype: object };
  Object.defineProperty(World.prototype, "getSolverInfo", { value: () => ({}), configurable: true });
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), mock.factory);
  physics.frame(1 / 30);
  assert.equal(physics.getState().status, "error");
  assert.equal(physics.getState().liveObjects, 0);
  assert.equal(mock.alive.size, 0);
  physics.dispose();
});

test("low quality resamples cached hair targets between solver ticks and diagnostics do not advance it", () => {
  const mock = mockAmmo(), physics = new LocalModelPhysics(physicsMesh(), mock.ammo, enabled("low"), mock.factory);
  try {
    for (let i = 0; i < 20; i++) physics.frame(1 / 60);
    let resampled = false;
    for (let i = 0; i < 6; i++) {
      const before = physics.getDiagnostics().hair, calls = mock.updates;
      physics.frame(1 / 60);
      const after = physics.getDiagnostics().hair;
      assert.equal(after.frameSerial, before.frameSerial + 1);
      assert.equal(after.outputBoneCount, 2);
      if (mock.updates === calls && after.maxAngle > before.maxAngle + 1e-7) resampled = true;
      assert.deepEqual(physics.getDiagnostics().hair, after, 'repeated observation is read-only');
      physics.frame(0);
      assert.equal(physics.getDiagnostics().hair.frameSerial, after.frameSerial);
      assert.ok(Math.abs(physics.getDiagnostics().hair.maxAngle - after.maxAngle) < 1e-7);
    }
    assert.ok(resampled, 'visible interpolation continues while the low scheduler skips a solve');
  } finally { physics.dispose(); }
  assert.equal(mock.alive.size, 0);
});

test("a joint-connected simulation helper is restored without acquiring visible output", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  mesh.geometry.userData.MMD.constraints.push(joint(1, 7));
  const helper = mesh.skeleton.bones[9];
  const base = { quaternion: helper.quaternion.clone(), position: helper.position.clone() };
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), mock.factory);
  try {
    for (let i = 0; i < 30; i++) physics.frame(1 / 30);
    assert.equal(physics.getState().support.hair.bodies, 3);
    assert.equal(physics.getDiagnostics().hair.outputBoneCount, 2);
    assert.ok(helper.quaternion.equals(base.quaternion) && helper.position.equals(base.position));
    assert.ok(physics.getDiagnostics().hair.maxAngle > 0.1, 'the real output bones still respond');
    physics.restore();
    assert.ok(helper.quaternion.equals(base.quaternion) && helper.position.equals(base.position));
  } finally { physics.dispose(); }
  assert.equal(mock.alive.size, 0);
});

test("a visible stall keeps settled output while an actual anchor jump resets only the solver", () => {
  const mesh = physicsMesh(), mock = mockAmmo(), physics = new LocalModelPhysics(mesh, mock.ammo, enabled("low"), mock.factory);
  try {
    for (let i = 0; i < 120; i++) physics.frame(1 / 60);
    const before = physics.getDiagnostics().hair, resets = mock.resets;
    physics.frame(0.8);
    const stalled = physics.getDiagnostics().hair;
    assert.equal(mock.resets, resets, 'a clock gap alone does not re-seed settled bodies to the authored pose');
    assert.equal(stalled.weight, before.weight);
    assert.ok(Math.abs(stalled.maxAngle - before.maxAngle) < 0.001);
    assert.ok(stalled.maxFrameAngle < 0.001);
    physics.restore();
    mesh.skeleton.bones[3].rotation.z = Math.PI * 0.4;
    physics.frame(1 / 60);
    const jumped = physics.getDiagnostics().hair;
    assert.equal(mock.resets, resets + 1);
    assert.ok(Math.abs(jumped.maxAngle - stalled.maxAngle) < 0.001, 'a skipped low-quality solve cannot drag toward a stale target');
    assert.equal(jumped.weight, before.weight);
  } finally { physics.dispose(); }
  assert.equal(mock.alive.size, 0);
});

test("invalid raw bone output preserves the last finite presentation and requests a solver reset", () => {
  const mesh = physicsMesh(), mock = mockAmmo();
  let invalid = false;
  const physics = new LocalModelPhysics(mesh, mock.ammo, enabled(), (target, rig, budget) => {
    const backend = mock.factory(target, rig, budget);
    return { ...backend, update(dt) {
      backend.update(dt);
      if (invalid) target.skeleton.bones[4].quaternion.set(Number.NaN, 0, 0, 1);
    } };
  });
  try {
    for (let i = 0; i < 60; i++) physics.frame(1 / 30);
    const before = physics.getDiagnostics().hair, resets = mock.resets;
    invalid = true;
    physics.frame(1 / 30);
    assert.ok(mesh.skeleton.bones[4].quaternion.toArray().every(Number.isFinite));
    assert.ok(Math.abs(physics.getDiagnostics().hair.maxAngle - before.maxAngle) < 0.001);
    invalid = false;
    physics.frame(1 / 30);
    assert.equal(mock.resets, resets + 1);
    assert.notEqual(physics.getState().status, "error");
  } finally { physics.dispose(); }
  assert.equal(mock.alive.size, 0);
});

test("quality transitions reach the new solver budget through bounded solves while preserving strength", () => {
  const mock = mockAmmo(), physics = new LocalModelPhysics(physicsMesh(), mock.ammo, enabled("high"), mock.factory);
  try {
    for (let i = 0; i < 60; i++) physics.frame(1 / 60);
    const weight = physics.getDiagnostics().hair.weight;
    physics.configure(enabled("low"));
    const iterations: number[] = [];
    for (let i = 0; i < 90; i++) {
      const calls = mock.updates;
      physics.frame(1 / 60);
      if (calls !== mock.updates) iterations.push(physics.getDiagnostics().hair.solverIterations);
      assert.equal(physics.getDiagnostics().hair.weight, weight);
    }
    assert.deepEqual(iterations.slice(0, 9), [20, 18, 16, 14, 12, 10, 8, 6, 4]);
    assert.equal(iterations.at(-1), MODEL_PHYSICS_BUDGETS.low.solverIterations);
    assert.equal(physics.getState().quality, "low");
  } finally { physics.dispose(); }
  assert.equal(mock.alive.size, 0);
});

test("screen motion diagnostics project all visible output bones in viewport DIP and remain read-only", () => {
  const mock = mockAmmo(), physics = new LocalModelPhysics(physicsMesh(), mock.ammo, enabled(), mock.factory);
  const camera = new PerspectiveCamera(40, 400 / 560, 0.1, 100);
  camera.position.set(0, 5, 25); camera.lookAt(0, 5, 0); camera.updateMatrixWorld(true);
  try {
    for (let i = 0; i < 10; i++) physics.frame(1 / 30);
    const normal = physics.getDiagnostics().hair;
    assert.equal(normal.maxScreenFrameDisplacementDip, null, 'world diagnostics do not invent a viewport');
    const small = physics.getDiagnostics(camera, { width: 400, height: 560 }).hair;
    const large = physics.getDiagnostics(camera, { width: 800, height: 1120 }).hair;
    assert.equal(small.screenSampleCount, 2);
    assert.ok(small.maxScreenFrameDisplacementDip! > 0);
    assert.ok(Math.abs(large.maxScreenFrameDisplacementDip! - small.maxScreenFrameDisplacementDip! * 2) < 1e-8);
    assert.equal(large.frameSerial, normal.frameSerial);
    assert.deepEqual(physics.getDiagnostics().hair, normal);
    camera.position.z = -25; camera.lookAt(0, 5, -50); camera.updateMatrixWorld(true);
    const behind = physics.getDiagnostics(camera, { width: 400, height: 560 }).hair;
    assert.equal(behind.screenSampleCount, 0);
    assert.equal(behind.maxScreenFrameDisplacementDip, null, 'behind-camera points do not sign screen stability');
    physics.setVisible(false);
    assert.equal(physics.getDiagnostics(camera, { width: 400, height: 560 }).hair.screenSampleCount, 0);
  } finally { physics.dispose(); }
  assert.equal(mock.alive.size, 0);
});
