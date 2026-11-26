// I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): a VRM's own spring bones (src/stage/vrm-spring/). What the loaded model hands on
// (chains, colliders, 0.x tails and gravity), the body colliders added for a skirt with none of its own, and the gates: the step is
// bounded (a placed figure is carried, a tail never spins faster than MAX_SPIN), the colliders hold, the switches are honoured, and the
// companion window's physics takes a VRM's springs (no Ammo for its standard skeleton, hidden pauses them, the preview runs none).
// Every model here is the synthetic one (tests/helpers/synthetic-vrm.ts); nothing from a real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3, type Bone } from 'three';
import { normalizeModelPhysicsSettings } from '../shared/stage/model-physics';
import { springWorldDir } from '../src/stage/model-adapter/vrm';
import { MAX_SPIN, VrmSpringPhysics } from '../src/stage/vrm-spring/vrm-springs';
import { nearestOnSegment } from '../src/stage/vrm-spring/spring-rig';
import { WindowPhysics, type WindowPhysicsRuntime } from '../src/unbound/window-mode/window-physics';
import { configureFigurePhysics } from '../src/unbound/figure-physics';
import { StandardBody } from '../src/unbound/model/standard-body';
import { syntheticStandardBody } from './helpers/unbound-vrm';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { PHYSICS_OFF, PHYSICS_ON } from './helpers/vrm-spring-harness';

const DEG = 180 / Math.PI;
const skirtBody = (extra: Parameters<typeof syntheticVrm>[0] = {}) => syntheticStandardBody(extra.version ?? '1.0', syntheticVrm({ body: 'full', skirt: true, ...extra }));
const springsOf = (body: StandardBody) => body.springs!;
const worldTail = (joint: VrmSpringPhysics['rig']['chains'][number]['joints'][number]) => joint.axis.clone().multiplyScalar(joint.length).applyMatrix4(joint.bone.matrixWorld);

test('the loaded VRM hands on its chains, colliders and groups; 0.x gravity turns into the stage\'s world', async () => {
  const body = await skirtBody();
  try {
    const physics = body.model.physics;
    assert.equal(physics.kind, 'vrm-spring');
    if (physics.kind !== 'vrm-spring') return;
    assert.equal(physics.chains.length, 9, 'hair and eight skirt chains');
    assert.equal(physics.shapes?.filter(Boolean).length, 2, 'the head sphere and the chest capsule');
    assert.deepEqual(physics.groups, [[0, 1]]);
    assert.equal(physics.chains[0].leafTail, false);
  } finally { body.dispose(); }
  assert.deepEqual(springWorldDir('0.x', [0.5, -1, 0.25]), [-0.5, -1, 0.25], '0.x: Unity\'s right is our left');
  assert.deepEqual(springWorldDir('1.0', [0.5, -1, 0.25]), [0.5, -1, 0.25]);
});

test('the rig: 1.0 hair swings two bones (the last joint is its tail), 0.x three (a virtual tail); the skirt gets her leg capsules, the hair does not', async () => {
  for (const version of ['1.0', '0.x'] as const) {
    const body = await skirtBody({ version });
    try {
      const rig = springsOf(body).rig, hair = rig.chains.find(chain => chain.name.startsWith('Hair'))!, skirts = rig.chains.filter(chain => chain.name.startsWith('Skirt'));
      assert.equal(hair.joints.length, version === '1.0' ? 2 : 3, `${version}: hair joints`);
      assert.equal(skirts.length, 8, `${version}: skirt chains`);
      assert.ok(skirts.every(chain => chain.joints.length === (version === '1.0' ? 4 : 5)), `${version}: skirt joints`);
      assert.equal(rig.bodyColliders, 5, `${version}: hips, two thighs, two shins`);
      assert.ok(skirts.every(chain => chain.colliderIndices.filter(index => rig.colliders[index].added).length === 5), 'every skirt chain keeps out of her legs');
      assert.ok(!hair.colliderIndices.some(index => rig.colliders[index].added), 'hair keeps only the file\'s colliders');
      assert.ok(rig.chains.every(chain => chain.part === 'hair'), 'no bust chains: everything is the hair switch\'s');
      // Leg capsules from her mesh (synthetic-vrm-body.ts: thigh tube 6.5 cm, shin 4.5 cm).
      const thigh = rig.colliders.find(collider => collider.added && collider.bone === body.model.bone('legLeft'))!;
      const shin = rig.colliders.find(collider => collider.added && collider.bone === body.model.bone('kneeLeft'))!;
      assert.ok(Math.abs(thigh.radiusM - 0.065) < 0.01 && Math.abs(shin.radiusM - 0.045) < 0.01, `leg radii from her mesh (${thigh.radiusM.toFixed(3)}, ${shin.radiusM.toFixed(3)})`);
      const support = springsOf(body).support();
      assert.equal(support.hair.supported, true); assert.equal(support.chest.supported, false);
      assert.equal(support.hair.bones, rig.chains.reduce((sum, chain) => sum + chain.joints.length, 0));
    } finally { body.dispose(); }
  }
});

test('the model\'s own collider wins: a thigh that already carries one of the skirt\'s colliders gets no runtime capsule', async () => {
  const body = await skirtBody({ skirtThighCollider: true });
  try {
    const rig = springsOf(body).rig, leftThigh = body.model.bone('legLeft');
    assert.equal(rig.bodyColliders, 4, 'the left thigh is the file\'s');
    assert.ok(!rig.colliders.some(collider => collider.added && collider.bone === leftThigh));
    assert.ok(rig.colliders.some(collider => !collider.added && collider.bone === leftThigh));
  } finally { body.dispose(); }
});

/** The springs alone (no frame loop): her body posed by hand, `frame` after each pose. */
async function bareSprings() {
  const body = await skirtBody(), springs = springsOf(body);
  springs.configure(PHYSICS_ON);
  body.mesh.updateMatrixWorld(true);
  return { body, springs, step: (dt: number) => { body.mesh.updateMatrixWorld(true); springs.frame(dt); body.mesh.updateMatrixWorld(true); } };
}
const hairTip = (springs: VrmSpringPhysics) => { const hair = springs.rig.chains.find(chain => chain.name.startsWith('Hair'))!; return hair.joints[hair.joints.length - 1]; };

test('gate (step bounded): placed somewhere else, the chain is carried with her; nothing whips across', async () => {
  const { body, springs, step } = await bareSprings();
  try {
    const head = body.model.bone('head')!, tip = hairTip(springs);
    // Awake (a still chain sleeps, and a sleeping chain is carried by her skeleton anyway): her head nods gently, then holds a frame.
    for (let i = 0; i < 60; i++) { head.rotation.x = Math.sin(i / 6) * 0.15; step(1 / 60); }
    assert.equal(springs.sleeping, false);
    const relative = () => { const q = head.getWorldQuaternion(new Quaternion()).invert(); return worldTail(tip).sub(head.getWorldPosition(new Vector3())).applyQuaternion(q); };
    const before = relative();
    body.mesh.position.x += 3 * 12.5; body.mesh.rotation.y += Math.PI / 2; // three metres away, turned a quarter: placed, not walked
    step(1 / 60);
    const after = relative();
    // One frame of its own swing at most (the nod's last frame), not a fling from where she was.
    assert.ok(after.distanceTo(before) < 0.01 * 12.5, `the hair keeps its shape where she was placed (${(after.distanceTo(before) / 12.5 * 100).toFixed(2)} cm)`);
  } finally { body.dispose(); }
});

test('gate (step bounded): however hard she is shaken, a tail never turns round its head faster than MAX_SPIN', async () => {
  const { body, springs, step } = await bareSprings();
  try {
    for (let i = 0; i < 30; i++) step(1 / 60);
    const tip = hairTip(springs);
    let previous: Vector3 | null = null, fastest = 0;
    for (let i = 0; i < 40; i++) {
      body.mesh.position.z = (i % 2 ? -1 : 1) * 0.25 * 12.5; // half a metre a frame back and forth (just under a placement)
      step(1 / 60);
      // The tail's turn round its own head, in the world (what the bound limits), per rendered frame.
      const direction = worldTail(tip).sub(tip.bone.getWorldPosition(new Vector3())).normalize();
      if (previous) fastest = Math.max(fastest, direction.angleTo(previous) * 60);
      previous = direction;
      assert.ok([direction.x, direction.y, direction.z].every(Number.isFinite), 'no NaN');
    }
    assert.ok(fastest <= MAX_SPIN * 1.05, `its spin stays within the bound (${fastest.toFixed(1)} rad/s, bound ${MAX_SPIN})`);
  } finally { body.dispose(); }
});

test('gate (colliders hold): the file\'s head collider keeps her hair out when her head is snatched back', async () => {
  const { body, springs, step } = await bareSprings();
  try {
    for (let i = 0; i < 30; i++) step(1 / 60);
    const rig = springs.rig, hair = rig.chains.find(chain => chain.name.startsWith('Hair'))!;
    const sphere = rig.colliders.find(collider => !collider.added && collider.tail === null)!;
    let worst = Infinity;
    for (let i = 0; i < 20; i++) {
      if (i < 4) body.mesh.position.z -= 0.2 * 12.5; // her head (and body) snatched back 20 cm a frame: the hair behind it lags into it
      step(1 / 60);
      const s = body.model.object.matrixWorld.getMaxScaleOnAxis(), centre = sphere.offset.clone().applyMatrix4(sphere.bone.matrixWorld);
      for (const joint of hair.joints) worst = Math.min(worst, (worldTail(joint).distanceTo(centre) - (sphere.radiusM + joint.hitRadius) * s) / s);
    }
    // Within 2 mm of the reach (the push and the bone's length settle in a few passes; the hair's root sits inside the head's reach).
    assert.ok(worst >= -0.002, `the hair stays outside her head (nearest ${(worst * 100).toFixed(2)} cm from the collider's reach)`);
  } finally { body.dispose(); }
});

test('her legs: a thigh swung into the skirt in one frame never leaves a skirt joint inside it', async () => {
  const { body, springs, step } = await bareSprings();
  try {
    for (let i = 0; i < 60; i++) step(1 / 60);
    const thigh = body.model.bone('legLeft')!, rig = springs.rig, capsule = rig.colliders.find(collider => collider.added && collider.bone === thigh)!;
    const skirts = rig.chains.filter(chain => chain.name.startsWith('Skirt'));
    let worst = Infinity;
    for (let i = 0; i < 30; i++) {
      thigh.rotateX(-(i < 15 ? 5 : -5) / DEG); // forward 75° and back, 5° a frame (300°/s)
      step(1 / 60);
      const s = body.model.object.matrixWorld.getMaxScaleOnAxis();
      const a = capsule.offset.clone().applyMatrix4(thigh.matrixWorld), b = capsule.tail!.clone().applyMatrix4(thigh.matrixWorld);
      for (const chain of skirts) for (const joint of chain.joints) {
        const tail = worldTail(joint);
        worst = Math.min(worst, (tail.distanceTo(nearestOnSegment(tail, a, b, new Vector3())) - capsule.radiusM * s) / s);
      }
    }
    assert.ok(worst >= -1e-4, `the skirt stays outside her thigh (nearest ${(worst * 100).toFixed(2)} cm from its surface)`);
  } finally { body.dispose(); }
});

test('gate (switches): hair off eases back to the rest pose (never a snap) and stays there; quality changes the substeps', async () => {
  const { body, springs, step } = await bareSprings();
  try {
    const head = body.model.bone('head')!;
    for (let i = 0; i < 60; i++) { head.rotation.y = Math.sin(i / 8) * 0.6; step(1 / 60); }
    assert.equal(springs.lastSubsteps, 2, 'standard: 1/120 s');
    const tip = hairTip(springs), rest = tip.restLocal;
    assert.ok(tip.bone.quaternion.angleTo(rest) * DEG > 1, 'swinging while on');
    springs.configure(normalizeModelPhysicsSettings({ ...PHYSICS_ON, hair: { enabled: false, strength: 1 } }));
    let largest = 0, previous = tip.bone.quaternion.clone();
    for (let i = 0; i < 40; i++) { head.rotation.y = Math.sin((60 + i) / 8) * 0.6; step(1 / 60); largest = Math.max(largest, tip.bone.quaternion.angleTo(previous) * DEG); previous = tip.bone.quaternion.clone(); }
    assert.ok(tip.bone.quaternion.angleTo(rest) < 1e-6, 'off: at rest');
    assert.ok(largest < 6, `eased back, no snap (largest step ${largest.toFixed(2)}°)`);
    assert.equal(springs.running, false);
    assert.deepEqual(springs.bones(), [], 'nothing for the pace once off');
    springs.configure(normalizeModelPhysicsSettings({ ...PHYSICS_ON, quality: 'high' }));
    step(1 / 60);
    assert.equal(springs.lastSubsteps, 4, 'high: 1/240 s');
    springs.configure(PHYSICS_OFF);
    for (let i = 0; i < 40; i++) step(1 / 60);
    assert.ok(springs.rig.chains.every(chain => chain.joints.every(joint => joint.bone.quaternion.angleTo(joint.restLocal) < 1e-6)), 'all off: every spring bone at rest');
  } finally { body.dispose(); }
});

test('hidden: no work; shown again the chain is carried (no fling from the time away); still chains sleep and wake when she moves', async () => {
  const { body, springs, step } = await bareSprings();
  try {
    for (let i = 0; i < 120; i++) step(1 / 60);
    assert.equal(springs.sleeping, true, 'still for a while: asleep');
    step(1 / 60);
    assert.equal(springs.lastMs < 1, true);
    body.mesh.position.x += 0.05 * 12.5;
    step(1 / 60);
    assert.equal(springs.sleeping, false, 'she moved: awake');
    const tip = hairTip(springs), before = tip.bone.quaternion.clone();
    springs.setVisible(false);
    body.mesh.position.x += 0.3 * 12.5;
    step(1 / 60);
    assert.ok(tip.bone.quaternion.angleTo(before) < 1e-9, 'hidden: nothing written');
    springs.setVisible(true);
    step(2);
    assert.ok(tip.bone.quaternion.angleTo(before) * DEG < 1, 'shown again after two seconds: carried, not flung');
  } finally { body.dispose(); }
});

test('full-screen: the tier and the setting reach a VRM\'s springs by her figure\'s mesh', async () => {
  const body = await skirtBody();
  try {
    assert.equal(StandardBody.ofMesh(body.mesh), body);
    let configured: unknown = null;
    configureFigurePhysics({ mesh: body.mesh, configurePhysics: (s: unknown) => { configured = s; } } as never, { ...PHYSICS_ON, quality: 'low' });
    assert.ok(configured, 'the figure\'s own physics still configured');
    assert.equal(springsOf(body).currentSettings.quality, 'low');
    assert.equal(springsOf(body).currentSettings.hair.enabled, true);
  } finally { body.dispose(); }
  assert.equal(StandardBody.ofMesh(body.mesh), null, 'gone with her');
});

test('gate (window physics): a VRM\'s springs take the switches, hidden pauses them, the preview runs none, and no Ammo is loaded', async () => {
  const body = await skirtBody(), springs = springsOf(body);
  let ammoLoads = 0;
  const runtime: WindowPhysicsRuntime = { loadAmmo: async () => { ammoLoads++; throw new Error('no Ammo here'); }, support: () => { throw new Error('not for a VRM'); },
    make: () => { throw new Error('not for a VRM'); }, outputBones: () => ({ hair: [], chest: [] }) };
  const figure = { mesh: body.mesh, configureJelly() {}, attachPhysics() {}, hidePhysics() {} };
  try {
    const physics = new WindowPhysics(runtime);
    await physics.set(PHYSICS_ON);
    await physics.attach(figure, springs);
    assert.equal(ammoLoads, 0, 'no Ammo world for the standard skeleton');
    assert.equal(springs.currentSettings.hair.enabled, true);
    const state = physics.state(false);
    assert.equal(state.status, 'running'); assert.equal(state.support.hair.supported, true);
    assert.ok((physics.springBones() ?? []).length > 0, 'the pace watches her spring bones');
    let hidden = 0;
    const visible = springs.setVisible.bind(springs);
    springs.setVisible = (value: boolean) => { if (!value) hidden++; visible(value); };
    physics.setShown(false);
    assert.equal(hidden, 1, 'hidden: the springs pause');
    assert.equal(physics.state(false).status, 'hidden');
    await physics.set(PHYSICS_OFF);
    assert.equal(springs.currentSettings.hair.enabled, false, 'switched off reaches them');
    const preview = new WindowPhysics(runtime);
    preview.previewOnly = true;
    await preview.set(PHYSICS_ON);
    await preview.attach(figure, springs);
    assert.equal(springs.currentSettings.hair.enabled, false, 'the control window\'s preview runs no physics');
    assert.equal(preview.springBones(), null);
  } finally { body.dispose(); }
});
