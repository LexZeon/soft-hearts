/**
 * Local pose sensing as the rest of the app sees it (I-001 stage 1). Pure: Electron pieces come in through
 * `PoseHostDeps` (electron/pose/electron-wiring.ts). This is the camera switch 「姿势识别」 — default off, only the user
 * turns it on — and it means "she may notice you, on this computer only". Since I-036 it is one of two
 * independent switches under 「摄像头共享」; the other, 「发图片」, sends small pictures with messages and needs no component
 * (electron/runtime.ts). Nothing here ever sends a picture:
 *
 *  - component installed  → mode `local`: frames stay in the sensor window + inference process.
 *  - not installed        → mode `blocked`: 「姿势识别」 stays off and the control window asks once, with the size.
 *  - other platforms      → mode `share`: there is no component package there; 「姿势识别」 is unavailable.
 */
import { EMPTY_POSE_SIGNAL, samePoseView, type PoseNotice, type PoseSensingView, type PoseSignal } from '../../shared/pose-signals';
import type { CameraRefusal, RuntimeState } from '../../shared/contracts';
import { ComponentInstallError, type ImportResult, type PoseComponentStore } from './component-store';
import { POSE_COMPONENT_VERSION } from './manifest';
import { PoseSupervisor, type PoseDiagnosticCategory, type SupervisorDeps } from './supervisor';

export type CameraMode = 'local' | 'share' | 'blocked';

export interface PoseHostDeps {
  store: PoseComponentStore | null;
  fork: SupervisorDeps['fork'];
  channel: SupervisorDeps['channel'];
  openSensor: SupervisorDeps['openSensor'];
  /** Fingerprint of this computer's GPU + driver (a change re-runs the self-test). */
  fingerprint(): Promise<string>;
  publish(view: PoseSensingView): void;
  /** Turn the camera switch off (the sensing process gave up). */
  disableCamera(): void;
  /** The user tried to turn the camera on from this window while the component is missing. */
  promptRaised(owner: 'controls' | 'pet'): void;
  trayChanged(sensing: boolean): void;
  developerMode(): boolean;
  onSignal?(signal: PoseSignal): void;
  now?(): number;
  setTimer?: SupervisorDeps['setTimer'];
  clearTimer?: SupervisorDeps['clearTimer'];
}

export class PoseSensingHost {
  readonly supervisor: PoseSupervisor;
  private prompt = false;
  /** Refused camera requests so far; a change tells the control window to bring the question into view again. */
  private asked = 0;
  private notice: PoseNotice = '';
  private job: { stage: 'downloading' | 'installing'; progress: number | null; controller: AbortController | null; fallback?: boolean } | null = null;
  private published: PoseSensingView | null = null;
  private sensing = false;

  constructor(private readonly deps: PoseHostDeps) {
    this.supervisor = new PoseSupervisor({
      prepare: () => this.prepare(),
      fork: deps.fork, channel: deps.channel, openSensor: deps.openSensor,
      saveRoute: result => { void this.saveRoute(result); },
      disableCamera: reason => { this.notice = reason === 'failed' ? 'crashed' : reason; this.deps.disableCamera(); this.publish(); },
      changed: () => this.publish(),
      signal: signal => this.deps.onSignal?.(signal),
      now: deps.now, setTimer: deps.setTimer, clearTimer: deps.clearTimer,
    });
  }

  /** Startup: quick installed check + old-version cleanup. */
  async init(): Promise<void> {
    await this.deps.store?.refresh().catch(() => false);
    this.publish();
  }

  /** Synchronous, for the camera switch. */
  cameraMode(): CameraMode {
    const store = this.deps.store;
    if (!store) return 'share';
    return store.installed && !store.working ? 'local' : 'blocked';
  }

  /**
   * The switch was refused (component missing or still being installed): the control window shows the one
   * question and brings it into view on every refused try, not only the first (2026-11-03: a second click from
   * the pet only focused the control window on whatever page it was on). The reason goes back to the window
   * that asked, which says it where the user clicked.
   */
  cameraBlocked(owner: 'controls' | 'pet'): CameraRefusal {
    this.prompt = true;
    this.asked++;
    if (this.notice !== 'download-failed' && this.notice !== 'verify-failed') this.notice = '';
    this.publish();
    this.deps.promptRaised(owner);
    return this.job || this.deps.store?.working ? 'preparing' : 'needs-component';
  }

  /** Follow the media runtime: local camera on ⇒ sensing on; anything else ⇒ off at once. */
  syncCamera(state: RuntimeState): void {
    this.supervisor.setWanted(state.cameraSharing && state.cameraLocal === true && this.cameraMode() === 'local');
  }

  /** Latest abstract signal while sensing runs (stage 2 hands it to mood and the inner loop). */
  latestSignal(): PoseSignal | null { return this.supervisor.phase === 'running' ? this.supervisor.latest ?? EMPTY_POSE_SIGNAL : null; }

  view(): PoseSensingView {
    const store = this.deps.store;
    const phase = !store ? 'unsupported' : this.job ? this.job.stage : !store.installed ? 'not-installed'
      : ({ off: 'idle', starting: 'starting', running: 'running', restarting: 'restarting' } as const)[this.supervisor.phase];
    return {
      phase, prompt: this.prompt && phase !== 'unsupported',
      // While falling back to the official sources the bigger number is the honest one.
      downloadBytes: (this.job?.fallback ? store?.officialDownloadBytes : store?.downloadBytes) ?? 0, installedBytes: store?.installedBytes ?? 0,
      progress: this.job?.progress ?? null, ...(this.job?.fallback ? { fallback: true } : {}),
      route: this.supervisor.phase === 'running' ? this.supervisor.route : null,
      level: this.supervisor.phase === 'running' ? this.supervisor.level : null,
      componentVersion: POSE_COMPONENT_VERSION, notice: this.notice,
      ...(this.asked && phase !== 'unsupported' ? { asked: this.asked } : {}),
    };
  }

  private publish(): void {
    const view = this.view();
    const sensing = this.supervisor.phase !== 'off';
    if (sensing !== this.sensing) { this.sensing = sensing; this.deps.trayChanged(sensing); }
    if (this.published && samePoseView(this.published, view)) return;
    this.published = view;
    this.deps.publish(view);
  }

  private async prepare() {
    const store = this.deps.store;
    const paths = store?.runtimePaths();
    if (!store || !paths) return null;
    const fingerprint = await this.deps.fingerprint().catch(() => '');
    const cached = await store.readRoute();
    const same = !!cached && !!fingerprint && cached.fingerprint === fingerprint;
    return { runtimeEntry: paths.runtimeEntry, detector: paths.detector, detectorSha256: paths.detectorSha256, pose: paths.pose,
      poseSha256: paths.poseSha256, prefer: same ? cached!.route : null, dmlBad: same ? cached!.dmlBad : false };
  }
  private async saveRoute(result: { route: 'dml' | 'cpu'; dmlBad: boolean; p90: { dml: number | null; cpu: number | null } }) {
    const store = this.deps.store;
    if (!store) return;
    const fingerprint = await this.deps.fingerprint().catch(() => '');
    const previous = await store.readRoute();
    const p90 = result.p90.dml === null && result.p90.cpu === null && previous ? previous.p90 : result.p90;
    await store.writeRoute({ fingerprint, route: result.route, dmlBad: result.dmlBad, p90 }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ control-window actions

  dismissPrompt(): PoseSensingView { this.prompt = false; this.publish(); return this.view(); }

  /** 「下载」: only ever started by this click. The camera stays off; the user turns it on when it is ready. */
  async download(): Promise<PoseSensingView> {
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
    return this.view();
  }

  cancelDownload(): void { this.job?.controller?.abort(); }

  /** Offline package: files the user picked in the host's own file dialog (paths never reach a renderer). */
  async importFiles(paths: readonly string[]): Promise<PoseSensingView & { result?: ImportResult }> {
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

  /** Delete every pose component (camera switch goes off first so no file is in use). */
  async remove(): Promise<PoseSensingView> {
    const store = this.deps.store;
    if (!store || this.job) return this.view();
    if (this.supervisor.phase !== 'off') { this.deps.disableCamera(); this.supervisor.stop(); }
    this.job = { stage: 'installing', progress: null, controller: null }; this.publish();
    try {
      await new Promise(resolve => (this.deps.setTimer ?? setTimeout)(() => resolve(undefined), 1_600)); // let the inference process exit
      await store.remove();
      this.notice = 'removed';
    } catch { this.notice = 'verify-failed'; }
    finally { this.job = null; this.publish(); }
    return this.view();
  }

  /** 「重新检测硬件」: forget the cached GPU/CPU choice; the next start runs the full self-test. */
  async redetect(): Promise<PoseSensingView> { await this.deps.store?.clearRoute().catch(() => undefined); return this.view(); }

  /** Developer diagnostics: signal categories and counts only. */
  diagnostics(): Partial<Record<PoseDiagnosticCategory, number>> {
    return this.deps.developerMode() ? Object.fromEntries(this.supervisor.diagnostics) : {};
  }

  /**
   * App quit: abort a download, stop sensing, start nothing new, and resolve once the inference process has
   * ended (bounded: see PoseSupervisor.shutdown). `busy` says whether there is anything to wait for at all.
   */
  shutdown(): Promise<void> { this.job?.controller?.abort(); return this.supervisor.shutdown(); }
  get busy(): boolean { return this.supervisor.busy; }

  dispose(): void { void this.shutdown(); }
}
