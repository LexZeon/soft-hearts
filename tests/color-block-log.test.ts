// I-031 色块诊断日志: the stage's recorder (src/stage/color-block-log.ts), the sentinel's hooks (stray-pixels.ts) and the host's
// writer (electron/mood/color-block-log.ts). Fake GL and canvases; the host writes into a temporary folder only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { COLOR_BLOCK_IMAGE_PREFIX } from '../shared/stage/color-block';
import { StrayPixelWatch, reachBox, type StrayCause, type StrayDiagnostics, type StrayReport, type StraySample } from '../src/stage/stray-pixels';

// ------------------------------------------------------------------------------------------------ fakes

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const pngUrl = (bytes: Buffer = PNG) => COLOR_BLOCK_IMAGE_PREFIX + bytes.toString('base64');

/** A WebGL2 stand-in: readPixels fills the pack buffer from `drawnAt(x, y)`; fences signal on the next frame. */
function fakeGl(drawnAt: (x: number, y: number) => boolean) {
  const buffers = new Map<object, Uint8Array>();
  let bound: object | null = null;
  const gl = {
    RGBA: 1, UNSIGNED_BYTE: 2, PIXEL_PACK_BUFFER: 3, STREAM_READ: 4, SYNC_GPU_COMMANDS_COMPLETE: 5, SYNC_STATUS: 6, SIGNALED: 7, RENDERER: 8, VENDOR: 9,
    drawingBufferWidth: 400, drawingBufferHeight: 560,
    createBuffer: () => ({}), deleteBuffer: (b: object) => { buffers.delete(b); },
    bindBuffer: (_t: number, b: object | null) => { bound = b; },
    bufferData: (_t: number, size: number) => { buffers.set(bound!, new Uint8Array(size)); },
    readPixels: (x: number, y: number, w: number, h: number, _f: number, _t: number, offset: number) => {
      const bytes = buffers.get(bound!)!;
      for (let row = 0; row < h; row++) for (let column = 0; column < w; column++)
        bytes[offset + (row * w + column) * 4 + 3] = drawnAt(x + column, y + row) ? 255 : 0;
    },
    fenceSync: () => ({ frames: 0 }),
    getSyncParameter: (sync: { frames: number }) => (++sync.frames > 1 ? 7 : 0),
    deleteSync: () => {},
    getBufferSubData: (_t: number, _o: number, out: Uint8Array, _d: number, length: number) => { out.set(buffers.get(bound!)!.subarray(0, length)); },
    isContextLost: () => false,
    getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 100, UNMASKED_VENDOR_WEBGL: 101 } : null,
    getParameter: (key: number) => key === 100 ? 'ANGLE (Test GPU Direct3D11)' : key === 101 ? 'Test Vendor' : 'masked',
  };
  return gl as unknown as WebGL2RenderingContext;
}

/** The 3D canvas: only its identity, size and listeners matter. */
function glCanvas() {
  const listeners = new Map<string, (() => void)[]>();
  return { width: 400, height: 560, clientWidth: 267, clientHeight: 373, dataset: {} as Record<string, string | undefined>,
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    fire: (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); } };
}

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

const hitSample = (stats?: Partial<StraySample['stats']>): StraySample => ({ drawn: 300, total: 1000, width: 400, height: 560, widen: 1,
  reach: { minX: 100, maxX: 300, minY: 50, maxY: 450 }, strips: [{ x: 399, y: 11, w: 1, h: 538, drawn: 300 }],
  stats: { samples: 10, hits: 2, blocks: 1, cleared: 0, stayed: 0, widen: 1, stopped: false, ...stats } });
const cleanSample = (): StraySample => ({ ...hitSample({ cleared: 1 }), drawn: 0, strips: [{ x: 399, y: 11, w: 1, h: 538, drawn: 0 }] });

// ------------------------------------------------------------------------------------------------ the sentinel's hooks

function runWatch(diagnostics: (() => StrayDiagnostics | null | undefined) | undefined) {
  let now = 0, block = false;
  const gl = fakeGl((x, y) => block && x > 200 && y > 300);
  const recovered: StrayCause[] = [], reports: StrayReport[] = [];
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.2, -0.6, 0.2, 0.3], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: cause => { recovered.push(cause); block = false; }, report: r => reports.push(r), diagnostics });
  const frames = (count: number) => { for (let i = 0; i < count; i++) { now += 16; w.afterRender(gl, { width: 400, height: 560 }); } };
  frames(60);
  block = true; frames(120); // a block, re-sent and gone
  w.sample(300, 1000); w.sample(0, 1000); // a near miss
  block = true; now += 20_000; frames(120);
  return { recovered, reports, stats: { ...w.stats } };
}

test('the sentinel tells the diagnostics about the block (which strips hit), the sample after it, and a near miss', () => {
  const seen = { block: [] as StraySample[], settled: [] as StraySample[], near: [] as StraySample[] };
  runWatch(() => ({ block: sample => seen.block.push(sample), settled: sample => seen.settled.push(sample), near: sample => seen.near.push(sample) }));
  assert.equal(seen.block.length, 2);
  assert.equal(seen.settled.length, 2);
  assert.equal(seen.near.length, 1);
  const found = seen.block[0];
  assert.ok(found.strips.length > 0 && found.strips.some(strip => strip.drawn > 0) && found.strips.some(strip => strip.drawn === 0), 'per strip: the hit ones and the clean ones');
  assert.equal(found.strips.reduce((sum, strip) => sum + strip.drawn, 0), found.drawn, 'the strips add up to the sample');
  assert.ok(found.reach && found.width === 400 && found.height === 560);
  assert.equal(seen.settled[0].drawn, 0, 'gone after the re-send');
  assert.equal(seen.near[0].drawn, 300);
});

test('the sentinel behaves exactly the same when the diagnostics throw (or are missing)', () => {
  const plain = runWatch(undefined);
  const boom = () => { throw new Error('diagnostics broke'); };
  const throwing = runWatch(() => ({ block: boom, settled: boom, near: boom }));
  const getterThrows = runWatch(boom);
  for (const run of [throwing, getterThrows]) {
    assert.deepEqual(run.recovered, plain.recovered);
    assert.deepEqual(run.reports, plain.reports);
    assert.deepEqual(run.stats, plain.stats);
  }
  assert.equal(plain.recovered.length, 2);
});

async function folder() {
  const root = await mkdtemp(path.join(tmpdir(), 'i031-color-block-'));
  return { root, directory: path.join(root, 'soft-hearts-diagnostics', 'color-block', 'development'), cleanup: () => rm(root, { recursive: true, force: true }) };
}
