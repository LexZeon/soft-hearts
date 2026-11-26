/**
 * The worker thread that starts and ends the brain's Claude Code processes (see index.ts for why). One worker for the whole run, made on
 * first use. The main thread keeps a stand-in per process (OffMainChild) with the same small surface the brain used on a ChildProcess:
 * stdin write/end and its error, stdout/stderr text, 'error' and 'close' once, kill, plus terminate (taskkill of the tree on Windows).
 *
 * Order is kept: every request goes to the worker in the order it was made (start, write, end, terminate), and every event comes back in
 * the order the real process gave it (stdout before 'close'). Stdin waits on the main thread until the process is up, and is dropped if the
 * process was ended before that (OffMainChild, "up gate"): a process its owner let go of while it was starting gets nothing. The worker holds the app's event loop open only while it has something to
 * do or a process alive, like a ChildProcess on the main thread would; it never keeps the app from quitting (Electron does not wait).
 * The worker going away (it should not) ends every stand-in with 'close' (null); the next start makes a new worker.
 */
import { Worker } from 'node:worker_threads';
import type { ClaudeChild, ClaudeChildInput, ClaudeChildOutput, ClaudeLaunchOptions } from './index';

// The worker's whole program (eval'd: nothing to bundle or ship). In: spawn, write, end, kill, terminate {id}; taskkill {id, pid}; every
// message carries `seq` and is acknowledged with ack {seq} once acted on (for terminate: once taskkill.exe has been started). Out: spawned
// {id, pid}, stdout/stderr {id, chunk}, stdin-error, error {id, code, message}, close {id, code}, taskkilled {id}.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const children = new Map();
const post = message => parentPort.postMessage(message);
const failure = error => ({ code: error && typeof error.code === 'string' ? error.code : undefined, message: String((error && error.message) || error) });
function taskkill(pid, done) {
  const file = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
  try { execFile(file, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done()); } catch { done(); }
}
function act(message) {
  const id = message.id, entry = children.get(id);
  switch (message.type) {
    case 'spawn': {
      let child;
      try { child = spawn(String(message.file), (message.args || []).map(String), { ...message.options, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { post({ type: 'error', id, ...failure(error) }); post({ type: 'close', id, code: null }); return; }
      const own = { child, closed: false };
      children.set(id, own);
      post({ type: 'spawned', id, pid: typeof child.pid === 'number' ? child.pid : null });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => post({ type: 'stdout', id, chunk }));
      child.stderr.on('data', chunk => post({ type: 'stderr', id, chunk }));
      child.stdin.on('error', error => post({ type: 'stdin-error', id, ...failure(error) }));
      child.once('error', error => post({ type: 'error', id, ...failure(error) }));
      child.once('close', code => { own.closed = true; children.delete(id); post({ type: 'close', id, code: typeof code === 'number' ? code : null }); });
      return;
    }
    case 'write': if (entry) { try { entry.child.stdin.write(String(message.text)); } catch {} } return;
    case 'end': if (entry) { try { typeof message.text === 'string' ? entry.child.stdin.end(message.text) : entry.child.stdin.end(); } catch {} } return;
    case 'kill': if (entry && !entry.closed) { try { entry.child.kill(); } catch {} } return;
    case 'terminate':
      // What electron/brain/claude.ts terminateClaude did on the main thread: the tree on Windows, a plain kill if it still has not closed.
      if (!entry || entry.closed) return;
      if (process.platform === 'win32' && entry.child.pid) taskkill(entry.child.pid, () => { if (!entry.closed) { try { entry.child.kill(); } catch {} } });
      else { try { entry.child.kill(); } catch {} }
      return;
    case 'taskkill': taskkill(Number(message.pid), () => post({ type: 'taskkilled', id })); return;
  }
}
parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return;
  try { act(message); } finally { post({ type: 'ack', seq: message.seq }); }
});
`;

type Listener<T> = (value: T) => void;
/** A listener's own fault never stops the others (it still surfaces, as an uncaught error, like one in a ChildProcess listener). */
function call<T>(listeners: Listener<T>[], value: T): void {
  for (const listener of listeners) { try { listener(value); } catch (error) { queueMicrotask(() => { throw error; }); } }
}

class OffMainOutput implements ClaudeChildOutput {
  readonly listeners: Listener<string>[] = [];
  setEncoding(_encoding?: 'utf8'): this { return this; } // always UTF-8 text
  on(_event: 'data', listener: Listener<string>): this { this.listeners.push(listener); return this; }
}

class OffMainInput implements ClaudeChildInput {
  readonly errors: Listener<Error>[] = [];
  ended = false;
  destroyed = false;
  constructor(private readonly child: OffMainChild) {}
  get writable(): boolean { return !this.ended && !this.destroyed; }
  write(text: string): boolean {
    if (!this.writable) return false;
    this.child.input({ type: 'write', text: String(text) });
    return true;
  }
  end(text?: string): this {
    if (this.ended) return this;
    this.ended = true;
    if (!this.destroyed) this.child.input({ type: 'end', ...(typeof text === 'string' ? { text } : {}) });
    return this;
  }
  on(_event: 'error', listener: Listener<Error>): this { this.errors.push(listener); return this; }
}

function errorFrom(message: { code?: string; message?: string }): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message.message || 'Claude Code could not be started.');
  if (message.code) error.code = message.code;
  return error;
}

/**
 * The main thread's stand-in for one process the worker started.
 *
 * Up gate (docs/claude/2026-11-23-unbound-step6.md, section "退出后才起来的进程不再收到请求"): what is written to stdin leaves the main
 * thread only once the worker has told it the process is up ('spawned'). Until then it is held here, and an end of the process asked for
 * meanwhile (terminate or kill: a quit, a cancelled warm, a dropped replacement, a stopped call, a switch) throws it away. A process that
 * comes up after its owner let go of it is ended the moment it is up with nothing written to it, whatever order the worker gets to things
 * in: the decision is made here, on the thread where the owner let go, not in the worker's queue. (Without it, a hidden warm request
 * written while its process was still starting reached Claude Code after the user had quit.)
 */
export class OffMainChild implements ClaudeChild {
  readonly stdin: OffMainInput;
  readonly stdout = new OffMainOutput();
  readonly stderr = new OffMainOutput();
  pid: number | undefined = undefined;
  /** 'close' has come (or the worker went away). */
  closed = false;
  /** The worker has said the process is up ('spawned'): stdin goes straight to it from now on. */
  up = false;
  /** Asked to end (terminate or kill) before it was up: nothing held is ever sent. */
  private withheld = false;
  /** Stdin (writes and the end) asked for before it was up, in order. */
  private held: Record<string, unknown>[] = [];
  private readonly errors: Listener<NodeJS.ErrnoException>[] = [];
  private readonly closes: Listener<number | null>[] = [];
  constructor(private readonly launcher: OffMainClaudeLauncher, readonly id: number) { this.stdin = new OffMainInput(this); }

  /** @internal: stdin for the process: sent once it is up, held until then, dropped if it was ended first. */
  input(message: Record<string, unknown>): void {
    if (this.withheld || this.closed) return;
    if (this.up) this.send(message); else this.held.push(message);
  }
  /** Ended before it was up: what was held goes nowhere, and its stdin takes nothing more. */
  private withhold(): void {
    if (this.up) return;
    this.withheld = true;
    this.held = [];
    this.stdin.destroyed = true;
  }

  once(event: 'error', listener: Listener<NodeJS.ErrnoException>): this;
  once(event: 'close', listener: Listener<number | null>): this;
  once(event: 'error' | 'close', listener: Listener<never>): this {
    if (event === 'error') this.errors.push(listener as Listener<NodeJS.ErrnoException>);
    else this.closes.push(listener as Listener<number | null>);
    return this;
  }
  kill(): boolean { if (this.closed) return false; this.withhold(); this.send({ type: 'kill' }); return true; }
  terminate(): void { if (this.closed) return; this.withhold(); this.send({ type: 'terminate' }); }

  /** @internal */ send(message: Record<string, unknown>): void { this.launcher.post({ ...message, id: this.id }); }
  /** @internal: one event from the worker. */
  receive(message: { type: string; pid?: number | null; chunk?: string; code?: unknown; message?: string }): void {
    switch (message.type) {
      case 'spawned': {
        this.pid = typeof message.pid === 'number' ? message.pid : undefined;
        if (this.up || this.withheld || this.closed) return;
        this.up = true;
        const held = this.held.splice(0);
        for (const input of held) this.send(input);
        return;
      }
      case 'stdout': if (typeof message.chunk === 'string') call(this.stdout.listeners, message.chunk); return;
      case 'stderr': if (typeof message.chunk === 'string') call(this.stderr.listeners, message.chunk); return;
      case 'stdin-error': {
        if (this.stdin.destroyed) return;
        this.stdin.destroyed = true;
        call(this.stdin.errors, errorFrom(message as { code?: string; message?: string }));
        return;
      }
      case 'error': { const listeners = this.errors.splice(0); call(listeners, errorFrom(message as { code?: string; message?: string })); return; }
      case 'close': this.ended(typeof message.code === 'number' ? message.code : null); return;
    }
  }
  /** @internal */ ended(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.held = [];
    this.stdin.destroyed = true;
    const listeners = this.closes.splice(0);
    call(listeners, code);
  }
}

interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error' | 'exit', listener: () => void): unknown;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

/** The shared worker and what it runs. Exported for tests (a fresh one each). */
export class OffMainClaudeLauncher {
  private worker: WorkerLike | null = null;
  private next = 1;
  private seq = 1;
  private readonly children = new Map<number, OffMainChild>();
  private readonly taskkills = new Map<number, () => void>();
  /** Requests the worker has not acted on yet (seq numbers). */
  private readonly unacknowledged = new Set<number>();
  private idleWaiters: (() => void)[] = [];
  private referenced = false;
  constructor(private readonly makeWorker: () => WorkerLike = () => new Worker(WORKER_SOURCE, { eval: true })) {}

  launch(file: string, args: readonly string[], options: ClaudeLaunchOptions): OffMainChild {
    const id = this.next++;
    const child = new OffMainChild(this, id);
    this.children.set(id, child);
    const { cwd, shell, windowsHide, env } = options;
    if (!this.post({ type: 'spawn', id, file: String(file), args: args.map(String), options: { cwd, shell, windowsHide, env: { ...env } } })) {
      // No worker at all: the same events a ChildProcess gives when it cannot start.
      queueMicrotask(() => { child.receive({ type: 'error', message: 'Claude Code could not be started (no worker thread).' }); this.end(id); });
    }
    return child;
  }

  taskkill(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
    const id = this.next++;
    return new Promise<void>(resolve => {
      this.taskkills.set(id, resolve);
      if (!this.post({ type: 'taskkill', id, pid })) { this.taskkills.delete(id); resolve(); }
    });
  }

  /** True once every request so far has been acted on (and every taskkill has ended); false after `limitMs`. */
  settled(limitMs: number): Promise<boolean> {
    if (this.idle()) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let done = false;
      const finish = (value: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish(false), Math.max(0, limitMs));
      this.idleWaiters.push(() => finish(true));
    });
  }

  /** Ends every process and the worker (tests; the app's end with it anyway). */
  async close(): Promise<void> {
    for (const child of [...this.children.values()]) child.terminate();
    await this.settled(5_000);
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => 0);
    this.gone();
  }

  /** @internal: false when there is no worker to send it to. */
  post(message: Record<string, unknown>): boolean {
    const worker = this.ensure();
    if (!worker) return false;
    const seq = this.seq++;
    this.unacknowledged.add(seq);
    this.hold();
    try { worker.postMessage({ ...message, seq }); return true; }
    catch { this.unacknowledged.delete(seq); this.release(); return false; }
  }

  private ensure(): WorkerLike | null {
    if (this.worker) return this.worker;
    let worker: WorkerLike;
    try { worker = this.makeWorker(); } catch { return null; }
    worker.unref();
    this.referenced = false;
    worker.on('message', (raw: unknown) => {
      const message = raw as { type?: string; id?: number; seq?: number };
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ack') { if (typeof message.seq === 'number') this.unacknowledged.delete(message.seq); this.release(); return; }
      if (message.type === 'taskkilled') { const done = this.taskkills.get(message.id as number); this.taskkills.delete(message.id as number); done?.(); this.release(); return; }
      const child = typeof message.id === 'number' ? this.children.get(message.id) : undefined;
      if (!child) return;
      child.receive(message as { type: string });
      if (message.type === 'close') this.end(child.id);
    });
    // The worker went away (it should not): every process it ran counts as ended; the next start makes a new worker.
    const gone = () => { if (this.worker !== worker) return; this.worker = null; this.gone(); };
    worker.on('error', gone);
    worker.on('exit', gone);
    this.worker = worker;
    return worker;
  }

  private end(id: number): void {
    const child = this.children.get(id);
    this.children.delete(id);
    child?.ended(null);
    this.release();
  }

  private gone(): void {
    this.unacknowledged.clear();
    for (const id of [...this.children.keys()]) this.end(id);
    for (const [id, done] of [...this.taskkills]) { this.taskkills.delete(id); done(); }
    this.release();
  }

  private idle(): boolean { return this.unacknowledged.size === 0 && this.taskkills.size === 0; }

  /** Busy (a request pending or a process alive): the worker keeps the event loop open, as a ChildProcess would. */
  private hold(): void { if (!this.referenced && this.worker) { this.referenced = true; this.worker.ref(); } }
  private release(): void {
    if (this.idle()) { const waiters = this.idleWaiters.splice(0); for (const waiter of waiters) waiter(); }
    if (this.referenced && this.idle() && this.children.size === 0) { this.referenced = false; this.worker?.unref(); }
  }
}
