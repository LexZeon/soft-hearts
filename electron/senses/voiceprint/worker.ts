/**
 * Entry of the voiceprint utilityProcess (built to dist-electron/voiceprint-worker.cjs), Unbound v1 step 3.
 *
 * Receives: the component paths, then one clip of samples at a time. Sends: only the messages in protocol.ts (192 numbers per clip).
 * No network, no file writes, nothing kept after an answer. On "stop" it releases the session and ends itself without the normal exit
 * path, like the pose, speech, recall and face workers (docs/claude/2026-11-03-pose-exit-hang.md).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SpeakerEngine, type VoiceOrtLike } from './engine';
import { parseVoiceprintHostMessage, type VoiceprintWorkerToHost } from './protocol';

interface ParentPortLike { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void }

export function endProcess(): void { process.kill(process.pid, 'SIGKILL'); }

export function startVoiceprintWorker(parent: ParentPortLike, loadRuntime: (entry: string) => VoiceOrtLike = defaultRuntime,
  exit: (code: number) => void = () => endProcess(), now: () => number = () => performance.now()): void {
  let engine: SpeakerEngine | null = null;
  let starting = false, stopping = false;
  let chain: Promise<void> = Promise.resolve();
  const emit = (message: VoiceprintWorkerToHost) => parent.postMessage(message);
  parent.on('message', event => {
    const message = parseVoiceprintHostMessage(event.data);
    if (!message || stopping) return;
    if (message.type === 'init' && !engine && !starting) {
      if (!path.isAbsolute(message.runtimeEntry) || !path.isAbsolute(message.model)) return;
      starting = true;
      const started = now();
      chain = chain.then(async () => {
        let ort: VoiceOrtLike;
        try { ort = loadRuntime(message.runtimeEntry); } catch { emit({ type: 'failed', reason: 'runtime' }); return; }
        try {
          // Read once, checked, then handed to ONNX Runtime as bytes (a swapped file fails closed).
          const model = await readFile(message.model);
          if (model.byteLength !== message.modelSize || createHash('sha256').update(model).digest('hex') !== message.modelSha256) throw new Error('model file changed on disk');
          engine = await SpeakerEngine.open(ort, model, message.threads);
          if (stopping) { await engine.release(); return; }
          emit({ type: 'ready', loadMs: Math.round(now() - started) });
        } catch { emit({ type: 'failed', reason: 'model' }); }
      }).finally(() => { starting = false; });
    } else if (message.type === 'embed') {
      chain = chain.then(async () => {
        if (!engine || stopping) { emit({ type: 'error', id: message.id }); return; }
        const started = now();
        try { emit({ type: 'result', id: message.id, vector: await engine.embed(message.samples), ms: Math.round(now() - started) }); }
        catch { emit({ type: 'error', id: message.id }); }
      });
    } else if (message.type === 'stop') {
      stopping = true;
      void chain.then(() => engine?.release()).catch(() => undefined).finally(() => exit(0));
    }
  });
}

function defaultRuntime(entry: string): VoiceOrtLike {
  // Loaded from the component folder (absolute path from the main process), never bundled.
  return createRequire(__filename)(entry) as VoiceOrtLike;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) startVoiceprintWorker(parentPort);
