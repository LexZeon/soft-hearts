/**
 * I-196: the page's side of the joystick pull and the wheel (the rules are shared/unbound/pull-stick/): each frame the pointer's offset from
 * the press point, or a few notches of the wheel, become one wanted point for her gait. Only the gait moves her feet (never faster than her
 * walk); letting go sends her gait back to where she stands, so she brakes instead of stopping dead. The far end of her range is today's
 * (ports.clampDepth), the near end is the eyes' station with its no-clipping guard (src/unbound/pull-near.ts, through the same port).
 */
import { stickGoal, stickReading, wheelDepth, type StickKnobs } from '../../shared/unbound/pull-stick';

export interface StickFigure {
  readonly rootM: { x: number; z: number };
  followTo(point: { x: number; z: number }): void;
}
export interface StickDrivePorts {
  viewerDistanceM(): number;
  /** A floor x (m) kept inside her stand range at that depth. */
  clampX(xM: number, depthM: number): number;
  /** A depth (m) kept inside her depth range (near end: the eyes' station; far end: her saved-place range). */
  clampDepth(depthM: number): number;
}

/** A goal nearer than this to where she stands (m) asks for no step: the stick has hardly left its dead zone (she would not step for it anyway). */
const MIN_GOAL_M = 0.02;

export class StickDrive {
  private moving = false;
  private goal: { xM: number; depthM: number } | null = null;

  constructor(private readonly ports: StickDrivePorts, private readonly knobs: StickKnobs) {}

  /** She is being walked by the stick or the wheel now (a let-go then counts as a pull that moved her). */
  get active(): boolean { return this.moving; }

  /**
   * One frame. `offset`: the pointer's offset from the press point (px), or null for none; `notches`: wheel notches since the last frame
   * (positive: closer). The wheel adds to where she was last asked to go, so a few notches in a row add up while she is still walking.
   */
  frame(figure: StickFigure, offset: { dx: number; dy: number } | null, notches = 0): void {
    const root = figure.rootM, here = { xM: root.x, depthM: -root.z }, viewer = this.ports.viewerDistanceM();
    let next: { xM: number; depthM: number };
    if (notches !== 0 && Number.isFinite(notches)) {
      const base = this.goal ?? here, depthM = this.ports.clampDepth(wheelDepth(base.depthM, notches, viewer, this.knobs));
      next = { xM: this.ports.clampX(base.xM, depthM), depthM };
      this.goal = next;
    } else if (offset) {
      const reading = stickReading(offset.dx, offset.dy, this.knobs);
      if (reading.side === 0 && reading.depth === 0) { this.stop(figure); return; } // inside the dead zone: nothing moves (and what moved her brakes)
      const wanted = stickGoal(here, reading, viewer, this.knobs), depthM = this.ports.clampDepth(wanted.depthM);
      next = { xM: this.ports.clampX(wanted.xM, depthM), depthM };
      this.goal = null;
      if (Math.hypot(next.xM - here.xM, next.depthM - here.depthM) < MIN_GOAL_M) { this.stop(figure); return; } // hardly past the dead zone: no step asked for
    } else return; // the wheel's goal stands until the wheel session ends
    this.moving = true;
    figure.followTo({ x: next.xM, z: -next.depthM });
  }

  /** Back to standing where she is (the gait brakes), and forget the wheel's goal. */
  stop(figure: StickFigure): void {
    if (this.moving) figure.followTo(figure.rootM);
    this.moving = false; this.goal = null;
  }

  reset(): void { this.moving = false; this.goal = null; }
}
