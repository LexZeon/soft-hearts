/**
 * I-154 batch 5 (docs/claude/2026-11-20-unbound-window-batch5.md), rows 34 and 38 on Unbound's engine in the companion window:
 *  - row 34 对你打哈欠、伸懒腰、挥手的反应: the companion's PoseReactionStage (src/mood/pose-reaction-stage.ts) as it is. Its input is the
 *    host's pose view (MoodView.pose: only while the user's own pose sensing is on; nothing new is sensed), with her own cues laid over it
 *    as the old stage does (哈欠捂嘴's yawn, and her drowsy yawn and waking stretch from the sleep body, which batch 3 had to drop). Its face
 *    and head ride on procedural life's activity (her life's own yields apply), its chest, shoulders and waving arm are written through the
 *    figure's overlay (remembered, put back next frame), and it gives way smoothly to every owner her own life gives way to;
 *  - row 38 惊喜 / 害羞表演、反应: the companion's model-agnostic show (src/stage/expression-show.ts) on its own clock (ShowClock: a repeat
 *    while it holds keeps it going), played through procedural life's preview channel exactly as the old stage plays it (one weight for face
 *    and bones, eased out over 0.3 s when a touch or a window move interrupts it). Its bones become goals here (window-proc-life.ts), so the
 *    figure's springs carry them. The reaction cues (I-037) decide through the companion's playReactionCue.
 * Pure of the DOM; three.js only through the mesh and bones it is given.
 */
import { Euler, Quaternion, type Bone, type SkinnedMesh } from 'three';
import { PoseReactionStage, playReactionCue } from '../../mood';
import { SHOW_CLIP, SHOW_MS, ShowClock, clampStrength, showRequest, showSupport, type HerLifeStageGates, type LifeActivity, type ShowCapabilities } from '../../stage';
import { readPoseReactionView, type PoseCoverCue } from '../../../shared/mood';
import { isExpressionRecipe, type ExpressionRecipe, type ExpressionSupport } from '../../../shared/stage';
import type { CollisionProxy } from '../../../shared/actions';
import { withWave } from './window-capability';

export interface WindowReactionInput {
  /** The mesh (a new one drops what plays); null: no model. */
  owner: SkinnedMesh | null;
  /** MoodView.pose (null unless the user's own pose sensing gives something). */
  pose: unknown;
  /** Her own cues to lay over it: 哈欠捂嘴's yawn (window-motions.ts), then the sleep body's yawn or stretch; null: none. */
  yawn: { id: string; at: number } | null;
  sleepCue: (base: unknown, nowMs: number) => unknown | null;
  /** The owners her own life gives way to (the old stage's HerLifeStageGates); null: not free. */
  gates: HerLifeStageGates | null;
  /** 猜拳 holds her arm and face. */
  game: boolean;
  proxy: CollisionProxy | null;
  /** The camera shows her whole body (a breather's yawn may bring the hand only then). */
  fullBody: boolean;
  /** 哈欠捂嘴 for the host's live cue (her action through window-motions.ts). */
  cover: (cue: PoseCoverCue) => void;
  nowMs: number;
  /** Batch 7 (row 42 试一下 能做手势): the preview's wave cue, offered over everything else; absent: none. */
  wave?: { id: string; at: number } | null;
}

/** The show for procedural life's preview channel this frame. */
export interface ShowPreview { clip: string; elapsedMs: number; strength: number }

interface Show { recipe: ExpressionRecipe; owner: object; start: number | null; requestedAt: number; strength: number; clock: ShowClock }

export class WindowReactions {
  private pose: PoseReactionStage | null = null;
  private show: Show | null = null;
  private ms = 0;
  private yawnSeen = '';
  private readonly euler = new Euler();
  private readonly turn = new Quaternion();

  /** A reaction to your pose is playing (face shapes give way; the frame pace stays full). */
  get reacting(): boolean { return this.pose?.reacting === true; }
  /** It shows anything (attention, a reaction or its fading). */
  get active(): boolean { return this.pose?.active === true; }
  /** A stretch or a wave moves her chest, shoulders or arm. */
  get holdsBody(): boolean { return this.pose?.holdsBody === true; }
  /** A 惊喜 / 害羞 show is asked for or playing (a preview owner, as on the old stage). */
  get showing(): boolean { return this.show !== null; }
  getState() { return { pose: this.pose?.getState() ?? null, show: this.show ? { recipe: this.show.recipe, strength: this.show.strength } : null }; }

  /**
   * E1: 惊喜 / 害羞 on this model now (`support`: what of it the model shows; nothing usable: nothing starts). A repeat while it holds keeps
   * it going at the higher strength (show-blend.ts, show-clock.ts); the other one, or the same one later, starts over (procedural life
   * carries what showed out of the old one).
   */
  playExpression(recipe: unknown, strength: number | undefined, support: (recipe: ExpressionRecipe) => ExpressionSupport, owner: object | null): ExpressionSupport | null {
    if (!isExpressionRecipe(recipe)) return null;
    const result = support(recipe);
    if (!result.usable || !owner) return result;
    const show = this.show, s = clampStrength(strength), wall = show?.start == null ? 0 : this.ms - show.start;
    if (show?.owner === owner && showRequest({ recipe: show.recipe, elapsedMs: show.clock.at(wall) }, recipe) === 'keep') {
      show.strength = Math.max(show.strength, s); show.clock.extend(wall); return result;
    }
    this.show = { recipe, owner, start: null, requestedAt: this.ms, strength: s, clock: new ShowClock(recipe) };
    return result;
  }
  /** I-037: one reaction cue from the host (the companion's performers decide; a running show is never restarted). */
  playReaction(cue: unknown, support: (recipe: ExpressionRecipe) => ExpressionSupport, owner: object | null) {
    return playReactionCue(cue, { showingOther: () => false, playExpression: (recipe, strength) => this.playExpression(recipe, strength, support, owner) });
  }

  /**
   * One frame, before procedural life: the show's clock, and the reaction's activity over `base` (the games' face). Returns the activity
   * procedural life reads this frame.
   */
  frame(dt: number, input: WindowReactionInput, base: LifeActivity | null): LifeActivity | null {
    this.ms += Math.max(0, Number.isFinite(dt) ? dt : 0) * 1000;
    const show = this.show;
    if (show && (show.owner !== input.owner || (show.start === null && this.ms - show.requestedAt > 3_000)
      || (show.start !== null && show.clock.at(this.ms - show.start) >= SHOW_MS[show.recipe]))) this.show = null;
    const view = this.view(input);
    if (!view && !this.pose?.active) return base;
    const reaction = this.pose ??= new PoseReactionStage();
    return reaction.frame(dt, { owner: input.owner, view, nowMs: input.nowMs, game: input.game, gates: input.gates, proxy: input.proxy, fullBody: input.fullBody,
      cover: input.cover }, base);
  }

  /** The show for procedural life's preview channel (its first frame starts its clock); null: none. */
  preview(): ShowPreview | null {
    const show = this.show;
    if (!show) return null;
    show.start ??= this.ms;
    return { clip: SHOW_CLIP[show.recipe], elapsedMs: show.clock.at(this.ms - show.start), strength: show.strength };
  }

  /** The reaction's chest, shoulders and waving arm, as the figure's overlay (after her feet, before physics); null when nothing plays. */
  overlay(): ((remember: (bone: Bone) => void) => void) | null {
    const pose = this.pose;
    if (!pose?.reacting) return null;
    return remember => pose.applyPose({ remember, rotate: (bone, x, y, z) => {
      remember(bone);
      bone.quaternion.multiply(this.turn.setFromEuler(this.euler.set(x, y, z, 'YXZ')));
    } });
  }

  /** The host's view, with her own cue over it (as the old stage's poseReactionView: 试一下's wave first, batch 7). */
  private view(input: WindowReactionInput): unknown {
    if (input.wave) return withWave(input.pose, input.wave, readPoseReactionView);
    const yawn = input.yawn;
    if (yawn && yawn.id !== this.yawnSeen && input.nowMs - yawn.at <= 1_000) {
      // 她的动作 哈欠捂嘴: the P1 yawn as one local cue over what the host sent; the reaction's own owners decide (it yields like a yawn).
      const real = readPoseReactionView(input.pose);
      return { attention: real?.attention ?? 0, boost: real?.boost ?? 1, cue: { id: yawn.id, kind: 'yawn', source: 'own', at: yawn.at, strength: 1 } };
    }
    if (yawn && input.nowMs - yawn.at > 1_000) this.yawnSeen = yawn.id;
    // I-078: her own drowsy yawn or waking stretch (sleep-body.ts), offered the same way.
    return input.sleepCue(input.pose, input.nowMs) ?? input.pose ?? null;
  }

  /** What the show needs of a model, from what the window has (its face slots, head, upper body, eyes, blush). */
  static support(recipe: ExpressionRecipe, capabilities: ShowCapabilities | null, lifeOn: boolean, offReason: string): ExpressionSupport {
    if (!capabilities) return showSupport(recipe, null);
    if (!lifeOn) return { ...showSupport(recipe, null), reason: offReason };
    return showSupport(recipe, capabilities);
  }

  reset(): void { this.show = null; this.pose = null; this.yawnSeen = ''; }
}
