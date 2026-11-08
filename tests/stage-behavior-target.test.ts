import assert from 'node:assert/strict';
import test from 'node:test';
import { SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MmdStage } from '../src/stage/MmdStage';

for (const invalidation of ['generation', 'model-url', 'disposed'] as const) {
  test(`late target support cannot attach the obsolete mesh after ${invalidation}`, async () => {
    const originalLoad = MMDLoader.prototype.load;
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let support!: (value: boolean) => void, checks = 0;
    const pending = new Promise<boolean>(resolve => { support = resolve; });
    Object.assign(globalThis, { window: { desktop: { isBehaviorModelSupported: () => { checks++; return pending; } } } });
    const loaded = new SkinnedMesh(), replacement = new SkinnedMesh(), disposed: SkinnedMesh[] = [];
    MMDLoader.prototype.load = ((_url: string, ready: (mesh: SkinnedMesh) => void) => ready(loaded)) as typeof originalLoad;
    const stage = Object.create(MmdStage.prototype) as any;
    Object.assign(stage, { modelGeneration: 0, motionGeneration: 0, modelUrl: 'mmd-asset://old/model.pmx', motionUrl: '',
      disposed: false, mesh: null, behaviorMotion: null, chatGesturePlayer: null,
      options: { onStatus() {} }, clearModel() {}, disposeMesh(mesh: SkinnedMesh) { disposed.push(mesh); } });
    try {
      const loading = stage.loadModel(stage.modelUrl);
      await Promise.resolve(); await Promise.resolve();
      assert.equal(checks, 1); assert.equal(stage.mesh, null, 'target approval remains pending');
      if (invalidation === 'generation') stage.modelGeneration++;
      else if (invalidation === 'model-url') stage.modelUrl = 'mmd-asset://new/model.pmx';
      else stage.disposed = true;
      stage.mesh = replacement;
      support(true); await loading;
      assert.deepEqual(disposed, [loaded]); assert.equal(stage.mesh, replacement);
      assert.equal(stage.behaviorMotion, null); assert.equal(stage.chatGesturePlayer, null);
    } finally {
      MMDLoader.prototype.load = originalLoad;
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
      loaded.geometry.dispose(); (loaded.material as any).dispose(); replacement.geometry.dispose(); (replacement.material as any).dispose();
    }
  });
}
