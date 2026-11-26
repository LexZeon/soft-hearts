/**
 * I-073 part 2 (docs/claude/how-to-tune-mood-face.md): what the face reads of the mood. The mood model (shared/foundation/mood.ts)
 * is not touched; this is a face-level copy of its numbers that
 *  - follows them critically damped (MOOD_FACE_KNOBS.follow): a mood event changes the numbers on one frame, the face
 *    starts moving at zero speed and arrives without overshoot;
 *  - keeps an afterglow: after an event moved her, every axis the event moved holds its furthest value (in the event's
 *    direction) for hold.base + hold.perPoint × the size of the change (at most hold.max) seconds, then lets go along a
 *    smootherstep over hold.release seconds, so the face follows the decay only after a while;
 *  - axes: D, O, E, N, C as (value − 50) / 50 (the idle motions' fixed centre, see docs/mood/README.md "基线也影响气质"),
 *    and M = longing / 100.
 * The slow drift that keeps the face from sitting frozen is not here: it rides on the same slow noise as the existing
 * wobble (procedural-life.ts) and is added per slider (continuous-expression.ts).
 */
import { MOOD_FACE_KNOBS } from './knobs';

export const FACE_AXES = ['D', 'O', 'E', 'N', 'C', 'M'] as const;
export type FaceAxis = typeof FACE_AXES[number];
export type FacePoint = Record<FaceAxis, number>;
export const emptyPoint = (): FacePoint => ({ D: 0, O: 0, E: 0, N: 0, C: 0, M: 0 });

export interface ReadingMood {
  values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>;
  longing?: number;
  event?: { id: string; delta: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> } | null;
}

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : 0;
const smootherstep = (value: number) => { const t = clamp(value, 0, 1); return t * t * t * (t * (6 * t - 15) + 10); };

/** The mood's numbers as the face axes (no smoothing). */
export function rawPoint(mood: ReadingMood | null | undefined, out: FacePoint = emptyPoint()): FacePoint {
  for (const axis of ['D', 'O', 'E', 'N', 'C'] as const) {
    const value = mood?.values?.[axis];
    out[axis] = typeof value === 'number' && Number.isFinite(value) ? clamp((value - 50) / 50, -1, 1) : 0;
  }
  out.M = typeof mood?.longing === 'number' && Number.isFinite(mood.longing) ? clamp(mood.longing / 100, 0, 1) : 0;
  return out;
}

export class FaceMoodReading {
  /** This frame's reading (read only). */
  readonly point = emptyPoint();
  private readonly velocity = emptyPoint();
  private readonly raw = emptyPoint();
  private readonly held = emptyPoint();
  /** Per axis: +1 / -1 the direction the current event moved it, 0 not held. */
  private readonly direction = emptyPoint();
  private ready = false;
  private eventId = '';
  private holdLeft = 0;
  private release = 0;

  reset(): void {
    for (const axis of FACE_AXES) this.point[axis] = this.velocity[axis] = this.held[axis] = this.direction[axis] = 0;
    this.ready = false; this.eventId = ''; this.holdLeft = 0; this.release = 0;
  }

  /** Seconds of afterglow left (hold, then release); for tests and diagnostics. */
  get glow(): number { return this.holdLeft + this.release * MOOD_FACE_KNOBS.hold.release; }

  frame(delta: number, mood: ReadingMood | null | undefined): FacePoint {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0, knobs = MOOD_FACE_KNOBS, raw = rawPoint(mood, this.raw);
    if (!this.ready) { for (const axis of FACE_AXES) { this.point[axis] = raw[axis]; this.velocity[axis] = 0; } this.ready = true; this.eventId = mood?.event?.id ?? ''; }
    const event = mood?.event;
    if (event && event.id !== this.eventId) {
      this.eventId = event.id;
      let size = 0;
      for (const axis of ['D', 'O', 'E', 'N', 'C'] as const) {
        const change = Number(event.delta?.[axis]) || 0;
        size = Math.max(size, Math.abs(change));
        // A new event starts from what the face holds now (its target), so nothing jumps.
        const start = this.target(axis);
        this.direction[axis] = Math.abs(change) >= 0.5 ? Math.sign(change) : 0;
        this.held[axis] = start;
      }
      this.holdLeft = size >= 0.5 ? Math.min(knobs.hold.max, knobs.hold.base + knobs.hold.perPoint * size) : 0;
      this.release = this.holdLeft > 0 ? 1 : 0;
    }
    // Held axes keep their furthest value in the event's direction while the hold lasts.
    for (const axis of ['D', 'O', 'E', 'N', 'C'] as const) {
      const sign = this.direction[axis];
      if (sign !== 0 && this.holdLeft > 0 && (raw[axis] - this.held[axis]) * sign > 0) this.held[axis] = raw[axis];
    }
    if (this.holdLeft > 0) this.holdLeft = Math.max(0, this.holdLeft - dt);
    else if (this.release > 0) this.release = Math.max(0, this.release - (knobs.hold.release > 0 ? dt / knobs.hold.release : 1));
    for (const axis of FACE_AXES) this.point[axis] = dampCritical(this.point[axis], this.target(axis), knobs.follow, dt, this.velocity, axis);
    return this.point;
  }

  /** Where the face is heading on this axis: the mood's number, or the held value fading into it after the hold. */
  private target(axis: FaceAxis): number {
    const raw = this.raw[axis];
    if (axis === 'M' || this.direction[axis] === 0 || this.release <= 0) return raw;
    const keep = this.holdLeft > 0 ? 1 : smootherstep(this.release);
    const held = (this.held[axis] - raw) * this.direction[axis] > 0 ? this.held[axis] : raw;
    return raw + (held - raw) * keep;
  }
}

/** Critically damped step (as procedural.ts dampCritical; local so this module stays free of the stage's imports). */
function dampCritical(current: number, target: number, omega: number, dt: number, velocity: FacePoint, axis: FaceAxis): number {
  if (!(omega > 0) || !Number.isFinite(omega)) { velocity[axis] = 0; return target; }
  const error = current - target, decay = Math.exp(-omega * dt), carry = velocity[axis] + omega * error;
  velocity[axis] = (velocity[axis] - omega * carry * dt) * decay;
  return target + (error + carry * dt) * decay;
}
