/**
 * I-154 batch 6, row 25 眼泪 (docs/claude/2026-11-20-unbound-window-batch6.md): her tears in the companion window on Unbound's engine.
 * The old stage's two pieces run unchanged (src/stage/mmd/blush-tears.ts on this window's state):
 *  - the crying timeline (src/mood/crying-timeline.ts CryingTimeline): one bounded presentation clock per accepted host reunion cue, its
 *    own smooth rise, hold and fade; comfort (your reply, a pat) shortens it, never lengthens it; hidden, a window or camera move, a picked
 *    expression, 「自动表现」 off: no cry starts, a running one stops (the timeline's own rule; nothing moves, it is paint);
 *  - the tear surface (src/mood/procedural-tears.ts ProceduralTears): painted on her face material, placed by the anchors measured on her
 *    rest pose (window-blush.ts owns the face materials: tears wrap the blush's, so it rebuilds both in order). A swapped-in material
 *    keeps its file place (src/foundation/draw-order.ts keepDrawPlace, docs/claude/2026-11-20-mumi-brow-clip.md): the window's renderer
 *    sorts by file order (fileOrderRenderer), so the face never drops behind the brows.
 * Who may cry (windowTearsGate, I-024): the reviewed Gene unless 能流泪 is off; another model only when its card has it on and the
 * anchors pass the same checks.
 */
import { CryingTimeline, type CryingFrame } from '../../mood';
import { capabilityEnabled, type ModelCapabilities } from '../../../shared/stage';
import type { MoodView } from '../../../shared/mood';
import { uiText } from '../../foundation/ui-language';

export interface TearsGate { gene: boolean; card: boolean; reason: string | null }

/** I-024 流泪 (the old stage's tearsGate): the reviewed Gene unless the card turns it off; another model when its card has it on. */
export function windowTearsGate(reviewedGene: boolean, card: ModelCapabilities | null): TearsGate {
  const off = card?.tears?.choice === 'off';
  return { gene: reviewedGene && !off, card: !reviewedGene && capabilityEnabled(card, 'tears'), reason: off ? uiText('角色页关了"能流泪"：流泪不开') : null };
}

export interface WindowCryingInput {
  view: MoodView | null;
  /** Drawn now (not hidden, the window has a size). */
  visible: boolean;
  /** A window move or a camera adjust (the old stage's behaviorBlocked, controls.interacting). */
  adjusting: boolean;
  /** A picked expression owns her face. */
  faceBlocked: boolean;
  /** The tear surface is on her face (window-blush.ts). */
  supported: boolean;
  /** Wall clock (ms): the host's reunion cue times are on it. */
  nowMs: number;
}

/** The crying timeline on this window's state; how much of a cry shows this frame and its clock, for the tear surface. */
export class WindowCrying {
  private timeline = new CryingTimeline();
  private shown = { amount: 0, elapsedMs: 0 };
  private last: CryingFrame | null = null;

  frame(delta: number, input: WindowCryingInput): Readonly<{ amount: number; elapsedMs: number }> {
    const view = input.view;
    if (!view) { this.stop(); return this.shown; }
    const frame = this.timeline.update({ characterId: view.characterId, token: view.token, nowMs: input.nowMs, snapshot: view.snapshot,
      durationMs: view.parameters.longing.cryDurationMs, reunionMs: view.parameters.interaction.reunionMs, expressionIntensity: view.snapshot.intensity.expression,
      allowed: view.expressions && !input.adjusting, visible: input.visible, supported: input.supported, faceBlocked: input.faceBlocked }, delta);
    this.shown = { amount: frame.amount, elapsedMs: frame.elapsedMs };
    this.last = frame;
    return this.shown;
  }
  /** Scope loss or the model goes: the running cry stops (consumed cues stay consumed, as on the old stage). */
  stop(): void { this.timeline.cancel(); this.shown = { amount: 0, elapsedMs: 0 }; this.last = null; }
  /** The timeline's own latest frame (the developer readout, window-readouts.ts); null while no cry has been asked for. */
  get latest(): CryingFrame | null { return this.last; }
  get amount(): number { return this.shown.amount; }
}
