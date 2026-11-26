/**
 * Unbound v1 step 6 (docs/claude/2026-11-23-unbound-step6.md): start a helper process without stopping the main thread.
 *
 * Node's `spawn` creates the process synchronously on the calling thread. In this app's main process that is the browser's UI thread, which
 * also hands every mouse event to the windows: measured with scripts/unbound/step6-probe.mjs on 2026-11-23, one `spawn` of Windows
 * PowerShell took 802 ms the first time she went full screen (the monitor-size helper) and 26-152 ms every time after (the full-screen
 * helper), and a synthetic mouse move waited exactly as long. So the helpers she starts are started from a worker thread instead: the main
 * thread only posts a message, the worker calls `spawn` and relays the output. One worker for all of them, made on first use, `unref`'d (it
 * never keeps the app from quitting), with stdout only (stdin and stderr ignored, as the helpers had them).
 *
 * Only for helpers this part starts itself (the full-screen watch, the monitor sizes). Claude Code processes are not started here: the brain
 * has its own worker for them (electron/brain/claude-launch/, full stdin/stdout/stderr and the tree kill), with the one hook the test
 * harnesses use to stand in for Claude Code.
 */
import { Worker } from 'node:worker_threads';

/** The part of a child process the helpers use. */
export interface HelperProcess {
  /** Text from the helper's stdout (UTF-8), in pieces as they come. */
  onData(listener: (chunk: string) => void): void;
  /** Once, when it has ended (code, or null when it was killed or could not start). */
  onExit(listener: (code: number | null) => void): void;
  /** Ends it (nothing happens when it already ended). */
  kill(): void;
  readonly ended: boolean;
}
export type HelperSpawn = (command: string, args: readonly string[]) => HelperProcess;

// The worker's whole program (eval'd: nothing to bundle or ship). Messages in: spawn {id, command, args}, kill {id}. Out: data, exit.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const children = new Map();
parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'kill') { const child = children.get(message.id); if (child) { try { child.kill(); } catch {} } return; }
  if (message.type !== 'spawn') return;
  const id = message.id;
  let child;
  try { child = spawn(String(message.command), (message.args || []).map(String), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { parentPort.postMessage({ type: 'exit', id, code: null }); return; }
  children.set(id, child);
  let ended = false;
  const end = code => { if (ended) return; ended = true; children.delete(id); parentPort.postMessage({ type: 'exit', id, code }); };
  if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => parentPort.postMessage({ type: 'data', id, chunk })); }
  child.once('error', () => end(null));
  child.once('exit', code => end(typeof code === 'number' ? code : null));
});
`;

interface Entry { data: ((chunk: string) => void)[]; exit: ((code: number | null) => void)[]; ended: boolean; code: number | null }

/** The shared worker and what it runs. Exported for tests (a fresh one each). */
export class OffMainSpawner {
  private worker: Worker | null = null;
  private next = 1;
  private readonly entries = new Map<number, Entry>();
  constructor(private readonly makeWorker: () => Worker = () => new Worker(WORKER_SOURCE, { eval: true })) {}

  spawn(command: string, args: readonly string[]): HelperProcess {
    const id = this.next++;
    const entry: Entry = { data: [], exit: [], ended: false, code: null };
    this.entries.set(id, entry);
    const worker = this.ensure();
    if (worker) worker.postMessage({ type: 'spawn', id, command, args: [...args] });
    else this.finish(id, null);
    const self = this;
    return {
      onData(listener) { entry.data.push(listener); },
      onExit(listener) { if (entry.ended) queueMicrotask(() => listener(entry.code)); else entry.exit.push(listener); },
      kill() { if (!entry.ended) self.worker?.postMessage({ type: 'kill', id }); },
      get ended() { return entry.ended; },
    };
  }

  /** Ends every helper and the worker (tests; the app's helpers end with it anyway). */
  async close(): Promise<void> {
    for (const id of [...this.entries.keys()]) this.finish(id, null);
    const worker = this.worker; this.worker = null;
    if (worker) await worker.terminate().catch(() => 0);
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    let worker: Worker;
    try { worker = this.makeWorker(); } catch { return null; }
    worker.unref();
    worker.on('message', (message: { type?: string; id?: number; chunk?: string; code?: number | null }) => {
      const entry = typeof message?.id === 'number' ? this.entries.get(message.id) : undefined;
      if (!entry) return;
      if (message.type === 'data' && typeof message.chunk === 'string') for (const listener of entry.data) { try { listener(message.chunk); } catch { /* a listener's fault stays its own */ } }
      else if (message.type === 'exit') this.finish(message.id as number, typeof message.code === 'number' ? message.code : null);
    });
    // The worker went away (it should not): every helper it ran counts as ended; the next spawn makes a new worker.
    const gone = () => { if (this.worker !== worker) return; this.worker = null; for (const id of [...this.entries.keys()]) this.finish(id, null); };
    worker.on('error', gone);
    worker.on('exit', gone);
    this.worker = worker;
    return worker;
  }

  private finish(id: number, code: number | null): void {
    const entry = this.entries.get(id);
    if (!entry || entry.ended) return;
    entry.ended = true; entry.code = code;
    this.entries.delete(id);
    for (const listener of entry.exit) { try { listener(code); } catch { /* its own */ } }
    entry.exit.length = 0;
  }
}

let shared: OffMainSpawner | null = null;
/** The app's spawner for Unbound's helpers (one worker for the whole run). */
export const spawnOffMain: HelperSpawn = (command, args) => (shared ??= new OffMainSpawner()).spawn(command, args);
