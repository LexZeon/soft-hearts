/**
 * I-154 batch 5: the stage members of rows 30 聊天手势, 31 她的动作, 32 自动身体动作 and 38 惊喜 / 害羞 for the Unbound window stage, between
 * the games' members (window-stage-games.ts) and the stage (window-stage.ts), so the stage file stays small. Her motions are in
 * WindowMotions (window-motions.ts), her reactions and the shows in WindowReactions (window-reactions.ts); this answers the wiring's calls the
 * old stage's way (src/stage/mmd/body.ts, gesture.ts, previews.ts): typing, a window move and input focus only stop new automatic motions
 * starting, and what plays gives way smoothly.
 */
import type { StageSurface, PaceReason, ShowCapabilities } from '../../stage';
import type { ExpressionRecipe, ExpressionSupport } from '../../../shared/stage';
import { uiText } from '../../foundation/ui-language';
import { WindowStageGames } from './window-stage-games';
import type { WindowMotions } from './window-motions';
import { WindowReactions } from './window-reactions';

type S = StageSurface;

export abstract class WindowStageMotions extends WindowStageGames {
  protected abstract readonly motions: WindowMotions;
  protected abstract readonly reactions: WindowReactions;
  /** What the loaded model has for the 惊喜 / 害羞 show, or null without a model. */
  protected abstract showCapabilities(): ShowCapabilities | null;
  /** 「程序化小动作与表情」 is on (the show plays through her procedural life). */
  protected abstract lifeOn(): boolean;
  /** Her model now (a show belongs to it), or null. */
  protected abstract motionOwner(): object | null;
  protected abstract wakePace(reason: PaceReason): void;
  protected typing = false;
  protected behaviorBlocked = false;
  protected inputBlocked = false;

  /** R29b typing (behavior-gates.ts): pauses only NEW automatic motions; the living base keeps running, a chat gesture hands back. */
  setTyping(active: boolean): void {
    if (this.typing === active) return;
    this.typing = active;
    this.wakePace('typing');
    this.motions.gatesChanged(active, active);
  }
  /** A window move or resize (the application's own window ownership): automatic motions give way, nothing new starts. */
  setBehaviorBlocked(blocked: boolean): void {
    if (this.behaviorBlocked === blocked) return;
    this.behaviorBlocked = blocked;
    this.motions.gatesChanged(blocked, blocked);
  }
  /** The chat box is active or a field is being edited: no new automatic body motion (the face and the rest are unchanged). */
  setBodyInputBlocked(blocked: boolean): void {
    this.inputBlocked = blocked;
    this.motions.gatesChanged(blocked, false);
  }
  /** 她的动作 (T-211): played once on this model, and her answer goes back to the host (window-motions.ts). */
  async playHerAction(value: unknown): Promise<void> { await this.motions.playHerAction(value); }

  /** E1: what this model can show of a recipe (the buttons grey out only when nothing can). */
  expressionSupport(recipe: ExpressionRecipe): ExpressionSupport {
    return WindowReactions.support(recipe, this.showCapabilities(), this.lifeOn(), uiText('开发者面板里的“程序化小动作与表情”关着，打开后才能预览。'));
  }
  /** E1: 惊喜 / 害羞 on this stage now, on whatever model is loaded (missing parts are skipped). Null for anything but the two recipes. */
  playExpression(recipe: unknown, strength?: number): ReturnType<S['playExpression']> {
    const result = this.reactions.playExpression(recipe, strength, value => this.expressionSupport(value), this.motionOwner());
    if (result?.usable) this.wakePace('preview');
    return result;
  }
  /** I-037: one reaction cue from the host (the companion's performers decide; a running show is never restarted). */
  playReaction(cue: unknown): ReturnType<S['playReaction']> {
    const result = this.reactions.playReaction(cue, value => this.expressionSupport(value), this.motionOwner());
    if (result === 'played') this.wakePace('preview');
    return result;
  }
}
