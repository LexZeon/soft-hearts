/**
 * Entry of the embedding utilityProcess (built to dist-electron/semantic-worker.cjs).
 *
 * Receives: the component paths, then one embed request at a time (a few short texts). Sends: only the messages in
 * protocol.ts. No network, no file writes, nothing kept after a request. On "stop" it releases the ONNX session first and
 * then ends itself without the normal exit path, like the speech and pose workers (docs/claude/2026-11-03-pose-exit-hang.md).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { EmbeddingEngine, type EmbedOrtLike } from './engine';
import { parseSemanticHostMessage, type SemanticWorkerToHost } from './protocol';

interface ParentPortLike { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void }

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Ends this process at once, without the normal exit path (nothing here needs flushing: no files are written). */
export function endProcess(): void {
  process.kill(process.pid, 'SIGKILL');
}

export function startSemanticWorker(parent: ParentPortLike, loadRuntime: (entry: string) => EmbedOrtLike = defaultRuntime,
  exit: (code: number) => void = () => endProcess(), now: () => number = () => performance.now()): void {
  let engine: EmbeddingEngine | null = null;
  let starting = false, stopping = false;
  let chain: Promise<void> = Promise.resolve();
  const emit = (message: SemanticWorkerToHost) => parent.postMessage(message);
  parent.on('message', event => {
    const message = parseSemanticHostMessage(event.data);
    if (!message || stopping) return;
    if (message.type === 'init' && !engine && !starting) {
      if (![message.runtimeEntry, message.model, message.vocab].every(p => path.isAbsolute(p))) return;
      starting = true;
      const started = now();
      chain = chain.then(async () => {
        let ort: EmbedOrtLike;
        try { ort = loadRuntime(message.runtimeEntry); } catch { emit({ type: 'failed', reason: 'runtime' }); return; }
        try {
          const info = await stat(message.model);
          const vocab = await readFile(message.vocab);
          if (info.size !== message.modelSize || createHash('sha256').update(vocab).digest('hex') !== message.vocabSha256
            || await sha256File(message.model) !== message.modelSha256) throw new Error('model files changed on disk');
          engine = await EmbeddingEngine.open(ort, message.model, vocab.toString('utf8'), message.threads);
          if (stopping) { await engine.release().catch(() => undefined); return; }
          emit({ type: 'ready', loadMs: Math.round(now() - started) });
        } catch { emit({ type: 'failed', reason: 'model' }); }
      }).finally(() => { starting = false; });
    } else if (message.type === 'embed') {
      chain = chain.then(async () => {
        if (!engine || stopping) { emit({ type: 'error', id: message.id }); return; }
        const started = now();
        try {
          const vectors = await engine.embed(message.texts);
          emit({ type: 'result', id: message.id, vectors, ms: Math.round(now() - started) });
        } catch { emit({ type: 'error', id: message.id }); }
      });
    } else if (message.type === 'stop') {
      stopping = true;
      void chain.then(() => engine?.release()).catch(() => undefined).finally(() => exit(0));
    }
  });
}

function defaultRuntime(entry: string): EmbedOrtLike {
  // Loaded from the downloaded component folder (absolute path from the main process), never bundled.
  return createRequire(__filename)(entry) as EmbedOrtLike;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) startSemanticWorker(parentPort);
