/**
 * I-147 全身果冻, layer 3: soft-region vertex jelly (src/stage/jelly/soft-*.ts; docs/claude/2026-11-17-whole-body-jelly.md).
 * - The mask selects only the intended regions: on a synthetic body (each body part its own bone and box of vertices) and on the
 *   bundled Gene (by the bones that carry the selected vertices and where they are).
 * - Bounded: the shown offset of every region, and the displacement of every vertex (the shader's formula, mirrored), stay
 *   within the region's max offset, whatever the motion; a cut gives no impulse; it settles after the motion stops.
 * - Off is exactly today: a disabled layer patches no material and adds no attribute; switching it off puts both back (the same
 *   hook, the same cache key, no attribute) and a hook captured by another layer meanwhile becomes transparent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, ShaderLib, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, type Material } from 'three';
import { SOFT_DEFAULTS, defaultJellyTuning, type SoftTuning } from '../shared/stage/jelly-tuning';
import { SoftJelly } from '../src/stage/jelly/soft-jelly';
import { SLOTS, softFalloff, type SoftRegionMap } from '../src/stage/jelly/soft-regions';
import { JELLY_REGION_ATTRIBUTE, JELLY_WEIGHT_ATTRIBUTE, JellyMaterialPatch, createJellyUniforms, injectJelly, type JellyUniforms } from '../src/stage/jelly/soft-shader';
import { physicsOwnership } from '../src/stage/jelly/stage-jelly';
import { GENE_PMX, loadPmxMesh } from './helpers/physics-lab-run';
import { syntheticBody } from './helpers/jelly-body';

function on(changes: (tuning: SoftTuning) => void = () => {}): SoftTuning {
  const tuning = defaultJellyTuning().soft; tuning.enabled = true; changes(tuning); return tuning;
}

/** Vertices a region really moves at its default radius and falloff (mask · falloff over a threshold). */
function moved(map: SoftRegionMap, mesh: SkinnedMesh, region: number, threshold = 0.05): number[] {
  const position = mesh.geometry.getAttribute('position'), info = map.regions[region], out: number[] = [];
  for (let v = 0; v < position.count; v++) for (let s = 0; s < SLOTS; s++) {
    if (map.slotRegion[v * SLOTS + s] !== region || map.slotWeight[v * SLOTS + s] <= 0) continue;
    const d = Math.hypot(position.getX(v) - info.center[0], position.getY(v) - info.center[1], position.getZ(v) - info.center[2]);
    if (map.slotWeight[v * SLOTS + s] * softFalloff(d, info.radius, 1.5) > threshold) out.push(v);
  }
  return out;
}

/** The shader's displacement of one vertex (the same formula as soft-shader.ts, in JS). */
function displacement(map: SoftRegionMap, uniforms: JellyUniforms, position: Vector3, v: number): Vector3 {
  const move = new Vector3(); let sum = 0;
  for (let s = 0; s < SLOTS; s++) {
    const w = map.slotWeight[v * SLOTS + s]; if (w <= 0) continue;
    const r = Math.round(map.slotRegion[v * SLOTS + s]), shape = uniforms.shJellyShape.value[r];
    const f = w * softFalloff(position.distanceTo(uniforms.shJellyCenter.value[r]), shape.x, shape.y);
    move.addScaledVector(uniforms.shJellyOffset.value[r], f); sum += f;
  }
  return sum > 1 ? move.divideScalar(sum) : move;
}

test('synthetic body: each region selects only its own part (belly front, hips back, thighs, upper arms, cheeks, chest)', () => {
  const { mesh, owner } = syntheticBody();
  const layer = new SoftJelly(mesh, false);
  const map = layer.regionMap();
  const kinds = map.regions.map(region => `${region.kind}${region.side > 0 ? 'L' : region.side < 0 ? 'R' : ''}`);
  assert.deepEqual(kinds, ['belly', 'hips', 'thighsL', 'upperArmsL', 'thighsR', 'upperArmsR', 'cheeksL', 'cheeksR', 'chestL', 'chestR']);
  const position = mesh.geometry.getAttribute('position');
  const expect: Record<string, (v: number) => boolean> = {
    belly: v => ['上半身', '下半身'].includes(owner[v]) && position.getZ(v) > -0.2, // the front half (a 5% margin)
    hips: v => ['下半身', '左足', '右足'].includes(owner[v]) && position.getZ(v) < 0.2, // the back half
    thighsL: v => owner[v] === '左足', thighsR: v => owner[v] === '右足',
    upperArmsL: v => owner[v] === '左腕', upperArmsR: v => owner[v] === '右腕',
    cheeksL: v => owner[v] === '頭' && position.getZ(v) > 0 && position.getX(v) > 0 && position.getY(v) < 16.6,
    cheeksR: v => owner[v] === '頭' && position.getZ(v) > 0 && position.getX(v) < 0 && position.getY(v) < 16.6,
    chestL: v => owner[v] === '上半身2' && position.getZ(v) > 0 && position.getX(v) > 0,
    chestR: v => owner[v] === '上半身2' && position.getZ(v) > 0 && position.getX(v) < 0,
  };
  kinds.forEach((kind, r) => {
    const vertices = moved(map, mesh, r);
    assert.ok(vertices.length > 0, `${kind} moves something`);
    const stray = vertices.filter(v => !expect[kind](v));
    assert.equal(stray.length, 0, `${kind}: ${stray.length} vertices outside it (${stray.slice(0, 3).map(v => owner[v]).join(', ')})`);
  });
  // Hands, feet and the knees' lower legs never move.
  for (let v = 0; v < position.count; v++) if (['左手首', '左足首', '左ひざ', '左ひじ'].includes(owner[v])) {
    for (let s = 0; s < SLOTS; s++) assert.equal(map.slotWeight[v * SLOTS + s], 0, `${owner[v]} vertex ${v}`);
  }
  // A model whose physics moves the chest gets no chest region.
  assert.equal(new SoftJelly(mesh, true).regions.some(region => region.kind === 'chest'), false);
});

test('Gene: the regions are found and the selected vertices are carried by the intended bones, in the intended places', async () => {
  const mesh = await loadPmxMesh(GENE_PMX);
  const owned = physicsOwnership(mesh);
  const layer = new SoftJelly(mesh, owned.chest);
  const map = layer.regionMap(), bones = mesh.skeleton.bones;
  const kinds = map.regions.map(region => `${region.kind}${region.side > 0 ? 'L' : region.side < 0 ? 'R' : ''}`);
  assert.deepEqual(kinds, ['belly', 'hips', 'thighsL', 'upperArmsL', 'thighsR', 'upperArmsR', 'cheeksL', 'cheeksR', 'chestL', 'chestR'], 'Gene has no chest physics: the chest is a soft region');
  const skinIndex = mesh.geometry.getAttribute('skinIndex'), skinWeight = mesh.geometry.getAttribute('skinWeight'), position = mesh.geometry.getAttribute('position');
  const dominant = (v: number) => { let best = 0, bone = -1; for (let k = 0; k < 4; k++) if (skinWeight.getComponent(v, k) > best) { best = skinWeight.getComponent(v, k); bone = skinIndex.getComponent(v, k); } return bones[bone]?.name ?? ''; };
  const forbidden = /手首|指|足首|つま先|目|髪|ひざ/u;
  const report: string[] = [];
  kinds.forEach((kind, r) => {
    const vertices = moved(map, mesh, r, 0.1);
    assert.ok(vertices.length > 10, `${kind} moves something (${vertices.length})`);
    const names = new Map<string, number>();
    for (const v of vertices) { const name = dominant(v); names.set(name, (names.get(name) ?? 0) + 1); }
    const bad = [...names].filter(([name]) => forbidden.test(name) || owned.bones.has(bones.findIndex(bone => bone.name === name)));
    assert.equal(bad.length, 0, `${kind}: carried by ${bad.map(([name, n]) => `${name}×${n}`).join(', ')}`);
    const c = map.regions[r].center, side = map.regions[r].side;
    if (side) assert.ok(vertices.every(v => Math.sign(position.getX(v)) === side || Math.abs(position.getX(v)) < 0.05 * map.regions[r].radius * 10), `${kind}: stays on its side`);
    report.push(`${kind} ${vertices.length} (${[...names].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name).join('/')}) c=${c.map(x => x.toFixed(2)).join(',')} r=${map.regions[r].radius.toFixed(2)}`);
  });
  if (process.env.JELLY_REPORT) console.log(`Gene soft regions: ${report.join(' | ')}`);
  const head = bones.find(bone => bone.name === '頭')!, headY = new Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[bones.indexOf(head)].clone().invert()).y;
  for (const side of [6, 7]) assert.ok(moved(map, mesh, side).every(v => position.getY(v) > headY - 0.5 && position.getZ(v) > 0), 'the cheeks are on the front of the face');
  assert.ok(moved(map, mesh, 0).every(v => position.getZ(v) > -0.2), 'the belly is the front of the trunk');
  assert.ok(moved(map, mesh, 1).every(v => position.getZ(v) < 0.2), 'the hips are the back');
});

for (const fps of [60, 30]) {
  test(`bounded under violent motion; a cut gives no impulse; settles when she stops (${fps} fps)`, async () => {
    const mesh = await loadPmxMesh(GENE_PMX);
    const layer = new SoftJelly(mesh, physicsOwnership(mesh).chest);
    layer.configure(on(tuning => { for (const region of Object.values(tuning.regions)) { region.gain = 4; region.damping = 0.05; region.hz = 1; } }));
    const center = mesh.skeleton.bones.find(bone => bone.name === 'センター')!, map = layer.regionMap(), uniforms = layer.uniformValues();
    const position = mesh.geometry.getAttribute('position'), p = new Vector3();
    // Each region's bound: its max offset (a fraction) × its own size. A vertex never moves further than the largest of its regions'.
    const limitOf = (r: number) => SOFT_DEFAULTS[map.regions[r].kind].maxOffset * map.regions[r].radius;
    const vertexLimit = Math.max(...map.regions.map((_, r) => limitOf(r)));
    let peak = 0;
    for (let i = 0; i < 4 * fps; i++) {
      const t = i / fps;
      center.position.set(Math.sign(Math.sin(t * 7)) * 2, Math.sin(t * 13) * 1.5, 0); // square-wave shoves: far past any real motion
      mesh.updateMatrixWorld(true);
      layer.update(1 / fps);
      layer.shownOffsets().forEach((offset, r) => {
        peak = Math.max(peak, offset.length() / limitOf(r));
        assert.ok(offset.length() <= limitOf(r) * (1 + 1e-9), `region ${map.regions[r].kind} frame ${i}: ${offset.length()} > ${limitOf(r)}`);
      });
      if (i % 10 === 0) for (let v = 0; v < position.count; v += 7) {
        const d = displacement(map, uniforms, p.fromBufferAttribute(position, v), v).length();
        assert.ok(d <= vertexLimit * (1 + 1e-9), `vertex ${v} moved ${d} > ${vertexLimit}`);
      }
    }
    assert.ok(peak > 0.9, `pushed this hard it reaches its bound (${peak.toFixed(3)} of it), and never passes it`);
    // Stops: with a normal damping it settles.
    layer.configure(on());
    for (let i = 0; i < 2 * fps; i++) layer.update(1 / fps);
    assert.ok(Math.max(...layer.shownOffsets().map(offset => offset.length())) < 1e-3, 'settled two seconds after she stopped');
    // Then a teleport of the whole body (a cut, not motion): no kick at all.
    for (const x of [40, 40, 40]) { center.position.set(x, 0, 0); mesh.updateMatrixWorld(true); layer.update(1 / fps); }
    const after = Math.max(...layer.shownOffsets().map(offset => offset.length()));
    assert.ok(after < 1e-3, `a 40-unit teleport adds nothing: ${after.toFixed(5)}`);
  });
}

test('off is exactly today: no patch, no attribute; switching off restores the hook, the key and the geometry exactly', () => {
  const { mesh } = syntheticBody();
  const materials = mesh.material as Material[];
  const keys = materials.map(material => material.customProgramCacheKey()), attributes = Object.keys(mesh.geometry.attributes).sort();
  const disabled = new SoftJelly(mesh, false); disabled.configure(defaultJellyTuning().soft);
  for (let i = 0; i < 30; i++) disabled.update(1 / 60);
  assert.equal(disabled.idle, true);
  assert.deepEqual(Object.keys(mesh.geometry.attributes).sort(), attributes, 'no attribute added while off');
  assert.ok(materials.every(material => !Object.hasOwn(material, 'onBeforeCompile') && !Object.hasOwn(material, 'customProgramCacheKey')), 'no material touched while off');

  const layer = new SoftJelly(mesh, false); layer.configure(on());
  layer.update(1 / 60);
  assert.ok(mesh.geometry.getAttribute(JELLY_REGION_ATTRIBUTE) && mesh.geometry.getAttribute(JELLY_WEIGHT_ATTRIBUTE), 'on: the slots are on the geometry');
  assert.ok(materials.every((material, i) => material.customProgramCacheKey() !== keys[i]), 'on: the materials compile with it');
  // Another layer (the blush) captures the patched hook in a clone meanwhile.
  const captured = materials[0].onBeforeCompile, capturedKey = materials[0].customProgramCacheKey;
  layer.configure(null);
  for (let i = 0; i < 30; i++) layer.update(1 / 60);
  assert.equal(layer.idle, true);
  assert.deepEqual(Object.keys(mesh.geometry.attributes).sort(), attributes, 'off again: the geometry is as it was');
  assert.ok(materials.every(material => !Object.hasOwn(material, 'onBeforeCompile') && !Object.hasOwn(material, 'customProgramCacheKey')), 'off again: the materials are as they were');
  assert.deepEqual(materials.map(material => material.customProgramCacheKey()), keys);
  const shader = { vertexShader: ShaderLib.basic.vertexShader, fragmentShader: '', uniforms: {} } as unknown as Parameters<Material['onBeforeCompile']>[0];
  captured.call(materials[0], shader, null as never);
  assert.equal(shader.vertexShader, ShaderLib.basic.vertexShader, 'a hook captured before "off" no longer injects anything');
  assert.equal(capturedKey.call(materials[0]).includes('jelly'), false);
});

test('the shader patch: injected after skinning, declared once, bounded by averaging; a shader without the hooks is left alone', () => {
  const source = ShaderLib.phong.vertexShader;
  const injected = injectJelly(source)!;
  assert.ok(injected.indexOf('shJellyMove') > injected.indexOf('#include <skinning_vertex>'), 'after the skinned position');
  assert.ok(injected.indexOf('shJellyMove') < injected.indexOf('#include <project_vertex>'), 'before the projection');
  assert.match(injected, /shJellySum > 1\.0 \? shJellyMove \/ shJellySum : shJellyMove/);
  assert.equal(injectJelly(injected), injected, 'idempotent');
  assert.equal(injectJelly('void main() {}'), null);
  const patch = new JellyMaterialPatch(createJellyUniforms()), material = new MeshBasicMaterial();
  patch.ensure(material); patch.ensure([material]);
  assert.equal(patch.count, 1, 'one patch per material');
  const shader = { vertexShader: 'void main() {}', fragmentShader: '', uniforms: {} } as unknown as Parameters<Material['onBeforeCompile']>[0];
  material.onBeforeCompile(shader, null as never);
  assert.equal(shader.vertexShader, 'void main() {}');
  assert.equal(patch.unsupported, 1);
  patch.unpatch();
});
