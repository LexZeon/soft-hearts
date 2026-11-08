import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Float32BufferAttribute, PerspectiveCamera, ShaderMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, UniformsUtils } from 'three';
import { MMDToonShader } from 'three/examples/jsm/shaders/MMDToonShader.js';
import { MmdStage } from '../src/stage/MmdStage';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/blush';
import { probeHeadContact } from '../src/stage/head-contact';

function restFace() {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], weights: number[] = [];
  for (let row = 0; row < 30; row++) for (let column = 0; column < 40; column++) {
    const x = column / 39 * 2.5 - 1.25, y = row / 29 * 1.9 - 0.5;
    positions.push(x, y, 1 - x * x * 0.08 - (y - 0.5) ** 2 * 0.03);
    const length = Math.hypot(x * 0.16, (y - 0.5) * 0.06, 1);
    normals.push(x * 0.16 / length, (y - 0.5) * 0.06 / length, 1 / length);
    indices.push(0, 0, 0, 0); weights.push(1, 0, 0, 0);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  geometry.addGroup(0, positions.length / 3, 0);
  const material = new ShaderMaterial({ vertexShader: MMDToonShader.vertexShader, fragmentShader: MMDToonShader.fragmentShader, uniforms: UniformsUtils.clone(MMDToonShader.uniforms) }); material.name = 'face-skin';
  const mesh = new SkinnedMesh(geometry, material);
  const head = new Bone(), left = new Bone(), right = new Bone();
  head.name = '頭'; left.name = '左目'; right.name = '右目';
  left.position.set(-0.5, 1, 1.1); right.position.set(0.5, 1, 1.1);
  head.add(left, right); mesh.add(head); mesh.bind(new Skeleton([head, left, right]));
  mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
  return { geometry, material, mesh, head, eyes: [left, right] };
}

test('calibration re-probing during a selected head pose preserves rest-local cheek orientation and the playing pose', () => {
  const f = restFace();
  // Exercise the real stage integration without constructing its WebGL renderer.
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage, {
    mesh: f.mesh, head: f.head, eyes: f.eyes, modelUrl: 'fixture-model',
    blushCalibrationModelUrl: 'fixture-model', blushCalibration: { ...DEFAULT_BLUSH_CALIBRATION },
    proceduralBlush: null,
    restPose: f.mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() })),
  });
  try {
    stage.rebuildBlush();
    assert.ok(stage.proceduralBlush, stage.blushSupport);
    const inspect = () => {
      const material = f.mesh.material as ShaderMaterial;
      const shader = { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader, uniforms: { ...material.uniforms } };
      material.onBeforeCompile(shader as any, {} as any);
      return { center: shader.uniforms.shBlushLeft.value.clone(), forward: shader.uniforms.shBlushForward.value.clone() };
    };
    const rest = inspect();
    f.head.rotation.y = 0.6;
    f.mesh.updateWorldMatrix(true, true); f.mesh.skeleton.update();
    const playingOrientation = f.head.quaternion.clone();
    stage.rebuildBlush();
    assert.ok(stage.proceduralBlush, stage.blushSupport);
    const playing = inspect();
    assert.ok(playing.forward.distanceTo(rest.forward) < 1e-5, 'a current VMD head turn must not be baked inversely into the mask');
    assert.ok(playing.center.distanceTo(rest.center) < 1e-5, 'unchanged calibration has the same head-local anchors');
    assert.ok(f.head.quaternion.angleTo(playingOrientation) < 1e-7, 'inspection must restore the selected playing pose');
  } finally {
    stage.proceduralBlush?.dispose(); f.geometry.dispose(); f.material.dispose();
  }
});

test('changing the scalp hit ellipse does not change frozen rua input scale or the food target', () => {
  const f = restFace();
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 100);
  camera.position.set(0, 1.5, 10); camera.lookAt(0, 1.5, 0); camera.updateWorldMatrix(true, false);
  const profile = probeHeadContact(f.mesh, f.head, f.eyes, 20);
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage, { mesh: f.mesh, head: f.head, eyes: f.eyes, height: 20, camera,
    hostVisible: true, controls: { interacting: false }, container: { clientWidth: 400, clientHeight: 560 },
    renderer: { domElement: { dataset: {} } }, headContactProfile: profile });
  try {
    const first = stage.getInteractionRegion(); assert.ok(first);
    profile.halfWidth *= 1.7; profile.halfHeight *= 1.4;
    const expanded = stage.getInteractionRegion(); assert.ok(expanded);
    assert.notEqual(expanded.axisXX, first.axisXX);
    assert.notEqual(expanded.axisYY, first.axisYY);
    assert.equal(expanded.referenceWidth, first.referenceWidth);
    assert.equal(expanded.mouthRadius, first.mouthRadius);
    assert.equal(expanded.mouthX, first.mouthX);
    assert.equal(expanded.mouthY, first.mouthY);
  } finally { f.geometry.dispose(); f.material.dispose(); }
});
