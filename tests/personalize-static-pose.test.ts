import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Bone, BufferGeometry, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { PersonalizeStaticPose } from '../src/stage/personalize-static-pose';

function fixture() {
  const root = new Bone(); root.name = 'root';
  const shoulder = new Bone(); shoulder.name = '左肩';
  const face = new Bone(); face.name = '顔';
  const mesh = new SkinnedMesh(new BufferGeometry());
  shoulder.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.08);
  mesh.add(root); root.add(shoulder, face); mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton([root, shoulder, face]));
  const rest = mesh.skeleton.bones.map(bone => ({ bone, quaternion: bone.quaternion.clone() }));
  return { mesh, shoulder, face, rest };
}

test('body overlay preserves independent face and restores the advancing base frame', () => {
  const { mesh, shoulder, face, rest } = fixture();
  const target = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
  shoulder.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.5); // Current animation is never the bind reference.
  const pose = new PersonalizeStaticPose(mesh, [{ boneIndex: 1, boneName: '左肩', quaternion: target.toArray() as [number, number, number, number] }], rest);
  const faceBefore = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.17);
  face.quaternion.copy(faceBefore);
  for (const angle of [0.1, 0.2, 0.4]) {
    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle);
    shoulder.quaternion.copy(base);
    pose.apply(0.5);
    assert.ok(shoulder.quaternion.angleTo(base) > 0.01);
    assert.ok(face.quaternion.angleTo(faceBefore) < 1e-7);
    assert.throws(() => pose.apply(0.5));
    pose.restore();
    assert.ok(shoulder.quaternion.angleTo(base) < 1e-7);
  }
  pose.restore();
  pose.apply(1);
  const bindTarget = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.08).multiply(target);
  assert.ok(shoulder.quaternion.angleTo(bindTarget) < 1e-7);
  pose.restore();
});

test('foreign bones, repeated properties and invalid strength cannot alter a target', () => {
  const { mesh, shoulder, rest } = fixture();
  const valid = { boneIndex: 1, boneName: '左肩', quaternion: [0, 0, 0, 1] as const };
  assert.throws(() => new PersonalizeStaticPose(mesh, [{ ...valid, boneName: '右肩' }], rest));
  assert.throws(() => new PersonalizeStaticPose(mesh, [valid, valid], rest));
  assert.throws(() => new PersonalizeStaticPose(mesh, [{ ...valid, quaternion: [0, 0, 0, 2] }], rest));
  assert.throws(() => new PersonalizeStaticPose(mesh, [valid], []));
  const pose = new PersonalizeStaticPose(mesh, [valid], rest);
  assert.throws(() => pose.apply(Number.NaN));
  assert.throws(() => pose.apply(1.1));
  assert.ok(Math.abs(shoulder.quaternion.w - Math.cos(0.04)) < 1e-7);
});
