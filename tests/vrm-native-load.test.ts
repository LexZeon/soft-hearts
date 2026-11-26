/**
 * I-152 step 1 (docs/claude/2026-11-19-model-adapter-and-vrm-display.md): a VRM loads as it is into the loaded-model shape
 * (src/stage/model-adapter/vrm.ts), with three's own glTF loader, the MToon package and our VRM reading, on the synthetic VRMs
 * built in the test (tests/helpers/synthetic-vrm.ts, VRM 1.0 and 0.x; nothing from a real model):
 * - format, no MMD mesh (the stage's MMD machinery leaves it alone), every skinned mesh and bone;
 * - the humanoid map: standard bones → the VRM's own bones (head, eyes, chest, center = hips, arms);
 * - facing: both versions face the stage's +Z with her left at +X (0.x is turned at load);
 * - units: metres → stage units (12.5 per metre), the bounds the framing reads;
 * - the temporary arm relaxation: a T pose's upper arms rest DISPLAY_ARM_DOWN_DEG below level;
 * - expressions: VRM presets → expression slots, binds on the face meshes (0.x weights 0–100 → 0–1);
 * - physics description: the spring chain and colliders (nothing simulates them yet);
 * - MToon materials for both versions (0.x translated first); a glTF without a VRM extension is refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture, Vector3, type Bone, type Material, type SkinnedMesh } from 'three';
import { DISPLAY_ARM_DOWN_DEG, VRM_UNITS_PER_METER, parseVrmModel } from '../src/stage/model-adapter/vrm';
import { glbWithJson, readGlbJson } from '../shared/foundation/glb-json';
import { translateVrm0Materials } from '../shared/stage/vrm/vrm0-mtoon';
import { syntheticVrm } from './helpers/synthetic-vrm';

// three's glTF loader reads `self.URL` for embedded images (a browser global); node has the same URL on globalThis.
(globalThis as { self?: unknown }).self ??= globalThis;

/** No image decoding in node: every texture is an empty one, handed back at once. */
const inertTextures = () => ({ load: (_url: string, onLoad?: (texture: Texture) => void) => { const texture = new Texture(); onLoad?.(texture); return texture; },
  setCrossOrigin() { return this; }, setRequestHeader() { return this; }, setPath() { return this; } }) as never;
const load = (version: '1.0' | '0.x') => parseVrmModel(syntheticVrm({ version }), { textureLoader: inertTextures });
const world = (bone: Bone | undefined) => { assert.ok(bone, 'bone found'); bone!.updateWorldMatrix(true, false); return bone!.getWorldPosition(new Vector3()); };

for (const version of ['1.0', '0.x'] as const) {
  test(`VRM ${version}: loads as it is into the loaded-model shape (bones, facing, units, arms, expressions, physics, MToon)`, async () => {
    const model = await load(version);
    assert.equal(model.format, 'vrm');
    assert.equal(model.mesh, null, 'the MMD machinery does not drive it');
    assert.equal(model.meshes.length, 4, 'body, two face primitives, hair');
    assert.ok(model.bones.length > 20);
    assert.equal(model.bone('head')?.name, 'J_Bip_C_Head');
    assert.equal(model.bone('eyeLeft')?.name, 'J_Adj_L_FaceEye');
    assert.equal(model.bone('eyeRight')?.name, 'J_Adj_R_FaceEye');
    assert.equal(model.bone('upperBody2')?.name, 'J_Bip_C_Chest', 'the stage\'s chest');
    assert.equal(model.bone('center')?.name, 'J_Bip_C_Hips', 'VRM has no center bone: the hips');
    assert.equal(model.bone('armLeft')?.name, 'J_Bip_L_UpperArm');
    assert.equal(model.bone('groove'), undefined);

    // Facing and units: the stage's +Z front, her left at +X, metres scaled to stage units.
    const head = world(model.bone('head')), left = world(model.bone('wristLeft')), right = world(model.bone('wristRight'));
    assert.ok(left.x > 0 && right.x < 0, `${version}: her left hand at +X (${left.x.toFixed(2)}, ${right.x.toFixed(2)})`);
    assert.ok(world(model.bone('eyeLeft')).z > head.z, `${version}: her eyes in front of the head centre (+Z)`);
    assert.equal(model.rest.sourceFacing, version === '1.0' ? '+z' : '-z');
    assert.equal(model.rest.unitsPerMeter, VRM_UNITS_PER_METER); assert.equal(model.rest.scale, VRM_UNITS_PER_METER);
    assert.ok(Math.abs(head.y - 1.45 * VRM_UNITS_PER_METER) < 1.5, `head height in stage units: ${head.y.toFixed(2)}`);
    const bounds = model.measureBounds();
    assert.ok(bounds.height > 1.4 * VRM_UNITS_PER_METER && bounds.height < 1.7 * VRM_UNITS_PER_METER, `height ${bounds.height.toFixed(2)}`);
    assert.ok(Math.abs(bounds.centerX) < 1.5, `about centred (the fixture has a left hand only): ${bounds.centerX.toFixed(3)}`);
    assert.ok(Math.abs(bounds.baseY) < 0.6, `feet at the floor: ${bounds.baseY.toFixed(3)}`);

    // The file's rest is a T pose; at load the upper arms are lowered (temporary, step 1).
    assert.equal(model.rest.pose, 'T');
    for (const side of ['Left', 'Right'] as const) {
      const shoulder = world(model.bone(`arm${side}`)), elbow = world(model.bone(`elbow${side}`));
      const direction = elbow.clone().sub(shoulder).normalize();
      const below = Math.asin(-direction.y) * 180 / Math.PI;
      assert.ok(Math.abs(below - DISPLAY_ARM_DOWN_DEG) < 0.5, `${side} upper arm ${below.toFixed(2)}° below level`);
      assert.ok(Math.abs(direction.z) < 0.05, `${side} arm swings down at her side, not forwards (z ${direction.z.toFixed(3)})`);
      assert.ok(side === 'Left' ? direction.x > 0 : direction.x < 0, `${side} arm still points outwards`);
    }

    // Expressions: presets onto slots, on both face primitives (they share the targets).
    const blink = model.expression('blink');
    assert.equal(blink.length, 2, 'blink binds both face primitives');
    assert.ok(blink.every(bind => bind.index === 0 && bind.weight === 1 && (bind.mesh.morphTargetInfluences?.length ?? 0) === 3));
    assert.deepEqual(model.expression('a').map(bind => [bind.index, bind.weight]), [[1, 1], [1, 1]]);
    // 笑眼 comes from the face's own Fcl_EYE_Joy by name (both versions), not from a preset (2026-11-19).
    assert.deepEqual(model.expression('smileEyes').map(bind => [bind.index, bind.weight]), [[2, 1], [2, 1]]);
    // I-164: じと目 is VRoid's eye close at half (shared/stage/vrm/face-shapes.ts). Compared as numbers: a failing deepEqual over a bind
    // prints its three.js mesh graph (2026-11-20 that diff grew one test process to 32 GB; tests/test-hygiene.test.ts now refuses it).
    assert.deepEqual(model.expression('jitome').map(bind => [bind.index, bind.weight]), [[0, 0.5], [0, 0.5]]);

    // Physics: described, not simulated.
    assert.equal(model.physics.kind, 'vrm-spring');
    if (model.physics.kind === 'vrm-spring') {
      assert.equal(model.physics.chains.length, 1);
      assert.deepEqual(model.physics.chains[0].joints.map(joint => joint.bone.name), ['J_Sec_Hair1_01', 'J_Sec_Hair2_01', 'J_Sec_Hair3_01']);
      assert.equal(model.physics.colliders, version === '1.0' ? 2 : 1);
    }
    assert.equal(model.profileSource(), null); assert.equal(model.rig(), null);

    // Materials: MToon for every mesh, with the outline the file asks for on the body.
    const materials = model.meshes.flatMap(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[]);
    const mtoon = materials.filter(material => (material as { isMToonMaterial?: boolean }).isMToonMaterial);
    assert.ok(mtoon.length >= 4, `${version}: MToon materials ${mtoon.length} of ${materials.length}`);
    const body = model.meshes.find(mesh => mesh.name.startsWith('Body'))! as SkinnedMesh;
    assert.ok(Array.isArray(body.material) && (body.material as Material[]).some(material => (material as { isOutline?: boolean }).isOutline), 'the body has its outline pass');
    model.dispose();
  });
}

test('VRM 0.x materials are translated to the 1.0 MToon extension before loading (outline, alpha, colours); the bytes of the file are not changed', () => {
  const bytes = syntheticVrm({ version: '0.x' }), before = Uint8Array.from(bytes);
  const json = readGlbJson(bytes)!;
  const result = translateVrm0Materials(json);
  assert.deepEqual(result, { translated: 4, skipped: 0 });
  const materials = json.materials as { name: string; extensions: { VRMC_materials_mtoon: Record<string, unknown> } }[];
  assert.equal(materials[0].extensions.VRMC_materials_mtoon.outlineWidthMode, 'worldCoordinates');
  assert.ok(Math.abs((materials[0].extensions.VRMC_materials_mtoon.outlineWidthFactor as number) - 0.002) < 1e-9, '0.2 cm → 0.002 m');
  assert.deepEqual((materials[0].extensions.VRMC_materials_mtoon.outlineColorFactor as number[]).map(v => +v.toFixed(4)), [0.1, 0.2, 0.3].map(v => +Math.pow(v, 2.2).toFixed(4)));
  assert.equal(materials[1].extensions.VRMC_materials_mtoon.outlineWidthMode, 'none');
  assert.ok((json.extensionsUsed as string[]).includes('VRMC_materials_mtoon'));
  assert.deepEqual(bytes, before, 'translation works on a copy of the JSON');
  assert.notDeepEqual(glbWithJson(bytes, json), bytes);
});

// ("这个摸头不对劲", Mumi.vrm): VRoid's happy preset is the whole face (Fcl_ALL_Joy: arched eyes AND an open mouth), so a
// pat's 笑眼 opened her mouth. Here the fixture's happy is bound to the mouth shape (index 1) to stand for such a whole-face preset.
const withJson = (edit: (json: Record<string, any>) => void) => {
  const bytes = syntheticVrm({ version: '1.0' }), json = readGlbJson(bytes)! as Record<string, any>;
  edit(json);
  return parseVrmModel(glbWithJson(bytes, json), { textureLoader: inertTextures });
};
test('a non-vowel, non-blink slot takes the face\'s own part shape first, so 笑眼 never brings a whole-face preset (open mouth) along', async () => {
  const model = await withJson(json => { json.extensions.VRMC_vrm.expressions.preset.happy.morphTargetBinds[0].index = 1; });
  assert.deepEqual(model.expression('smileEyes').map(bind => bind.index), [2, 2], 'Fcl_EYE_Joy, not the preset that opens the mouth');
  assert.deepEqual(model.expression('a').map(bind => bind.index), [1, 1], 'a vowel keeps its preset');
  assert.deepEqual(model.expression('blink').map(bind => bind.index), [0, 0], 'a blink keeps its preset');
  model.dispose();
});

test('without a part shape of that name the slot falls back to the preset', async () => {
  const model = await withJson(json => { json.meshes.find((mesh: { name: string }) => mesh.name === 'Face').extras.targetNames[2] = 'Something_Else'; });
  assert.deepEqual(model.expression('smileEyes').map(bind => bind.index), [2, 2], 'happy preset (bound to index 2 in the fixture)');
  model.dispose();
});

test('a closed smile is preferred over the open one for the mouth smile (Fcl_MTH_Fun before Fcl_MTH_Joy)', async () => {
  const { MORPH_ALIASES } = await import('../shared/foundation/universal-skeleton');
  const list = MORPH_ALIASES.mouthSmile;
  assert.ok(list.indexOf('fcl_mth_fun') >= 0 && list.indexOf('fcl_mth_fun') < list.indexOf('fcl_mth_joy'));
});

test('a glTF without a VRM extension, or bytes that are not a GLB, are refused with a plain reason', async () => {
  await assert.rejects(parseVrmModel(new Uint8Array([1, 2, 3]), { textureLoader: inertTextures }), /不是 GLB/);
  const plain = readGlbJson(syntheticVrm())!;
  delete plain.extensions;
  await assert.rejects(parseVrmModel(glbWithJson(syntheticVrm(), plain), { textureLoader: inertTextures }), /没有 VRM 扩展/);
});
