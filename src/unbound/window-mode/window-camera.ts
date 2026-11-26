/**
 * I-154: dragging her camera (「调整镜头」) in the Unbound window stage. The companion's own CameraController on the engine's canvas:
 * left drag turns, right drag pans, wheel zooms, WASD / Space / Z move, Tab frames, Esc finishes. Every change goes back through the
 * stage's own setCamera, then onCameraChange (saved the usual way); entering and leaving is reported through onCameraEditChange, so the
 * toolbar button, the behaviour gate and click-through (cameraEditing) follow exactly as with the companion's own stage.
 * Pure of WebGL: the stage passes its canvas and four callbacks, the test passes a fake canvas.
 */
import { CameraController } from '../../stage';
import type { CameraConfig } from '../../../shared/foundation/settings';

export interface WindowCameraPorts {
  /** Put the camera on screen (the stage lifts it with her floor). */
  apply(camera: CameraConfig): void;
  /** The camera the user dragged to: saved by the wiring. */
  changed(camera: CameraConfig): void;
  /** Editing started or ended (the toolbar, the gates). */
  mode(enabled: boolean): void;
  /** Tab: back to full-body framing. */
  reset(): void;
  /** Whether editing can run now (shown, page visible). */
  canEdit(): boolean;
}

export class WindowCameraEdit {
  private readonly controls: CameraController;
  constructor(canvas: HTMLCanvasElement, initial: CameraConfig, private readonly ports: WindowCameraPorts) {
    this.controls = new CameraController(canvas, initial, camera => { ports.apply(camera); ports.changed(camera); }, enabled => ports.mode(enabled), () => ports.reset());
  }
  get interacting(): boolean { return this.controls.interacting; }
  /** The camera set from outside (settings, framing): the next drag starts from it. */
  setCamera(camera: CameraConfig): void { this.controls.setCamera(camera); }
  set(enabled: boolean): void { this.controls.setEnabled(enabled && this.ports.canEdit()); }
  update(delta: number): void { this.controls.update(delta); }
  dispose(): void { this.controls.dispose(); }
}
