// I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): a VRM in Unbound's engine, through the standard body
// (src/unbound/model/), on the synthetic VRMs (tests/helpers/synthetic-vrm.ts, nothing from a real model):
//  - the standard skeleton: Gene's names and hierarchy at the VRM's joints, which VRM bone each one drives, the face it has;
//  - the window body's real frame loop at 60 and 30 fps on the VRM's OWN bones: she stays where she stands, her T-pose arms come
//    down, blinks close fully and open again, her mouth opens and closes while she speaks (in proportion, never pinned at the top),
//    her eyes and head follow the cursor, a pat (small smile, lids half down, head up) comes and goes, and nothing jumps;
//  - the VRM's own look settings: look expressions (lookLeft/Right) when the file says so, eye bones by its range maps otherwise;
//  - a model bone's own rest orientation never changes the pose she shows (the transfer works by direction);
//  - MMD models: Gene's bones are found by their exact names exactly as before (no alias lookup), a PMX with English bone names
//    is found through the alias table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, Vector3, type AnimationClip, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { readFile } from 'node:fs/promises';
import { glbWithJson, readGlbJson } from '../shared/foundation/glb-json';
import { parseVrmModel } from '../src/stage/model-adapter/vrm';
import { StandardBody } from '../src/unbound/model/standard-body';
import { aliasHits } from '../src/unbound/model/figure-bones';
import { standardHeadContact } from '../src/unbound/model/standard-contact';
import { BodyRig } from '../src/unbound/contact';
import { UnboundFigure } from '../src/unbound/figure';
import { parseVmdWith } from '../src/foundation/vmd';
import { REST_TARGETS } from '../src/unbound/motion/generator';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { STAND_VMD, geneFigure, max } from './helpers/unbound-gene';
import { inertTextures, runVrmWindowBody, syntheticStandardBody } from './helpers/unbound-vrm';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { RENAMED } from './helpers/motion-coverage';

const DEG = 180 / Math.PI;
const yawOf = (q: Quaternion) => new Euler().setFromQuaternion(q, 'YXZ').y * DEG;

async function standClipFor(body: StandardBody): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, body.transform);
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, body.mesh);
  clip.duration = Math.max(clip.duration, 4);
  return clip;
}

// ---- the standard skeleton ---------------------------------------------------------------------------------------------------

for (const version of ['1.0', '0.x'] as const) {
  test(`VRM ${version}: the standard skeleton has Gene's names at the VRM's joints, drives the VRM's humanoid bones, and has its face`, async () => {
    const body = await syntheticStandardBody(version);
    try {
      const drives = Object.fromEntries(body.specs.map(spec => [spec.name, spec.drives?.name ?? null]));
      assert.equal(drives['下半身'], 'J_Bip_C_Hips'); assert.equal(drives['上半身'], 'J_Bip_C_Spine'); assert.equal(drives['上半身2'], 'J_Bip_C_Chest');
      assert.equal(drives['頭'], 'J_Bip_C_Head'); assert.equal(drives['左腕'], 'J_Bip_L_UpperArm'); assert.equal(drives['右ひじ'], 'J_Bip_R_LowerArm');
      assert.equal(drives['左足首'], 'J_Bip_L_Foot'); assert.equal(drives['左目'], 'J_Adj_L_FaceEye'); assert.equal(drives['左親指０'], 'J_Bip_L_Thumb1');
      assert.equal(drives['左人指３'], 'J_Bip_L_Index3');
      for (const helper of ['全ての親', 'センター', 'グルーブ', '左腕捩', '左手捩', '左足ＩＫ', '左つま先ＩＫ']) assert.equal(drives[helper], null, `${helper} only steers`);
      assert.ok(!('左中指１' in drives), 'a finger the model has not is not made up');
      // Every bone rests at identity, at the VRM's joint (model units), and the IK the engine solves is there.
      assert.ok(body.mesh.skeleton.bones.every(b => b.quaternion.equals(new Quaternion())));
      body.mesh.updateMatrixWorld(true);
      const arm = body.mesh.skeleton.bones.find(b => b.name === '左腕')!.getWorldPosition(new Vector3());
      assert.ok(arm.distanceTo(new Vector3(0.1 * 12.5, 1.3 * 12.5, 0)) < 1e-4, 'her left upper arm where the VRM has it (+X is her left)');
      assert.ok(BodyRig.find(body.mesh), 'the leg IK is found the way the engine finds it on an MMD model');
      // 笑眼 by the face's own Fcl_EYE_Joy in both versions (2026-11-19; before, only 1.0's happy preset gave one).
      // I-164: じと目 from the VRoid part shape Fcl_EYE_Close at 0.5 (shared/stage/vrm/face-shapes.ts, the converter's mix).
      assert.deepEqual(body.morphs.map(m => `${m.name}:${m.slot}`).sort(), ['あ:a', 'まばたき:blink', '笑い:smileEyes', 'にやり:smileEyes', 'じと目:jitome'].sort());
      assert.equal(body.retarget.plan.bakeLegIk, false, 'the standard skeleton has its own leg IK');
      // The T-pose arms are laid in at Gene's angle (34° below level), so the conversion has almost nothing left to align.
      const elbow = body.mesh.skeleton.bones.find(b => b.name === '左ひじ')!.getWorldPosition(new Vector3());
      const below = Math.asin((arm.y - elbow.y) / elbow.distanceTo(arm)) * DEG;
      assert.ok(Math.abs(below - 34) < 1, `her standard upper arm rests ${below.toFixed(1)}° below level`);
      assert.ok((body.retarget.plan.alignedDeg.armLeft ?? 0) < 1, 'nothing left to align');
    } finally { body.dispose(); }
  });
}

test('a VRM without a humanoid part the engine needs is refused, naming it', async () => {
  const json = readGlbJson(syntheticVrm()) as { extensions: { VRMC_vrm: { humanoid: { humanBones: Record<string, unknown> } } } };
  delete json.extensions.VRMC_vrm.humanoid.humanBones.leftLowerLeg;
  const loaded = await parseVrmModel(glbWithJson(syntheticVrm(), json), { textureLoader: inertTextures, relaxArms: false });
  assert.throws(() => StandardBody.of(loaded), /kneeLeft/);
  loaded.dispose();
});

// ---- her window body on the VRM: the real frame loop ------------------------------------------------------------------------------

for (const fps of [60, 30]) {
  test(`VRM window body at ${fps} fps: stays put, arms down, blinks shut and open, mouth flaps in proportion, gaze follows, a pat comes and goes, no jumps`, async () => {
    const run = await runVrmWindowBody(fps, 10, t => ({
      pat: t > 2 && t < 4.5,
      speaking: t > 5 && t < 7,
      pointer: t < 7.5 ? { x: Math.sin(t * 1.3) * 0.8, y: Math.cos(t * 0.9) * 0.4 } : t < 8.75 ? { x: 0.9, y: 0 } : { x: -0.9, y: 0 },
    }));
    const frames = run.frames;
    const roots = frames.map(f => Math.hypot(f.root.x, f.root.z));
    assert.ok(max(roots) < 1e-9, 'she never walks');
    const hipsY = frames.map(f => f.hips.y / 12.5), hipsX = frames.map(f => Math.abs(f.hips.x) / 12.5);
    assert.ok(Math.min(...hipsY) > 0.8 && max(hipsY) < 0.92 && max(hipsX) < 0.05, `her hips stay over her feet (y ${Math.min(...hipsY).toFixed(3)}..${max(hipsY).toFixed(3)} m, x ≤ ${max(hipsX).toFixed(3)} m)`);
    // The VRM rests in a T pose; the engine's idle lowers her arms (no temporary relaxation at load any more).
    const last = frames.at(-1)!, armDown = (q: Quaternion, side: 1 | -1) => { const d = new Vector3(side, 0, 0).applyQuaternion(q); return Math.asin(-d.y) * DEG; };
    assert.ok(armDown(last.rotations[7], 1) > 50 && armDown(last.rotations[8], -1) > 50, `arms down (${armDown(last.rotations[7], 1).toFixed(1)}°, ${armDown(last.rotations[8], -1).toFixed(1)}°)`);
    // Blinks: the VRM's own blink expression reaches 1 (fully shut) and goes back to 0.
    const blink = frames.map(f => f.morphs.Fcl_EYE_Close);
    const shut = frames.findIndex(f => f.t < 2 && f.morphs.Fcl_EYE_Close > 0.999);
    assert.ok(shut > 0, 'a natural blink closes her eyes fully');
    assert.ok(frames.slice(shut).some(f => f.t < 2 && f.morphs.Fcl_EYE_Close === 0), 'and opens them again');
    // A pat: a small smile (happy), lids eased half down, never a jump; gone after.
    const patted = frames.filter(f => f.t > 3 && f.t < 4.5);
    assert.ok(Math.min(...patted.map(f => f.morphs.Fcl_EYE_Joy)) > 0.2, 'she smiles while patted');
    assert.ok(Math.abs(max(patted.map(f => f.morphs.Fcl_EYE_Close)) - 0.38) < 0.05, 'her lids rest half down');
    assert.ok(max(frames.filter(f => f.t > 6 && f.t < 7).map(f => f.morphs.Fcl_EYE_Joy)) < 0.01, 'and stops after');
    const blinkSteps = blink.slice(1).map((v, i) => Math.abs(v - blink[i]));
    const patSteps = blinkSteps.filter((_, i) => frames[i + 1].t > 2 && frames[i + 1].t < 5.2 && frames[i + 1].morphs.Fcl_EYE_Close < 0.45);
    assert.ok(max(patSteps) < (fps === 60 ? 0.03 : 0.06), `the lids ease (largest step ${max(patSteps).toFixed(4)})`);
    // Speaking: aa between 0 and 1, up and down, never pinned at the top; closed after.
    const aa = frames.filter(f => f.t > 5.3 && f.t < 7).map(f => f.morphs.Fcl_MTH_A);
    let turns = 0;
    for (let i = 2; i < aa.length; i++) if ((aa[i] - aa[i - 1]) * (aa[i - 1] - aa[i - 2]) < 0) turns++;
    assert.ok(max(aa) > 0.3 && max(aa) < 0.8, `her mouth opens in proportion (${max(aa).toFixed(2)})`);
    assert.ok(turns >= 6, `and closes and opens again (${turns} turns)`);
    assert.ok(max(frames.filter(f => f.t > 8.5).map(f => f.morphs.Fcl_MTH_A)) < 0.01, 'and is shut after');
    // Gaze: the cursor to her left (your right), then her right: the look and the eye bones turn that way (the head: next test).
    const at = (t: number) => frames.find(f => f.t >= t)!;
    const left = at(8.7), right = at(9.95);
    assert.ok(left.look.yaw > 3 && right.look.yaw < -3, `the eyes look her left then right (${left.look.yaw.toFixed(1)}°, ${right.look.yaw.toFixed(1)}°)`);
    assert.ok(yawOf(left.eyes[0]) > 1 && yawOf(right.eyes[0]) < -1, 'the VRM eye bones turn');
    // No jumps: R29c's "unexpected step" over the whole run stays at the idle's own level.
    const idleStep = max(run.step(0.5, 2)), idleSurprise = max(run.surprise(0.5, 2));
    const allStep = max(run.step(0.5, 10)), allSurprise = max(run.surprise(0.5, 10));
    console.log(`  VRM ${fps} fps · idle step ${idleStep.toFixed(3)}° surprise ${idleSurprise.toFixed(3)}° · whole run step ${allStep.toFixed(3)}° surprise ${allSurprise.toFixed(3)}° · mouth ${max(aa).toFixed(2)} (${turns} turns)`);
    const limit = fps === 60 ? 0.5 : 1.0;
    assert.ok(allSurprise < Math.max(limit, idleSurprise * 1.5), `no jump (surprise ${allSurprise.toFixed(3)}°)`);
    assert.ok(allStep < (fps === 60 ? 2 : 4), `no fast turn (step ${allStep.toFixed(3)}°)`);
    const mouth = frames.map(f => f.morphs.Fcl_MTH_A), mouthSteps = mouth.slice(1).map((v, i) => Math.abs(v - mouth[i]));
    assert.ok(max(mouthSteps) < (fps === 60 ? 0.2 : 0.35), `mouth step ${max(mouthSteps).toFixed(3)}`);
  });
}

test('VRM: her head follows where she looks (two runs alike but for the cursor: her idle wanders the same in both)', async () => {
  const run = (x: number) => runVrmWindowBody(60, 8, t => ({ pointer: t < 3 ? { x: 0, y: 0 } : { x, y: 0 } }));
  const left = (await run(0.9)).frames.at(-1)!, right = (await run(-0.9)).frames.at(-1)!;
  const head = yawOf(left.rotations[4]) - yawOf(right.rotations[4]);
  assert.ok(left.look.yaw > 3 && right.look.yaw < -3, 'the eyes look each way');
  assert.ok(head > 5, `her head turned ${head.toFixed(1)}° further toward the cursor on her left than on her right`);
});

// ---- the VRM's own look settings --------------------------------------------------------------------------------------------

function withLookAt(lookAt: Record<string, unknown>, expressions: Record<string, unknown> = {}): Uint8Array {
  const bytes = syntheticVrm(), json = readGlbJson(bytes) as { extensions: { VRMC_vrm: Record<string, { preset?: Record<string, unknown> } | unknown> } };
  const vrm = json.extensions.VRMC_vrm as { lookAt?: unknown; expressions: { preset: Record<string, unknown> } };
  vrm.lookAt = lookAt;
  Object.assign(vrm.expressions.preset, expressions);
  return glbWithJson(bytes, json);
}
const lookRun = (bytes: Uint8Array, pointerX: number) => (async () => {
  const body = await syntheticStandardBody('1.0', bytes);
  const figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 });
  try {
    for (let i = 0; i < 90; i++) {
      figure.setPoseTargets({ ...REST_TARGETS, eyes: { yaw: pointerX * 0.4, pitch: 0 } });
      figure.frame(1 / 60); body.present();
    }
    const face = body.model.meshes.find(mesh => mesh.morphTargetDictionary?.Fcl_MTH_A !== undefined)!;
    const values = Object.fromEntries(Object.entries(face.morphTargetDictionary!).map(([name, index]) => [name, face.morphTargetInfluences![index]]));
    return { look: { ...body.transfer.look }, eye: body.eyes[0].quaternion.clone(), values, driven: body.transfer.drivenBones.map(b => b.name) };
  } finally { figure.dispose(); body.dispose(); }
})();

test('a VRM whose look is expressions: lookLeft / lookRight by its range map, its eye bones left alone', async () => {
  const json = readGlbJson(syntheticVrm()) as { nodes: { name: string }[] };
  const faceNode = json.nodes.findIndex(node => node.name === 'Face');
  const bind = (index: number) => ({ morphTargetBinds: [{ node: faceNode, index, weight: 1 }] });
  const range = { inputMaxValue: 20, outputScale: 0.8 };
  const bytes = withLookAt({ type: 'expression', rangeMapHorizontalOuter: range, rangeMapHorizontalInner: range }, { lookLeft: bind(2), lookRight: bind(1) });
  const left = await lookRun(bytes, 1), right = await lookRun(bytes, -1);
  assert.ok(left.look.yaw > 2, `she looks her left (${left.look.yaw.toFixed(2)}°)`);
  const expected = 0.8 * Math.min(1, left.look.yaw / 20);
  assert.ok(Math.abs(left.values.Fcl_EYE_Joy - expected) < 1e-6, `lookLeft = ${expected.toFixed(4)} (${left.values.Fcl_EYE_Joy.toFixed(4)})`);
  assert.equal(left.values.Fcl_MTH_A, 0, 'not lookRight');
  assert.ok(right.values.Fcl_MTH_A > 0 && right.values.Fcl_EYE_Joy === 0, 'the other way: lookRight');
  assert.ok(!left.driven.includes('J_Adj_L_FaceEye'), 'the eye bones are not driven');
  assert.ok(left.eye.equals(new Quaternion()), 'and stay at rest');
});

test('a VRM whose look is its eye bones: they turn by its range map (inner and outer per eye)', async () => {
  const bytes = withLookAt({ type: 'bone', rangeMapHorizontalOuter: { inputMaxValue: 30, outputScale: 6 }, rangeMapHorizontalInner: { inputMaxValue: 30, outputScale: 3 },
    rangeMapVerticalDown: { inputMaxValue: 30, outputScale: 5 }, rangeMapVerticalUp: { inputMaxValue: 30, outputScale: 5 } });
  const run = await lookRun(bytes, 1);
  const yaw = new Euler().setFromQuaternion(run.eye, 'YXZ').y * DEG;
  // Her left eye turning to her left turns outward: the outer map.
  assert.ok(Math.abs(yaw - 6 * Math.min(1, run.look.yaw / 30)) < 1e-3, `left eye ${yaw.toFixed(4)}° for a ${run.look.yaw.toFixed(3)}° look`);
});

test('a pat on a VRM lands on her scalp, measured from her own eyes in her head bone (metres under a root scaled to stage units)', async () => {
  const body = await syntheticStandardBody('1.0');
  const figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 });
  try {
    figure.frame(0); body.present();
    const { contact, head } = standardHeadContact(body, body.measureShown().height);
    assert.equal(head?.name, 'J_Bip_C_Head');
    assert.equal(contact?.source, 'eyes-and-scalp', 'found from the eyes, not a whole-head estimate');
    assert.ok(contact!.halfWidth < 0.2 && contact!.center.dot(contact!.up) > 0.03, `a head-sized patch above the eyes (half width ${contact!.halfWidth.toFixed(3)} m)`);
  } finally { figure.dispose(); body.dispose(); }
});

// ---- the transfer works by direction ----------------------------------------------------------------------------------------

test("a VRM bone's own rest orientation does not change the pose she shows", async () => {
  const shown = async (twist: boolean) => {
    const loaded = await parseVrmModel(syntheticVrm(), { textureLoader: inertTextures, relaxArms: false });
    if (twist) {
      // The same rest pose with other bone axes: the upper arm and the hips turned, their children turned back.
      for (const slot of ['armLeft', 'lowerBody', 'head'] as const) {
        const bone = loaded.bone(slot)!, q = new Quaternion().setFromEuler(new Euler(0.4, -0.7, 0.9));
        bone.quaternion.multiply(q);
        for (const child of bone.children) { child.position.applyQuaternion(q.clone().invert()); child.quaternion.premultiply(q.clone().invert()); }
      }
    }
    const body = StandardBody.of(loaded), figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 });
    figure.setClips({ pose: await standClipFor(body), gesture: null, expression: null }, false);
    for (let i = 0; i < 45; i++) { figure.frame(1 / 30); body.present(); }
    body.mesh.updateMatrixWorld(true);
    const points = (['wristLeft', 'elbowLeft', 'head', 'ankleRight', 'upperBody'] as const).map(slot => loaded.bone(slot)!.getWorldPosition(new Vector3()));
    const eye = loaded.bone('eyeLeft')!.getWorldPosition(new Vector3());
    figure.dispose(); body.dispose();
    return [...points, eye];
  };
  const plain = await shown(false), twisted = await shown(true);
  plain.forEach((p, i) => assert.ok(p.distanceTo(twisted[i]) < 1e-3, `joint ${i}: ${p.toArray().map(v => v.toFixed(3))} vs ${twisted[i].toArray().map(v => v.toFixed(3))}`));
});

// ---- MMD models: exact names first --------------------------------------------------------------------------------------------

test("Gene's bones are found by their exact names, exactly as before (no alias lookup); a PMX with English bone names is found by the alias table", async () => {
  aliasHits.length = 0;
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 0 });
  figure.frame(1 / 60);
  figure.dispose(); fixture.close();
  assert.deepEqual(aliasHits, [], 'Gene: every lookup answered by an exact name');
  const renamed = await loadPublicGeneForTargets();
  for (const bone of renamed.mesh.skeleton.bones) if (Object.hasOwn(RENAMED, bone.name)) bone.name = RENAMED[bone.name];
  const rig = BodyRig.find(renamed.mesh);
  assert.ok(rig, 'the renamed PMX still plants her feet (its leg IK found through the aliases)');
  assert.deepEqual(rig!.legs.map(leg => [leg.ik.name, leg.hip.name, leg.knee.name, leg.ankle.name]), [['LeftLegIK', 'LeftLeg', 'LeftKnee', 'LeftAnkle'], ['RightLegIK', 'RightLeg', 'RightKnee', 'RightAnkle']]);
  const other = new UnboundFigure(renamed.mesh, { xM: 0, depthM: 0 });
  assert.equal(other.head?.name, 'Head');
  assert.ok(aliasHits.some(hit => hit === '上半身2→Chest'), 'her chest (breath, lean) through the alias table');
  other.dispose(); renamed.close();
});
