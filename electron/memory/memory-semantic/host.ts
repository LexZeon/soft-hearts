/**
 * The "recall by meaning" model as the rest of the app sees it (user approval of the download 2026-11-13). Pure: Electron pieces
 * come in through `SemanticHostDeps` (electron/memory/memory-semantic/electron-wiring.ts).
 *
 *  - The switch (聊天记忆 > 按意思想起旧事) is OFF by default and saved in the profile. Turning it ON is the user's consent to the one-time
 *    download (about 24 MB; the runtime is copied from local pose sensing or speech recognition when either is installed). Nothing is
 *    downloaded, started or computed while it is off. Turning it off stops the process and any download.
 *  - Component: the same store, checks and clean-up as local pose sensing and speech recognition (electron/senses/pose/component-store.ts),
 *    under its own folder.
 *  - Embedding runs in its own utilityProcess on the CPU, started on first use and stopped after a while unused (it holds about
 *    160 MB); it releases its session and exits by itself, and is killed only if it does not.
 *  - Failures carry a closed category; no text, no memory, no path ever leaves.
 */
import path from 'node:path';
import { sameSemanticView, type SemanticNotice, type SemanticPhase, type SemanticRecallView } from '../../../shared/memory/memory-semantic/view';
import { MEMORY_SEMANTIC_KNOBS } from '../../../shared/memory/memory-semantic/knobs';
import { ComponentInstallError, type PoseComponentStore } from '../../senses';
import { SEMANTIC_COMPONENT_VERSION, SEMANTIC_MANIFEST, SEMANTIC_MODEL_FILES, SEMANTIC_RUNTIME_ENTRY } from './manifest';
import { parseSemanticWorkerMessage, type SemanticHostToWorker } from './protocol';

export interface SemanticWorkerHandle {
  postMessage(message: SemanticHostToWorker): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface SemanticHostDeps {
  store: PoseComponentStore | null;
  fork(): SemanticWorkerHandle;
  publish(view: SemanticRecallView): void;
  /** The saved switch (false when there is nothing saved or it cannot be read). */
  loadEnabled(): Promise<boolean>;
  saveEnabled(on: boolean): Promise<void>;
  /** The component was deleted: the vectors made with it go too. */
  removed?(): Promise<void>;
  /** How many memories have their meaning computed (for the control window's line). */
  progress?(): { indexed: number; total: number };
  threads?: number;
  /** Local pose sensing or speech recognition is installed: their runtime files are copied, so the question counts only the model. */
  sharedRuntime?(): boolean;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class SemanticError extends Error {
  constructor(readonly kind: 'off' | 'not-ready' | 'timeout' | 'failed', message: string) { super(message); this.name = 'SemanticError'; }
}

export const SEMANTIC_MODEL_DOWNLOAD_BYTES = SEMANTIC_MANIFEST.archives.filter(archive => archive.kind === 'file').reduce((sum, archive) => sum + archive.networkBytes, 0);
export const READY_TIMEOUT_MS = 60_000;
export const EMBED_TIMEOUT_MS = 20_000;
export const EXIT_GRACE_MS = 5_000;

interface Pending { resolve(vectors: Float32Array[]): void; reject(error: Error): void; timer: unknown }
interface Running { worker: SemanticWorkerHandle; ready: Promise<void>; isReady: boolean; pending: Map<string, Pending>; exited: boolean }

export class SemanticHost {
  private on = false;
  private notice: SemanticNotice = '';
  private job: { stage: 'downloading' | 'installing'; progress: number | null; controller: AbortController | null } | null = null;
  private published: SemanticRecallView | null = null;
  private running: Running | null = null;
  private idleTimer: unknown = null;
  private sequence = 0;
  private inFlight = 0;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: SemanticHostDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?(): void }).unref?.(); return handle; });
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Startup: the saved switch, the quick installed check and old-version clean-up. Never downloads. */
  async init(): Promise<void> {
    this.on = await this.deps.loadEnabled().catch(() => false);
    await this.deps.store?.refresh().catch(() => false);
    this.publish();
  }

  get enabled(): boolean { return this.on; }
  get installed(): boolean { return !!this.deps.store?.installed && !this.deps.store.working; }
  /** The switch is on and the model is installed and not being changed: embedding can be asked for. */
  get ready(): boolean { return this.on && this.installed && !this.job; }

  /** Texts -> unit vectors. Throws SemanticError (switch off, model not there, timeout, failure). */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.on) throw new SemanticError('off', 'recall by meaning is off');
    if (!this.ready) throw new SemanticError('not-ready', 'model is not installed');
    this.inFlight++;
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    try { return await this.request(texts); }
    finally { this.inFlight--; this.armIdle(); }
  }

  private async request(texts: string[]): Promise<Float32Array[]> {
    const running = await this.ensure();
    if (this.running !== running || running.exited) throw new SemanticError('failed', 'embedding process stopped');
    const id = `sem-${++this.sequence}`;
    return new Promise<Float32Array[]>((resolve, reject) => {
      const done = () => { running.pending.delete(id); this.clearTimer(entry.timer); };
      const entry: Pending = {
        resolve: vectors => { done(); resolve(vectors); },
        reject: error => { done(); reject(error); },
        timer: this.setTimer(() => { done(); reject(new SemanticError('timeout', 'embedding took too long')); this.restart(running); }, EMBED_TIMEOUT_MS),
      };
      running.pending.set(id, entry);
      try { running.worker.postMessage({ type: 'embed', id, texts }); }
      catch { entry.reject(new SemanticError('failed', 'embedding process unavailable')); this.restart(running); }
    });
  }

  private ensure(): Promise<Running> {
    if (this.running && !this.running.exited) return this.running.ready.then(() => this.running!);
    const store = this.deps.store, dir = store?.installedDir();
    const model = store?.installedFile(SEMANTIC_MODEL_FILES.model), vocab = store?.installedFile(SEMANTIC_MODEL_FILES.vocab);
    if (!store || !dir || !model || !vocab) return Promise.reject(new SemanticError('not-ready', 'model is not installed'));
    const files = SEMANTIC_MANIFEST.archives.flatMap(archive => archive.files.all ?? []);
    const modelFile = files.find(file => file.to === SEMANTIC_MODEL_FILES.model)!, vocabFile = files.find(file => file.to === SEMANTIC_MODEL_FILES.vocab)!;
    let worker: SemanticWorkerHandle;
    try { worker = this.deps.fork(); } catch { return Promise.reject(new SemanticError('failed', 'embedding process could not start')); }
    let settle!: { resolve(): void; reject(error: Error): void };
    const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    void ready.catch(() => undefined);
    const running: Running = { worker, ready, isReady: false, pending: new Map(), exited: false };
    this.running = running;
    const readyTimer = this.setTimer(() => { settle.reject(new SemanticError('timeout', 'embedder did not load in time')); this.restart(running); }, READY_TIMEOUT_MS);
    worker.onMessage(raw => {
      if (this.running !== running) return;
      const message = parseSemanticWorkerMessage(raw);
      if (!message) return;
      if (message.type === 'ready') { this.clearTimer(readyTimer); running.isReady = true; settle.resolve(); this.publish(); }
      else if (message.type === 'failed') { this.clearTimer(readyTimer); this.notice = 'failed'; settle.reject(new SemanticError('failed', `embedder ${message.reason} failed`)); this.restart(running); }
      else if (message.type === 'result') running.pending.get(message.id)?.resolve(message.vectors);
      else if (message.type === 'error') running.pending.get(message.id)?.reject(new SemanticError('failed', 'embedding failed'));
    });
    worker.onExit(() => {
      running.exited = true;
      this.clearTimer(readyTimer);
      settle.reject(new SemanticError('failed', 'embedding process exited'));
      for (const entry of [...running.pending.values()]) entry.reject(new SemanticError('failed', 'embedding process exited'));
      if (this.running === running) { this.running = null; this.publish(); }
    });
    worker.postMessage({ type: 'init', runtimeEntry: path.join(dir, ...SEMANTIC_RUNTIME_ENTRY.split('/')), model, modelSize: modelFile.size,
      modelSha256: modelFile.sha256, vocab, vocabSha256: vocabFile.sha256, threads: this.deps.threads ?? 2 });
    this.publish();
    return ready.then(() => running);
  }

  private armIdle(): void {
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    if (!this.running) return;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.inFlight) this.armIdle(); else this.stop();
    }, Math.max(1, MEMORY_SEMANTIC_KNOBS.pace.idleStopMinutes) * 60_000);
  }

  /** Ask the process to release its session and exit; kill it only if it is still there after the grace time. */
  private retire(running: Running): void {
    if (this.running === running) this.running = null;
    for (const entry of [...running.pending.values()]) entry.reject(new SemanticError('failed', 'embedding process stopped'));
    if (running.exited) return;
    try { running.worker.postMessage({ type: 'stop' }); } catch { /* already gone */ }
    this.setTimer(() => { if (!running.exited) try { running.worker.kill(); } catch { /* exited */ } }, EXIT_GRACE_MS);
  }
  private restart(running: Running): void { this.retire(running); this.publish(); }

  stop(): void {
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    const running = this.running;
    if (running) this.retire(running);
    this.publish();
  }

  view(): SemanticRecallView {
    const store = this.deps.store;
    const phase: SemanticPhase = !store ? 'unsupported' : this.job ? this.job.stage : !store.installed ? 'not-installed'
      : !this.running || this.running.exited ? 'idle' : this.running.isReady ? 'ready' : 'starting';
    let shared = false;
    try { shared = !!this.deps.sharedRuntime?.(); } catch { shared = false; }
    let counts = { indexed: 0, total: 0 };
    try { if (this.on && phase !== 'unsupported' && phase !== 'not-installed') counts = this.deps.progress?.() ?? counts; } catch { counts = { indexed: 0, total: 0 }; }
    return {
      enabled: this.on, phase, downloadBytes: shared ? SEMANTIC_MODEL_DOWNLOAD_BYTES : store?.downloadBytes ?? 0, installedBytes: store?.installedBytes ?? 0,
      progress: this.job?.progress ?? null, notice: this.notice, indexed: counts.indexed, total: counts.total,
    };
  }
  /** Re-publish when something the view shows changed (the backfill moved on). */
  refreshView(): void { this.publish(); }
  private publish(): void {
    const view = this.view();
    if (this.published && sameSemanticView(this.published, view)) return;
    this.published = view;
    try { this.deps.publish(view); } catch { /* a closed window misses one update */ }
  }

  // ------------------------------------------------------------------ control-window actions

  /**
   * The switch. On: saved, and when the model is missing the one-time download starts now (this click is the consent). Off: saved, the
   * process and any download stop; the model stays on disk until deleted.
   */
  async setEnabled(on: boolean): Promise<SemanticRecallView> {
    if (typeof on !== 'boolean') throw new Error('bad value');
    const store = this.deps.store;
    if (!store) return this.view();
    this.on = on; this.notice = '';
    await this.deps.saveEnabled(on).catch(() => undefined);
    if (!on) { this.job?.controller?.abort(); this.stop(); this.publish(); return this.view(); }
    this.publish();
    if (!store.installed && !this.job) void this.download();
    return this.view();
  }

  /** Only ever started by turning the switch on (or the retry button). */
  async download(): Promise<SemanticRecallView> {
    const store = this.deps.store;
    if (!store || this.job || store.installed || !this.on) return this.view();
    const controller = new AbortController();
    this.job = { stage: 'downloading', progress: 0, controller }; this.notice = ''; this.publish();
    let lastPublish = 0;
    try {
      await store.install(controller.signal, progress => {
        if (!this.job) return;
        this.job.stage = progress.stage;
        this.job.progress = progress.total ? Math.round(progress.done / progress.total * 100) / 100 : null;
        const now = Date.now();
        if (progress.stage === 'installing' || now - lastPublish > 250) { lastPublish = now; this.publish(); }
      });
    } catch (error) {
      this.notice = error instanceof ComponentInstallError ? error.failure : 'download-failed';
      // A download that did not finish leaves the switch ON with the retry button, so the user's choice is not undone behind their back.
    } finally { this.job = null; this.publish(); }
    return this.view();
  }

  cancelDownload(): void {
    if (!this.job?.controller) return;
    this.job.controller.abort();
    // Canceling is the user saying no: the switch goes off too (nothing is downloaded behind it).
    this.on = false; void this.deps.saveEnabled(false).catch(() => undefined);
  }

  /** Delete the model and everything computed with it (the process is stopped first so no file is in use). The switch goes off. */
  async remove(): Promise<SemanticRecallView> {
    const store = this.deps.store;
    if (!store || this.job) return this.view();
    this.on = false; await this.deps.saveEnabled(false).catch(() => undefined);
    const running = this.running;
    this.stop();
    this.job = { stage: 'installing', progress: null, controller: null }; this.publish();
    try {
      if (running && !running.exited) await new Promise(resolve => this.setTimer(() => resolve(undefined), EXIT_GRACE_MS + 500));
      await store.remove();
      await this.deps.removed?.();
      this.notice = 'removed';
    } catch { this.notice = 'verify-failed'; }
    finally { this.job = null; this.publish(); }
    return this.view();
  }

  dispose(): void { this.job?.controller?.abort(); this.stop(); }
}

export { SEMANTIC_COMPONENT_VERSION };
