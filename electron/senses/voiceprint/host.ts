/**
 * Unbound v1 step 3 「只认你的声音」, the host side (docs/claude/2026-11-17-unbound-step3.md). Pure: Electron pieces come in through
 * `VoiceprintHostDeps` (electron/senses/voiceprint/electron-wiring.ts).
 *
 * Privacy:
 *  - OFF by default (the saved switch). Turning it on is the consent to the one model download (28 MB, the only one approved); the
 *    runtime is only copied from a component already installed: without one nothing is installed ('needs-runtime').
 *  - Enrolling records nothing new: while it runs, the user's own voice-input clips (hold T, the microphone the user turned on) are
 *    taken here instead of going to her chat, turned into numbers in memory and dropped. Only the mean and two cut-offs are kept,
 *    encrypted (electron/senses/voiceprint/store.ts). Nothing without secure storage.
 *  - Checking a clip happens only while the switch is on and a voiceprint exists; the clip is never kept. Neither the voiceprint nor
 *    a score ever leaves the host: the view has states and counts only, and nothing here talks to a model or the agent channel.
 *  - Deleting (and 「允许记录」 off) removes the file and what is in memory at once; an enrollment under way is dropped.
 */
import { ComponentInstallError, type PoseComponentStore } from '../pose/component-store';
import { VOICEPRINT_KNOBS, decideVoice, cosine, enrolVoice, voiceQuality, type VoiceCheck, type VoiceprintNotice, type VoiceprintPhase, type VoiceprintView, type VoiceQuality } from '../../../shared/senses/voiceprint';
import { VOICEPRINT_ARCHIVES, VOICEPRINT_MODEL_DOWNLOAD_BYTES, VOICEPRINT_MODEL_FILE, VOICEPRINT_RUNTIME_ENTRY } from './manifest';
import { parseVoiceprintWorkerMessage, type VoiceprintHostToWorker } from './protocol';
import type { Voiceprint, VoiceprintData } from './store';
import path from 'node:path';

export interface VoiceprintWorkerHandle {
  postMessage(message: VoiceprintHostToWorker): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}
export interface VoiceprintDataPort {
  readonly encryptionAvailable: boolean;
  load(): Promise<VoiceprintData>;
  save(data: VoiceprintData): Promise<void>;
  deleteAll(): Promise<void>;
}
export interface VoiceprintHostDeps {
  store: PoseComponentStore | null;
  data: VoiceprintDataPort;
  fork(): VoiceprintWorkerHandle;
  publish(view: VoiceprintView): void;
  /** An installed component the runtime can be copied from (pose, speech, recall, face). */
  sharedRuntime(): boolean;
  threads?: number;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const READY_TIMEOUT_MS = 30_000;
export const EMBED_TIMEOUT_MS = 10_000;
export const EXIT_GRACE_MS = 5_000;

interface Running { worker: VoiceprintWorkerHandle; ready: Promise<void>; isReady: boolean; pending: Map<string, { resolve(v: Float32Array): void; reject(e: Error): void; timer: unknown }>; exited: boolean }

export class VoiceprintHost {
  private on = false;
  private print: Voiceprint | null = null;
  private notice: VoiceprintNotice = '';
  private job: { stage: 'downloading' | 'installing'; progress: number | null; controller: AbortController | null } | null = null;
  private enrolment: { vectors: Float32Array[]; seconds: number } | null = null;
  private last: VoiceprintView['lastCheck'] = null;
  private running: Running | null = null;
  private idleTimer: unknown = null;
  private sequence = 0;
  /** Bumped by every delete / switch-off: a check or enrollment that was under way then is dropped. */
  private generation = 0;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: VoiceprintHostDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?(): void }).unref?.(); return handle; });
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? Date.now;
  }

  /** Startup: the saved switch and voiceprint, the quick installed check. Never downloads. */
  async init(): Promise<void> {
    const data = await this.deps.data.load().catch(() => ({ enabled: false, print: null }));
    this.on = data.enabled; this.print = data.print;
    await this.deps.store?.refresh().catch(() => false);
    this.publish();
  }

  get enabled(): boolean { return this.on; }
  get installed(): boolean { return !!this.deps.store?.installed && !this.deps.store.working; }
  /** Clips are checked: the switch is on, a voiceprint exists and the model is there. */
  get active(): boolean { return this.on && !!this.print && this.installed && !this.job; }
  /** An enrollment is taking the user's clips now. */
  get enrolling(): boolean { return !!this.enrolment; }

  view(): VoiceprintView {
    const store = this.deps.store;
    let shared = false;
    try { shared = this.deps.sharedRuntime(); } catch { shared = false; }
    const phase: VoiceprintPhase = !store ? 'unsupported' : this.job ? this.job.stage : !store.installed ? (shared ? 'not-installed' : 'needs-runtime')
      : !this.running || this.running.exited ? 'idle' : this.running.isReady ? 'ready' : 'starting';
    const knobs = VOICEPRINT_KNOBS.enrol;
    return {
      enabled: this.on, phase, downloadBytes: VOICEPRINT_MODEL_DOWNLOAD_BYTES, progress: this.job?.progress ?? null, notice: this.notice,
      encryption: this.deps.data.encryptionAvailable,
      enrolled: this.print ? { clips: this.print.clips, seconds: Math.round(this.print.seconds), at: this.print.at } : null,
      enrolling: this.enrolment ? { clips: this.enrolment.vectors.length, seconds: Math.round(this.enrolment.seconds), needClips: knobs.clips, needSeconds: knobs.seconds } : null,
      lastCheck: this.on && this.print ? this.last : null,
    };
  }
  private publish(): void { try { this.deps.publish(this.view()); } catch { /* a closed window misses one update */ } }

  // ---- the switch, the component -------------------------------------------------------------------------------------------------

  /** On: saved; when the model is missing (and a runtime can be copied) the one download starts now (this click is the consent). Off: saved, everything stops. */
  async setEnabled(on: boolean): Promise<VoiceprintView> {
    if (typeof on !== 'boolean') throw new Error('bad value');
    this.on = on; this.notice = '';
    if (!on) { this.generation++; this.enrolment = null; this.last = null; this.job?.controller?.abort(); this.stop(); }
    await this.save().catch(() => undefined);
    this.publish();
    if (on && this.deps.store && !this.deps.store.installed && !this.job) void this.download();
    return this.view();
  }

  /** Only ever started by turning the switch on (or the retry button). Never downloads a runtime. */
  async download(): Promise<VoiceprintView> {
    const store = this.deps.store;
    if (!store || this.job || store.installed || !this.on) return this.view();
    let shared = false;
    try { shared = this.deps.sharedRuntime(); } catch { shared = false; }
    if (!shared) { this.notice = 'needs-runtime'; this.publish(); return this.view(); }
    const controller = new AbortController();
    this.job = { stage: 'downloading', progress: 0, controller }; this.notice = ''; this.publish();
    let lastPublish = 0;
    try {
      await store.install(controller.signal, progress => {
        if (!this.job) return;
        this.job.stage = progress.stage;
        this.job.progress = progress.total ? Math.round(progress.done / progress.total * 100) / 100 : null;
        const now = this.now();
        if (progress.stage === 'installing' || now - lastPublish > 250) { lastPublish = now; this.publish(); }
      });
    } catch (error) {
      this.notice = error instanceof ComponentInstallError ? (error.failure === 'verify-failed' ? 'verify-failed' : 'download-failed') : 'download-failed';
    } finally { this.job = null; this.publish(); }
    return this.view();
  }

  cancelDownload(): void {
    if (!this.job?.controller) return;
    this.job.controller.abort();
    this.on = false; void this.save().catch(() => undefined); // cancelling is the user saying no
  }

  /** Deletes the model (the process is stopped first). The voiceprint stays until the user deletes it; it is unused without the model. */
  async removeComponent(): Promise<VoiceprintView> {
    const store = this.deps.store;
    if (!store || this.job) return this.view();
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

  // ---- the user's own voiceprint --------------------------------------------------------------------------------------------------

  /** Starts taking the user's next voice-input clips as the sample (a new sample replaces the old one when it is complete). */
  startEnrol(): VoiceprintView {
    if (!this.on || !this.installed) throw new Error('先打开「只认你的声音」并等它装好。');
    if (!this.deps.data.encryptionAvailable) { this.notice = 'no-encryption'; this.publish(); throw new Error('这台电脑的系统加密不可用，声纹不能安全保存，所以不登记。'); }
    this.enrolment = { vectors: [], seconds: 0 }; this.notice = ''; this.publish();
    return this.view();
  }
  cancelEnrol(): VoiceprintView { this.enrolment = null; this.publish(); return this.view(); }

  /**
   * While enrolling: this clip of the user's own voice input is taken for the sample (true: it was taken and must not go on to her
   * chat). Too short or too noisy: taken but not counted (the user says another sentence). Not enrolling: false.
   */
  async take(samples: Float32Array): Promise<boolean> {
    const enrolment = this.enrolment, generation = this.generation;
    if (!enrolment) return false;
    const { quality, voicedSeconds } = voiceQuality(samples);
    if (quality !== 'ok' || voicedSeconds < VOICEPRINT_KNOBS.enrol.clipMinSeconds) { this.notice = 'enrol-skipped'; this.publish(); return true; }
    let vector: Float32Array;
    try { vector = await this.embed(samples); }
    catch { if (this.enrolment === enrolment) { this.notice = 'enrol-failed'; this.publish(); } return true; }
    if (this.enrolment !== enrolment || generation !== this.generation) return true;
    enrolment.vectors.push(vector); enrolment.seconds += voicedSeconds; this.notice = '';
    const knobs = VOICEPRINT_KNOBS.enrol;
    if (enrolment.vectors.length >= knobs.clips && enrolment.seconds >= knobs.seconds) await this.finishEnrol(enrolment);
    this.publish();
    return true;
  }

  private async finishEnrol(enrolment: { vectors: Float32Array[]; seconds: number }): Promise<void> {
    this.enrolment = null;
    const { centroid, calibration } = enrolVoice(enrolment.vectors);
    const print: Voiceprint = { centroid, calibration, clips: enrolment.vectors.length, seconds: enrolment.seconds, at: this.now() };
    enrolment.vectors.length = 0; // the per-clip numbers go; only the mean is kept
    const before = this.print;
    this.print = print; this.last = null;
    try { await this.save(); this.notice = 'enrolled'; }
    catch { this.print = before; this.notice = 'no-encryption'; }
  }

  /**
   * One clip of what the microphone heard: you, unsure, can't confirm, or clearly not you. Null when the check is not in use (switch
   * off, no voiceprint, no model): then nothing is judged and everything goes on as before. Never throws; a failure is "can't confirm".
   */
  async check(samples: Float32Array): Promise<{ check: VoiceCheck; why: VoiceQuality | 'mixed' | null } | null> {
    const print = this.print, generation = this.generation;
    if (!this.active || !print) return null;
    const { quality } = voiceQuality(samples);
    let result: { check: VoiceCheck; why: VoiceQuality | 'mixed' | null };
    if (quality !== 'ok') result = decideVoice({ quality, score: null, calibration: print.calibration });
    else {
      try {
        const whole = await this.embed(samples);
        let halves: number | null = null;
        if (samples.length >= VOICEPRINT_KNOBS.check.halvesSeconds * VOICEPRINT_KNOBS.sampleRate) {
          const middle = Math.floor(samples.length / 2);
          const [first, second] = [await this.embed(samples.subarray(0, middle)), await this.embed(samples.subarray(middle))];
          halves = cosine(first, second);
        }
        result = decideVoice({ quality, score: cosine(whole, print.centroid), halves, calibration: print.calibration });
      } catch { result = { check: 'cannot', why: null }; }
    }
    if (generation !== this.generation || this.print !== print) return null; // deleted or switched off meanwhile: nothing is judged
    this.last = { ...result, at: this.now() };
    this.publish();
    return result;
  }

  /** One-click delete (and 「允许记录」 off): the file and what is in memory go now; the switch goes off. */
  async deleteData(): Promise<VoiceprintView> {
    this.generation++;
    this.print = null; this.enrolment = null; this.last = null; this.on = false;
    this.stop();
    await this.deps.data.deleteAll();
    this.notice = 'deleted'; this.publish();
    return this.view();
  }

  dispose(): void { this.generation++; this.job?.controller?.abort(); this.stop(); }

  private save(): Promise<void> { return this.deps.data.save({ enabled: this.on, print: this.print }); }

  // ---- the model process --------------------------------------------------------------------------------------------------------

  private async embed(samples: Float32Array): Promise<Float32Array> {
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    try {
      const running = await this.ensure();
      const id = `vp-${++this.sequence}`;
      return await new Promise<Float32Array>((resolve, reject) => {
        const done = () => { running.pending.delete(id); this.clearTimer(entry.timer); };
        const entry = { resolve: (v: Float32Array) => { done(); resolve(v); }, reject: (e: Error) => { done(); reject(e); },
          timer: this.setTimer(() => { done(); reject(new Error('timeout')); this.retire(running); }, EMBED_TIMEOUT_MS) };
        running.pending.set(id, entry);
        try { running.worker.postMessage({ type: 'embed', id, samples: Float32Array.from(samples) }); }
        catch { entry.reject(new Error('process unavailable')); this.retire(running); }
      });
    } finally { this.armIdle(); }
  }

  private ensure(): Promise<Running> {
    if (this.running && !this.running.exited) return this.running.ready.then(() => this.running!);
    const store = this.deps.store, dir = store?.installedDir(), model = store?.installedFile(VOICEPRINT_MODEL_FILE);
    if (!store || !dir || !model) return Promise.reject(new Error('model is not installed'));
    const file = VOICEPRINT_ARCHIVES.flatMap(archive => archive.files.all ?? []).find(item => item.to === VOICEPRINT_MODEL_FILE)!;
    let worker: VoiceprintWorkerHandle;
    try { worker = this.deps.fork(); } catch { return Promise.reject(new Error('process could not start')); }
    let settle!: { resolve(): void; reject(error: Error): void };
    const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    void ready.catch(() => undefined);
    const running: Running = { worker, ready, isReady: false, pending: new Map(), exited: false };
    this.running = running;
    const readyTimer = this.setTimer(() => { settle.reject(new Error('timeout')); this.retire(running); }, READY_TIMEOUT_MS);
    worker.onMessage(raw => {
      if (this.running !== running) return;
      const message = parseVoiceprintWorkerMessage(raw);
      if (!message) return;
      if (message.type === 'ready') { this.clearTimer(readyTimer); running.isReady = true; settle.resolve(); this.publish(); }
      else if (message.type === 'failed') { this.clearTimer(readyTimer); this.notice = 'failed'; settle.reject(new Error('failed')); this.retire(running); }
      else if (message.type === 'result') running.pending.get(message.id)?.resolve(message.vector);
      else if (message.type === 'error') running.pending.get(message.id)?.reject(new Error('embedding failed'));
    });
    worker.onExit(() => {
      running.exited = true; this.clearTimer(readyTimer); settle.reject(new Error('exited'));
      for (const entry of [...running.pending.values()]) entry.reject(new Error('exited'));
      if (this.running === running) { this.running = null; this.publish(); }
    });
    worker.postMessage({ type: 'init', runtimeEntry: path.join(dir, ...VOICEPRINT_RUNTIME_ENTRY.split('/')), model, modelSize: file.size, modelSha256: file.sha256, threads: this.deps.threads ?? 1 });
    this.publish();
    return ready.then(() => running);
  }

  private armIdle(): void {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.idleTimer = this.running ? this.setTimer(() => { this.idleTimer = null; this.stop(); }, VOICEPRINT_KNOBS.idleStopMinutes * 60_000) : null;
  }
  private retire(running: Running): void {
    if (this.running === running) this.running = null;
    for (const entry of [...running.pending.values()]) entry.reject(new Error('stopped'));
    if (running.exited) return;
    try { running.worker.postMessage({ type: 'stop' }); } catch { /* already gone */ }
    this.setTimer(() => { if (!running.exited) try { running.worker.kill(); } catch { /* exited */ } }, EXIT_GRACE_MS);
  }
  private stop(): void {
    if (this.idleTimer) { this.clearTimer(this.idleTimer); this.idleTimer = null; }
    if (this.running) this.retire(this.running);
  }
}
