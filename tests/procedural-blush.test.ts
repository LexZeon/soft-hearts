import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bone, BufferGeometry, Float32BufferAttribute, Matrix4, MeshBasicMaterial, PerspectiveCamera, RepeatWrapping, ShaderMaterial, Skeleton, SkinnedMesh, SRGBColorSpace, Texture, Uint16BufferAttribute, UniformsUtils, Vector3 } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import { ProceduralBlush, probeBlushAnchors } from '../src/stage/procedural-blush';

function skin(name = 'face-skin') {
  const value = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) });
  value.name = name; return value;
}
function fixture(scale = 1, named = true) {
  const geometry = new BufferGeometry(), positions: number[] = [], normals: number[] = [], indices: number[] = [], weights: number[] = [];
  for (let row = 0; row < 32; row++) for (let column = 0; column < 42; column++) {
    const x = column / 41 * 2.5 - 1.25, y = row / 31 * 1.9 - 0.5;
    positions.push(x * scale, y * scale, (1 - x * x * 0.08 - (y - 0.5) ** 2 * 0.03) * scale);
    normals.push(...new Vector3(x * 0.16, (y - 0.5) * 0.06, 1).normalize().toArray()); indices.push(0, 0, 0, 0); weights.push(1, 0, 0, 0);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4)); geometry.addGroup(0, positions.length / 3, 0);
  const material = skin(named ? 'face-skin' : 'material'), mesh = new SkinnedMesh(geometry, material) as SkinnedMesh;
  const head = new Bone(), left = new Bone(), right = new Bone(), mouth = new Bone(); head.name = '頭'; left.name = '左目'; right.name = '右目';
  left.position.set(-0.5 * scale, scale, 1.1 * scale); right.position.set(0.5 * scale, scale, 1.1 * scale); mouth.position.set(0, 0.1 * scale, scale);
  head.add(left, right, mouth); mesh.add(head); mesh.bind(new Skeleton([head, left, right, mouth])); mesh.updateWorldMatrix(true, true);
  return { mesh, head, left, right, mouth, geometry, material };
}
function anchors(f: ReturnType<typeof fixture>) {
  const result = probeBlushAnchors(f.mesh, f.head, [f.left, f.right]); assert.equal(result.supported, true, result.reason); assert.ok(result.anchors); return result.anchors;
}
function compile(material: ShaderMaterial) {
  const shader = { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader, uniforms: material.uniforms };
  material.onBeforeCompile(shader as any, {} as any); return shader;
}
const cloneOf = (f: ReturnType<typeof fixture>) => (Array.isArray(f.mesh.material) ? f.mesh.material[0] : f.mesh.material) as ShaderMaterial;

test('probe uses real eyes and reliable skin ownership with an explicit estimated mouth', () => {
  const f = fixture(), result = probeBlushAnchors(f.mesh, f.head, [f.left, f.right]);
  assert.equal(result.supported, true, result.reason); assert.ok(result.anchors); assert.equal(result.anchors.mouthEstimated, true);
  assert.equal(result.anchors.surfaceSource, 'named-face'); assert.deepEqual(result.anchors.materialIndices, [0]); assert.match(result.reason, /嘴点.*估算/);
  assert.equal(result.anchors.eyeDistance, 1); assert.equal(result.anchors.boneEyeDistance, 1); assert.equal(result.anchors.eyeReference, 'eye-bones'); assert.ok(result.anchors.leftCheek[0] < 0 && result.anchors.rightCheek[0] > 0);
  assert.ok(result.anchors.leftCheek[1] < result.anchors.leftEye[1]); assert.ok(result.anchors.leftCheek[2] < result.anchors.leftEye[2]);
});

test('size changes only radii, while calibration changes references; no geometry is created or moved', () => {
  const f = fixture(), baseline = anchors(f), changed = probeBlushAnchors(f.mesh, f.head, [f.left, f.right], f.mouth, { eyeOffsetY: 0.1, mouthOffsetX: 0.1, eyeSpacingScale: 1.1 });
  assert.ok(changed.anchors); assert.equal(changed.anchors.mouthEstimated, false); assert.ok(changed.anchors.leftEye[1] > baseline.leftEye[1]); assert.ok(changed.anchors.mouth[0] > baseline.mouth[0]);
  const positions = f.geometry.getAttribute('position').array.slice(), effect = new ProceduralBlush(f.head, changed.anchors, f.mesh), shader = compile(cloneOf(f));
  effect.update(0.35, 50); const center = shader.uniforms.shBlushLeft.value.clone(), radius = shader.uniforms.shBlushRadius.value.clone(), depth = shader.uniforms.shBlushDepth.value;
  effect.update(0.35, 100); assert.equal(shader.uniforms.shBlushRadius.value.x, radius.x * 2); assert.equal(shader.uniforms.shBlushRadius.value.y, radius.y * 2);
  assert.equal(shader.uniforms.shBlushAmount.value, 0.35); assert.deepEqual(shader.uniforms.shBlushLeft.value.toArray(), center.toArray()); assert.equal(shader.uniforms.shBlushDepth.value, depth);
  assert.deepEqual(f.geometry.getAttribute('position').array, positions); assert.equal(effect.group.children.length, 0); effect.dispose();
});

test('injection preserves original compile extension, UV, alpha, normals, light, depth and color-space', () => {
  const f = fixture(); let calls = 0; f.material.transparent = true; f.material.alphaTest = 0.1;
  const vertex = f.material.vertexShader, fragment = f.material.fragmentShader;
  f.material.customProgramCacheKey = () => 'existing-key'; f.material.onBeforeCompile = shader => { calls++; shader.fragmentShader += '\n// prior-compiler'; };
  const effect = new ProceduralBlush(f.head, anchors(f), f.mesh), clone = cloneOf(f), shader = compile(clone);
  assert.notEqual(clone, f.material); assert.equal(calls, 1); assert.equal(effect.getState().compiled, 1); assert.match(clone.customProgramCacheKey(), /^existing-key:soft-hearts/);
  assert.ok(shader.vertexShader.indexOf('vShBlushHead =') > shader.vertexShader.indexOf('#include <displacementmap_vertex>'));
  for (const chunk of ['map_fragment', 'normal_fragment_maps', 'lights_fragment_begin', 'alphatest_fragment', 'tonemapping_fragment', 'colorspace_fragment']) assert.ok(shader.fragmentShader.includes(`#include <${chunk}>`), chunk);
  assert.match(shader.fragmentShader, /prior-compiler/); assert.match(shader.fragmentShader, /diffuseColor\.rgb = mix/); assert.match(shader.fragmentShader, /shBlushDepth/); assert.match(shader.fragmentShader, /dot\(normalize\(vViewPosition\), normal\)/);
  assert.doesNotMatch(shader.fragmentShader, /diffuseColor\.a\s*=/); assert.equal(clone.depthTest, f.material.depthTest); assert.equal(clone.depthWrite, f.material.depthWrite); assert.equal(clone.transparent, true); assert.equal(clone.alphaTest, 0.1);
  assert.equal(f.material.vertexShader, vertex); assert.equal(f.material.fragmentShader, fragment); effect.dispose();
});

test('original Texture objects remain shared when loader settings arrive after cloning', () => {
  const f = fixture(), texture = new Texture(), gradient = new Texture(); let disposed = 0;
  texture.addEventListener('dispose', () => disposed++); gradient.addEventListener('dispose', () => disposed++);
  f.material.uniforms.map.value = texture; f.material.uniforms.gradientMap.value = gradient;
  const effect = new ProceduralBlush(f.head, anchors(f), f.mesh), clone = cloneOf(f);
  assert.equal(clone.uniforms.map.value, texture); assert.equal(clone.uniforms.gradientMap.value, gradient);
  texture.flipY = false; texture.wrapS = RepeatWrapping; texture.colorSpace = SRGBColorSpace;
  assert.equal(clone.uniforms.map.value.flipY, false); assert.equal(clone.uniforms.map.value.wrapS, RepeatWrapping); assert.equal(clone.uniforms.map.value.colorSpace, SRGBColorSpace);
  effect.dispose(); assert.equal(disposed, 0); assert.equal(f.mesh.material, f.material);
});

test('onBeforeRender samples the final pose, keeps eye rotation out of anchors, and chains the original callback', () => {
  const f = fixture(); let calls = 0; const original = () => { calls++; }; f.mesh.onBeforeRender = original;
  const effect = new ProceduralBlush(f.head, anchors(f), f.mesh), shader = compile(cloneOf(f)); effect.update(0.4, 50);
  const center = shader.uniforms.shBlushLeft.value.toArray(); f.left.rotation.y = 0.6; f.right.rotation.y = -0.5; f.head.rotation.set(0.1, 0.4, 0.06); f.head.position.x = 2;
  f.mesh.updateWorldMatrix(true, true); f.mesh.onBeforeRender({} as any, {} as any, new PerspectiveCamera(), f.geometry, cloneOf(f), {} as any);
  assert.equal(calls, 1); assert.deepEqual(shader.uniforms.shBlushLeft.value.toArray(), center);
  assert.deepEqual(shader.uniforms.shBlushMeshToHead.value.elements, new Matrix4().copy(f.head.matrixWorld).invert().multiply(f.mesh.matrixWorld).elements);
  effect.dispose(); assert.equal(f.mesh.onBeforeRender, original);
});

test('zero size, zero amount and nonfinite inputs disable only the optional color', () => {
  const f = fixture(), before = f.material.uniforms.diffuse.value.toArray(), effect = new ProceduralBlush(f.head, anchors(f), f.mesh), shader = compile(cloneOf(f));
  for (const [amount, size] of [[0.5, 0], [0, 50], [NaN, 50], [0.5, NaN]]) { effect.update(amount, size); assert.equal(shader.uniforms.shBlushAmount.value, 0); }
  assert.deepEqual(f.material.uniforms.diffuse.value.toArray(), before); effect.dispose(); assert.equal(shader.uniforms.shBlushAmount.value, 0);
});

test('unnamed local surfaces identify their real group independently of model scale or a named body material', () => {
  for (const scale of [0.001, 1, 1000]) {
    const f = fixture(scale, false), body = skin('skin-body'); f.mesh.material = [body, f.material]; f.geometry.clearGroups(); f.geometry.addGroup(0, f.geometry.getAttribute('position').count, 1);
    const result = probeBlushAnchors(f.mesh, f.head, [f.left, f.right]); assert.equal(result.supported, true, result.reason); assert.equal(result.anchors!.surfaceSource, 'local-face');
    assert.deepEqual(result.anchors!.materialIndices, [1]); assert.ok(Math.abs(result.anchors!.eyeDistance / scale - 1) < 1e-8);
    const effect = new ProceduralBlush(f.head, result.anchors!, f.mesh); assert.equal(f.mesh.material[0], body); assert.notEqual(f.mesh.material[1], f.material); effect.dispose();
  }
});

test('missing landmarks, unsupported shaders, ambiguous groups and absent skin return explicit failures', () => {
  const f = fixture(); assert.equal(probeBlushAnchors(f.mesh, undefined, [f.left, f.right]).supported, false); assert.match(probeBlushAnchors(f.mesh, f.head, [f.left]).reason, /两个独立眼骨/);
  f.right.position.copy(f.left.position); assert.equal(probeBlushAnchors(f.mesh, f.head, [f.left, f.right]).supported, false); f.right.position.set(0.5, 1, 1.1);
  f.mouth.position.y = 3; assert.equal(probeBlushAnchors(f.mesh, f.head, [f.left, f.right], f.mouth).supported, false); f.mouth.position.y = 0.1;
  assert.equal(probeBlushAnchors(f.mesh, f.head, [f.left, f.right], undefined, { eyeSpacingScale: 10 }).supported, false);
  f.mesh.material = new MeshBasicMaterial(); assert.equal(probeBlushAnchors(f.mesh, f.head, [f.left, f.right]).supported, false);
  f.mesh.material = [skin('material1'), skin('material2')]; f.geometry.addGroup(0, f.geometry.getAttribute('position').count, 1);
  assert.equal(probeBlushAnchors(f.mesh, f.head, [f.left, f.right]).supported, false);
  f.mesh.material = f.material; f.geometry.clearGroups(); f.geometry.addGroup(0, f.geometry.getAttribute('position').count, 0);
  const position = f.geometry.getAttribute('position'); for (let i = 0; i < position.count; i++) position.setZ(i, -5);
  assert.match(probeBlushAnchors(f.mesh, f.head, [f.left, f.right]).reason, /表面/);
});

test('an incompatible prior shader extension degrades explicitly without pretending the decal compiled', () => {
  const f = fixture(); f.material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', ''); };
  const effect = new ProceduralBlush(f.head, anchors(f), f.mesh), shader = compile(cloneOf(f)); effect.update(0.8, 80);
  assert.equal(effect.supported, false); assert.match(effect.reason, /缺少.*接点/); assert.equal(effect.getState().amount, 0); assert.doesNotMatch(shader.fragmentShader, /shBlushMask/); effect.dispose();
});

test('dispose restores only owned materials/callbacks and never disposes model geometry or original materials', () => {
  const f = fixture(), originalRender = f.mesh.onBeforeRender, effect = new ProceduralBlush(f.head, anchors(f), f.mesh), clone = cloneOf(f);
  let clones = 0, originals = 0, geometries = 0;
  clone.addEventListener('dispose', () => clones++); f.material.addEventListener('dispose', () => originals++); f.geometry.addEventListener('dispose', () => geometries++);
  effect.dispose(); effect.dispose(); effect.update(1, 100);
  assert.equal(f.mesh.material, f.material); assert.equal(f.mesh.onBeforeRender, originalRender); assert.equal(clones, 1); assert.equal(originals, 0); assert.equal(geometries, 0); assert.equal(effect.getState().attached, false);
  const again = new ProceduralBlush(f.head, anchors(f), f.mesh), replacement = skin('external'), callback = () => {};
  f.mesh.material = replacement; f.mesh.onBeforeRender = callback; again.dispose(); assert.equal(f.mesh.material, replacement); assert.equal(f.mesh.onBeforeRender, callback);
});

test('real bundled Gene selects only 顔 and preserves its actual MMDToonMaterial and late texture references', async () => {
  const manifest = JSON.parse(await readFile('shared/bundled-assets.json', 'utf8')), bytes = await readFile(join('assets/bundled', manifest.root, manifest.model.relativePath));
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js'; const { MMDParser } = await import(parserModule);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true), loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder._loadTexture = () => { const texture = new Texture() as any; texture.readyCallbacks = []; return texture; };
  const mesh = loader.meshBuilder.build(data, '') as SkinnedMesh, materials = mesh.material as ShaderMaterial[];
  try {
    const head = mesh.skeleton.bones.find(bone => bone.name === '頭')!, eyes = ['左目', '右目'].map(name => mesh.skeleton.bones.find(bone => bone.name === name)!);
    const result = probeBlushAnchors(mesh, head, eyes); assert.equal(result.supported, true, result.reason); assert.ok(result.anchors);
    assert.equal(result.anchors.surfaceSource, 'named-face'); assert.deepEqual(result.anchors.materialIndices.map(index => materials[index].name), ['顔']);
    assert.equal(result.anchors.eyeReference, 'main-eye-geometry'); assert.match(result.reason, /主眼几何校准/);
    assert.ok(result.anchors.boneEyeDistance > 0.51 && result.anchors.boneEyeDistance < 0.53);
    assert.ok(result.anchors.eyeDistance > 0.94 && result.anchors.eyeDistance < 0.97, 'visible spacing is separate from the narrow, deep eye bones');
    assert.ok(result.anchors.leftCheek[0] < -0.55 && result.anchors.leftCheek[0] > -0.65); assert.ok(result.anchors.rightCheek[0] > 0.55 && result.anchors.rightCheek[0] < 0.65);
    assert.ok(result.anchors.leftCheek[1] > 0 && result.anchors.leftCheek[1] < 0.22); assert.ok(result.anchors.mouth[1] < 0.05, 'mouth remains an explicit lower-face estimate');
    const shifted = probeBlushAnchors(mesh, head, eyes, undefined, { eyeOffsetX: 0.1 }); assert.ok(shifted.anchors);
    const eyeCenterX = (value: NonNullable<typeof result.anchors>) => (value.leftEye[0] + value.rightEye[0]) / 2;
    assert.ok(Math.abs(eyeCenterX(shifted.anchors) - eyeCenterX(result.anchors) - result.anchors.boneEyeDistance * 0.1) < 1e-7, 'persisted offsets still use original bone E');
    const wider = probeBlushAnchors(mesh, head, eyes, undefined, { eyeSpacingScale: 1.1 }); assert.ok(wider.anchors);
    assert.ok(Math.abs(wider.anchors.eyeDistance / result.anchors.eyeDistance - 1.1) < 1e-7);
    assert.ok(Math.abs(wider.anchors.mouth[1] - result.anchors.mouth[1]) < 0.05, 'horizontal scaling does not multiply vertical mouth placement');
    const effect = new ProceduralBlush(head, result.anchors, mesh), faceIndex = result.anchors.materialIndices[0], clone = (mesh.material as ShaderMaterial[])[faceIndex];
    assert.equal((clone as any).isMMDToonMaterial, true); assert.equal(clone.vertexShader, materials[faceIndex].vertexShader); assert.equal(clone.fragmentShader, materials[faceIndex].fragmentShader);
    assert.equal((clone as any).map, (materials[faceIndex] as any).map); assert.equal(clone.uniforms.map.value, materials[faceIndex].uniforms.map.value);
    (materials[faceIndex] as any).map.flipY = false; (materials[faceIndex] as any).map.colorSpace = SRGBColorSpace;
    assert.equal((clone as any).map.flipY, false); assert.equal((clone as any).map.colorSpace, SRGBColorSpace);
    const shader = compile(clone); effect.update(0.8, 20); const smallCenter = shader.uniforms.shBlushLeft.value.toArray(), smallRadius = shader.uniforms.shBlushRadius.value.x;
    effect.update(0.8, 80); assert.deepEqual(shader.uniforms.shBlushLeft.value.toArray(), smallCenter); assert.equal(shader.uniforms.shBlushRadius.value.x, smallRadius * 4); assert.equal(shader.uniforms.shBlushAmount.value, 0.8); assert.equal(effect.getState().compiled, 1);
    for (let index = 0; index < materials.length; index++) if (index !== faceIndex) assert.equal((mesh.material as ShaderMaterial[])[index], materials[index]);
    assert.ok(mesh.skeleton.boneMatrices.some(value => value !== 0)); effect.dispose(); assert.equal(mesh.material, materials);
    const mainEyeGroup = mesh.geometry.groups.find(group => materials[group.materialIndex!].name === '目')!;
    const duplicate = materials[mainEyeGroup.materialIndex!].clone(); duplicate.name = '目'; materials.push(duplicate);
    mesh.geometry.addGroup(mainEyeGroup.start, mainEyeGroup.count, materials.length - 1);
    const ambiguous = probeBlushAnchors(mesh, head, eyes); assert.equal(ambiguous.supported, true, ambiguous.reason); assert.equal(ambiguous.anchors!.eyeReference, 'eye-bones');
    assert.equal(ambiguous.anchors!.eyeDistance, ambiguous.anchors!.boneEyeDistance); assert.match(ambiguous.reason, /眼骨参考/);
  } finally { mesh.geometry.dispose(); for (const material of materials) material.dispose(); mesh.skeleton.dispose(); }
});
