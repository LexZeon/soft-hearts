// docs/claude/2026-11-20-mumi-brow-clip.md: a material swapped in for another (the painted blush's and the tears' clone of the face
// skin) keeps the other's place in the draw order, and every renderer in src/ sorts its opaque list by that place. Without it the
// face skin moved behind the brows, eye lines and hair, and their see-through texels cut holes into the face (the desktop showed
// through above her eyes, and her eyeballs through her closed lids).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshBasicMaterial, type Bone, type Material, type SkinnedMesh } from 'three';
import { drawPlace, fileOrderOpaqueSort, fileOrderRenderer, keepDrawPlace, type SortableRenderItem } from '../src/foundation/draw-order';
import { ProceduralBlush, probeBlushAnchors } from '../src/stage/procedural-blush';
import { ProceduralTears } from '../src/mood/procedural-tears';
import { loadPublicGeneForTargets } from './public-gene-fixture';

/** Three r170's painterSortStable, as the renderer sorts its opaque list when nobody set another sort. */
function threeDefaultSort(a: SortableRenderItem, b: SortableRenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

/** The opaque render items of one multi-material mesh, as three's render list holds them (same object, same z). */
function items(mesh: SkinnedMesh): (SortableRenderItem & { index: number })[] {
  const materials = mesh.material as Material[];
  return mesh.geometry.groups.map((group, index) => ({ groupOrder: 0, renderOrder: mesh.renderOrder, material: materials[group.materialIndex!], z: 0, id: mesh.id, index }));
}
const drawn = (mesh: SkinnedMesh, sort: (a: SortableRenderItem, b: SortableRenderItem) => number) =>
  [...items(mesh)].sort(sort).map(item => item.index);
const fileOrder = (mesh: SkinnedMesh) => mesh.geometry.groups.map((_, index) => index);

async function geneWithBlush() {
  const gene = await loadPublicGeneForTargets();
  const mesh = gene.mesh as SkinnedMesh, bone = (name: string) => mesh.skeleton.bones.find(b => b.name === name) as Bone;
  const probe = probeBlushAnchors(mesh, bone('頭'), [bone('左目'), bone('右目')]);
  assert.equal(probe.supported, true, probe.reason);
  return { gene, mesh, head: bone('頭'), anchors: probe.anchors! };
}

test('public Gene: with the painted blush on, her materials are still drawn in file order', async () => {
  const { gene, mesh, head, anchors } = await geneWithBlush();
  try {
    assert.deepEqual(drawn(mesh, fileOrderOpaqueSort), fileOrder(mesh), 'as loaded');
    const before = mesh.material as Material[];
    const blush = new ProceduralBlush(head, anchors, mesh);
    const face = anchors.materialIndices[0], now = mesh.material as Material[];
    assert.notEqual(now[face], before[face], 'the blush draws her face with a clone');
    // Three's own sort draws the clone (a newer id) after every other material: the bug.
    assert.notDeepEqual(drawn(mesh, threeDefaultSort), fileOrder(mesh));
    assert.equal(drawn(mesh, threeDefaultSort).at(-1), mesh.geometry.groups.findIndex(group => group.materialIndex === face));
    // The stage's sort keeps the clone where the face skin was.
    assert.equal(drawPlace(now[face]), before[face].id);
    assert.deepEqual(drawn(mesh, fileOrderOpaqueSort), fileOrder(mesh));
    // The tears clone the blush's clone: still the same place.
    const tears = new ProceduralTears(head, anchors, mesh, true);
    assert.equal(tears.getState().supported, true, tears.getState().reason);
    assert.notEqual((mesh.material as Material[])[face], now[face]);
    assert.deepEqual(drawn(mesh, fileOrderOpaqueSort), fileOrder(mesh));
    tears.dispose(); blush.dispose();
    assert.deepEqual(drawn(mesh, fileOrderOpaqueSort), fileOrder(mesh), 'after both are taken off');
  } finally { gene.close(); }
});

test('the sort is three\'s own where no material stands in for another', () => {
  const materials = Array.from({ length: 6 }, () => new MeshBasicMaterial());
  const list: SortableRenderItem[] = [];
  for (let k = 0; k < 60; k++) list.push({ groupOrder: k % 2, renderOrder: (k * 7) % 3, material: materials[(k * 5) % 6], z: (k * 13) % 4, id: (k * 3) % 5 });
  assert.deepEqual([...list].sort(fileOrderOpaqueSort), [...list].sort(threeDefaultSort));
  // A stand-in for a stand-in keeps the first place; standing in for itself changes nothing.
  const [a, b, c] = materials;
  keepDrawPlace(b, a); keepDrawPlace(c, b); keepDrawPlace(a, a);
  assert.equal(drawPlace(c), a.id); assert.equal(drawPlace(a), a.id);
  materials.forEach(material => material.dispose());
});

test('fileOrderRenderer sets the opaque sort and returns the renderer', () => {
  let given: unknown = null;
  const renderer = { setOpaqueSort(sort: unknown) { given = sort; } };
  assert.equal(fileOrderRenderer(renderer as never), renderer);
  assert.equal(given, fileOrderOpaqueSort);
});

// The old stage (src/stage/MmdStage.ts) was left out of this list on purpose until it was deleted (I-176 step 3): nothing is excepted now.
test('every WebGLRenderer in src/ is made through fileOrderRenderer', () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (/\.tsx?$/.test(entry.name)) files.push(full);
  } };
  walk('src');
  const made = files.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(line => line.includes('new WebGLRenderer(')).map(line => ({ file, line })));
  assert.ok(made.length >= 4, `found ${made.length}`);
  assert.ok(made.some(({ file }) => file.replace(/\\/g, '/') === 'src/unbound/window-mode/window-stage.ts'), 'the companion window\'s Unbound engine');
  for (const { file, line } of made) assert.match(line, /fileOrderRenderer\(new WebGLRenderer\(/, `${file}: ${line.trim()}`);
});
