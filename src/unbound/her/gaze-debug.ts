/**
 * I-169 (docs/claude/2026-11-21-i169-gaze-debug.md): full-screen Unbound's version of developer mode's "where she looks" label and dot
 * (the label, the dot and their easing are src/senses/gaze-debug-view.ts). Here the world is real: her head is a point in metres, her
 * look (what the figure shows now: head, upper body and eyes) is a direction from it, and the screen is the plane z = 0, so the dot sits
 * where that line of sight meets the screen (not drawn when she looks away from it). Your head is where pose sensing says (the reading's
 * point, in this page's units, which are the screen's); the cursor is the page's pointer. Read only: called by the page's developer
 * overlay only while it shows (main.ts), and the view's nodes go when the overlay is hidden (overlay.ts).
 */
import { Vector3, type Camera } from 'three';
import { gazeDebug, unitsToPx, type GazeDebugFrame } from '../../senses';
import { UNITS_PER_M } from '../figure';
import type { UnboundFigure } from '../figure';
import type { HerOutGaze } from './out-gaze';
import type { V3 } from '../motion/lens-align';

const scratch = new Vector3();
const px = (point: V3, camera: Camera, width: number, height: number) => {
  scratch.set(point.x * UNITS_PER_M, point.y * UNITS_PER_M, point.z * UNITS_PER_M).project(camera);
  return Number.isFinite(scratch.x) && Number.isFinite(scratch.y) ? unitsToPx(scratch.x, scratch.y, width, height) : null;
};

/**
 * Where a look from her head (m, world; heading in rad) with these angles (rad; yaw + = her left = the screen's right, pitch + = up)
 * meets the screen plane (z = 0), in metres; null when it points away from the screen (or is level with it).
 */
export function sightOnScreenM(head: V3, heading: number, yaw: number, pitch: number): V3 | null {
  if (![head.x, head.y, head.z, heading, yaw, pitch].every(Number.isFinite)) return null;
  const down = -pitch, hx = Math.sin(yaw) * Math.cos(down), hy = -Math.sin(down), hz = Math.cos(yaw) * Math.cos(down);
  // Her frame to the world: the inverse of lens-align's toHerFrame.
  const c = Math.cos(heading), s = Math.sin(heading), dx = hx * c + hz * s, dz = -hx * s + hz * c;
  if (!(Math.abs(dz) > 1e-6)) return null;
  const t = -head.z / dz;
  return t > 0 && Number.isFinite(t) ? { x: head.x + dx * t, y: head.y + hy * t, z: 0 } : null;
}

/** One frame of the page's readout: `owner` keys the view (the page's developer overlay). */
export function herGazeDebug(owner: object, dt: number, figure: UnboundFigure, gaze: HerOutGaze, camera: Camera, pointer: { x: number; y: number; inside: boolean }, width: number, height: number): void {
  const view = gazeDebug(owner, true);
  if (!view) return;
  try {
    const shown = figure.gazeShown, sense = figure.sense, head = sense?.head ?? null, read = gaze.readout();
    camera.updateMatrixWorld();
    const sight = head && sense ? sightOnScreenM(head, sense.root.heading, shown.head.yaw + shown.eyes.yaw, shown.head.pitch + shown.eyes.pitch) : null;
    const frame: GazeDebugFrame = { dt, width, height, chosen: read.chosen, followMouse: true, head: shown.head, eyes: shown.eyes,
      anchor: head ? px(head, camera, width, height) : null, mouse: pointer.inside ? { x: pointer.x, y: pointer.y } : null,
      user: read.user ? unitsToPx(read.user.x, read.user.y, width, height) : null, sight: sight ? px(sight, camera, width, height) : null };
    view.frame(frame);
  } catch { /* a readout never breaks her */ }
}
