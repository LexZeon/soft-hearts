/**
 * I-154 batch 7: the stage's tools in one place, so window-stage.ts only wires them: 试一下 (window-capability.ts, both windows), the control
 * window's preview mode (window-preview-mode.ts: the grid and the authoring previews; only with the preview grants) and the developer's
 * diagnostics (window-diagnostics.ts). Each frame: before her body (their clocks and gates), the figure's overlay (a personal pose
 * preview), after the render (the previews' ready receipts, the diagnostics).
 */
import type { Bone, Camera, Scene, SkinnedMesh } from 'three';
import type { BodyStageGates, CapabilityPreviewFrame, MotionGlitchReport } from '../../stage';
import type { MotionActivity } from '../../../shared/stage';
import { WindowCapabilityPreviews, type WindowCapabilityContext } from './window-capability';
import { WindowDiagnostics, windowActivities } from './window-diagnostics';
import { WindowPreviewMode, bodyPreviewBlocked, visualPreviewBlocked } from './window-preview-mode';
import type { WindowPreviewStage } from './window-previews';
import type { WindowPreviewGrants } from './preview-port';
import type { WindowMotionEnv } from './window-motions';

/** What the tools read of the stage after a render. */
export interface WindowToolsFrame {
  mesh: SkinnedMesh | null; camera: Camera; height: number; gl: WebGL2RenderingContext; canvas: HTMLCanvasElement;
  physicsBones: readonly number[] | null; fps: number | null; frameMs: number; props: () => readonly { x: number; y: number; z: number }[];
  env: WindowMotionEnv;
  /** What plays now beyond the env (her motions' players, her own life, a transition). */
  playing: { chat: boolean; action: boolean; body: boolean; herLife: boolean; transition: boolean };
}

export class WindowStageTools {
  readonly capability = new WindowCapabilityPreviews();
  /** The control window's preview mode; null in the companion window. */
  readonly preview: WindowPreviewMode | null;
  private readonly diagnostics: WindowDiagnostics;

  constructor(scene: Scene, grants: WindowPreviewGrants | null, stage: WindowPreviewStage, report: ((glitch: MotionGlitchReport) => void) | undefined,
    developer: () => boolean) {
    this.preview = grants ? new WindowPreviewMode(scene, grants, stage) : null;
    this.diagnostics = new WindowDiagnostics(report, developer);
  }

  /** Before her body's frame: 试一下's amounts (on the stage's clock; a new model drops them), the previews' gates and weights. */
  beforeBody(dt: number, owner: object | null, env: WindowMotionEnv, gates: BodyStageGates): CapabilityPreviewFrame {
    this.preview?.frame(dt, bodyPreviewBlocked(gates), visualPreviewBlocked(env));
    return this.capability.frame(dt, owner);
  }

  /** The figure's overlay this frame (a personal pose preview, after the sleep body and a pose reaction); null when none. */
  overlay(): ((remember: (bone: Bone) => void) => void) | null { return this.preview?.body.overlay() ?? null; }

  /** After the render: the previews' "ready", the glitch watches and the stray watch (not while the grid shows). */
  afterRender(frame: WindowToolsFrame): void {
    this.preview?.afterRender();
    const previewing = this.preview?.busy === true;
    this.diagnostics.afterRender({ mesh: frame.mesh, camera: frame.camera, height: frame.height, gl: frame.gl, canvas: frame.canvas,
      physicsBones: frame.physicsBones, fps: frame.fps, frameMs: frame.frameMs, grid: this.preview?.grid.visible === true, props: frame.props,
      activities: () => windowActivities(frame.env, { ...frame.playing, preview: previewing }) });
  }

  /** What the display guard would have caught (the pretrial's readout). */
  get guard() { return this.diagnostics.guard; }

  /** Not drawn this frame (hidden, no size): the watches forget; 试一下 nobody saw is not played later. */
  notShown(): void { this.diagnostics.forget(); this.capability.clear(); }
  /** The WebGL context came back: GL objects the diagnostics kept are dropped. */
  contextBack(): void { this.diagnostics.contextBack(); }
  /** The model went (or the window hid): 试一下 and the previews end now. */
  modelGone(): void { this.capability.clear(); this.preview?.dropAll(); }
  /** Something here eases now (the pace stays full). */
  get busy(): boolean { return this.capability.active || this.preview?.busy === true; }
  start(id: unknown, owner: object | null, ctx: WindowCapabilityContext): boolean { return this.capability.start(id, owner, ctx); }
  activities(env: WindowMotionEnv, playing: WindowToolsFrame['playing']): MotionActivity[] { return windowActivities(env, { ...playing, preview: this.preview?.busy === true }); }
  dispose(): void { this.diagnostics.dispose(); this.preview?.dropAll(); }
}
