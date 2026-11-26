/**
 * I-154 batch 7: the stage members of row 42 (试一下, previewCapability: the companion window), row 43 (the control window's authoring
 * previews) and row 44 (the avatar and the sticker reference) for the Unbound window stage, between the (now empty) not-yet list and the
 * music members, so window-stage.ts stays a wiring file. The previews themselves are window-capability.ts and window-previews.ts, the
 * pictures window-capture.ts. Only the control window's stage has the preview grants (preview-port.ts); in the companion window the
 * authoring previews answer false, as the old stage does there.
 */
import type { StageSurface } from '../../stage';
import type { AuthoringPreview } from '../../../shared/actions';
import type { BodyPosePreview } from '../../../shared/stage';
import type { StickerCapture } from '../../../shared/cards';
import { uiText } from '../../foundation/ui-language';
import { WindowStageNotYet } from './not-yet';
import type { WindowBodyPreview, WindowVisualPreview } from './window-previews';
import { renderAvatar, renderStickerReference, type WindowCaptureParts } from './window-capture';

type S = StageSurface;
const messages = () => ({ size: uiText('模型预览没有可见尺寸。'), context: uiText('头像暂时截不了。'), changed: uiText('模型已经变化。') });

export abstract class WindowStagePreviews extends WindowStageNotYet {
  /** 试一下 on the model shown, with the stage's state now (window-capability.ts WindowCapabilityPreviews.start). */
  protected abstract startCapability(id: unknown): boolean;
  /** The control window's authoring previews; null in the companion window (no grants there). */
  protected abstract authoring(): { body: WindowBodyPreview; visual: WindowVisualPreview } | null;
  /** The pictures' parts when the preview is ready for one (`avatar`: also faded in fully), else null. */
  protected abstract captureParts(expectedUrl: string, generation: number, avatar: boolean): Promise<{ parts: WindowCaptureParts; still(): boolean } | null>;
  protected abstract modelGenerationNow(): number;
  protected abstract previewWake(): void;

  /** I-024 试一下 (row 42): show this capability once (window-capability.ts); false when the card says no or the part is owned now. */
  previewCapability(id: Parameters<S['previewCapability']>[0]): boolean {
    const started = this.startCapability(id);
    if (started) this.previewWake();
    return started;
  }
  /** Row 43: 个性化眉眼 and 表情预览 (window-previews.ts); the control window only. */
  async previewVisual(view: AuthoringPreview): Promise<boolean> {
    const authoring = this.authoring();
    if (!authoring) return false;
    this.previewWake();
    return authoring.visual.start(view);
  }
  cancelVisualPreview(id?: string, token?: string, notify = true): void { this.authoring()?.visual.cancel(id, token, notify); }
  /** Row 43: 个性化姿势 (window-previews.ts); the control window only. */
  async previewBody(view: BodyPosePreview): Promise<boolean> {
    const authoring = this.authoring();
    if (!authoring) return false;
    this.previewWake();
    return authoring.body.start(view);
  }
  cancelBodyPreview(id?: string, token?: string, notify = true, _inFrame?: boolean): void { this.authoring()?.body.cancel(id, token, notify); }
  /** There is no Gene-only surprise clip on this engine (惊喜 / 害羞 are the model-agnostic show, playExpression): nothing to cancel. */
  cancelSurprisePreview(_id?: string, _inFrame?: boolean): void {}

  /** Row 44, C2 角色页: a small half-body picture of her as she stands in the preview now (window-capture.ts). */
  async captureCharacterAvatar(expectedUrl: string, side = 192): Promise<string> {
    const ready = await this.captureParts(expectedUrl, this.modelGenerationNow(), true);
    if (!ready) throw Error(uiText('模型预览还没准备好，稍后再截头像。'));
    return renderAvatar(ready.parts, side, ready.still, messages());
  }
  /** Row 44: the preview canvas as the sticker reference (window-capture.ts). */
  async captureCharacterStickerReference(expectedUrl: string): Promise<StickerCapture> {
    const generation = this.modelGenerationNow();
    const ready = await this.captureParts(expectedUrl, generation, false);
    if (!ready) throw Error(uiText('当前模型预览还不能作为参考，请等待载入并结束镜头调整。'));
    return renderStickerReference(ready.parts, expectedUrl, generation, ready.still, messages());
  }
}
