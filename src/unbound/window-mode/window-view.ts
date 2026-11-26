/**
 * I-154: what the companion window sees of her on Unbound's engine (split out of window-stage.ts on 2026-11-20, batch 3, behaviour unchanged).
 *
 * The companion's own camera (settings.camera) and framing (stage-framing.ts), lifted by Unbound's floor so the picture does not move;
 * and the screen projections the companion window reads: where her eyes are (the gaze origin), her face anchor (the reply bubble, the
 * game buttons) and the head region (pats; since batch 3 also the cheeks for the pinch). Three.js only, no WebGL: the stage owns the
 * renderer and asks this for the camera.
 */
import { MathUtils, PerspectiveCamera, Vector3, type Bone } from 'three';
import { cameraBasis, clamp, framingCamera, framingTopBand, isUnframedCamera, normalizeCamera, type StageOptions, type StageSurface } from '../../stage';
import { headRegion, type HeadAt, type HeadContact } from '../her/head-region';
import type { CameraConfig } from '../../../shared/foundation/settings';

type S = StageSurface;
export type { HeadContact };
export const DEFAULT_CAMERA: CameraConfig = { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 };
export const FACE_ANCHOR_MS = 100;
const signature = (camera: CameraConfig) => JSON.stringify(normalizeCamera(camera));

/** Her head as the projections need it (../her/head-region.ts HeadAt). */
export type WindowHead = HeadAt;

export class WindowView {
  readonly camera = new PerspectiveCamera(32, 1, 0.1, 3000);
  /** The model's bind-pose bounds as the companion measures them (mesh at the origin), model units. */
  bounds = { height: 20, width: 12, baseY: 0, centerX: 0 };
  /** How far Unbound's body lifted her so her soles are on its floor; the camera is lifted the same. */
  lift = 0;
  private framingConfig: CameraConfig | null = null;
  private framingRevision = 0;
  private cameraKey = '';
  private lastAnchor = -Infinity;

  constructor(private readonly container: HTMLElement, private readonly options: StageOptions,
    private readonly ports: { cameraSet(camera: CameraConfig): void }) {}

  /** Whether this camera differs from the one in use (applySettings re-applies only a changed one). */
  differs(camera: CameraConfig): boolean { return signature(camera) !== this.cameraKey; }
  get config(): CameraConfig { return this.framingConfig ?? DEFAULT_CAMERA; }

  setCamera(config: CameraConfig): void {
    const next = normalizeCamera(config), key = signature(next);
    const changed = key !== this.cameraKey;
    this.framingConfig = structuredClone(next); this.cameraKey = key;
    this.ports.cameraSet(next);
    if (changed) this.framingRevision++;
    this.applyCamera();
    if (changed) this.options.onFramingStateChange?.();
  }
  /** The companion's camera, lifted with her (Unbound's floor). */
  applyCamera(): void {
    const next = this.framingConfig ?? DEFAULT_CAMERA, { forward } = cameraBasis(next), lift = this.lift;
    this.camera.position.set(next.targetX - forward.x * next.distance, next.targetY + lift - forward.y * next.distance, (next.targetZ ?? 0) - forward.z * next.distance);
    this.camera.lookAt(next.targetX, next.targetY + lift, next.targetZ ?? 0);
    this.camera.fov = next.fov;
    this.camera.updateProjectionMatrix();
  }
  /** The window's size changed: the aspect follows (the stage resizes the renderer). */
  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  /** The companion's framing (full body / portrait) for these bounds; the camera is set and saved. */
  frame(preset: 'full' | 'portrait', fov: number): CameraConfig {
    let reserved = 0;
    try { reserved = this.options.framingTop?.() ?? 0; } catch { reserved = 0; }
    const next = framingCamera(preset, this.bounds, { aspect: this.camera.aspect || 1, fov, topBand: framingTopBand(this.container.clientHeight, reserved) });
    this.setCamera(next);
    this.options.onCameraChange?.(structuredClone(this.framingConfig!));
    return structuredClone(this.framingConfig!);
  }
  unframed(): boolean { return !!this.options.frameUnframed && !!this.framingConfig && isUnframedCamera(this.framingConfig); }
  framingView(state: { modelGeneration: number; modelUrl: string; ready: boolean }): ReturnType<S['getFramingView']> {
    return { modelGeneration: state.modelGeneration, cameraRevision: this.framingRevision, modelUrl: state.modelUrl, ready: state.ready,
      camera: structuredClone(this.framingConfig ?? DEFAULT_CAMERA) };
  }

  /** Her eyes on the window (-1..1, y up), the companion's gaze origin. */
  eyesOnWindow(eyes: readonly Bone[], head: Bone | null): { x: number; y: number } | null {
    const bones = eyes.length ? eyes : head ? [head] : [];
    if (!bones.length) return null;
    const sum = new Vector3(), point = new Vector3();
    for (const bone of bones) sum.add(bone.getWorldPosition(point));
    sum.divideScalar(bones.length).project(this.camera);
    return Number.isFinite(sum.x) && Number.isFinite(sum.y) ? { x: sum.x, y: sum.y } : null;
  }

  /** The companion's face anchor (bubble, game buttons): a point near her lips, at most every 100 ms. */
  reportFaceAnchor(now: number, head: Bone | null): void {
    if (!this.options.onFaceAnchor || now - this.lastAnchor < FACE_ANCHOR_MS || !head) return;
    this.lastAnchor = now;
    const h = this.bounds.height, width = this.container.clientWidth, height = this.container.clientHeight;
    const point = head.localToWorld(new Vector3(0, -h * 0.01, h * 0.05));
    const distance = Math.max(0.1, this.camera.position.distanceTo(point));
    const radius = clamp(h * 0.09 * height / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2) * distance), 20, width * 0.48);
    point.project(this.camera);
    const visible = Number.isFinite(point.x) && Number.isFinite(point.y) && point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
    this.options.onFaceAnchor({ x: visible ? (point.x + 1) * width / 2 : 0, y: visible ? (1 - point.y) * height / 2 : 0, visible, radius });
  }

  /** The head region the companion's touch input reads (the scalp for pats, the mouth for feeding, the cheeks for the pinch): the shared projection (../her/head-region.ts). */
  interactionRegion(at: WindowHead): ReturnType<S['getInteractionRegion']> {
    const width = this.container.clientWidth, height = this.container.clientHeight, camera = this.camera;
    return headRegion(at, { camera, width, height, boundsHeight: this.bounds.height,
      radiusPx: (units, point) => units * height / (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2) * Math.max(0.1, camera.position.distanceTo(point))) });
  }
}
