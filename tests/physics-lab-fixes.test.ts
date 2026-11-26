/**
 * R01 (2026-11-17: stiff braids that do not hang with physics; a chest that hardly moves and stutters when it does), docs/claude/2026-11-17-physics-lab.md.
 * The private model itself never enters a test: each cause is rebuilt on a synthetic body with the same shape.
 * 1. A chain whose bodies weigh more than 10 000 (the braid: 1.8e7 .. 6e13) was dropped whole.
 * 2. Such a mass range (a 3.5e6 ratio across one joint) blew Bullet's float32 solver up; it is compressed to MAX_MASS_RATIO.
 * 3. A boneless dynamic helper became a kinematic body frozen in world space; the chest hung from it.
 * 4. The chest showed each 30 Hz solve unchanged until the next one: at 60 fps it moved every other frame.
 * 5. Bullet's 1/65 s step does not divide the 1/30 s solve: solves advanced 2 or 3 steps and the result juddered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { LocalModelPhysics } from '../src/stage/model-physics';
import { MAX_MASS_RATIO, buildPhysicsRigPlan, type PhysicsConstraint, type PhysicsRigidBody } from '../src/stage/physics-rig';
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { loadAmmoForTests } from './helpers/ammo-node';
import { chestHandBody } from './helpers/chest-hand-body';
import { mockAmmo, physicsMesh } from './physics-fixture';

type V3 = [number, number, number];
const body = (boneIndex: number, type: number, position: V3, weight: number, groupIndex = 1): PhysicsRigidBody => ({
  boneIndex, type, shapeType: 0, width: 0.2, height: 0, depth: 0, weight: type ? weight : 0, position, rotation: [0, 0, 0], friction: 0.5,
  restitution: 0, positionDamping: 0.5, rotationDamping: 0.5, groupIndex, groupTarget: 1 });
const joint = (a: number, b: number, position: V3, limit = 0.6): PhysicsConstraint => ({ rigidBodyIndex1: a, rigidBodyIndex2: b, position, rotation: [0, 0, 0],
  translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0], rotationLimitation1: [-limit, -limit, -limit], rotationLimitation2: [limit, limit, limit],
  springPosition: [0, 0, 0], springRotation: [0, 0, 0] });

/** A head with a long hair chain (a braid) whose masses fall off from a huge root, as the private model's back hair does. */
function braidMesh(masses: readonly number[]): SkinnedMesh {
  const specs: [string, number, V3][] = [['センター', -1, [0, 9, 0]], ['上半身', 0, [0, 12, 0]], ['首', 1, [0, 15, 0]], ['頭', 2, [0, 16, 0]]];
  masses.forEach((_, i) => specs.push([`後髪_${i}`, i === 0 ? 3 : specs.length - 1, [0, 16 - i * 0.8, -1]]));
  const bones = specs.map(([name]) => { const bone = new Bone(); bone.name = name; return bone; });
  specs.forEach(([, parent, position], i) => {
    bones[i].position.set(...(parent >= 0 ? position.map((v, k) => v - specs[parent][2][k]) as V3 : position));
    if (parent >= 0) bones[parent].add(bones[i]);
  });
  const geometry = new BufferGeometry();
  const weighted = specs.map((_, i) => i).filter(i => i >= 4);
  geometry.setAttribute('position', new Float32BufferAttribute(weighted.flatMap(i => specs[i][2]), 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(weighted.flatMap(i => [i, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weighted.flatMap(() => [1, 0, 0, 0]), 4));
  const rigidBodies = [body(3, 0, [0, 0, 0], 0, 0), ...masses.map((mass, i) => body(4 + i, 1, [0, -0.4, 0], mass))];
  const constraints = masses.map((_, i) => joint(i, i + 1, specs[4 + i][2]));
  geometry.userData.MMD = { rigidBodies, constraints };
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return mesh;
}

const huge = Array.from({ length: 12 }, (_, i) => 6e13 / 3.5 ** i);

test('a braid whose authored masses exceed 10 000 is still simulated (it used to be dropped whole and follow the head rigidly)', () => {
  const plan = buildPhysicsRigPlan(braidMesh(huge));
  assert.equal(plan.support.hair.supported, true, 'the braid is found');
  assert.equal(plan.hair.dynamicBodyCount, 12, 'every braid body stays dynamic');
  assert.equal(plan.hair.outputBoneIndices.length, 12);
});

test('a mass range past what float32 Bullet can solve is compressed in order; a normal range is left exactly as authored', () => {
  const plan = buildPhysicsRigPlan(braidMesh(huge));
  const weights = plan.hair.rigidBodies.filter(entry => entry.type !== 0).map(entry => entry.weight);
  assert.ok(Math.max(...weights) / Math.min(...weights) <= MAX_MASS_RATIO * 1.0001, 'range bounded');
  for (let i = 1; i < weights.length; i++) assert.ok(weights[i] < weights[i - 1], 'heavier root, lighter tip: order kept');
  const plain = [3, 2, 1.5, 1, 0.5];
  const untouched = buildPhysicsRigPlan(braidMesh(plain)).hair.rigidBodies.filter(entry => entry.type !== 0).map(entry => entry.weight);
  assert.deepEqual(untouched, plain);
});

test('real Ammo: the huge-mass braid hangs and holds still instead of blowing up', async () => {
  const ammo = await loadAmmoForTests(), mesh = braidMesh(huge);
  const physics = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 1 } }));
  const tip = mesh.skeleton.bones.at(-1)!;
  const rest = mesh.skeleton.bones.map(bone => ({ p: bone.position.clone(), q: bone.quaternion.clone() }));
  let quietPeak = 0, previous = null as null | number[];
  try {
    for (let frame = 0; frame < 240; frame++) {
      physics.restore();
      mesh.skeleton.bones.forEach((bone, i) => { bone.position.copy(rest[i].p); bone.quaternion.copy(rest[i].q); });
      physics.frame(1 / 60);
      mesh.updateMatrixWorld(true);
      const at = tip.getWorldPosition(tip.position.clone()).toArray();
      assert.ok(at.every(Number.isFinite));
      if (previous && frame > 180) quietPeak = Math.max(quietPeak, Math.hypot(at[0] - previous[0], at[1] - previous[1], at[2] - previous[2]));
      previous = at;
    }
    assert.notEqual(physics.getState().status, 'error');
    assert.ok(quietPeak < 0.01, `held pose: the braid tip is still (${quietPeak})`);
  } finally { physics.dispose(); }
});

test('a boneless dynamic helper stays dynamic in the chest world (it used to freeze in world space and pin the chest)', () => {
  const { mesh } = chestHandBody();
  const meta = mesh.geometry.userData.MMD as { rigidBodies: PhysicsRigidBody[]; constraints: PhysicsConstraint[] };
  // Torso (0) → boneless helper → bust (1), as the private model's chest is built.
  meta.rigidBodies.push(body(-1, 1, [0.7, 14.2, 0.45], 1, 1));
  const helper = meta.rigidBodies.length - 1;
  meta.constraints.push(joint(0, helper, [0.7, 14.2, 0.4]), joint(helper, 1, [0.7, 14.2, 0.5]));
  const plan = buildPhysicsRigPlan(mesh);
  const at = plan.chest.sourceBodyIndices.indexOf(helper);
  assert.ok(at >= 0, 'the helper is in the chest world');
  assert.notEqual(plan.chest.rigidBodies[at].type, 0, 'and dynamic, as authored');
  assert.ok(!plan.chest.dynamicBoneIndices.includes(-1), 'it writes no bone');
});

test('the chest moves on every displayed frame at 60 fps (it used to hold each 30 Hz solve for two frames)', async () => {
  const ammo = await loadAmmoForTests();
  const { mesh } = chestHandBody();
  const center = mesh.skeleton.bones[0];
  const physics = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ chest: { enabled: true, strength: 1 }, quality: 'standard' }));
  const base = center.position.clone();
  let moving = 0, held = 0;
  try {
    for (let frame = 0; frame < 240; frame++) {
      physics.restore();
      center.position.copy(base);
      center.position.x += Math.sin(frame / 60 * Math.PI * 2 * 1.5) * 1.5;
      physics.frame(1 / 60);
      if (frame < 60) continue;
      const chest = physics.getDiagnostics().chest;
      const step = chest.maxFrameAngle + chest.maxFrameDisplacement;
      if (step > 1e-6) moving++; else held++;
    }
  } finally { physics.dispose(); }
  assert.ok(moving > 150, `the chest responds (${moving} moving frames)`);
  assert.equal(held, 0, `no frame shows the previous output unchanged while she moves (${held} held frames)`);
});

test('every Bullet step divides the solve quantum, so each solve advances the same simulated time', () => {
  for (const quality of ['low', 'standard', 'high'] as const) {
    const mock = mockAmmo();
    const physics = new LocalModelPhysics(physicsMesh(), mock.ammo, normalizeModelPhysicsSettings({ hair: { enabled: true }, quality }), mock.factory);
    let unitStep = 0;
    try {
      physics.frame(1 / 60);
      unitStep = (physics as unknown as { parts: { hair: { backend: { unitStep: number } } } }).parts.hair.backend.unitStep;
    } finally { physics.dispose(); }
    const quantum = { low: 1 / 20, standard: 1 / 30, high: 1 / 60 }[quality];
    const steps = quantum / unitStep;
    assert.ok(Math.abs(steps - Math.round(steps)) < 0.01 && unitStep <= 1 / 65, `${quality}: ${steps} steps per solve`);
  }
});
