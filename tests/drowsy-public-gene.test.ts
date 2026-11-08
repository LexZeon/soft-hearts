import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDrowsyTargets } from '../src/stage/drowsy-expression';
import { loadPublicGeneForTargets } from './public-gene-fixture';

test('the pinned public Gene structure binds the new drowsy targets without textures or a renderer', async () => {
  const h = await loadPublicGeneForTargets();
  try {
    const head = h.mesh.skeleton.bones[9];
    assert.equal(head.name, '頭');
    assert.deepEqual(resolveDrowsyTargets(h.mesh, head, true), { head: 9, brow: 68, eye: 95 });
    assert.equal(resolveDrowsyTargets(h.mesh, head, false), null);
  } finally { h.close(); }
});
