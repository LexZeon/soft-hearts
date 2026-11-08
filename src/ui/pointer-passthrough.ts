import type { StageAlpha } from '../stage/pixel-probe';

/**
 * Click-through that keeps her touchable.
 *
 * In click-through the host lets the mouse fall through the pet window and only forwards
 * moves (electron/pet-pointer-input.ts). This decides, from those moves, when the window
 * should take the mouse after all: over her drawn pixels or over a visible control
 * (toolbar, chat box, panels). Only the transparent space around her lets clicks through.
 *
 * - A visible control is found with elementFromPoint: hidden/faded controls already have
 *   pointer-events:none or opacity 0, so they are not hits.
 * - Her body is read from the rendered frame (src/stage/pixel-probe.ts), at most every
 *   PROBE_INTERVAL_MS while the pointer moves and every IDLE_PROBE_MS while it rests over
 *   the window (she moves under a still pointer). Nothing runs off click-through.
 * - Taking the mouse is immediate; giving it back waits RELEASE_DELAY_MS of misses, and
 *   the alpha needed to stay is lower and wider than the alpha needed to enter, so her
 *   outline does not flicker. A pressed button, a drag, camera editing, window adjusting
 *   or an open reader keep the mouse until they end.
 * - Late results (Codex T-112 round 031): while something holds the whole window, a pixel
 *   result changes nothing; leaving the window or pointing outside it withdraws a read not
 *   yet submitted; a result read for a point the pointer has since moved away from cannot
 *   take the mouse for where it is now (it can still count as a miss).
 */
export type PointTarget = 'ui' | 'stage' | 'outside';
export const PASSTHROUGH_TIMING = Object.freeze({ probeIntervalMs: 50, idleProbeMs: 250, releaseDelayMs: 200, probeTimeoutMs: 400 });
/** Alpha (0–255) to start receiving (inner 3×3) and to keep receiving (outer 9×9). */
export const PASSTHROUGH_ALPHA = Object.freeze({ enter: 64, stay: 16 });
/** A result still speaks for the pointer within this many CSS px of the point it was read for (about the read block). */
export const PASSTHROUGH_NEAR_PX = 4;

export interface PassthroughState {
  active: boolean;
  receiving: boolean;
  target: PointTarget | 'none';
  probes: number;
  hits: number;
  requests: number;
}
export interface PassthroughPorts {
  /** Click-through is on and the pet window is shown. */
  enabled(): boolean;
  /** A mode that owns the whole window while it lasts (camera edit, window adjust, drag, reader). */
  holds(): boolean;
  classify(x: number, y: number): PointTarget;
  /** `signal` aborts when the answer is no longer wanted (a read not yet submitted should not happen). */
  probe(x: number, y: number, signal?: AbortSignal): Promise<StageAlpha | null>;
  /** Host request; resolves to whether the window now receives the mouse. */
  request(receive: boolean): Promise<boolean>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  report?(state: PassthroughState): void;
}

export class PointerPassthrough {
  private pointer: { x: number; y: number } | null = null;
  private buttons = 0;
  private active = false;
  /** What was last asked of the host, and what it last confirmed. */
  private wanted = false;
  private receiving = false;
  private requestSeq = 0;
  private lastHitAt = -Infinity;
  private probeToken = 0;
  private probing: { point: { x: number; y: number }; timeout: unknown; abort: AbortController | null } | null = null;
  private lastProbeAt = -Infinity;
  private timer: unknown = null;
  private timerDue = Infinity;
  private target: PointTarget | 'none' = 'none';
  private counts = { probes: 0, hits: 0, requests: 0 };
  private disposed = false;
  constructor(private readonly ports: PassthroughPorts, private readonly timing = PASSTHROUGH_TIMING, private readonly alpha = PASSTHROUGH_ALPHA) {}

  /** Clears any wish an earlier page left with the host (reload); the host also resets on its own transitions. */
  start(): void { this.send(false); this.evaluate(); }
  move(x: number, y: number, buttons: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.pointer = { x, y };
    this.buttons = Number.isFinite(buttons) ? buttons : 0;
    this.evaluate();
  }
  leave(): void { this.pointer = null; this.evaluate(); }
  /** Settings, visibility or a holding mode changed. */
  refresh(): void { this.evaluate(); }
  get state(): PassthroughState {
    return { active: this.active, receiving: this.receiving, target: this.target, ...this.counts };
  }
  dispose(): void { this.disposed = true; this.cancelProbe(); this.clearTimer(); }

  private evaluate(): void {
    if (this.disposed) return;
    this.clearTimer();
    if (!this.ports.enabled()) {
      if (this.active) {
        this.active = false; this.cancelProbe(); this.lastHitAt = -Infinity; this.target = 'none';
        if (this.wanted || this.receiving) { this.wanted = false; this.send(false); }
      }
      this.report();
      return;
    }
    if (!this.active) {
      // The host forgets any earlier wish when click-through turns on.
      this.active = true; this.wanted = this.receiving = false; this.lastHitAt = -Infinity; this.lastProbeAt = -Infinity;
    }
    const now = this.ports.now();
    // Held: nothing read before it may change that (round 031), so a read still out is dropped; a fresh one starts after.
    if (this.holding()) { this.cancelProbe(); this.hit(now); return; }
    const point = this.pointer;
    // Left the window: let go after the same short delay, so a stray leave during the native switch cannot flap.
    if (!point) { this.target = 'none'; this.cancelProbe(); this.settle(now); return; }
    const target = this.target = this.ports.classify(point.x, point.y);
    if (target === 'ui') { this.cancelProbe(); this.hit(now); return; }
    if (target === 'outside') { this.cancelProbe(); this.settle(now); return; }
    if (!this.probing) {
      const wait = this.lastProbeAt + this.timing.probeIntervalMs - now;
      if (wait <= 0) this.startProbe(point, now);
      else this.schedule(wait);
    }
    this.scheduleIdle();
    this.report();
  }

  /** A drag, camera editing, window adjusting, a reader, or a pressed button while the window has the mouse. */
  private holding(): boolean { return this.ports.holds() || (this.buttons !== 0 && (this.wanted || this.receiving)); }

  private hit(now: number): void {
    this.lastHitAt = now;
    this.counts.hits++;
    this.want(true);
    this.scheduleIdle();
    this.report();
  }

  /** A miss: let go only after RELEASE_DELAY_MS without a hit. */
  private settle(now: number): void {
    const remaining = this.lastHitAt + this.timing.releaseDelayMs - now;
    if ((this.wanted || this.receiving) && remaining > 0) this.schedule(remaining);
    else this.want(false);
    this.scheduleIdle();
    this.report();
  }

  private startProbe(point: { x: number; y: number }, now: number): void {
    const token = ++this.probeToken;
    this.lastProbeAt = now;
    this.counts.probes++;
    const finish = (alpha: StageAlpha | null) => {
      if (token !== this.probeToken || !this.probing) return;
      this.ports.clearTimer(this.probing.timeout);
      const pointer = this.pointer;
      const moved = pointer !== null && (pointer.x !== point.x || pointer.y !== point.y);
      // Read for where the pointer was, not near where it is now: "her" there does not mean her here (round 031, A → B).
      const away = pointer !== null && Math.hypot(pointer.x - point.x, pointer.y - point.y) > PASSTHROUGH_NEAR_PX;
      this.probing = null;
      if (this.disposed || !this.active) return;
      if (this.holding()) { this.evaluate(); return; } // Held since it was asked: the result changes nothing.
      const keeping = this.wanted || this.receiving;
      const found = alpha !== null && (keeping ? alpha.outer >= this.alpha.stay : alpha.inner >= this.alpha.enter);
      const time = this.ports.now();
      if (found && pointer && !away) this.hit(time);
      else if (!found || !pointer) this.settle(time); // A miss still counts as one (the release delay still applies).
      if (moved) this.evaluate();
    };
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    this.probing = { point, timeout: this.ports.setTimer(() => finish(null), this.timing.probeTimeoutMs), abort };
    let pending: Promise<StageAlpha | null>;
    try { pending = this.ports.probe(point.x, point.y, abort?.signal); } catch { pending = Promise.resolve(null); }
    void pending.then(finish, () => finish(null));
  }

  /** Drops the read still out: its answer is ignored, and one not yet submitted is withdrawn (no read after leaving). */
  private cancelProbe(): void {
    const probing = this.probing;
    if (!probing) return;
    this.ports.clearTimer(probing.timeout);
    this.probing = null;
    this.probeToken++;
    try { probing.abort?.abort(); } catch { /* The answer is ignored either way. */ }
  }

  private want(receive: boolean): void {
    if (receive === this.wanted) return;
    this.wanted = receive;
    this.send(receive);
  }

  private send(receive: boolean): void {
    const seq = ++this.requestSeq;
    this.counts.requests++;
    let pending: Promise<boolean>;
    try { pending = this.ports.request(receive); } catch (error) { pending = Promise.reject(error); }
    void pending.then(applied => {
      if (seq !== this.requestSeq || this.disposed) return;
      // The host may refuse (cursor already outside the window); its answer is the truth.
      this.receiving = applied === true;
      if (this.active) this.wanted = this.receiving;
      this.report();
    }, () => {
      if (seq !== this.requestSeq || this.disposed) return;
      this.wanted = this.receiving;
      this.report();
    });
  }

  /** Re-check under a still pointer: she moves, and a held hit has to expire. */
  private scheduleIdle(): void { if (this.active && this.pointer) this.schedule(this.timing.idleProbeMs); }

  private schedule(ms: number): void {
    const due = this.ports.now() + Math.max(0, ms);
    if (this.timer !== null && due >= this.timerDue) return;
    if (this.timer !== null) this.ports.clearTimer(this.timer);
    this.timerDue = due;
    this.timer = this.ports.setTimer(() => { this.timer = null; this.timerDue = Infinity; this.evaluate(); }, Math.max(0, ms));
  }

  private clearTimer(): void {
    if (this.timer !== null) this.ports.clearTimer(this.timer);
    this.timer = null; this.timerDue = Infinity;
  }

  private report(): void { this.ports.report?.(this.state); }
}

/** What is under a client point of the pet window: a shown control, the stage (her or empty space), or nothing. */
export interface HitDocument {
  elementFromPoint(x: number, y: number): Element | null;
  readonly documentElement: Element;
  readonly body: Element | null;
  readonly defaultView: { innerWidth: number; innerHeight: number } | null;
}
export function classifyPetPoint(doc: HitDocument, x: number, y: number, stageRoot: Element): PointTarget {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'outside';
  const view = doc.defaultView;
  if (view && (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight)) return 'outside';
  const element = doc.elementFromPoint(x, y);
  if (!element) return 'outside';
  if (element === doc.documentElement || element === doc.body || element.id === 'app' || stageRoot.contains(element)) return 'stage';
  return shown(element) ? 'ui' : 'stage';
}
function shown(element: Element): boolean {
  const check = (element as Element & { checkVisibility?(options?: object): boolean }).checkVisibility;
  return typeof check !== 'function' || check.call(element, { opacityProperty: true, visibilityProperty: true });
}

export interface PetPointerPassthroughOptions {
  document: Document;
  stageRoot: HTMLElement;
  probe(x: number, y: number, signal?: AbortSignal): Promise<StageAlpha | null>;
  enabled(): boolean;
  holds(): boolean;
  request(receive: boolean): Promise<boolean>;
  /** Host window-visibility updates; re-checked after every listener of the same update has run. */
  visibility?(callback: () => void): () => void;
}
/** Wires the controller to the pet window's own pointer events. */
export function installPetPointerPassthrough(options: PetPointerPassthroughOptions): { refresh(): void; dispose(): void; readonly state: PassthroughState } {
  const doc = options.document, view = doc.defaultView!, root = doc.documentElement;
  let reported = '';
  const controller = new PointerPassthrough({
    enabled: options.enabled, holds: options.holds, probe: options.probe, request: options.request,
    classify: (x, y) => classifyPetPoint(doc, x, y, options.stageRoot),
    now: () => view.performance.now(),
    setTimer: (callback, ms) => view.setTimeout(callback, ms),
    clearTimer: handle => view.clearTimeout(handle as number),
    // Diagnostics for smoke checks: which state the window is in, not where the pointer is.
    report: state => {
      const next = `${state.active ? (state.receiving ? 'receive' : 'pass') : 'off'}`;
      if (next !== reported) { reported = next; root.setAttribute('data-pointer-passthrough', next); }
    },
  });
  const sample = (event: PointerEvent) => controller.move(event.clientX, event.clientY, event.buttons);
  const out = (event: PointerEvent) => { if (!event.relatedTarget) controller.leave(); };
  const leave = () => controller.leave();
  const refresh = () => controller.refresh();
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerover'] as const) view.addEventListener(type, sample, { capture: true, passive: true });
  view.addEventListener('pointerout', out, { capture: true, passive: true });
  root.addEventListener('pointerleave', leave);
  view.addEventListener('blur', refresh);
  doc.addEventListener('visibilitychange', refresh);
  const unsubscribe = options.visibility?.(() => queueMicrotask(refresh));
  controller.start();
  return {
    refresh,
    get state() { return controller.state; },
    dispose() {
      for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerover'] as const) view.removeEventListener(type, sample, { capture: true });
      view.removeEventListener('pointerout', out, { capture: true });
      root.removeEventListener('pointerleave', leave);
      view.removeEventListener('blur', refresh);
      doc.removeEventListener('visibilitychange', refresh);
      unsubscribe?.();
      controller.dispose();
    },
  };
}
