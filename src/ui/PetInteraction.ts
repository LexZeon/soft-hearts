import { CheekPinchTracker, hitCheek, type CheekRegion, type CheekPinchFeedback } from './CheekPinch';
import { FEED_SOURCE_MAX_BYTES } from '../../shared/feed-recognition';
/** rua-hover remains a compatibility literal only; valid scalp hits enter rua immediately. */
export type PetInteractionPhase = "idle" | "rua-hover" | "rua" | "cheek-hover" | "cheek" | "feeding-wait" | "feeding-ready" | "feeding-accepted";
export interface PetHeadRegion {
  /** All coordinates are CSS pixels relative to the interaction surface. */
  x: number;
  y: number;
  radius: number;
  /** Projected horizontal/vertical half axes; all four numbers form one ellipse. */
  axisXX?: number;
  axisXY?: number;
  axisYX?: number;
  axisYY?: number;
  /** Physical input scale, independent of the projected hit-shape dimensions. */
  referenceWidth?: number;
  mouthX?: number;
  mouthY?: number;
  mouthRadius?: number;
  cheeks?: CheekRegion[];
}
export interface PetInteractionState { phase: PetInteractionPhase; sessionId: string | null }
export interface PetInteractionFeedback {
  contact: boolean;
  /** Local contact attention only; it never supplies measured movement or a reward. */
  hover?: number;
  feeding: boolean;
  prepared: boolean;
  /** Feeding only, display-only: snack proximity to the mouth (0..1); acceptance still uses the mouth radius. */
  near?: number;
  /** Feeding only: the snack was accepted at the mouth (the bite), until the accepted phase ends. */
  accepted?: boolean;
  /** Feeding only: this snack's interaction session (the host's #32 pick for it carries the same id; its sounds use only that pick). */
  sessionId?: string;
  /** Position and velocity are normalized to the frozen reference head width. */
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  speed: number;
  pinch?: CheekPinchFeedback;
}
export type PetInteractionEvent =
  | { type: "rua"; id: string; sessionId: string; activeMs: number }
  | { type: "cheek"; id: string; sessionId: string; activeMs: number }
  | { type: "food"; id: string; sessionId: string };
export interface PetInteractionConfig {
  qualityWindowMs: number;
  minSpeed: number;
  maxSpeed: number;
  minSweep: number;
  prepareMs: number;
  acceptedMs: number;
}
export const DEFAULT_PET_INTERACTION_CONFIG: PetInteractionConfig = {
  qualityWindowMs: 500, minSpeed: 0.1, maxSpeed: 3, minSweep: 0.05, prepareMs: 650, acceptedMs: 900,
};
export function validatePetInteractionConfig(value: unknown): PetInteractionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("互动手感参数应为 JSON 对象");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_PET_INTERACTION_CONFIG);
  if (Object.keys(record).length !== keys.length || keys.some(key => typeof record[key] !== "number" || !Number.isFinite(record[key]))) throw new Error("请提供完整的六项互动手感数值");
  const next = record as unknown as PetInteractionConfig;
  if (next.qualityWindowMs < 100 || next.qualityWindowMs > 1000 || next.minSpeed < 0 || next.maxSpeed < next.minSpeed || next.maxSpeed > 10 || next.minSweep < 0.01 || next.minSweep > 1 || next.prepareMs < 500 || next.prepareMs > 3000 || next.acceptedMs < 100 || next.acceptedMs > 5000)
    throw new Error("互动参数超出试验范围；嘴边准备需为 500～3000 ms");
  return { ...next };
}
interface InteractionCallbacks {
  onState(state: PetInteractionState): void;
  onFeedback(feedback: PetInteractionFeedback): void;
  onEvent(event: PetInteractionEvent): void;
}
interface Point { x: number; y: number; at: number }
interface Segment { a: Point; b: Point; eligibleMs: number; counted: boolean }
interface PendingDose { sessionId: string; activeMs: number }
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const emptyFeedback = (): PetInteractionFeedback => ({ contact: false, hover: 0, feeding: false, prepared: false, x: 0, y: 0, velocityX: 0, velocityY: 0, speed: 0 });
function validRegion(region: PetHeadRegion | null): region is PetHeadRegion {
  if (!region || !Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.radius) || region.radius < 4) return false;
  if (region.referenceWidth !== undefined && (!Number.isFinite(region.referenceWidth) || region.referenceWidth < 8)) return false;
  if (region.mouthRadius !== undefined && (!Number.isFinite(region.mouthRadius) || region.mouthRadius <= 0)) return false;
  if ([region.mouthX, region.mouthY].some(value => value !== undefined && !Number.isFinite(value))) return false;
  const axes = [region.axisXX, region.axisXY, region.axisYX, region.axisYY];
  if (axes.every(value => value === undefined)) return true;
  if (!axes.every(value => typeof value === 'number' && Number.isFinite(value))) return false;
  const horizontal = Math.hypot(region.axisXX!, region.axisXY!), vertical = Math.hypot(region.axisYX!, region.axisYY!);
  return horizontal >= 4 && vertical >= 4 && Math.abs(region.axisXX! * region.axisYY! - region.axisYX! * region.axisXY!) > horizontal * vertical * 1e-6;
}
const referenceWidth = (region: PetHeadRegion) => Math.max(8, region.referenceWidth ?? region.radius * 2);
function headHit(x: number, y: number, region: PetHeadRegion, continuing: boolean): boolean {
  const dx = x - region.x, dy = y - region.y;
  let u: number, v: number;
  if (region.axisXX !== undefined) {
    const determinant = region.axisXX * region.axisYY! - region.axisYX! * region.axisXY!;
    u = (dx * region.axisYY! - dy * region.axisYX!) / determinant;
    v = (region.axisXX * dy - region.axisXY! * dx) / determinant;
  } else { u = dx / region.radius; v = dy / region.radius; }
  const margin = continuing ? 1.12 : 1;
  // Lateral/top grace must never extend below the calibrated hair/scalp boundary.
  return u * u + v * v <= margin * margin && v <= 1;
}

/** Deterministic input accounting. Model animation never supplies points to this tracker. */
export class PetInteractionTracker {
  private current: PetInteractionState = { phase: "idle", sessionId: null };
  private region: PetHeadRegion | null = null;
  private frozenWidth = 0;
  private lastPoint: Point | null = null;
  private segments: Segment[] = [];
  private pending: PendingDose[] = [];
  private sequence = 0;
  private lastEmissionAt = -Infinity;
  private mouthSince: number | null = null;
  private lastDragAt = 0;
  private acceptedUntil = 0;
  private feedback = emptyFeedback();
  private config: PetInteractionConfig;
  constructor(private readonly callbacks: InteractionCallbacks, config: Partial<PetInteractionConfig> = {}, private readonly identity = "interaction") {
    this.config = { ...DEFAULT_PET_INTERACTION_CONFIG, ...config };
    this.configure(config);
  }
  get state(): PetInteractionState { return { ...this.current }; }
  configure(config: Partial<PetInteractionConfig>): void {
    this.config = validatePetInteractionConfig({ ...this.config, ...config });
  }
  pointer(x: number, y: number, now: number, head: PetHeadRegion | null, eligible = true): void {
    if (this.current.phase.startsWith("feeding")) return;
    if (!eligible || !validRegion(head) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now)) { this.leave(now); return; }
    // Hit testing follows the current head, while dose/speed units remain frozen.
    if (!headHit(x, y, head, this.current.phase === 'rua')) { this.leave(now); return; }
    if (this.current.phase === "idle") {
      // Entry establishes a fresh input origin, never elapsed activity.
      // A new session supersedes unsubmitted old tail time before its phase is
      // published; old activity must never arrive after the host switches IDs.
      this.pending = [];
      this.region = { ...head };
      this.lastPoint = { x, y, at: now };
      this.segments = [];
      this.frozenWidth = referenceWidth(head);
      this.setState("rua", this.newId());
      this.reportPointer(x, y, 0, 0, 0);
      return;
    }
    this.region = { ...head };
    const previous = this.lastPoint;
    this.lastPoint = { x, y, at: now };
    if (!previous || now <= previous.at) return;
    const elapsed = now - previous.at;
    const width = this.frozenWidth;
    const vx = (x - previous.x) / width / (elapsed / 1000);
    const vy = (y - previous.y) / width / (elapsed / 1000);
    const speed = Math.hypot(vx, vy);
    this.reportPointer(x, y, vx, vy, speed);
    // A new movement after a pause does not turn that pause into active contact.
    if (elapsed > 250) { this.segments = []; this.flush(now); return; }
    if (speed > this.config.maxSpeed) { this.segments = []; this.flush(now); return; }
    const segment: Segment = { a: previous, b: { x, y, at: now }, eligibleMs: speed > 0.000001 && speed >= this.config.minSpeed ? elapsed : 0, counted: false };
    this.segments.push(segment);
    const cutoff = now - this.config.qualityWindowMs;
    this.segments = this.segments.filter(value => value.b.at > cutoff).slice(-512);
    let minX = x, maxX = x, minY = y, maxY = y;
    for (const value of this.segments) {
      if (!value.eligibleMs) continue;
      // Only qualifying input establishes the sweep; an extreme swipe cannot validate jitter.
      minX = Math.min(minX, value.a.x, value.b.x); maxX = Math.max(maxX, value.a.x, value.b.x);
      minY = Math.min(minY, value.a.y, value.b.y); maxY = Math.max(maxY, value.a.y, value.b.y);
    }
    if (Math.hypot(maxX - minX, maxY - minY) / width >= this.config.minSweep) {
      let added = 0;
      for (const value of this.segments) {
        if (!value.counted) { added += value.eligibleMs * Math.min(1, Math.max(0, value.b.at - cutoff) / Math.max(1, value.b.at - value.a.at)); value.counted = true; }
      }
      if (added > 0) this.addDose(this.current.sessionId!, added);
    }
    this.flush(now);
  }
  /** Normal exit preserves measured tail for the bounded flush unless a new session supersedes it. */
  leave(now: number): void {
    if (this.current.phase !== "rua") return;
    this.flush(now);
    this.clearContact();
    this.setState("idle", null);
  }
  /** Timer rechecks the live hit region but never supplies measured mouse movement. */
  pollPointer(x: number, y: number, now: number, head: PetHeadRegion | null, eligible = true): void {
    if (this.current.phase === 'rua') {
      if (!eligible || !validRegion(head) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now) || !headHit(x, y, head, true)) this.leave(now);
      else this.region = { ...head };
    }
  }
  drag(x: number, y: number, now: number, head: PetHeadRegion | null): void {
    if (!validRegion(head) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(now)) { this.cancel(); return; }
    if (this.current.phase === "feeding-accepted") return;
    if (!this.current.phase.startsWith("feeding")) {
      this.leave(now);
      this.pending = [];
      this.region = { ...head };
      this.frozenWidth = referenceWidth(head);
      this.setState("feeding-wait", this.newId());
    }
    this.region = { ...head };
    this.lastDragAt = now;
    const atMouth = this.nearMouth(x, y);
    if (!atMouth) this.mouthSince = null;
    else if (this.mouthSince === null) this.mouthSince = now;
    const ready = this.mouthSince !== null && now - this.mouthSince >= this.config.prepareMs;
    this.setState(ready ? "feeding-ready" : "feeding-wait", this.current.sessionId);
    this.feedback = { ...emptyFeedback(), feeding: true, prepared: ready, near: this.mouthProximity(x, y), x: clamp((x - this.region!.x) / this.frozenWidth, -1, 1), y: clamp((y - this.region!.y) / this.frozenWidth, -1, 1),
      sessionId: this.current.sessionId! };
    this.callbacks.onFeedback({ ...this.feedback });
  }
  drop(x: number, y: number, now: number, supportedImage: boolean, head?: PetHeadRegion | null): boolean {
    if (head !== undefined) { if (!validRegion(head)) { this.cancel(); return false; } this.region = { ...head }; }
    if (this.current.phase !== "feeding-ready" || !supportedImage || !Number.isFinite(now) || now - this.lastDragAt > 1500 || !this.nearMouth(x, y)) { this.cancel(); return false; }
    const sessionId = this.current.sessionId!;
    // Change phase before emitting: duplicate drop and callbacks cannot re-enter acceptance.
    this.acceptedUntil = now + this.config.acceptedMs;
    this.setState("feeding-accepted", sessionId);
    this.feedback = { ...emptyFeedback(), feeding: true, prepared: true, accepted: true, sessionId };
    this.callbacks.onFeedback({ ...this.feedback });
    this.callbacks.onEvent({ type: "food", id: `${sessionId}-food`, sessionId });
    return true;
  }
  flush(now: number): void {
    if (!Number.isFinite(now)) return;
    if (now - this.lastEmissionAt >= 200 && this.pending.length) {
      const dose = this.pending[0];
      const activeMs = Math.min(500, dose.activeMs);
      dose.activeMs -= activeMs;
      if (dose.activeMs < 0.001) this.pending.shift();
      this.lastEmissionAt = now;
      this.callbacks.onEvent({ type: "rua", id: `${dose.sessionId}-dose-${++this.sequence}`, sessionId: dose.sessionId, activeMs });
    }
    if (this.current.phase === "rua" && this.lastPoint && now - this.lastPoint.at > 100 && this.feedback.speed > 0) {
      this.feedback = { ...this.feedback, velocityX: 0, velocityY: 0, speed: 0 };
      this.callbacks.onFeedback({ ...this.feedback });
    }
    if (this.current.phase === "feeding-accepted" && now >= this.acceptedUntil) this.cancel();
    else if (this.current.phase === "feeding-wait" || this.current.phase === "feeding-ready") {
      if (now - this.lastDragAt > 1500) this.cancel();
      else if (this.mouthSince !== null && now - this.mouthSince >= this.config.prepareMs && this.current.phase !== "feeding-ready") {
        this.setState("feeding-ready", this.current.sessionId);
        this.feedback = { ...this.feedback, prepared: true };
        this.callbacks.onFeedback({ ...this.feedback });
      }
    }
  }
  /** Context invalidation discards pending input; it cannot arrive in a new model or role. */
  cancel(): void {
    if (this.current.phase === "idle" && !this.region && !this.pending.length) return;
    this.pending = [];
    this.clearContact();
    this.setState("idle", null);
  }
  private addDose(sessionId: string, activeMs: number): void {
    const last = this.pending.at(-1);
    if (last?.sessionId === sessionId) last.activeMs += activeMs;
    else this.pending.push({ sessionId, activeMs });
    // Bound transient input bookkeeping even if a consumer stalls.
    if (this.pending.length > 16) this.pending.shift();
  }
  private nearMouth(x: number, y: number): boolean {
    if (!this.region) return false;
    const mouthX = this.region.mouthX ?? this.region.x;
    const mouthY = this.region.mouthY ?? this.region.y + this.region.radius * 0.38;
    return Math.hypot(x - mouthX, y - mouthY) <= (this.region.mouthRadius ?? this.region.radius * 0.7);
  }
  /** Display-only (B06): 1 inside the mouth radius, fading to 0 at four radii. Never used for acceptance. */
  private mouthProximity(x: number, y: number): number {
    if (!this.region) return 0;
    const radius = this.region.mouthRadius ?? this.region.radius * 0.7;
    const distance = Math.hypot(x - (this.region.mouthX ?? this.region.x), y - (this.region.mouthY ?? this.region.y + this.region.radius * 0.38));
    const value = 1 - (distance - radius) / (radius * 3);
    return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
  }
  private reportPointer(x: number, y: number, vx: number, vy: number, speed: number): void {
    const width = this.frozenWidth;
    this.feedback = { contact: true, hover: 1, feeding: false, prepared: false, x: clamp((x - this.region!.x) / width, -0.65, 0.65), y: clamp((y - this.region!.y) / width, -0.65, 0.65), velocityX: clamp(vx, -3, 3), velocityY: clamp(vy, -3, 3), speed: Math.min(3, speed) };
    this.callbacks.onFeedback({ ...this.feedback });
  }
  private clearContact(): void {
    this.region = null; this.frozenWidth = 0; this.lastPoint = null; this.segments = []; this.mouthSince = null; this.acceptedUntil = 0;
    this.feedback = emptyFeedback(); this.callbacks.onFeedback({ ...this.feedback });
  }
  private setState(phase: PetInteractionPhase, sessionId: string | null): void {
    if (this.current.phase === phase && this.current.sessionId === sessionId) return;
    this.current = { phase, sessionId };
    this.callbacks.onState({ ...this.current });
  }
  private newId(): string { return `${this.identity}-${++this.sequence}`; }
}

export function isSnackImage(file: Pick<File, "type" | "name" | "size">): boolean {
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > FEED_SOURCE_MAX_BYTES) return false;
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const mime: Record<string, string[]> = { png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"], webp: ["image/webp"], gif: ["image/gif"], bmp: ["image/bmp", "image/x-ms-bmp"] };
  return Boolean(extension && mime[extension] && (!file.type || mime[extension].includes(file.type.toLowerCase())));
}

export interface PetInteractionOptions {
  getHeadRegion(): PetHeadRegion | null;
  canInteract?(): boolean;
  /** Client coordinates occupied by UI, including temporarily visibility-hidden controls. */
  blocksPoint?(clientX: number, clientY: number): boolean;
  onState(state: PetInteractionState): void;
  onFeedback(feedback: PetInteractionFeedback): void;
  onEvent(event: PetInteractionEvent): void | Promise<void>;
  /**
   * I-019: the one dropped file, only once the bite was accepted at her mouth (after its "food" event), with the bite's
   * interaction session. The owner decides whether the picture goes anywhere (src/ui/feed-snack.ts); a refused drop never calls it.
   */
  onSnack?(file: File, sessionId: string): void;
  onError?(message: string): void;
  onCancel?(reason: string): void;
  config?: Partial<PetInteractionConfig>;
}

/** DOM adapter reads only pointer samples and file metadata; it never reads or uploads a file (an accepted snack goes to `onSnack`). */
export class PetInteraction {
  private readonly tracker: PetInteractionTracker;
  private readonly cheek: CheekPinchTracker;
  private pinchPointer: number | null = null;
  private readonly owner: Document;
  private readonly view: Window;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly cursor: PetInteractionCursor;
  private pointerPosition: { x: number; y: number } | null = null;
  private visible = true;
  private disposed = false;
  constructor(private readonly surface: HTMLElement, private readonly options: PetInteractionOptions) {
    this.owner = surface.ownerDocument;
    this.view = this.owner.defaultView!;
    this.cursor = new PetInteractionCursor(surface);
    const identity = `pet-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    this.tracker = new PetInteractionTracker({
      onState: state => { if (state.phase !== 'rua' && state.phase !== 'rua-hover') this.cursor.hide(); options.onState(state); },
      onFeedback: feedback => {
        // The hand signals a valid hit immediately. Measured activity remains
        // independent and is never inferred from cursor paint or contact entry.
        if ((feedback.contact || this.tracker.state.phase === 'rua-hover') && !feedback.feeding && this.pointerPosition && this.allowed()) this.cursor.show(this.pointerPosition.x, this.pointerPosition.y);
        else this.cursor.hide();
        options.onFeedback(feedback);
      },
      onEvent: event => { try { void Promise.resolve(options.onEvent(event)).catch(error => options.onError?.(String(error))); } catch (error) { options.onError?.(String(error)); } },
    }, options.config, identity);
    this.cheek = new CheekPinchTracker({
      onState: state => options.onState(state),
      onFeedback: pinch => {
        if ((pinch.hover || pinch.pinching) && this.pointerPosition && this.allowed()) this.cursor.show(this.pointerPosition.x, this.pointerPosition.y, pinch.pinching ? '🤏' : '👉');
        else this.cursor.hide();
        options.onFeedback({ ...emptyFeedback(), contact: pinch.pinching, hover: pinch.hover ? 1 : 0, x: pinch.x, y: pinch.y, pinch });
      },
      onEvent: event => { try { void Promise.resolve(options.onEvent(event)).catch(error => options.onError?.(String(error))); } catch (error) { options.onError?.(String(error)); } },
    }, `${identity}-cheek`);
    surface.addEventListener("pointermove", this.pointer);
    surface.addEventListener("pointerdown", this.press);
    surface.addEventListener("pointerup", this.release);
    surface.addEventListener("lostpointercapture", this.lostCapture);
    surface.addEventListener("pointerleave", this.leave);
    surface.addEventListener("pointercancel", this.cancel);
    surface.addEventListener("dragenter", this.drag);
    surface.addEventListener("dragover", this.drag);
    surface.addEventListener("dragleave", this.dragLeave);
    surface.addEventListener("drop", this.drop);
    this.owner.addEventListener("keydown", this.key);
    this.owner.addEventListener("focusin", this.focus);
    this.owner.addEventListener("visibilitychange", this.visibility);
    this.view.addEventListener("blur", this.cancel);
    this.view.addEventListener("resize", this.cancel);
    this.timer = setInterval(() => {
      if (!this.allowed()) { this.cursor.hide(); if (this.state.phase !== "idle") this.cancelContext("disabled"); return; }
      if (this.cheek.state.phase !== 'idle') {
        const position = this.pointerPosition;
        if (!position || this.options.blocksPoint?.(position.x, position.y) || !this.options.getHeadRegion()) this.cancelContext('geometry');
        else if (this.pinchPointer === null) { const point = this.point({ clientX: position.x, clientY: position.y } as MouseEvent); this.cheek.hover(point.x, point.y, this.options.getHeadRegion()?.cheeks ?? []); }
        return;
      }
      if (this.pointerPosition && this.tracker.state.phase === 'rua') {
        const position = this.pointerPosition;
        if (!this.blocked({ clientX: position.x, clientY: position.y } as MouseEvent)) {
          const rect = this.surface.getBoundingClientRect();
          this.tracker.pollPointer(position.x - rect.left, position.y - rect.top, this.now(), this.options.getHeadRegion());
        }
      }
      this.tracker.flush(this.now());
    }, 100);
  }
  get state(): PetInteractionState { return this.cheek.state.phase !== 'idle' ? this.cheek.state : this.tracker.state; }
  setHostVisible(visible: boolean): void { this.visible = visible; if (!visible) this.reset(); }
  configure(config: Partial<PetInteractionConfig>): void { this.tracker.configure(config); this.reset(); }
  reset(_reason?: string): void { this.pointerPosition = null; this.releaseCapture(); this.cheek.cancel(); this.cursor.hide(); this.tracker.cancel(); }
  private now(): number { return this.view.performance.now(); }
  private allowed(): boolean {
    return !this.disposed && this.visible && !this.owner.hidden && this.options.canInteract?.() !== false;
  }
  private point(event: MouseEvent): { x: number; y: number } {
    const rect = this.surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private blocked(event: MouseEvent): boolean {
    if (!this.options.blocksPoint?.(event.clientX, event.clientY)) return false;
    if (this.cheek.state.phase !== 'idle') { this.cancelContext('ui'); return true; }
    this.pointerPosition = null; this.cursor.hide();
    // A UI exit preserves measured rua tail, but an unaccepted food drag is canceled.
    if (this.tracker.state.phase === "rua") this.tracker.leave(this.now());
    else this.tracker.cancel();
    return true;
  }
  private readonly pointer = (event: PointerEvent) => {
    if (this.pinchPointer !== null && event.pointerId !== this.pinchPointer) return;
    this.pointerPosition = { x: event.clientX, y: event.clientY };
    if (this.blocked(event)) return;
    const point = this.point(event);
    if (this.pinchPointer !== null) {
      if (!this.allowed()) { this.cancelContext('disabled'); return; }
      this.cheek.move(point.x, point.y, this.now(), event.buttons);
      if (this.cheek.state.phase !== 'cheek') this.cancelContext('lost-button');
      return;
    }
    const eligible = this.allowed() && event.buttons === 0 && (!event.pointerType || event.pointerType === "mouse") && event.isPrimary !== false;
    const region = this.options.getHeadRegion();
    if (eligible && !this.tracker.state.phase.startsWith('feeding') && hitCheek(point.x, point.y, region?.cheeks ?? [])) {
      this.tracker.cancel(); this.cheek.hover(point.x, point.y, region?.cheeks ?? []); return;
    }
    this.cheek.cancel();
    this.tracker.pointer(point.x, point.y, this.now(), region, eligible);
  };
  private readonly press = (event: PointerEvent) => {
    if (this.pinchPointer !== null) return;
    if (!this.allowed() || this.blocked(event) || event.button !== 0 || !(event.buttons & 1) || (event.pointerType && event.pointerType !== 'mouse') || event.isPrimary === false || this.tracker.state.phase.startsWith('feeding')) { this.cancelContext('press'); return; }
    const point = this.point(event), regions = this.options.getHeadRegion()?.cheeks ?? [];
    if (!hitCheek(point.x, point.y, regions)) { this.cancelContext('press'); return; }
    this.pointerPosition = { x: event.clientX, y: event.clientY };
    // A failed native capture cannot create a held interaction or a host session.
    try { this.surface.setPointerCapture(event.pointerId); if (!this.surface.hasPointerCapture(event.pointerId)) throw new Error('Pointer capture unavailable'); } catch { this.cancelContext('capture'); return; }
    this.tracker.cancel(); this.pinchPointer = event.pointerId;
    if (!this.cheek.press(point.x, point.y, this.now(), regions)) { this.cancelContext('geometry'); return; }
    event.preventDefault();
  };
  private releaseCapture(): void {
    const pointer = this.pinchPointer; this.pinchPointer = null;
    if (pointer === null) return;
    try { if (this.surface.hasPointerCapture(pointer)) this.surface.releasePointerCapture(pointer); } catch { /* owner already released */ }
  }
  private readonly release = (event: PointerEvent) => {
    if (this.pinchPointer === null || event.pointerId !== this.pinchPointer) return;
    if (event.button !== 0 || (event.buttons & 1) || event.isPrimary === false || (event.pointerType && event.pointerType !== 'mouse') || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || !this.allowed() || this.options.blocksPoint?.(event.clientX, event.clientY)) { this.cancelContext('release'); return; }
    this.cheek.release(this.now()); this.releaseCapture(); this.cursor.hide();
  };
  private readonly lostCapture = (event: PointerEvent) => { if (event.pointerId === this.pinchPointer) this.cancelContext('capture-lost'); };
  private readonly leave = () => { if (this.pinchPointer !== null) return; this.pointerPosition = null; this.cheek.cancel(); this.cursor.hide(); this.tracker.leave(this.now()); };
  private cancelContext(reason: string): void { this.reset(); this.options.onCancel?.(reason); }
  private readonly cancel = () => this.cancelContext("cancelled");
  private isFocusedControl(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    if (typeof target?.getBoundingClientRect !== 'function' || !this.options.blocksPoint) return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && this.options.blocksPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  private readonly focus = (event: FocusEvent) => { if (this.isFocusedControl(event)) this.cancelContext('ui-focus'); };
  private readonly key = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.cancelContext("escape");
    else if (this.isFocusedControl(event)) this.cancelContext('ui-keyboard');
  };
  private readonly visibility = () => { if (this.owner.hidden) this.cancelContext("hidden"); };
  private readonly drag = (event: DragEvent) => {
    if (this.cheek.state.phase !== 'idle') { this.cancelContext('food-drag'); }
    this.pointerPosition = null; this.cursor.hide();
    if (this.blocked(event)) {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) {
        event.preventDefault(); event.dataTransfer.dropEffect = "none";
      }
      return;
    }
    if (!this.allowed() || !event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) { this.tracker.leave(this.now()); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const point = this.point(event);
    this.tracker.drag(point.x, point.y, this.now(), this.options.getHeadRegion());
  };
  private readonly dragLeave = (event: DragEvent) => {
    const related = event.relatedTarget;
    if (related && this.surface.contains(related as Node)) return;
    const point = this.point(event);
    const rect = this.surface.getBoundingClientRect();
    if (!related && point.x >= 0 && point.y >= 0 && point.x < rect.width && point.y < rect.height) return;
    this.reset();
  };
  private readonly drop = (event: DragEvent) => {
    if (this.cheek.state.phase !== 'idle') this.cancelContext('food-drop');
    this.pointerPosition = null; this.cursor.hide();
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.blocked(event)) return;
    if (!this.allowed()) { this.reset(); return; }
    const files = Array.from(event.dataTransfer.files);
    const supported = files.length === 1 && isSnackImage(files[0]);
    const point = this.point(event);
    const accepted = this.tracker.drop(point.x, point.y, this.now(), supported, this.options.getHeadRegion());
    if (!supported) this.options.onError?.("请拖入一张不超过 50 MB 的 PNG、JPEG、WebP、GIF 或 BMP 图片。");
    else if (!accepted) this.options.onError?.("请在嘴边稍停，张嘴准备后再松开鼠标。");
    else {
      const sessionId = this.tracker.state.sessionId;
      if (sessionId) { try { this.options.onSnack?.(files[0], sessionId); } catch { /* She has eaten either way. */ } }
    }
  };
  dispose(): void {
    if (this.disposed) return;
    this.reset(); this.disposed = true; clearInterval(this.timer);
    this.surface.removeEventListener("pointermove", this.pointer); this.surface.removeEventListener("pointerdown", this.press); this.surface.removeEventListener("pointerleave", this.leave);
    this.surface.removeEventListener('pointerup', this.release); this.surface.removeEventListener('lostpointercapture', this.lostCapture);
    this.surface.removeEventListener("pointercancel", this.cancel); this.surface.removeEventListener("dragenter", this.drag);
    this.surface.removeEventListener("dragover", this.drag); this.surface.removeEventListener("dragleave", this.dragLeave); this.surface.removeEventListener("drop", this.drop);
    this.owner.removeEventListener("keydown", this.key); this.owner.removeEventListener("focusin", this.focus); this.owner.removeEventListener("visibilitychange", this.visibility);
    this.view.removeEventListener("blur", this.cancel); this.view.removeEventListener("resize", this.cancel);
    this.cursor.dispose();
  }
}
import { PetInteractionCursor } from './PetInteractionCursor';

