import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MeshBasicMaterial, Quaternion, type SkinnedMesh } from "three";
import { MMDPhysics } from "three/examples/jsm/animation/MMDPhysics.js";
import { MMDLoader } from "three/examples/jsm/loaders/MMDLoader.js";
import { normalizeModelPhysicsSettings } from "../shared/model-physics";
import { LocalModelPhysics } from "../src/stage/model-physics";
import { buildPhysicsRigPlan } from "../src/stage/physics-rig";
import { loadAmmoForTests } from "./helpers/ammo-node";

async function geneMesh(): Promise<SkinnedMesh> {
  const bytes = await readFile(new URL("../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx", import.meta.url));
  const parserModule = "three/examples/jsm/libs/mmdparser.module.js";
  const { MMDParser } = await import(parserModule);
  const data: unknown = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  // Use the pinned loader's actual geometry normalization and skeleton builder.
  // Replace only material creation: CPU physics requires no textures or DOM.
  const loader = new MMDLoader() as unknown as {
    meshBuilder: {
      materialBuilder: { build: (...args: unknown[]) => unknown };
      build(data: unknown, resourcePath: string): SkinnedMesh;
    };
  };
  loader.meshBuilder.materialBuilder.build = () => new MeshBasicMaterial();
  return loader.meshBuilder.build(data, "");
}

test("public Gene has an anchored weighted hair rig and explicit unsupported chest", async () => {
  const mesh = await geneMesh();
  const rig = buildPhysicsRigPlan(mesh);
  assert.equal(rig.support.hair.supported, true);
  assert.ok(rig.hair.dynamicBoneIndices.length > 0);
  assert.ok(rig.hair.constraints.length > 0);
  assert.ok(rig.hair.springConstraintCount > 0);
  assert.equal(rig.support.chest.supported, false);
  assert.equal(rig.chest.dynamicBodyCount, 0);
  mesh.geometry.dispose();
  (mesh.material as MeshBasicMaterial).dispose();
});

test("real fixed Ammo keeps Gene output bounded and restores the current nonzero animated base", async () => {
  const ammo = await loadAmmoForTests(), mesh = await geneMesh();
  const settings = normalizeModelPhysicsSettings({ hair: { enabled: true }, quality: "standard" });
  const physics = new LocalModelPhysics(mesh, ammo, settings);
  const head = mesh.skeleton.bones.find(bone => bone.name === "頭")!;
  assert.ok(head);
  let maxVisibleAngle = 0;
  try {
    for (let i = 0; i < 180; i++) {
      physics.restore();
      head.rotation.y = Math.sin(i * 0.06) * 0.22;
      const base = mesh.skeleton.bones.map(bone => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
      physics.frame(1 / 30);
      const state = physics.getState(), output = physics.getDiagnostics().hair;
      assert.notEqual(state.status, "error");
      assert.ok(Number.isFinite(output.maxAngle) && Number.isFinite(output.maxDisplacement));
      assert.ok(output.maxAngle <= 0.7 * 0.65 + 1e-7);
      maxVisibleAngle = Math.max(maxVisibleAngle, output.maxAngle);
      assert.ok(head.quaternion.equals(base[mesh.skeleton.bones.indexOf(head)].quaternion));
      physics.restore();
      mesh.skeleton.bones.forEach((bone, index) => {
        assert.ok(bone.position.equals(base[index].position));
        assert.ok(bone.quaternion.equals(base[index].quaternion));
      });
    }
    assert.ok(maxVisibleAngle > 0.00001, "actual displayed hair response exists under moving head input");
    assert.ok(physics.getState().steps > 0);
  } finally {
    physics.dispose();
    mesh.geometry.dispose();
    (mesh.material as MeshBasicMaterial).dispose();
  }
  assert.equal(physics.getState().liveObjects, 0);
  assert.equal(physics.getState().createdObjects, physics.getState().destroyedObjects);
  assert.equal(physics.getState().cleanupFailures, 0);
});

test("real Gene hair retains gravity response and settles under upright and tilted static head poses", async () => {
  const ammo = await loadAmmoForTests();
  for (const tilt of [0, 0.35]) {
    const mesh = await geneMesh();
    const head = mesh.skeleton.bones.find(bone => bone.name === "頭")!;
    let activeFrame = 0, rawQuietAnglePeak = 0;
    const previousRaw = new Map<number, Quaternion>();
    const physics = new LocalModelPhysics(mesh, ammo,
      normalizeModelPhysicsSettings({ hair: { enabled: true }, quality: "standard" }), (target, rig, budget) => {
        const backend = new MMDPhysics(target, [...rig.rigidBodies], [...rig.constraints],
          { unitStep: budget.unitStep, maxStepNum: budget.maxSteps });
        const update = backend.update.bind(backend);
        backend.update = dt => {
          const base = rig.outputBoneIndices.map(index => target.skeleton.bones[index].quaternion.clone());
          update(dt);
          rig.outputBoneIndices.forEach((index, i) => {
            const rotation = base[i].invert().multiply(target.skeleton.bones[index].quaternion).normalize();
            if (activeFrame >= 240 && previousRaw.has(index)) rawQuietAnglePeak = Math.max(rawQuietAnglePeak, previousRaw.get(index)!.angleTo(rotation));
            previousRaw.set(index, rotation);
          });
          return backend;
        };
        return backend;
      });
    let quietWorldPeak = 0, quietAnglePeak = 0, gravityDrop = 0, response = 0;
    try {
      for (let frame = 0; frame < 360; frame++) {
        activeFrame = frame;
        physics.restore();
        head.rotation.z = tilt;
        physics.frame(1 / 30);
        const hair = physics.getDiagnostics().hair;
        assert.notEqual(physics.getState().status, "error");
        assert.ok([hair.maxFrameAngle, hair.maxWorldFrameDisplacement, hair.maxWorldDownward].every(Number.isFinite));
        if (frame >= 240) {
          quietWorldPeak = Math.max(quietWorldPeak, hair.maxWorldFrameDisplacement);
          quietAnglePeak = Math.max(quietAnglePeak, hair.maxFrameAngle);
          gravityDrop = Math.max(gravityDrop, hair.maxWorldDownward);
          response = Math.max(response, hair.maxAngle);
        }
      }
      // Same scene-unit engineering gate as native held-pose QA. Pixel-level
      // visibility still requires the real window. The simultaneous vendor
      // sample proves high-frequency attenuation across all output bones.
      assert.ok(quietWorldPeak < 0.005, `held pose world chatter is bounded (${tilt}: ${quietWorldPeak})`);
      assert.ok(rawQuietAnglePeak > 0.01, 'the fixture actually exercises persistent raw solver motion');
      assert.ok(quietAnglePeak < rawQuietAnglePeak * 0.4,
        `all output bones attenuate raw chatter (${tilt}: ${quietAnglePeak} versus ${rawQuietAnglePeak})`);
      assert.ok(gravityDrop > 0.001 && response > 0.01, 'a quiet result must retain an actual gravity response');
    } finally {
      physics.dispose();
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
    assert.equal(physics.getState().liveObjects, 0);
    assert.equal(physics.getState().createdObjects, physics.getState().destroyedObjects);
  }
});

test("real Ammo toggle/hide/dispose cycles balance owned objects without growing warmed linear capacity", async () => {
  const ammo = await loadAmmoForTests(), mesh = await geneMesh();
  const on = normalizeModelPhysicsSettings({ hair: { enabled: true } });
  const off = normalizeModelPhysicsSettings({ hair: { enabled: false } });
  const physics = new LocalModelPhysics(mesh, ammo, on);
  const capacities: number[] = [];
  const capacity = () => {
    const heap = ammo.HEAP8;
    assert.ok(ArrayBuffer.isView(heap), "fixed Ammo exposes its linear memory view");
    return heap.byteLength;
  };
  try {
    for (let cycle = 0; cycle < 12; cycle++) {
      physics.configure(on);
      for (let i = 0; i < 12; i++) physics.frame(1 / 30);
      physics.configure(off);
      for (let i = 0; i < 12; i++) physics.frame(1 / 30);
      assert.equal(physics.getState().liveObjects, 0);
      physics.configure(on);
      physics.frame(1 / 30);
      physics.setVisible(false);
      assert.equal(physics.getState().liveObjects, 0);
      physics.frame(10);
      physics.setVisible(true);
      physics.frame(10);
      physics.setVisible(false);
      assert.equal(physics.getState().createdObjects, physics.getState().destroyedObjects);
      assert.equal(physics.getState().cleanupFailures, 0);
      capacities.push(capacity());
      assert.equal(physics.getState().heapCapacityBytes, capacities.at(-1), 'diagnostics report actual retained capacity');
      physics.setVisible(true);
    }
    // A retained module's capacity does not shrink on dispose. After warming,
    // repeated equal worlds must fit the same fixed allocation, not grow forever.
    assert.ok(capacities.slice(3).every(value => value === capacities[3]));
  } finally {
    physics.dispose();
    mesh.geometry.dispose();
    (mesh.material as MeshBasicMaterial).dispose();
  }
  assert.equal(physics.getState().liveObjects, 0);
});

test("real solver iteration budgets differ at the same 30 FPS without dropping simulation substeps", async () => {
  const ammo = await loadAmmoForTests();
  const results: { steps: number; work: number; iterations: number }[] = [];
  for (const quality of ["low", "standard", "high"] as const) {
    const mesh = await geneMesh();
    mesh.scale.setScalar(1.2);
    const physics = new LocalModelPhysics(mesh, ammo,
      normalizeModelPhysicsSettings({ hair: { enabled: true }, quality }));
    try {
      for (let i = 0; i < 60; i++) physics.frame(1 / 30);
      assert.notEqual(physics.getState().status, "error");
      const state = physics.getState();
      results.push({ steps: state.steps, work: state.solverIterationWork, iterations: physics.getDiagnostics().hair.solverIterations });
      assert.deepEqual(mesh.scale.toArray(), [1.2, 1.2, 1.2]);
      assert.ok(physics.getDiagnostics().hair.maxAngle <= 0.7 * 0.65 + 1e-7);
    } finally {
      physics.dispose();
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
    assert.equal(physics.getState().liveObjects, 0);
  }
  assert.deepEqual(results.map(result => result.iterations), [4, 10, 20]);
  // The low scheduler can finish one interval later; it must not slow the world
  // by capping away a significant fraction of two seconds of simulation.
  assert.ok(results[0].steps >= results[1].steps - 5);
  assert.equal(results[1].steps, results[2].steps);
  assert.ok(results[0].work < results[1].work && results[1].work < results[2].work);
});
