/**
 * I-154 batch 7, row 43: what the window engine does differently as the control window's preview (the old stage's `!options.transparent`
 * branches, src/stage/MmdStage.ts, mmd/model.ts, mmd/camera.ts, mmd/physics.ts):
 *  - the floor grid under her (hidden for the pictures and the stray watch skips while it shows);
 *  - the authoring previews (window-previews.ts) with the control window's grants (preview-port.ts) and their gates;
 *  - paused while the window is hidden: the model is let go and loaded again when the window shows (「预览已暂停 · 重开窗口自动恢复」),
 *    so a hidden control window holds no second copy of her;
 *  - no hair or chest physics runs here (the old stage's "previewOnly": the form still reads the model's support);
 *  - the fit check's scan of the motion library on a model that is not the reviewed Gene (the library's "suits this model" marks), with the
 *    host's stored scores, as the old stage's control window does (mmd/model.ts).
 * Senses and Unbound's channels are not here at all: the stage holds only the two narrow ports.
 */
import { GridHelper, type Scene } from 'three';
import { parseVmdWith } from '../../foundation/vmd';
import type { StageMotionRetarget } from '../../actions';
import type { BodyStageGates } from '../../stage';
import { WindowBodyPreview, WindowVisualPreview, type WindowPreviewStage } from './window-previews';
import type { WindowPreviewGrants } from './preview-port';
import type { WindowMotionEnv } from './window-motions';

/** The old stage's body preview gates (frameBodyPreview): any of these holds her, and a personal pose preview ends. */
export function bodyPreviewBlocked(gates: BodyStageGates): boolean {
  return !gates.visible || gates.manualPose || gates.manualGesture || gates.dynamicPose || gates.cameraOrWindow || gates.inputBlocked
    || gates.directContact || gates.music || gates.chatGesture;
}

/** The behaviour face's gates (window-motions.ts update): any of these holds her face, and a visual preview ends (eased out). */
export function visualPreviewBlocked(env: WindowMotionEnv): boolean {
  const view = env.view;
  return !env.shown || env.blocks.face || env.pat || env.feeding || env.hover || env.behaviorBlocked || env.adjusting
    || !view?.expressions || (view.snapshot?.intensity?.expression ?? 0) <= 0;
}

export class WindowPreviewMode {
  readonly grid = new GridHelper(60, 30, 0x344452, 0x263440);
  readonly body: WindowBodyPreview;
  readonly visual: WindowVisualPreview;
  /** The window is hidden: the model was let go; it is loaded again when the window shows. */
  suspended = false;

  constructor(scene: Scene, readonly grants: WindowPreviewGrants, stage: WindowPreviewStage) {
    scene.add(this.grid);
    this.body = new WindowBodyPreview(grants, stage);
    this.visual = new WindowVisualPreview(grants, stage);
  }

  /** The fit check's scan for this model: every library motion read (through the preview grant) and judged; `current()` false stops it. */
  scanFits(retarget: StageMotionRetarget, current: () => boolean): void {
    retarget.announce();
    if (!retarget.plan) return;
    void retarget.scan({ resolve: (packId, motionId) => this.grants.previewMotion(packId, motionId).then(asset => asset.url),
      read: url => fetch(url).then(response => response.arrayBuffer()), parse: buffer => parseVmdWith(buffer, retarget.transform), current }).catch(() => { /* the marks stay as they are */ });
  }

  /** The grid just under her floor (her soles stand on the figure's floor, lifted with the camera). */
  placeGrid(floorY: number): void { this.grid.position.y = floorY - 0.03; }

  /** Each frame before her body's: the gates, expiries and weights of both previews. */
  frame(dt: number, body: boolean, visual: boolean): void { this.body.frame(dt, body); this.visual.frame(dt, visual); }
  afterRender(): void { this.body.afterRender(); this.visual.afterRender(); }
  /** A preview shows or eases (the pace stays full; the journal says "expression-preview"). */
  get busy(): boolean { return this.body.busy || this.visual.busy; }
  /** The model went or the window hid: both end now (nothing on screen to ease). */
  dropAll(): void { this.body.dropAll(); this.visual.dropAll(); }
}
