import type { CameraConfig } from "../../shared/contracts";
import { clamp } from "./procedural";

export interface MovementAxes { forward: number; right: number; up: number; }
const radians = (degrees: number) => degrees * Math.PI / 180;
const normalizeYaw = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;
const movementKeys = new Set(["KeyW", "KeyS", "KeyA", "KeyD", "Space", "KeyZ"]);

export function normalizeCamera(camera: CameraConfig): CameraConfig {
  return {
    ...camera,
    yaw: normalizeYaw(camera.yaw),
    pitch: clamp(camera.pitch, -80, 80),
    distance: clamp(camera.distance, 1, 500),
    targetX: clamp(camera.targetX, -1000, 1000),
    targetY: clamp(camera.targetY, -1000, 1000),
    targetZ: clamp(camera.targetZ ?? 0, -1000, 1000),
    fov: clamp(camera.fov, 12, 80),
  };
}

export function cameraBasis(camera: CameraConfig) {
  const yaw = radians(camera.yaw), pitch = radians(camera.pitch);
  return {
    forward: { x: -Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) },
    right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
    up: { x: -Math.sin(yaw) * Math.sin(pitch), y: Math.cos(pitch), z: -Math.cos(yaw) * Math.sin(pitch) },
  };
}

export function moveCamera(camera: CameraConfig, axes: MovementAxes, seconds: number): CameraConfig {
  const { forward, right } = cameraBasis(camera);
  const x = forward.x * axes.forward + right.x * axes.right;
  const y = forward.y * axes.forward + axes.up;
  const z = forward.z * axes.forward + right.z * axes.right;
  const length = Math.hypot(x, y, z);
  if (!length) return camera;
  const step = Math.max(1, camera.distance * 0.7) * clamp(seconds, 0, 0.1) / length;
  return normalizeCamera({ ...camera, targetX: camera.targetX + x * step, targetY: camera.targetY + y * step, targetZ: (camera.targetZ ?? 0) + z * step });
}

export function rotateCamera(camera: CameraConfig, dx: number, dy: number): CameraConfig {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return camera;
  const before = cameraBasis(camera).forward;
  const next = { ...camera, yaw: normalizeYaw(camera.yaw - dx * 0.25), pitch: clamp(camera.pitch + dy * 0.25, -80, 80) };
  const after = cameraBasis(next).forward;
  // Turn around the eye point C = T - forward * distance, not around T.
  const target = {
    targetX: camera.targetX + (after.x - before.x) * camera.distance,
    targetY: camera.targetY + (after.y - before.y) * camera.distance,
    targetZ: (camera.targetZ ?? 0) + (after.z - before.z) * camera.distance,
  };
  // Clamping one target axis would translate C. Reject the whole step instead.
  if (Object.values(target).some(value => !Number.isFinite(value) || Math.abs(value) > 1000)) return camera;
  return { ...next, ...target };
}

export function panCamera(camera: CameraConfig, dx: number, dy: number, height: number): CameraConfig {
  const { right, up } = cameraBasis(camera);
  const scale = 2 * camera.distance * Math.tan(radians(camera.fov / 2)) / Math.max(1, height);
  return normalizeCamera({
    ...camera,
    targetX: camera.targetX + (-dx * right.x + dy * up.x) * scale,
    targetY: camera.targetY + dy * up.y * scale,
    targetZ: (camera.targetZ ?? 0) + (-dx * right.z + dy * up.z) * scale,
  });
}

/** Focus-scoped camera input; Shift refines each continuous control by one quarter. */
export class CameraController {
  private camera: CameraConfig;
  private enabled = false;
  private disposed = false;
  private readonly keys = new Set<string>();
  private fine = false;
  private drag: { id: number; button: number; x: number; y: number } | null = null;

  constructor(
    private readonly element: HTMLCanvasElement,
    initial: CameraConfig,
    private readonly onChange: (camera: CameraConfig) => void,
    private readonly onModeChange?: (enabled: boolean) => void,
    private readonly onReset?: () => void,
  ) {
    this.camera = normalizeCamera(initial);
    element.tabIndex = 0;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerEnd);
    element.addEventListener("pointercancel", this.onPointerEnd);
    element.addEventListener("lostpointercapture", this.onPointerEnd);
    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("contextmenu", this.onContextMenu);
    element.addEventListener("keydown", this.onKeyDown);
    element.addEventListener("keyup", this.onKeyUp);
    element.addEventListener("blur", this.onCanvasBlur);
    window.addEventListener("blur", this.onWindowBlur);
  }

  get interacting(): boolean { return this.drag !== null || this.keys.size > 0; }
  setCamera(camera: CameraConfig): void { this.camera = normalizeCamera(camera); }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    const changed = this.enabled !== enabled;
    this.enabled = enabled;
    if (enabled) this.element.focus({ preventScroll: true });
    else this.clearInput();
    if (changed) this.onModeChange?.(enabled);
  }

  update(delta: number): void {
    if (!this.enabled || document.activeElement !== this.element || !this.keys.size) return;
    const next = moveCamera(this.camera, {
      forward: Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS")),
      right: Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")),
      up: Number(this.keys.has("Space")) - Number(this.keys.has("KeyZ")),
    }, clamp(delta, 0, 0.1) * (this.fine ? 0.25 : 1));
    if (next !== this.camera) this.commit(next);
  }

  dispose(): void {
    this.setEnabled(false);
    this.disposed = true;
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerEnd);
    this.element.removeEventListener("pointercancel", this.onPointerEnd);
    this.element.removeEventListener("lostpointercapture", this.onPointerEnd);
    this.element.removeEventListener("wheel", this.onWheel);
    this.element.removeEventListener("contextmenu", this.onContextMenu);
    this.element.removeEventListener("keydown", this.onKeyDown);
    this.element.removeEventListener("keyup", this.onKeyUp);
    this.element.removeEventListener("blur", this.onCanvasBlur);
    window.removeEventListener("blur", this.onWindowBlur);
  }

  private commit(camera: CameraConfig): void { this.camera = camera; this.onChange(camera); }
  private clearInput(): void {
    this.keys.clear();
    this.fine = false;
    this.endDrag();
  }
  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.element.hasPointerCapture(drag.id)) this.element.releasePointerCapture(drag.id);
  }
  private readonly onCanvasBlur = () => this.clearInput();
  private readonly onWindowBlur = () => this.setEnabled(false);
  private readonly onContextMenu = (event: MouseEvent) => { if (this.enabled) event.preventDefault(); };
  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.enabled || (event.button !== 0 && event.button !== 2) || this.drag || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
    this.element.focus({ preventScroll: true });
    this.fine = event.shiftKey;
    this.drag = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY };
    this.element.setPointerCapture(event.pointerId);
  };
  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!this.enabled || !drag || drag.id !== event.pointerId) return;
    this.fine = event.shiftKey;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!(event.buttons & (drag.button === 0 ? 1 : 2)) || !Number.isFinite(dx) || !Number.isFinite(dy)) { this.endDrag(); return; }
    event.preventDefault();
    drag.x = event.clientX; drag.y = event.clientY;
    if (!dx && !dy) return;
    const scale = this.fine ? 0.25 : 1;
    const next = drag.button === 0 ? rotateCamera(this.camera, dx * scale, dy * scale) : panCamera(this.camera, dx * scale, dy * scale, this.element.clientHeight);
    if (next !== this.camera) this.commit(next);
  };
  private readonly onPointerEnd = (event: PointerEvent) => {
    if (this.drag?.id !== event.pointerId) return;
    if (event.type === "pointerup") { this.fine = event.shiftKey; this.endDrag(); }
    else this.clearInput();
  };
  private readonly onWheel = (event: WheelEvent) => {
    if (!this.enabled || !Number.isFinite(event.deltaY)) return;
    event.preventDefault();
    this.fine = event.shiftKey;
    const next = normalizeCamera({ ...this.camera, distance: this.camera.distance * Math.exp(clamp(event.deltaY, -500, 500) * 0.0015) });
    next.distance = this.camera.distance + (next.distance - this.camera.distance) * (this.fine ? 0.25 : 1);
    if (next.distance !== this.camera.distance) this.commit(next);
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.enabled || document.activeElement !== this.element || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    this.fine = event.shiftKey;
    if (event.code === "Escape") { event.preventDefault(); this.setEnabled(false); }
    else if (event.code === "Tab") { event.preventDefault(); if (!event.repeat) { this.clearInput(); this.onReset?.(); } }
    else if (movementKeys.has(event.code)) { event.preventDefault(); this.keys.add(event.code); }
  };
  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (!this.enabled || document.activeElement !== this.element) return;
    this.fine = event.shiftKey;
    if (this.keys.delete(event.code)) event.preventDefault();
  };
}
