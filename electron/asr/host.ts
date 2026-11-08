/**
 * The local speech recognizer as the rest of the app sees it (voice input). Pure: Electron
 * pieces come in through `LocalAsrDeps` (electron/asr/electron-wiring.ts).
 *
 *  - Component: downloaded only after the user clicks「下载」(or imported offline); same store, checks and clean-up as
 *    local pose sensing (electron/pose/component-store.ts), under its own folder.
 *  - Voice input with the local recognizer and no component: the switch stays off, the window that asked says why,
 *    and the control window shows the question with the size (like the camera, faabc23).
 *  - Recognition runs in its own utilityProcess on the CPU, started when voice input turns on and stopped a little
 *    after it turns off; it releases its session and exits by itself, and is killed only if it does not.
 *  - Failures carry a closed category (LocalAsrError), never text or audio.
 */
import path from 'node:path';
import type { MediaOwner } from '../runtime';
import type { VoiceRefusal } from '../../shared/contracts';
import { sameLocalAsrView, type LocalAsrNotice, type LocalAsrView } from '../../shared/local-asr';
import type { VoiceInputFailure } from '../../shared/speech-failure';
import { ComponentInstallError, type ImportResult, type PoseComponentStore } from '../pose/component-store';
import type { AsrTags } from './decode';
import { asrLanguage } from './engine';
import { ASR_COMPONENT_VERSION, ASR_MANIFEST, ASR_MODEL_FILES, ASR_RUNTIME_ENTRY } from './manifest';
import { parseAsrWorkerMessage, type AsrHostToWorker } from './protocol';

export interface AsrWorkerHandle {
  postMessage(message: AsrHostToWorker, transfer?: unknown[]): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface LocalAsrDeps {
  store: PoseComponentStore | null;
  fork(): AsrWorkerHandle;
  publish(view: LocalAsrView): void;
  /** The user tried to turn voice input on from this window while the component is missing. */
  promptRaised(owner: MediaOwner): void;
  /** CPU threads for one recognition (2 measured fine on the test machine). */
  threads?: number;
  /** Local pose sensing is installed: its runtime files are copied, so the question counts only the model. */
  sharedRuntime?(): boolean;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  id?(): string;
}

/** A recognition that did not happen, by closed category (shared/speech-failure.ts). */
export class LocalAsrError extends Error {
  constructor(readonly failure: VoiceInputFailure, message: string) { super(message); this.name = 'LocalAsrError'; }
}

/** The model and its tokens: what is downloaded when the runtime is copied from local pose sensing. */
export const ASR_MODEL_DOWNLOAD_BYTES = ASR_MANIFEST.archives.filter(archive => archive.kind === 'file').reduce((sum, archive) => sum + archive.networkBytes, 0);
export const READY_TIMEOUT_MS = 90_000;
export const RECOGNIZE_TIMEOUT_MS = 30_000;
/** Keep the model loaded this long after voice input turns off (a quick off/on does not reload it). */
export const IDLE_STOP_MS = 120_000;
/** A process asked to stop that has not exited by then is killed. */
export const EXIT_GRACE_MS = 5_000;

/** One recognition: the words, and the whitelisted tags when they were asked for (listening/watching transcription). */
export interface LocalAsrResult { text: string; tags?: AsrTags }

interface Pending { resolve(result: LocalAsrResult): void; reject(error: Error): void; timer: unknown }
interface Running { worker: AsrWorkerHandle; ready: Promise<void>; isReady: boolean; pending: Map<string, Pending>; exited: boolean }

export class LocalAsrHost {
  private prompt = false;
  private asked = 0;
  private notice: LocalAsrNotice = '';
  private job: { stage: 'downloading' | 'installing'; progress: number | null; controller: AbortController | null; fallback?: boolean } | null = null;
  private published: LocalAsrView | null = null;
  private running: Running | null = null;
  private wanted = false;
  private idleTimer: unknown = null;
  private sequence = 0;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: LocalAsrDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?(): void }).unref?.(); return handle; });
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Startup: quick installed check + old-version clean-up. */
  async init(): Promise<void> {
    await this.deps.store?.refresh().catch(() => false);
    this.publish();
  }

  get installed(): boolean { return !!this.deps.store?.installed && !this.deps.store.working; }
  /** Installed and not being downloaded, imported or deleted: recognition can be asked for. */
  get ready(): boolean { return this.installed && !this.job; }

  /**
   * Turning on something that needs the local recognizer (voice input, or listening/watching transcription): null when
   * it may go on, otherwise why not. A refusal raises the control window's question (brought into view on every refused
   * try) and goes back to the window that asked.
   */
  voiceBlocked(owner: MediaOwner): VoiceRefusal | null {
    const store = this.deps.store;
    if (!store) return 'unavailable';
    if (this.installed && !this.job) return null;
    this.prompt = true;
    this.asked++;
    if (this.notice !== 'download-failed' && this.notice !== 'verify-failed') this.notice = '';
    this.publish();
    this.deps.promptRaised(owner);
    return this.job || store.working ? 'preparing' : 'needs-component';
  }

  /**
   * Follows voice input with the local recognizer: on loads the model now, off stops the process a little later.
   * Listening/watching transcription does not call this: each clip keeps the process warm by itself (recognize below),
   * and the process stops the same little while after the last clip, unless voice input wants it.
   */
  setWanted(on: boolean): void {
    this.wanted = on;
    if (on) {
      if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
      if (this.installed) void this.ensure().catch(() => undefined);
      return;
    }
    this.armIdle();
  }

  /** (Re)starts the idle countdown: the process is asked to stop IDLE_STOP_MS after the last use, never during a request. */
  private armIdle(): void {
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    if (this.wanted || !this.running) return;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.wanted) return;
      if (this.inFlight) this.armIdle(); else this.stop();
    }, IDLE_STOP_MS);
  }
  private inFlight = 0;

  /** One utterance (a checked 16 kHz WAV) → the words. Throws LocalAsrError with a category. */
  async transcribe(wav: ArrayBuffer, language: string, signal: AbortSignal): Promise<string> {
    return (await this.recognize(wav, language, signal)).text;
  }

  /**
   * One clip (a checked 16 kHz WAV) → the words, plus the whitelisted language / event / emotion tags when `tags` is
   * asked for (listening/watching transcription, with language '' so the model detects it). One request at a time in
   * the process; the caller (ForegroundAsr) keeps voice input ahead of transcription. Throws LocalAsrError.
   */
  async recognize(wav: ArrayBuffer, language: string, signal: AbortSignal, options: { tags?: boolean } = {}): Promise<LocalAsrResult> {
    this.inFlight++;
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    try { return await this.request(wav, language, signal, options.tags === true); }
    finally { this.inFlight--; this.armIdle(); }
  }

  private async request(wav: ArrayBuffer, language: string, signal: AbortSignal, tags: boolean): Promise<LocalAsrResult> {
    signal.throwIfAborted();
    if (!this.deps.store) throw new LocalAsrError('needs-component', 'no local recognizer on this computer');
    if (this.job || this.deps.store.working) throw new LocalAsrError('preparing', 'local recognizer is being installed');
    if (!this.deps.store.installed) throw new LocalAsrError('needs-component', 'local recognizer not installed');
    const running = await this.ensure();
    signal.throwIfAborted();
    if (this.running !== running || running.exited) throw new LocalAsrError('local-failed', 'recognition process stopped');
    const id = `asr-${++this.sequence}`;
    return new Promise<LocalAsrResult>((resolve, reject) => {
      const done = () => { running.pending.delete(id); signal.removeEventListener('abort', abort); this.clearTimer(entry.timer); };
      const abort = () => { done(); reject(signal.reason ?? new Error('aborted')); };
      const entry: Pending = {
        resolve: result => { done(); resolve(tags ? result : { text: result.text }); },
        reject: error => { done(); reject(error); },
        timer: this.setTimer(() => {
          done(); reject(new LocalAsrError('timeout', 'recognition took too long'));
          this.restart(running); // a stuck process is replaced; the next utterance starts a fresh one
        }, RECOGNIZE_TIMEOUT_MS),
      };
      running.pending.set(id, entry);
      signal.addEventListener('abort', abort, { once: true });
      // Copied by structured clone (utilityProcess transfers only message ports).
      try { running.worker.postMessage({ type: 'recognize', id, wav: wav.slice(0), language: asrLanguage(language), ...(tags ? { tags: true as const } : {}) }); }
      catch { entry.reject(new LocalAsrError('local-failed', 'recognition process unavailable')); this.restart(running); }
    });
  }

  private ensure(): Promise<Running> {
    if (this.running && !this.running.exited) return this.running.ready.then(() => this.running!);
    const store = this.deps.store, dir = store?.installedDir();
    const model = store?.installedFile(ASR_MODEL_FILES.model), tokens = store?.installedFile(ASR_MODEL_FILES.tokens);
    if (!store || !dir || !model || !tokens) return Promise.reject(new LocalAsrError('needs-component', 'local recognizer not installed'));
    const files = ASR_MANIFEST.archives.flatMap(archive => archive.files.all ?? []);
    const modelFile = files.find(file => file.to === ASR_MODEL_FILES.model)!, tokensFile = files.find(file => file.to === ASR_MODEL_FILES.tokens)!;
    let worker: AsrWorkerHandle;
    try { worker = this.deps.fork(); } catch { return Promise.reject(new LocalAsrError('local-failed', 'recognition process could not start')); }
    let settle!: { resolve(): void; reject(error: Error): void };
    const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    void ready.catch(() => undefined);
    const running: Running = { worker, ready, isReady: false, pending: new Map(), exited: false };
    this.running = running;
    const readyTimer = this.setTimer(() => { settle.reject(new LocalAsrError('local-failed', 'recognizer did not load in time')); this.restart(running); }, READY_TIMEOUT_MS);
    worker.onMessage(raw => {
      if (this.running !== running) return;
      const message = parseAsrWorkerMessage(raw);
      if (!message) return;
      if (message.type === 'ready') { this.clearTimer(readyTimer); running.isReady = true; settle.resolve(); this.publish(); }
      else if (message.type === 'failed') { this.clearTimer(readyTimer); this.notice = 'failed'; settle.reject(new LocalAsrError('local-failed', `recognizer ${message.reason} failed`)); this.restart(running); }
      else if (message.type === 'result') running.pending.get(message.id)?.resolve({ text: message.text.trim(), ...(message.tags ? { tags: message.tags } : {}) });
      else if (message.type === 'error') running.pending.get(message.id)?.reject(new LocalAsrError('local-failed', 'recognition failed'));
    });
    worker.onExit(() => {
      running.exited = true;
      this.clearTimer(readyTimer);
      settle.reject(new LocalAsrError('local-failed', 'recognition process exited'));
      for (const entry of [...running.pending.values()]) entry.reject(new LocalAsrError('local-failed', 'recognition process exited'));
      if (this.running === running) { this.running = null; this.publish(); }
    });
    worker.postMessage({ type: 'init', runtimeEntry: path.join(dir, ...ASR_RUNTIME_ENTRY.split('/')), model, modelSize: modelFile.size,
      modelSha256: modelFile.sha256, tokens, tokensSha256: tokensFile.sha256, threads: this.deps.threads ?? 2 });
    this.publish();
    return ready.then(() => running);
  }

  /** Ask the process to release its session and exit; kill it only if it is still there after the grace time. */
  private retire(running: Running): void {
    if (this.running === running) this.running = null;
    for (const entry of [...running.pending.values()]) entry.reject(new LocalAsrError('local-failed', 'recognition process stopped'));
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

  view(): LocalAsrView {
    const store = this.deps.store;
    const phase = !store ? 'unsupported' : this.job ? this.job.stage : !store.installed ? 'not-installed'
      : !this.running || this.running.exited ? 'idle' : this.running.isReady ? 'ready' : 'starting';
    let shared = false;
    try { shared = !this.job?.fallback && !!this.deps.sharedRuntime?.(); } catch { shared = false; }
    return {
      phase, prompt: this.prompt && phase !== 'unsupported',
      downloadBytes: shared ? ASR_MODEL_DOWNLOAD_BYTES : (this.job?.fallback ? store?.officialDownloadBytes : store?.downloadBytes) ?? 0,
      installedBytes: store?.installedBytes ?? 0,
      progress: this.job?.progress ?? null, componentVersion: ASR_COMPONENT_VERSION, notice: this.notice,
      ...(this.job?.fallback ? { fallback: true } : {}), ...(this.asked && phase !== 'unsupported' ? { asked: this.asked } : {}),
    };
  }
  private publish(): void {
    const view = this.view();
    if (this.published && sameLocalAsrView(this.published, view)) return;
    this.published = view;
    try { this.deps.publish(view); } catch { /* a closed window misses one update */ }
  }

  // ------------------------------------------------------------------ control-window actions

  dismissPrompt(): LocalAsrView { this.prompt = false; this.publish(); return this.view(); }

  /** 「下载」: only ever started by this click. Voice input stays off; the user turns it on when it is ready. */
  async download(): Promise<LocalAsrView> {
    const store = this.deps.store;
    if (!store || this.job || store.installed) return this.view();
    const controller = new AbortController();
    this.job = { stage: 'downloading', progress: 0, controller }; this.notice = ''; this.publish();
    let lastPublish = 0;
    try {
      await store.install(controller.signal, progress => {
        if (!this.job) return;
        this.job.stage = progress.stage;
        this.job.progress = progress.total ? Math.round(progress.done / progress.total * 100) / 100 : null;
        const switched = !!progress.fallback !== !!this.job.fallback;
        this.job.fallback = !!progress.fallback;
        const now = Date.now();
        if (switched || progress.stage === 'installing' || now - lastPublish > 250) { lastPublish = now; this.publish(); }
      });
      this.prompt = false;
    } catch (error) {
      this.notice = error instanceof ComponentInstallError ? error.failure : 'download-failed';
    } finally { this.job = null; this.publish(); }
    if (this.wanted && store.installed) void this.ensure().catch(() => undefined);
    return this.view();
  }

  cancelDownload(): void { this.job?.controller?.abort(); }

  /** Offline files the user picked in the host's own dialog (paths never reach a window). */
  async importFiles(paths: readonly string[]): Promise<LocalAsrView & { result?: ImportResult }> {
    const store = this.deps.store;
    if (!store || this.job || !paths.length) return this.view();
    this.job = { stage: 'installing', progress: null, controller: null }; this.notice = ''; this.publish();
    let result: ImportResult | undefined;
    try {
      result = await store.importFiles(paths);
      this.notice = result.complete ? 'import-done' : 'import-incomplete';
      if (result.complete) this.prompt = false;
    } catch { this.notice = 'import-incomplete'; }
    finally { this.job = null; this.publish(); }
    return { ...this.view(), ...(result ? { result } : {}) };
  }

  /** Delete the component (the recognition process is stopped first so no file is in use). */
  async remove(turnOffVoice: () => void): Promise<LocalAsrView> {
    const store = this.deps.store;
    if (!store || this.job) return this.view();
    turnOffVoice();
    const running = this.running;
    this.stop();
    this.job = { stage: 'installing', progress: null, controller: null }; this.publish();
    try {
      if (running && !running.exited) await new Promise(resolve => this.setTimer(() => resolve(undefined), EXIT_GRACE_MS + 500));
      await store.remove();
      this.notice = 'removed';
    } catch { this.notice = 'verify-failed'; }
    finally { this.job = null; this.publish(); }
    return this.view();
  }

  dispose(): void { this.job?.controller?.abort(); this.wanted = false; this.stop(); }
}
