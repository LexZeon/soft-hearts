// The local recognizer host (electron/asr/host.ts) and its inference process (electron/asr/worker.ts), with a fake store,
// fake utilityProcess and fake onnxruntime. Covers: the refusal and question when the component is missing, one request at
// a time with a text answer, failures by category, a stuck process replaced, and the process releasing its session and
// exiting by itself (killed only after the grace time if it does not).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXIT_GRACE_MS, IDLE_STOP_MS, LocalAsrError, LocalAsrHost, RECOGNIZE_TIMEOUT_MS, type AsrWorkerHandle } from '../electron/asr/host';
import { startAsrWorker } from '../electron/asr/worker';
import { asrLanguage, type AsrOrtLike, type AsrOrtSession } from '../electron/asr/engine';
import type { LocalAsrView } from '../shared/local-asr';
import { encodeWav } from '../src/ui/MediaInput';
import { onnxWithMetadata, senseVoiceMetadata } from './helpers/onnx-proto';
import { ASR_MODEL_FILES } from '../electron/asr/manifest';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function clock() {
  let now = 0, id = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, ms: number) => { due.set(++id, { at: now + ms, run }); return id; },
    clearTimer: (handle: unknown) => { due.delete(handle as number); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].run(); await flush();
      }
      now = end;
    },
  };
}

function fakeStore(installed = true) {
  return {
    installed, working: false, downloadBytes: 270_161_561, officialDownloadBytes: 355_013_368, installedBytes: installed ? 313_698_939 : 0,
    installedDir: () => installed ? 'C:\\components\\asr\\asr-v1\\win32-arm64' : null,
    installedFile: (to: string) => installed ? `C:\\components\\asr\\asr-v1\\win32-arm64\\${to.replaceAll('/', '\\')}` : null,
    refresh: async () => installed, install: async () => { installed = true; }, importFiles: async () => ({ accepted: 0, rejected: 0, complete: false }), remove: async () => { installed = false; },
  };
}

/** A fake utilityProcess: records what the host sends; the test answers as the process would. */
function fakeWorkers() {
  const made: { sent: unknown[]; message?: (m: unknown) => void; exit?: (code: number) => void; killed: number; exited: boolean }[] = [];
  const fork = (): AsrWorkerHandle => {
    const worker = { sent: [] as unknown[], message: undefined as ((m: unknown) => void) | undefined, exit: undefined as ((code: number) => void) | undefined, killed: 0, exited: false };
    made.push(worker);
    return { postMessage: message => { worker.sent.push(message); }, onMessage: listener => { worker.message = listener; },
      onExit: listener => { worker.exit = listener; }, kill: () => { worker.killed++; worker.exited = true; worker.exit?.(1); } };
  };
  return { made, fork };
}

function host(installed = true) {
  const time = clock(), workers = fakeWorkers(), views: LocalAsrView[] = [], prompts: string[] = [];
  const store = fakeStore(installed);
  const value = new LocalAsrHost({ store: store as never, fork: workers.fork, publish: view => views.push(view), promptRaised: owner => prompts.push(owner),
    setTimer: time.setTimer, clearTimer: time.clearTimer, sharedRuntime: () => false });
  return { value, time, workers, views, prompts, store };
}
const wav = () => encodeWav(new Float32Array(16000).fill(0.1));

test('component missing: voice input is refused with a reason, the question shows with the size, the window that asked is raised', () => {
  const h = host(false);
  assert.equal(h.value.voiceBlocked('pet'), 'needs-component');
  assert.deepEqual(h.prompts, ['pet']);
  const view = h.value.view();
  assert.equal(view.phase, 'not-installed'); assert.equal(view.prompt, true); assert.equal(view.asked, 1);
  assert.equal(Math.round(view.downloadBytes / 1e6), 270);
  h.value.voiceBlocked('controls');
  assert.equal(h.value.view().asked, 2, 'every refused try brings the question back');
  assert.equal(h.workers.made.length, 0, 'nothing is started');
  const none = new LocalAsrHost({ store: null, fork: () => assert.fail(), publish() {}, promptRaised() {} });
  assert.equal(none.voiceBlocked('controls'), 'unavailable');
  assert.equal(none.view().phase, 'unsupported');
});

test('installed: voice on loads the model; one utterance goes to the process and its words come back', async () => {
  const h = host();
  assert.equal(h.value.voiceBlocked('controls'), null);
  h.value.setWanted(true); await flush();
  const worker = h.workers.made[0]!;
  const init = worker.sent[0] as Record<string, unknown>;
  assert.equal(init.type, 'init');
  assert.ok(String(init.model).endsWith('sensevoice-small.int8.onnx'));
  assert.match(String(init.modelSha256), /^[0-9a-f]{64}$/);
  assert.equal(h.value.view().phase, 'starting');
  worker.message!({ type: 'ready', loadMs: 900 }); await flush();
  assert.equal(h.value.view().phase, 'ready');
  const text = h.value.transcribe(wav(), 'zh', new AbortController().signal);
  await flush();
  const request = worker.sent[1] as { type: string; id: string; language: string; wav: ArrayBuffer };
  assert.equal(request.type, 'recognize'); assert.equal(request.language, 'zh'); assert.ok(request.wav.byteLength > 44);
  worker.message!({ type: 'result', id: request.id, text: ' 今天天气真好。 ', ms: 100 });
  assert.equal(await text, '今天天气真好。');
  // Unknown or malformed messages are ignored.
  worker.message!({ type: 'result', id: request.id, text: 'late', ms: 1, extra: 1 });
  worker.message!('hello');
});

test('failures carry a category: process error, not installed, being installed, timeout (and the stuck process is replaced)', async () => {
  const h = host();
  h.value.setWanted(true); await flush();
  const worker = h.workers.made[0]!;
  worker.message!({ type: 'ready', loadMs: 1 }); await flush();
  const failed = h.value.transcribe(wav(), 'zh', new AbortController().signal); await flush();
  worker.message!({ type: 'error', id: (worker.sent[1] as { id: string }).id });
  await assert.rejects(failed, (error: unknown) => error instanceof LocalAsrError && error.failure === 'local-failed');
  const slow = h.value.transcribe(wav(), 'zh', new AbortController().signal); await flush();
  await h.time.advance(RECOGNIZE_TIMEOUT_MS);
  await assert.rejects(slow, (error: unknown) => error instanceof LocalAsrError && error.failure === 'timeout');
  assert.deepEqual(worker.sent.at(-1), { type: 'stop' }, 'the stuck process is asked to stop');
  await h.time.advance(EXIT_GRACE_MS);
  assert.equal(worker.killed, 1, 'and killed only after the grace time');
  const missing = host(false);
  await assert.rejects(missing.value.transcribe(wav(), 'zh', new AbortController().signal), (error: unknown) => error instanceof LocalAsrError && error.failure === 'needs-component');
});

test('voice off: the process is asked to stop a little later; if it exits by itself it is never killed', async () => {
  const h = host();
  h.value.setWanted(true); await flush();
  const worker = h.workers.made[0]!;
  worker.message!({ type: 'ready', loadMs: 1 }); await flush();
  h.value.setWanted(false);
  await h.time.advance(IDLE_STOP_MS - 1);
  assert.equal(worker.sent.some(m => (m as { type: string }).type === 'stop'), false, 'a quick off/on keeps the model');
  await h.time.advance(1);
  assert.deepEqual(worker.sent.at(-1), { type: 'stop' });
  worker.exited = true; worker.exit!(0);
  await h.time.advance(EXIT_GRACE_MS);
  assert.equal(worker.killed, 0);
  assert.equal(h.value.view().phase, 'idle');
});

test('the inference process: checks the files, answers one request with the words, releases its session before it exits', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const model = onnxWithMetadata(senseVoiceMetadata());
  const tokens = ['<unk>', '<s>', '</s>', '<|zh|>', '<|en|>', '<|NEUTRAL|>', '<|Speech|>', '<|withitn|>', '今天', '天气', '真', '好', '。', '▁hi', '<|woitn|>', '<|HAPPY|>', '<|BGM|>']
    .map((piece, id) => `${piece} ${id}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'model.onnx'), model); writeFileSync(path.join(dir, 'tokens.txt'), tokens);
  const events: string[] = [], sent: Record<string, unknown>[] = [];
  let feeds: Record<string, { data: ArrayLike<number>; dims: number[] }> = {};
  const session: AsrOrtSession = {
    inputNames: ['x', 'x_length', 'language', 'text_norm'], outputNames: ['logits'],
    run: async input => {
      feeds = input as typeof feeds;
      const best = [3, 5, 6, 7, 8, 9, 10, 11, 12]; // <|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气真好。
      const data = new Float32Array(best.length * 17);
      best.forEach((id, frame) => { data[frame * 17 + id] = 9; });
      return { logits: { data, dims: [1, best.length, 17] } };
    },
    release: async () => { events.push('release'); },
  };
  const ort: AsrOrtLike = {
    InferenceSession: { create: async (file, options) => { events.push(`create ${path.basename(file)} ${JSON.stringify((options as { executionProviders: unknown }).executionProviders)}`); return session; } },
    Tensor: class { constructor(public type: string, public data: ArrayLike<number>, public dims: number[]) {} } as never,
  };
  let listener: (event: { data: unknown }) => void = () => {};
  startAsrWorker({ on: (_e, l) => { listener = l; }, postMessage: m => sent.push(m as Record<string, unknown>) }, () => ort, code => events.push(`exit ${code}`), () => 0);
  const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
  const init = { type: 'init', runtimeEntry: path.join(dir, 'ort'), model: path.join(dir, 'model.onnx'), modelSize: model.length, modelSha256: hash(model),
    tokens: path.join(dir, 'tokens.txt'), tokensSha256: hash(tokens), threads: 2 };
  // Hashing the files takes longer when the whole suite runs at once: wait for the answer, not a fixed time.
  const answered = async (count: number, check: () => number = () => sent.length) => {
    for (const end = Date.now() + 3000; check() <= count && Date.now() < end; ) await new Promise(resolve => setTimeout(resolve, 5));
  };
  listener({ data: { ...init, modelSha256: '0'.repeat(64) } });
  await answered(0);
  assert.deepEqual(sent.at(-1), { type: 'failed', reason: 'model' }, 'a changed model file is refused');
  listener({ data: init });
  await answered(1);
  assert.equal(sent.at(-1)!.type, 'ready');
  assert.deepEqual(events, ['create model.onnx ["cpu"]'], 'CPU only');
  listener({ data: { type: 'recognize', id: 'r1', wav: encodeWav(new Float32Array(16000).fill(0.05)), language: 'zh' } });
  await answered(2);
  assert.deepEqual(sent.at(-1), { type: 'result', id: 'r1', text: '今天天气真好。', ms: 0 });
  assert.deepEqual(feeds.x.dims, [1, 17, 560]);
  assert.deepEqual(Array.from(feeds.language.data), [3]);
  assert.deepEqual(Array.from(feeds.text_norm.data), [14]);
  listener({ data: { type: 'recognize', id: 'r2', wav: new ArrayBuffer(10), language: 'zh' } });
  await answered(3);
  assert.deepEqual(sent.at(-1), { type: 'error', id: 'r2' });
  listener({ data: { type: 'stop' } });
  await answered(2, () => events.length);
  assert.deepEqual(events.slice(1), ['release', 'exit 0'], 'session released first, then it leaves by itself');
});

test('the language setting maps to what the model knows; anything else listens for all', () => {
  assert.deepEqual(['zh', 'zh-CN', 'EN', 'yue', 'ja', 'ko', '', 'fr'].map(asrLanguage), ['zh', 'zh', 'en', 'yue', 'ja', 'ko', 'auto', 'auto']);
  assert.equal(ASR_MODEL_FILES.model, 'models/sensevoice-small.int8.onnx');
});
