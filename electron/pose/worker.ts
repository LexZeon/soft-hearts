/**
 * Entry of the pose inference utilityProcess (built to dist-electron/pose-worker.cjs).
 *
 * Receives: the component paths from the main process, then a MessagePort to the hidden sensor window that
 * carries small RGBA frames. Sends: only the messages in protocol.ts (abstract signals, route and level).
 * No network, no chat content, no file writes; frames and keypoints are dropped after each frame.
 *
 * Ending (camera off, app quit, a CPU failure): stop taking frames → let the frame or self-test in flight finish
 * → release every inference session → end the process (see `endProcess`). The main process kills it only if
 * that has not happened in time (worker-exit.ts).
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sha256 } from './archive';
import { PoseEngine, type ModelBytes, type OrtLike } from './engine';
import { parseSensorFrame, type HostToWorker, type WorkerInit, type WorkerToHost, type WorkerToSensor } from './protocol';

interface PortLike { on(event: 'message', listener: (event: { data: unknown; ports?: PortLike[] }) => void): void; postMessage(message: unknown): void; start(): void; close(): void }
interface ParentPortLike { on(event: 'message', listener: (event: { data: unknown; ports: PortLike[] }) => void): void; postMessage(message: unknown): void }
/** stopped: the host asked; failed: CPU inference failed (the host restarts the process within its limit). */
export type WorkerEnd = 'stopped' | 'failed';

export function startPoseWorker(parent: ParentPortLike, loadRuntime: (entry: string) => OrtLike = defaultRuntime,
  end: (reason: WorkerEnd) => void = endProcess): void {
  let engine: PoseEngine | null = null;
  let sensor: PortLike | null = null;
  let init: WorkerInit | null = null;
  let ending = false;
  const emit = (message: WorkerToHost) => { if (!ending) parent.postMessage(message); };
  const tell = (message: WorkerToSensor) => sensor?.postMessage(message);
  const loadModels = async (): Promise<ModelBytes> => {
    const [detector, pose] = await Promise.all([readFile(init!.detector), readFile(init!.pose)]);
    if (sha256(detector) !== init!.detectorSha256 || sha256(pose) !== init!.poseSha256) throw new Error('model files changed on disk');
    return { detector, pose };
  };
  const finish = (reason: WorkerEnd) => {
    if (ending) return;
    ending = true;
    // 1. No more frames: the sensor window is told to pause and the port is closed.
    try { tell({ type: 'fps', fps: 0 }); sensor?.close(); } catch { /* the window is already gone */ }
    sensor = null;
    // 2. The frame or self-test in flight finishes, then every session is released (PoseEngine.dispose).
    // 3. Only then does the process end.
    void (engine?.dispose() ?? Promise.resolve()).catch(() => undefined).then(() => end(reason));
  };
  parent.on('message', event => {
    const message = event.data as HostToWorker;
    if (ending || !message || typeof message !== 'object') return;
    if (message.type === 'init' && !engine) {
      if (![message.runtimeEntry, message.detector, message.pose].every(p => typeof p === 'string' && path.isAbsolute(p))) return;
      init = message;
      let ort: OrtLike;
      try { ort = loadRuntime(message.runtimeEntry); }
      catch { emit({ type: 'failed', reason: 'runtime' }); return; }
      engine = new PoseEngine({ ort, loadModels, emit: msg => { emit(msg); if (msg.type === 'level' || msg.type === 'route') tell({ type: 'fps', fps: engine!.desiredFps() }); } });
      void engine.init({ prefer: message.prefer, dmlBad: message.dmlBad === true });
    } else if (message.type === 'port' && event.ports[0] && !sensor) {
      sensor = event.ports[0];
      sensor.on('message', frameEvent => {
        if (ending || !engine) return;
        const frame = parseSensorFrame(frameEvent.data);
        if (!frame) { tell({ type: 'ack', fps: engine.desiredFps() }); return; } // malformed: drop it, keep the sensor going
        engine.frame(frame.rgba, frame.width, frame.height).then(
          () => { if (!ending) tell({ type: 'ack', fps: engine!.desiredFps() }); },
          () => finish('failed')); // a CPU failure ends this process; the host restarts it within its limit
      });
      sensor.start();
      tell({ type: 'fps', fps: engine?.desiredFps() ?? 1 });
    } else if (message.type === 'pressure') engine?.setPressure(message.on === true);
    else if (message.type === 'stop') finish('stopped');
  });
}

function defaultRuntime(entry: string): OrtLike {
  // Loaded from the downloaded component folder (absolute path from the main process), never bundled.
  return createRequire(__filename)(entry) as OrtLike;
}

/**
 * Ends this process at once, without the normal exit path (2026-11-03, docs/claude/2026-11-03-pose-exit-hang.md).
 * After DirectML inference, `process.exit(0)` (sessions already released) reported its exit and then stayed
 * stuck with a single thread, impossible to kill until a restart — the normal exit runs the libraries' unload
 * code after every other thread is gone. On a freshly copied package even a worker that loaded nothing native
 * lingered ~8 s after reporting its exit. Nothing here needs flushing: the process writes no files, and by now
 * every session is released and no frame is in flight. The system reports exit code 1; the host does not read it.
 */
export function endProcess(): void {
  process.kill(process.pid, 'SIGKILL');
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) startPoseWorker(parentPort);
