import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { MmdStage } from '../src/stage/MmdStage';

test('viewport resize presents the same scene immediately and keeps world proportions across aspect ratios', () => {
  const oldDocument = globalThis.document;
  globalThis.document = { hidden: false } as Document;
  try {
    const stage = Object.create(MmdStage.prototype) as any;
    const camera = new PerspectiveCamera(32, 1, 0.1, 3000);
    camera.position.set(0, 0, 30); camera.updateMatrixWorld(true);
    const scene = new Scene(), calls: string[] = [];
    let blank = false;
    const container = { clientWidth: 400, clientHeight: 560 };
    Object.assign(stage, { camera, scene, container, hostVisible: true, disposed: false,
      renderer: { setSize: () => { blank = true; calls.push('size'); }, render: (s: Scene, c: PerspectiveCamera) => {
        assert.equal(s, scene); assert.equal(c, camera); blank = false; calls.push('draw');
      } } });
    for (const [width, height] of [[400, 560], [700, 300], [220, 720]]) {
      Object.assign(container, { clientWidth: width, clientHeight: height });
      stage.resize();
      assert.equal(blank, false, 'FPS throttling must not leave a cleared transparent buffer');
      assert.deepEqual(calls.slice(-2), ['size', 'draw']);
      const origin = new Vector3(0, 0, 0).project(camera);
      const right = new Vector3(1, 0, 0).project(camera), up = new Vector3(0, 1, 0).project(camera);
      assert.ok(Math.abs((right.x - origin.x) * width - (up.y - origin.y) * height) < 1e-9, 'world unit has equal pixel size on both axes');
      assert.deepEqual(camera.position.toArray(), [0, 0, 30]);
      assert.equal(camera.fov, 32);
    }
  } finally { globalThis.document = oldDocument; }
});
