/**
 * I-154 step 1: what drives her in the companion window when Unbound's engine draws her (docs/claude/2026-11-19-unbound-in-window.md).
 *
 * Goals only (Unbound's rule "只给目标，不写骨头"): each frame this hands her figure one set of PoseTargets, and the figure's own
 * springs (intent layer, eye-head coordinator) carry them, so nothing here can make her jump:
 *  - where she looks: the cursor, read every 100 ms by the companion window, keyframed by the companion's own PointerKeys and turned into a
 *    look from her eyes on the window (the companion's own split: up to 0.48 rad across, 0.28 rad up and down); "看鼠标" off: ahead;
 *  - blinks: a natural one every 3.2–7 s (the companion's rhythm), Unbound's blink shape (close 70 ms, hold 40 ms, open 130 ms);
 *  - a pat on her head: a small smile, her eyes eased half shut (the companion's 38 %), her head lifting a little into your hand. The
 *    lids are eased here (critically damped: the blink channel itself is crisp), natural blinks wait while they are low, and a
 *    pat survives the hand briefly leaving the scalp (the companion's PAT_HOLD), so a stroke does not flicker her face.
 * Pure: no DOM, no three.js; the stage feeds it and hands the result to the figure.
 */
import { REST_TARGETS, type PoseTargets } from '../motion/generator';
import { blinkCurve } from '../motion/own-moves';

/** The companion's pointer-to-look gains (src/stage/procedural.ts gazeTargets: yaw x·0.48, pitch y·0.28 before it splits them). */
export const WINDOW_LOOK = Object.freeze({ yawPerUnit: 0.48, pitchPerUnit: 0.28, maxYaw: 0.48, maxPitch: 0.28 });
/** A pat: smile, half-shut lids, head up into the hand (rad), how long it outlives a brief exit (s), how fast the lids ease (ω, 1/s). */
export const WINDOW_PAT = Object.freeze({ smile: 0.55, lids: 0.38, headPitch: -0.07, holdS: 0.35, lidOmega: 7 });
/** Natural blinks: the companion's rhythm (s), and the lid level above which none starts. */
export const WINDOW_BLINK = Object.freeze({ minS: 3.2, spreadS: 3.8, quietAbove: 0.2, lengthS: 0.24 });

export interface WindowLifeInput {
  /** Seconds since the last frame. */
  dt: number;
  /** The cursor on the companion window (-1..1, y up), as the companion reads it; null: none yet. */
  pointer: { x: number; y: number } | null;
  /** Her eyes on the window (-1..1, y up); null when the model has no head or eyes. */
  eyes: { x: number; y: number } | null;
  /** 「看鼠标」 (settings.pet.followMouse). */
  follow: boolean;
  /** A hand on her head this frame (the mood companion's contact). */
  pat: boolean;
  /**
   * Batch 2 (window-face.ts): her face's asks of the lids and the look; absent: the step-1 behaviour. `ownsPat`: the mood answers a
   * pat (its smile, lids and head), so the simple pat face here steps aside (the pat is still tracked: her idle yields to it).
   */
  face?: WindowLifeFace | null;
  /**
   * Batch 3 (row 16, window-gaze.ts): while pose sensing's chooser is engaged, the look's aim in the cursor's units from her eyes
   * (it replaces cursor − eyes and already says how much of the mouse it keeps); absent or null: the cursor, as before.
   */
  aim?: { x: number; y: number } | null;
  /** Batch 3 (row 15, window-proc-life.ts): when a natural blink starts, her own interval to the next (s); null or absent: the window's rhythm. */
  nextBlink?: (() => number | null) | null;
}
export interface WindowLifeFace {
  /** An enjoyed closure (a pat): natural blinks wait while it holds. */
  lids: number;
  /** A soft closure (tired lids, a thinking look down): natural blinks go on over it. */
  softLids: number;
  /** Batch 4 (慢慢眨眼): a performed blink 0..1, shown over the natural one; no natural blink starts while it shows. */
  blink?: number;
  ownsPat: boolean;
  /** How much of the cursor's pull remains; a look offset in the cursor's units; tired strength; asleep: no look; the mood's eye motions (rad). */
  gaze: { pull: number; x: number; y: number; strength: number; allowed: boolean; eyeYaw: number; eyePitch: number };
}

export class WindowLife {
  private t = 0;
  private nextBlink: number;
  private blinkAt = -10;
  private patUntil = -1;
  private lid = 0;
  private lidVelocity = 0;
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
    this.nextBlink = 1.5 + random() * 2;
  }

  /** The lids' eased closure from a pat now (0..1), for tests and the developer view. */
  get patLids(): number { return this.lid; }
  /** Batch 5: the natural blink's closure now (0..1; a face shape on the eyelids waits for it to open). */
  get naturalBlink(): number { return blinkCurve(this.t, this.blinkAt); }
  /** Being patted (including the short hold after the hand left). */
  get patted(): boolean { return this.t <= this.patUntil; }

  frame(input: WindowLifeInput): PoseTargets {
    const dt = Number.isFinite(input.dt) ? Math.min(0.25, Math.max(0, input.dt)) : 0;
    this.t += dt;
    if (input.pat) this.patUntil = this.t + WINDOW_PAT.holdS;
    const patted = this.patted, face = input.face ?? null, simplePat = patted && !face?.ownsPat;
    const held = Math.max(simplePat ? WINDOW_PAT.lids : 0, finite(face?.lids ?? 0)), soft = finite(face?.softLids ?? 0);
    this.easeLids(Math.min(1, Math.max(0, held, soft)), dt);
    // A natural blink: never while an enjoyed closure holds the lids low (nor while it eases open); over soft, tired lids it goes on.
    const performed = finite(face?.blink ?? 0);
    if (held > WINDOW_BLINK.quietAbove || (this.lid > WINDOW_BLINK.quietAbove && soft <= WINDOW_BLINK.quietAbove)) this.nextBlink = Math.max(this.nextBlink, this.t + WINDOW_BLINK.minS * 0.5);
    // 慢慢眨眼: no natural blink on top of it, and the next one comes a while after it (the old stage stretches the interval).
    else if (performed > 0) this.nextBlink = Math.max(this.nextBlink, this.t + WINDOW_BLINK.minS * 0.6);
    else if (this.t >= this.nextBlink) {
      this.blinkAt = this.t;
      const own = input.nextBlink?.() ?? null; // her procedural life's rhythm while it shows
      this.nextBlink = this.t + (own !== null && Number.isFinite(own) && own > 0 ? own : WINDOW_BLINK.minS + this.random() * WINDOW_BLINK.spreadS);
    }
    const blink = Math.max(blinkCurve(this.t, this.blinkAt), this.lid, Math.min(1, Math.max(0, performed)));
    return {
      ...REST_TARGETS,
      eyes: this.look(input),
      head: simplePat ? { pitch: WINDOW_PAT.headPitch, yaw: 0, roll: 0 } : REST_TARGETS.head,
      face: simplePat ? { curious: 0, smile: WINDOW_PAT.smile, startle: 0 } : REST_TARGETS.face,
      blink: Math.min(1, Math.max(0, blink)),
    };
  }

  /** Where she looks, rad in her frame (yaw + = her left = your right, pitch + = down). Always a target, so the hand-off never changes owner. */
  private look(input: WindowLifeInput): { yaw: number; pitch: number } {
    const gaze = input.face?.gaze;
    // Batch 2: the companion's look (src/stage/mmd/idle.ts): the cursor's pull (less while a touch draws her, replaced by a thinking
    // glance), plus the thinking glance's offset, scaled by how tired she is; asleep, none. The mood's eye motions on top.
    const follow = input.follow && gaze?.allowed !== false;
    const origin = input.eyes ?? { x: 0, y: 0 }, pull = gaze ? clamp(finite(gaze.pull), 0, 1) : 1;
    // Batch 3: pose sensing's aim (window-gaze.ts) replaces the cursor's while it is engaged; never while asleep.
    const aim = input.aim && gaze?.allowed !== false ? input.aim : null;
    const dx = aim ? finite(aim.x) * pull : follow && input.pointer ? (finite(input.pointer.x) - finite(origin.x)) * pull : 0;
    const dy = aim ? finite(aim.y) * pull : follow && input.pointer ? (finite(input.pointer.y) - finite(origin.y)) * pull : 0;
    const x = dx + (gaze?.allowed === false ? 0 : finite(gaze?.x ?? 0)), y = dy + (gaze?.allowed === false ? 0 : finite(gaze?.y ?? 0));
    const strength = gaze ? clamp(finite(gaze.strength), 0, 1) : 1;
    if (!gaze && !aim && (!input.follow || !input.pointer)) return { yaw: 0, pitch: 0 };
    return {
      yaw: clamp(x * WINDOW_LOOK.yawPerUnit * strength + finite(gaze?.eyeYaw ?? 0), -WINDOW_LOOK.maxYaw, WINDOW_LOOK.maxYaw),
      pitch: clamp(-y * WINDOW_LOOK.pitchPerUnit * strength + finite(gaze?.eyePitch ?? 0), -WINDOW_LOOK.maxPitch, WINDOW_LOOK.maxPitch),
    };
  }

  /** Critically damped, stepped exactly: any frame rate gives the same curve, no overshoot, zero speed at both ends. */
  private easeLids(goal: number, dt: number): void {
    if (dt <= 0) return;
    const omega = WINDOW_PAT.lidOmega, x0 = this.lid - goal, j = this.lidVelocity + omega * x0, e = Math.exp(-omega * dt);
    this.lid = goal + (x0 + j * dt) * e;
    this.lidVelocity = (this.lidVelocity - omega * j * dt) * e;
    if (goal === 0 && this.lid < 1e-4 && Math.abs(this.lidVelocity) < 1e-3) { this.lid = 0; this.lidVelocity = 0; }
    this.lid = Math.min(1, Math.max(0, this.lid));
  }
}

const finite = (value: number) => Number.isFinite(value) ? value : 0;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
