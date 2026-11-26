/**
 * I-154 batch 4 (docs/claude/2026-11-20-unbound-window-batch4.md): rows 26 猜拳, 27 递东西 (snack, cushion) and 28 牵手、拉钩、击掌 in the
 * companion window on Unbound's engine.
 *
 * The same performers as the old stage, with the same inputs and clocks (src/initiative/: RpsPerformance's raised hand, count strokes,
 * hand shapes and result timing; GivePerformance's reach, hold, take and withdraw with its snack or cushion; HandsStageLayer's reach for
 * your mouse, hold, squeeze, touch and let go). What is different, on purpose: none of them writes a bone here. Each frame their arm is
 * read as a design (armAim, src/initiative/arm-aim.ts) and handed to the engine's own arm reach as an 'aim' target (src/unbound/arm-reach.ts):
 * the figure solves the arm after the body it rides on and before the pull, so your hand pulling hers still wins (the pull is written
 * after it, as on the old stage). Their faces go to her procedural life as its activity (as on the old stage), the reach's lean to her
 * upper body's goal. Props (the cookie, the snack card, the cushion) are the performer's own, placed after her frame.
 *
 * Layered like the old stage writes them (game, then the offer, then the hand): when two hold the same arm at once, the later one is
 * laid over the earlier by its own weight (the old slerp chain, as directions), so a hand-off is a blend, never a jump.
 * Pure of the DOM: the stage (window-stage.ts) feeds it and reads the anchors.
 */
import { Vector3, type Camera, type Object3D, type SkinnedMesh } from 'three';
import { GivePerformance, HandsStageLayer, RpsPerformance, rpsStageCue, type GiveStageCue, type GiveStageOutcome, type HandReachCue, type HandReachState,
  type PerformerArmAim } from '../../initiative';
import type { HandsStageCommand, RpsView } from '../../../shared/initiative';
import type { CollisionProxy } from '../../../shared/actions';
import type { LifeActivity } from '../../stage';
import type { HandShapeTable, HandTarget, HandTargets } from '../arm-reach';
import type { Rot } from '../motion/generator';

export interface WindowGamesFrame {
  /** Her arms for the engine's reach (per side; null: nothing of the games on that arm). */
  hands: HandTargets;
  /** Her game face, laid over her own activity (procedural life's input); null: none. */
  activity: LifeActivity | null;
  /** Added to her upper body's goal (the reach's slow turn and lean toward your hand). */
  torso: Rot;
  /** The game holds her head (her sleep pose gives way, as on the old stage). */
  head: boolean;
}
const ZERO: Rot = Object.freeze({ pitch: 0, yaw: 0, roll: 0 }) as Rot;
const NONE: WindowGamesFrame = Object.freeze({ hands: Object.freeze({ left: null, right: null }), activity: null, torso: ZERO, head: false }) as WindowGamesFrame;

export class WindowGames {
  readonly hands = new HandsStageLayer();
  private rps: RpsPerformance | null = null;
  private give: GivePerformance | null = null;
  private owner: SkinnedMesh | null = null;

  constructor(private readonly scene: Object3D | null) {}

  /** Anything of a game, an offer or a reach still shows (her arms are held: a beat's hand gives way, the sleep body yields). */
  get busy(): boolean { return this.rps?.active === true || this.give?.active === true || this.hands.active; }
  get rpsActive(): boolean { return this.rps?.active === true; }
  /** The game's own state while it shows (the developer readout, window-readouts.ts); null otherwise. */
  rpsState(): unknown { return this.rps?.active ? this.rps.getState() : null; }
  get giveActive(): boolean { return this.give?.active === true; }
  /** Her arms are held: a pull, the game, an offer or her reach (a beat's hand does not start; the sleep body yields). */
  armsHeld(pulled: boolean): boolean { return pulled || this.busy; }

  // ---- the stage members (the old stage's her-life.ts, the same rules) ---------------------------------------------------------
  /** G1 猜拳: the host's game view (null when it is over); the layer eases in and out by itself. */
  setRps(view: RpsView | null): void { (this.rps ??= new RpsPerformance()).cue(rpsStageCue(view)); }
  /** I-086: an offer; `onOutcome` hears taken / not-taken / interrupted once. */
  startGive(cue: GiveStageCue, onOutcome?: (id: string, outcome: GiveStageOutcome) => void): void { (this.give ??= new GivePerformance(this.scene)).start(cue, onOutcome); }
  takeGive(): boolean { return this.give?.take() === true; }
  withdrawGive(outcome: 'not-taken' | 'interrupted' = 'interrupted'): void { this.give?.withdraw(outcome); }
  giveAnchor(camera: Camera | null, width: number, height: number) { return this.give?.anchor(camera, width, height) ?? null; }
  /** I-087: she reaches toward your mouse; false while the game or an offer holds her arm (the old stage's rule). */
  startHands(cue: HandReachCue): boolean {
    if (this.rps?.active || this.give?.active) return false;
    this.hands.start(cue); return true;
  }
  handsCommand(command: HandsStageCommand): void { this.hands.command(command); }
  handsState(): HandReachState | null { return this.hands.state(); }
  handsAnchor(camera: Camera | null, width: number, height: number) { return this.hands.anchor(camera, width, height); }
  /** Your mouse is within her reach now; never while the game or an offer holds her arm. */
  handsNear(camera: Camera | null): boolean { return !this.rps?.active && !this.give?.active && this.hands.near(camera, this.owner); }

  /**
   * One frame, before her body's: the performers' clocks, then their arms as designs for the reach, their faces as her activity.
   * `pointer`: the cursor as the gaze reads it; `follow`: 「看鼠标」; `camera`: the window's (where your hand is in front of her).
   */
  frame(delta: number, input: { mesh: SkinnedMesh | null; pointer: { x: number; y: number }; follow: boolean; camera: Camera | null; proxy?: CollisionProxy | null;
    /** Batch 6: her own life's activity (row 33), the base their faces lay over, as on the old stage. */
    base?: LifeActivity | null }): WindowGamesFrame {
    this.owner = input.mesh;
    this.rps?.frame(delta, input.mesh, input.proxy ?? null);
    this.give?.frame(delta, input.mesh);
    this.hands.frame(delta, input.mesh, input.pointer, input.follow);
    const base = input.base ?? null;
    if (!this.busy) return base ? { ...NONE, activity: base } : NONE;
    const aims = [this.rps?.armAim() ?? null, this.give?.armAim() ?? null, this.hands.reach.armAim(input.camera)];
    const hands: HandTargets = { left: null, right: null };
    for (const side of ['left', 'right'] as const) hands[side] = stack(aims.filter((a): a is PerformerArmAim => !!a && a.side === side));
    const rps = this.rps, give = this.give;
    const activity = this.hands.activity(give ? give.activity(rps ? rps.activity(base) : base) : rps ? rps.activity(base) : base);
    const lean = this.hands.reach.leanShown;
    return { hands, activity, torso: { pitch: lean.pitch, yaw: lean.yaw, roll: 0 }, head: this.rps?.active === true };
  }

  /** After her frame (her pose final): the offer's prop where her hand is now, and the reach's click target on her hand. */
  after(camera: Camera | null): void {
    this.give?.place(camera);
    this.hands.reach.measureAnchor();
  }

  dispose(): void { this.give?.dispose(); this.give = null; this.rps = null; }
}

/**
 * The arms that hold one side, in the old stage's write order, as one target: each later one laid over what is below by its own weight
 * (final = slerp(slerp(base, lower, w₁), upper, w₂), as directions: combined weight W = 1 − (1 − w₁)(1 − w₂), the upper's share w₂ / W).
 */
export function stack(aims: readonly PerformerArmAim[]): HandTarget | null {
  let out: { weight: number; upper: Vector3; fore: Vector3; hand: Vector3; palm: Vector3; fingers: HandShapeTable | null } | null = null;
  for (const aim of aims) {
    const w = Math.min(1, Math.max(0, Number.isFinite(aim.weight) ? aim.weight : 0));
    if (!(w > 0)) continue;
    if (!out) { out = { weight: w, upper: aim.upper.clone(), fore: aim.fore.clone(), hand: aim.hand.clone(), palm: aim.palm.clone(), fingers: aim.fingers }; continue; }
    const W = 1 - (1 - out.weight) * (1 - w), a = w / W;
    const mix = (from: Vector3, to: Vector3) => { from.lerp(to, a); if (from.lengthSq() < 1e-10) from.copy(to); return from.normalize(); };
    mix(out.upper, aim.upper); mix(out.fore, aim.fore); mix(out.hand, aim.hand); mix(out.palm, aim.palm);
    out.fingers = !aim.fingers ? out.fingers : !out.fingers ? aim.fingers : blendShapes(out.fingers, aim.fingers, a);
    out.weight = W;
  }
  if (!out) return null;
  const v = (p: Vector3) => ({ x: p.x, y: p.y, z: p.z });
  return { weight: out.weight, pose: 'aim', wave: 0, aim: { upper: v(out.upper), fore: v(out.fore), hand: v(out.hand), palm: v(out.palm) }, fingers: out.fingers ?? undefined };
}

function blendShapes(a: HandShapeTable, b: HandShapeTable, t: number): HandShapeTable {
  const rows = (x: HandShapeTable['thumb'], y: HandShapeTable['thumb']) => x.map((row, j) => [row[0] + ((y[j] ?? row)[0] - row[0]) * t, row[1] + ((y[j] ?? row)[1] - row[1]) * t] as [number, number]);
  return { thumb: rows(a.thumb, b.thumb), fingers: [0, 1, 2, 3].map(i => rows(a.fingers[i], b.fingers[i])) as unknown as HandShapeTable['fingers'] };
}
