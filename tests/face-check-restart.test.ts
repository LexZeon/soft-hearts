/**
 * I-135 认出是不是你（Beta）, 2026-11-25: the owner's own trial (his face was not recognized at 19:32, and a visitor's was not either).
 *  - After a restart the saved switch and faces are read by a NEW host from the real file store; with the camera on in each mode (pose,
 *    send pictures, both) checks start without anyone touching the switch, also when the hook that should have started them never came.
 *  - Off and on again, a character switch and full screen and back (Unbound turns the senses off and on as a bundle) all resume.
 *  - A check that cannot run leaves a row that says why (closed words), and every check's score is a row (numbers only).
 * Fakes only: no model, no camera, no Electron. Temporary folders only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FaceCheckHost, type FaceEnrolPreviewInput, type FaceFrame, type FaceRecordRow, type FaceWorkerHandle } from '../electron/senses/face/host';
import { createFaceFrameSource, previewTarget } from '../electron/senses/face/frames';
import { FaceDataStore } from '../electron/senses/face/store';
import { FACE_KNOBS } from '../electron/senses/face/knobs';
import { IDLE_AFTER_MS, IDLE_REPEAT_MS, FaceIdleWatch, ScoreRowGate, idleWhy } from '../electron/senses/face/diagnosis';
import { enrolHint } from '../electron/senses/face/enrolment';
import { l2normalize } from '../electron/senses/face/score';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { FACE_ENROL_IMAGE_MAX, parseFaceEnrolPreviewMessage } from '../shared/senses/face-check';
import type { FaceHostToWorker } from '../electron/senses/face/protocol';

const unit = (seed: number) => { let a = seed * 2654435761 >>> 0; const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return l2normalize(Array.from({ length: 128 }, () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()))); };
const ME = unit(1), STRANGER = unit(50);
const FRAME: FaceFrame = { width: 32, height: 24, rgba: new Uint8Array(32 * 24 * 4) };
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
    async advance(ms: number, each?: () => void) {
      const end = now + ms;
      await flush();
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

/** A worker that answers every analysis with the scripted embedding (or no face). */
function fakeWorkers(embedding: () => Float32Array | null, options: { failFork?: boolean } = {}) {
  const forks: FaceHostToWorker[][] = [];
  const fork = (): FaceWorkerHandle => {
    if (options.failFork) throw new Error('no worker');
    let listener: (message: unknown) => void = () => undefined, exit: (code: number) => void = () => undefined;
    const sent: FaceHostToWorker[] = [];
    forks.push(sent);
    return {
      postMessage: message => {
        sent.push(message);
        if (message.type === 'init') queueMicrotask(() => listener({ type: 'ready', loadMs: 5 }));
        else if (message.type === 'analyze') {
          const e = embedding();
          queueMicrotask(() => listener({ type: 'result', id: message.id, found: !!e, detScore: e ? 0.97 : 0, faceWidth: e ? 90 : 0, frontal: e ? 0.95 : 0, sharpness: e ? 120 : 0,
            brightness: e ? 130 : 0, embedding: e ? Array.from(e) : null, ms: 3, ...(e ? { box: [4, 3, 20, 18] } : {}) }));
        } else if (message.type === 'stop') queueMicrotask(() => exit(0));
      },
      onMessage: l => { listener = l; }, onExit: l => { exit = l; }, kill: () => exit(1),
    };
  };
  return { fork, forks };
}

const fakeStore = (installed = true) => ({
  installed, working: false, downloadBytes: 1, installedBytes: 1, refresh: async () => installed,
  installedDir: () => installed ? 'C:\\c\\face' : null, installedFile: (to: string) => installed ? `C:\\c\\face\\${to}` : null,
  install: async () => undefined, remove: async () => undefined, importFiles: async () => ({ accepted: 2, rejected: 0, complete: true }),
});

const secret = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '') };

interface Switches { pose: boolean; images: boolean; frames: number }

/** A new host (a "start of the app") over the same folder. `switches` is what the camera switches say right now. */
async function startApp(directory: string, switches: Switches, options: { embedding?: () => Float32Array | null; installed?: boolean; failFork?: boolean } = {}) {
  const time = manualTime();
  const rows: FaceRecordRow[] = [];
  const previews: (FaceEnrolPreviewInput | null)[] = [];
  const workers = fakeWorkers(options.embedding ?? (() => ME), { failFork: options.failFork });
  let picture = 0;
  const frames = createFaceFrameSource({
    poseOn: () => switches.pose, poseTap: async () => { switches.frames++; return FRAME; },
    imagesOn: () => switches.images, latestPicture: () => `data:image/jpeg;base64,AAAA${++picture}`, clearPicture: async () => null, decode: () => { switches.frames++; return FRAME; },
  });
  const host = new FaceCheckHost({
    store: fakeStore(options.installed ?? true) as never, data: new FaceDataStore(directory, secret), fork: workers.fork, frames, publish: () => undefined,
    record: row => rows.push(row), preview: input => previews.push(input),
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, setInterval: time.setInterval, clearInterval: time.clearInterval,
  });
  await host.init();
  return { host, time, workers, rows, previews, switches };
}

async function savedProfile(enabled = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'face-restart-'));
  await new FaceDataStore(directory, secret).save({ enabled, faces: [0, 1, 2].map(i => ({ vector: l2normalize(ME.map((v, k) => v + (k % 7 === i ? 0.01 : 0))), source: 'enrol' as const, at: 0 })) });
  return directory;
}
const analyses = (app: Awaited<ReturnType<typeof startApp>>) => app.workers.forks.flat().filter(m => m.type === 'analyze').length;

const MODES: [string, Partial<Switches>][] = [['pose only', { pose: true }], ['send pictures only', { images: true }], ['both', { pose: true, images: true }]];

for (const [name, camera] of MODES) {
  test(`after a restart (${name}): the saved switch and faces are read by a new host and checks start with no toggle`, async () => {
    const directory = await savedProfile();
    try {
      const switches: Switches = { pose: false, images: false, frames: 0 };
      const app = await startApp(directory, switches);
      assert.equal(app.host.enabled, true, 'the saved switch came back');
      assert.equal(app.host.enrolledCount, 3, 'the saved faces came back');
      await app.time.advance(10_000);
      assert.equal(analyses(app), 0, 'camera off: nothing runs');
      Object.assign(switches, camera);
      app.host.cameraChanged(); // what mediaChanged does
      await app.time.advance(10_000);
      assert.ok(analyses(app) >= 3, `checks started, got ${analyses(app)}`);
      assert.ok(app.rows.some(row => row.event === 'check' && row.outcome === 'match'), 'and a score row says so');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test(`after a restart (${name}): the camera came on without the hook ever reaching the host; the once-a-second clock starts the checks`, async () => {
    const directory = await savedProfile();
    try {
      const switches: Switches = { pose: false, images: false, frames: 0 };
      const app = await startApp(directory, switches);
      Object.assign(switches, camera); // no cameraChanged(): the case the user hit
      for (let i = 0; i < 12; i++) { app.host.notePresence('idle'); await app.time.advance(1000); }
      assert.ok(analyses(app) >= 2, `the watch brought the checks back, got ${analyses(app)}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test(`${name}: camera off and on again, full screen and back, and a character switch all resume`, async () => {
    const directory = await savedProfile();
    try {
      const switches: Switches = { pose: false, images: false, frames: 0, ...camera };
      const app = await startApp(directory, switches);
      await app.time.advance(6000);
      const first = analyses(app);
      assert.ok(first >= 2);
      // The camera goes off (a "别看", or Unbound's bundle turning the senses off) and on again.
      for (const key of ['pose', 'images'] as const) switches[key] = false;
      app.host.cameraChanged();
      await app.time.advance(10_000);
      assert.equal(analyses(app), first, 'off means off');
      Object.assign(switches, camera);
      app.host.cameraChanged();
      await app.time.advance(10_000);
      assert.ok(analyses(app) > first, 'on again resumes');
      // A character switch changes nothing here (the face is the user's, not the character's), and its media change still reaches the host.
      const before = analyses(app);
      app.host.cameraChanged(); app.host.noteTalk();
      await app.time.advance(10_000);
      assert.ok(analyses(app) > before, 'still checking after the switch');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('a stranger in front of the camera after a restart: told apart within a few checks, and the rows carry the scores', async () => {
  const directory = await savedProfile();
  try {
    const switches: Switches = { pose: true, images: false, frames: 0 };
    let who: Float32Array | null = ME;
    const app = await startApp(directory, switches, { embedding: () => who });
    await app.time.advance(5000);
    assert.equal(app.host.state(), 'you');
    who = STRANGER;
    await app.time.advance(8000);
    assert.equal(app.host.state(), 'not-you');
    const checks = app.rows.filter((row): row is Extract<FaceRecordRow, { event: 'check' }> => row.event === 'check');
    assert.ok(checks.some(row => row.outcome === 'match' && (row.similarity ?? 0) > 0.9 && row.which !== null));
    assert.ok(checks.some(row => row.outcome === 'clear-not' && (row.similarity ?? 1) < FACE_KNOBS.match.clearlyNotCosine && row.clear));
    for (const row of checks) assert.deepEqual(Object.keys(row).sort(), ['clear', 'det', 'event', 'frontal', 'outcome', 'similarity', 'type', 'which'], 'closed fields only');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('expected but nothing ran for a minute: one row says why, in closed words, and not again at once', async () => {
  const directory = await savedProfile();
  try {
    // The camera says "on" (pose) but its tap gives no picture.
    const time = manualTime();
    const rows: FaceRecordRow[] = [];
    const host = new FaceCheckHost({
      store: fakeStore() as never, data: new FaceDataStore(directory, secret), fork: fakeWorkers(() => ME).fork, publish: () => undefined, record: row => rows.push(row),
      frames: createFaceFrameSource({ poseOn: () => true, poseTap: async () => null, imagesOn: () => false, latestPicture: () => null, clearPicture: async () => null, decode: () => null }),
      now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, setInterval: time.setInterval, clearInterval: time.clearInterval,
    });
    await host.init();
    for (let s = 0; s < 70; s++) { host.notePresence('idle'); await time.advance(1000); }
    const idle = rows.filter(row => row.event === 'idle');
    assert.equal(idle.length, 1, 'one row in the first minute and a bit');
    assert.deepEqual(idle[0], { type: 'face-score', event: 'idle', why: 'no-frames', seconds: idle[0].event === 'idle' ? idle[0].seconds : 0 });
    assert.ok(idle[0].event === 'idle' && idle[0].seconds >= 60 && idle[0].seconds < 70);
    for (let s = 0; s < 120; s++) { host.notePresence('idle'); await time.advance(1000); }
    assert.equal(rows.filter(row => row.event === 'idle').length, 1, 'not again within five minutes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('idle reasons: models missing, the worker failing to start, and nothing when the switch or the camera is off', async () => {
  const directory = await savedProfile();
  try {
    const missing = await startApp(directory, { pose: true, images: false, frames: 0 }, { installed: false });
    for (let s = 0; s < 70; s++) { missing.host.notePresence('idle'); await missing.time.advance(1000); }
    assert.deepEqual(missing.rows.map(row => row.event === 'idle' ? row.why : row.event), ['models-missing']);
    const broken = await startApp(directory, { pose: true, images: false, frames: 0 }, { failFork: true });
    for (let s = 0; s < 90; s++) { broken.host.notePresence('idle'); await broken.time.advance(1000); }
    assert.ok(broken.rows.some(row => row.event === 'idle' && row.why === 'worker-failed'), JSON.stringify(broken.rows));
    const off = await startApp(directory, { pose: false, images: false, frames: 0 });
    for (let s = 0; s < 120; s++) { off.host.notePresence('idle'); await off.time.advance(1000); }
    assert.deepEqual(off.rows, [], 'camera off: nothing is expected, nothing is written');
    const switchOff = await savedProfile(false);
    try {
      const app = await startApp(switchOff, { pose: true, images: true, frames: 0 });
      for (let s = 0; s < 120; s++) { app.host.notePresence('idle'); await app.time.advance(1000); }
      assert.deepEqual(app.rows, []);
      assert.equal(app.time.pending, 0, 'and no timer');
    } finally { await rm(switchOff, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('diagnosis helpers: the idle watch, the reason words and the thinning of steady rows', () => {
  const watch = new FaceIdleWatch();
  assert.equal(watch.due(0), null);
  assert.equal(watch.due(IDLE_AFTER_MS - 1), null);
  assert.equal(watch.due(IDLE_AFTER_MS), 60);
  assert.equal(watch.due(IDLE_AFTER_MS + 1000), null, 'once, then quiet');
  assert.equal(watch.due(IDLE_AFTER_MS + IDLE_REPEAT_MS), 360, 'again after five minutes');
  watch.ran(IDLE_AFTER_MS + IDLE_REPEAT_MS + 1000);
  assert.equal(watch.due(IDLE_AFTER_MS + IDLE_REPEAT_MS + 30_000), null, 'a check ran: the minute starts over');
  watch.stopExpecting();
  assert.equal(watch.due(10_000_000), null, 'after not expecting, the clock starts over');
  const facts = { installed: true, gaveUp: false, workerFailed: false, active: true, noFrames: 0, noResult: 0 };
  assert.equal(idleWhy({ ...facts, installed: false }), 'models-missing');
  assert.equal(idleWhy({ ...facts, gaveUp: true }), 'worker-failed');
  assert.equal(idleWhy({ ...facts, active: false }), 'not-started');
  assert.equal(idleWhy({ ...facts, noFrames: 5 }), 'no-frames');
  assert.equal(idleWhy({ ...facts, noFrames: 1, noResult: 4 }), 'no-result');
  const gate = new ScoreRowGate();
  assert.equal(gate.admit('match', 0.7, 0), true);
  assert.equal(gate.admit('match', 0.71, 2500), false, 'steady');
  assert.equal(gate.admit('match', 0.6, 5000), true, 'the score moved');
  assert.equal(gate.admit('clear-not', 0.1, 7500), true, 'the outcome changed');
  assert.equal(gate.admit('clear-not', 0.1, 7500 + 30_000), true, 'steady for half a minute: one more');
});

test('the journal row: closed outcome and numbers only; an embedding, a picture or an extra field never fits', () => {
  const ok = { type: 'face-score', characterId: 'gene', event: 'check', outcome: 'clear-not', similarity: 0.214, which: 3, clear: true, frontal: 0.912, det: 0.97 };
  const entry = buildJournalEntry(ok as never, 0);
  assert.ok(entry);
  assert.deepEqual({ ...entry }, { ...entry, similarity: 0.21, frontal: 0.91, det: 0.97 }, 'two decimals');
  const text = describeJournalEntry(entry!, (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)])));
  assert.match(text, /相似度 0\.21，最像登记的第 3 组/);
  assert.ok(!('embedding' in entry!) && !('picture' in entry!));
  const kept = buildJournalEntry({ ...ok, embedding: [1, 2, 3], picture: 'data:image/jpeg;base64,AAAA', note: 'x' } as never, 0);
  assert.ok(kept && !('embedding' in kept) && !('picture' in kept) && !('note' in kept), 'extras dropped');
  for (const bad of [{ outcome: 'skipped' }, { similarity: 1.5 }, { which: 0 }, { which: 99 }, { clear: 'yes' }, { frontal: 'a' }, { event: 'other' }])
    assert.equal(buildJournalEntry({ ...ok, ...bad } as never, 0), null, JSON.stringify(bad));
  assert.equal(buildJournalEntry({ type: 'face-score', characterId: 'gene', event: 'idle', why: 'no-frames', seconds: 61 } as never, 0)?.type, 'face-score');
  assert.equal(buildJournalEntry({ type: 'face-score', characterId: 'gene', event: 'idle', why: 'because I said so', seconds: 61 } as never, 0), null);
});

test('enrolment shows the camera picture, the face box, one line of advice and the count; it closes when done and keeps nothing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'face-enrol-'));
  try {
    const switches: Switches = { pose: true, images: false, frames: 0 };
    let n = 0;
    const app = await startApp(directory, switches, { embedding: () => { n++; return l2normalize(ME.map((v, k) => v + ((k + n * 17) % 13) * 0.05)); } });
    await app.host.setEnabled(true);
    const enrolling = app.host.enrol();
    await app.time.advance(20_000);
    const view = await enrolling;
    assert.equal(view.notice, 'enrolled');
    const shown = app.previews.filter((p): p is FaceEnrolPreviewInput => p !== null);
    assert.ok(shown.length >= 3, 'a picture per step');
    assert.ok(shown.every(p => p.frame === FRAME && p.total === FACE_KNOBS.enrol.samples && p.taken >= 0 && p.taken <= p.total));
    assert.ok(shown.some(p => p.box && p.box.width === 20), 'the found face box');
    assert.ok(shown.some(p => p.hint === 'good'));
    assert.equal(app.previews.at(-1), null, 'closed at the end');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the enrolment picture goes to the control window, never the companion', () => {
  const controls = { id: 'controls' }, she = { id: 'companion' };
  assert.equal(previewTarget([controls, she], she), controls);
  assert.equal(previewTarget([she], she), null, 'no control window open: nobody gets it');
  assert.equal(previewTarget([], null), null);
});

test('enrolment advice words and the preview message check', () => {
  const base = { found: true, detScore: 0.97, faceWidth: 90, frontal: 0.95, sharpness: 120, brightness: 130, similarity: null };
  assert.equal(enrolHint(null), 'starting');
  assert.equal(enrolHint({ ...base, found: false }), 'no-face');
  assert.equal(enrolHint({ ...base, faceWidth: 20 }), 'too-small');
  assert.equal(enrolHint({ ...base, brightness: 10 }), 'too-dark');
  assert.equal(enrolHint({ ...base, brightness: 250 }), 'too-bright');
  assert.equal(enrolHint({ ...base, frontal: 0.3 }), 'off-angle');
  assert.equal(enrolHint({ ...base, sharpness: 3 }), 'blurry');
  assert.equal(enrolHint(base), 'good');
  const preview = { image: 'data:image/jpeg;base64,AAAA', box: [0.1, 0.2, 0.3, 0.4], hint: 'good', taken: 2, total: 5 };
  assert.ok(parseFaceEnrolPreviewMessage({ enrolPreview: preview }));
  assert.ok(parseFaceEnrolPreviewMessage({ enrolPreview: null }));
  for (const bad of [{ ...preview, image: `data:image/jpeg;base64,${'A'.repeat(FACE_ENROL_IMAGE_MAX)}` }, { ...preview, image: 'https://example.com/x.jpg' }, { ...preview, box: [2, 0, 0, 0] }, { ...preview, hint: 'x' }, { ...preview, score: 0.3 }, { ...preview, taken: 99 }])
    assert.equal(parseFaceEnrolPreviewMessage({ enrolPreview: bad }), null, JSON.stringify(bad));
  assert.equal(parseFaceEnrolPreviewMessage({ enrolPreview: preview, extra: 1 }), null);
});
