import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Matrix4, Ray, ShaderMaterial, SkinnedMesh, Texture, Triangle, Vector3 } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { ProceduralBlush, probeBlushAnchors, type BlushAnchors } from '../src/stage/procedural-blush';
import { ProceduralTears } from '../src/stage/procedural-tears';

// Read only the hash-pinned public asset from the current project source.
// No private model, browser, GPU, texture decoding or application is involved.
const candidate = resolve('.');
const geneSha256 = '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
async function gene() {
  const manifest = JSON.parse(await readFile(resolve(candidate, 'shared/bundled-assets.json'), 'utf8'));
  const bytes = await readFile(resolve(candidate, 'assets/bundled', manifest.root, manifest.model.relativePath));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), geneSha256);
  assert.equal(manifest.model.sha256, geneSha256);
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const parsed = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const loader = new MMDLoader() as any;
  const textures = new Set<Texture>();
  loader.meshBuilder.materialBuilder._loadTexture = () => {
    const texture = new Texture() as Texture & { readyCallbacks: unknown[] };
    texture.readyCallbacks = []; textures.add(texture); return texture;
  };
  const mesh = loader.meshBuilder.build(parsed, '') as SkinnedMesh;
  const materials = mesh.material as ShaderMaterial[];
  const head = mesh.skeleton.bones.find(bone => bone.name === '頭')!;
  const eyes = ['左目', '右目'].map(name => mesh.skeleton.bones.find(bone => bone.name === name)!);
  const probe = probeBlushAnchors(mesh, head, eyes);
  assert.ok(probe.anchors, probe.reason);
  assert.deepEqual(probe.anchors.materialIndices, [3]);
  assert.equal(materials[3].name, '顔'); assert.equal(materials[8].name, '頬薄赤');
  const effects: { dispose(): void }[] = [];
  return { mesh, materials, head, anchors: probe.anchors, effects,
    tears(verified = true, anchors: BlushAnchors = probe.anchors!) {
      const effect = new ProceduralTears(head, anchors, mesh, verified); effects.push(effect); return effect;
    },
    close() {
      for (const effect of effects.reverse()) effect.dispose();
      mesh.geometry.dispose(); mesh.skeleton.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
    } };
}
function compile(material: ShaderMaterial) {
  const shader = { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader, uniforms: material.uniforms };
  material.onBeforeCompile(shader as any, {} as any); return shader;
}
function geometryBytes(mesh: SkinnedMesh) {
  return { index: Array.from(mesh.geometry.index!.array),
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attr]) => [name, Array.from((attr as any).array)])),
    morphs: Object.fromEntries(Object.entries(mesh.geometry.morphAttributes).map(([name, attrs]) => [name, (attrs ?? []).map(attr => Array.from((attr as any).array))])),
    morphInfluences: mesh.morphTargetInfluences?.slice(), groups: mesh.geometry.groups.map(group => ({ ...group })) };
}
const smooth = (lo: number, hi: number, value: number) => { const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
function leftTrail(point: Vector3, a: BlushAnchors) {
  const forward = new Vector3(...a.forward), eye = new Vector3(...a.leftEye);
  const origin = eye.clone().addScaledVector(forward, new Vector3(...a.leftCheek).sub(eye).dot(forward));
  const offset = point.clone().sub(origin).divideScalar(a.eyeDistance);
  const y = -offset.dot(new Vector3(...a.up)) - 0.13;
  const x = offset.dot(new Vector3(...a.right)) + (0.018 * y + 0.018 * Math.sin(y * 5));
  const width = 0.022 * (1 - 0.35 * Math.max(0, Math.min(1, y / 0.58)));
  return (1 - smooth(width * 0.55, width * 1.45, Math.abs(x))) * smooth(0, 0.04, y) *
    (1 - smooth(0.51, 0.58, y)) * (1 - smooth(0.18, 0.42, Math.abs(offset.dot(forward))));
}

test('real Gene tear-support ray reaches the opaque cheek cover before the underlying face', async () => {
  const f = await gene();
  try {
    // One independently retained ray from frozen offline evidence 7328640c…
    // (155/160 rays hit material 8). Recompute its actual geometry here rather
    // than treating the implementation target list as visibility evidence.
    const camera = new Vector3(7.429306010355486, 1.3854246820466052, 19.205775132377898);
    const target = new Vector3(-0.4880872216741508, 0.13852958679199218, 0.9837605893611907);
    assert.ok(leftTrail(target, f.anchors) > 0.7);
    f.mesh.updateWorldMatrix(true, true); f.mesh.skeleton.update();
    const toHead = new Matrix4().copy(f.head.matrixWorld).invert().multiply(f.mesh.matrixWorld);
    const index = f.mesh.geometry.index!, ray = new Ray(camera, target.clone().sub(camera).normalize());
    const faceDistance = camera.distanceTo(target);
    const nearest = new Map<number, number>(), hitPoints = new Map<number, Vector3>(); let targetOnFace = false;
    for (const group of f.mesh.geometry.groups.filter(group => [3, 8].includes(group.materialIndex!))) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const points = [0, 1, 2].map(j => f.mesh.getVertexPosition(index.getX(i + j), new Vector3()).applyMatrix4(toHead));
        if (group.materialIndex === 3 && new Triangle(points[0], points[1], points[2]).closestPointToPoint(target, new Vector3()).distanceTo(target) < 1e-6) targetOnFace = true;
        const hit = ray.intersectTriangle(points[0], points[1], points[2], false, new Vector3());
        if (hit && camera.distanceTo(hit) < (nearest.get(group.materialIndex!) ?? Infinity)) {
          nearest.set(group.materialIndex!, camera.distanceTo(hit)); hitPoints.set(group.materialIndex!, hit);
        }
      }
    }
    assert.equal(targetOnFace, true);
    assert.ok(nearest.has(8)); assert.ok(nearest.get(8)! < faceDistance - 1e-4);
    assert.ok(nearest.get(8)! < nearest.get(3)! - 1e-4);
    assert.ok(leftTrail(hitPoints.get(8)!, f.anchors) > 0.1);
    assert.equal(f.materials[8].opacity, 1);
    const tears = f.tears(); assert.equal(tears.getState().supported, true);
    assert.deepEqual(tears.getState().materialIndices, [3, 8]);
  } finally { f.close(); }
});

test('both audited surfaces receive the same tears while original shader, alpha, textures and morph data stay intact', async () => {
  const f = await gene();
  try {
    const before = geometryBytes(f.mesh), originalHook = f.mesh.onBeforeRender;
    const properties = f.materials.map(m => ({ opacity: m.opacity, transparent: m.transparent, alphaTest: m.alphaTest, side: m.side, depthTest: m.depthTest, depthWrite: m.depthWrite, vertex: m.vertexShader, fragment: m.fragmentShader }));
    const tears = f.tears(), installed = f.mesh.material as ShaderMaterial[];
    const shaders = [3, 8].map(i => {
      assert.notEqual(installed[i], f.materials[i]);
      for (const key of ['opacity', 'transparent', 'alphaTest', 'side', 'depthTest', 'depthWrite'] as const) assert.equal(installed[i][key], properties[i][key]);
      for (const [name, uniform] of Object.entries(f.materials[i].uniforms)) if (uniform.value?.isTexture) assert.equal(installed[i].uniforms[name].value, uniform.value);
      const shader = compile(installed[i]);
      assert.match(shader.fragmentShader, /vec3 shTearsMask/); assert.match(shader.vertexShader, /vShTearsHead =/);
      assert.ok(shader.fragmentShader.includes('#include <alphatest_fragment>')); return shader;
    });
    assert.equal(shaders[0].uniforms.shTearsAmount, shaders[1].uniforms.shTearsAmount);
    tears.update(0.8, 1800);
    assert.equal(shaders[1].uniforms.shTearsAmount.value, 0.8);
    for (let i = 0; i < installed.length; i++) if (![3, 8].includes(i)) assert.equal(installed[i], f.materials[i]);
    assert.equal(f.materials[3].vertexShader, properties[3].vertex); assert.equal(f.materials[8].fragmentShader, properties[8].fragment);
    assert.deepEqual(geometryBytes(f.mesh), before);
    tears.dispose(); assert.equal(f.mesh.material, f.materials); assert.equal(f.mesh.onBeforeRender, originalHook);
  } finally { f.close(); }
});

test('names grant no authority to an unverified model and non-Gene synthetic selected indices retain their prior behavior', async () => {
  const f = await gene();
  try {
    const originalHook = f.mesh.onBeforeRender;
    const denied = f.tears(false); assert.equal(denied.getState().supported, false);
    assert.equal(f.mesh.material, f.materials); assert.equal(f.mesh.onBeforeRender, originalHook);
    const synthetic = f.tears(true, { ...f.anchors, materialIndices: [0] });
    assert.equal(synthetic.getState().supported, true);
    assert.deepEqual(synthetic.getState().materialIndices, [0]);
    assert.equal((f.mesh.material as ShaderMaterial[])[8], f.materials[8]);
  } finally { f.close(); }
});

test('an unavailable cover shader or mismatched audited names fails before cloning or publishing either surface', async () => {
  const f = await gene();
  try {
    const originalHook = f.mesh.onBeforeRender, clone = f.materials[3].clone, coverName = f.materials[8].name, faceName = f.materials[3].name, fragment = f.materials[8].fragmentShader;
    let clones = 0; f.materials[3].clone = function () { clones++; return clone.call(this); };
    for (const failure of ['cover-shader', 'cover-name', 'face-name']) {
      f.materials[8].fragmentShader = failure === 'cover-shader' ? fragment.replace('#include <opaque_fragment>', '') : fragment;
      f.materials[8].name = failure === 'cover-name' ? 'unreviewed-cover' : coverName;
      f.materials[3].name = failure === 'face-name' ? 'unreviewed-face' : faceName;
      const tears = f.tears(); assert.equal(tears.getState().supported, false); assert.equal(tears.getState().attached, false);
      assert.equal(f.mesh.material, f.materials); assert.equal(f.mesh.onBeforeRender, originalHook); tears.dispose();
    }
    assert.equal(clones, 0); f.materials[3].clone = clone;
  } finally { f.close(); }
});

test('a second-surface clone failure rolls back the first clone exactly once and never publishes a partial layer', async () => {
  const f = await gene();
  try {
    const originalHook = f.mesh.onBeforeRender, firstClone = f.materials[3].clone;
    let ownedDisposals = 0, originalDisposals = 0;
    for (const m of f.materials) m.addEventListener('dispose', () => originalDisposals++);
    f.materials[3].clone = function () { const result = firstClone.call(this); result.addEventListener('dispose', () => ownedDisposals++); return result; };
    f.materials[8].clone = () => { throw Error('deliberate second-layer clone failure'); };
    const tears = f.tears(); assert.equal(tears.getState().supported, false); assert.equal(tears.getState().attached, false);
    assert.deepEqual(tears.getState().materialIndices, []);
    assert.equal(f.mesh.material, f.materials); assert.equal(f.mesh.onBeforeRender, originalHook);
    assert.equal(ownedDisposals, 1); assert.equal(originalDisposals, 0);
    tears.dispose(); assert.equal(ownedDisposals, 1);
  } finally { f.close(); }
});

test('blush/tears rebuilds unwind both cover clones in LIFO order and a dynamic cover conflict zeros the shared tears', async () => {
  const f = await gene();
  try {
    const originalHook = f.mesh.onBeforeRender;
    for (const conflict of [false, true]) {
      const blush = new ProceduralBlush(f.head, f.anchors, f.mesh); f.effects.push(blush);
      const blushMaterials = f.mesh.material, blushHook = f.mesh.onBeforeRender;
      f.materials[8].onBeforeCompile = shader => { if (conflict) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', ''); };
      const tears = f.tears(), installed = f.mesh.material as ShaderMaterial[];
      let cloneDisposals = 0; for (const i of [3, 8]) installed[i].addEventListener('dispose', () => cloneDisposals++);
      const face = compile(installed[3]); compile(installed[8]);
      tears.update(0.6, 1400); blush.update(0.3, 50);
      assert.equal(face.uniforms.shBlushAmount.value, 0.3);
      assert.equal(face.uniforms.shTearsAmount.value, conflict ? 0 : 0.6);
      assert.equal(tears.getState().supported, !conflict);
      tears.dispose(); assert.equal(cloneDisposals, 2); assert.equal(f.mesh.material, blushMaterials); assert.equal(f.mesh.onBeforeRender, blushHook);
      blush.dispose(); assert.equal(f.mesh.material, f.materials); assert.equal(f.mesh.onBeforeRender, originalHook);
    }
  } finally { f.close(); }
});
