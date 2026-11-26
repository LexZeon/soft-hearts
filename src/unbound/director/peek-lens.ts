/**
 * Unbound U2, the first action: peek-lens (I-104). docs/claude/2026-11-12-unbound-peek.md.
 *
 * Beats, each decided live from her body at that moment (the plan from the host only gives the mood-made knobs):
 *   notice  she sees the lens: eyes first, the head after, brows up a little (brisk)
 *   walk    if she is not already close: where to stand is solved from her own measurements now (which eye, how far she can lean
 *           and still get that eye up to the axis on her toes), then the gait walks her there
 *   lean    a tiny lean back first (anticipation), then she leans in while the chosen eye is brought onto the axis by the
 *           generator's closed loop, from where it is to a few cm from the lens; tense, she stops part-way for a moment
 *   hold    the stare: she holds her breath a little, blinks now and then (crisp), small saccades and drift
 *   back    upright again: a short startle if you moved, otherwise a small after-smile
 *   settle  she walks back to where she was; done when she is there
 */
import { PEEK_TIMING, type PeekCancelReason, type PeekCommand, type PeekPhase, type PeekPlan } from '../../../shared/unbound/director';
import type { BodySense, MotionIntent } from '../motion/generator';
import { axisOffset, chooseEye, eyePoint, facingLens, leanFor, onAxis, standFor, toHerFrame, type BodyFrame, type EyeAim, type LensView } from '../motion/lens-align';
import { ARRIVAL_KNOBS, eyeClearDistance, frameWorst, usableFace } from '../../../shared/unbound/arrival';
import type { DirectorAction, DirectorBody, DirectorWorld, Performance } from './director';

/** Beat timing that is not in the plan (s). T-246a hook: rules from Codex's 生动规则手册 replace these. */
export const PEEK_BEATS = Object.freeze({
  /** The small preparation before the lean-in: a touch back first (rad; its length is the plan's prepareS). */
  anticipationRad: -0.035,
  /** Closer than this (m, her root to the solved stand point) she does not walk, the lean and hips cover it. */
  walkFromM: 0.08,
  walkTimeoutS: 30,
  /** She is close enough to start holding (m off the target), or the approach has taken this much longer than planned (s). */
  holdWithinM: 0.012, holdLateS: 2.5,
  /** Where she pauses when hesitant (fraction of the approach). */
  hesitateAt: 0.6,
  backS: 1.1, backStartledS: 0.8,
  settleTimeoutS: 40,
  /** Blink keyframes (s): close, closed, open. */
  blink: Object.freeze([0.07, 0.04, 0.13] as const),
  saccadeEvery: Object.freeze([0.45, 1.2] as const),
  /** How much of her toes' rise the stand solve may count on (the rest is left for the loop). */
  tiptoeShare: 0.75,
});

const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };
/** A small seeded random (mulberry32), so a peek's blinks and saccades are its own and a test can repeat them. */
function seeded(seed: number): () => number {
  let a = Math.floor(seed * 2 ** 32) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}
/** A blink's lid value at `t` s into it (keyframes, crisp; 0 outside). */
export function blinkAt(t: number): number {
  const [close, closed, open] = PEEK_BEATS.blink;
  if (t < 0 || t > close + closed + open) return 0;
  if (t < close) { const u = t / close; return u * u; }
  if (t < close + closed) return 1;
  const u = (t - close - closed) / open; return 1 - u * (2 - u);
}

class PeekLensPerformance implements Performance {
  phase: PeekPhase = 'notice';
  cancelled: PeekCancelReason | null = null;
  private t = 0;
  private since = 0;
  private eye: EyeAim = 'left';
  private stand: { x: number; z: number } | null = null;
  private lean = 0;
  private startDistance = 0;
  /** Lens to her eye (its visible surface) at the closest (m): from the plan's fill and the model's own eye size (peekDistance). */
  private boneDistance = 0.1;
  private paused = 0;
  private arrivedAt: number | null = null;
  private home: { x: number; z: number };
  private readonly random: () => number;
  private nextBlink = 0;
  private nextSaccade = 0;
  private saccade = { yaw: 0, pitch: 0 };

  constructor(readonly id: string, private readonly plan: PeekPlan, world: DirectorWorld) {
    this.home = { ...world.home };
    this.random = seeded(plan.seed);
  }

  /** Seconds in the current beat. */
  private get beat(): number { return this.t - this.since; }
  private go(phase: PeekPhase): void { this.phase = phase; this.since = this.t; }

  cancel(reason: PeekCancelReason): void {
    if (this.cancelled || this.phase === 'back' || this.phase === 'settle' || this.phase === 'done') return;
    this.cancelled = reason;
    this.go('back');
  }
  /** 2026-11-23: a large pull took her: "home" is wherever she stands from now on (she is not walked back; the pull walks her). */
  private placeFree = false;
  yieldPlace(): void { this.placeFree = true; }

  next(dt: number, world: DirectorWorld, sense: BodySense | null, body: DirectorBody): { intent: MotionIntent; t: number } {
    this.t += Math.max(0, Math.min(0.1, dt));
    const lens = world.lens, plan = this.plan;
    if (this.placeFree && sense) { this.home = { x: sense.root.x, z: sense.root.z }; this.stand = null; }
    switch (this.phase) {
      case 'notice': {
        // T-246a: a short orienting delay before anything moves, then eyes first.
        if (this.beat < plan.orientDelayS) return { intent: { kind: 'rest' }, t: this.beat };
        if (this.beat >= plan.orientDelayS + plan.noticeS && sense) this.decide(world, sense);
        return { intent: { kind: 'notice', lens }, t: this.beat - plan.orientDelayS };
      }
      case 'walk': {
        const stand = this.stand!;
        const there = !!sense && !sense.moving && Math.hypot(sense.root.x - stand.x, sense.root.z - stand.z) < 0.05;
        // T-246a P04: arrived and steady, a moment before the lean-in.
        if (there) { this.arrivedAt ??= this.t; if (this.t - this.arrivedAt >= plan.arrivePauseS) this.startLean(world, sense!); }
        else if (this.beat > PEEK_BEATS.walkTimeoutS) { this.cancelled = 'timeout'; this.go('back'); }
        return { intent: { kind: 'walk', lens, place: stand, speedMps: plan.walkSpeedMps }, t: this.beat };
      }
      case 'lean': {
        const anticipating = this.beat < plan.prepareS;
        // Progress through the approach, stopping part-way for a moment when she is hesitant.
        let u = (this.beat - plan.prepareS - this.paused) / plan.approachS;
        if (plan.hesitateS > 0 && u >= PEEK_BEATS.hesitateAt && this.paused < plan.hesitateS) { this.paused = Math.min(plan.hesitateS, this.paused + dt); u = PEEK_BEATS.hesitateAt; }
        const k = anticipating ? 0 : S5(u);
        const distance = this.startDistance + (this.boneDistance - this.startDistance) * k;
        const eye = sense ? eyePoint(sense.eyes, this.eye) : null;
        // I-192 follow-up: with both eyes framed, the stare starts only once both are inside the window (or the late bound: she never freezes).
        const framed = this.eye !== 'both' || !sense || (frameWorst(lens, [sense.eyes.left, sense.eyes.right]) ?? 0) <= 1;
        const close = !!eye && k >= 1 && framed && Math.hypot(axisOffset(lens, eye).off, axisOffset(lens, eye).along - this.boneDistance) < PEEK_BEATS.holdWithinM;
        if (close || u > 1 + PEEK_BEATS.holdLateS / plan.approachS) { this.go('hold'); this.nextBlink = 0.4 + this.random() * plan.blinkEveryS; this.nextSaccade = 0.3; }
        return { intent: this.lensIntent(lens, distance, anticipating ? PEEK_BEATS.anticipationRad : this.lean * k, anticipating ? 0 : 1, k, 0), t: this.beat };
      }
      case 'hold': {
        const t = this.beat;
        if (t >= this.nextSaccade) {
          const [a, b] = PEEK_BEATS.saccadeEvery;
          this.saccade = { yaw: (this.random() * 2 - 1) * plan.saccadeRad, pitch: (this.random() * 2 - 1) * plan.saccadeRad * 0.6 };
          this.nextSaccade = t + a + (b - a) * this.random();
        }
        let lid = blinkAt(t - this.nextBlink);
        if (t - this.nextBlink > PEEK_BEATS.blink.reduce((x, y) => x + y, 0)) { this.nextBlink = t + plan.blinkEveryS * (0.7 + 0.6 * this.random()); lid = 0; }
        if (t >= plan.holdS) this.go('back');
        // Drift: a slow wander under the saccades.
        const drift = { yaw: 0.004 * Math.sin(t * 1.3), pitch: 0.003 * Math.sin(t * 0.9 + 1) };
        return { intent: this.lensIntent(lens, this.boneDistance, this.lean, 1, 1, lid, { yaw: this.saccade.yaw + drift.yaw, pitch: this.saccade.pitch + drift.pitch }), t };
      }
      case 'back': {
        const startled = this.cancelled === 'input';
        if (this.beat >= (startled ? PEEK_BEATS.backStartledS : PEEK_BEATS.backS)) this.go('settle');
        // T-246a: the after-smile starts a moment after she begins to back off (a target: its spring eases it in).
        const smile = this.beat >= plan.smileDelayS ? (this.cancelled === 'reply' ? plan.smile * 0.5 : plan.smile) : 0;
        return { intent: { kind: 'back', lens, startled, smile, home: this.home }, t: this.beat };
      }
      case 'settle': {
        const startled = this.cancelled === 'input';
        const home = !!sense && !sense.moving && Math.hypot(sense.root.x - this.home.x, sense.root.z - this.home.z) < 0.05 && body.intentIdle;
        if (home || this.beat > PEEK_BEATS.settleTimeoutS || !sense) this.go('done');
        // The back intent's own clock keeps running (its startle is over, its place is home); the smile's after-glow fades out.
        const glow = this.cancelled === 'reply' ? plan.smile * 0.5 : plan.smile;
        return { intent: { kind: 'back', lens, startled, smile: Math.max(0, glow * (1 - this.beat / plan.afterglowS)), home: this.home }, t: this.beat + 2 };
      }
      case 'done': default:
        return { intent: { kind: 'rest' }, t: this.beat };
    }
  }

  /** End of the notice: which eye, how far to lean, where to stand; walk there if it is more than a few cm. */
  private decide(world: DirectorWorld, sense: BodySense): void {
    const plan = this.plan, lens = world.lens;
    // One eye filling the screen, as decided in I-104; ARRIVAL_KNOBS.peekEyes = 2 (an option, off):
    // both eyes in the frame, the point between them on the axis (I-192 follow-up, Codex T-263).
    this.eye = ARRIVAL_KNOBS.peekEyes >= 2 ? 'both' : chooseEye(lens, sense.root.x, sense.root.z, plan.otherEye);
    if (!sense.frame) { this.cancelled = 'timeout'; this.go('back'); return; } // no eye bones: nothing to bring to the lens
    // How close: so that her eye takes the planned share of the screen's height (the model's own eye size), else the plan's distance;
    // both eyes: and far enough that both fit across the window.
    this.boneDistance = peekDistance(plan, sense.eyeSizeM, lens);
    if (this.eye === 'both') this.boneDistance = Math.max(this.boneDistance, peekBothDistance(sense.frame, sense.eyeSizeM, lens));
    // I-192 ("注意不能穿模摄像头那一块"): never so near that her nose, bangs or hair come into the camera (her own measured face).
    const face = usableFace(sense.face), head = sense.head;
    if (face && head) {
      const e = eyePoint(sense.frame.eyes, this.eye)!, h = toHerFrame({ x: head.x - sense.root.x, y: head.y, z: head.z - sense.root.z }, sense.root.heading);
      this.boneDistance = Math.max(this.boneDistance, eyeClearDistance(face, { x: e.x - h.x, y: e.y - h.y, z: e.z - h.z }));
    }
    const target = onAxis(lens, this.boneDistance);
    this.lean = leanFor(sense.frame, this.eye, target.y, plan.leanRad, sense.tiptoeRise * PEEK_BEATS.tiptoeShare);
    const stand = standFor(sense.frame, this.eye, target, this.lean, facingLens(lens));
    this.stand = { x: stand.x, z: stand.z };
    if (Math.hypot(sense.root.x - stand.x, sense.root.z - stand.z) > PEEK_BEATS.walkFromM) this.go('walk');
    else this.startLean(world, sense);
  }
  private startLean(world: DirectorWorld, sense: BodySense): void {
    const eye = eyePoint(sense.eyes, this.eye);
    this.startDistance = eye ? Math.max(this.boneDistance, axisOffset(world.lens, eye).along) : this.boneDistance + 0.2;
    this.paused = 0;
    this.go('lean');
  }
  private lensIntent(lens: DirectorWorld['lens'], distanceM: number, leanRad: number, loop: number, stare: number, blink: number,
    saccade = { yaw: 0, pitch: 0 }): MotionIntent {
    return { kind: 'lens-eye', lens, eye: this.eye, distanceM, leanRad, tiltRad: this.plan.tiltRad * stare, stare, loop, saccade, blink };
  }
}

export const PEEK_LENS: DirectorAction = {
  id: 'peek-lens',
  begin: (command: Extract<PeekCommand, { type: 'start' }>, world: DirectorWorld) => new PeekLensPerformance(command.id, command.plan as PeekPlan, world),
};

/**
 * Lens to her eye at the closest (m): far enough that her eye (eyeSizeM tall) takes `plan.eyeFill` of the screen's height, between
 * 3.5 and 20 cm; the plan's own distance when the model does not say how big her eyes are.
 */
export function peekDistance(plan: Pick<PeekPlan, 'eyeFill' | 'eyeDistanceM'>, eyeSizeM: number | null, lens: { heightPerM?: number }): number {
  const perM = lens.heightPerM;
  if (!eyeSizeM || !(eyeSizeM > 0) || !perM || !(perM > 0)) return plan.eyeDistanceM;
  return Math.min(0.2, Math.max(0.035, eyeSizeM / (plan.eyeFill * perM)));
}

/**
 * I-192 follow-up: lens to the point between her eyes (m) so both eyes (their centres, plus about an eye's width) fit across the window with
 * ARRIVAL_KNOBS.frameInset to spare. 0 when the window is not known (the one-eye distance stands).
 */
export function peekBothDistance(frame: BodyFrame, eyeSizeM: number | null, lens: Pick<LensView, 'window'>): number {
  const w = lens.window, l = frame.eyes.left, r = frame.eyes.right;
  if (!w || !(w.right > w.left)) return 0;
  const half = Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z) / 2 + 0.6 * (eyeSizeM && eyeSizeM > 0 && eyeSizeM < 0.1 ? eyeSizeM : 0.025);
  return Math.min(0.3, half / ((1 - ARRIVAL_KNOBS.frameInset) * (w.right - w.left) / 2));
}

/** For the host's own clock (the page never runs longer than this either). */
export const PEEK_MAX_S = PEEK_TIMING.maxPeekMs / 1000;
