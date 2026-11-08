// 色块哨兵 (src/stage/stray-pixels.ts): where it looks, when a hit is a block, what it re-sends, and the journal line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, PerspectiveCamera, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import {
  STRAY_INTERVAL_MS, STRAY_MAX_STAYED, STRAY_MIN_PIXELS, STRAY_RETRY_MS, StrayPixelWatch, boneReach, inspectModel, isStrayHit, reachBox, resendModel,
  skinnedBones, strayStrips, type StrayCause, type StrayReport,
} from '../src/stage/stray-pixels';
import { buildJournalEntry, describeJournalEntry } from '../shared/journal';

test('her reach is her bones widened (more room above for hair), and strips sit only in wide empty gaps', () => {
  // Bones from x 0.4..0.6 and y 0.2..0.8 of a 400 x 560 buffer (NDC -0.2..0.2, -0.6..0.6).
  const box = reachBox([-0.2, -0.6, 0.2, 0.6], 400, 560)!;
  const size = 0.6 * 560; // the larger side of the bones' box: 336 px
  assert.ok(Math.abs(box.maxY - (448 + size * 0.35)) < 1e-6 && Math.abs(box.minY - (112 - size * 0.2)) < 1e-6);
  assert.ok(Math.abs(box.minX - (160 - size * 0.3)) < 1e-6 && Math.abs(box.maxX - (240 + size * 0.3)) < 1e-6);
  const strips = strayStrips(box, 400, 560);
  // Above her head the gap is too thin (448 + 118 > 560), below too (112 - 67 = 45 < 6 % of 560 = 33.6 is false: 45 is wide enough).
  // Each wide gap gets a strip halfway and one along the window edge (Codex X-278: a block only along the edge was missed).
  assert.deepEqual(strips.map(strip => strip.w === 1 ? 'column' : 'row'), ['row', 'row', 'column', 'column', 'column', 'column']);
  assert.ok(strips.some(strip => strip.w === 1 && strip.x === 399), 'one column is the outermost right pixel line');
  for (const strip of strips) assert.ok(strip.x >= 0 && strip.y >= 0 && strip.x + strip.w <= 400 && strip.y + strip.h <= 560);
  // A close-up fills the window: nowhere to look, so no strips (and no false alarms).
  assert.deepEqual(strayStrips(reachBox([-0.9, -1.5, 0.9, 1.4], 400, 560)!, 400, 560), []);
  assert.equal(reachBox([NaN, NaN, Infinity, 1], 400, 560), null);
  assert.equal(reachBox([0, 0], 0, 560), null);
});

test('a hit needs enough drawn pixels; a stray hair line of a few pixels is not one', () => {
  assert.equal(isStrayHit(STRAY_MIN_PIXELS - 1, 1000), false);
  assert.equal(isStrayHit(STRAY_MIN_PIXELS, 5000), false); // under 1 %
  assert.equal(isStrayHit(60, 1000), true);
  assert.equal(isStrayHit(0, 0), false);
});

function watch(cause: StrayCause = { part: 'gpu', name: 'gpu' }) {
  let now = 0;
  const calls = { inspect: 0, recover: [] as StrayCause[], reports: [] as StrayReport[] };
  const w = new StrayPixelWatch({ now: () => now, reach: () => null, inspect: () => { calls.inspect++; return cause; },
    recover: c => { calls.recover.push(c); }, report: r => { calls.reports.push(r); } });
  return { w, calls, advance: (ms: number) => { now += ms; } };
}

test('two hits in a row are a block: she is re-sent, and the next sample says whether it went away', () => {
  const { w, calls } = watch();
  w.sample(300, 1000);
  assert.equal(calls.recover.length, 0, 'one hit is not enough (a frame of something else)');
  w.sample(0, 1000);
  w.sample(300, 1000);
  assert.equal(calls.recover.length, 0, 'the streak restarts after a clean sample');
  w.sample(300, 1000);
  assert.deepEqual(calls.recover, [{ part: 'gpu', name: 'gpu' }]);
  assert.equal(calls.reports.length, 0, 'reported once the next sample is in');
  w.sample(0, 1000);
  assert.deepEqual(calls.reports, [{ cause: { part: 'gpu', name: 'gpu' }, drawn: 0.3, cleared: true }]);
  assert.deepEqual(w.stats, { samples: 5, hits: 3, blocks: 1, cleared: 1, stayed: 0, widen: 1, stopped: false });
});

test('a block that stays is reported once and not re-sent again until the retry time has passed', () => {
  const { w, calls, advance } = watch({ part: 'bone', name: '左髪1' });
  w.sample(500, 1000); w.sample(500, 1000); // block → re-send
  w.sample(500, 1000); // still there → reported as stayed
  assert.deepEqual(calls.reports, [{ cause: { part: 'bone', name: '左髪1' }, drawn: 0.5, cleared: false }]);
  for (let i = 0; i < 10; i++) { advance(STRAY_INTERVAL_MS); w.sample(500, 1000); }
  assert.equal(calls.recover.length, 1, 'no re-send storm while it stays');
  assert.equal(calls.reports.length, 1);
  advance(STRAY_RETRY_MS);
  w.sample(500, 1000); w.sample(500, 1000);
  assert.equal(calls.recover.length, 2, 'tried again after the retry time');
});

test('a model that really reaches past the margins (her numbers fine, a fresh copy the same): her reach widens, then the watch stops', () => {
  const { w, calls, advance } = watch({ part: 'gpu', name: 'gpu' });
  for (let round = 1; round <= STRAY_MAX_STAYED; round++) {
    w.sample(500, 1000); w.sample(500, 1000); w.sample(500, 1000); // block, re-send, still there
    assert.equal(w.stats.widen, Math.round(1.5 ** round * 1000) / 1000);
    advance(STRAY_RETRY_MS);
  }
  assert.equal(w.stats.stopped, true);
  assert.equal(calls.recover.length, STRAY_MAX_STAYED, 'a wide model is re-sent at most this many times');
  w.reset();
  assert.deepEqual([w.stats.widen, w.stats.stopped], [1, false], 'a new model starts fresh');
  // A broken bone that stays does not widen her reach (not the model's own shape), but it also stops after three stays.
  const bone = watch({ part: 'bone', name: '左髪1' });
  for (let round = 0; round < STRAY_MAX_STAYED; round++) { bone.w.sample(500, 1000); bone.w.sample(500, 1000); bone.w.sample(500, 1000); bone.advance(STRAY_RETRY_MS); }
  assert.equal(bone.w.stats.widen, 1);
  assert.equal(bone.w.stats.stopped, true);
  assert.equal(bone.calls.reports.length, STRAY_MAX_STAYED, 'reported at most three times, not every ten seconds');
});

test('widening moves the strips out past a wide part of the model, and then the re-sends stop', () => {
  let now = 0;
  const { gl, reads } = fakeGl(x => x > 330); // a wide part of the model on the right that is always there
  const canvas = { width: 400, height: 560 };
  let recovered = 0;
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.2, -0.6, 0.2, 0.3], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: () => { recovered++; }, report: () => {} });
  const frames = (count: number) => { for (let i = 0; i < count; i++) { now += 16; w.afterRender(gl, canvas); } };
  frames(40);
  const columns = () => reads.filter(read => read.w === 1).map(read => read.x);
  const firstMiddle = Math.min(...columns().filter(x => x > 200 && x < 399)); // the edge strip sits at 399
  frames(3000);
  assert.equal(w.stats.widen, 2.25, 'widened twice');
  assert.equal(recovered, 2);
  assert.ok(columns().some(x => x > firstMiddle && x < 399), 'the middle right strip moved out');
  frames(3000);
  assert.equal(recovered, 2, 'nothing outside her widened reach any more: no more re-sends');
  assert.equal(w.stats.stopped, false);
});

test('a block only along the window edge is found (Codex X-278)', () => {
  let now = 0, recovered = 0;
  const { gl } = fakeGl(x => x >= 400 - 5); // only the last 5 px on the right (Codex X-282 E01)
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.2, -0.6, 0.2, 0.3], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: () => { recovered++; }, report: () => {} });
  for (let i = 0; i < 120; i++) { now += 16; w.afterRender(gl, { width: 400, height: 560 }); }
  assert.ok(recovered >= 1);
});

test('reset (a new model) wakes a stopped watch and drops a readback that was still in flight', () => {
  let now = 0, recovered = 0, block = true;
  const { gl } = fakeGl(x => block && x > 330);
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.2, -0.6, 0.2, 0.3], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: () => { recovered++; }, report: () => {} });
  w.sample(500, 1000); w.sample(500, 1000); w.sample(500, 1000);
  now += 20_000; w.sample(500, 1000); w.sample(500, 1000); w.sample(500, 1000);
  now += 20_000; w.sample(500, 1000); w.sample(500, 1000); w.sample(500, 1000);
  assert.equal(w.stats.stopped, true);
  w.reset();
  assert.equal(w.stats.stopped, false, 'the next model is watched again');
  // A readback in flight when the model changes is dropped, not judged against the new one.
  recovered = 0;
  now += 1_000; w.afterRender(gl, { width: 400, height: 560 }); // starts a read of the old picture
  const hits = w.stats.hits;
  w.reset();
  block = false;
  for (let i = 0; i < 4; i++) { now += 16; w.afterRender(gl, { width: 400, height: 560 }); }
  assert.equal(w.stats.hits, hits, 'the old read never counted');
  assert.equal(recovered, 0);
});

/** A WebGL2 stand-in: readPixels fills the pack buffer from `drawnAt(x, y)`; fences signal on the next frame. */
function fakeGl(drawnAt: (x: number, y: number) => boolean) {
  const buffers = new Map<object, Uint8Array>();
  let bound: object | null = null, lost = false;
  const reads: { x: number; y: number; w: number; h: number }[] = [];
  const gl = {
    RGBA: 1, UNSIGNED_BYTE: 2, PIXEL_PACK_BUFFER: 3, STREAM_READ: 4, SYNC_GPU_COMMANDS_COMPLETE: 5, SYNC_STATUS: 6, SIGNALED: 7,
    createBuffer: () => ({}), deleteBuffer: (b: object) => { buffers.delete(b); },
    bindBuffer: (_t: number, b: object | null) => { bound = b; },
    bufferData: (_t: number, size: number) => { buffers.set(bound!, new Uint8Array(size)); },
    readPixels: (x: number, y: number, w: number, h: number, _f: number, _t: number, offset: number) => {
      reads.push({ x, y, w, h });
      const bytes = buffers.get(bound!)!;
      for (let row = 0; row < h; row++) for (let column = 0; column < w; column++)
        bytes[offset + (row * w + column) * 4 + 3] = drawnAt(x + column, y + row) ? 255 : 0;
    },
    fenceSync: () => ({ frames: 0 }),
    getSyncParameter: (sync: { frames: number }) => (++sync.frames > 1 ? 7 : 0),
    deleteSync: () => {},
    getBufferSubData: (_t: number, _o: number, out: Uint8Array, _d: number, length: number) => { out.set(buffers.get(bound!)!.subarray(0, length)); },
    isContextLost: () => lost,
  };
  return { gl: gl as unknown as WebGL2RenderingContext, reads, lose: () => { lost = true; } };
}

test('on the real path it reads the strips after render without waiting, and a block across the window is found and re-sent', () => {
  let block = false, now = 0;
  const { gl, reads } = fakeGl((x, y) => block && x > 200 && y > 300); // a cream block in the top right, like the screenshot
  const recovered: StrayCause[] = [], reports: StrayReport[] = [];
  const canvas = { width: 400, height: 560, dataset: {} as Record<string, string | undefined> };
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.2, -0.6, 0.2, 0.3], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: cause => { recovered.push(cause); block = false; }, report: r => reports.push(r) });
  const frames = (count: number) => { for (let i = 0; i < count; i++) { now += 16; w.afterRender(gl, canvas); } };
  frames(60);
  assert.ok(reads.length > 0 && reads.every(read => read.w === 1 || read.h === 1), 'only thin strips are read');
  assert.equal(recovered.length, 0, 'nothing outside her reach: no block');
  block = true;
  frames(120);
  assert.deepEqual(recovered, [{ part: 'gpu', name: 'gpu' }]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].cleared, true);
  assert.ok(reports[0].drawn > 0.1);
  assert.match(canvas.dataset.strayPixels!, /"blocks":1/);
});

test('a lost context stops reading; the watch survives it', () => {
  const { gl, lose, reads } = fakeGl(() => true);
  let now = 0;
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.1, -0.1, 0.1, 0.1], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: () => {}, report: () => {} });
  lose();
  for (let i = 0; i < 30; i++) { now += 50; w.afterRender(gl, { width: 400, height: 560 }); }
  assert.equal(reads.length, 0);
});

/** Three bones (root, a weighted body bone, an unweighted IK target), one triangle, one morph. */
function model() {
  const root = new Bone(), body = new Bone(), target = new Bone();
  root.name = 'センター'; body.name = '上半身'; target.name = '右足ＩＫ';
  root.add(body); root.add(target);
  body.position.set(0, 10, 0); target.position.set(0, 0, 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 10, 0, -1, 10, 0], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.morphAttributes.position = [new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 1, 0], 3)];
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new Skeleton([root, body, target]));
  mesh.updateMorphTargets();
  mesh.morphTargetDictionary = { 照れ: 0 };
  mesh.updateMatrixWorld(true);
  return { mesh, root, body, target };
}

test('her reach uses only bones her vertices follow, and leaves out a bone that has flown away', () => {
  const { mesh, body } = model();
  assert.deepEqual(skinnedBones(mesh).map(bone => bone.name), ['センター', '上半身']);
  const camera = new PerspectiveCamera(30, 400 / 560, 0.1, 1000);
  camera.position.set(0, 5, 40); camera.lookAt(0, 5, 0); camera.updateMatrixWorld(true);
  const ndc = { value: new Float32Array(0) };
  const sane = boneReach(mesh, skinnedBones(mesh), camera, 12, 400, 560, ndc)!;
  body.position.set(1e6, 1e6, 0); mesh.updateMatrixWorld(true);
  const broken = boneReach(mesh, skinnedBones(mesh), camera, 12, 400, 560, ndc)!;
  assert.ok(broken.maxX - broken.minX < sane.maxX - sane.minX + 1e-6, 'the flown bone does not widen her reach to the whole window');
});

test('inspect names a broken bone, then a broken morph weight; otherwise it is the GPU side', () => {
  const { mesh, body, target } = model();
  assert.deepEqual(inspectModel(mesh, 12), { part: 'gpu', name: 'gpu' });
  mesh.morphTargetInfluences![0] = Number.NaN;
  assert.deepEqual(inspectModel(mesh, 12), { part: 'morph', name: '照れ' });
  mesh.morphTargetInfluences![0] = 0.4;
  // A bone no vertex follows (an IK target, a physics helper) is never blamed, however far it is (I-031: a Gene cloak helper).
  target.position.set(0, 0, 1e9); mesh.updateMatrixWorld(true);
  assert.deepEqual(inspectModel(mesh, 12), { part: 'gpu', name: 'gpu' });
  // A skinned bone far past its own bind distance is.
  body.position.set(0, 10 + 12 * 2.5, 0); mesh.updateMatrixWorld(true);
  assert.deepEqual(inspectModel(mesh, 12), { part: 'bone', name: '上半身' });
  // Within its bind distance plus two heights (a raised arm, a lean) it is fine.
  body.position.set(0, 10 + 12 * 1.5, 0); mesh.updateMatrixWorld(true);
  assert.deepEqual(inspectModel(mesh, 12), { part: 'gpu', name: 'gpu' });
  body.position.set(0, 10, 0);
  target.position.set(0, 0, 2); body.scale.set(40, 40, 40); mesh.updateMatrixWorld(true);
  assert.deepEqual(inspectModel(mesh, 12), { part: 'bone', name: '上半身' });
});

test('a broken CPU copy of her geometry is named, not blamed on the GPU (Codex X-278)', () => {
  const { mesh } = model();
  assert.deepEqual(inspectModel(mesh, 12), { part: 'gpu', name: 'gpu' });
  (mesh.geometry.getAttribute('position').array as Float32Array)[4] = 100000;
  assert.deepEqual(inspectModel(mesh, 12), { part: 'geometry', name: 'geometry' });
  (mesh.geometry.getAttribute('position').array as Float32Array)[4] = 10;
  (mesh.geometry.morphAttributes.position[0].array as Float32Array)[1] = Number.NaN;
  assert.deepEqual(inspectModel(mesh, 12), { part: 'geometry', name: 'geometry' }, 'a morph offset counts too');
  // Re-sending would only copy the broken data again (Codex X-282 E02): nothing is disposed.
  let disposed = 0;
  mesh.geometry.addEventListener('dispose', () => { disposed++; });
  resendModel(mesh, { part: 'geometry', name: 'geometry' });
  assert.equal(disposed, 0);
});

test('the re-send rebuilds her GPU copies from the CPU ones and resets what was found broken', () => {
  const { mesh, body } = model();
  let disposed = 0;
  mesh.geometry.addEventListener('dispose', () => { disposed++; });
  mesh.skeleton.computeBoneTexture();
  const texture = mesh.skeleton.boneTexture!;
  let textureDisposed = 0;
  texture.addEventListener('dispose', () => { textureDisposed++; });
  mesh.morphTargetInfluences![0] = Infinity;
  resendModel(mesh, { part: 'morph', name: '照れ' });
  assert.equal(disposed, 1);
  assert.equal(textureDisposed, 1);
  assert.equal(mesh.skeleton.boneTexture, null, 'three builds a new bone texture on the next render');
  assert.equal(mesh.morphTargetInfluences![0], 0);
  assert.equal(mesh.geometry.getAttribute('position').count, 3, 'the CPU copy stays');
  body.position.set(1e9, 0, 0);
  resendModel(mesh, { part: 'bone', name: '上半身' });
  assert.ok(Math.abs(body.position.x) < 1e-6, 'the skeleton is back in its bind pose');
});

test('the journal keeps a block line with what the stage found and whether it went away, and nothing else', () => {
  const at = Date.UTC(2026, 10, 4, 21, 40, 0);
  const tr = (text: string, ...values: unknown[]) => text.replace(/\{(\d)\}/g, (_, i) => String(values[Number(i)]));
  const base = { type: 'motion', characterId: 'c1', kind: 'block', part: 'gpu', name: 'gpu', size: 0.31234, activities: ['idle'], fps: 30, frameMs: null } as const;
  const entry = buildJournalEntry({ ...base, cleared: true, text: '秘密' }, at)!;
  assert.deepEqual({ ...entry, time: undefined }, { v: 1, at, time: undefined, type: 'motion', characterId: 'c1', kind: 'block', part: 'gpu', name: 'gpu', size: 0.312,
    activities: ['idle'], fps: 30, frameMs: null, cleared: true, reason: '窗口里突然出现了一块色块' });
  assert.equal(describeJournalEntry(entry, tr).slice(6), '窗口里突然出现了一块色块：程序里的骨骼、表情和模型数据都正常，重传给显卡后消失了（待机）');
  const bone = buildJournalEntry({ ...base, part: 'bone', name: '左髪1', cleared: false }, at)!;
  assert.equal(describeJournalEntry(bone, tr).slice(6), '窗口里突然出现了一块色块：骨骼「左髪1」的数值坏了，重传给显卡后还在（待机）');
  assert.equal(buildJournalEntry({ ...base }, at), null, 'a block line says whether it went away');
  assert.equal(buildJournalEntry({ ...base, kind: 'guard', cleared: true }, at), null, 'gpu is only for blocks');
  assert.equal(buildJournalEntry({ ...base, part: 'gpu', name: '显卡', cleared: true }, at), null);
  const geometry = buildJournalEntry({ ...base, part: 'geometry', name: 'geometry', cleared: false }, at)!;
  assert.equal(describeJournalEntry(geometry, tr).slice(6), '窗口里突然出现了一块色块：程序内存里的模型数据坏了，重传给显卡后还在（待机）');
  assert.equal(buildJournalEntry({ ...base, kind: 'physics', part: 'geometry', name: 'geometry', cleared: true }, at), null, 'geometry is only for blocks');
  assert.equal(buildJournalEntry({ ...base, size: 3, cleared: true }, at), null);
  const guard = buildJournalEntry({ type: 'motion', characterId: 'c1', kind: 'guard', part: 'bone', name: '頭', size: 3, activities: [], fps: 60, frameMs: 16, cleared: true }, at)!;
  assert.equal('cleared' in guard, false, 'only block lines carry it');
});

test('on the real Gene, standing and moving, nothing is blamed: her cloak helper bones sit far out at rest and are no culprit (I-031 check)', async () => {
  const { geneStage } = await import('./helpers/gene-stage-harness');
  const h = await geneStage({ fps: 60, refreshHz: 60 });
  try {
    h.run(1.5);
    const height = (h.stage as unknown as { height: number }).height;
    assert.deepEqual(inspectModel(h.mesh, height, skinnedBones(h.mesh)), { part: 'gpu', name: 'gpu' });
    assert.deepEqual(inspectModel(h.mesh, height), { part: 'gpu', name: 'gpu' }, 'the default bone list is the skinned one too');
    // One skinned bone thrown far away is still named.
    const skinned = skinnedBones(h.mesh), arm = skinned.find(bone => bone.name === '右ひじ') ?? skinned[Math.floor(skinned.length / 2)];
    arm.position.set(0, height * 20, 0); h.mesh.updateMatrixWorld(true);
    assert.equal(inspectModel(h.mesh, height).part, 'bone');
  } finally { h.close(); }
});
