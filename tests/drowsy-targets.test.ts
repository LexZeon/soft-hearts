import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh } from 'three';
import { resolveDrowsyTargets } from '../src/stage/drowsy-expression';

// An explicit synthetic identity port. This is not a real Gene admission claim.
function fixture() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.morphAttributes.position = Array.from({ length: 184 }, () => new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const material = new MeshBasicMaterial();
  const mesh = new SkinnedMesh(geometry, material);
  const bones = Array.from({ length: 10 }, (_, index) => {
    const bone = new Bone(); bone.name = index === 9 ? '頭' : `synthetic-${index}`; return bone;
  });
  const skeleton = new Skeleton(bones); mesh.skeleton = skeleton;
  mesh.morphTargetInfluences = Array(184).fill(0);
  mesh.morphTargetDictionary = { '困る': 68, 'じと目': 95, 'まばたき': 88, '笑い': 89 };
  return { mesh, head: bones[9], close() { geometry.dispose(); material.dispose(); skeleton.dispose(); } };
}
const approved = { head: 9, brow: 68, eye: 95 };

test('target resolution needs the strict verified flag, exact bone identity and exact head name', () => {
  const h = fixture();
  try {
    assert.deepEqual(resolveDrowsyTargets(h.mesh, h.head, true), approved);
    h.mesh.skeleton.bones[0].name = '頭';
    assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null, 'head name must be unique');
    h.mesh.skeleton.bones[0].name = 'synthetic-0';
    assert.equal(resolveDrowsyTargets(h.mesh, h.head, false), null);
    assert.equal(resolveDrowsyTargets(h.mesh, h.head, 1 as unknown as boolean), null);
    const different = new Bone(); different.name = '頭';
    assert.equal(resolveDrowsyTargets(h.mesh, different, true), null);
    h.head.name = 'head'; assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null);
    h.head.name = '頭'; h.mesh.skeleton.bones[9] = different;
    assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null);
  } finally { h.close(); }
});

test('expression and closure dictionary entries must all have their exact unique indices', () => {
  const required = [['困る', 68], ['じと目', 95], ['まばたき', 88], ['笑い', 89]] as const;
  for (const [name, index] of required) {
    const h = fixture();
    try {
      const dictionary = h.mesh.morphTargetDictionary!;
      delete dictionary[name]; assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null, `missing ${name}`);
      dictionary[name] = index + 1; assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null, `wrong ${name}`);
      dictionary[name] = index; dictionary['duplicate-target'] = index;
      assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null, `alias ${name}`);
    } finally { h.close(); }
  }
});

test('target resolution rejects short or extra influences and insufficient morph position slots', () => {
  for (const length of [0, 183, 185]) {
    const h = fixture();
    try {
      h.mesh.morphTargetInfluences = Array(length).fill(0);
      assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null);
    } finally { h.close(); }
  }
  const h = fixture();
  try {
    h.mesh.geometry.morphAttributes.position!.push(h.mesh.geometry.morphAttributes.position![0]);
    assert.deepEqual(resolveDrowsyTargets(h.mesh, h.head, true), approved, 'extra position slots are permitted');
    h.mesh.geometry.morphAttributes.position = h.mesh.geometry.morphAttributes.position!.slice(0, 183);
    assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null);
  } finally { h.close(); }
});

test('all four audited position attributes must match the actual geometry vertex count', () => {
  for (const index of [68, 95, 88, 89]) {
    const h = fixture();
    try {
      h.mesh.geometry.morphAttributes.position![index] = new Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3);
      assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null);
    } finally { h.close(); }
  }
  for (const index of [68, 95, 88, 89]) {
    const h = fixture();
    try {
      h.mesh.morphTargetInfluences![index] = NaN;
      assert.equal(resolveDrowsyTargets(h.mesh, h.head, true), null, 'audited current influence must be finite');
    } finally { h.close(); }
  }
});
