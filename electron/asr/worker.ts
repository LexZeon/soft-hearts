/**
 * Entry of the speech inference utilityProcess (built to dist-electron/asr-worker.cjs).
 *
 * Receives: the component paths, then one recognize request at a time (a checked 16 kHz WAV of the user's own
 * microphone). Sends: only the messages in protocol.ts. No network, no file writes, nothing kept after a request.
 * On "stop" it releases the ONNX session first and then ends itself (user note 2026-11-03: never leave a
 * process that cannot be ended). It ends without the normal exit path, like the pose worker (endProcess below).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SenseVoiceEngine, type AsrOrtLike } from './engine';
import { wavSamples } from './features';
import { readOnnxMetadataFile, senseVoiceMeta } from './onnx-metadata';
import { parseAsrHostMessage, type AsrWorkerToHost } from './protocol';

interface ParentPortLike { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void }

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Ends this process at once, without the normal exit path (docs/claude/2026-11-03-pose-exit-hang.md): there, a
 * worker using the same onnxruntime called `process.exit(0)` with its sessions released, reported its exit and then
 * stayed stuck with one thread until a restart, because the normal exit runs the libraries' unload code after every
 * other thread is gone. Nothing here needs flushing: no files are written and the session is already released.
 * The system reports exit code 1; the host does not read it.
 */
export function endProcess(): void {
  process.kill(process.pid, 'SIGKILL');
}

export function startAsrWorker(parent: ParentPortLike, loadRuntime: (entry: string) => AsrOrtLike = defaultRuntime,
  exit: (code: number) => void = () => endProcess(), now: () => number = () => performance.now()): void {
  let engine: SenseVoiceEngine | null = null;
  let starting = false, stopping = false;
  let chain: Promise<void> = Promise.resolve();
  const emit = (message: AsrWorkerToHost) => parent.postMessage(message);
  parent.on('message', event => {
    const message = parseAsrHostMessage(event.data);
    if (!message || stopping) return;
    if (message.type === 'init' && !engine && !starting) {
      if (![message.runtimeEntry, message.model, message.tokens].every(p => path.isAbsolute(p))) return;
      starting = true;
      const started = now();
      chain = chain.then(async () => {
        let ort: AsrOrtLike;
        try { ort = loadRuntime(message.runtimeEntry); } catch { emit({ type: 'failed', reason: 'runtime' }); return; }
        try {
          const info = await stat(message.model);
          const tokens = await readFile(message.tokens);
          if (info.size !== message.modelSize || createHash('sha256').update(tokens).digest('hex') !== message.tokensSha256
            || await sha256File(message.model) !== message.modelSha256) throw new Error('model files changed on disk');
          const meta = senseVoiceMeta(readOnnxMetadataFile(message.model));
          engine = await SenseVoiceEngine.open(ort, message.model, tokens.toString('utf8'), meta, message.threads);
          if (stopping) { await engine.release().catch(() => undefined); return; }
          emit({ type: 'ready', loadMs: Math.round(now() - started) });
        } catch { emit({ type: 'failed', reason: 'model' }); }
      }).finally(() => { starting = false; });
    } else if (message.type === 'recognize') {
      chain = chain.then(async () => {
        if (!engine || stopping) { emit({ type: 'error', id: message.id }); return; }
        const started = now();
        try {
          const result = await engine.recognize(wavSamples(message.wav), message.language);
          emit({ type: 'result', id: message.id, text: result.text.slice(0, 4000), ms: Math.round(now() - started),
            // Only when asked (listening/watching transcription): the closed tags, never anything else from the model.
            ...(message.tags ? { tags: { language: result.language, event: result.event, emotion: result.emotion } } : {}) });
        } catch { emit({ type: 'error', id: message.id }); }
      });
    } else if (message.type === 'stop') {
      stopping = true;
      // After the request in hand (if any): release the session, then leave on our own.
      void chain.then(() => engine?.release()).catch(() => undefined).finally(() => exit(0));
    }
  });
}

function defaultRuntime(entry: string): AsrOrtLike {
  // Loaded from the downloaded component folder (absolute path from the main process), never bundled.
  return createRequire(__filename)(entry) as AsrOrtLike;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) startAsrWorker(parentPort);
