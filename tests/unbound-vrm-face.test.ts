/**
 * I-164 VRM gaps (docs/claude/2026-11-20-vrm-gaps.md), the face on a model loaded natively, on the
 * synthetic VRMs (tests/helpers/synthetic-vrm.ts, synthetic-vrm-face.ts; nothing from a real model):
 *  - her face actions' shapes found on the VRM's own data (presets, a custom expression, a raw morph target, VRoid part-shape stand-ins),
 *    reported missing only for what the model truly lacks;
 *  - the painted blush and tear marks on its MToon face: the same probe and rules as an MMD model's, painted on the primitive with the
 *    cheeks, the swapped-in material keeping its file place, the shader patches live (not inside MToon's commented-out includes), the
 *    calibration moving the cheeks, a preview leaving the pinch's cheeks alone;
 *  - its own capability card; the pinch's cheek region through its own head;
 *  - how far its eye bones may turn: the lid room rule natively, the smaller of it and the VRM's range map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, ShaderMaterial, Vector3, type Material, type SkinnedMesh } from 'three';
import { HER_ACTION_SPECS, HER_FACE_ACTIONS } from '../shared/actions/her-actions';
import { resolveFaceMorphs } from '../shared/foundation/face-morphs';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/mood/blush';
import { FaceExclusive } from '../src/stage/face-exclusive';
import { drawPlace } from '../src/foundation/draw-order';
import { MTOON_OUTPUT, mtoonTearFragment } from '../src/mood/procedural-tears';
import { standardCapabilities, standardFaceMesh } from '../src/unbound/model/standard-face';
import { roomTurn } from '../src/unbound/model/body-transfer';
import { vrmEyeRooms } from '../src/unbound/model/vrm-eye-room';
import { headRegion } from '../src/unbound/her/head-region';
import { windowTearsGate } from '../src/unbound/window-mode/window-tears';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { syntheticStandardBody } from './helpers/unbound-vrm';
import { FULL_FACE } from './helpers/synthetic-vrm-face';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { standardHeadContact } from '../src/unbound/model/standard-contact';
import { paintTarget } from '../src/unbound/her/vrm-blush';
import { HerOutFace } from '../src/unbound/her/out-face';
import { UnboundFigure } from '../src/unbound/figure';

const FULL = () => syntheticVrm({ face: 'full' });
const faceSkin = (meshes: readonly SkinnedMesh[]) => meshes.find(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(m => /Face_00_SKIN/.test(m.name) && !(m as { isOutline?: boolean }).isOutline))!;
const surfaceOf = (mesh: SkinnedMesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as ShaderMaterial;

// ---- her face actions' shapes ------------------------------------------------------------------------------------------------------

test('face shapes on a VRM: presets, a custom expression, a raw target and VRoid stand-ins become standard morphs, proportional', async () => {
  const body = await syntheticStandardBody('1.0', FULL());
  try {
    const names = body.morphs.map(m => m.name);
    for (const name of ['ウィンク', 'ウィンク右', 'う', 'mouthPucker', 'cheekPuff', 'tongueOut', 'mouthCornersDown']) assert.ok(names.includes(name), `${name} is on her standard face`);
    // Proportional: 嘟嘴 is VRoid's う plus a touch of the small mouth (the converter's mix), じと目 its close at half, never scaled up.
    const pucker = body.model.expression('mouthPucker').map(b => b.weight).sort();
    assert.deepEqual(pucker, [0.1, 0.1, 1, 1]); // each through the face's two primitives (they share the targets)
    assert.deepEqual(body.model.expression('jitome').map(b => b.weight), [0.5, 0.5]); // the eye close's two primitives (shared targets)
    assert.equal(body.model.faceShape!('cheekPuff')[0].index, 8, 'cheekPuff: the custom expression');
    assert.equal(body.model.faceShape!('tongueOut')[0].index, 9, 'tongueOut: the raw morph target of that name');
    // Every face action resolves on the face exclusive's view of this face, nothing missing, nothing approximated.
    const face = standardFaceMesh(body), exclusive = new FaceExclusive(face);
    for (const id of HER_FACE_ACTIONS) {
      const resolved = resolveFaceMorphs(HER_ACTION_SPECS[id].face!, { names: body.mesh.morphTargetDictionary, count: body.mesh.morphTargetInfluences!.length,
        slot: () => null, displaces: index => exclusive.displaced(index).length > 0 });
      assert.deepEqual(resolved.missing, [], `${id} plays`);
      assert.deepEqual(resolved.approximations, [], `${id} is her own shape`);
    }
    // The wink's group is the morphs sharing its vertices on THIS face: the blink, the left eye close, the smile eyes, じと目; not the mouth.
    const wink = body.mesh.morphTargetDictionary!['ウィンク'], group = exclusive.conflictGroup([wink]).map(i => body.morphs[i].name);
    for (const name of ['ウィンク', 'まばたき', '笑い', 'じと目']) assert.ok(group.includes(name), `${name} shares the wink's lid`);
    for (const name of ['あ', 'cheekPuff', 'ウィンク右']) assert.ok(!group.includes(name), `${name} does not`);
  } finally { body.dispose(); }
});

test('face shapes on a VRM that lacks them: missing only for what the model truly lacks', async () => {
  const body = await syntheticStandardBody('1.0', syntheticVrm());
  try {
    const exclusive = new FaceExclusive(standardFaceMesh(body));
    const miss = (id: string) => resolveFaceMorphs(HER_ACTION_SPECS[id as 'wink'].face!, { names: body.mesh.morphTargetDictionary, count: body.mesh.morphTargetInfluences!.length,
      slot: () => null, displaces: index => exclusive.displaced(index).length > 0 }).missing;
    assert.deepEqual(miss('cheek-puff'), ['鼓腮的表情（cheekPuff）']);
    assert.deepEqual(miss('tongue-out'), ['吐舌的表情（tongueOut）']); // it has あ (aa), not a tongue
    assert.ok(miss('wink').length > 0, 'no one-eye close at all');
    assert.ok(miss('pout').length > 0, 'no う, no pucker, no corners');
  } finally { body.dispose(); }
});

// ---- the painted blush and the tears -----------------------------------------------------------------------------------------------

test('blush on a VRM: measured on its own face (iris spacing, not the close eye bones), painted on the face skin primitive in its place', async () => {
  const body = await syntheticStandardBody('1.0', FULL());
  const measure = measureWindowModel(body.mesh, body, false), painter = measure.painter!;
  try {
    assert.ok(painter, 'a painter for the VRM');
    const skin = faceSkin(body.model.meshes), original = surfaceOf(skin);
    assert.equal((skin.material as Material[]).length, 2, 'the face skin has its outline copy');
    assert.equal(painter.build(null, true), true, painter.reason);
    const cheeks = painter.cheeks!;
    assert.equal(cheeks.eyeReference, 'main-eye-geometry', 'the iris surface gave the eye spacing');
    assert.equal(cheeks.surfaceSource, 'named-face');
    assert.ok(Math.abs(cheeks.eyeDistance - 2 * FULL_FACE.irisX) < 0.004, `eye spacing ${cheeks.eyeDistance.toFixed(4)} m (irises ${2 * FULL_FACE.irisX}, bones ${2 * FULL_FACE.eyeBoneX})`);
    const [lx, ly] = cheeks.leftCheek, [rx] = cheeks.rightCheek;
    assert.ok(Math.abs(Math.abs(lx) - 0.038) < 0.006 && Math.abs(Math.abs(rx) - 0.038) < 0.006, `cheeks at ±${Math.abs(lx).toFixed(3)} m, on the cheekbones, not under the nose`);
    assert.ok(ly < FULL_FACE.irisY - 1.45 && ly > FULL_FACE.mouthY - 1.45, `cheek height ${ly.toFixed(3)} m between eyes and mouth (head space)`);
    // Painted on the skin primitive: its surface material swapped for a patched clone that keeps the original's file place.
    const clone = surfaceOf(skin);
    assert.notEqual(clone, original);
    assert.equal(drawPlace(clone), drawPlace(original), 'the clone is drawn where the face skin was (draw-order.ts)');
    assert.ok((skin.material as Material[])[1] === (skin.material as Material[])[1] && (skin.material as { isOutline?: boolean }[])[1].isOutline, 'the outline left as it is');
    // The patch lands as live code in MToon's shader (its includes are comments: the code goes on the next line).
    const shader = { vertexShader: original.vertexShader, fragmentShader: original.fragmentShader, uniforms: {} as Record<string, unknown> };
    clone.onBeforeCompile(shader as never, {} as never);
    const live = (text: string, line: string) => text.split('\n').some(row => row.trim().startsWith(line));
    assert.ok(live(shader.vertexShader, 'vShBlushHead = (shBlushMeshToHead'), 'the vertex hook is a statement');
    assert.ok(live(shader.fragmentShader, 'if (shBlushAmount > 0.0'), 'the fragment hook is a statement');
    const at = (needle: string) => shader.fragmentShader.indexOf(needle);
    assert.ok(at('vec3 normal = normalize( vNormal );') < at('if (shBlushAmount') && at('if (shBlushAmount') < at('material.diffuseColor = diffuseColor.rgb;'), 'after the normal, before MToon lights the colour');
    // The calibration moves the cheeks; a slider preview never changes the pinch's cheeks.
    const before = [...painter.cheeks!.leftCheek];
    painter.build({ ...DEFAULT_BLUSH_CALIBRATION, eyeOffsetY: -0.3 }, true);
    assert.ok(painter.cheeks!.leftCheek[1] < before[1] - 1e-4, 'lower with the calibration');
    const calibrated = [...painter.cheeks!.leftCheek];
    painter.build({ ...DEFAULT_BLUSH_CALIBRATION, eyeOffsetY: 0.3 }, true, true);
    assert.deepEqual(painter.cheeks!.leftCheek, calibrated, 'a preview leaves the pinch alone');
    painter.clear();
    assert.equal(surfaceOf(skin), original, 'cleared: her own material back');
  } finally { painter?.dispose(); body.dispose(); }
});

test('tears on a VRM: the card lets her cry, the tear colour goes before MToon\'s LAST output line, the clone keeps its place', async () => {
  const body = await syntheticStandardBody('1.0', FULL());
  const measure = measureWindowModel(body.mesh, body, false), painter = measure.painter!;
  try {
    const card = standardCapabilities(body);
    assert.equal(card.tears.enabled, true, 'two eyes and a head');
    const gate = windowTearsGate(false, card);
    assert.deepEqual(gate, { gene: false, card: true, reason: null });
    const original = surfaceOf(faceSkin(body.model.meshes));
    painter.build(null, true);
    painter.setTearsGate(gate);
    assert.equal(painter.tearsSupported, true, painter.tearsReason);
    const skin = faceSkin(body.model.meshes), tears = surfaceOf(skin);
    const fragment = tears.fragmentShader, shader = { vertexShader: tears.vertexShader, fragmentShader: fragment, uniforms: {} as Record<string, unknown> };
    tears.onBeforeCompile(shader as never, {} as never);
    const out = shader.fragmentShader, last = out.lastIndexOf(MTOON_OUTPUT), first = out.indexOf(MTOON_OUTPUT);
    assert.ok(first < last, 'MToon writes its colour twice (a debug view first)');
    const tear = out.indexOf('vec3 outgoingLight = col;');
    assert.ok(tear > first && tear < last, 'the tears go before the real output, not into the debug view');
    assert.ok(out.indexOf('shTearsAmount > 0.0') > tear && out.indexOf('col = outgoingLight;') < last);
    assert.equal(mtoonTearFragment('no output here', 'X'), 'no output here', 'no output line: unchanged');
    assert.notEqual(tears, original);
    assert.equal(drawPlace(tears), drawPlace(original), 'the tears\' clone (over the blush\'s) is drawn where the face skin was');
    painter.updateTears(0.8, 500);
    painter.clear();
    assert.ok(!(surfaceOf(skin).fragmentShader.includes('shTears')), 'cleared');
  } finally { painter?.dispose(); body.dispose(); }
});

test('blush on a VRM: painted only where both cheeks are on one mesh, with that mesh\'s own material indices', () => {
  const a = { name: 'a' } as unknown as SkinnedMesh, b = { name: 'b' } as unknown as SkinnedMesh;
  const anchors = { materialIndices: [0, 1] } as never as Parameters<typeof paintTarget>[0];
  assert.deepEqual(paintTarget(anchors, [{ mesh: a, material: 0 }, { mesh: a, material: 0 }])?.anchors.materialIndices, [0]);
  assert.equal(paintTarget(anchors, [{ mesh: a, material: 0 }, { mesh: b, material: 0 }]), null, 'two meshes: no paint');
  assert.equal(paintTarget({ ...anchors, materialIndices: [5] }, [{ mesh: a, material: 0 }]), null, 'an index the probe never made');
});

test('full-screen Unbound: her face on a VRM through the shared set has its card, its painted blush and its tears', async () => {
  const body = await syntheticStandardBody('1.0', FULL());
  const measure = measureWindowModel(body.mesh, body, false), figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 }), her = new HerOutFace();
  try {
    her.attach({ body: figure, mesh: figure.mesh, profile: measure.profile, painter: measure.painter, reviewed: false, standard: true, url: 'vrm', vrm: body });
    assert.equal(her.face.capabilities()?.tears.enabled, true, 'its own card');
    assert.equal(her.blush.painter?.painted, true, her.blush.painter?.reason);
    assert.equal(her.blush.painter?.tearsSupported, true, her.blush.painter?.tearsReason);
    // Before (no standard body handed over): no card, so no tears.
    her.attach({ body: figure, mesh: figure.mesh, profile: measure.profile, painter: measure.painter, reviewed: false, standard: true, url: 'vrm' });
    assert.equal(her.face.capabilities(), null);
    assert.equal(her.blush.painter?.tearsSupported, false);
  } finally { her.attach(null); figure.dispose(); measure.painter?.dispose(); body.dispose(); }
});

// ---- the card and the pinch region -------------------------------------------------------------------------------------------------

test('a VRM\'s own card: what its expressions and bones allow, no choices; the window face uses it until a host card comes', async () => {
  const body = await syntheticStandardBody('1.0', FULL());
  try {
    const card = standardCapabilities(body);
    for (const id of ['closeEyes', 'mouth', 'sleepPose', 'drowsyFace', 'tears', 'gesture'] as const) assert.equal(card[id].enabled, true, id);
    assert.equal(card.blush.detected, false, 'no blush expression: the blush is painted');
    assert.ok(Object.values(card).every(entry => entry.choice === null));
    const rig = windowFaceRig(body.mesh, null, false, null, body), face = new WindowFace();
    face.attach(rig);
    assert.equal(face.capabilities(), rig.card);
    assert.equal(face.wantsPainted(), true);
    assert.equal(face.fatigueEyelidsAllowed(), true);
    // An MMD rig has no card of its own (its card comes from its profile).
    assert.equal(windowFaceRig(body.mesh, null, false, null).card, undefined);
  } finally { body.dispose(); }
});

test('the pinch region on a VRM: the cheeks measured on its own face, projected through its own head', async () => {
  const body = await syntheticStandardBody('1.0', FULL());
  const measure = measureWindowModel(body.mesh, body, false), painter = measure.painter!;
  try {
    painter.build(null, true);
    body.mesh.updateMatrixWorld(true);
    const head = body.head!, standardHead = body.standardBone('head')!;
    const eye = head.localToWorld(new Vector3(0, FULL_FACE.irisY - 1.45, 0.06));
    const camera = new PerspectiveCamera(20, 420 / 640, 0.1, 3000);
    camera.position.set(eye.x, eye.y, eye.z + 12); camera.lookAt(eye); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    body.present();
    const { contact } = standardHeadContact(body, 20);
    const region = headRegion({ head: standardHead, contact, contactHead: head, cheeks: { anchors: painter.cheeks, reviewed: false } },
      { camera, width: 420, height: 640, boundsHeight: 20, radiusPx: () => 40 });
    const cheeks = region?.cheeks ?? [];
    assert.equal(cheeks.length, 2, 'both cheeks');
    // Where the anchors are on screen (through the VRM head, whose space they were measured in).
    const screen = (p: readonly number[]) => { const w = head.localToWorld(new Vector3(...p)).project(camera); return { x: (w.x + 1) * 210, y: (1 - w.y) * 320 }; };
    const expected = [screen(painter.cheeks!.leftCheek), screen(painter.cheeks!.rightCheek)].sort((a, b) => a.x - b.x), got = [...cheeks].sort((a, b) => a.x - b.x);
    for (let k = 0; k < 2; k++) assert.ok(Math.hypot(got[k].x - expected[k].x, got[k].y - expected[k].y) < 2, `cheek ${k} at (${got[k].x.toFixed(1)}, ${got[k].y.toFixed(1)})`);
    // Without a face to measure, the cheeks still come from her own eyes and mouth (pinch only).
    const plain = await syntheticStandardBody('1.0', syntheticVrm());
    const fallback = measureWindowModel(plain.mesh, plain, false).painter;
    try { fallback?.build(null, true); assert.equal(fallback?.cheeks?.eyeReference, 'model-profile'); } finally { fallback?.dispose(); plain.dispose(); }
  } finally { painter?.dispose(); body.dispose(); }
});

// ---- how far its eyes turn ---------------------------------------------------------------------------------------------------------

test('eye room on a VRM: measured natively; an iris filling its socket turns less, the smaller of that and the range map', async () => {
  const roomy = await syntheticStandardBody('1.0', FULL()), full = await syntheticStandardBody('1.0', syntheticVrm({ face: 'full', irisFill: true }));
  try {
    const rooms = vrmEyeRooms(full.model, full.mesh);
    assert.ok(rooms.every(Boolean), 'both eyes measured on the VRM face');
    assert.ok(rooms[0]!.coverAtRest > 0, `the lid already covers the iris at rest (${rooms[0]!.coverAtRest.toFixed(3)})`);
    assert.equal(roomy.transfer.eyeRoom, 1, 'room enough: as before');
    assert.ok(full.transfer.eyeRoom < 0.6 && full.transfer.eyeRoom >= 0.2, `a filled socket: the eyes take ${full.transfer.eyeRoom.toFixed(3)} of a look`);
    // The smaller turn: a tight range map wins; a generous one is capped by the room.
    assert.equal(roomTurn(2.4, 18, 0.4), 2.4);
    assert.ok(Math.abs(roomTurn(12, 18, 0.4) - 7.2) < 1e-9);
    assert.ok(Math.abs(roomTurn(-12, -18, 0.4) + 7.2) < 1e-9);
  } finally { roomy.dispose(); full.dispose(); }
});
