/**
 * I-154 / I-176: Unbound's engine in the companion window and in the control window's preview (docs/claude/2026-11-19-unbound-in-window.md,
 * docs/claude/2026-11-23-i176-delete.md; README.md here). The renderer wiring (src/wiring/stage-wiring.ts) imports this folder through this file
 * only. Not re-exported from src/unbound/index.ts: the mood companion reaches that page, and this folder reaches the stage page (a runtime
 * import cycle).
 */
import { readWindowStyle, watchWindowStyle, type ChoiceStorage } from './window-style';
import { windowStageHost, type WindowStageHost } from './host-ports';
import { windowPreviewGrants, windowPreviewStageHost, type WindowPreviewGrants } from './preview-port';

export { UnboundWindowStage } from './window-stage';
export { announceWindowStyle, readWindowStyle, writeWindowStyle, watchWindowStyle, pageStorage, WINDOW_STYLE_KEY } from './window-style';
export type { WindowStageHost } from './host-ports';
export type { WindowPreviewGrants } from './preview-port';
/** I-154 batch 2: what 「边说边演」 passes to UnboundWindowStage.showExpression (window-expression.ts). */
export type { ShowExpressionOptions, ShowExpressionResult } from './window-expression';

/**
 * The stage of a window, made by Unbound's engine: the personal-feel strength stored for this profile, and the narrow ports. The companion
 * window's stage gets only its host port (host-ports.ts), never the preload; the control window's preview gets the preview's port and the
 * authoring grants (preview-port.ts): no sense, no Unbound channel, no companion write.
 */
export function createWindowStage<T>(input: { isPet: boolean; storage: ChoiceStorage | null; desktop: WindowStageHost & WindowPreviewGrants },
  make: (host: WindowStageHost, style: number, grants: WindowPreviewGrants | null) => T): { stage: T; style: number } {
  const style = readWindowStyle(input.storage);
  if (input.isPet) return { stage: make(windowStageHost(input.desktop), style, null), style };
  return { stage: make(windowPreviewStageHost(input.desktop), style, windowPreviewGrants(input.desktop)), style };
}

/** Once the stage is made: the stored strength changed (the slider, any page of the profile) is applied in place. */
export function followWindowStyle(started: number, apply: (value: number) => void): void {
  watchWindowStyle(window, started, apply);
}
