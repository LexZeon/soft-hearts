/**
 * I-154 batch 1, row 9「你不在时少画」(P1 舞台少画) in the companion window on Unbound's engine (docs/claude/2026-11-19-unbound-in-window.md).
 *
 * The old stage's frame clock and pace, unchanged (src/stage/frame-clock.ts acceptStageFrame, src/stage/stage-pace.ts): the user's fps
 * setting is the ceiling; while the user is away (the host's signal, setUserAway) or she is asleep, and nothing on screen has moved or
 * responded for PACE_HOLD_MS, the window draws at min(setting, AWAY_FPS). It never stops: time stays continuous (each drawn frame advances
 * her by the real time since the last one, capped like the old stage), so a slower pace samples the same motion less often and a move
 * in progress keeps the full pace until it has ended (PaceMotionProbe on her body and the bones physics moves; a touch, a pull, speaking,
 * the camera being dragged, a fade). The user back: the next frame is due at once at full pace.
 * Pure of the DOM and WebGL: the stage passes its time, its surface and what moved. scripts/dev/mutations/unbound.json window-pace-* guard it.
 */
import type { Object3D } from 'three';
import { acceptStageFrame, PACE_BODY_SPEED, PACE_PHYSICS_SPEED, PaceMotionProbe, StagePaceTracker, type PaceReason } from '../../stage';

export interface WindowPaceSurface { hostVisible: boolean; documentHidden: boolean; width: number; height: number }
export type WindowFrame = ReturnType<typeof acceptStageFrame>;

/** What moved or responded on a drawn frame (the stage fills it). */
export interface WindowPaceActivity {
  /** A pat or a pull held or easing back. */
  touch: boolean;
  /** The camera being dragged (调整镜头). */
  camera: boolean;
  speaking: boolean;
  /** She fades in or out (a model change). */
  fading: boolean;
  /** Her feet are settling a step (the gait). */
  stepping: boolean;
  /** Her body's main bones (centre, chest, head, arms) and the bones physics moves now. */
  body: readonly (Object3D | null | undefined)[];
  physics: readonly (Object3D | null | undefined)[];
}

export class WindowPace {
  private readonly tracker = new StagePaceTracker();
  private readonly bodyProbe = new PaceMotionProbe();
  private readonly physicsProbe = new PaceMotionProbe();
  private previous = 0;
  private due = 0;
  private fps = 0;
  private away = false;

  /** The host: the user is away (no input for a while, or the screen is locked). Back: the next frame is drawn at full pace, at once. */
  setAway(away: boolean): void {
    const next = away === true;
    if (next === this.away) return;
    this.away = next;
    if (!next) this.wake('input');
  }
  get userAway(): boolean { return this.away; }

  /** An input between frames (the pointer moved, a touch began, she started speaking): the next frame is at full pace. */
  wake(reason: PaceReason): void { this.tracker.wake(reason); }

  /** One display callback: whether to draw now, and by how much time to advance her. `asleep`: her fatigue phase says so. */
  accept(now: number, setting: unknown, surface: WindowPaceSurface, asleep: boolean): WindowFrame {
    const decision = this.tracker.decide({ now, setting, userAway: this.away, asleep: asleep === true, calmSwitch: false, calm: true });
    if (decision.fps > this.fps) this.due = 0; // speeding up: the next frame as soon as the faster pace allows, never on the slower schedule
    this.fps = decision.fps;
    const frame = acceptStageFrame(this.previous, now, decision.fps, surface, this.due);
    this.previous = frame.previous; this.due = frame.due;
    if (!frame.render && frame.reason !== 'throttled') { this.tracker.reset(); this.bodyProbe.reset(); this.physicsProbe.reset(); }
    return frame;
  }

  /** After a drawn frame: what moved or responded on it keeps the full pace for a while. `gap`: the real seconds since the last one. */
  drawn(now: number, gap: number, activity: WindowPaceActivity): void {
    const reason = this.reason(gap, activity);
    if (reason) this.tracker.note(now, reason);
    this.tracker.drawn();
  }

  /** The fps of the latest decision (the setting, or the away pace). */
  get currentFps(): number { return this.fps; }
  getState() { return { ...this.tracker.getState(), userAway: this.away }; }

  private reason(gap: number, a: WindowPaceActivity): PaceReason | null {
    // The speeds first, on every drawn frame, so each spans exactly one frame gap.
    const body = this.bodyProbe.measure(a.body, gap);
    const physics = a.physics.length ? this.physicsProbe.measure(a.physics, gap) : (this.physicsProbe.reset(), 0);
    if (a.touch) return 'touch';
    if (a.camera) return 'camera';
    if (a.speaking) return 'speaking';
    if (a.fading) return 'fade';
    if (a.stepping || body > PACE_BODY_SPEED) return 'moving';
    if (physics > PACE_PHYSICS_SPEED) return 'physics';
    return null;
  }
}
