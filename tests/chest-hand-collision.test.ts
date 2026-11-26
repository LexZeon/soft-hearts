/**
 * Facts given: not Gene, twist bones,
 * 60 fps, chest physics on, and the model's author ships a "no hand–chest collision" variant (the original's hand and chest
 * rigid bodies can collide and shake). This reproduces that on a synthetic body (no user data): a chest on dynamic rigid bodies
 * anchored to the torso, and a kinematic hand body that a gesture sweeps in front of the chest. Real Ammo, the stage's own
 * LocalModelPhysics. Measured: the chest bone's per-frame turn and its "unexpected" step (how far a frame's step departs from
 * the previous one), the hand sweeping through the chest vs the same sweep far in front of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { LocalModelPhysics } from '../src/stage/model-physics';
import { buildPhysicsRigPlan, type PhysicsConstraint, type PhysicsRigidBody } from '../src/stage/physics-rig';
import { chestHandBody } from './helpers/chest-hand-body';

export { chestHandBody };
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { loadAmmoForTests } from './helpers/ammo-node';

const DEG = 180 / Math.PI;
type V3 = [number, number, number];
const body = (boneIndex: number, type: number, position: V3, radius: number, groupIndex: number): PhysicsRigidBody => ({
  boneIndex, type, shapeType: 0, width: radius, height: 0, depth: 0, weight: type ? 1 : 0, position, rotation: [0, 0, 0], friction: 0.5, restitution: 0,
  positionDamping: 0.5, rotationDamping: 0.5, groupIndex, groupTarget: 65535 });
const joint = (a: number, b: number, position: V3): PhysicsConstraint => ({ rigidBodyIndex1: a, rigidBodyIndex2: b, position, rotation: [0, 0, 0],
  translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0], rotationLimitation1: [-0.6, -0.6, -0.6], rotationLimitation2: [0.6, 0.6, 0.6],
  springPosition: [0, 0, 0], springRotation: [20, 20, 20] });


/** The hand sweeps left-right at chest height, `depth` in front of the body, the way a talking gesture crosses the chest. */
async function sweep(fps: number, depth: number, period = 1.6) {
  const ammo = await loadAmmoForTests(), { mesh, chest, hand } = chestHandBody();
  const physics = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings({ chest: { enabled: true, strength: 1 }, hair: { enabled: false }, quality: 'standard' }));
  const rest = hand.position.clone(), world = new Quaternion(), shown: Quaternion[] = [];
  let resets = 0; const reset = (physics as any).resetRuntime.bind(physics); (physics as any).resetRuntime = (runtime: unknown) => { resets++; reset(runtime); };
  try {
    const dt = 1 / fps, frames = Math.round(8 * fps);
    for (let i = 0; i < frames; i++) {
      physics.restore();
      const t = i * dt, phase = Math.min(1, t / 1.5); // ease in to the sweep
      // In the hand's parent (手捩) frame: across the chest (x), at the bust's height, `depth` in front.
      const x = 4.9 + 0.7 + 1.9 * Math.sin(2 * Math.PI * t / period) * phase;
      hand.position.set(rest.x + (x - rest.x) * phase, rest.y + (14.2 - 12.9 - rest.y) * phase, rest.z + depth * phase);
      mesh.updateMatrixWorld(true);
      physics.frame(dt);
      mesh.updateMatrixWorld(true);
      if (t >= 2) shown.push(chest.getWorldQuaternion(world).clone());
    }
  } finally { physics.dispose(); mesh.geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose(); }
  let step = 0, surprise = 0;
  for (let i = 2; i < shown.length; i++) {
    const a = shown[i].clone().multiply(shown[i - 1].clone().invert()), b = shown[i - 1].clone().multiply(shown[i - 2].clone().invert());
    step = Math.max(step, shown[i].angleTo(shown[i - 1]) * DEG); surprise = Math.max(surprise, a.angleTo(b) * DEG);
  }
  return { step, surprise, resets, plan: buildPhysicsRigPlan(mesh).chest };
}

// Before: the hand and elbow bodies were in the chest's world as kinematic colliders, and every included kinematic bone counted as an
// anchor. A fast sweep (0.5 s period, ~0.8 model units per frame at 30 fps) read as "the anchor jumped": the world reset and the
// bust turned 14.8° in one frame (29.7° unexpected), the same whether the hand touched the bust or passed far in front of it.
test('a hand sweeping past the bust, slow or fast, through it or in front of it, never resets the chest world or kicks the bust', async () => {
  for (const fps of [60, 30]) {
    const runs = { clear: await sweep(fps, 4), through: await sweep(fps, 1.05), fast: await sweep(fps, 1.05, 0.5), fastClear: await sweep(fps, 4, 0.5) };
    for (const [name, r] of Object.entries(runs)) {
      if (process.env.R29_REPORT) console.log(`[chest-hand ${fps}fps] ${name} step ${r.step.toFixed(3)} surprise ${r.surprise.toFixed(3)} resets ${r.resets}`);
      assert.equal(r.resets, 1, `${fps} fps ${name}: only the world's first start`);
      assert.ok(r.surprise <= runs.clear.surprise * 1.5 + 0.05, `${fps} fps ${name}: ${r.surprise.toFixed(3)}° unexpected per frame vs ${runs.clear.surprise.toFixed(3)}° with the hand far away`);
    }
  }
});

test('the chest world keeps the torso anchor but not the arm and hand collision bodies', () => {
  const plan = buildPhysicsRigPlan(chestHandBody().mesh).chest;
  assert.equal(plan.support.supported, true);
  assert.deepEqual(plan.sourceBodyIndices, [0, 1, 2], `torso anchor and the two bust bodies; hand (3) and elbow (4) left out: ${JSON.stringify({ dynamic: plan.dynamicBoneIndices, output: plan.outputBoneIndices, anchors: plan.anchorBoneIndices })}`);
});
