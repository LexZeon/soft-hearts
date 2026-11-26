// The procedural blush measures the real eye spacing from the main eye material. A VRoid model converted to PMX names
// it `N00_000_00_EyeIris_00_EYE`; its eye bones sit at about a third of the real spacing, so without the eye surface the cheeks
// fell under the nose (docs/claude/2026-11-19-mumi-pmx-face.md). Gene's own names and the other layers must stay as they were.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, BufferGeometry, Float32BufferAttribute, ShaderMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, UniformsUtils, Vector3 } from 'three';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import { eyeMaterialPriority } from '../src/stage/blush-eye-names';
import { probeBlushAnchors } from '../src/stage/procedural-blush';

test('eye material names: Gene and the old generic names keep their rank, VRoid iris and white join them', () => {
  assert.equal(eyeMaterialPriority('目'), 0);
  assert.equal(eyeMaterialPriority('瞳'), 1);
  assert.equal(eyeMaterialPriority('Iris'), 1);
  assert.equal(eyeMaterialPriority('眼'), 2);
  assert.equal(eyeMaterialPriority('eyes'), 2);
  assert.equal(eyeMaterialPriority('N00_000_00_EyeIris_00_EYE'), 1);
  assert.equal(eyeMaterialPriority('N00_000_00_EyeWhite_00_EYE'), 2);
  assert.equal(eyeMaterialPriority('Mia_EyeIris_01_EYE'), 1);
  // layers that are not the main eye surface, and every other Gene material
  for (const name of ['N00_000_00_EyeHighlight_00_EYE', 'N00_000_00_FaceEyeline_00_FACE', 'N00_000_00_FaceEyelash_00_FACE', 'N00_000_00_FaceBrow_00_FACE',
    'N00_000_00_Face_00_SKIN', '顔', '星目', 'ぐるぐる目', '頬薄赤', '青ざめ', '髪', 'トップス', 'Mumi Leaf Matte', 'EyeIrisExtra', '']) assert.equal(eyeMaterialPriority(name), -1, name);
});

function skinMaterial(name: string) {
  const value = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) });
  value.name = name; return value;
}
/** A flat-ish face with eye bones 1 apart (E = 1), real eyes (named by `eyeName`) 2.6 apart floating just in front of it. */
function face(eyeName: string) {
  const geometry = new BufferGeometry(), positions: number[] = [], normals: number[] = [], indices: number[] = [], weights: number[] = [], triangles: number[] = [];
  const grid = (x0: number, x1: number, y0: number, y1: number, z: number, nx: number, ny: number) => {
    const base = positions.length / 3;
    for (let row = 0; row < ny; row++) for (let column = 0; column < nx; column++) {
      positions.push(x0 + (x1 - x0) * column / (nx - 1), y0 + (y1 - y0) * row / (ny - 1), z); normals.push(0, 0, 1); indices.push(0, 0, 0, 0); weights.push(1, 0, 0, 0);
    }
    const start = triangles.length;
    for (let row = 0; row < ny - 1; row++) for (let column = 0; column < nx - 1; column++) {
      const a = base + row * nx + column, b = a + 1, c = a + nx, d = c + 1; triangles.push(a, b, c, b, d, c);
    }
    return { start, count: triangles.length - start };
  };
  const skin = grid(-3, 3, -0.6, 2.2, 1.0, 61, 29);
  const eyes = [grid(-1.6, -1.0, 0.8, 1.2, 1.4, 7, 5), grid(1.0, 1.6, 0.8, 1.2, 1.4, 7, 5)];
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  geometry.setIndex(triangles);
  geometry.addGroup(skin.start, skin.count, 0);
  for (const eye of eyes) geometry.addGroup(eye.start, eye.count, 1);
  const mesh = new SkinnedMesh(geometry, [skinMaterial('N00_000_00_Face_00_SKIN'), skinMaterial(eyeName)]);
  const head = new Bone(), left = new Bone(), right = new Bone(); head.name = '頭'; left.name = '左目'; right.name = '右目';
  left.position.set(-0.5, 1, 1.0); right.position.set(0.5, 1, 1.0);
  head.add(left, right); mesh.add(head); mesh.bind(new Skeleton([head, left, right])); mesh.updateWorldMatrix(true, true);
  return { mesh, head, eyes: [left, right] };
}
const probe = (eyeName: string) => {
  const f = face(eyeName), result = probeBlushAnchors(f.mesh, f.head, f.eyes, undefined, {}, new Vector3(0, 0.1, 1.2));
  assert.equal(result.supported, true, result.reason); assert.ok(result.anchors); return result.anchors;
};

test('a VRoid-named iris or eye white gives the measured eye spacing, so the cheeks sit under the real eyes', () => {
  for (const name of ['N00_000_00_EyeIris_00_EYE', 'N00_000_00_EyeWhite_00_EYE']) {
    const a = probe(name);
    assert.equal(a.eyeReference, 'main-eye-geometry', name);
    assert.ok(Math.abs(a.eyeDistance - 2.6) < 0.1, `eye spacing ${a.eyeDistance}`);
    assert.ok(a.leftCheek[0] < -1.3 && a.rightCheek[0] > 1.3, `cheeks at ${a.leftCheek[0]}, ${a.rightCheek[0]}`);
    assert.ok(Math.abs(a.leftCheek[0] + a.rightCheek[0]) < 1e-6, 'left and right are symmetric');
    assert.ok(a.leftCheek[1] < a.leftEye[1], 'under the eyes');
  }
});

test('the same face with an eye layer that is not the main eye surface keeps the eye-bone reference as before', () => {
  for (const name of ['N00_000_00_EyeHighlight_00_EYE', 'N00_000_00_FaceEyeline_00_FACE']) {
    const a = probe(name);
    assert.equal(a.eyeReference, 'eye-bones', name);
    assert.equal(a.eyeDistance, a.boneEyeDistance);
  }
});
