/**
 * I-135 认出"不是你": the host, its storage, the worker protocol and the frame sources, with fakes only (no model, no camera,
 * no Electron, no network). Temporary folders only.
 *
 * What it pins (privacy and consent first): with the switch off or the camera off nothing is forked, grabbed or checked;
 * the download starts only from the user's switch; enrolment needs the camera and secure storage, stores numbers encrypted
 * (never in the clear, never without encryption) and a one-click delete removes them; two clear lows give the stranger line
 * and a match takes it away; the journal and the view carry counts and enums only; the worker's messages are checked key by
 * key; the worker refuses swapped model files; the pose sensor's tap copies one frame and only while sensing runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FACE_STRANGER_LINE, parseFaceCheckView, type FaceCheckCounts, type FaceCheckView } from '../shared/senses/face-check';
import { FaceCheckHost, type FaceDataPort, type FaceFrame, type FaceWorkerHandle } from '../electron/senses/face/host';
import { createFaceFrameSource, bgraToRgba, fitFaceFrame } from '../electron/senses/face/frames';
import type { EnrolledFace } from '../electron/senses/face/enrolment';
import { FaceDataStore } from '../electron/senses/face/store';
import { parseFaceHostMessage, parseFaceWorkerMessage, type FaceHostToWorker } from '../electron/senses/face/protocol';
import { startFaceWorker } from '../electron/senses/face/worker';
import { FACE_MODEL_DOWNLOAD_BYTES, FACE_MODEL_PINS, FACE_ARCHIVES } from '../electron/senses/face/manifest';
import { FACE_KNOBS } from '../electron/senses/face/knobs';
import { cosine, l2normalize } from '../electron/senses/face/score';
import { parseWorkerMessage } from '../electron/senses/pose/protocol';
import { PoseSupervisor } from '../electron/senses/pose/supervisor';

/** A seeded random unit vector (mulberry32 + Box-Muller): different seeds are nearly orthogonal, like two different people. */
const unit = (seed: number) => { let a = seed * 2654435761 >>> 0; const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return l2normalize(Array.from({ length: 128 }, () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()))); };
const mix = (a: Float32Array, b: Float32Array, t: number) => l2normalize(a.map((v, i) => v * (1 - t) + b[i] * t));
const ME = unit(1), STRANGER = unit(50);
const FRAME: FaceFrame = { width: 32, height: 24, rgba: new Uint8Array(32 * 24 * 4) };

interface Analysis { found: boolean; embedding: Float32Array | null; frontal?: number; sharpness?: number }
const faceOf = (embedding: Float32Array | null, extra: Partial<Analysis> = {}): Analysis => ({ found: !!embedding, embedding, ...extra });

/** A fake worker process: answers init with ready and each analyze with the next scripted analysis. */
function fakeWorkers(script: () => Analysis) {
  const forks: { sent: FaceHostToWorker[]; handle: FaceWorkerHandle }[] = [];
  const fork = (): FaceWorkerHandle => {
    let listener: (message: unknown) => void = () => undefined, exit: (code: number) => void = () => undefined;
    const sent: FaceHostToWorker[] = [];
    const handle: FaceWorkerHandle = {
      postMessage: message => {
        sent.push(message);
        if (message.type === 'init') queueMicrotask(() => listener({ type: 'ready', loadMs: 5 }));
        else if (message.type === 'analyze') {
          const a = script();
          queueMicrotask(() => listener({ type: 'result', id: message.id, found: a.found, detScore: a.found ? 0.97 : 0, faceWidth: a.found ? 90 : 0,
            frontal: a.found ? a.frontal ?? 0.95 : 0, sharpness: a.found ? a.sharpness ?? 120 : 0, brightness: a.found ? 130 : 0,
            embedding: a.embedding ? Array.from(a.embedding) : null, ms: 3 }));
        } else if (message.type === 'stop') queueMicrotask(() => exit(0));
      },
      onMessage: l => { listener = l; }, onExit: l => { exit = l; }, kill: () => exit(1),
    };
    forks.push({ sent, handle });
    return handle;
  };
  return { fork, forks };
}

function fakeStore(installed = true) {
  const store = {
    installed, working: false, downloadBytes: 160_000_000, installedBytes: installed ? 120_000_000 : 0, installs: 0,
    refresh: async () => store.installed,
    installedDir: () => store.installed ? 'C:\\c\\face\\face-v1\\win32-arm64' : null,
    installedFile: (to: string) => store.installed ? `C:\\c\\face\\face-v1\\win32-arm64\\${to.replaceAll('/', '\\')}` : null,
    install: async () => { store.installs++; store.installed = true; store.installedBytes = 120_000_000; },
    remove: async () => { store.installed = false; store.installedBytes = 0; },
    importFiles: async () => ({ accepted: 2, rejected: 0, complete: true }),
  };
  return store;
}

function memoryData(encryption = true, initial: { enabled: boolean; faces: EnrolledFace[] } = { enabled: false, faces: [] }) {
  const data = { saved: [] as { enabled: boolean; faces: EnrolledFace[] }[], current: initial, deleted: 0 };
  const port: FaceDataPort = {
    get encryptionAvailable() { return encryption; },
    load: async () => data.current,
    save: async value => { if (value.faces.length && !encryption) throw new Error('no encryption'); data.current = value; data.saved.push(value); },
    deleteAll: async () => { data.deleted++; data.current = { enabled: false, faces: [] }; },
  };
  return { data, port };
}

/** Manual clock and timers: ticks run only when the test advances time. */
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function manualTime() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  let id = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    setInterval: (fn: () => void, ms: number) => { timers.set(++id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (handle: unknown) => { timers.delete(handle as number); },
    get pending() { return timers.size; },
    async advance(ms: number) {
      const end = now + ms;
      await flush(); // let work already started register its timers first
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, timer] = next;
        now = timer.at;
        if (timer.every) timer.at += timer.every; else timers.delete(key);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

function setup(options: { enabled?: boolean; faces?: EnrolledFace[]; camera?: boolean; installed?: boolean; encryption?: boolean; script?: () => Analysis } = {}) {
  const time = manualTime();
  let script = options.script ?? (() => faceOf(ME));
  const workers = fakeWorkers(() => script());
  const store = fakeStore(options.installed ?? true);
  const { data, port } = memoryData(options.encryption ?? true, { enabled: options.enabled ?? false, faces: options.faces ?? [] });
  const camera = { on: options.camera ?? false, grabs: 0 };
  const views: FaceCheckView[] = [];
  const journal: FaceCheckCounts[] = [];
  const host = new FaceCheckHost({
    store: store as never, data: port, fork: workers.fork, publish: view => views.push(view), journal: counts => journal.push(counts),
    frames: { cameraOn: () => camera.on, grab: async () => { camera.grabs++; return camera.on ? FRAME : null; } },
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, setInterval: time.setInterval, clearInterval: time.clearInterval,
  });
  return { host, time, workers, store, data, camera, views, journal, setScript: (next: () => Analysis) => { script = next; } };
}

const enrolled = (): EnrolledFace[] => [0, 1, 2].map(i => ({ vector: mix(ME, unit(200 + i), 0.05), source: 'enrol' as const, at: 0 }));

test('switch off or camera off: nothing is forked, grabbed or checked, and the verdict is "you"', async () => {
  for (const options of [{ enabled: false, camera: true }, { enabled: true, camera: false }, { enabled: true, camera: true, faces: [] as EnrolledFace[] }]) {
    const t = setup({ faces: enrolled(), ...options });
    await t.host.init();
    await t.time.advance(60_000);
    assert.equal(t.workers.forks.length, 0, JSON.stringify(options));
    assert.equal(t.camera.grabs, 0);
    assert.equal(t.host.state(), 'you');
    assert.equal(t.host.strangerLine(), null);
    assert.equal(t.views.at(-1)!.active, false, 'no light');
    assert.equal(await t.host.checkFrame(FRAME), 'you', 'a photo check does nothing either');
    assert.equal(t.workers.forks.length, 0);
    assert.equal(t.time.pending, 0, 'no timer left running');
  }
});

test('on + camera on + enrolled: low-rate checks; two clear lows give the stranger line; a match takes it away', async () => {
  const t = setup({ enabled: true, camera: true, faces: enrolled() });
  const changes: string[] = [];
  t.host.onChange(state => changes.push(state));
  await t.host.init();
  assert.equal(t.views.at(-1)!.active, true, 'the small light is on');
  await t.time.advance(10_000);
  assert.equal(t.workers.forks.length, 1);
  const analyses = () => t.workers.forks[0].sent.filter(m => m.type === 'analyze').length;
  const first = analyses();
  assert.ok(first >= 3 && first <= 5, `about one check every 2.5 s, got ${first} in 10 s`);
  assert.equal(t.host.state(), 'you');
  t.setScript(() => faceOf(STRANGER));
  await t.time.advance(FACE_KNOBS.schedule.continuousMs);
  assert.equal(t.host.state(), 'you', 'one clear low is not enough');
  await t.time.advance(FACE_KNOBS.schedule.continuousMs);
  assert.equal(t.host.state(), 'not-you');
  assert.equal(t.host.strangerLine(), FACE_STRANGER_LINE);
  assert.equal(FACE_STRANGER_LINE, '现在坐在电脑前的不是他。你不认识这个人。');
  t.setScript(() => faceOf(ME));
  await t.time.advance(FACE_KNOBS.schedule.continuousMs);
  assert.equal(t.host.state(), 'you');
  assert.equal(t.host.strangerLine(), null);
  assert.deepEqual(changes, ['not-you', 'you']);
  // Camera off: checks stop at once, the worker is asked to stop, the light goes out.
  t.camera.on = false; t.host.cameraChanged();
  const stopped = analyses();
  await t.time.advance(30_000);
  assert.equal(analyses(), stopped);
  assert.ok(t.workers.forks[0].sent.some(m => m.type === 'stop'));
  assert.equal(t.views.at(-1)!.active, false);
});

test('拿不准就当是你: a stranger turning sideways or leaving the frame brings "you" back after two doubts, not one', async () => {
  const t = setup({ enabled: true, camera: true, faces: enrolled(), script: () => faceOf(STRANGER) });
  await t.host.init();
  await t.time.advance(8_000);
  assert.equal(t.host.state(), 'not-you');
  t.setScript(() => faceOf(STRANGER, { frontal: 0.3 }));
  await t.time.advance(FACE_KNOBS.schedule.continuousMs);
  assert.equal(t.host.state(), 'not-you');
  await t.time.advance(FACE_KNOBS.schedule.continuousMs);
  assert.equal(t.host.state(), 'you');
  // Feature off while "not you": back to "you" at once.
  t.setScript(() => faceOf(STRANGER));
  await t.time.advance(8_000);
  assert.equal(t.host.state(), 'not-you');
  await t.host.setEnabled(false);
  assert.equal(t.host.state(), 'you');
});

test('a photo about to be sent is checked once, within the time limit', async () => {
  const t = setup({ enabled: true, camera: true, faces: enrolled(), script: () => faceOf(STRANGER) });
  await t.host.init();
  await t.time.advance(1_000); // one scheduled clear low
  assert.equal(t.host.state(), 'you');
  const verdict = t.host.checkFrame(FRAME);
  await t.time.advance(10);
  assert.equal(await verdict, 'not-you', 'the photo was the second clear low');
});

test('the journal gets counts only, and the view only enums and counts', async () => {
  const t = setup({ enabled: true, camera: true, faces: enrolled(), script: () => faceOf(STRANGER) });
  await t.host.init();
  await t.time.advance(8_000);
  t.setScript(() => faceOf(null));
  await t.time.advance(8_000);
  t.camera.on = false; t.host.cameraChanged();
  assert.ok(t.journal.length >= 1);
  const total = t.journal.reduce((sum, c) => ({ matched: sum.matched + c.matched, notYou: sum.notYou + c.notYou, unsure: sum.unsure + c.unsure,
    skipped: sum.skipped + c.skipped, stranger: sum.stranger + c.stranger }), { matched: 0, notYou: 0, unsure: 0, skipped: 0, stranger: 0 });
  assert.ok(total.notYou >= 2 && total.stranger === 1 && total.unsure >= 1);
  for (const counts of t.journal) {
    assert.deepEqual(Object.keys(counts).sort(), ['matched', 'notYou', 'skipped', 'stranger', 'unsure']);
    assert.ok(Object.values(counts).every(n => Number.isInteger(n) && n >= 0));
  }
  for (const view of t.views) {
    assert.ok(parseFaceCheckView(view), JSON.stringify(view));
    assert.doesNotMatch(JSON.stringify(view), /\\|\/|embedding|score|similar/i);
  }
});

test('consent: nothing downloads until the user turns the switch on; cancel turns it off again', async () => {
  const t = setup({ installed: false });
  await t.host.init();
  await t.host.download();
  assert.equal(t.store.installs, 0, 'the retry button does nothing while the switch is off');
  assert.equal(t.views.at(-1)!.phase, 'not-installed');
  await t.host.setEnabled(true);
  await t.time.advance(10);
  assert.equal(t.store.installs, 1, 'turning it on is the click that downloads');
  assert.equal(t.data.saved.at(-1)!.enabled, true);
  assert.equal(t.workers.forks.length, 0, 'nothing runs without a camera and an enrolled face');
  await assert.rejects(t.host.setEnabled('yes' as never));
});

test('enrolment: needs the camera and secure storage; keeps 3–5 clear samples of one face, encrypted; delete removes them', async () => {
  const noCamera = setup({ enabled: true });
  await noCamera.host.init();
  const tryNoCamera = noCamera.host.enrol();
  await noCamera.time.advance(FACE_KNOBS.enrol.timeoutMs + 2_000);
  assert.equal((await tryNoCamera).notice, 'enrol-needs-camera');
  assert.equal(noCamera.data.saved.length, 0);
  assert.equal(noCamera.camera.grabs, 0, 'no frame asked for');
  assert.equal(noCamera.workers.forks.length, 0, 'nothing started');

  const noCrypto = setup({ enabled: true, camera: true, encryption: false });
  await noCrypto.host.init();
  const tryNoCrypto = noCrypto.host.enrol();
  await noCrypto.time.advance(FACE_KNOBS.enrol.timeoutMs + 2_000);
  assert.equal((await tryNoCrypto).notice, 'no-encryption');
  assert.equal(noCrypto.workers.forks.length, 0, 'not even started');
  assert.equal(noCrypto.camera.grabs, 0);

  let n = 0;
  const t = setup({ enabled: true, camera: true, script: () => faceOf(mix(ME, unit(300 + n++), 0.35)) });
  await t.host.init();
  const run = t.host.enrol();
  await t.time.advance(10);
  assert.equal(t.views.at(-1)!.active, true, 'the light is on while enrolling');
  await t.time.advance(FACE_KNOBS.enrol.timeoutMs + 2_000);
  const view = await run;
  assert.equal(view.notice, 'enrolled');
  assert.equal(view.enrolled, FACE_KNOBS.enrol.samples);
  assert.equal(view.enrolling, null);
  const saved = t.data.saved.at(-1)!;
  assert.equal(saved.faces.length, FACE_KNOBS.enrol.samples);
  assert.ok(saved.faces.every(face => face.source === 'enrol' && cosine(face.vector, ME) > 0.7));
  // Now checking runs; then one-click delete: off, nothing enrolled, verdict "you".
  await t.time.advance(5_000);
  const deleted = await t.host.deleteData();
  assert.equal(deleted.notice, 'deleted');
  assert.equal(deleted.enabled, false);
  assert.equal(deleted.enrolled, 0);
  assert.equal(t.data.deleted, 1);

  // Someone else stepping in during enrolment, or a blurry camera: nothing is stored.
  const blurry = setup({ enabled: true, camera: true, script: () => faceOf(ME, { sharpness: 3 }) });
  await blurry.host.init();
  const failed = blurry.host.enrol();
  await blurry.time.advance(FACE_KNOBS.enrol.timeoutMs + 2_000);
  assert.equal((await failed).notice, 'enrol-failed');
  assert.equal(blurry.data.saved.length, 0);
});

test('auto-augment adds a confident new look at most every 10 minutes and never past the cap', async () => {
  const look = mix(ME, STRANGER, 0.45);
  const t = setup({ enabled: true, camera: true, faces: [{ vector: ME, source: 'enrol', at: 0 }], script: () => faceOf(look) });
  await t.host.init();
  await t.time.advance(20_000);
  assert.equal(t.host.enrolledCount, 2, 'one added');
  await t.time.advance(5 * 60_000);
  assert.equal(t.host.enrolledCount, 2, 'not again within 10 minutes (and the same look again adds nothing)');
  assert.ok(t.data.saved.at(-1)!.faces.some(face => face.source === 'auto'));
});

test('storage: encrypted with the system storage, never in the clear, nothing without encryption; delete removes the file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-face-store-'));
  try {
    const secret = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s, 'utf8').map(b => b ^ 0x5a) as Buffer,
      decryptString: (b: Buffer) => Buffer.from(b.map(x => x ^ 0x5a)).toString('utf8') };
    const store = new FaceDataStore(dir, secret);
    assert.deepEqual(await store.load(), { enabled: false, faces: [] }, 'nothing saved: off');
    const faces: EnrolledFace[] = [{ vector: ME, source: 'enrol', at: 1 }, { vector: unit(9), source: 'auto', at: 2 }];
    await store.save({ enabled: true, faces });
    const text = await readFile(store.file, 'utf8');
    assert.match(text, /"enabled":true/);
    const plainVector = Buffer.from(ME.buffer).toString('base64');
    assert.ok(!text.includes(plainVector.slice(0, 40)), 'the numbers are not in the clear');
    assert.doesNotMatch(text, /enrol|auto|0\.\d{4}/);
    const loaded = await store.load();
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.faces.length, 2);
    assert.deepEqual(Array.from(loaded.faces[0].vector), Array.from(ME));
    assert.equal(loaded.faces[1].source, 'auto');
    // A wrong key reads as "nothing enrolled", never throws.
    const other = new FaceDataStore(dir, { ...secret, decryptString: () => { throw new Error('bad'); } });
    assert.equal((await other.load()).faces.length, 0);
    // No encryption: the switch can be saved, faces cannot.
    const plain = new FaceDataStore(dir, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no'); }, decryptString: () => { throw new Error('no'); } });
    await assert.rejects(plain.save({ enabled: true, faces }), /secure storage/);
    await plain.save({ enabled: false, faces: [] });
    await store.deleteAll();
    await assert.rejects(readFile(store.file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker messages are checked key by key; frames are size-checked', () => {
  const ok = { type: 'result', id: 'face-1', found: true, detScore: 0.9, faceWidth: 80, frontal: 0.9, sharpness: 50, brightness: 120, embedding: Array(128).fill(0.1), ms: 4 };
  assert.ok(parseFaceWorkerMessage(ok));
  assert.equal(parseFaceWorkerMessage({ ...ok, frame: [1, 2] }), null, 'an extra key (a picture) drops the message');
  assert.equal(parseFaceWorkerMessage({ ...ok, embedding: Array(64).fill(0) }), null);
  assert.equal(parseFaceWorkerMessage({ ...ok, found: false }), null, 'no face cannot carry an embedding');
  assert.equal(parseFaceWorkerMessage({ ...ok, detScore: 2 }), null);
  assert.equal(parseFaceWorkerMessage({ type: 'ready', loadMs: 3, path: 'C:\\x' }), null);
  assert.ok(parseFaceHostMessage({ type: 'analyze', id: 'a', width: 16, height: 16, data: new ArrayBuffer(16 * 16 * 4) }));
  assert.equal(parseFaceHostMessage({ type: 'analyze', id: 'a', width: 16, height: 16, data: new ArrayBuffer(10) }), null);
  assert.equal(parseFaceHostMessage({ type: 'analyze', id: 'a', width: 1280, height: 720, data: new ArrayBuffer(1280 * 720 * 4) }), null);
});

test('worker: refuses changed model files, answers with numbers only, releases and exits on stop', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-face-worker-'));
  try {
    const detector = Buffer.from('fake yunet'), recognizer = Buffer.from('fake sface');
    await writeFile(path.join(dir, 'd.onnx'), detector); await writeFile(path.join(dir, 'r.onnx'), recognizer);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const run = (initPatch: Record<string, unknown>) => new Promise<{ messages: unknown[]; exited: boolean; released: number }>(resolve => {
      const messages: unknown[] = [];
      let listener: (event: { data: unknown }) => void = () => undefined;
      let released = 0;
      const session = (outputs: Record<string, { data: Float32Array; dims: number[] }>) => ({ inputNames: ['x'], outputNames: Object.keys(outputs),
        run: async () => outputs, release: async () => { released++; } });
      const yunet: Record<string, { data: Float32Array; dims: number[] }> = {};
      for (const stride of [8, 16, 32]) {
        const n = (640 / stride) ** 2;
        yunet[`cls_${stride}`] = { data: new Float32Array(n), dims: [1, n, 1] }; yunet[`obj_${stride}`] = { data: new Float32Array(n), dims: [1, n, 1] };
        yunet[`bbox_${stride}`] = { data: new Float32Array(n * 4), dims: [1, n, 4] }; yunet[`kps_${stride}`] = { data: new Float32Array(n * 10), dims: [1, n, 10] };
      }
      // One face at stride 32, cell (5, 5), with landmarks spread like a face.
      const i = 5 * 20 + 5;
      yunet.cls_32.data[i] = 0.98; yunet.obj_32.data[i] = 0.98;
      yunet.bbox_32.data.set([0.5, 0.5, Math.log(3), Math.log(3.5)], i * 4);
      yunet.kps_32.data.set([-0.4, -0.3, 1.4, -0.3, 0.5, 0.3, -0.2, 1.0, 1.2, 1.0], i * 10);
      let created = 0;
      const ort = { InferenceSession: { create: async () => created++ === 0 ? session(yunet) : session({ fc1: { data: new Float32Array(128).fill(0.25), dims: [1, 128] } }) },
        Tensor: class { constructor(public type: string, public data: Float32Array, public dims: number[]) {} } };
      let exited = false;
      startFaceWorker({ on: (_e, l) => { listener = l; }, postMessage: m => { messages.push(m); } }, () => ort as never, () => { exited = true; resolve({ messages, exited, released }); }, () => 0);
      listener({ data: { type: 'init', runtimeEntry: path.join(dir, 'ort'), detector: path.join(dir, 'd.onnx'), detectorSize: detector.length, detectorSha256: sha(detector),
        recognizer: path.join(dir, 'r.onnx'), recognizerSize: recognizer.length, recognizerSha256: sha(recognizer), threads: 1, ...initPatch } });
      listener({ data: { type: 'analyze', id: 'f1', width: 320, height: 240, data: new Uint8Array(320 * 240 * 4).fill(128).buffer } });
      // "stop" drops anything not yet answered, so it goes once both answers are in (or after a short wait).
      void (async () => { for (let i = 0; i < 300 && messages.length < 2; i++) await new Promise(r => setTimeout(r, 10)); listener({ data: { type: 'stop' } }); })();
    });
    const good = await run({});
    assert.deepEqual(good.messages.map(m => (m as { type: string }).type), ['ready', 'result']);
    const result = parseFaceWorkerMessage(good.messages[1]);
    assert.ok(result && result.type === 'result' && result.found && result.embedding?.length === 128);
    assert.equal(good.released, 2, 'both sessions released before exit');
    const swapped = await run({ detectorSha256: 'f'.repeat(64) });
    assert.deepEqual(swapped.messages.map(m => (m as { type: string }).type), ['failed', 'error']);
    const relative = await run({ detector: 'd.onnx' });
    assert.deepEqual(relative.messages.map(m => (m as { type: string }).type), ['error'], 'a relative path is ignored');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('frame sources: both camera switches off → no frame and no port touched; one small picture is never checked twice', async () => {
  const calls: string[] = [];
  let pose = false, images = false, latest: string | null = 'data:image/jpeg;base64,AAAA';
  const source = createFaceFrameSource({
    poseOn: () => pose, imagesOn: () => images,
    poseTap: async () => { calls.push('tap'); return FRAME; },
    latestPicture: () => { calls.push('latest'); return latest; },
    clearPicture: async () => { calls.push('clear'); return 'data:image/jpeg;base64,BBBB'; },
    decode: url => { calls.push(`decode:${url.slice(-4)}`); return FRAME; },
  });
  const signal = new AbortController().signal;
  assert.equal(source.cameraOn(), false);
  assert.equal(await source.grab('check', signal), null);
  assert.equal(await source.grab('enrol', signal), null);
  assert.equal(calls.length, 0, "no port touched");
  images = true;
  assert.equal(await source.grab('check', signal), FRAME);
  assert.equal(await source.grab('check', signal), null, 'the same small picture again');
  latest = 'data:image/jpeg;base64,CCCC';
  assert.equal(await source.grab('check', signal), FRAME);
  assert.equal(await source.grab('enrol', signal), FRAME);
  assert.ok(calls.includes('clear') && calls.includes('decode:BBBB'), 'enrolment takes a fresh clear picture');
  pose = true; calls.length = 0;
  assert.equal(await source.grab('check', signal), FRAME);
  assert.deepEqual(calls, ['tap'], 'pose sensing running: its frame, no picture decoded');
  assert.deepEqual(fitFaceFrame(1280, 720), { width: 640, height: 360 });
  assert.deepEqual(fitFaceFrame(320, 240), { width: 320, height: 240 });
  assert.deepEqual(Array.from(bgraToRgba(new Uint8Array([1, 2, 3, 0]), 1, 1)!), [3, 2, 1, 255]);
  assert.equal(bgraToRgba(new Uint8Array(3), 1, 1), null);
});

test('pose tap: one copied frame back to the host, only while sensing runs; the message is size-checked', async () => {
  const frame = { type: 'tap', width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
  assert.ok(parseWorkerMessage(frame));
  assert.equal(parseWorkerMessage({ ...frame, data: new Uint8Array(5) }), null);
  assert.equal(parseWorkerMessage({ ...frame, keypoints: [] }), null);
  let workerListener: (m: unknown) => void = () => undefined;
  const sent: unknown[] = [];
  const supervisor = new PoseSupervisor({
    prepare: async () => ({ runtimeEntry: 'C:\\r', detector: 'C:\\d', detectorSha256: 'a', pose: 'C:\\p', poseSha256: 'b', prefer: null, dmlBad: false }),
    fork: () => ({ postMessage: m => { sent.push(m); }, onMessage: l => { workerListener = l; }, onExit: () => undefined, kill: () => undefined }),
    channel: () => ({ worker: {}, sensor: {} }), openSensor: () => ({ close: () => undefined }), saveRoute: () => undefined,
    disableCamera: () => undefined, changed: () => undefined, setTimer: () => 0, clearTimer: () => undefined,
  });
  assert.equal(await supervisor.tap(), null, 'not running: nothing');
  supervisor.setWanted(true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(supervisor.phase, 'starting');
  const early = await Promise.race([supervisor.tap(), new Promise(resolve => setTimeout(() => resolve('pending'), 50))]);
  assert.equal(early, null, 'still starting (no sensor window yet): nothing, at once');
  assert.ok(!sent.some(m => (m as { type: string }).type === 'tap'));
  workerListener({ type: 'ready', route: 'cpu', level: 'normal', p90: { dml: null, cpu: 40 }, dmlBad: false });
  assert.equal(supervisor.phase, 'running');
  const tapped = supervisor.tap();
  assert.ok(sent.some(m => (m as { type: string }).type === 'tap'));
  workerListener(frame);
  const got = await tapped;
  assert.equal(got?.width, 16);
  supervisor.stop();
  assert.equal(await supervisor.tap(), null);
});

test('manifest: only the int8 SFace and YuNet, pinned; the model-only download is about 10 MB', () => {
  assert.equal(FACE_MODEL_PINS.detector.sha256, '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4');
  assert.equal(FACE_MODEL_PINS.recognizer.sha256, '2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a');
  assert.equal(FACE_MODEL_DOWNLOAD_BYTES, 232_589 + 9_896_933);
  const files = FACE_ARCHIVES.flatMap(archive => archive.files.all ?? []).map(file => file.to);
  assert.ok(files.includes('models/face_recognition_sface_2021dec_int8.onnx'));
  assert.ok(!files.some(file => /sface_2021dec\.onnx$/.test(file)), 'no fp32 fallback');
  assert.ok(FACE_ARCHIVES.every(archive => /^https:\/\//.test(archive.url)));
});

test('internal channel: face_check goes through the control window\'s own switch, reads its view, and nothing else', async () => {
  const { createHostBridge, recordAgentOperations } = await import('../electron/safety/agent-channel/bridge');
  const ipc: { handle(channel: string, handler: (...args: any[]) => unknown): void } = { handle: () => {} };
  const recorder = recordAgentOperations(ipc as never);
  const seen: Array<[string, number, unknown]> = [];
  let enabled = false;
  for (const name of ['getRuntimeState', 'getAudioReadingView', 'getFaceCheck', 'setFaceCheck', 'startFaceEnrolment', 'deleteFaceData'])
    ipc.handle(`desk:${name}`, (event: any, ...args: unknown[]) => { seen.push([name, event.sender.id, args[0]]);
      if (name === 'setFaceCheck') enabled = args[0] === true;
      return name === 'getFaceCheck' ? { enabled } : name === 'getRuntimeState' ? {} : undefined; });
  const operations = recorder.done();
  assert.ok(!operations.has('startFaceEnrolment') && !operations.has('deleteFaceData'), 'enrolment and delete stay the user\'s own clicks');
  const win = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send: () => {} } });
  const bridge = createHostBridge({ version: () => 't', controls: () => win(1), pet: () => win(2), operations, admit: (_guard: unknown, run: () => unknown) => run(),
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true } as never);
  assert.equal(bridge.perception!().faceCheck, false);
  await bridge.setPerception!('face_check', true, [], () => {});
  assert.deepEqual(seen.filter(entry => entry[0] === 'setFaceCheck'), [['setFaceCheck', 1, true]]);
  assert.equal(bridge.perception!().faceCheck, true);
});
