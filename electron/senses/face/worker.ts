/**
 * Entry of the face-check utilityProcess (built to dist-electron/face-worker.cjs), I-135.
 *
 * Receives: the component paths, then one small RGBA frame at a time. Sends: only the messages in protocol.ts — numbers
 * about the largest face and its 128-number embedding. No network, no file writes, no frame kept after an answer.
 * On "stop" it releases both sessions and ends itself without the normal exit path, like the pose, speech and
 * embedding workers (docs/claude/2026-11-03-pose-exit-hang.md).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { FaceEngine, type FaceOrtLike } from './engine';
import { parseFaceFrame, parseFaceHostMessage, type FaceWorkerToHost } from './protocol';

interface ParentPortLike { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void }

export function endProcess(): void {
  process.kill(process.pid, 'SIGKILL');
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

export function startFaceWorker(parent: ParentPortLike, loadRuntime: (entry: string) => FaceOrtLike = defaultRuntime,
  exit: (code: number) => void = () => endProcess(), now: () => number = () => performance.now()): void {
  let engine: FaceEngine | null = null;
  let starting = false, stopping = false;
  let chain: Promise<void> = Promise.resolve();
  const emit = (message: FaceWorkerToHost) => parent.postMessage(message);
  parent.on('message', event => {
    const message = parseFaceHostMessage(event.data);
    if (!message || stopping) return;
    if (message.type === 'init' && !engine && !starting) {
      if (![message.runtimeEntry, message.detector, message.recognizer].every(p => path.isAbsolute(p))) return;
      starting = true;
      const started = now();
      chain = chain.then(async () => {
        let ort: FaceOrtLike;
        try { ort = loadRuntime(message.runtimeEntry); } catch { emit({ type: 'failed', reason: 'runtime' }); return; }
        try {
          // Read once, checked, then handed to ONNX Runtime as bytes (long paths and swapped files both fail closed).
          const [detector, recognizer] = await Promise.all([readFile(message.detector), readFile(message.recognizer)]);
          if (detector.byteLength !== message.detectorSize || recognizer.byteLength !== message.recognizerSize
            || sha256(detector) !== message.detectorSha256 || sha256(recognizer) !== message.recognizerSha256) throw new Error('model files changed on disk');
          engine = await FaceEngine.open(ort, detector, recognizer, message.threads);
          if (stopping) { await engine.release().catch(() => undefined); return; }
          emit({ type: 'ready', loadMs: Math.round(now() - started) });
        } catch { emit({ type: 'failed', reason: 'model' }); }
      }).finally(() => { starting = false; });
    } else if (message.type === 'analyze') {
      chain = chain.then(async () => {
        const frame = parseFaceFrame(message.width, message.height, message.data);
        if (!engine || stopping || !frame) { emit({ type: 'error', id: message.id }); return; }
        const started = now();
        try {
          const result = await engine.analyze(frame.rgba, frame.width, frame.height);
          emit({ type: 'result', id: message.id, found: result.found, detScore: round(Math.min(1, Math.max(0, result.detScore))),
            faceWidth: round(result.faceWidth, 1), frontal: round(result.frontal), sharpness: round(result.sharpness, 2),
            brightness: round(Math.min(255, Math.max(0, result.brightness)), 2),
            embedding: result.embedding ? Array.from(result.embedding) : null, ms: Math.round(now() - started),
            ...(result.box ? { box: result.box.map(value => round(value, 1)) as [number, number, number, number] } : {}) });
        } catch { emit({ type: 'error', id: message.id }); }
      });
    } else if (message.type === 'stop') {
      stopping = true;
      void chain.then(() => engine?.release()).catch(() => undefined).finally(() => exit(0));
    }
  });
}

function defaultRuntime(entry: string): FaceOrtLike {
  // Loaded from the downloaded component folder (absolute path from the main process), never bundled.
  return createRequire(__filename)(entry) as FaceOrtLike;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) startFaceWorker(parentPort);
