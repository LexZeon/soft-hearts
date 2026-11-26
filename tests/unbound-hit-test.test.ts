// Unbound U1: the cursor is on her → the window takes the mouse; off her → clicks go through (shared/unbound/hit-test.ts,
// src/foundation/body-capsules.ts on the bundled public Gene).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { InteractiveToggle, LEAVE_MARGIN_PX, segmentDistance, silhouetteDistance, type Capsule2D } from '../shared/unbound/hit-test';
import { capsuleDistance3D, capsuleEnds, measureBoneCapsules, projectCapsules } from '../src/foundation/body-capsules';
import { loadPublicGeneForTargets } from './public-gene-fixture';

test('distance to a segment and to the nearest capsule', () => {
  assert.equal(segmentDistance(5, 3, 0, 0, 10, 0), 3);
  assert.equal(segmentDistance(-4, 3, 0, 0, 10, 0), 5);
  assert.equal(segmentDistance(3, 4, 0, 0, 0, 0), 5, 'a point capsule is a circle');
  const capsules: Capsule2D[] = [{ ax: 0, ay: 0, bx: 0, by: 100, r: 10 }, { ax: 50, ay: 50, bx: 50, by: 50, r: 5 }];
  assert.equal(silhouetteDistance(0, 50, capsules), -10);
  assert.equal(silhouetteDistance(15, 50, capsules), 5);
  assert.equal(silhouetteDistance(50, 52, capsules), -3);
  assert.equal(silhouetteDistance(1000, 1000, []), Infinity);
});

test('click-through switches off on her, back on only past the margin, and never while a button is held', () => {
  const applied: boolean[] = [];
  const toggle = new InteractiveToggle(on => applied.push(on));
  assert.equal(toggle.pointer(20, false), false, 'outside: nothing to do');
  assert.equal(toggle.pointer(-1, false), true); assert.equal(toggle.interactive, true);
  assert.equal(toggle.pointer(-3, false), false, 'still on her: no second call');
  assert.equal(toggle.pointer(LEAVE_MARGIN_PX - 1, false), false, 'on the edge band: stays hers (no flicker)');
  assert.equal(toggle.pointer(0.5, false), false);
  assert.equal(toggle.pointer(LEAVE_MARGIN_PX + 1, true), false, 'a press that started on her stays hers');
  assert.equal(toggle.pointer(LEAVE_MARGIN_PX + 1, false), true, 'released away from her: clicks go through');
  assert.equal(toggle.pointer(0.5, false), false, 'outside the silhouette (inside the band) does not take the mouse');
  assert.equal(toggle.pointer(0, false), true);
  assert.equal(toggle.release(true), false, 'leaving the window with a button held keeps it');
  assert.equal(toggle.release(false), true);
  assert.deepEqual(applied, [true, false, true, false]);
});

test('Gene\'s capsules cover her body and nothing beside her, in the pose she moves to', async () => {
  const gene = await loadPublicGeneForTargets();
  try {
    const { mesh } = gene;
    mesh.updateMatrixWorld(true);
    const capsules = measureBoneCapsules(mesh);
    assert.ok(capsules.length >= 30, `capsules: ${capsules.length}`);
    const bone = (name: string) => mesh.skeleton.bones.find(b => b.name === name)!;
    const at = (name: string) => bone(name).getWorldPosition(new Vector3());
    let ends = capsuleEnds(mesh, capsules);
    for (const name of ['頭', '首', '上半身', '下半身', '左ひじ', '右手首', '左足', '右ひざ']) assert.ok(capsuleDistance3D(at(name), capsules, ends) <= 0, `${name} is inside her`);
    const head = at('頭');
    for (const offset of [new Vector3(8, 0, 0), new Vector3(-8, 0, 0), new Vector3(0, 6, 0), new Vector3(0, 0, 8)])
      assert.ok(capsuleDistance3D(head.clone().add(offset), capsules, ends) > 0, `beside her head ${offset.toArray()}`);
    // The capsules follow the pose: raise the left arm and the hand's new place is inside, its old place is not.
    const before = at('左手首');
    bone('左腕').rotation.z += 1.2; mesh.updateMatrixWorld(true);
    ends = capsuleEnds(mesh, capsules, ends);
    const after = at('左手首');
    assert.ok(after.distanceTo(before) > 3, 'the hand moved');
    assert.ok(capsuleDistance3D(after, capsules, ends) <= 0, 'raised hand is hers');
    assert.ok(capsuleDistance3D(before, capsules, ends) > 0, 'the air where the hand was is not');
  } finally { gene.close(); }
});

test('projected to a window, a point on her takes the mouse and the empty side of the screen does not', async () => {
  const gene = await loadPublicGeneForTargets();
  try {
    const { mesh } = gene;
    mesh.position.set(0, 0, -100); mesh.updateMatrixWorld(true);
    const capsules = measureBoneCapsules(mesh), ends = capsuleEnds(mesh, capsules);
    const camera = new PerspectiveCamera(30, 800 / 600, 1, 1000); camera.position.set(0, 10, 0); camera.updateMatrixWorld(true);
    const ppu = (ahead: number) => 600 / (2 * Math.tan(15 * Math.PI / 180) * ahead);
    const flat = projectCapsules(capsules, ends, camera, 800, 600, ppu);
    const toWindow = (p: Vector3) => { const n = p.clone().project(camera); return { x: (n.x + 1) / 2 * 800, y: (1 - n.y) / 2 * 600 }; };
    const chest = toWindow(mesh.skeleton.bones.find(b => b.name === '上半身')!.getWorldPosition(new Vector3()));
    assert.ok(silhouetteDistance(chest.x, chest.y, flat) < 0, 'her chest');
    assert.ok(silhouetteDistance(60, 60, flat) > 40, 'the top-left corner');
    assert.ok(silhouetteDistance(chest.x + 200, chest.y, flat) > 20, 'beside her');
  } finally { gene.close(); }
});
