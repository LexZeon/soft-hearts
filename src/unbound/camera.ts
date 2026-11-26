/**
 * Unbound U1: the screen as a camera (shared/unbound/world.ts) applied to a Three.js camera in scene units.
 * The camera sits at the viewer's eye looking straight at the screen (down -z, no rotation) with an off-axis frustum through the
 * window's rectangle of the screen ('physical'), or through the whole screen scaled into the window ('fit', the preview).
 *
 * U2 (docs/claude/2026-11-12-unbound-peek.md): the near plane follows the nearest part of her. She may bring an eye a few cm from
 * the lens, so a fixed 5 cm near plane would cut her face off; a near plane always at 2 mm would waste depth precision when she is
 * far. `nearPlaneFor` puts it at a fraction of the distance to the nearest point of her (bone capsules, conservatively padded),
 * between NEAR_MIN_M and the U1 default, and pulls the far plane in while she is that close.
 */
import { PerspectiveCamera } from 'three';
import { eyePosition, pixelsPerMeter, windowFrustum, type Frustum, type WorldView } from '../../shared/unbound/world';
import type { UnboundWorld } from '../../shared/unbound/scene';
import { UNITS_PER_M } from './figure';

/** The U1 near and far planes (m), and the closest the near plane comes. */
export const NEAR_DEFAULT_M = 0.05, FAR_DEFAULT_M = 400, NEAR_MIN_M = 0.003, FAR_CLOSE_M = 80;
/** The near plane sits at this fraction of the distance to her nearest padded point (the rest is margin for what the capsules miss). */
export const NEAR_SHARE = 0.4;
/** Capsule radii are padded by this factor (a capsule covers 90% of its bone's vertices; lashes, bangs and the nose stick out). */
export const NEAR_PAD = 1.5;

/**
 * The screen as a camera (docs/claude/2026-11-21-unbound-wide.md): a PerspectiveCamera whose projection is the off-axis frustum
 * applyWorldCamera() gave it. Its fov and aspect are unused, so code written for an ordinary camera that calls
 * updateProjectionMatrix() (the cheek projection did, 2026-11-21: she turned about 1.7 times too wide and short until the next scene)
 * rebuilds the same frustum instead of a fov 50 / aspect 1 picture. Before any frustum it is an ordinary perspective camera.
 */
export class WorldCamera extends PerspectiveCamera {
  private frustum: Frustum | null = null;
  /** Sets the off-axis frustum (scene units) and applies it. */
  setFrustum(frustum: Frustum): void { this.frustum = { ...frustum }; this.updateProjectionMatrix(); }
  override updateProjectionMatrix(): void {
    const f = this.frustum;
    if (!f) { super.updateProjectionMatrix(); return; }
    this.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, f.near, f.far);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

/** The world before the first scene: the whole page, a nominal laptop screen (moved from main.ts with the floor framing, 2026-11-21). */
export function placeholderWorld(width: number, height: number): UnboundWorld {
  const rect = { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
  return { screen: { widthM: 0.34, heightM: 0.2125, source: 'dpi', detail: 'placeholder' }, display: rect, workArea: rect, window: rect, mapping: 'fit',
    viewerDistanceM: 0.55, eyeHeightM: 1.4, placement: { xM: 0, depthM: 8 } };
}

export function worldView(world: UnboundWorld): WorldView {
  return { screen: world.screen, display: world.display, viewerDistanceM: world.viewerDistanceM, eyeHeightM: world.eyeHeightM };
}

/** Places the camera and sets its projection. Returns the frustum in scene units (for pixel sizes). `nearM`: the near plane (m). */
export function applyWorldCamera(camera: PerspectiveCamera, world: UnboundWorld, nearM = NEAR_DEFAULT_M): Frustum {
  const view = worldView(world);
  const near = Number.isFinite(nearM) ? Math.min(NEAR_DEFAULT_M, Math.max(NEAR_MIN_M, nearM)) : NEAR_DEFAULT_M;
  const metres = windowFrustum(view, world.mapping === 'fit' ? world.display : world.window, near, near < NEAR_DEFAULT_M ? FAR_CLOSE_M : FAR_DEFAULT_M);
  const k = UNITS_PER_M;
  const frustum: Frustum = { left: metres.left * k, right: metres.right * k, top: metres.top * k, bottom: metres.bottom * k, near: metres.near * k, far: metres.far * k };
  const eye = eyePosition(view);
  camera.position.set(eye.x * k, eye.y * k, eye.z * k);
  camera.quaternion.identity();
  camera.updateMatrixWorld(true);
  if (camera instanceof WorldCamera) camera.setFrustum(frustum);
  else {
    camera.projectionMatrix.makePerspective(frustum.left, frustum.right, frustum.top, frustum.bottom, frustum.near, frustum.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  return frustum;
}

/**
 * The near plane (m) for her nearest point: each capsule's two ends (scene units, world) and radius (model units = scene units),
 * the camera position (scene units). Distance ahead is along −z (the camera looks straight down −z).
 */
export function nearPlaneFor(ends: readonly { z: number }[], radii: readonly number[], cameraZ: number): number {
  let nearest = Infinity;
  for (let i = 0; i < radii.length; i++) {
    const a = ends[2 * i], b = ends[2 * i + 1];
    if (!a || !b) continue;
    const ahead = Math.min(cameraZ - a.z, cameraZ - b.z) - radii[i] * NEAR_PAD;
    if (ahead < nearest) nearest = ahead;
  }
  if (!Number.isFinite(nearest)) return NEAR_DEFAULT_M;
  return Math.min(NEAR_DEFAULT_M, Math.max(NEAR_MIN_M, nearest / UNITS_PER_M * NEAR_SHARE));
}

/**
 * The lens softness (CSS blur, px) for an eye `distanceM` from the lens: none from 25 cm out, rising to `softness` × 1.6 px at 8 cm
 * and closer (a real lens that close is soft, and the face's textures are magnified many times). 0 when the knob is 0.
 */
export function lensSoftnessPx(distanceM: number | null, softness: number): number {
  if (distanceM === null || !Number.isFinite(distanceM) || !(softness > 0)) return 0;
  const u = Math.min(1, Math.max(0, (0.25 - distanceM) / (0.25 - 0.08)));
  return Math.min(1, softness) * 1.6 * u * u * (3 - 2 * u);
}

/** Pixels per scene unit at `aheadUnits` in front of the eye, on a viewport `heightPx` tall. */
export function pixelsPerUnit(frustum: Frustum, heightPx: number, aheadUnits: number): number {
  return pixelsPerMeter(frustum, heightPx, aheadUnits);
}
