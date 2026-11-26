/**
 * I-154: the to-do list of Unbound's engine in the companion window (docs/claude/2026-11-19-unbound-in-window.md「功能覆盖表」).
 *
 * Every stage member the windows' wiring uses (src/stage/stage-surface.ts) that the engine does not do yet goes here, each a neutral
 * stand-in: it changes nothing on screen, starts nothing, and answers "none" / "not here" so the caller's own fallback runs (a preview
 * reports it could not play; a picture is refused, with notYetReason). Porting a feature = moving its members from here into a layer of
 * stage members (window-stage-games.ts, window-stage-motions.ts, window-stage-previews.ts …) and turning its row in the coverage table.
 * Nothing here may reach the host: a stand-in never calls window.desktop (host-ports.ts and preview-port.ts are the engine's only ports).
 *
 * Batch 7 (2026-11-20): the list is empty. The last members (试一下, the control window's previews, the avatar and the sticker reference)
 * moved to window-stage-previews.ts. The class stays as the bottom of the layers, for whatever the stage surface gains next.
 */
import { uiText } from '../../foundation/ui-language';

/** What a member says while the engine cannot show it (shown in the developer panel and the control window). */
export const notYetReason = (): string => uiText('桌宠正在用 Unbound 引擎（实验），这一项还没搬过来');

export abstract class WindowStageNotYet {}
