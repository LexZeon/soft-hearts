// I-154: her body in the companion window on Unbound's engine, without a canvas: the real Gene frame loop (figure, idle layer, mouth:
// src/unbound/window-mode/window-body.ts) seen through the camera the window stage would use (the companion's own framing, lifted with
// her floor: window-stage.ts applyCamera), on a 420×640 window. Shared by the batch-1 tests (pull, physics, pace).
import { PerspectiveCamera, Quaternion, Vector3, Box3 } from 'three';
import { WindowBody } from '../../src/unbound/window-mode/window-body';
import { createBundledIdle } from '../../src/unbound/motion/bundled-idle';
import { cameraBasis, framingCamera, framingTopBand } from '../../src/stage';
import { geneFigure, TRACKED } from './unbound-gene';
import { shippedIdle } from './unbound-idle-stream';

export const WINDOW = { width: 420, height: 640 } as const;
export const DEG = 180 / Math.PI;

export async function windowGene(seed = 7) {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 0 });
  const idle = await shippedIdle();
  let s = seed; const random = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random);
  await new Promise(resolve => setImmediate(resolve)); // the idle is made
  // The window stage's bounds (bind pose at the origin) and its full-body framing, lifted by her floor (window-stage.ts).
  const width = (() => { const mesh = fixture.mesh, y = mesh.position.y; mesh.position.y = 0; mesh.updateMatrixWorld(true); const box = new Box3().setFromObject(mesh); mesh.position.y = y; mesh.updateMatrixWorld(true); return box.max.x - box.min.x; })();
  const bounds = { height: figure.heightUnits, width, baseY: -figure.floorUnits, centerX: 0 };
  const config = framingCamera('full', bounds, { aspect: WINDOW.width / WINDOW.height, fov: 32, topBand: framingTopBand(WINDOW.height, 0) });
  const camera = new PerspectiveCamera(config.fov, WINDOW.width / WINDOW.height, 0.1, 3000);
  const { forward } = cameraBasis(config), lift = figure.floorUnits;
  camera.position.set(config.targetX - forward.x * config.distance, config.targetY + lift - forward.y * config.distance, (config.targetZ ?? 0) - forward.z * config.distance);
  camera.lookAt(config.targetX, config.targetY + lift, config.targetZ ?? 0);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const view = () => ({ camera, width: WINDOW.width, height: WINDOW.height });
  /** A bone's place on the window (CSS px). */
  const screenOf = (name: string) => {
    fixture.mesh.updateMatrixWorld(true);
    const p = fixture.mesh.skeleton.bones.find(b => b.name === name)!.getWorldPosition(new Vector3()).project(camera);
    return { x: (p.x + 1) / 2 * WINDOW.width, y: (1 - p.y) / 2 * WINDOW.height };
  };
  const between = (a: string, b: string, at = 0.5) => { const p = screenOf(a), q = screenOf(b); return { x: p.x + (q.x - p.x) * at, y: p.y + (q.y - p.y) * at }; };
  const frame = (dt: number, physicsDt = dt) => body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false }, physicsDt);
  const rotations = () => bones.map(b => b.getWorldQuaternion(new Quaternion()));
  const close = () => { body.dispose(); fixture.close(); };
  return { fixture, figure, body, camera, view, screenOf, between, frame, rotations, close };
}
export type WindowGene = Awaited<ReturnType<typeof windowGene>>;

/** Per frame, the largest turn of any of `rotations` from the frame before (°). */
export const frameSteps = (frames: readonly Quaternion[][]) => frames.slice(1).map((f, i) => Math.max(...f.map((q, b) => q.angleTo(frames[i][b]) * DEG)));

/** R29c "unexpected step": how far each bone's step departs from its step on the frame before (°), per frame (the largest bone), and per bone. */
export function surprises(frames: readonly Quaternion[][]): { perFrame: number[]; perBone: number[] } {
  const perFrame: number[] = [], perBone = frames[0]?.map(() => 0) ?? [];
  const s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
  for (let i = 2; i < frames.length; i++) {
    let worst = 0;
    for (let b = 0; b < frames[i].length; b++) {
      s.copy(frames[i][b]).multiply(inv.copy(frames[i - 1][b]).invert());
      l.copy(frames[i - 1][b]).multiply(inv.copy(frames[i - 2][b]).invert());
      const v = s.angleTo(l) * DEG;
      worst = Math.max(worst, v); perBone[b] = Math.max(perBone[b], v);
    }
    perFrame.push(worst);
  }
  return { perFrame, perBone };
}
