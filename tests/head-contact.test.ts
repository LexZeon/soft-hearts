import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Float32BufferAttribute, PerspectiveCamera, SkinnedMesh, Skeleton } from 'three';
import { probeHeadContact, projectHeadContact } from '../src/stage/head-contact';

function fixture() {
  const geometry = new BufferGeometry(); const vertices: number[] = [];
  for (let i = 0; i < 100; i++) vertices.push(Math.sin(i * 0.2), 3.2 + Math.cos(i * 0.2) * 0.5, 0.3);
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  const head = new Bone(), left = new Bone(), right = new Bone(); left.position.set(-0.6, 2, 0.3); right.position.set(0.6, 2, 0.3); head.add(left, right);
  const mesh = new SkinnedMesh(geometry); mesh.add(head); mesh.bind(new Skeleton([head, left, right]));
  // This fixture models already skinned positions, avoiding unrelated skin attributes.
  mesh.getVertexPosition = (index, point) => point.fromBufferAttribute(geometry.getAttribute('position'), index);
  return { mesh, head, eyes: [left, right] };
}
test('scalp region begins above the eye line and reaches the sampled head top', () => {
  const { mesh, head, eyes } = fixture(); const profile = probeHeadContact(mesh, head, eyes, 20);
  assert.equal(profile.source, 'eyes-and-scalp');
  assert.ok(profile.center.y - profile.halfHeight > 2, 'lower boundary excludes the face and eyes');
  assert.ok(profile.center.y + profile.halfHeight >= 3.65, 'upper boundary includes sampled scalp');
});
test('projected ellipse follows head tilt and camera scale with independent axes', () => {
  const { mesh, head, eyes } = fixture(); const profile = probeHeadContact(mesh, head, eyes, 20);
  const camera = new PerspectiveCamera(32, 1, 0.1, 100); camera.position.set(0, 2, 10); camera.lookAt(0, 2, 0);
  const first = projectHeadContact(profile, head, camera, 400, 400)!;
  head.rotation.z = 0.3;
  const tilted = projectHeadContact(profile, head, camera, 400, 400)!;
  assert.ok(Math.abs(tilted.axisXY) > 1); assert.notEqual(tilted.x, first.x);
  camera.position.z = 5; camera.lookAt(0, 2, 0);
  const close = projectHeadContact(profile, head, camera, 400, 400)!;
  assert.ok(Math.hypot(close.axisXX, close.axisXY) > Math.hypot(tilted.axisXX, tilted.axisXY) * 1.9);
});
test('missing paired eyes use an explicit bounded upper-head estimate', () => {
  const { mesh, head } = fixture(); const profile = probeHeadContact(mesh, head, [], 20);
  assert.equal(profile.source, 'head-estimate'); assert.ok(profile.center.y - profile.halfHeight > 1);
});
test('upper side hair can define a wider scalp without extending the lower face boundary', () => {
  const { mesh, head, eyes } = fixture();
  const points: number[] = [];
  for (let index = 0; index < 120; index++) points.push(Math.sin(index) * 2.6, 3.1 + Math.cos(index) * 0.4, 0.3);
  mesh.geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  const profile = probeHeadContact(mesh, head, eyes, 20);
  assert.ok(profile.halfWidth > 2.3);
  assert.ok(profile.center.y - profile.halfHeight > 2, 'a wider top is still strictly above the eyes');
});
test('a tall scalp is measured from actual vertices rather than capped near the eye line', () => {
  const { mesh, head, eyes } = fixture(); const points: number[] = [];
  for (let index = 0; index < 120; index++) points.push(Math.sin(index) * 1.4, 4.8 + Math.cos(index) * 0.4, 0.3);
  mesh.geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  const profile = probeHeadContact(mesh, head, eyes, 20);
  assert.ok(profile.center.y + profile.halfHeight > 5.1, 'the real crown is reachable');
  assert.ok(profile.center.y - profile.halfHeight > 2, 'the lower edge still excludes the face');
});
test('B05: the pat region sits on the crown, leaving brows and forehead out', () => {
  const { mesh, head, eyes } = fixture();
  const profile = probeHeadContact(mesh, head, eyes, 20);
  // Eye line y = 2, sampled crown ~3.7 (top incl. margin ~3.84): the forehead band right above the brows is excluded.
  const eyeLine = 2, top = profile.center.y + profile.halfHeight, bottom = profile.center.y - profile.halfHeight;
  assert.ok(bottom >= eyeLine + (top - eyeLine) * 0.38, `lower edge at the hairline, not the brows (${bottom.toFixed(2)})`);
  assert.ok(profile.center.y >= eyeLine + (top - eyeLine) * 0.68, `centre toward the crown (${profile.center.y.toFixed(2)})`);
  assert.ok(profile.halfHeight > 0.3, 'still a comfortably large target');
});
