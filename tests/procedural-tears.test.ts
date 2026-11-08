import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bone, BufferGeometry, Float32BufferAttribute, Matrix4, MeshBasicMaterial, PerspectiveCamera, RepeatWrapping, ShaderMaterial, Skeleton, SkinnedMesh, SRGBColorSpace, Texture, Uint16BufferAttribute, UniformsUtils, Vector3 } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import { ProceduralBlush, probeBlushAnchors, type BlushAnchors } from '../src/stage/procedural-blush';
import { ProceduralTears, TEAR_STYLE, tearsSupport } from '../src/stage/procedural-tears';

function skin(name = 'face-skin') {
  const material = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) });
  material.name = name; return material;
}

/** Synthetic landmarks exercise rendering ownership; they are not a model-audit result. */
function fixture() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, 0, 1, 1, 0, 1, -1, 1.5, 1, 1, 1.5, 1], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array(16).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2, 2, 1, 3]); geometry.addGroup(0, 6, 0);
  const material = skin(), mesh = new SkinnedMesh(geometry, material) as SkinnedMesh, head = new Bone(), left = new Bone(), right = new Bone();
  left.position.set(-0.5, 1, 1.1); right.position.set(0.5, 1, 1.1); head.add(left, right); mesh.add(head);
  mesh.bind(new Skeleton([head, left, right])); mesh.updateWorldMatrix(true, true);
  const anchors: BlushAnchors = {
    leftEye: [-0.5, 1, 1.1], rightEye: [0.5, 1, 1.1], mouth: [0, 0.1, 1],
    leftCheek: [-0.55, 0.45, 0.95], rightCheek: [0.55, 0.45, 0.95],
    leftNormal: [0, 0, 1], rightNormal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
    eyeDistance: 1, boneEyeDistance: 1, eyeReference: 'main-eye-geometry', mouthEstimated: true,
    surfaceSource: 'named-face', materialIndices: [0],
  };
  return { mesh, head, left, right, material, geometry, anchors };
}

function compile(material: ShaderMaterial) {
  const shader = { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader, uniforms: material.uniforms };
  material.onBeforeCompile(shader as any, {} as any); return shader;
}
const current = (f: ReturnType<typeof fixture>) => (Array.isArray(f.mesh.material) ? f.mesh.material[0] : f.mesh.material) as ShaderMaterial;
function render(f: ReturnType<typeof fixture>) {
  f.mesh.updateWorldMatrix(true, true);
  f.mesh.onBeforeRender({} as any, {} as any, new PerspectiveCamera(), f.geometry, current(f), {} as any);
}

test('identity, geometric landmarks and a reliable material are separate support gates', () => {
  const f = fixture();
  assert.equal(tearsSupport(f.anchors, true).supported, true);
  // I-038: one unnamed material owning both cheeks is a face surface too; two different ones are not.
  assert.equal(tearsSupport({ ...f.anchors, surfaceSource: 'local-face' }, true).supported, true);
  for (const [anchors, verified] of [[f.anchors, false], [null, true], [{ ...f.anchors, eyeReference: 'eye-bones' }, true],
    [{ ...f.anchors, surfaceSource: 'local-face', materialIndices: [0, 1] }, true], [{ ...f.anchors, materialIndices: [] }, true],
    [{ ...f.anchors, materialIndices: [-1] }, true], [{ ...f.anchors, eyeDistance: NaN }, true],
    [{ ...f.anchors, leftEye: [0, Infinity, 0] }, true], [{ ...f.anchors, up: [0, 2, 0] }, true],
    [{ ...f.anchors, up: [1, 0, 0] }, true]] as const) {
    assert.equal(tearsSupport(anchors as BlushAnchors | null, verified).supported, false);
  }
  assert.ok(Object.isFrozen(TEAR_STYLE)); assert.ok(TEAR_STYLE.start > 0 && TEAR_STYLE.width > 0 && TEAR_STYLE.length < 1);
});

test('unsupported identity or shader leaves materials, callbacks and model data untouched', () => {
  const f = fixture(), originalRender = f.mesh.onBeforeRender, positions = f.geometry.getAttribute('position').array.slice();
  for (const verified of [false, true]) {
    if (verified) f.mesh.material = new MeshBasicMaterial();
    const original = f.mesh.material, effect = new ProceduralTears(f.head, f.anchors, f.mesh, verified);
    assert.equal(effect.getState().supported, false); assert.equal(effect.getState().attached, false);
    effect.update(1, 3000); effect.dispose();
    assert.equal(f.mesh.material, original); assert.equal(f.mesh.onBeforeRender, originalRender);
  }
  assert.deepEqual(f.geometry.getAttribute('position').array, positions);
});

test('only the selected face material is cloned, without new geometry or texture ownership', () => {
  const f = fixture(), body = skin('body'), hair = skin('hair'), materials = [body, f.material, hair];
  f.mesh.material = materials; f.anchors.materialIndices = [1, 1];
  const texture = new Texture(), arrayTexture = new Texture(); let textureDisposals = 0;
  texture.addEventListener('dispose', () => textureDisposals++); arrayTexture.addEventListener('dispose', () => textureDisposals++);
  f.material.uniforms.map.value = texture;
  f.material.uniforms.arrayFixture = { value: [arrayTexture, new Vector3(1, 2, 3)] };
  const childCount = f.mesh.children.length, vertices = f.geometry.getAttribute('position').array.slice();
  const effect = new ProceduralTears(f.head, f.anchors, f.mesh, true), installed = f.mesh.material as ShaderMaterial[], clone = installed[1];
  assert.equal(effect.getState().supported, true); assert.deepEqual(effect.getState().materialIndices, [1]);
  assert.equal(installed[0], body); assert.equal(installed[2], hair); assert.notEqual(clone, f.material);
  assert.equal(clone.uniforms.map.value, texture); assert.equal(clone.uniforms.arrayFixture.value[0], arrayTexture);
  assert.notEqual(clone.uniforms.arrayFixture.value[1], f.material.uniforms.arrayFixture.value[1]);
  texture.flipY = false; texture.wrapS = RepeatWrapping; texture.colorSpace = SRGBColorSpace;
  assert.equal(clone.uniforms.map.value.flipY, false); assert.equal(clone.uniforms.map.value.wrapS, RepeatWrapping); assert.equal(clone.uniforms.map.value.colorSpace, SRGBColorSpace);
  assert.deepEqual(f.geometry.getAttribute('position').array, vertices); assert.equal(f.mesh.children.length, childCount);
  effect.dispose(); assert.equal(f.mesh.material, materials); assert.equal(textureDisposals, 0);
});

test('shader composition keeps blush before tears and preserves the original shading/output pipeline', () => {
  const f = fixture(), originalVertex = f.material.vertexShader, originalFragment = f.material.fragmentShader;
  f.material.alphaTest = 0.13; f.material.transparent = true; let priorCompiles = 0;
  f.material.onBeforeCompile = shader => { priorCompiles++; shader.fragmentShader += '\n// pre-existing-effect'; };
  f.material.customProgramCacheKey = () => 'original-program';
  const blush = new ProceduralBlush(f.head, f.anchors, f.mesh), blushMaterial = current(f);
  const tears = new ProceduralTears(f.head, f.anchors, f.mesh, true), clone = current(f), shader = compile(clone);
  assert.equal(priorCompiles, 1); assert.equal(blush.getState().compiled, 1); assert.equal(tears.getState().compiled, 1);
  assert.match(clone.customProgramCacheKey(), /^original-program:soft-hearts-local-blush-v1:soft-hearts-surface-tears-v1$/);
  assert.ok(shader.vertexShader.indexOf('vShTearsHead =') > shader.vertexShader.indexOf('#include <skinning_vertex>'));
  assert.ok(shader.fragmentShader.indexOf('diffuseColor.rgb = mix') < shader.fragmentShader.indexOf('outgoingLight = mix(outgoingLight'));
  assert.ok(shader.fragmentShader.indexOf('outgoingLight = mix(outgoingLight') < shader.fragmentShader.indexOf('#include <opaque_fragment>'));
  for (const chunk of ['map_fragment', 'normal_fragment_maps', 'lights_fragment_begin', 'alphatest_fragment', 'opaque_fragment', 'tonemapping_fragment', 'colorspace_fragment'])
    assert.ok(shader.fragmentShader.includes(`#include <${chunk}>`), chunk);
  assert.match(shader.fragmentShader, /pre-existing-effect/); assert.match(shader.fragmentShader, /gl_FrontFacing/); assert.match(shader.fragmentShader, /shTearsForward/);
  assert.doesNotMatch(shader.fragmentShader, /diffuseColor\.a\s*=/); assert.doesNotMatch(shader.fragmentShader, /float\s+length\s*=/);
  assert.equal(clone.alphaTest, 0.13); assert.equal(clone.transparent, true);
  assert.equal(clone.depthTest, f.material.depthTest); assert.equal(clone.depthWrite, f.material.depthWrite);
  assert.equal(f.material.vertexShader, originalVertex); assert.equal(f.material.fragmentShader, originalFragment);
  tears.dispose(); assert.equal(f.mesh.material, blushMaterial); blush.dispose(); assert.equal(f.mesh.material, f.material);
});

test('LIFO disposal and rebuild release each owned clone once and restore the complete callback chain', () => {
  const f = fixture(), originalRender = f.mesh.onBeforeRender; let originalDisposals = 0, geometryDisposals = 0;
  f.material.addEventListener('dispose', () => originalDisposals++); f.geometry.addEventListener('dispose', () => geometryDisposals++);
  for (let attempt = 0; attempt < 3; attempt++) {
    const blush = new ProceduralBlush(f.head, f.anchors, f.mesh), blushMaterial = current(f), blushRender = f.mesh.onBeforeRender;
    const tears = new ProceduralTears(f.head, f.anchors, f.mesh, true), tearMaterial = current(f);
    let tearDisposals = 0, blushDisposals = 0;
    tearMaterial.addEventListener('dispose', () => tearDisposals++); blushMaterial.addEventListener('dispose', () => blushDisposals++);
    const shader = compile(tearMaterial); tears.update(0.7, 1500); blush.update(0.35, 50);
    tears.dispose(); tears.dispose(); tears.update(1, 0);
    assert.equal(shader.uniforms.shTearsAmount.value, 0); assert.equal(f.mesh.material, blushMaterial); assert.equal(f.mesh.onBeforeRender, blushRender);
    assert.equal(tearDisposals, 1); assert.equal(blushDisposals, 0); assert.equal(tears.getState().attached, false);
    blush.dispose(); assert.equal(blushDisposals, 1); assert.equal(f.mesh.material, f.material); assert.equal(f.mesh.onBeforeRender, originalRender);
  }
  assert.equal(originalDisposals, 0); assert.equal(geometryDisposals, 0);
});

test('render hook uses the final head transform while eye rotation leaves the tear origins fixed', () => {
  const f = fixture(); let priorRenders = 0; const originalRender = () => { priorRenders++; }; f.mesh.onBeforeRender = originalRender;
  const effect = new ProceduralTears(f.head, f.anchors, f.mesh, true), shader = compile(current(f)); effect.update(0.8, 2200);
  const leftOrigin = shader.uniforms.shTearsLeft.value.clone(), rightOrigin = shader.uniforms.shTearsRight.value.clone();
  assert.equal(leftOrigin.x, f.anchors.leftEye[0]); assert.equal(leftOrigin.y, f.anchors.leftEye[1]); assert.equal(leftOrigin.z, f.anchors.leftCheek[2]);
  f.left.rotation.set(0.3, -0.6, 0.1); f.right.rotation.set(-0.4, 0.4, -0.1);
  f.head.position.set(2, 0.4, -1); f.head.rotation.set(0.2, 0.5, -0.1); f.mesh.position.set(-3, 1, 0); render(f);
  assert.equal(priorRenders, 1); assert.deepEqual(shader.uniforms.shTearsLeft.value.toArray(), leftOrigin.toArray());
  assert.deepEqual(shader.uniforms.shTearsRight.value.toArray(), rightOrigin.toArray());
  assert.deepEqual(shader.uniforms.shTearsMeshToHead.value.elements, new Matrix4().copy(f.head.matrixWorld).invert().multiply(f.mesh.matrixWorld).elements);
  assert.equal(shader.uniforms.shTearsAmount.value, 0.8); effect.dispose(); assert.equal(f.mesh.onBeforeRender, originalRender);
});

test('zero amount and singular final transforms do not leave a visible tear uniform behind', () => {
  const f = fixture(), effect = new ProceduralTears(f.head, f.anchors, f.mesh, true), shader = compile(current(f));
  effect.update(0.7, 2300); render(f); assert.equal(shader.uniforms.shTearsAmount.value, 0.7);
  effect.update(0, 2400); render(f); assert.equal(shader.uniforms.shTearsAmount.value, 0);
  effect.update(0.7, 2500); f.head.scale.x = 0; render(f); assert.equal(shader.uniforms.shTearsAmount.value, 0);
  f.head.scale.x = 1; render(f); assert.equal(shader.uniforms.shTearsAmount.value, 0.7);
  effect.dispose(); assert.equal(shader.uniforms.shTearsAmount.value, 0);
});

test('amount and elapsed inputs are bounded and cannot poison shader uniforms', () => {
  const f = fixture(), effect = new ProceduralTears(f.head, f.anchors, f.mesh, true), shader = compile(current(f));
  for (const [amount, elapsed, expectedAmount, expectedElapsed] of [[NaN, NaN, 0, 0], [Infinity, Infinity, 0, 0], [-1, -200, 0, 0], [2, 200_000, 1, 120_000], [0.3, 1700, 0.3, 1700]]) {
    effect.update(amount, elapsed); assert.equal(shader.uniforms.shTearsAmount.value, expectedAmount);
    assert.equal(effect.getState().elapsedMs, expectedElapsed); assert.equal(shader.uniforms.shTearsTime.value, expectedElapsed / 1000);
  }
  effect.dispose();
});

test('missing static shader chunks or material indices fail before attachment', () => {
  for (const missing of ['#include <common>', '#include <opaque_fragment>', '#include <normal_fragment_maps>']) {
    const f = fixture(); f.material.fragmentShader = f.material.fragmentShader.replace(missing, '');
    const hook = f.mesh.onBeforeRender, effect = new ProceduralTears(f.head, f.anchors, f.mesh, true);
    assert.equal(effect.getState().supported, false); assert.equal(effect.getState().attached, false);
    assert.equal(f.mesh.material, f.material); assert.equal(f.mesh.onBeforeRender, hook); effect.dispose();
  }
  const f = fixture(); f.anchors.materialIndices = [8]; const effect = new ProceduralTears(f.head, f.anchors, f.mesh, true);
  assert.equal(effect.getState().supported, false); assert.equal(f.mesh.material, f.material); effect.dispose();
});

test('a conflicting prior shader extension degrades explicitly and never reports compilation', () => {
  const f = fixture(); f.material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', ''); };
  const effect = new ProceduralTears(f.head, f.anchors, f.mesh, true), shader = compile(current(f)); effect.update(0.8, 1800);
  assert.equal(effect.getState().supported, false); assert.equal(effect.getState().compiled, 0); assert.equal(effect.getState().amount, 0);
  assert.match(effect.getState().reason, /冲突/); assert.doesNotMatch(shader.fragmentShader, /vec3 shTearsMask/); effect.dispose();
});

test('dispose preserves an external material/callback replacement rather than restoring stale owned state', () => {
  const f = fixture(), effect = new ProceduralTears(f.head, f.anchors, f.mesh, true), clone = current(f);
  const replacement = skin('external'), callback = () => {}; let disposedClones = 0;
  clone.addEventListener('dispose', () => disposedClones++); f.mesh.material = replacement; f.mesh.onBeforeRender = callback;
  effect.dispose(); assert.equal(f.mesh.material, replacement); assert.equal(f.mesh.onBeforeRender, callback); assert.equal(disposedClones, 1);
});

test('hash-pinned public Gene supplies face and cheek-cover targets and preserves unrelated materials and source geometry', async () => {
  const manifest = JSON.parse(await readFile('shared/bundled-assets.json', 'utf8'));
  const bytes = await readFile(join('assets/bundled', manifest.root, manifest.model.relativePath));
  const verified = createHash('sha256').update(bytes).digest('hex') === manifest.model.sha256;
  assert.equal(verified, true); assert.equal(bytes.byteLength, manifest.model.bytes);
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js'; const { MMDParser } = await import(parserModule);
  const parsed = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true), loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder._loadTexture = () => { const texture = new Texture() as any; texture.readyCallbacks = []; return texture; };
  const mesh = loader.meshBuilder.build(parsed, '') as SkinnedMesh, materials = mesh.material as ShaderMaterial[];
  const head = mesh.skeleton.bones.find(bone => bone.name === '頭')!, eyes = ['左目', '右目'].map(name => mesh.skeleton.bones.find(bone => bone.name === name)!);
  const originalRender = mesh.onBeforeRender, vertices = mesh.geometry.getAttribute('position').array.slice();
  try {
    const probe = probeBlushAnchors(mesh, head, eyes); assert.ok(probe.anchors, probe.reason);
    assert.equal(probe.anchors.eyeReference, 'main-eye-geometry'); assert.equal(tearsSupport(probe.anchors, verified).supported, true);
    assert.deepEqual(probe.anchors.materialIndices.map(index => materials[index].name), ['顔']);
    const faceIndex = probe.anchors.materialIndices[0], originalFace = materials[faceIndex];
    const blush = new ProceduralBlush(head, probe.anchors, mesh), blushMaterials = mesh.material;
    const tears = new ProceduralTears(head, probe.anchors, mesh, verified), installed = mesh.material as ShaderMaterial[], clone = installed[faceIndex], shader = compile(clone);
    assert.equal(tears.getState().supported, true); assert.equal(tears.getState().compiled, 1); assert.equal((clone as any).isMMDToonMaterial, true);
    assert.equal((clone as any).map, (originalFace as any).map); assert.equal(clone.uniforms.map.value, originalFace.uniforms.map.value);
    assert.deepEqual(tears.getState().materialIndices, [faceIndex, 8]);
    assert.notEqual(installed[8], materials[8]); assert.equal(installed[8].uniforms.map.value, materials[8].uniforms.map.value);
    for (let index = 0; index < materials.length; index++) if (index !== faceIndex && index !== 8) assert.equal(installed[index], materials[index]);
    tears.update(0.7, 1500); blush.update(0.35, 50);
    assert.equal(shader.uniforms.shTearsAmount.value, 0.7); assert.equal(shader.uniforms.shBlushAmount.value, 0.35);
    assert.ok(Math.abs(shader.uniforms.shTearsScale.value - probe.anchors.eyeDistance) < 1e-8);
    assert.deepEqual(mesh.geometry.getAttribute('position').array, vertices);
    tears.dispose(); assert.equal(mesh.material, blushMaterials); blush.dispose(); assert.equal(mesh.material, materials); assert.equal(mesh.onBeforeRender, originalRender);
  } finally { mesh.geometry.dispose(); for (const material of materials) material.dispose(); mesh.skeleton.dispose(); }
});
