/**
 * I-154 batch 7 safety line (docs/claude/2026-11-19-unbound-in-window.md「第 7 批」): what the control window's preview may ask the host
 * when it is drawn by the window engine.
 *
 * The control window's preload (window.desktop) can switch every sense (camera, microphone, screen, the computer's sound, face sign-in),
 * reach Unbound's way out and its permission bundle, run tasks, save settings. The preview never gets it. It gets two narrow ports:
 *  - windowPreviewStageHost: the engine's own port (host-ports.ts WindowStageHost) with what the old stage in this same window already calls
 *    (is this the reviewed Gene; the granted bytes of a chat gesture, one of her actions, a behaviour face, a held pose; her default stand;
 *    2026-11-27: the model check-up cache read and its save, as in the companion window). The companion's
 *    only write, reportHerAction, never leaves here (the companion window answers the host; the old stage reports only there), and the
 *    automatic body motion's plan and bytes are refused (the old stage runs none in this window);
 *  - windowPreviewGrants: the authoring previews' receipts and grants (personal expressions and visuals, personal poses), the motion
 *    library's preview asset, and the motion fits' save (the fit check's scan; their stored copy comes with the engine port's cache read),
 *    each already called by the old stage in this window.
 * Nothing here is a sense, nothing is Unbound's. A new need adds one named method here and to the list; never the whole preload.
 * tests/unbound-window-preview.test.ts holds it; scripts/dev/mutations/unbound.json「window-preview-narrow-port」checks the test.
 */
import type { AssetRef } from '../../../shared/foundation/settings';
import type { BehaviorMotionResource, ExpressionResource, MotionPackId } from '../../../shared/actions';
import type { BodyPoseBinding, BodyPoseReceipt, VisualPreviewReceipt } from '../../../shared/stage';
import type { WindowStageHost } from './host-ports';

export interface WindowPreviewGrants {
  visualPreviewReceipt(request: VisualPreviewReceipt): Promise<void>;
  resolveVisualPreview(id: string, token: string, stageGeneration: number): Promise<BehaviorMotionResource>;
  resolveExpressionPreview(id: string, token: string, generation: number): Promise<ExpressionResource>;
  bodyPreviewReceipt(request: BodyPoseReceipt): Promise<void>;
  resolveBodyPreview(id: string, token: string, stageGeneration: number): Promise<BodyPoseBinding>;
  /** The motion library's asset for a pack motion (the fit check's scan reads its bytes). */
  previewMotion(packId: MotionPackId, motionId: string): Promise<AssetRef>;
  /** The fit check's scan saves this model's motion fits (their stored copy comes with the engine port's getModelProfile). */
  saveMotionFits(modelKey: string, record: unknown): Promise<boolean>;
}
/** Every grant the preview may call, by name. */
export const WINDOW_PREVIEW_GRANT_METHODS: readonly (keyof WindowPreviewGrants)[] = Object.freeze(['visualPreviewReceipt', 'resolveVisualPreview',
  'resolveExpressionPreview', 'bodyPreviewReceipt', 'resolveBodyPreview', 'previewMotion', 'saveMotionFits']);
/** The host methods the preview's engine port forwards (the rest of WindowStageHost answers here, without the host). */
export const WINDOW_PREVIEW_HOST_METHODS: readonly (keyof WindowStageHost)[] = Object.freeze(['isBehaviorModelSupported', 'resolveChatGesture',
  'resolveHerAction', 'resolveBehaviorMotion', 'resolveHerLifeMotion', 'getRestStand', 'getModelProfile', 'saveModelProfile']);

const refused = (): Promise<never> => Promise.reject(new Error('companion window only'));

/** The engine's port for the control window's preview: a new object, the allowed reads forwarded, the companion's write kept here. */
export function windowPreviewStageHost(desktop: Pick<WindowStageHost, 'isBehaviorModelSupported' | 'resolveChatGesture' | 'resolveHerAction'
  | 'resolveBehaviorMotion' | 'resolveHerLifeMotion' | 'getRestStand' | 'getModelProfile' | 'saveModelProfile'>): WindowStageHost {
  return Object.freeze({
    isBehaviorModelSupported: () => desktop.isBehaviorModelSupported(),
    resolveChatGesture: (cueId: string, token: string) => desktop.resolveChatGesture(cueId, token),
    resolveHerAction: (cueId: string) => desktop.resolveHerAction(cueId),
    reportHerAction: async () => { /* the companion window answers the host (the old stage reports only there) */ },
    getBehaviorBodyPlan: refused,
    resolveBehaviorBody: refused,
    resolveBehaviorMotion: (cueId: string, token: string) => desktop.resolveBehaviorMotion(cueId, token),
    resolveHerLifeMotion: (motionId: string, token: string) => desktop.resolveHerLifeMotion(motionId, token),
    getRestStand: async () => (await desktop.getRestStand?.()) ?? null, // her default stand, as the old stage in this window reads it
    getModelProfile: () => desktop.getModelProfile!(), // the check-up cache read and its save, as the old stage in this window made them
    saveModelProfile: (modelKey: string, profile: unknown) => desktop.saveModelProfile!(modelKey, profile),
  });
}

/** The authoring previews' port: a new object with the allowed grants only, each bound. */
export function windowPreviewGrants(desktop: WindowPreviewGrants): WindowPreviewGrants {
  return Object.freeze({
    visualPreviewReceipt: (request: VisualPreviewReceipt) => desktop.visualPreviewReceipt(request),
    resolveVisualPreview: (id: string, token: string, stageGeneration: number) => desktop.resolveVisualPreview(id, token, stageGeneration),
    resolveExpressionPreview: (id: string, token: string, generation: number) => desktop.resolveExpressionPreview(id, token, generation),
    bodyPreviewReceipt: (request: BodyPoseReceipt) => desktop.bodyPreviewReceipt(request),
    resolveBodyPreview: (id: string, token: string, stageGeneration: number) => desktop.resolveBodyPreview(id, token, stageGeneration),
    previewMotion: (packId: MotionPackId, motionId: string) => desktop.previewMotion(packId, motionId),
    saveMotionFits: (modelKey: string, record: unknown) => desktop.saveMotionFits(modelKey, record),
  });
}
