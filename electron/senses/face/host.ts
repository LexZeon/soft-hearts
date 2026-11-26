/**
 * I-135 认出"不是你" as the rest of the app sees it. Pure: Electron pieces come in through `FaceHostDeps`
 * (electron/senses/face/electron-wiring.ts).
 *
 * Product: the point is to show her preference, not a privacy
 * vault. When the person at the computer is clearly not the user she gets one private line (`strangerLine`) and treats
 * them politely and distantly; nothing else changes. "拿不准就当是你".
 *
 *  - The switch 「认出是不是你」 is OFF by default and saved in the profile; turning it on is the user's explicit choice, and
 *    when the models are missing that click starts their one-time download (the explanation sits beside the switch).
 *  - Only the user's own face is enrolled, as numbers (embeddings), encrypted with the system's secure storage, on this
 *    computer only; one click deletes them. Nobody else is stored or identified: a check only answers "is this the user?".
 *  - Nothing runs while the switch is off, the camera is off (both 「发图片」 and 「姿势识别」), or nothing is enrolled.
 *  - Frames come from the camera the user already turned on; each is dropped after its check. The journal gets counts only.
 */
import path from 'node:path';
import { EMPTY_FACE_CHECK_COUNTS, FACE_STRANGER_LINE, sameFaceCheckView, type FaceCheckCounts, type FaceCheckNotice, type FaceCheckPhase, type FaceCheckView, type FaceEnrolHint } from '../../../shared/senses/face-check';
import type { FaceScoreInput } from '../../../shared/senses/face-journal';
import { ComponentInstallError, type PoseComponentStore } from '../pose/component-store';
import { classifyCheck, FaceDecision, isClearFace, type CheckClass, type FaceObservation, type FaceVerdict } from './decision';
import { checkRow, FaceIdleWatch, idleWhy, ScoreRowGate } from './diagnosis';
import { enrolHint, judgeEnrolSample, shouldAugment, type EnrolledFace } from './enrolment';
import { FACE_KNOBS, type FaceKnobs } from './knobs';
import { FACE_MANIFEST, FACE_MODEL_DOWNLOAD_BYTES, FACE_MODEL_FILES, FACE_RUNTIME_ENTRY } from './manifest';
import { parseFaceWorkerMessage, type FaceHostToWorker, type FaceResultMessage } from './protocol';
import { FaceCheckScheduler, type ScheduledReason } from './scheduler';
import { bestMatch, l2normalize } from './score';
import type { FaceData } from './store';

export interface FaceFrame { width: number; height: number; rgba: Uint8Array }

export interface FaceFrameSource {
  /** The camera is on (either switch) — the only time frames exist. */
  cameraOn(): boolean;
  /** One frame now (null when there is none). 'enrol' may take a clearer, fresher one. Never throws. */
  grab(purpose: 'check' | 'enrol', signal: AbortSignal): Promise<FaceFrame | null>;
}

export type FaceRecordRow = FaceScoreInput extends infer T ? (T extends unknown ? Omit<T, 'characterId'> : never) : never;

/** What the enrolment window shows each moment: the frame (host-side only; the wiring turns it into a small picture for the control window), the hint, the count. */
export interface FaceEnrolPreviewInput {
  frame: FaceFrame | null;
  /** The detected face box in the frame's own pixels, or null. */
  box: { x: number; y: number; width: number; height: number } | null;
  hint: FaceEnrolHint;
  taken: number;
  total: number;
}

export interface FaceWorkerHandle {
  postMessage(message: FaceHostToWorker): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface FaceDataPort {
  readonly encryptionAvailable: boolean;
  load(): Promise<FaceData>;
  save(data: FaceData): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface FaceHostDeps {
  store: PoseComponentStore | null;
  data: FaceDataPort;
  fork(): FaceWorkerHandle;
  frames: FaceFrameSource;
  publish(view: FaceCheckView): void;
  /** Counts only (never a picture, an embedding or a score); called when the verdict changes, the checks stop, or every 30 minutes. */
  journal?(counts: FaceCheckCounts): void;
  /**
   * One journal row about how a check went (numbers and closed words only; the writer adds the character): each check's outcome and
   * similarity, or why no check ran for a minute (electron/senses/face/diagnosis.ts). Never a picture or the face's numbers.
   */
  record?(row: FaceRecordRow): void;
  /** While enrolling: what to show the user in the control window (a live picture, the face box, a hint, how many sets). Local, never stored. */
  preview?(preview: FaceEnrolPreviewInput | null): void;
  /** Another component with the same runtime is installed: only the two models are downloaded. */
  sharedRuntime?(): boolean;
  threads?: number;
  knobs?: FaceKnobs;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  clearInterval?(handle: unknown): void;
  setInterval?(callback: () => void, ms: number): unknown;
}

export const READY_TIMEOUT_MS = 30_000;
export const EXIT_GRACE_MS = 3_000;
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 5 * 60_000;
export const JOURNAL_EVERY_MS = 30 * 60_000;

interface Pending { resolve(result: FaceResultMessage | null): void; timer: unknown }
interface Running { worker: FaceWorkerHandle; ready: Promise<boolean>; isReady: boolean; pending: Map<string, Pending>; exited: boolean }

export class FaceCheckHost {
  private on = false;
  private faces: EnrolledFace[] = [];
  private notice: FaceCheckNotice = '';
  private job: { stage: 'downloading' | 'installing'; progress: number | null; controller: AbortController | null } | null = null;
  private enrolling: { progress: number; controller: AbortController } | null = null;
  private running: Running | null = null;
  private crashes: number[] = [];
  private gaveUp = false;
  private published: FaceCheckView | null = null;
  private ticker: unknown = null;
  private checking: AbortController | null = null;
  private sequence = 0;
  private counts: FaceCheckCounts = { ...EMPTY_FACE_CHECK_COUNTS };
  private lastJournal = 0;
  private readonly decision: FaceDecision;
  private readonly scheduler: FaceCheckScheduler;
  private readonly listeners = new Set<(state: FaceVerdict) => void>();
  private readonly knobs: FaceKnobs;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly setTicker: (callback: () => void, ms: number) => unknown;
  private readonly clearTicker: (handle: unknown) => void;
  private lastPresence: string | null = null;
  private readonly idleWatch = new FaceIdleWatch();
  private readonly scoreGate = new ScoreRowGate();
  /** Frame grabs / analyses that gave nothing since the last check that ran (the idle row's reason). */
  private noFrames = 0;
  private noResult = 0;

  constructor(private readonly deps: FaceHostDeps) {
    this.knobs = deps.knobs ?? FACE_KNOBS;
    this.decision = new FaceDecision(this.knobs);
    this.scheduler = new FaceCheckScheduler(this.knobs);
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?(): void }).unref?.(); return handle; });
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.setTicker = deps.setInterval ?? ((callback, ms) => { const handle = setInterval(callback, ms); (handle as { unref?(): void }).unref?.(); return handle; });
    this.clearTicker = deps.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
    this.lastJournal = this.now();
  }

  /** Startup: the saved switch and faces, the quick installed check. Never downloads, never opens a camera. */
  async init(): Promise<void> {
    const data = await this.deps.data.load().catch(() => ({ enabled: false, faces: [] as EnrolledFace[] }));
    this.on = data.enabled; this.faces = data.faces;
    await this.deps.store?.refresh().catch(() => false);
    this.sync();
  }

  // ------------------------------------------------------------------ the lead's API

  /** 'you' unless the person at the computer is clearly someone else (and the feature is on). */
  state(): FaceVerdict { return this.decision.state; }

  /** Her private line while it is clearly not the user; null otherwise. */
  strangerLine(): string | null { return this.decision.state === 'not-you' ? FACE_STRANGER_LINE : null; }

  onChange(listener: (state: FaceVerdict) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * A camera picture is about to be sent: check it (bounded by `photoTimeoutMs`) and return the verdict to use.
   * Anything that cannot run in time leaves the current verdict. Never throws.
   */
  async checkFrame(frame: FaceFrame | null): Promise<FaceVerdict> {
    if (!frame || !this.scheduler.isActive) return this.decision.state;
    const timeout = new Promise<null>(resolve => this.setTimer(() => resolve(null), this.knobs.schedule.photoTimeoutMs));
    await Promise.race([this.runCheck(async () => frame), timeout]);
    return this.decision.state;
  }

  /** Counts since the last call (and starts counting again). */
  takeCounts(): FaceCheckCounts {
    const counts = this.counts;
    this.counts = { ...EMPTY_FACE_CHECK_COUNTS };
    this.lastJournal = this.now();
    return counts;
  }

  // ------------------------------------------------------------------ hooks (wired from main.ts)

  /** The camera switches changed. */
  cameraChanged(): void { this.sync(); }

  /** The app's 在/不在 judgment (user-activity presence: 'away' | 'back' | 'idle' | 'busy' | ...). */
  notePresence(presence: string | null | undefined): void {
    this.watch(); // the clock calls this every second: the one place that notices "checks should be running but are not"
    const value = presence ?? null;
    if (value === this.lastPresence) return;
    const before = this.lastPresence;
    this.lastPresence = value;
    if (value === 'away') this.scheduler.noteLeave();
    else if (before === 'away' && (value === 'back' || value === 'idle' || value === 'busy')) this.scheduler.noteReturn();
  }

  /** Pose sensing's "somebody in front": a leave, then someone appearing. */
  notePoseSignal(present: boolean): void {
    if (present) this.scheduler.noteReturn(); else this.scheduler.noteLeave();
  }

  /** Someone started typing or talking to her. */
  noteTalk(): void { this.scheduler.noteReturn(); }

  // ------------------------------------------------------------------ state

  get enabled(): boolean { return this.on; }
  get installed(): boolean { return !!this.deps.store?.installed && !this.deps.store.working; }
  get enrolledCount(): number { return this.faces.length; }

  private cameraOn(): boolean { try { return this.deps.frames.cameraOn(); } catch { return false; } }

  /** Recompute what should run: worker, ticker, scheduler. Everything stops the moment any condition goes away. */
  private sync(): void {
    const ready = this.on && this.installed && !this.job && !this.gaveUp && this.cameraOn();
    const checking = ready && this.faces.length > 0 && !this.enrolling;
    const wasActive = this.scheduler.isActive;
    this.scheduler.setActive(checking);
    if (!checking) {
      this.checking?.abort(); this.checking = null; this.scoreGate.reset();
      if (this.decision.state !== 'you') { this.decision.reset(); this.emit(); } else this.decision.reset();
      if (wasActive) this.flushJournal();
    }
    if (checking && !this.ticker) this.ticker = this.setTicker(() => this.tick(), this.knobs.schedule.tickMs);
    else if (!checking && this.ticker) { this.clearTicker(this.ticker); this.ticker = null; }
    if (!(ready && (this.faces.length > 0 || this.enrolling)) && this.running) this.stopWorker();
    this.publish();
  }

  /**
   * Called about once a second (no timer of its own, so nothing runs while the switch or the camera is off). While checks are expected
   * (switch on, camera on, a face enrolled): (1) if they are not running although every condition holds, start them again (a camera or
 * pose change that never reached `sync` —); (2) when none ran for a minute,
   * write one row that says why (electron/senses/face/diagnosis.ts).
   */
  watch(): void {
    const expected = this.on && this.faces.length > 0 && !this.enrolling && !this.job && this.cameraOn();
    if (!expected) { this.idleWatch.stopExpecting(); return; }
    if (!this.scheduler.isActive && this.installed && !this.gaveUp) this.sync();
    const quiet = this.idleWatch.due(this.now());
    if (quiet === null) return;
    const why = idleWhy({ installed: this.installed, gaveUp: this.gaveUp, workerFailed: this.notice === 'failed', active: this.scheduler.isActive,
      noFrames: this.noFrames, noResult: this.noResult });
    try { this.deps.record?.({ type: 'face-score', event: 'idle', why, seconds: quiet }); } catch { /* keeping a record never blocks her */ }
  }

  private tick(): void {
    const now = this.now();
    if (this.decision.expire(now).changed) this.emit();
    if (now - this.lastJournal >= JOURNAL_EVERY_MS) this.flushJournal();
    const reason = this.scheduler.due(now);
    if (!reason) return;
    this.scheduler.started(now);
    void this.scheduled(reason);
  }

  private async scheduled(reason: ScheduledReason): Promise<void> {
    let result: CheckClass | null = null;
    try {
      const controller = new AbortController();
      this.checking = controller;
      result = await this.runCheck(() => this.deps.frames.grab('check', controller.signal), controller.signal);
    } catch { result = null; }
    finally { this.scheduler.finished(result, reason); }
  }

  /** One check: frame → worker → numbers → class → verdict. The frame is not kept. */
  private async runCheck(frame: () => Promise<FaceFrame | null>, signal?: AbortSignal): Promise<CheckClass> {
    if (!this.scheduler.isActive) return 'skipped';
    let cls: CheckClass = 'skipped';
    let result: FaceResultMessage | null = null;
    // No frame at all (nothing new from the camera yet) is not a check: nothing is counted or decided.
    const image = await frame().catch(() => null);
    if (!image) this.noFrames++;
    if (!image || signal?.aborted || !this.scheduler.isActive) return 'skipped';
    try { result = await this.analyze(image); } catch { result = null; }
    if (!result) this.noResult++;
    if (signal?.aborted || !this.scheduler.isActive) return 'skipped';
    let observation: FaceObservation | null = null;
    let which: number | null = null;
    if (result) {
      const match = result.embedding ? bestMatch(l2normalize(result.embedding), this.faces.map(face => face.vector)) : null;
      which = match?.which ?? null;
      observation = { found: result.found, detScore: result.detScore, faceWidth: result.faceWidth, frontal: result.frontal,
        sharpness: result.sharpness, brightness: result.brightness, similarity: match?.similarity ?? null };
    }
    cls = classifyCheck(observation, this.knobs);
    this.count(cls);
    if (cls !== 'skipped') {
      const now = this.now();
      this.idleWatch.ran(now); this.noFrames = 0; this.noResult = 0;
      const row = checkRow(cls, observation, which, !!observation && isClearFace(observation, this.knobs));
      if (row && this.scoreGate.admit(row.outcome, row.similarity, now)) { try { this.deps.record?.(row); } catch { /* journal only */ } }
    }
    const step = this.decision.step(cls, this.now());
    if (step.changed) {
      if (step.state === 'not-you') this.counts.stranger++;
      this.emit();
      this.flushJournal();
    }
    if (cls === 'match' && observation && result?.embedding && shouldAugment(this.faces, observation, result.embedding, this.now(), this.knobs)) {
      this.faces = [...this.faces, { vector: l2normalize(result.embedding), source: 'auto', at: this.now() }];
      void this.deps.data.save({ enabled: this.on, faces: this.faces }).catch(() => undefined);
      this.publish();
    }
    return cls;
  }

  private count(cls: CheckClass): void {
    if (cls === 'match') this.counts.matched++;
    else if (cls === 'clear-not') this.counts.notYou++;
    else if (cls === 'skipped') this.counts.skipped++;
    else this.counts.unsure++;
  }

  private flushJournal(): void {
    const counts = this.counts;
    if (!counts.matched && !counts.notYou && !counts.unsure && !counts.skipped && !counts.stranger) { this.lastJournal = this.now(); return; }
    const taken = this.takeCounts();
    try { this.deps.journal?.(taken); } catch { /* keeping a record never blocks her */ }
  }

  private emit(): void {
    const state = this.decision.state;
    for (const listener of [...this.listeners]) { try { listener(state); } catch { /* one listener never blocks another */ } }
  }

  // ------------------------------------------------------------------ the worker

  private analyze(frame: FaceFrame): Promise<FaceResultMessage | null> {
    return this.ensureWorker().then(running => {
      if (!running) return null;
      const id = `face-${++this.sequence}`;
      return new Promise<FaceResultMessage | null>(resolve => {
        const entry: Pending = {
          resolve: value => { running.pending.delete(id); this.clearTimer(entry.timer); resolve(value); },
          timer: this.setTimer(() => { entry.resolve(null); this.crashed(running); }, this.knobs.schedule.analyzeTimeoutMs),
        };
        running.pending.set(id, entry);
        // A copy, not a transfer: the frame's buffer may be shared with the caller.
        const data = frame.rgba.slice().buffer;
        try { running.worker.postMessage({ type: 'analyze', id, width: frame.width, height: frame.height, data }); }
        catch { entry.resolve(null); this.crashed(running); }
      });
    }, () => null);
  }

  private ensureWorker(): Promise<Running | null> {
    if (this.running && !this.running.exited) return this.running.ready.then(ok => ok ? this.running : null);
    const store = this.deps.store, dir = store?.installedDir();
    const detector = store?.installedFile(FACE_MODEL_FILES.detector), recognizer = store?.installedFile(FACE_MODEL_FILES.recognizer);
    if (!store || !dir || !detector || !recognizer || this.gaveUp) return Promise.resolve(null);
    const files = FACE_MANIFEST.archives.flatMap(archive => archive.files.all ?? []);
    const detectorFile = files.find(file => file.to === FACE_MODEL_FILES.detector)!, recognizerFile = files.find(file => file.to === FACE_MODEL_FILES.recognizer)!;
    let worker: FaceWorkerHandle;
    try { worker = this.deps.fork(); } catch { this.noteCrash(); return Promise.resolve(null); }
    let settle!: (ok: boolean) => void;
    const ready = new Promise<boolean>(resolve => { settle = resolve; });
    const running: Running = { worker, ready, isReady: false, pending: new Map(), exited: false };
    this.running = running;
    const readyTimer = this.setTimer(() => { settle(false); this.crashed(running); }, READY_TIMEOUT_MS);
    worker.onMessage(raw => {
      if (this.running !== running) return;
      const message = parseFaceWorkerMessage(raw);
      if (!message) return;
      if (message.type === 'ready') { this.clearTimer(readyTimer); running.isReady = true; settle(true); this.publish(); }
      else if (message.type === 'failed') { this.clearTimer(readyTimer); settle(false); this.notice = 'failed'; this.crashed(running); }
      else if (message.type === 'result') running.pending.get(message.id)?.resolve(message);
      else if (message.type === 'error') running.pending.get(message.id)?.resolve(null);
    });
    worker.onExit(() => {
      running.exited = true;
      this.clearTimer(readyTimer);
      settle(false);
      for (const entry of [...running.pending.values()]) entry.resolve(null);
      if (this.running === running) { this.running = null; this.noteCrash(); this.publish(); }
    });
    try {
      worker.postMessage({ type: 'init', runtimeEntry: path.join(dir, ...FACE_RUNTIME_ENTRY.split('/')),
        detector, detectorSize: detectorFile.size, detectorSha256: detectorFile.sha256,
        recognizer, recognizerSize: recognizerFile.size, recognizerSha256: recognizerFile.sha256, threads: this.deps.threads ?? 1 });
    } catch { settle(false); this.crashed(running); }
    this.publish();
    return ready.then(ok => ok ? running : null);
  }

  private noteCrash(): void {
    const now = this.now();
    this.crashes = [...this.crashes.filter(at => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) { this.gaveUp = true; this.notice = 'failed'; this.sync(); }
  }

  private crashed(running: Running): void {
    if (this.running !== running) return;
    this.retire(running);
    this.noteCrash();
    this.publish();
  }

  private retire(running: Running): void {
    if (this.running === running) this.running = null;
    for (const entry of [...running.pending.values()]) entry.resolve(null);
    if (running.exited) return;
    try { running.worker.postMessage({ type: 'stop' }); } catch { /* already gone */ }
    this.setTimer(() => { if (!running.exited) try { running.worker.kill(); } catch { /* exited */ } }, EXIT_GRACE_MS);
  }

  private stopWorker(): void { const running = this.running; if (running) this.retire(running); }

  // ------------------------------------------------------------------ view

  view(): FaceCheckView {
    const store = this.deps.store;
    const phase: FaceCheckPhase = !store ? 'unsupported' : this.job ? this.job.stage : !store.installed ? 'not-installed'
      : !this.running || this.running.exited ? 'idle' : this.running.isReady ? 'ready' : 'starting';
    let shared = false;
    try { shared = !!this.deps.sharedRuntime?.(); } catch { shared = false; }
    const camera = this.cameraOn();
    return {
      enabled: this.on, phase, downloadBytes: shared ? FACE_MODEL_DOWNLOAD_BYTES : store?.downloadBytes ?? 0, installedBytes: store?.installedBytes ?? 0,
      progress: this.job?.progress ?? null, enrolled: Math.min(64, this.faces.length),
      enrolling: this.enrolling ? Math.round(this.enrolling.progress * 100) / 100 : null,
      camera, active: camera && (this.scheduler.isActive || !!this.enrolling), notice: this.notice,
    };
  }

  private publish(): void {
    const view = this.view();
    if (this.published && sameFaceCheckView(this.published, view)) return;
    this.published = view;
    try { this.deps.publish(view); } catch { /* a closed window misses one update */ }
  }

  // ------------------------------------------------------------------ control-window actions

  /**
   * The switch. On: saved; when the models are missing their one-time download starts now (this click is the consent; the
   * explanation is right beside the switch). Off: saved, checks and the worker stop, the verdict goes back to 'you'.
   * Enrolled faces stay until 「删除我的脸部数据」.
   */
  async setEnabled(on: boolean): Promise<FaceCheckView> {
    if (typeof on !== 'boolean') throw new Error('bad value');
    const store = this.deps.store;
    if (!store) return this.view();
    this.on = on; this.notice = ''; this.gaveUp = false; this.crashes = [];
    if (!on) { this.job?.controller?.abort(); this.enrolling?.controller.abort(); }
    await this.deps.data.save({ enabled: on, faces: this.faces }).catch(() => undefined);
    this.sync();
    if (on && !store.installed && !this.job) void this.download();
    return this.view();
  }

  /** Only ever started by turning the switch on (or the retry button). */
  async download(): Promise<FaceCheckView> {
    const store = this.deps.store;
    if (!store || this.job || store.installed || !this.on) return this.view();
    const controller = new AbortController();
    this.job = { stage: 'downloading', progress: 0, controller }; this.notice = ''; this.sync();
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
      this.notice = error instanceof ComponentInstallError ? error.failure : 'download-failed';
    } finally { this.job = null; this.sync(); }
    return this.view();
  }

  cancelDownload(): void {
    if (!this.job?.controller) return;
    this.job.controller.abort();
    // Canceling is the user saying no: the switch goes off too.
    this.on = false; void this.deps.data.save({ enabled: false, faces: this.faces }).catch(() => undefined);
  }

  /**
   * 「登记我的脸」: look at the camera for a few seconds; 3–5 clear samples of the same face become the stored set (replacing
   * any earlier one). Needs the switch on, the models, the camera on and secure storage. Nothing is stored when it fails.
   */
  async enrol(): Promise<FaceCheckView> {
    if (!this.on || !this.installed || this.job || this.enrolling) return this.view();
    if (!this.deps.data.encryptionAvailable) { this.notice = 'no-encryption'; this.publish(); return this.view(); }
    if (!this.cameraOn()) { this.notice = 'enrol-needs-camera'; this.publish(); return this.view(); }
    const controller = new AbortController();
    this.enrolling = { progress: 0, controller }; this.notice = '';
    this.sync();
    const rule = this.knobs.enrol;
    const samples: Float32Array[] = [];
    const started = this.now();
    try {
      while (samples.length < rule.samples && this.now() - started < rule.timeoutMs && !controller.signal.aborted && this.cameraOn()) {
        const frame = await this.deps.frames.grab('enrol', controller.signal).catch(() => null);
        const result = frame && !controller.signal.aborted ? await this.analyze(frame) : null;
        let observation: FaceObservation | null = null;
        if (result && !controller.signal.aborted) {
          observation = { found: result.found, detScore: result.detScore, faceWidth: result.faceWidth, frontal: result.frontal,
            sharpness: result.sharpness, brightness: result.brightness, similarity: null };
          if (judgeEnrolSample(samples, observation, result.embedding, this.knobs) === 'taken' && result.embedding) {
            samples.push(l2normalize(result.embedding));
            this.enrolling.progress = samples.length / rule.samples; this.publish();
          }
        }
        if (!controller.signal.aborted) this.showEnrolPreview(frame, result?.box ?? null, enrolHint(observation, this.knobs), samples.length);
        if (samples.length < rule.samples) await new Promise(resolve => this.setTimer(() => resolve(undefined), rule.intervalMs));
      }
      if (!controller.signal.aborted && samples.length >= rule.minSamples) {
        const at = this.now();
        const faces = samples.map(vector => ({ vector, source: 'enrol' as const, at }));
        await this.deps.data.save({ enabled: this.on, faces });
        this.faces = faces;
        this.decision.reset();
        this.notice = 'enrolled';
      } else if (!controller.signal.aborted) this.notice = this.cameraOn() ? 'enrol-failed' : 'enrol-needs-camera';
    } catch { this.notice = this.deps.data.encryptionAvailable ? 'enrol-failed' : 'no-encryption'; }
    finally { samples.length = 0; this.enrolling = null; this.showEnrolPreview(null, null, 'starting', 0, true); this.sync(); }
    return this.view();
  }

  /** The live picture in the enrolment area (2026-11-25): only while enrolling, only to the control window, never kept; `end` closes it. */
  private showEnrolPreview(frame: FaceFrame | null, box: readonly [number, number, number, number] | null, hint: FaceEnrolHint, taken: number, end = false): void {
    try {
      this.deps.preview?.(end ? null : { frame, box: box ? { x: box[0], y: box[1], width: box[2], height: box[3] } : null, hint, taken, total: this.knobs.enrol.samples });
    } catch { /* a closed window misses one picture */ }
  }

  cancelEnrol(): FaceCheckView { this.enrolling?.controller.abort(); return this.view(); }

  /** 「删除我的脸部数据」: every stored embedding and the saved switch go; the switch is off. The models stay (removeComponent). */
  async deleteData(): Promise<FaceCheckView> {
    this.enrolling?.controller.abort();
    this.on = false; this.faces = [];
    try { await this.deps.data.deleteAll(); this.notice = 'deleted'; } catch { this.notice = 'failed'; }
    this.sync();
    return this.view();
  }

  /** Offline package: files the user picked in the host's own file dialog (paths never reach a renderer). Accepted by size + hash only. */
  async importFiles(paths: readonly string[]): Promise<FaceCheckView> {
    const store = this.deps.store;
    if (!store || this.job || !paths.length) return this.view();
    this.job = { stage: 'installing', progress: null, controller: null }; this.notice = ''; this.sync();
    try {
      const result = await store.importFiles(paths);
      this.notice = result.complete ? '' : 'verify-failed';
    } catch { this.notice = 'verify-failed'; }
    finally { this.job = null; this.sync(); }
    return this.view();
  }

  /** Delete the two models (and the runtime copy) from the advanced settings; checks stop first. */
  async removeComponent(): Promise<FaceCheckView> {
    const store = this.deps.store;
    if (!store || this.job) return this.view();
    this.enrolling?.controller.abort();
    const running = this.running;
    this.stopWorker();
    this.job = { stage: 'installing', progress: null, controller: null }; this.sync();
    try {
      if (running && !running.exited) await new Promise(resolve => this.setTimer(() => resolve(undefined), EXIT_GRACE_MS + 500));
      await store.remove();
      this.notice = 'removed';
    } catch { this.notice = 'verify-failed'; }
    finally { this.job = null; this.sync(); }
    return this.view();
  }

  dispose(): void {
    this.job?.controller?.abort(); this.enrolling?.controller.abort(); this.checking?.abort();
    if (this.ticker) { this.clearTicker(this.ticker); this.ticker = null; }
    this.flushJournal();
    this.stopWorker();
  }
}
