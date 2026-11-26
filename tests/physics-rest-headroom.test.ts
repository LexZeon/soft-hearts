/**
 * Codex T-251's two residual physics risks (docs/claude/2026-11-17-physics-lab.md, 「T-251 余项」). Synthetic bodies only.
 * 1. A dynamic chest helper bound to a bone with no skin of its own (a tip bone, or a helper whose name no rule knows) left the dynamic
 *    set and became a kinematic body glued to the animated pose: the bust hung between two pinned ends and barely moved.
 * 2. The chest's rotation was bounded relative to the animated pose before its rest angle was separated: a rest angle near or past the
 *    bound used up the swing (the private model's bust rests at 0.245 rad of its 0.3 rad bound).
 * 3. Found on the way: the bound itself was `q.slerpQuaternions(IDENTITY, q, t)`, which three evaluates as identity → identity, so a
 *    rotation past the bound became no rotation at all (the braid snapped back to the pose at the top of each swing).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { LocalModelPhysics, type LocalPhysicsFactory } from '../src/stage/model-physics';
import { buildPhysicsRigPlan, type PhysicsConstraint, type PhysicsRigidBody } from '../src/stage/physics-rig';
import { boundAroundRest } from '../src/stage/physics-rest-split';
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { loadAmmoForTests } from './helpers/ammo-node';
import { mockAmmo, physicsMesh } from './physics-fixture';

type V3 = [number, number, number];
const body = (boneIndex: number, type: number, position: V3, radius: number, groupIndex: number): PhysicsRigidBody => ({
  boneIndex, type, shapeType: 0, width: radius, height: 0, depth: 0, weight: type ? 1 : 0, position, rotation: [0, 0, 0], friction: 0.5, restitution: 0,
  positionDamping: 0.5, rotationDamping: 0.5, groupIndex, groupTarget: 1 });
const joint = (a: number, b: number, position: V3, limit = 0.6, spring = 20): PhysicsConstraint => ({ rigidBodyIndex1: a, rigidBodyIndex2: b, position,
  rotation: [0, 0, 0], translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0],
  rotationLimitation1: [-limit, -limit, -limit], rotationLimitation2: [limit, limit, limit], springPosition: [0, 0, 0], springRotation: [spring, spring, spring] });

/**
 * A torso and a bust whose chain carries two dynamic helpers on skinless bones: a tip (左胸先, a child of the bust with no weights
 * below it) and a side helper (左補助, under the upper chest, named by no rule). Optionally an animation-owned dynamic body on the
 * upper chest itself (an anchor) and a dynamic body on a weighted ribbon bone (its own visible skin).
 */
function helperChest(extras: { anchor?: boolean; ribbon?: boolean } = {}): SkinnedMesh {
  const specs: [string, number, V3][] = [
    ['センター', -1, [0, 9.2, 0]], ['上半身', 0, [0, 11.8, 0]], ['上半身2', 1, [0, 13.8, 0]],
    ['左胸', 2, [0.7, 14.2, 0.35]], ['左胸先', 3, [0.7, 14.2, 1.1]], ['左補助', 2, [0.7, 13.6, 0.9]], ['リボン', 2, [0, 13.4, 1.0]],
  ];
  const bones = specs.map(([name]) => { const bone = new Bone(); bone.name = name; return bone; });
  specs.forEach(([, parent, position], i) => {
    bones[i].position.set(...(parent >= 0 ? position.map((v, k) => v - specs[parent][2][k]) as V3 : position));
    if (parent >= 0) bones[parent].add(bones[i]);
  });
  const geometry = new BufferGeometry();
  const weighted = [1, 2, 3, 6];
  geometry.setAttribute('position', new Float32BufferAttribute(weighted.flatMap(i => specs[i][2]), 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(weighted.flatMap(i => [i, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weighted.flatMap(() => [1, 0, 0, 0]), 4));
  const rigidBodies = [
    body(2, 0, [0, 13.9, -0.35], 0.75, 0),    // 0 upper chest (kinematic anchor)
    body(3, 1, [0.7, 14.2, 0.6], 0.42, 1),    // 1 bust (weighted output)
    body(4, 1, [0.7, 14.2, 1.05], 0.2, 1),    // 2 tip helper: chest-named bone, no weighted descendants
    body(5, 1, [0.7, 13.6, 0.9], 0.2, 1),     // 3 side helper: a name no rule knows, no weights
  ];
  const constraints = [joint(0, 1, [0.7, 14.2, 0.35]), joint(1, 2, [0.7, 14.2, 0.85]), joint(1, 3, [0.7, 13.9, 0.8])];
  if (extras.anchor) { rigidBodies.push(body(2, 2, [0, 14.2, 0.2], 0.3, 1)); constraints.push(joint(rigidBodies.length - 1, 1, [0.5, 14.2, 0.35])); }
  if (extras.ribbon) { rigidBodies.push(body(6, 1, [0, 13.4, 1.0], 0.2, 1)); constraints.push(joint(1, rigidBodies.length - 1, [0.3, 13.6, 0.9])); }
  geometry.userData.MMD = { rigidBodies, constraints };
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return mesh;
}

const typeOf = (mesh: SkinnedMesh, source: number) => {
  const plan = buildPhysicsRigPlan(mesh).chest, at = plan.sourceBodyIndices.indexOf(source);
  assert.ok(at >= 0, `body ${source} is in the chest world`);
  return plan.rigidBodies[at].type;
};

test('T-251: dynamic helpers on skinless bones stay dynamic in the chest world (they used to become kinematic and pin the bust)', () => {
  const mesh = helperChest();
  const plan = buildPhysicsRigPlan(mesh).chest;
  assert.equal(plan.support.supported, true);
  assert.notEqual(typeOf(mesh, 2), 0, 'the tip helper (chest-named bone, nothing weighted below it) stays dynamic');
  assert.notEqual(typeOf(mesh, 3), 0, 'the side helper (a name no rule knows) stays dynamic');
  assert.deepEqual(plan.outputBoneIndices, [3], 'only the bust is shown: the helpers write no visible bone');
  assert.equal(plan.dynamicBodyCount, 3);
});

test('T-251: the anchor, and a body with its own visible skin, stay kinematic', () => {
  const mesh = helperChest({ anchor: true, ribbon: true });
  const plan = buildPhysicsRigPlan(mesh).chest;
  assert.equal(typeOf(mesh, 4), 0, 'a dynamic body on the animation-owned upper chest is the anchor, not a helper');
  assert.ok(!plan.dynamicBoneIndices.includes(2), 'the upper chest is never written');
  assert.equal(typeOf(mesh, 5), 0, 'a ribbon with its own skin is not simulated unseen under the bust');
  assert.ok(!plan.dynamicBoneIndices.includes(6));
});

test('T-251 real Ammo: with its helpers free the bust swings as authored (pinned, it swung about half as much)', async () => {
  const ammo = await loadAmmoForTests();
  const swing = (mesh: SkinnedMesh) => {
    const center = mesh.skeleton.bones[0], bust = mesh.skeleton.bones[3];
    const physics = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ chest: { enabled: true, strength: 1 }, quality: 'standard' }));
    const base = center.position.clone(), rest = bust.quaternion.clone();
    let low = Infinity, high = -Infinity;
    try {
      for (let frame = 0; frame < 300; frame++) {
        physics.restore();
        center.position.copy(base);
        center.position.x += Math.sin(frame / 60 * Math.PI * 2 * 1.2) * 1.2;
        physics.frame(1 / 60);
        if (frame < 120) continue;
        const turn = rest.clone().invert().multiply(bust.quaternion);
        const angle = 2 * Math.atan2(turn.z, turn.w);
        low = Math.min(low, angle); high = Math.max(high, angle);
      }
    } finally { physics.dispose(); }
    return high - low;
  };
  const free = swing(helperChest());
  // The same chest with its helpers forced kinematic, as the old rule built it.
  const pinned = helperChest();
  for (const index of [2, 3]) (pinned.geometry.userData.MMD as { rigidBodies: PhysicsRigidBody[] }).rigidBodies[index].type = 0;
  const held = swing(pinned);
  assert.ok(free > 0.02, `the bust swings (${free.toFixed(4)} rad peak to peak)`);
  assert.ok(free > held * 1.5, `free helpers let it swing more than pinned ones (${free.toFixed(4)} vs ${held.toFixed(4)})`);
});

test('T-251: the bound applies to the swing around the rest value, and to the rest value apart', () => {
  const cap = 0.3, about = new Vector3(0, 0, 1);
  const turn = (angle: number) => new Quaternion().setFromAxisAngle(about, angle);
  const angleOf = (q: Quaternion) => 2 * Math.atan2(q.z, q.w);
  // Rest past the bound: the rest part is bounded to the cap, the swing around it keeps its size.
  const out = boundAroundRest(turn(0.75), turn(0.6), cap, new Quaternion());
  assert.ok(Math.abs(angleOf(out) - (cap + 0.15)) < 1e-6, `rest 0.6 → ${cap}, swing 0.15 kept (${angleOf(out)})`);
  // A swing past the bound is bounded on its own.
  assert.ok(Math.abs(angleOf(boundAroundRest(turn(0.1 + 0.9), turn(0.1), cap, new Quaternion())) - (0.1 + cap)) < 1e-6);
  // Settled inside the bound: exactly the raw value (looks as before at rest).
  assert.ok(Math.abs(angleOf(boundAroundRest(turn(0.2), turn(0.2), cap, new Quaternion())) - 0.2) < 1e-9);
});

/**
 * A scripted solver: after each Bullet update, `part`'s bones are turned `angleAt(time)` about z from the pose they were solved from.
 * Returns the shown z angle of `bone` relative to its pose for each frame at 60 fps.
 */
function shownAngles(part: 'hair' | 'chest', bone: number, angleAt: (time: number) => number, frames: number): number[] {
  const mock = mockAmmo();
  const mesh = physicsMesh();
  let time = 0;
  const factory: LocalPhysicsFactory = (m, rig, budget) => {
    const inner = mock.factory(m, rig, budget);
    return {
      get unitStep() { return inner.unitStep; }, set unitStep(value) { inner.unitStep = value; },
      get maxStepNum() { return inner.maxStepNum; }, set maxStepNum(value) { inner.maxStepNum = value; },
      reset: () => inner.reset(),
      update(dt) {
        const before = rig.dynamicBoneIndices.map(index => m.skeleton.bones[index].quaternion.clone());
        inner.update(dt);
        time += dt;
        if (rig.part !== part) return;
        rig.dynamicBoneIndices.forEach((index, i) => m.skeleton.bones[index].quaternion.copy(before[i])
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angleAt(time))));
      },
    };
  };
  const physics = new LocalModelPhysics(mesh, mock.ammo, normalizeModelPhysicsSettings({ [part]: { enabled: true, strength: 1 } }), factory);
  const target = mesh.skeleton.bones[bone], base = target.quaternion.clone(), angles: number[] = [];
  try {
    for (let frame = 0; frame < frames; frame++) {
      physics.restore();
      physics.frame(1 / 60);
      const turn = base.clone().invert().multiply(target.quaternion);
      angles.push(2 * Math.atan2(turn.z, turn.w));
    }
  } finally { physics.dispose(); }
  return angles;
}

test('T-251: a chest resting past its rotation bound still swings, and the swing stays bounded (it used to sit on the bound, still)', () => {
  // The solver's chest rests 0.6 rad off the pose (twice the 0.3 rad bound) and swings ±0.12 rad around it at 1.5 Hz.
  const angles = shownAngles('chest', 6, time => 0.6 + 0.12 * Math.sin(time * Math.PI * 2 * 1.5), 480);
  const settled = angles.slice(240);
  const low = Math.min(...settled), high = Math.max(...settled), largest = Math.max(...settled.map(Math.abs));
  const largestStep = Math.max(...angles.slice(1).map((angle, i) => Math.abs(angle - angles[i])));
  assert.ok(high - low > 0.1, `it swings (${(high - low).toFixed(4)} rad peak to peak)`);
  assert.ok(largest <= 0.3 * 2 + 1e-6, `bounded: rest bound plus swing bound (${largest.toFixed(4)} rad)`);
  assert.ok(largestStep < 0.05, `no step from one frame to the next (${largestStep.toFixed(4)} rad)`);
});

test('T-251: hair turned past its 0.7 rad bound is held at the bound (it used to snap back to no turn at all)', () => {
  const angles = shownAngles('hair', 4, () => 0.9, 240);
  const held = angles.at(-1)!;
  assert.ok(Math.abs(held - 0.7) < 0.01, `shown at the bound, not at the pose (${held.toFixed(4)} rad)`);
});
