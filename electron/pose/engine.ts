/**
 * The pose inference loop inside the utility process: self-test (GPU vs CPU on synthetic frames), per-frame
 * detection + pose, in-process DirectML → CPU fallback, the slow-computer ladder and adaptive frame rate.
 * `ort` is injected (onnxruntime-node from the component folder in the app; a fake in tests).
 */
import type { PoseSignal } from '../../shared/pose-signals';
import { PoseFeatureTracker } from './features';
import { boxFromKeypoints, detectorBoxes, detectorInput, poseInput, simccDecode, syntheticFrame, RTMDET_NANO, RTMPOSE_M, type Box } from './pipeline';
import type { WorkerToHost } from './protocol';
import { DegradeLadder, LADDER, SlowGpuWatch, budgetMs, chooseRoute, p90, type RouteName, type SelfTest } from './route';

export interface OrtTensorLike { data: ArrayLike<number>; dims: readonly number[] }
export interface OrtSessionLike {
  inputNames: readonly string[]; outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}
export interface OrtLike {
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSessionLike> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
export interface ModelBytes { detector: Uint8Array; pose: Uint8Array }

export function sessionOptions(route: RouteName): Record<string, unknown> {
  const base = { graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  return route === 'dml'
    // DirectML needs sequential execution and no memory-pattern optimisation.
    ? { ...base, executionProviders: [{ name: 'dml', deviceId: 0 }], executionMode: 'sequential', enableMemPattern: false }
    // 2 threads with spinning off: 0.43 cores at 5 fps on the test machine; the default (one thread per core) was 3× slower.
    : { ...base, executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1,
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } };
}

interface Sessions { route: RouteName; detector: OrtSessionLike; pose: OrtSessionLike }

export interface EngineOptions {
  ort: OrtLike;
  loadModels(): Promise<ModelBytes>;
  emit(message: WorkerToHost): void;
  now?: () => number;
  selfTestFrames?: number;
}

export class PoseEngine {
  private sessions: Sessions | null = null;
  private ladder: DegradeLadder | null = null;
  private readonly tracker = new PoseFeatureTracker();
  private readonly gpuWatch = new SlowGpuWatch();
  private box: Box | null = null;
  private detScore = 0;
  private sinceDetect = Infinity;
  private dmlBad = false;
  private pressure = false;
  private lastEmit = -Infinity;
  private lastPresent = false;
  private burstUntil = -Infinity;
  private burstCooldownUntil = -Infinity;
  private busy = false;
  private disposed = false;
  /** Work that uses the sessions (self-test, a frame, the CPU fallback): dispose() lets it finish first. */
  private readonly work = new Set<Promise<unknown>>();
  private costs: number[] = [];
  private readonly now: () => number;

  constructor(private readonly options: EngineOptions) { this.now = options.now ?? (() => performance.now()); }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    const done = () => { this.work.delete(promise); };
    promise.then(done, done);
    return promise;
  }

  private async open(route: RouteName, models: ModelBytes): Promise<Sessions> {
    const { ort } = this.options;
    const detector = await ort.InferenceSession.create(models.detector, sessionOptions(route));
    try { return { route, detector, pose: await ort.InferenceSession.create(models.pose, sessionOptions(route)) }; }
    catch (error) { await detector.release().catch(() => undefined); throw error; }
  }
  private async close(sessions: Sessions | null): Promise<void> {
    if (!sessions) return;
    await Promise.allSettled([sessions.detector.release(), sessions.pose.release()]);
  }

  /**
   * p90 of full frames and of detector-only work on the synthetic pattern (first frame excluded: graph compile).
   * null: stopped part-way (dispose), so no more work goes to the graphics card.
   */
  private async measure(sessions: Sessions, frames: number): Promise<{ full: number; detect: number } | null> {
    const rgba = syntheticFrame(320, 240), full: number[] = [], detect: number[] = [];
    for (let i = 0; i <= frames; i++) {
      if (this.disposed) return null;
      const start = this.now();
      const box = await this.detect(sessions, rgba, 320, 240);
      const mid = this.now();
      await this.estimate(sessions, rgba, 320, 240, box ?? { x1: 100, y1: 40, x2: 220, y2: 240, score: 1 });
      if (i > 0) { full.push(this.now() - start); detect.push(mid - start); }
    }
    return { full: p90(full), detect: p90(detect) };
  }

  /**
   * Pick DirectML or CPU (20 synthetic frames each; with a cached choice for this computer only the cached
   * route is opened and timed briefly). Never throws for a route problem: a failed route is simply not chosen.
   */
  init(cache: { prefer: RouteName | null; dmlBad: boolean }): Promise<void> { return this.track(this.selfTest(cache)); }

  private async selfTest(cache: { prefer: RouteName | null; dmlBad: boolean }): Promise<void> {
    this.dmlBad = cache.dmlBad;
    let models: ModelBytes;
    try { models = await this.options.loadModels(); } catch { if (!this.disposed) this.options.emit({ type: 'failed', reason: 'models' }); return; }
    const test: SelfTest = { dml: null, cpu: null, dmlDetect: null, cpuDetect: null };
    const order: RouteName[] = cache.prefer ? [cache.prefer, cache.prefer === 'dml' ? 'cpu' : 'dml'] : ['dml', 'cpu'];
    const opened = new Map<RouteName, Sessions>();
    for (const route of order) {
      if (this.disposed) break;
      if (route === 'dml' && this.dmlBad) continue;
      if (cache.prefer && opened.size) break; // cached route worked: no need to time the other one
      let sessions: Sessions | null = null;
      try {
        sessions = await this.open(route, models);
        const result = await this.measure(sessions, cache.prefer ? 5 : this.options.selfTestFrames ?? 20);
        if (!result) { await this.close(sessions); break; } // stopped part-way
        test[route] = result.full; test[route === 'dml' ? 'dmlDetect' : 'cpuDetect'] = result.detect;
        opened.set(route, sessions);
      } catch {
        await this.close(sessions); // a route that failed part-way never keeps its sessions open
        if (route === 'dml' && !this.disposed) this.dmlBad = true;
      }
    }
    if (this.disposed) { for (const sessions of opened.values()) await this.close(sessions); return; }
    const choice = chooseRoute(test);
    for (const [route, sessions] of opened) if (route !== choice?.route) await this.close(sessions);
    if (!choice) { this.options.emit(opened.size ? { type: 'paused' } : { type: 'failed', reason: 'no-route' }); return; }
    this.sessions = opened.get(choice.route)!;
    this.ladder = new DegradeLadder(choice.index, this.now());
    this.options.emit({ type: 'ready', route: choice.route, level: this.ladder.step.level,
      p90: { dml: round(test.dml), cpu: round(test.cpu) }, dmlBad: this.dmlBad });
  }

  get route(): RouteName | null { return this.sessions?.route ?? null; }

  /** Frames per second the sensor window should send now. 0: paused. */
  desiredFps(): number {
    const ladder = this.ladder;
    if (!ladder || ladder.paused || !this.sessions) return 0;
    const step = ladder.step, t = this.now();
    if (!this.tracker.present) return step.absentFps;
    if (step.burstFps && !this.pressure) {
      if (t < this.burstUntil) return step.burstFps;
      // A short 10 fps burst (waving is ~2 Hz, at the edge of 5 fps) only when frames are cheap enough for it.
      if (t >= this.burstCooldownUntil && this.costs.length >= 5 && p90(this.costs) <= budgetMs(step.burstFps) && this.tracker.wantsBurst()) {
        this.burstUntil = t + 6_000; this.burstCooldownUntil = this.burstUntil + 6_000;
        return step.burstFps;
      }
    }
    return step.presentFps;
  }

  setPressure(on: boolean): void { this.pressure = on; }

  private async detect(sessions: Sessions, rgba: Uint8Array, w: number, h: number): Promise<Box | null> {
    const { ort } = this.options;
    const input = detectorInput(rgba, w, h, RTMDET_NANO);
    const out = await sessions.detector.run({ [sessions.detector.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, RTMDET_NANO.size, RTMDET_NANO.size]) });
    const dets = out[sessions.detector.outputNames[0]];
    const boxes = detectorBoxes(dets.data, dets.dims[1] ?? 0, input.ratio, w, h);
    return boxes[0] ?? null;
  }
  private async estimate(sessions: Sessions, rgba: Uint8Array, w: number, h: number, box: Box) {
    const { ort } = this.options;
    const input = poseInput(rgba, w, h, box, RTMPOSE_M);
    const out = await sessions.pose.run({ [sessions.pose.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, RTMPOSE_M.height, RTMPOSE_M.width]) });
    return simccDecode(out[sessions.pose.outputNames[0]].data, out[sessions.pose.outputNames[1]].data, RTMPOSE_M, input.center, input.scale);
  }

  /** One camera frame (RGBA). Frames that arrive while one is in flight, or after dispose(), are dropped. */
  async frame(rgba: Uint8Array, w: number, h: number): Promise<void> {
    if (this.busy || this.disposed || !this.sessions || !this.ladder || this.ladder.paused) return;
    this.busy = true;
    try { await this.track(this.process(rgba, w, h)); }
    finally { this.busy = false; }
  }

  private async process(rgba: Uint8Array, w: number, h: number): Promise<void> {
    const sessions = this.sessions!, ladder = this.ladder!, step = ladder.step, start = this.now();
    try {
      let kpts: Float32Array | null = null, scores: Float32Array | null = null, detected = false;
      if (!step.pose || !this.box || this.sinceDetect >= step.detectEvery) {
        const found = await this.detect(sessions, rgba, w, h);
        this.box = found; this.detScore = found?.score ?? 0; this.sinceDetect = 0; detected = !!found;
      } else { this.sinceDetect++; detected = true; }
      if (step.pose && this.box) {
        ({ kpts, scores } = await this.estimate(sessions, rgba, w, h, this.box));
        const next = boxFromKeypoints(kpts, scores, w, h);
        if (!next) { this.box = null; detected = this.sinceDetect === 0 && detected; }
        else if (this.sinceDetect > 0) this.box = next;
      }
      const t = this.now();
      this.tracker.push({ t, detected, detScore: this.detScore, kpts, scores });
      const elapsed = t - start;
      this.costs.push(elapsed);
      if (this.costs.length > 20) this.costs.shift();
      if (sessions.route === 'dml' && this.gpuWatch.record(elapsed, budgetMs(step.presentFps))) { await this.fallBackToCpu(); return; }
      if (ladder.record(elapsed, t, this.pressure)) {
        if (ladder.paused) { this.options.emit({ type: 'paused' }); return; }
        this.box = null; this.sinceDetect = Infinity;
        this.options.emit({ type: 'level', level: ladder.step.level });
      }
      this.maybeEmit(t);
    } catch {
      if (this.disposed) return; // stopping: not a graphics-card failure, nothing to fall back to
      if (sessions.route === 'dml') await this.fallBackToCpu();
      else throw new Error('cpu inference failed');
    }
  }

  private maybeEmit(t: number): void {
    const step = this.ladder!.step;
    const signal: PoseSignal = this.tracker.signal(step.pose ? 'full' : 'presence-only');
    const changed = signal.present !== this.lastPresent || signal.events.length > 0;
    if (!changed && t - this.lastEmit < (signal.present ? 500 : 2_000)) {
      return;
    }
    this.lastEmit = t; this.lastPresent = signal.present;
    this.options.emit({ type: 'signal', signal });
  }

  /** DirectML broke or crawled: rebuild on the CPU inside this process; remembered for this computer. */
  private async fallBackToCpu(): Promise<void> {
    const old = this.sessions;
    this.sessions = null; this.dmlBad = true;
    await this.close(old);
    if (this.disposed) return;
    try {
      const sessions = await this.open('cpu', await this.options.loadModels());
      if (this.disposed) { await this.close(sessions); return; }
      this.sessions = sessions;
      this.box = null; this.sinceDetect = Infinity;
      this.options.emit({ type: 'route', route: 'cpu' });
    } catch { if (!this.disposed) this.options.emit({ type: 'failed', reason: 'runtime' }); }
  }

  /**
   * Stop (camera off, app quit): no new frames; the self-test, frame or CPU fallback in flight finishes first,
   * then every session is released — so the process never ends with work on the graphics card or a session open.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    while (this.work.size) await Promise.allSettled([...this.work]);
    const sessions = this.sessions; this.sessions = null;
    await this.close(sessions);
  }
}

const round = (n: number | null) => n === null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
