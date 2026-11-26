export type CheekSide = 'left' | 'right';

export interface CheekExclusion {
  /** Convex projected feature boundary, in the same CSS pixels as the ellipse. */
  points: readonly { x: number; y: number }[];
  padding: number;
}

/** CSS-pixel ellipse projected from this model's local face calibration. */
export interface CheekRegion {
  side: CheekSide;
  x: number;
  y: number;
  axisXX: number;
  axisXY: number;
  axisYX: number;
  axisYY: number;
  /** Input unit only; independent of the ellipse's hit area. */
  referenceWidth: number;
  /** Initial hover/press admission only; held drag keeps its original contract. */
  exclusions?: readonly CheekExclusion[];
}

export interface CheekPinchFeedback {
  hover: boolean;
  pinching: boolean;
  side: CheekSide | null;
  /** Displacement from the press point, in the frozen reference head width. */
  x: number;
  y: number;
}

export interface CheekPinchState {
  phase: 'idle' | 'cheek-hover' | 'cheek';
  sessionId: string | null;
}

export interface CheekPinchEvent {
  type: 'cheek';
  id: string;
  sessionId: string;
  activeMs: number;
}

interface Callbacks {
  onState(state: CheekPinchState): void;
  onFeedback(feedback: CheekPinchFeedback): void;
  onEvent(event: CheekPinchEvent): void;
}
interface Point { x: number; y: number; at: number }
interface Sweep {
  x: number;
  y: number;
  dx: number;
  dy: number;
  pendingMs: number;
  qualified: boolean;
}
interface Hold {
  id: string;
  side: CheekSide;
  origin: Point;
  width: number;
  last: Point;
  activeMs: number;
  sweep: Sweep | null;
}

/** Trial defaults, not portable character parameters or current mood state. */
export const CHEEK_PINCH_INPUT = Object.freeze({
  minSpeed: 0.1, maxSpeed: 3, minSweep: 0.05,
  minActiveMs: 180, maxActiveMs: 500, maxSampleGapMs: 250,
});
const empty = (): CheekPinchFeedback => ({ hover: false, pinching: false, side: null, x: 0, y: 0 });
const finitePoint = (x: number, y: number): boolean => Number.isFinite(x) && Number.isFinite(y);
const clampDisplacement = (value: number): number => Math.min(2, Math.max(-2, value));

function ellipseDistance(x: number, y: number, region: CheekRegion): number | null {
  if (!region || (region.side !== 'left' && region.side !== 'right')
    || ![region.x, region.y, region.axisXX, region.axisXY, region.axisYX, region.axisYY, region.referenceWidth].every(Number.isFinite)
    || region.referenceWidth < 8) return null;
  const horizontal = Math.hypot(region.axisXX, region.axisXY);
  const vertical = Math.hypot(region.axisYX, region.axisYY);
  const determinant = region.axisXX * region.axisYY - region.axisYX * region.axisXY;
  if (horizontal < 1 || vertical < 1 || !Number.isFinite(determinant)
    || Math.abs(determinant) <= horizontal * vertical * 1e-6) return null;
  const dx = x - region.x, dy = y - region.y;
  const u = (dx * region.axisYY - dy * region.axisYX) / determinant;
  const v = (region.axisXX * dy - region.axisXY * dx) / determinant;
  const distance = u * u + v * v;
  return Number.isFinite(distance) ? distance : null;
}

function excludedByFeatures(x: number, y: number, exclusions: readonly CheekExclusion[] | undefined): boolean {
  if (exclusions === undefined) return false;
  if (!Array.isArray(exclusions) || exclusions.length !== 4) return true;
  for (const exclusion of exclusions) {
    const points = exclusion?.points, padding = exclusion?.padding;
    if (!Array.isArray(points) || points.length < 3 || points.length > 8
      || !Number.isFinite(padding) || padding < 0 || padding > 2
      || points.some(point => !point || !finitePoint(point.x, point.y))) return true;
    let winding = 0, inside = true, area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
      if (!Number.isFinite(length) || length < 1e-12) return true;
      const turn = dx * (c.y - b.y) - dy * (c.x - b.x);
      if (!Number.isFinite(turn) || Math.abs(turn) < 1e-8) return true;
      const nextWinding = Math.sign(turn);
      if (winding && winding !== nextWinding) return true;
      winding = nextWinding;
      area += a.x * b.y - b.x * a.y;
      const side = dx * (y - a.y) - dy * (x - a.x);
      if (side * winding < 0) inside = false;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length));
      if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= padding) return true;
    }
    if (!Number.isFinite(area) || Math.abs(area) < 1e-4 || inside) return true;
  }
  return false;
}

/** Both rotated axes participate in the hit; missing/degenerate data never falls back to a broad circle. */
export function hitCheek(x: number, y: number, regions: readonly CheekRegion[] | null | undefined): CheekRegion | null {
  if (!finitePoint(x, y) || !Array.isArray(regions)) return null;
  let result: CheekRegion | null = null, closest = Infinity;
  // Only the nearest valid ellipse wins if a view makes their projections overlap.
  for (const region of regions) {
    const distance = ellipseDistance(x, y, region);
    if (distance !== null && distance <= 1 && distance < closest && !excludedByFeatures(x, y, region.exclusions)) {
      result = region; closest = distance;
    }
  }
  return result ? { ...result } : null;
}

/** Pure mouse-input accounting. Timers, pose updates and cursor paint cannot add movement. */
export class CheekPinchTracker {
  private current: CheekPinchState = { phase: 'idle', sessionId: null };
  private value = empty();
  private hold: Hold | null = null;
  private sequence = 0;
  private generation = 0;

  constructor(private readonly callbacks: Callbacks, private readonly identity = 'cheek') {}

  get state(): CheekPinchState { return { ...this.current }; }
  get feedback(): CheekPinchFeedback { return { ...this.value }; }

  hover(x: number, y: number, regions: readonly CheekRegion[] | null | undefined): void {
    if (this.hold) return;
    const region = hitCheek(x, y, regions);
    this.setState(region ? 'cheek-hover' : 'idle', null);
    this.report({ hover: !!region, pinching: false, side: region?.side ?? null, x: 0, y: 0 });
  }

  press(x: number, y: number, now: number, regions: readonly CheekRegion[] | null | undefined): boolean {
    // A second press cannot manufacture another identity or restart one hold's budget.
    if (this.hold) return false;
    const region = hitCheek(x, y, regions);
    if (!region || !Number.isFinite(now)) { this.cancel(); return false; }
    const point = { x, y, at: now };
    const id = `${this.identity}-${++this.sequence}`;
    this.generation++;
    this.hold = { id, side: region.side, origin: { ...point }, width: region.referenceWidth,
      last: point, activeMs: 0, sweep: null };
    this.setState('cheek', id);
    this.report({ hover: false, pinching: true, side: region.side, x: 0, y: 0 });
    return true;
  }

  move(x: number, y: number, now: number, buttons: number): void {
    const hold = this.hold;
    if (!hold) return;
    if (!finitePoint(x, y) || !Number.isFinite(now) || !Number.isInteger(buttons) || buttons < 0 || buttons > 31 || (buttons & 1) === 0) { this.cancel(); return; }
    // Do not move the measurement origin backwards when a delayed sample arrives.
    if (now <= hold.last.at) return;
    const previous = hold.last;
    hold.last = { x, y, at: now };
    this.report({ hover: false, pinching: true, side: hold.side,
      x: clampDisplacement((x - hold.origin.x) / hold.width),
      y: clampDisplacement((y - hold.origin.y) / hold.width) });
    const elapsed = now - previous.at;
    const dx = x - previous.x, dy = y - previous.y;
    const speed = Math.hypot(dx, dy) / hold.width / (elapsed / 1000);
    if (elapsed > CHEEK_PINCH_INPUT.maxSampleGapMs || !Number.isFinite(speed)
      || speed < CHEEK_PINCH_INPUT.minSpeed || speed > CHEEK_PINCH_INPUT.maxSpeed) {
      hold.sweep = null;
      return;
    }
    // A reversal starts a fresh sweep. Tiny oscillation cannot bank time and
    // become eligible later because of one large final displacement.
    let sweep = hold.sweep;
    if (!sweep || sweep.dx * dx + sweep.dy * dy <= 0) {
      sweep = { x: previous.x, y: previous.y, dx, dy, pendingMs: 0, qualified: false };
      hold.sweep = sweep;
    }
    sweep.dx = dx; sweep.dy = dy;
    sweep.pendingMs = Math.min(CHEEK_PINCH_INPUT.maxActiveMs, sweep.pendingMs + elapsed);
    if (!sweep.qualified && Math.hypot(x - sweep.x, y - sweep.y) / hold.width >= CHEEK_PINCH_INPUT.minSweep)
      sweep.qualified = true;
    if (sweep.qualified) {
      hold.activeMs = Math.min(CHEEK_PINCH_INPUT.maxActiveMs, hold.activeMs + sweep.pendingMs);
      sweep.pendingMs = 0;
    }
  }

  release(now: number): void {
    const hold = this.hold;
    if (!hold) return;
    if (!Number.isFinite(now)) { this.cancel(); return; }
    if (now < hold.last.at) return;
    const event: CheekPinchEvent | null = hold.activeMs >= CHEEK_PINCH_INPUT.minActiveMs
      ? { type: 'cheek', id: `${hold.id}-release`, sessionId: hold.id, activeMs: hold.activeMs } : null;
    // Consume before invoking a callback, including reentrant/throwing callbacks.
    this.hold = null; this.current = { phase: 'idle', sessionId: null }; this.value = empty();
    const generation = ++this.generation;
    try { if (event) this.callbacks.onEvent(event); }
    finally {
      // A synchronous consumer may already have begun a new interaction.
      if (this.generation === generation) {
        this.callbacks.onState(this.state);
        this.callbacks.onFeedback(this.feedback);
      }
    }
  }

  cancel(): void {
    const changed = this.hold !== null || this.current.phase !== 'idle' || this.value.side !== null;
    this.generation++; this.hold = null;
    this.current = { phase: 'idle', sessionId: null }; this.value = empty();
    if (changed) { this.callbacks.onState(this.state); this.callbacks.onFeedback(this.feedback); }
  }

  private setState(phase: CheekPinchState['phase'], sessionId: string | null): void {
    if (phase === this.current.phase && sessionId === this.current.sessionId) return;
    this.generation++;
    this.current = { phase, sessionId };
    this.callbacks.onState(this.state);
  }
  private report(value: CheekPinchFeedback): void { this.value = value; this.callbacks.onFeedback(this.feedback); }
}
