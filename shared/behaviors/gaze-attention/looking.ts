/**
 * I-167 (docs/claude/2026-11-21-gaze-at-user.md): "you are looking at her" vs "you face the screen but look elsewhere", from which way your
 * head points (the reading's turn) and where she is on the screen. Pure; the stage asks every frame, the host checks once per fact.
 *
 * People look with their eyes first and turn the head only part of the way, so the window is generous (knobs.looking: yaw / pitch degrees
 * of an ellipse around the direction to her) and has two edges: inside 1 to start, beyond `leave` to stop, each held `holdS` seconds.
 * No head reading (the nose or an eye not seen, or an older reading): not known (null), and the callers fall back to facing alone.
 */
import { angleToward, type UserGazePoint, type UserTurn } from './geometry';
import { GAZE_ATTENTION_KNOBS, type GazeAttentionKnobs } from './knobs';

/** How far the head's direction is from the direction to a spot, in units of the window (1 = its edge). */
export function lookOffset(turn: UserTurn, toward: { x: number; y: number }, knobs: GazeAttentionKnobs['looking'] = GAZE_ATTENTION_KNOBS.looking): number {
  const yaw = Math.max(1e-3, knobs.yaw), pitch = Math.max(1e-3, knobs.pitch);
  return Math.hypot((turn.x - toward.x) / yaw, (turn.y - toward.y) / pitch);
}

/**
 * The host's check before an eye contact reaches her mood: the head points at her window (or the screen she fills), within the leaving
 * edge. `point`: the user's head (the pointer's units of that window), `turn`: the head's direction. The window is -1..1 on both axes.
 */
export function turnTowardWindow(point: UserGazePoint, turn: UserTurn, knobs: GazeAttentionKnobs['looking'] = GAZE_ATTENTION_KNOBS.looking): boolean {
  const lo = angleToward(point, -1, -1), hi = angleToward(point, 1, 1);
  const gap = (value: number, a: number, b: number) => value < Math.min(a, b) ? Math.min(a, b) - value : value > Math.max(a, b) ? value - Math.max(a, b) : 0;
  const yaw = Math.max(1e-3, knobs.yaw), pitch = Math.max(1e-3, knobs.pitch);
  return Math.hypot(gap(turn.x, lo.x, hi.x) / yaw, gap(turn.y, lo.y, hi.y) / pitch) <= Math.max(1, knobs.leave);
}

/** "Looking at her" with two edges and a hold, frame by frame. */
export class LookingAtHer {
  private on = false;
  private held = 0;
  private known = false;

  constructor(private readonly knobs: GazeAttentionKnobs['looking'] = GAZE_ATTENTION_KNOBS.looking) {}

  /**
   * One frame: `point` where your head is, `turn` which way it points (null: not known), `herX`, `herY` where she is (the pointer's units).
   * Returns true / false, or null while the head's direction is not known (the state is then forgotten: it starts from "not looking").
   */
  frame(dt: number, point: UserGazePoint | null, turn: UserTurn | null, herX: number, herY: number): boolean | null {
    if (!point || !turn || !Number.isFinite(herX) || !Number.isFinite(herY)) { this.on = false; this.held = 0; this.known = false; return null; }
    const step = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
    const offset = lookOffset(turn, angleToward(point, herX, herY), this.knobs);
    const wants = this.on ? offset <= Math.max(1, this.knobs.leave) : offset <= 1;
    if (!this.known) { this.known = true; this.on = wants; this.held = 0; return this.on; }
    if (wants === this.on) { this.held = 0; return this.on; }
    this.held += step;
    if (this.held >= this.knobs.holdS) { this.on = wants; this.held = 0; }
    return this.on;
  }

  get looking(): boolean { return this.on; }
}
