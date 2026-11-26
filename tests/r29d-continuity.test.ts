/**
 * R29d (docs/claude/2026-11-02-R29b-continuity.md, "R29d"): the one-frame
 * changes R29c left, the X-089 review items and selected motions that do not
 * suit the current model, measured on the real Stage frame loop with the
 * bundled Gene (gene-stage-harness), at 60 and 30 fps.
 *
 * - Bones: the R29b surprise measure (a frame's step vs repeating the previous
 *   one) may not exceed 1.25x the reference's own largest, floor 0.15 deg at
 *   60 fps. The floor is an angular acceleration (0.15 deg per frame^2 at 60 fps
 *   = 540 deg/s^2), so at 30 fps it is 0.6 deg: the same smooth hand-off shows
 *   4x the per-frame change at half the frame rate. For a switch to another
 *   motion the reference is the larger of the motion before and the motion
 *   after (each has its own rhythm).
 * - "Caught": hand-offs the display guard had to absorb (a one-frame cut in the
 *   composed target). A bridge that covers a hand-off leaves nothing to catch.
 * R29_REPORT=1 prints the numbers recorded in the R29d section.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dampCritical, damp } from '../src/stage/procedural';
import { catalogAsset, surprises, type ShownFrame } from './helpers/frame-stats';

const FLOOR = 0.15;
const floorAt = (fps: number) => FLOOR * (60 / fps) ** 2;
const REPORT = !!process.env.R29_REPORT;
const f3 = (value: number) => value.toFixed(3);
/** Largest surprise per tracked bone in a window of one run (the "own rhythm" of whatever plays there). */
function ownSurprise(frames: readonly ShownFrame[], set: 'world' | 'derived' = 'world'): number[] {
  return surprises(frames, set).map(values => Math.max(0, ...values));
}

// ------------------------------------------------------------------ 5. manual switch / clear: grant and IK bones

const ARMS_FOLDED = catalogAsset('100style-idles', 'arms-folded-idle');

test('R29d gaze: the critically damped follow keeps the old reach and timing, starts from rest and never overshoots', () => {
  const omega = 10, dt = 1 / 60, velocity = { x: 0, y: 0 };
  let critical = 0, first = 0, reachCritical = 0, reachFirst = 0, peak = 0, firstStep = -1;
  for (let i = 1; i <= 120; i++) {
    const before = critical;
    critical = dampCritical(critical, 1, omega, dt, velocity, 'x');
    first = damp(first, 1, omega / 2, dt);
    if (firstStep < 0) firstStep = critical - before;
    peak = Math.max(peak, critical);
    if (!reachCritical && critical >= 0.9) reachCritical = i * dt;
    if (!reachFirst && first >= 0.9) reachFirst = i * dt;
  }
  assert.ok(firstStep < (1 - Math.exp(-5 * dt)) * 0.25, 'the first frame is a gentle start, not the full-speed step of first-order damping');
  assert.ok(peak <= 1 + 1e-9, 'no overshoot');
  assert.ok(Math.abs(critical - 1) < 1e-4, 'it reaches the target');
  assert.ok(Math.abs(reachCritical - reachFirst) <= 0.1, `90% at ${reachCritical.toFixed(2)} s vs ${reachFirst.toFixed(2)} s`);
  // Following a steadily moving pointer keeps the same lag as before (2 / omega = 1 / speed).
  let a = 0, b = 0; const v2 = { x: 0, y: 0 };
  for (let i = 1; i <= 300; i++) { const target = i * dt * 0.5; a = dampCritical(a, target, omega, dt, v2, 'y'); b = damp(b, target, omega / 2, dt); }
  assert.ok(Math.abs(a - b) < 0.01, `ramp lag ${(300 * dt * 0.5 - a).toFixed(3)} vs ${(300 * dt * 0.5 - b).toFixed(3)}`);
});
