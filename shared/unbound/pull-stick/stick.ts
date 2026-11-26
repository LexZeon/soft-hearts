/**
 * I-196: the joystick pull. The press point is the stick's centre; where the pointer is against it says where she goes: down = toward you,
 * up = away, left and right = she walks across. Everything is in screen pixels, never in her scaled body, so it feels the same when she
 * fills half the screen. Speed grows smoothly with the offset and is capped; a small round dead zone around the centre does nothing.
 *
 * Pure: no clock, no DOM, no Three.js. The page (src/unbound/pull-input.ts) asks for the goal each frame and hands it to her gait.
 */
import { STICK_KNOBS, type StickKnobs } from './knobs';

export interface StickReading {
  /** −1..1: right is +. */
  side: number;
  /** −1..1: down is + (toward you). */
  depth: number;
}
const ZERO: StickReading = Object.freeze({ side: 0, depth: 0 });

const finite = (...values: number[]) => values.every(Number.isFinite);
const sign = (value: number) => (value < 0 ? -1 : 1);

/** The offset (px, from the press point) as two readings. Inside the dead zone: nothing; at its edge: still 0 (no jump); capped at the full offset. */
export function stickReading(dxPx: number, dyPx: number, knobs: StickKnobs = STICK_KNOBS): StickReading {
  if (!finite(dxPx, dyPx)) return ZERO;
  const length = Math.hypot(dxPx, dyPx);
  if (length <= knobs.deadZonePx) return ZERO;
  const outside = (length - knobs.deadZonePx) / length, span = Math.max(1e-6, knobs.fullOffsetPx - knobs.deadZonePx);
  const axis = (value: number) => { const t = Math.min(1, Math.abs(value * outside) / span); return t === 0 ? 0 : sign(value) * Math.pow(t, knobs.curve); };
  return { side: axis(dxPx), depth: axis(dyPx) };
}

/** How big she shows: the viewer's distance plus her depth (m). Moves are made in the log of this, so a step feels the same near and far. */
const apparent = (viewerM: number, depthM: number) => Math.max(1e-3, viewerM + depthM);

export interface StickGoal { xM: number; depthM: number }

/**
 * Where the stick points her, `lookAheadS` ahead of where she stands. Depth: her apparent size changes by `depthRatePerS` at full offset;
 * across: `sideRatePerS` of her apparent distance per second (so it looks equally fast near and far), at most `sideMaxMps`.
 * The caller keeps the goal inside her ranges (the near end is the eyes' station and its no-clipping guard, the far end is today's).
 */
export function stickGoal(from: StickGoal, reading: StickReading, viewerM: number, knobs: StickKnobs = STICK_KNOBS): StickGoal {
  if (!finite(from.xM, from.depthM, viewerM)) return { ...from };
  const d = apparent(viewerM, from.depthM);
  const closer = Math.exp(-knobs.depthRatePerS * reading.depth * knobs.lookAheadS);
  const acrossMps = Math.min(knobs.sideMaxMps, knobs.sideRatePerS * d * Math.abs(reading.side)) * sign(reading.side);
  return { xM: from.xM + (reading.side === 0 ? 0 : acrossMps * knobs.lookAheadS), depthM: d * closer - viewerM };
}

/** `notches` of the wheel (positive: closer, as scrolling forward zooms in) from where she is or was last asked to go. */
export function wheelDepth(depthM: number, notches: number, viewerM: number, knobs: StickKnobs = STICK_KNOBS): number {
  if (!finite(depthM, notches, viewerM)) return depthM;
  return apparent(viewerM, depthM) * Math.exp(-Math.max(-6, Math.min(6, notches)) * knobs.wheelStep) - viewerM;
}

/** The wheel event's delta as notches (one notch = 100 px of delta in pixel mode; line mode counts 3 lines to a notch; page mode is a few). */
export function wheelNotches(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY)) return 0;
  const notch = deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 100;
  return -deltaY / notch;
}
