import assert from "node:assert/strict";
import test from "node:test";
import { buildPhysicsRigPlan, probeModelPhysicsSupport } from "../src/stage/physics-rig";
import { body, joint, physicsMesh } from "./physics-fixture";

test("rig requires weighted anchored secondary bones and preserves source metadata", () => {
  const mesh = physicsMesh();
  const original = JSON.stringify(mesh.geometry.userData.MMD);
  const rig = buildPhysicsRigPlan(mesh);
  assert.deepEqual(rig.hair.dynamicBoneIndices, [4, 5]);
  assert.deepEqual(rig.hair.outputBoneIndices, [4, 5]);
  assert.deepEqual(rig.chest.dynamicBoneIndices, [6]);
  assert.deepEqual(rig.chest.outputBoneIndices, [6]);
  assert.equal(rig.support.hair.supported, true);
  assert.equal(rig.support.chest.supported, true);
  assert.ok(rig.hair.springConstraintCount > 0);
  assert.equal(JSON.stringify(mesh.geometry.userData.MMD), original);
  // Facial and clothing dynamics never become additional physics outputs.
  for (const part of [rig.hair, rig.chest]) {
    assert.ok(part.rigidBodies.filter(value => value.type !== 0).every(value => part.dynamicBoneIndices.includes(value.boneIndex)));
    for (const constraint of part.constraints) {
      assert.ok(part.rigidBodies[constraint.rigidBodyIndex1]);
      assert.ok(part.rigidBodies[constraint.rigidBodyIndex2]);
    }
  }
});

test("necessary boundary references become kinematic and compatible static collisions remain", () => {
  const mesh = physicsMesh();
  const metadata = mesh.geometry.userData.MMD;
  // Hair's secondary boundary is a dynamic torso body; retaining it must not
  // grant the adapter ownership of the torso's output bone.
  metadata.rigidBodies.push(body(1, 1));
  metadata.constraints.push(joint(2, metadata.rigidBodies.length - 1));
  const plan = buildPhysicsRigPlan(mesh).hair;
  assert.equal(plan.rigidBodies[plan.sourceBodyIndices.indexOf(metadata.rigidBodies.length - 1)].type, 0);
  assert.ok(plan.sourceBodyIndices.includes(4), "unconnected compatible torso collider retained");
  assert.deepEqual(plan.dynamicBoneIndices, [4, 5]);
});

test("names alone, missing weights, detached components and torso names cannot grant support", () => {
  const mesh = physicsMesh();
  mesh.geometry.deleteAttribute("skinWeight");
  assert.equal(probeModelPhysicsSupport(mesh).hair.supported, false);
  const detached = physicsMesh();
  detached.geometry.userData.MMD.constraints = [];
  assert.equal(probeModelPhysicsSupport(detached).hair.supported, false);
  const torso = physicsMesh();
  torso.skeleton.bones[6].name = "upperChest";
  assert.equal(probeModelPhysicsSupport(torso).chest.supported, false);
  const renamed = physicsMesh();
  renamed.skeleton.bones[8].name = "hair decoration";
  assert.deepEqual(buildPhysicsRigPlan(renamed).hair.dynamicBoneIndices, [4, 5]);
});

test("malformed references and nonfinite parameters are never sent to Ammo", () => {
  const mesh = physicsMesh();
  mesh.geometry.userData.MMD.constraints.push({ ...joint(1, 2), rigidBodyIndex2: 9000 });
  mesh.geometry.userData.MMD.constraints.push({ ...joint(0, 1), springRotation: [NaN, 0, 0] });
  mesh.geometry.userData.MMD.rigidBodies[2].width = Infinity;
  const plan = buildPhysicsRigPlan(mesh);
  assert.deepEqual(plan.hair.dynamicBoneIndices, [4]);
  assert.ok(plan.hair.constraints.every(value => value.rigidBodyIndex2 < plan.hair.rigidBodies.length));
  const missing = physicsMesh();
  delete missing.geometry.userData.MMD;
  assert.equal(probeModelPhysicsSupport(missing).hair.supported, false);
});

test("zero source springs remain zero and are reported without invented chest tuning", () => {
  const mesh = physicsMesh();
  mesh.geometry.userData.MMD.constraints[2].springRotation = [0, 0, 0];
  const rig = buildPhysicsRigPlan(mesh).chest;
  assert.equal(rig.support.supported, true);
  assert.equal(rig.springConstraintCount, 0);
  assert.deepEqual(rig.constraints[0].springRotation, [0, 0, 0]);
});

test("joint-connected unweighted hair helpers preserve their authored dynamic type and complete snapshot ownership", () => {
  const mesh = physicsMesh();
  const metadata = mesh.geometry.userData.MMD;
  // Bone 9 has no weights or weighted descendants, but the added joint makes
  // its body part of the weighted hair component rather than a separate ornament.
  metadata.constraints.push(joint(2, 7));
  metadata.rigidBodies[7].weight = 0.7;
  const original = JSON.stringify(metadata);
  const rig = buildPhysicsRigPlan(mesh);
  const helper = rig.hair.rigidBodies[rig.hair.sourceBodyIndices.indexOf(7)];
  assert.deepEqual(rig.hair.dynamicBoneIndices, [4, 5, 9], 'all bones the backend may write are captured for restore');
  assert.deepEqual(rig.hair.outputBoneIndices, [4, 5], 'unweighted helpers are simulation-only, not visible output metrics');
  assert.equal(helper.type, 1);
  assert.equal(helper.weight, 0.7);
  assert.equal(rig.hair.dynamicBodyCount, 3);
  assert.equal(rig.hair.support.bones, 2, 'support reports visible output bones separately from simulation bodies');
  assert.equal(rig.hair.support.bodies, 3);
  assert.equal(rig.hair.constraints.length, 4, 'both helper and hair joints retain their endpoints');
  assert.deepEqual(rig.chest.dynamicBoneIndices, [6], 'the chest selection is unchanged');
  assert.deepEqual(rig.chest.outputBoneIndices, [6]);
  assert.equal(JSON.stringify(metadata), original, 'source model metadata is not rewritten');
});

test("an unweighted dynamic hair helper can connect weighted hair to its original static anchor", () => {
  const mesh = physicsMesh();
  const metadata = mesh.geometry.userData.MMD;
  metadata.constraints = [joint(0, 7), joint(7, 1), joint(1, 2)];
  const rig = buildPhysicsRigPlan(mesh).hair;
  assert.equal(rig.support.supported, true);
  assert.deepEqual(rig.dynamicBoneIndices, [4, 5, 9]);
  assert.deepEqual(rig.outputBoneIndices, [4, 5]);
  assert.equal(rig.rigidBodies[rig.sourceBodyIndices.indexOf(7)].type, 1, 'the original helper is not converted into a second fixed anchor');
  assert.equal(rig.constraints.length, 3);
});

test("a separate anchored hair helper without a weighted seed remains outside the dynamic rig", () => {
  const mesh = physicsMesh();
  const rig = buildPhysicsRigPlan(mesh).hair;
  assert.deepEqual(rig.dynamicBoneIndices, [4, 5]);
  assert.equal(rig.sourceBodyIndices.includes(7), false);
  const weights = mesh.geometry.getAttribute('skinWeight');
  weights.setX(0, 0); weights.setX(1, 0);
  assert.equal(buildPhysicsRigPlan(mesh).hair.support.supported, false, 'hair names plus joints and anchors cannot replace a weighted seed');
});

test("hair helper closure does not activate protected bones or bones outside head ancestry", () => {
  for (const change of ['protected-name', 'outside-head'] as const) {
    const mesh = physicsMesh();
    const metadata = mesh.geometry.userData.MMD;
    metadata.constraints.push(joint(2, 7));
    if (change === 'protected-name') mesh.skeleton.bones[9].name = 'hair-eye-helper';
    else mesh.skeleton.bones[0].add(mesh.skeleton.bones[9]);
    mesh.updateMatrixWorld(true);
    const rig = buildPhysicsRigPlan(mesh).hair;
    assert.deepEqual(rig.dynamicBoneIndices, [4, 5], change);
    assert.equal(rig.rigidBodies[rig.sourceBodyIndices.indexOf(7)].type, 0, 'an excluded joint endpoint stays animation-owned');
  }
});

test("a weighted hair and helper component still needs a valid external anchor", () => {
  const mesh = physicsMesh();
  mesh.geometry.userData.MMD.constraints = [joint(1, 2), joint(2, 7)];
  const rig = buildPhysicsRigPlan(mesh).hair;
  assert.equal(rig.support.supported, false);
  assert.deepEqual(rig.dynamicBoneIndices, []);
  assert.deepEqual(rig.outputBoneIndices, []);
});
