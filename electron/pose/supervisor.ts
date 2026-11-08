/**
 * Main-process side of local pose sensing: starts/stops the inference process and the hidden sensor window
 * with the camera switch, restarts after a crash with backoff and a hard limit, and validates every message.
 * The pet never waits on it; a dead or stuck sensing process only means "no signal".
 */
import type { PoseLevel, PoseSignal } from '../../shared/pose-signals';
import { parseWorkerMessage, type HostToWorker, type WorkerInit } from './protocol';
import { QUIT_GRACE_MS, STOP_GRACE_MS, WorkerExits, type ExitOutcome } from './worker-exit';

export interface WorkerHandle {
  postMessage(message: HostToWorker, transfer?: unknown[]): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}
export interface SensorHandle { close(): void }
export type SensorStatus = 'started' | 'camera-error' | 'camera-ended' | 'gone';
export interface ChannelPair { worker: unknown; sensor: unknown }

export interface SupervisorDeps {
  /** Component paths + cached route; null when the component is not installed. */
  prepare(): Promise<Omit<WorkerInit, 'type'> | null>;
  fork(): WorkerHandle;
  channel(): ChannelPair;
  openSensor(port: unknown, status: (status: SensorStatus) => void): SensorHandle;
  saveRoute(result: { route: 'dml' | 'cpu'; dmlBad: boolean; p90: { dml: number | null; cpu: number | null } }): void;
  /** Turn the camera switch off (crash limit reached, too slow, camera unavailable). */
  disableCamera(reason: 'crashed' | 'too-slow' | 'camera-unavailable' | 'failed'): void;
  changed(): void;
  signal?(signal: PoseSignal): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const RESTART_DELAYS_MS = [5_000, 20_000, 60_000] as const;
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_LIMIT = 3;
const READY_TIMEOUT_MS = 90_000;
/** No signal this long after the camera should be open (or between two signals): treat as a stall and restart. */
export const FIRST_SIGNAL_MS = 20_000;
export const SIGNAL_GAP_MS = 10_000;

export type SupervisorPhase = 'off' | 'starting' | 'running' | 'restarting';
/** Signal categories and counts only (developer diagnostics); never coordinates, images or text. */
export type PoseDiagnosticCategory = 'present' | 'absent' | 'wave' | 'stretch' | 'rhythm' | 'gpu-fallback' | 'level-change' | 'restart' | 'crash' | 'too-slow' | 'camera-unavailable'
  | 'stop-killed' | 'stop-unresponsive';

interface WorkerSlot { handle: WorkerHandle; exited: Promise<void> }

export class PoseSupervisor {
  phase: SupervisorPhase = 'off';
  route: 'gpu' | 'cpu' | null = null;
  level: PoseLevel | null = null;
  latest: PoseSignal | null = null;
  readonly diagnostics = new Map<PoseDiagnosticCategory, number>();
  private wanted = false;
  /** App quit has begun: nothing new starts. */
  private closing = false;
  private worker: WorkerSlot | null = null;
  private readonly exits: WorkerExits;
  private sensor: SensorHandle | null = null;
  private generation = 0;
  private crashes: number[] = [];
  private timer: unknown = null;
  private readyTimer: unknown = null;
  private watchdog: unknown = null;
  private wasPresent = false;
  private wasRhythm = false;
  private pressure = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: SupervisorDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.exits = new WorkerExits({ now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer });
  }

  get running(): boolean { return this.phase !== 'off'; }
  /** An inference process is alive or still ending. */
  get busy(): boolean { return !!this.worker || this.exits.pending > 0; }
  private count(category: PoseDiagnosticCategory): void { this.diagnostics.set(category, (this.diagnostics.get(category) ?? 0) + 1); }

  /** Follows the camera switch: on starts (if installed), off stops at once. */
  setWanted(on: boolean): void {
    if (on && this.closing) return;
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) { this.crashes = []; void this.start(); }
    else this.stop();
  }

  private async start(): Promise<void> {
    if (!this.wanted || this.worker || this.closing) return;
    const generation = ++this.generation;
    this.phase = 'starting'; this.deps.changed();
    const init = await this.deps.prepare().catch(() => null);
    // A process asked to stop (camera off and on again quickly, or a restart) ends first: two inference
    // processes never hold the graphics card at once.
    if (this.exits.pending) await this.exits.settled();
    if (generation !== this.generation || !this.wanted || this.closing) return;
    if (!init) { this.giveUp('failed'); return; }
    let handle: WorkerHandle;
    try { handle = this.deps.fork(); } catch { this.crashed(generation); return; }
    let exited!: () => void;
    const worker: WorkerSlot = { handle, exited: new Promise<void>(resolve => { exited = resolve; }) };
    this.worker = worker;
    handle.onMessage(raw => { if (generation === this.generation) this.onMessage(raw, generation); });
    handle.onExit(() => {
      exited();
      if (generation === this.generation && this.worker === worker) { this.worker = null; this.crashed(generation); }
    });
    handle.postMessage({ type: 'init', ...init });
    this.readyTimer = this.setTimer(() => {
      this.readyTimer = null;
      if (generation === this.generation && this.phase === 'starting') { this.kill(); this.crashed(generation); }
    }, READY_TIMEOUT_MS);
  }

  private onMessage(raw: unknown, generation: number): void {
    const message = parseWorkerMessage(raw);
    if (!message || !this.worker) return;
    switch (message.type) {
      case 'ready': {
        if (this.phase !== 'starting') return;
        this.clearTimer(this.readyTimer);
        this.route = message.route === 'dml' ? 'gpu' : 'cpu'; this.level = message.level;
        this.deps.saveRoute({ route: message.route, dmlBad: message.dmlBad, p90: message.p90 });
        const pair = this.deps.channel();
        this.worker.handle.postMessage({ type: 'port' }, [pair.worker]);
        if (this.pressure) this.worker.handle.postMessage({ type: 'pressure', on: true });
        this.sensor = this.deps.openSensor(pair.sensor, status => { if (generation === this.generation) this.onSensor(status, generation); });
        this.phase = 'running'; this.deps.changed();
        this.arm(FIRST_SIGNAL_MS, generation);
        return;
      }
      case 'signal': {
        if (this.phase !== 'running') return;
        const signal = message.signal;
        this.latest = signal;
        this.arm(SIGNAL_GAP_MS, generation);
        if (signal.present !== this.wasPresent) this.count(signal.present ? 'present' : 'absent');
        if (signal.rhythm && !this.wasRhythm) this.count('rhythm');
        for (const event of signal.events) if (event === 'wave' || event === 'stretch') this.count(event);
        this.wasPresent = signal.present; this.wasRhythm = signal.rhythm;
        this.deps.signal?.(signal);
        return;
      }
      case 'route': this.route = 'cpu'; this.count('gpu-fallback'); this.deps.saveRoute({ route: 'cpu', dmlBad: true, p90: { dml: null, cpu: null } }); this.deps.changed(); return;
      case 'level': this.level = message.level; this.count('level-change'); this.deps.changed(); return;
      case 'paused': this.count('too-slow'); this.giveUp('too-slow'); return;
      case 'failed': this.giveUp('failed'); return;
    }
  }

  /** A sensor window that never delivers frames, or an inference process that stops answering, ends in a restart. */
  private arm(ms: number, generation: number): void {
    if (this.watchdog) this.clearTimer(this.watchdog);
    this.watchdog = this.setTimer(() => {
      this.watchdog = null;
      if (generation !== this.generation || this.phase !== 'running') return;
      this.closeSensor(); this.kill(); this.crashed(generation);
    }, ms);
  }

  private onSensor(status: SensorStatus, generation: number): void {
    if (status === 'started') return;
    if (status === 'gone') { this.sensor = null; this.kill(); this.crashed(generation); return; }
    this.count('camera-unavailable');
    this.giveUp('camera-unavailable'); // the system blocked the camera or it was unplugged: do not keep retrying
  }

  private crashed(generation: number): void {
    if (generation !== this.generation || !this.wanted) return;
    if (this.watchdog) { this.clearTimer(this.watchdog); this.watchdog = null; }
    this.closeSensor();
    this.count('crash');
    const now = this.now();
    this.crashes = [...this.crashes.filter(at => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) { this.giveUp('crashed'); return; }
    this.phase = 'restarting'; this.latest = null; this.deps.changed();
    const delay = RESTART_DELAYS_MS[Math.min(this.crashes.length, RESTART_DELAYS_MS.length) - 1];
    this.timer = this.setTimer(() => { this.timer = null; if (generation === this.generation && this.wanted) { this.count('restart'); void this.start(); } }, delay);
  }

  private giveUp(reason: 'crashed' | 'too-slow' | 'camera-unavailable' | 'failed'): void {
    this.stop();
    this.deps.disableCamera(reason);
  }

  private closeSensor(): void { const sensor = this.sensor; this.sensor = null; sensor?.close(); }
  /**
   * Ends the current inference process: "stop" lets it finish the frame in flight, release its sessions and end
   * itself (worker.ts); it is killed only if it has not ended in time (worker-exit.ts).
   */
  private kill(): void {
    const worker = this.worker; this.worker = null;
    if (!worker) return;
    const { handle } = worker;
    void this.exits.retire({ stop: () => handle.postMessage({ type: 'stop' }), kill: () => handle.kill(), exited: worker.exited },
      this.closing ? QUIT_GRACE_MS : STOP_GRACE_MS).then(outcome => this.noteExit(outcome));
  }
  private noteExit(outcome: ExitOutcome): void {
    if (outcome === 'killed') this.count('stop-killed');
    else if (outcome === 'unresponsive') this.count('stop-unresponsive');
  }

  /** Off: camera closed first (sensor window destroyed), then the inference process. */
  stop(): void {
    this.wanted = false;
    this.generation++;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.readyTimer) { this.clearTimer(this.readyTimer); this.readyTimer = null; }
    if (this.watchdog) { this.clearTimer(this.watchdog); this.watchdog = null; }
    this.closeSensor();
    this.kill();
    this.phase = 'off'; this.route = null; this.level = null; this.latest = null; this.wasPresent = false; this.wasRhythm = false;
    this.deps.changed();
  }

  /**
   * App quit: stop, start nothing new, and resolve once the inference process has ended (by itself after
   * "stop", or killed after QUIT_GRACE_MS; one that does not even go away when killed is given up on after
   * KILL_WAIT_MS more). Bounded, so quitting never hangs on it.
   */
  shutdown(): Promise<void> {
    this.closing = true;
    if (this.phase !== 'off' || this.worker) this.stop();
    this.exits.hurry(QUIT_GRACE_MS);
    return this.exits.settled();
  }

  /** Battery / heavy load: the inference process drops one step while this is on. */
  setPressure(on: boolean): void {
    this.pressure = on;
    try { if (this.phase === 'running') this.worker?.handle.postMessage({ type: 'pressure', on }); } catch { /* restarting */ }
  }
}
