// I-031 色块诊断日志: the stage's recorder (src/stage/color-block-log.ts), the sentinel's hooks (stray-pixels.ts) and the host's
// writer (electron/color-block-log.ts). Fake GL and canvases; the host writes into a temporary folder only.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, PerspectiveCamera, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { COLOR_BLOCK_FRAME_COLUMNS, COLOR_BLOCK_IMAGE_BYTES, COLOR_BLOCK_IMAGE_PREFIX, type ColorBlockEvent, type ColorBlockNearMiss, type ColorBlockReport } from '../shared/color-block';
import { COLOR_BLOCK_SETTLE_MS, ColorBlockRecorder, inspectDetails, type ColorBlockFrameValues, type ColorBlockSnapshotCanvas } from '../src/stage/color-block-log';
import { StrayPixelWatch, reachBox, type StrayCause, type StrayDiagnostics, type StrayReport, type StraySample } from '../src/stage/stray-pixels';
import { COLOR_BLOCK_DIRECTORY_VARIABLE, COLOR_BLOCK_LIMITS, ColorBlockLog, colorBlockDirectory, createColorBlockLog, parseTasklist, validateColorBlockReport } from '../electron/color-block-log';

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

/** The 2D canvas the picture is drawn on; remembers what was drawn. */
function snapshotCanvas(url = pngUrl()) {
  const drawn: { image: unknown; w: number; h: number }[] = [];
  const canvas: ColorBlockSnapshotCanvas & { drawn: typeof drawn } = {
    width: 0, height: 0, drawn,
    getContext: () => ({ clearRect: () => {}, drawImage: (image: unknown, _x: number, _y: number, w: number, h: number) => { drawn.push({ image, w, h }); } }),
    toDataURL: () => url,
  };
  return canvas;
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

function recorder(options: { snapshot?: ReturnType<typeof snapshotCanvas> } = {}) {
  let now = 1_000;
  const sent: ColorBlockReport[] = [];
  const { mesh } = model();
  const camera = new PerspectiveCamera(30, 400 / 560, 0.1, 1000);
  camera.position.set(0, 5, 40);
  const snapshot = options.snapshot ?? snapshotCanvas();
  let frameIndex = 0, activities: ('idle' | 'pat' | 'speaking')[] = ['idle'], physics = false, over = false;
  const r = new ColorBlockRecorder({
    send: report => sent.push(report), now: () => now,
    read: (out: ColorBlockFrameValues) => { out.headYaw = frameIndex * 0.01; out.headPitch = -frameIndex * 0.01; out.eyeX = 0.2; out.eyeY = -0.1; out.pointerX = 0.5; out.pointerY = 0.25; out.pointerOver = over; },
    slow: () => ({ activities, physics }),
    scene: () => ({ mesh, height: 12, camera, fps: 30 }),
    createCanvas: () => snapshot, devicePixelRatio: () => 1.5,
  });
  const canvas = glCanvas(), gl = fakeGl(() => false);
  return {
    r, sent, mesh, canvas, gl, snapshot,
    set: (values: { activities?: typeof activities; physics?: boolean; over?: boolean }) => { activities = values.activities ?? activities; physics = values.physics ?? physics; over = values.over ?? over; },
    frames: (count: number, stepMs = 16) => { for (let i = 0; i < count; i++) { now += stepMs; frameIndex++; r.frame(now, stepMs, canvas, gl); } },
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

const hitSample = (stats?: Partial<StraySample['stats']>): StraySample => ({ drawn: 300, total: 1000, width: 400, height: 560, widen: 1,
  reach: { minX: 100, maxX: 300, minY: 50, maxY: 450 }, strips: [{ x: 399, y: 11, w: 1, h: 538, drawn: 300 }],
  stats: { samples: 10, hits: 2, blocks: 1, cleared: 0, stayed: 0, widen: 1, stopped: false, ...stats } });
const cleanSample = (): StraySample => ({ ...hitSample({ cleared: 1 }), drawn: 0, strips: [{ x: 399, y: 11, w: 1, h: 538, drawn: 0 }] });

// ------------------------------------------------------------------------------------------------ the stage's recorder

test('a block sends the last five seconds of frames from the ring, what she did, her numbers, the GPU, and two pictures of the canvas only', () => {
  const t = recorder();
  t.frames(200, 50); // 10 s at 20 fps: only the last 5 s may come along
  t.set({ activities: ['pat', 'speaking'], physics: true, over: true });
  t.frames(30, 16);
  t.canvas.fire('webglcontextlost');
  t.frames(2, 16);
  t.r.hooks.block!(hitSample(), { part: 'gpu', name: 'gpu' });
  assert.equal(t.sent.length, 0, 'sent once the sample after the re-send is in');
  t.frames(25, 16);
  t.r.hooks.settled!(cleanSample(), { cause: { part: 'gpu', name: 'gpu' }, drawn: 0.3, cleared: true });
  assert.equal(t.sent.length, 1);
  const event = t.sent[0] as ColorBlockEvent;
  assert.equal(event.kind, 'block');
  assert.deepEqual([event.cause, event.cleared], [{ part: 'gpu', name: 'gpu' }, true]);
  // Frames: every column the same length, oldest first, all within 5 s before the detection.
  const length = event.frames.atMs.length;
  for (const column of COLOR_BLOCK_FRAME_COLUMNS) assert.equal(event.frames[column].length, length, column);
  assert.ok(length > 100 && length <= 5000 / 16 + 1, `frames: ${length}`);
  assert.ok(event.frames.atMs.every((at, i, all) => at <= 0 && at >= -5000 && (i === 0 || at >= all[i - 1])));
  assert.equal(event.frames.dtMs.at(-1), 16);
  assert.ok(event.frames.dtMs.slice(0, 5).every(dt => dt === 50), 'the older 20 fps frames inside the window are there');
  assert.equal(event.frames.eyeX.at(-1), 0.2);
  assert.ok(Math.abs(event.frames.headYaw.at(-1)! - 2.32) < 1e-4, 'head yaw of the last frame before the block');
  assert.deepEqual([event.frames.pointerOver.at(-1), event.frames.physics.at(-1), event.frames.contextLost.at(-1)], [1, 1, 1]);
  assert.deepEqual([event.frames.pointerOver[0], event.frames.physics[0], event.frames.contextLost[0]], [0, 0, 0]);
  assert.deepEqual(event.activities.map(run => run.names), [['idle'], ['speaking', 'pat']]);
  // Her own numbers, the GPU and the framing.
  assert.equal(event.inspect?.bones, 3);
  assert.equal(event.inspect?.geometryBroken, false);
  assert.equal(event.inspect?.worstMorph?.name, '照れ');
  assert.equal(event.env.renderer, 'ANGLE (Test GPU Direct3D11)');
  assert.deepEqual([event.env.bufferWidth, event.env.bufferHeight, event.env.canvasWidth, event.env.canvasHeight, event.env.dpr, event.env.fov, event.env.fps, event.env.contextLost],
    [400, 560, 267, 373, 1.5, 30, 30, 1]);
  assert.ok(event.env.distance !== null && event.env.distance > 0);
  // The pictures: the 3D canvas itself, drawn small, at the block and after the re-send; nothing else is drawn.
  assert.equal(t.snapshot.drawn.length, 2);
  for (const draw of t.snapshot.drawn) { assert.equal(draw.image, t.canvas, 'only the 3D canvas'); assert.ok(draw.w <= 240); }
  assert.deepEqual(event.images, { found: pngUrl(), after: pngUrl() });
  assert.equal(event.found.strips[0].drawn, 300);
  assert.equal(event.after?.strips[0].drawn, 0);
  // What the stage sends passes the host's own check unchanged in shape.
  assert.ok(validateColorBlockReport(JSON.parse(JSON.stringify(event))));
});

test('a block without a sample after it (the model changed) still goes, without the second half; blocks closer than 10 s are skipped', () => {
  const t = recorder();
  t.frames(10);
  t.r.hooks.block!(hitSample(), { part: 'bone', name: '左髪1' });
  t.frames(Math.ceil(COLOR_BLOCK_SETTLE_MS / 16) + 2);
  assert.equal(t.sent.length, 1);
  const event = t.sent[0] as ColorBlockEvent;
  assert.deepEqual([event.cleared, event.after, event.images.after], [null, null, null]);
  t.r.hooks.block!(hitSample(), { part: 'gpu', name: 'gpu' });
  t.r.hooks.settled!(cleanSample(), { cause: { part: 'gpu', name: 'gpu' }, drawn: 0.3, cleared: true });
  assert.equal(t.sent.length, 1, 'within 10 s of the last one');
  assert.equal(t.r.stats.skipped, 1);
  t.advance(10_000);
  t.r.hooks.block!(hitSample(), { part: 'gpu', name: 'gpu' });
  t.r.hooks.settled!(cleanSample(), { cause: { part: 'gpu', name: 'gpu' }, drawn: 0.3, cleared: false });
  assert.equal(t.sent.length, 2);
});

test('a near miss is one short line of numbers (no pictures), at most one per 5 s', () => {
  const t = recorder();
  t.frames(100, 16);
  t.frames(1, 120); // one stall
  t.r.hooks.near!(hitSample());
  t.r.hooks.near!(hitSample());
  assert.equal(t.sent.length, 1);
  const near = t.sent[0] as ColorBlockNearMiss;
  assert.equal(near.kind, 'near');
  assert.deepEqual(Object.keys(near).sort(), ['activities', 'dt', 'found', 'kind', 'watch']);
  assert.equal(near.dt.slowFrames, 1);
  assert.equal(near.dt.maxMs, 120);
  assert.equal(near.dt.frames, 101);
  assert.equal(t.snapshot.drawn.length, 0, 'no picture for a near miss');
  assert.ok(validateColorBlockReport(JSON.parse(JSON.stringify(near))));
  t.advance(5_000);
  t.r.hooks.near!(hitSample());
  assert.equal(t.sent.length, 2);
});

test('her numbers at the block: the farthest bone in model heights, a scale, a broken morph weight, a broken CPU geometry', () => {
  const { mesh, body } = model();
  body.position.set(0, 120, 0); mesh.updateMatrixWorld(true);
  mesh.morphTargetInfluences![0] = Number.NaN;
  let details = inspectDetails(mesh, 12);
  assert.deepEqual(details.farthestBone, { name: '上半身', heights: 10 });
  assert.deepEqual(details.worstMorph, { name: '照れ', weight: null });
  assert.equal(details.worstScale?.scale, 1);
  body.scale.set(3, 3, 3); mesh.updateMatrixWorld(true);
  (mesh.geometry.getAttribute('position').array as Float32Array)[4] = 1e7;
  details = inspectDetails(mesh, 12);
  assert.deepEqual(details.worstScale, { name: '上半身', scale: 3 });
  assert.equal(details.geometryBroken, true);
});

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

test('end to end: the real watch path feeds the recorder, and a broken recorder snapshot never stops the report', () => {
  let now = 0, block = false;
  const gl = fakeGl((x, y) => block && x > 200 && y > 300);
  const sent: ColorBlockReport[] = [], reports: StrayReport[] = [];
  const broken: ColorBlockSnapshotCanvas = { width: 0, height: 0, getContext: () => { throw new Error('no 2d'); }, toDataURL: () => '' };
  const { mesh } = model();
  const canvas = glCanvas();
  const r = new ColorBlockRecorder({ send: report => sent.push(report), now: () => now, read: () => {}, slow: () => ({ activities: ['idle'], physics: false }),
    scene: () => ({ mesh, height: 12, camera: new PerspectiveCamera(), fps: null }), createCanvas: () => broken });
  const w = new StrayPixelWatch({ now: () => now, reach: (width, height) => reachBox([-0.2, -0.6, 0.2, 0.3], width, height),
    inspect: () => ({ part: 'gpu', name: 'gpu' }), recover: () => { block = false; }, report: report => reports.push(report), diagnostics: () => r.hooks });
  const frames = (count: number) => { for (let i = 0; i < count; i++) { now += 16; r.frame(now, 16, canvas, gl); w.afterRender(gl, canvas); } };
  frames(60); block = true; frames(120);
  assert.equal(reports.length, 1);
  assert.equal(sent.length, 1);
  const event = sent[0] as ColorBlockEvent;
  assert.deepEqual(event.images, { found: null, after: null }, 'no picture, but the record still goes');
  assert.equal(event.cleared, true);
  assert.ok(validateColorBlockReport(JSON.parse(JSON.stringify(event))));
});

// ------------------------------------------------------------------------------------------------ the host's writer

function validEvent(): ColorBlockEvent {
  const t = recorder();
  t.frames(20);
  t.r.hooks.block!(hitSample(), { part: 'gpu', name: 'gpu' });
  t.r.hooks.settled!(cleanSample(), { cause: { part: 'gpu', name: 'gpu' }, drawn: 0.3, cleared: true });
  return JSON.parse(JSON.stringify(t.sent[0]));
}
function validNear(): ColorBlockNearMiss {
  const t = recorder();
  t.frames(20);
  t.r.hooks.near!(hitSample());
  return JSON.parse(JSON.stringify(t.sent[0]));
}

test('the host takes only the closed shape: extra fields, bad numbers, unknown names and oversize or non-PNG pictures reject the whole report', () => {
  assert.ok(validateColorBlockReport(validEvent()));
  assert.ok(validateColorBlockReport(validNear()));
  const broken: [string, (e: Record<string, any>) => void][] = [
    ['extra top field', e => { e.chat = '你好'; }],
    ['extra nested field', e => { e.env.path = 'C:\\Users\\x'; }],
    ['missing field', e => { delete e.watch; }],
    ['not finite', e => { e.found.drawn = null; }],
    ['frame column too short', e => { e.frames.dtMs.pop(); }],
    ['unknown frame column', e => { e.frames.secret = [0]; }],
    ['unknown activity', e => { e.activities[0].names = ['typing-secret']; }],
    ['gpu named otherwise', e => { e.cause.name = '显卡'; }],
    ['unknown part', e => { e.cause.part = 'shader'; }],
    ['jpeg picture', e => { e.images.found = 'data:image/jpeg;base64,' + PNG.toString('base64'); }],
    ['not a png inside', e => { e.images.found = COLOR_BLOCK_IMAGE_PREFIX + Buffer.alloc(64, 1).toString('base64'); }],
    ['oversize picture', e => { e.images.after = pngUrl(Buffer.concat([PNG, Buffer.alloc(COLOR_BLOCK_IMAGE_BYTES)])); }],
    ['too many strips', e => { e.found.strips = Array.from({ length: 9 }, () => e.found.strips[0]); }],
  ];
  for (const [label, change] of broken) {
    const event = validEvent() as unknown as Record<string, any>;
    change(event);
    assert.equal(validateColorBlockReport(event), null, label);
  }
  const near = validNear() as unknown as Record<string, any>;
  near.images = { found: pngUrl(), after: null };
  assert.equal(validateColorBlockReport(near), null, 'a near miss carries no pictures');
  // Numbers are clamped, names and the GPU string are cut short and stripped of control characters.
  const event = validEvent() as unknown as Record<string, any>;
  event.env.renderer = 'A'.repeat(300) + '\n';
  event.found.widen = 5e9;
  event.inspect.farthestBone.name = '前髪\u0000' + 'x'.repeat(80);
  const checked = validateColorBlockReport(event) as Record<string, any>;
  assert.equal(checked.env.renderer.length, 200);
  assert.equal(checked.found.widen, 1000);
  assert.equal(checked.inspect.farthestBone.name, '前髪' + 'x'.repeat(38));
  assert.ok(Buffer.isBuffer(checked.images.found) && checked.images.found.equals(PNG));
});

async function folder() {
  const root = await mkdtemp(path.join(tmpdir(), 'i031-color-block-'));
  return { root, directory: path.join(root, 'soft-hearts-diagnostics', 'color-block', 'development'), cleanup: () => rm(root, { recursive: true, force: true }) };
}
function log(directory: string, clock: { now: number }) {
  return new ColorBlockLog({ directory, channel: 'development', version: '0.1.0', commit: 'abc1234', clock: () => clock.now,
    countProcesses: async () => ({ softHeartsNext: 2, electron: 1 }) });
}

test('the host writes one JSON and two pictures per block, near misses as lines, a Chinese README and the start marker', async () => {
  const { directory, cleanup } = await folder();
  try {
    const clock = { now: Date.UTC(2026, 10, 5, 1, 0, 0) };
    const writer = log(directory, clock);
    assert.equal(writer.note(7, 3, validEvent()), false, 'not the pet window');
    assert.equal(writer.note(7, null, validEvent()), false, 'no pet window');
    assert.equal(writer.note(3, 3, { ...validEvent(), extra: 1 }), false);
    assert.equal(writer.note(3, 3, validEvent()), true);
    clock.now += 1_000;
    assert.equal(writer.note(3, 3, validNear()), true);
    await writer.idle();
    const files = (await readdir(directory)).sort();
    const block = files.find(name => /^block-\d{8}-\d{6}-\d{3}\.json$/.test(name))!;
    const base = block.slice(0, -'.json'.length);
    assert.deepEqual(files, ['README.txt', `${base}-after.png`, `${base}-found.png`, block, 'near-misses.jsonl', 'started.json'].sort());
    const readme = await readFile(path.join(directory, 'README.txt'), 'utf8');
    assert.match(readme, /色块诊断日志/);
    assert.match(readme, /没有记：聊天内容/);
    assert.match(readme, /14 天/);
    const record = JSON.parse(await readFile(path.join(directory, block), 'utf8'));
    assert.deepEqual(record.app, { version: '0.1.0', commit: 'abc1234', channel: 'development' });
    assert.deepEqual(record.processes, { softHeartsNext: 2, electron: 1 });
    assert.deepEqual(record.images, { found: `${base}-found.png`, after: `${base}-after.png` });
    assert.deepEqual(Object.keys(record.frames), [...COLOR_BLOCK_FRAME_COLUMNS]);
    assert.deepEqual(Object.keys(record).sort(), ['activities', 'after', 'app', 'at', 'cause', 'cleared', 'env', 'found', 'frames', 'images', 'inspect', 'kind', 'local', 'processes', 'watch', 'what'].sort());
    assert.ok((await readFile(path.join(directory, `${base}-found.png`))).equals(PNG));
    const lines = (await readFile(path.join(directory, 'near-misses.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).kind, 'near');
    const started = JSON.parse(await readFile(path.join(directory, 'started.json'), 'utf8'));
    assert.equal(started.startedAt, new Date(Date.UTC(2026, 10, 5, 1, 0, 0)).toISOString());
    assert.deepEqual(writer.counts, { accepted: 2, rejected: 3, written: 2, skipped: 0, failed: 0 });
  } finally { await cleanup(); }
});

test('the host keeps to its caps: one block per 10 s, 50 blocks, 200 near-miss lines, 8 MB, 14 days, and a STOP file', async () => {
  const { directory, cleanup } = await folder();
  try {
    const clock = { now: Date.UTC(2026, 10, 5, 1, 0, 0) };
    const plain = validEvent() as unknown as Record<string, any>;
    plain.images = { found: null, after: null };
    let writer = log(directory, clock);
    assert.equal(writer.accept(plain), true);
    clock.now += 9_000;
    assert.equal(writer.accept(plain), false, 'closer than 10 s');
    for (let i = 0; i < COLOR_BLOCK_LIMITS.blocks + 3; i++) { clock.now += 11_000; writer.accept(plain); }
    for (let i = 0; i < COLOR_BLOCK_LIMITS.nearLines + 3; i++) { clock.now += 6_000; writer.accept(validNear()); }
    await writer.idle();
    let files = await readdir(directory);
    assert.equal(files.filter(name => name.endsWith('.json') && name.startsWith('block-')).length, COLOR_BLOCK_LIMITS.blocks);
    assert.equal((await readFile(path.join(directory, 'near-misses.jsonl'), 'utf8')).trim().split('\n').length, COLOR_BLOCK_LIMITS.nearLines);

    // 14 days after the first write nothing more is written, even by a new run.
    const late = await folder();
    try {
      clock.now = Date.UTC(2026, 10, 5, 1, 0, 0);
      writer = log(late.directory, clock);
      writer.accept(validNear()); await writer.idle();
      clock.now += COLOR_BLOCK_LIMITS.stopAfterMs - 60_000;
      writer = log(late.directory, clock);
      writer.accept(validNear()); await writer.idle();
      clock.now += 120_000;
      writer = log(late.directory, clock);
      writer.accept(validNear()); await writer.idle();
      assert.equal((await readFile(path.join(late.directory, 'near-misses.jsonl'), 'utf8')).trim().split('\n').length, 2);
      assert.equal(writer.counts.written, 0);
      // A STOP file stops it at once.
      const stop = await folder();
      try {
        writer = log(stop.directory, clock);
        await mkdir(stop.directory, { recursive: true });
        await writeFile(path.join(stop.directory, 'STOP.txt'), '');
        writer.accept(validNear()); await writer.idle();
        assert.deepEqual((await readdir(stop.directory)).sort(), ['STOP.txt']);
      } finally { await stop.cleanup(); }
    } finally { await late.cleanup(); }

    // 8 MB in all: pictures are dropped first, then nothing more fits.
    const full = await folder();
    try {
      await mkdir(full.directory, { recursive: true });
      await writeFile(path.join(full.directory, 'filler.bin'), Buffer.alloc(COLOR_BLOCK_LIMITS.totalBytes - 120 * 1024));
      clock.now = Date.UTC(2026, 10, 6, 1, 0, 0);
      writer = log(full.directory, clock);
      const big = validEvent() as unknown as Record<string, any>;
      big.images = { found: pngUrl(Buffer.concat([PNG, Buffer.alloc(150 * 1024)])), after: pngUrl() };
      writer.accept(big); await writer.idle();
      files = await readdir(full.directory);
      const block = files.find(name => name.startsWith('block-') && name.endsWith('.json'))!;
      assert.ok(block, 'the record itself still fits');
      assert.equal(files.some(name => name.endsWith('.png')), false, 'the pictures did not');
      assert.deepEqual(JSON.parse(await readFile(path.join(full.directory, block), 'utf8')).images, { found: null, after: null, dropped: 'size' });
      let used = 0;
      for (const name of await readdir(full.directory)) used += (await readFile(path.join(full.directory, name))).length;
      await writeFile(path.join(full.directory, 'filler2.bin'), Buffer.alloc(COLOR_BLOCK_LIMITS.totalBytes - used - 100));
      clock.now += 60_000;
      writer.accept(big); await writer.idle();
      assert.equal((await readdir(full.directory)).filter(name => name.startsWith('block-')).length, 1, 'nothing more past 8 MB');
    } finally { await full.cleanup(); }
  } finally { await cleanup(); }
});

test('a write that fails never reaches the pet', async () => {
  const { root, cleanup } = await folder();
  try {
    await writeFile(path.join(root, 'not-a-folder'), 'x');
    const writer = log(path.join(root, 'not-a-folder', 'color-block'), { now: Date.now() });
    assert.equal(writer.accept(validNear()), true);
    await writer.idle();
    assert.equal(writer.counts.failed, 1);
    assert.equal(new ColorBlockLog({ directory: null, channel: 'source', version: '0', commit: null }).accept(validNear()), false, 'no folder: nothing at all');
  } finally { await cleanup(); }
});

test('the installed channels write under %LOCALAPPDATA%, a source or test run only where it is told, never inside %APPDATA%; process counts are names only', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.equal(colorBlockDirectory(env, 'stable'), path.resolve('C:\\Users\\u\\AppData\\Local', 'soft-hearts-diagnostics', 'color-block', 'stable'));
  assert.equal(colorBlockDirectory(env, 'development')?.endsWith(path.join('color-block', 'development')), true);
  // A source run (a pretrial keeps the real %LOCALAPPDATA%) writes nothing unless it names its own folder.
  assert.equal(colorBlockDirectory(env, null), null);
  assert.equal(colorBlockDirectory(env, '../x'), null);
  const test = { ...env, [COLOR_BLOCK_DIRECTORY_VARIABLE]: 'C:\\temp\\run\\diagnostics' };
  assert.equal(colorBlockDirectory(test, null), path.resolve('C:\\temp\\run\\diagnostics', 'color-block', 'source'));
  assert.equal(colorBlockDirectory(test, 'stable'), path.resolve('C:\\temp\\run\\diagnostics', 'color-block', 'stable'));
  assert.equal(colorBlockDirectory({ ...env, [COLOR_BLOCK_DIRECTORY_VARIABLE]: 'relative' }, null), null);
  assert.equal(colorBlockDirectory({ ...env, [COLOR_BLOCK_DIRECTORY_VARIABLE]: 'C:\\Users\\u\\AppData\\Roaming\\soft-hearts-claude' }, null), null);
  assert.equal(colorBlockDirectory({ ...env, LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Roaming\\x' }, 'stable'), null);
  assert.equal(colorBlockDirectory({ APPDATA: env.APPDATA }, 'stable'), null);
  assert.equal(colorBlockDirectory({ LOCALAPPDATA: 'relative' }, 'stable'), null);
  assert.equal(createColorBlockLog({ channel: 'stable', version: '1', commit: null, env: {} }).accept(validNear()), false);
  assert.equal(createColorBlockLog({ channel: null, version: '1', commit: null, env }).accept(validNear()), false, 'a source run without a folder writes nothing');
  const output = ['"soft hearts next.exe","100","Console","1","200,000 K"', '"SOFT HEARTS NEXT.EXE","101","Console","1","1 K"', '"electron.exe","5","Console","1","1 K"',
    '"soft hearts next.exe.bak","6","Console","1","1 K"', '"explorer.exe","7","Console","1","1 K"', ''].join('\r\n');
  assert.deepEqual(parseTasklist(output), { softHeartsNext: 2, electron: 1 });
});
