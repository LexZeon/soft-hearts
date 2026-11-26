/**
 * Unbound U1 part 2: her support, her steps and her weight (docs/claude/2026-11-12-unbound-u1-part2.md). Pure: meters on her
 * floor (x across, z toward the viewer), no Three.js, so it is tested on its own.
 *
 * One owner of contact (Codex c228 §1, §4): this class alone decides which foot supports her, when a foot leaves the floor and
 * where it lands. A planted foot keeps its world point and yaw until this class lifts it; contact.ts turns these decisions into
 * the model's leg-IK targets as the last write before the IK solve.
 *
 * - Her root (the point under her hips) walks: speed is a smooth function of the distance left (a velocity that follows a
 *   braking profile through two springs in a row, so acceleration never jumps), and she turns toward where she is going first
 *   when the way is long, then back toward the viewer when she arrives. Short moves are side or back steps without turning.
 * - Steps are triggered by how far a planted foot has fallen behind its place under her hips (Codex c228 §3: S5 path across,
 *   64·h·u³(1−u)³ lift, both ends at rest); the landing point is predicted from her root's speed so a foot lands ahead of her
 *   hips and is passed, the other foot then falls behind and steps: alternation emerges, and a stop ends with feet together.
 * - Her hips (the pelvis offsets, root-local) sway over the supporting foot while the other swings, dip a little while walking
 *   (so the legs reach), drift slowly from foot to foot while she stands (phase-continuous), and move over one foot before
 *   that foot alone carries her (single stance: the free foot is lifted only once the measured COM is over the support).
 */
import { Spring, BreathOscillator, MOTION_GROUPS, substeps } from './dynamics';
import { convexHull, footPatch, polygonCenter, supportMargin, type FootSize, type Point2 } from './balance';
import { UNBOUND_BODY_DEFAULTS, UNBOUND_BODY_RANGES, type UnboundStance } from '../../shared/unbound/scene';
import { hopAt, planHop, type HopPlan } from './hop';

export type Stance = UnboundStance;
export interface GaitKnobs { speedMps: number; stepLengthM: number; /** I-203: one brisk step (quicker to speed and to stop: a kiss's step in). */ brisk?: boolean }
export const GAIT_KNOB_RANGES = Object.freeze({ speedMps: UNBOUND_BODY_RANGES.walkSpeedMps, stepLengthM: UNBOUND_BODY_RANGES.stepLengthM });
export const DEFAULT_GAIT_KNOBS: GaitKnobs = Object.freeze({ speedMps: UNBOUND_BODY_DEFAULTS.walkSpeedMps, stepLengthM: UNBOUND_BODY_DEFAULTS.stepLengthM });

export interface GaitBody {
  /** Each ankle's place under her, root-local meters (x toward her left, z forward), [left, right]. */
  home: readonly [Point2, Point2];
  /** Ankle height above the floor when the foot is flat (m). */
  ankleHeight: number;
  /** Hip joint to ankle with the leg straight (m), and the hip joint's height above the floor standing (m). */
  legLength: number;
  hipHeight: number;
  foot: FootSize;
  /** From the ankle to the toe's contact point on a flat foot (m): how far forward, and how far down. */
  toe: { forward: number; drop: number };
}
export interface RootState { x: number; z: number; heading: number }
/** 'air': both feet off the floor in a hop (U2 experiment E2), carried with her hips; they land on the places they left. */
export type FootPhase = 'planted' | 'swing' | 'raised' | 'air';
/**
 * U2 experiment E2 (docs/claude/2026-11-14-unbound-night-e2-autonomy.md): a small hop on the spot, both feet. A goal like the
 * others: the gait plays it with gravity (softer than real, so it reads light), and the feet come back to exactly where they left.
 */
export interface HopRequest { id: number; crouchM: number; heightM: number; gravity: number }
export type HopPhase = 'crouch' | 'push' | 'flight' | 'land';
export const HOP_LIMITS = Object.freeze({ crouchM: [0.02, 0.1] as const, heightM: [0.02, 0.15] as const, gravity: [3, 9.81] as const });
/** In the air her feet tuck up by this much of the apex height (knees bend a little), on a bump that is still at both ends. */
const HOP_TUCK = 0.3;
/** Take-off on her toes: this much of the full toe rise (hop.ts plans the path). */
const HOP_TAKEOFF_TOES = 0.85;
export interface FootState {
  phase: FootPhase;
  /**
   * World point under the ankle (m), the ankle's lift above its flat-foot height (m), the foot's yaw (rad, 0 = toward +z) and
   * pitch (rad, + = heel up about the toe: a planted foot behind her hips rolls onto its toes; the toe stays where it was).
   */
  x: number; z: number; lift: number; yaw: number; pitch: number;
}
export type StanceState = 'both' | 'shifting' | 'lifting' | 'holding' | 'lowering';

// ---- tuning (first picks; Codex c228 §7 candidates where it has them) --------------------------------------------------------
/** Farther than this, she turns and walks; nearer, she steps sideways or back without turning (m, with hysteresis below). */
const TRAVEL_START_M = 0.6, TRAVEL_END_M = 0.12;
const SIDE_STEP_MAX_MPS = 0.35;
const BRAKE_MPS2 = 0.6;
/** I-203: a brisk step (GaitKnobs.brisk, only while an action asks): it brakes this hard and its speed follows this spring. Never by default. */
const BRISK_BRAKE_MPS2 = 1.6, BRISK_ARRIVE_GAIN = 4, BRISK_VELOCITY_SPRING = { hz: 2.0, eased: true } as const;
/** Final approach gain (1/s): speed = gain × distance near the goal, so she arrives without a jolt. */
const ARRIVE_GAIN = 2;
const VELOCITY_SPRING = { hz: 1.2, eased: true } as const;
const HEADING_SPRING = { hz: 0.55, eased: true } as const;
const MIN_DOUBLE_SUPPORT_S = 0.05;
const START_STEP_M = 0.02, START_STEP_AFTER_S = 0.5;
/** Her root's speed is predicted this far ahead when braking (the velocity springs' lag), so she stops on the goal, not past it. */
const BRAKE_LOOKAHEAD_S = 0.3;
const SETTLE_ERROR_M = 0.035, SETTLE_YAW = 0.17, MOVING_YAW = 0.3;
/** Fraction of the step length a foot lands ahead of her hips at cruising speed (and falls behind before it steps). */
const LEAD = 0.6;
const STAND_CROUCH_M = 0.006;
const BOB_M = 0.008;
const SWAY = 0.45;
const WEIGHT_SHIFT_M = 0.018, WEIGHT_SHIFT_HZ = 0.075;
const MIN_FOOT_GAP_M = 0.09;
const RAISE_M = 0.07, RAISE_S = 0.5, LOWER_S = 0.45, SHIFT_MIN_S = 0.6, SHIFT_TIMEOUT_S = 2.5;
const SINGLE_MARGIN_M = 0.012;
const COM_GAIN = 1.5, COM_LIMIT_M = 0.05;
/** Heel-off: none until the ankle is this far behind its hip, full pitch (rad) by the second distance. */
const HEEL_FROM_M = 0.06, HEEL_FULL_M = 0.24, HEEL_MAX = 0.45;
/** Heel-off counts only walking forward: her velocity along her facing over max(speed, this) (m/s), 0..1. */
const HEEL_SPEED_MPS = 0.05;
/** A foot that has just landed eases into its heel-off over this long (s), so landing never snaps the ankle. */
const LAND_ROLL_S = 0.15;
/**
 * I-203: a foot that lands while she is up on her toes eases onto them over this long (s). It used to take the whole tiptoe pitch the frame it
 * landed: the ankle jumped up ~4 cm and her hips with it (measured: a kiss whose step in ended on her toes, 4 cm in one frame).
 */
const TOE_LAND_S = 0.4;
/** U2 (peek-lens): up on her toes, both planted feet rolled about their toes by up to this much (rad); her hips rise by the same lift. */
const TIPTOE_MAX = 0.5;
const TIPTOE_SPRING = { hz: 1.0, eased: true } as const;
/** A step's horizontal travel runs between these fractions of the swing (lift first, place last). */
const STEP_LIFT_FIRST = 0.1, STEP_PLACE_FROM = 0.85;

const S5 = (u: number) => u * u * u * (10 + u * (-15 + 6 * u));
const smooth = (a: number, b: number, u: number) => { const t = Math.min(1, Math.max(0, (u - a) / (b - a))); return t * t * (3 - 2 * t); };
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Swing {
  kind: 'step' | 'raise' | 'lower';
  from: { x: number; z: number; yaw: number; lift: number; pitch: number };
  to: { x: number; z: number; yaw: number; lift: number };
  u: number; duration: number; clearance: number;
}

export class Gait {
  private knobs: GaitKnobs = { ...DEFAULT_GAIT_KNOBS };
  private readonly root: { x: number; z: number };
  private readonly vx: Spring; private readonly vz: Spring;
  private readonly heading: Spring;
  private goal: Point2;
  private facingPoint: Point2 | null = null;
  private travel = false;
  private readonly feet: [FootState, FootState];
  /** Each planted foot's flat place (ankle point and yaw): fixed from landing to lift-off. null while it is off the floor. */
  private readonly anchors: [{ x: number; z: number; yaw: number } | null, { x: number; z: number; yaw: number } | null] = [null, null];
  private readonly swings: [Swing | null, Swing | null] = [null, null];
  private lastLanding = -Infinity;
  /** When each foot last landed from a step or a lowering (its heel-off eases in after that). */
  private readonly landedAt: [number, number] = [-Infinity, -Infinity];
  private time = 0;
  private request: Stance = 'both';
  private stanceState: StanceState = 'both';
  private support: 0 | 1 = 0;
  private stateSince = 0;
  private com: Point2 | null = null;
  private readonly correction = { lateral: 0, forward: 0 };
  private readonly pelvisSprings = { lateral: new Spring(MOTION_GROUPS.pelvis), vertical: new Spring(MOTION_GROUPS.pelvis), forward: new Spring(MOTION_GROUPS.pelvis) };
  private readonly standWeight = new Spring({ hz: 0.5 }, 1);
  private readonly walkWeight = new Spring({ hz: 1.5 }, 0);
  private readonly shift = new BreathOscillator(WEIGHT_SHIFT_HZ);
  private shiftValue = 0;
  private steps = 0;
  private readonly tiptoe = new Spring(TIPTOE_SPRING, 0);
  /** U2 E2: a hop in progress (hop.ts plans the path of her hips; the feet leave and land on the same places). */
  private hopState: {
    id: number; plan: HopPlan; t: number; y: number; phase: HopPhase;
    anchors: [{ x: number; z: number; yaw: number } | null, { x: number; z: number; yaw: number } | null] | null;
    takeoff: { x: number; z: number; lift: number; pitch: number; yaw: number }[] | null;
  } | null = null;
  private lastHopId = 0;
  private hopsLanded = 0;

  constructor(private readonly body: GaitBody, start: RootState, feet?: readonly [{ x: number; z: number; yaw?: number }, { x: number; z: number; yaw?: number }]) {
    this.root = { x: start.x, z: start.z };
    this.goal = { x: start.x, z: start.z };
    this.vx = new Spring(VELOCITY_SPRING); this.vz = new Spring(VELOCITY_SPRING);
    this.heading = new Spring(HEADING_SPRING, start.heading);
    const placed = (i: 0 | 1): FootState => {
      const given = feet?.[i];
      const home = this.homeWorld(i, start.x, start.z, start.heading);
      return { phase: 'planted', x: given?.x ?? home.x, z: given?.z ?? home.z, lift: 0, yaw: given?.yaw ?? start.heading, pitch: 0 };
    };
    this.feet = [placed(0), placed(1)];
    this.anchors[0] = { x: this.feet[0].x, z: this.feet[0].z, yaw: this.feet[0].yaw };
    this.anchors[1] = { x: this.feet[1].x, z: this.feet[1].z, yaw: this.feet[1].yaw };
    this.pelvisSprings.vertical.reset(-STAND_CROUCH_M);
  }

  // ---- inputs: targets only ---------------------------------------------------------------------------------------------------
  setGoal(x: number, z: number): void { if (Number.isFinite(x) && Number.isFinite(z)) this.goal = { x, z }; }
  /** Where she turns to when she is not walking somewhere (the viewer's eye on her floor). */
  setFacingPoint(point: Point2 | null): void { this.facingPoint = point && Number.isFinite(point.x) && Number.isFinite(point.z) ? { ...point } : null; }
  /** U2: up on her toes, 0..1 (eased; 0, the default, leaves every foot and the hips exactly as before). */
  setTiptoe(amount: number): void { if (Number.isFinite(amount)) this.toeWant = clamp(amount, 0, 1); } // a fraction of the full lift (linear in height)
  /** What the intent asks of her toes; I-203: she comes down off them while a foot steps (a step on her toes made her hips drop and jump). */
  private toeWant = 0;
  /** How much higher her ankles and hips are on full toes (m). */
  get tiptoeRise(): number { return this.liftAt(TIPTOE_MAX); }
  get tiptoeValue(): number { return this.tiptoe.value; }
  /** How much higher her ankles and hips are on her toes right now (m). */
  get tiptoeLift(): number { return this.tiptoe.value > 0 ? this.tiptoe.value * this.tiptoeRise : 0; }
  /** The roll about the toes (rad) that lifts the ankle by `lift` (m): d·cos p + f·sin p − d = lift. */
  private pitchForLift(lift: number): number {
    const { forward: f, drop: d } = this.body.toe, r = Math.hypot(f, d), phi = Math.atan2(f, d);
    return Math.max(0, phi - Math.acos(Math.min(1, Math.max(-1, (lift + d) / r))));
  }
  setStance(stance: Stance): void { if (stance === 'both' || stance === 'left' || stance === 'right') this.request = stance; }
  /**
   * U2 E2: a small hop on the spot. Starts (true) only when she stands still on both feet; a request whose id was already seen is
   * ignored (the goal is handed every frame). Once started it runs to its landing: nothing cancels a hop in the air.
   */
  hop(request: HopRequest): boolean {
    if (!request || !Number.isFinite(request.id) || request.id === this.lastHopId) return false;
    this.lastHopId = request.id;
    if (this.hopState || this.stanceState !== 'both' || this.swings.some(Boolean) || this.travel || Math.hypot(this.vx.value, this.vz.value) > 0.03) return false;
    const L = HOP_LIMITS, n = (v: number, [lo, hi]: readonly [number, number]) => clamp(Number.isFinite(v) ? v : lo, lo, hi);
    const plan = planHop({ crouchM: n(request.crouchM, L.crouchM), heightM: n(request.heightM, L.heightM), gravity: n(request.gravity, L.gravity) }, HOP_TAKEOFF_TOES * this.tiptoeRise);
    this.hopState = { id: request.id, plan, t: 0, y: 0, phase: 'crouch', anchors: null, takeoff: null };
    return true;
  }
  get hopPhase(): HopPhase | null { return this.hopState?.phase ?? null; }
  /** How far her hips are above (−: below) standing because of the hop (m). */
  get hopLift(): number { return this.hopState?.y ?? 0; }
  get hopPlan(): HopPlan | null { return this.hopState?.plan ?? null; }
  /** Hops she has landed and settled from; the id of the last hop asked for (started or not). */
  get hopsDone(): number { return this.hopsLanded; }
  get lastHopRequest(): number { return this.lastHopId; }
  setKnobs(knobs: Partial<GaitKnobs>): void {
    const [s0, s1] = GAIT_KNOB_RANGES.speedMps, [l0, l1] = GAIT_KNOB_RANGES.stepLengthM;
    if (Number.isFinite(knobs.speedMps)) this.knobs.speedMps = clamp(knobs.speedMps!, s0, s1);
    if (Number.isFinite(knobs.stepLengthM)) this.knobs.stepLengthM = clamp(knobs.stepLengthM!, l0, l1);
    if (typeof knobs.brisk === 'boolean' && knobs.brisk !== (this.knobs.brisk === true)) {
      this.knobs.brisk = knobs.brisk; // value and speed are kept: only how she goes on changes
      const spec = knobs.brisk ? BRISK_VELOCITY_SPRING : VELOCITY_SPRING; this.vx.retune(spec); this.vz.retune(spec);
    }
  }
  /** The measured centre of mass (world floor point) from the last displayed pose, or null when it cannot be measured. */
  setCom(com: Point2 | null): void { this.com = com && Number.isFinite(com.x) && Number.isFinite(com.z) ? { ...com } : null; }

  // ---- outputs -----------------------------------------------------------------------------------------------------------------
  get rootState(): RootState { return { x: this.root.x, z: this.root.z, heading: this.heading.value }; }
  get velocity(): Point2 { return { x: this.vx.value, z: this.vz.value }; }
  /** Where she is walking to now (I-209 step 3: the stage keeps it clear of the others). */
  get goalPoint(): Point2 { return { ...this.goal }; }
  get footStates(): readonly [Readonly<FootState>, Readonly<FootState>] { return this.feet; }
  /** Hip offsets from the root, root-local meters (lateral toward her left, vertical, forward). */
  get pelvis(): { lateral: number; vertical: number; forward: number } {
    return { lateral: this.pelvisSprings.lateral.value, vertical: this.pelvisSprings.vertical.value + this.hopLift, forward: this.pelvisSprings.forward.value };
  }
  /** −1..1: + = her left arm forward (her right foot ahead), scaled by how much she is walking. */
  get armSwing(): number {
    const [l, r] = [0, 1].map(i => this.toLocal(this.feet[i].x, this.feet[i].z).z - this.body.home[i].z);
    return clamp((r - l) / Math.max(0.05, 2 * LEAD * this.knobs.stepLengthM), -1, 1) * this.walkWeight.value;
  }
  /** How far her heading still has to turn (rad, toward where she is going or the viewer). */
  get turnLeft(): number { return wrap(this.headingTarget() - this.heading.value); }
  get stance(): StanceState { return this.stanceState; }
  get walking(): boolean { return this.travel || Math.hypot(this.vx.value, this.vz.value) > 0.03; }
  get moving(): boolean {
    return this.walking || !!this.hopState || this.swings.some(Boolean) || this.heading.moving(1e-3) || Math.hypot(this.goal.x - this.root.x, this.goal.z - this.root.z) > 0.01;
  }
  /**
   * I-203: her feet are busy (travelling, a step or a hop): `moving` without her heading's slow last turn and without the last centimetres of
   * her root easing onto its goal (no foot is lifted for those).
   */
  get stepping(): boolean { return this.travel || !!this.hopState || this.swings.some(Boolean); }
  get stepCount(): number { return this.steps; }
  /** The support region now (convex hull of the patches of feet in contact). */
  supportRegion(): Point2[] {
    const patches = this.anchors.flatMap(a => a ? footPatch(a, a.yaw, this.body.foot) : []);
    return patches.length ? convexHull(patches) : [];
  }
  /** Signed COM margin over the support region (m), or null without a measured COM. */
  comMargin(): number | null { return this.com && this.hopState?.phase !== 'flight' ? supportMargin(this.com, this.supportRegion()) : null; }

  // ---- the clock ---------------------------------------------------------------------------------------------------------------
  step(delta: number): void {
    const { count, h } = substeps(delta);
    for (let i = 0; i < count; i++) this.substep(h);
  }

  private substep(h: number): void {
    this.time += h;
    this.updateStance();
    this.updateRoot(h);
    this.advanceFeet(h);
    this.advanceHop(h);
    this.rollPlantedFeet();
    this.maybeStep();
    this.updatePelvis(h);
  }
  private liftAt(pitch: number): number { const { forward: f, drop: d } = this.body.toe; return d * Math.cos(pitch) + f * Math.sin(pitch) - d; }

  private headingTarget(): number {
    const dx = this.goal.x - this.root.x, dz = this.goal.z - this.root.z;
    if (this.travel && Math.hypot(dx, dz) > 1e-6) return Math.atan2(dx, dz);
    if (this.facingPoint) return Math.atan2(this.facingPoint.x - this.root.x, this.facingPoint.z - this.root.z);
    return this.heading.target;
  }

  private updateRoot(h: number): void {
    const dx = this.goal.x - this.root.x, dz = this.goal.z - this.root.z, distance = Math.hypot(dx, dz);
    const bothDown = this.stanceState === 'both' && !this.hopState; // a hop holds her on the spot until she has landed
    if (!this.travel && distance > TRAVEL_START_M && bothDown) this.travel = true;
    else if (this.travel && distance < TRAVEL_END_M) this.travel = false;
    const current = this.heading.value, error = wrap(this.headingTarget() - current);
    this.heading.target = current + error; // the nearest way round
    let cap = this.travel ? this.knobs.speedMps * Math.max(0, Math.cos(error)) ** 2 : Math.min(this.knobs.speedMps, SIDE_STEP_MAX_MPS);
    if (!bothDown) cap = 0; // a foot is off the floor for a single stance: put it down before going anywhere
    const ahead = Math.max(0, distance - Math.hypot(this.vx.value, this.vz.value) * BRAKE_LOOKAHEAD_S);
    const speed = distance < 1e-5 ? 0 : Math.min(cap, Math.sqrt(2 * (this.knobs.brisk ? BRISK_BRAKE_MPS2 : BRAKE_MPS2) * ahead), (this.knobs.brisk ? BRISK_ARRIVE_GAIN : ARRIVE_GAIN) * Math.max(ahead, distance * 0.25));
    this.vx.target = distance < 1e-5 ? 0 : dx / distance * speed;
    this.vz.target = distance < 1e-5 ? 0 : dz / distance * speed;
    this.vx.advance(h); this.vz.advance(h);
    this.tiptoe.target = this.swings.some(s => s?.kind === 'step') || this.travel ? 0 : this.toeWant;
    if (this.tiptoe.target !== 0 || this.tiptoe.value !== 0) this.tiptoe.advance(h);
    this.root.x += this.vx.value * h; this.root.z += this.vz.value * h;
    this.heading.advance(h);
    const walkingNow = Math.hypot(this.vx.value, this.vz.value);
    this.walkWeight.target = clamp(walkingNow / 0.25, 0, 1);
    this.walkWeight.advance(h);
    const restful = !this.travel && walkingNow < 0.03 && !this.swings.some(Boolean) && this.stanceState === 'both' && this.time - this.lastLanding > 0.8;
    this.standWeight.target = restful ? 1 : 0;
    this.standWeight.advance(h);
    this.shiftValue = this.shift.step(h);
  }

  private advanceFeet(h: number): void {
    for (const i of [0, 1] as const) {
      const swing = this.swings[i];
      if (!swing) continue;
      swing.u = Math.min(1, swing.u + h / swing.duration);
      if (swing.kind === 'step') {
        // The landing point follows her root's prediction early in the swing and is settled smoothly by 70% (no late correction).
        const follow = 1 - smooth(0.4, 0.7, swing.u);
        if (follow > 0) {
          const next = this.landing(i, (1 - swing.u) * swing.duration);
          swing.to.x += (next.x - swing.to.x) * follow; swing.to.z += (next.z - swing.to.z) * follow;
          swing.to.yaw += wrap(next.yaw - swing.to.yaw) * follow;
        }
      }
      const s = S5(swing.u), foot = this.feet[i];
      // A step lifts the foot before it travels and finishes travelling before it is put down (lift, carry, place): the toe
      // leaves and meets the floor straight up and down, never skimming it. Each part is an S5, so the path stays C².
      const across = swing.kind === 'step' ? S5(clamp((swing.u - STEP_LIFT_FIRST) / (STEP_PLACE_FROM - STEP_LIFT_FIRST), 0, 1)) : s;
      foot.x = swing.from.x + (swing.to.x - swing.from.x) * across;
      foot.z = swing.from.z + (swing.to.z - swing.from.z) * across;
      foot.yaw = swing.from.yaw + wrap(swing.to.yaw - swing.from.yaw) * across;
      // A step leaves from wherever the foot was (heel up or not) and lands flat; the lift's bump has zero speed at both ends.
      foot.lift = swing.from.lift + (swing.to.lift - swing.from.lift) * s
        + (swing.kind === 'step' ? 64 * swing.clearance * swing.u ** 3 * (1 - swing.u) ** 3 : 0);
      foot.pitch = swing.from.pitch * (1 - s);
      if (swing.u >= 1) {
        this.swings[i] = null;
        if (swing.kind === 'raise') { foot.phase = 'raised'; this.enter('holding'); }
        else {
          foot.phase = 'planted'; foot.lift = 0; foot.pitch = 0; this.lastLanding = this.time; this.landedAt[i] = this.time;
          this.anchors[i] = { x: foot.x, z: foot.z, yaw: foot.yaw };
          if (swing.kind === 'lower') this.enter('both');
        }
      }
    }
  }

  /** Where foot `i` should land if it lands `remaining` seconds from now. */
  private landing(i: 0 | 1, remaining: number): { x: number; z: number; yaw: number } {
    const vx = this.vx.value, vz = this.vz.value;
    const px = this.root.x + vx * remaining, pz = this.root.z + vz * remaining;
    const turn = wrap(this.heading.target - this.heading.value);
    const ahead = this.heading.velocity.v * remaining;
    const yaw = this.heading.value + (Math.sign(ahead) === Math.sign(turn) ? Math.sign(turn) * Math.min(Math.abs(ahead), Math.abs(turn)) : 0);
    const lead = LEAD * this.knobs.stepLengthM / Math.max(0.3, this.knobs.speedMps);
    const home = this.homeWorld(i, px, pz, yaw);
    let x = home.x + vx * lead, z = home.z + vz * lead;
    // Within reach of that hip at landing, and never across the other foot.
    const reach = this.reach(), hip = this.homeWorld(i, px, pz, yaw, 0);
    const ox = x - hip.x, oz = z - hip.z, out = Math.hypot(ox, oz);
    if (out > reach) { x = hip.x + ox / out * reach; z = hip.z + oz / out * reach; }
    const other = this.feet[1 - i], side = i === 0 ? 1 : -1;
    const left = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const lateral = (x - other.x) * left.x + (z - other.z) * left.z;
    if (side * lateral < MIN_FOOT_GAP_M) { const push = MIN_FOOT_GAP_M - side * lateral; x += left.x * push * side; z += left.z * push * side; }
    return { x, z, yaw };
  }

  /** How far from the point under her hips a foot can be placed at the walking crouch (m). */
  private reach(): number {
    const drop = this.body.hipHeight - this.body.ankleHeight - this.walkCrouch();
    return Math.sqrt(Math.max(0.01, (0.985 * this.body.legLength) ** 2 - drop * drop));
  }
  private walkCrouch(): number {
    const L = this.body.legLength, reachNeeded = (LEAD + 0.05) * this.knobs.stepLengthM;
    const height = this.body.hipHeight - this.body.ankleHeight;
    return Math.max(STAND_CROUCH_M, height - Math.sqrt(Math.max(0, (0.985 * L) ** 2 - reachNeeded * reachNeeded)));
  }

  private maybeStep(): void {
    if (this.hopState || this.stanceState !== 'both' || this.swings.some(Boolean) || this.time - this.lastLanding < MIN_DOUBLE_SUPPORT_S) return;
    const vx = this.vx.value, vz = this.vz.value, speed = Math.hypot(vx, vz);
    const moving = this.travel || speed > 0.03 || Math.abs(this.heading.velocity.v) > 0.05;
    const heading = this.heading.value;
    // Starting off: the first step goes as soon as she starts to move (gait initiation), not once her hips are far ahead.
    const fresh = this.time - this.lastLanding > START_STEP_AFTER_S;
    const threshold = !moving ? SETTLE_ERROR_M : fresh ? START_STEP_M : Math.max(0.05, LEAD * this.knobs.stepLengthM * clamp(speed / this.knobs.speedMps, 0, 1));
    const yawThreshold = moving ? MOVING_YAW : SETTLE_YAW;
    const scored = ([0, 1] as const).map(i => {
      const foot = this.anchors[i] ?? this.feet[i], home = this.homeWorld(i, this.root.x, this.root.z, heading);
      const ex = foot.x - home.x, ez = foot.z - home.z, error = Math.hypot(ex, ez);
      let score: number;
      if (moving && speed > 0.03) {
        const ux = vx / speed, uz = vz / speed, behind = -(ex * ux + ez * uz), across = Math.abs(ex * uz - ez * ux);
        score = (Math.max(0, behind) + across) / threshold;
      } else score = error / threshold;
      const yawError = Math.abs(wrap(foot.yaw - heading));
      score = Math.max(score, yawError / yawThreshold);
      if (error > this.reach() * 0.9) score = Math.max(score, 3); // out of comfortable reach: step now
      return { i, score, error, yawError, foot };
    }).sort((a, b) => b.score - a.score);
    if (scored[0].score <= 1) return;
    const duration = moving ? clamp(0.8 * this.knobs.stepLengthM / this.knobs.speedMps, 0.25, 0.55) : 0.4;
    const clearance = moving ? clamp(0.22 * this.knobs.stepLengthM, 0.03, 0.07) : 0.035;
    // A step that the other foot blocks (it may not cross over) gets nowhere: then the other foot goes first, the way a side
    // step leads with the foot on the side she is going to. A step that would move the foot by almost nothing is not taken.
    const gain = (c: typeof scored[number]) => {
      const t = this.landing(c.i, duration);
      return { t, moved: Math.hypot(t.x - c.foot.x, t.z - c.foot.z), turned: Math.abs(wrap(t.yaw - c.foot.yaw)) };
    };
    let pick = scored[0], plan = gain(pick);
    if (plan.moved < 0.4 * pick.error && scored[1].score > 0.5) {
      const other = gain(scored[1]);
      if (other.moved > plan.moved) { pick = scored[1]; plan = other; }
    }
    if (plan.moved < 0.01 && plan.turned < 0.05) return;
    const best = pick.i, foot = this.feet[best], target = plan.t;
    this.lift(best);
    this.swings[best] = { kind: 'step', from: { x: foot.x, z: foot.z, yaw: foot.yaw, lift: foot.lift, pitch: foot.pitch }, to: { ...target, lift: 0 }, u: 0, duration, clearance };
    this.steps++;
  }

  private lift(i: 0 | 1): void { this.feet[i].phase = 'swing'; this.anchors[i] = null; }

  /**
   * U2 E2: the hop's clock. Take-off: both feet leave from where they are (rolled onto their toes) and the places they left are
   * kept; in the air they ride with her hips (plus a small tuck that is still at both ends); touch-down puts them back on exactly
   * those places, so a hop never moves a foot along the floor. The rest of the landing is her hips coming down and back up.
   */
  private advanceHop(h: number): void {
    const hop = this.hopState;
    if (!hop) return;
    hop.t += h;
    const s = hopAt(hop.plan, hop.t);
    if (s.phase === 'flight' && hop.phase !== 'flight') {
      hop.anchors = [this.anchors[0], this.anchors[1]];
      hop.takeoff = this.feet.map(f => ({ x: f.x, z: f.z, lift: f.lift, pitch: f.pitch, yaw: f.yaw }));
      for (const i of [0, 1] as const) { this.anchors[i] = null; this.feet[i].phase = 'air'; }
    } else if (s.phase !== 'flight' && hop.phase === 'flight' && hop.anchors) {
      for (const i of [0, 1] as const) { this.anchors[i] = hop.anchors[i]; this.feet[i].phase = 'planted'; }
      this.lastLanding = this.time;
    }
    hop.phase = s.phase === 'done' ? 'land' : s.phase;
    hop.y = s.y;
    if (s.phase === 'flight' && hop.takeoff) {
      const tuck = HOP_TUCK * hop.plan.heightM * 64 * s.flightU ** 3 * (1 - s.flightU) ** 3;
      hop.takeoff.forEach((t, i) => Object.assign(this.feet[i], { x: t.x, z: t.z, pitch: t.pitch, yaw: t.yaw, lift: t.lift + (s.y - hop.plan.takeoffY) + tuck }));
    }
    if (s.phase === 'done') { this.hopState = null; this.hopsLanded++; }
  }

  /**
   * Heel-off: a planted foot that her hips have passed rolls onto its toes (Codex c228 §4: "抬跟阶段只有前掌接触"), so the
   * trailing leg keeps its reach instead of her hips having to drop. The toe point stays exactly where it was; the pitch is a
   * smooth function of how far behind the hip the foot is (and of how much she is walking), so it never jumps.
   */
  private rollPlantedFeet(): void {
    const heading = this.heading.value, fx = Math.sin(heading), fz = Math.cos(heading);
    const { forward: f, drop: d } = this.body.toe;
    // Lapwing showcase round 8: heel-off belongs to walking forward. A step back (facing the viewer, moving away) lands its foot
    // behind her hips — the foot leading the way, not one her hips have passed — and the rule used to roll it onto its toes the
    // instant it touched down: the ankle jumped ~20° in one frame. Now the roll scales with how much she is moving forward (her
    // velocity along her facing; it is smooth, so this never jumps), and a foot that has just landed eases into any roll it has.
    const speed = Math.hypot(this.vx.value, this.vz.value);
    const forwardness = clamp((this.vx.value * fx + this.vz.value * fz) / Math.max(speed, HEEL_SPEED_MPS), 0, 1);
    // U2 E2: in a hop's push and landing, with her hips above standing, her ankles rise with them (onto her toes).
    const hopPitch = this.hopState && this.hopState.phase !== 'flight' && this.hopState.y > 0 ? this.pitchForLift(this.hopState.y) : 0;
    for (const i of [0, 1] as const) {
      const anchor = this.anchors[i], foot = this.feet[i];
      if (!anchor || foot.phase !== 'planted') continue;
      const hip = this.homeWorld(i, this.root.x, this.root.z, heading, 0);
      const behind = -((anchor.x - hip.x) * fx + (anchor.z - hip.z) * fz);
      const landed = smooth(0, LAND_ROLL_S, this.time - this.landedAt[i]);
      const heel = HEEL_MAX * smooth(HEEL_FROM_M, HEEL_FULL_M, behind) * this.walkWeight.value * forwardness * landed;
      const toes = this.tiptoe.value > 0 ? this.pitchForLift(this.tiptoeLift) * smooth(0, TOE_LAND_S, this.time - this.landedAt[i]) : 0;
      const pitch = Math.max(heel, toes, hopPitch);
      // Rotating the foot about its toe by `pitch`: the ankle rises and comes forward along the foot's own direction.
      const along = f - (f * Math.cos(pitch) - d * Math.sin(pitch));
      const ax = Math.sin(anchor.yaw), az = Math.cos(anchor.yaw);
      foot.x = anchor.x + ax * along; foot.z = anchor.z + az * along;
      foot.lift = d * Math.cos(pitch) + f * Math.sin(pitch) - d;
      foot.pitch = pitch; foot.yaw = anchor.yaw;
    }
  }

  private enter(state: StanceState): void { this.stanceState = state; this.stateSince = this.time; }

  private updateStance(): void {
    if (this.hopState) return; // both feet, until the hop has landed
    const wantsTravel = Math.hypot(this.goal.x - this.root.x, this.goal.z - this.root.z) > 0.03;
    const want: Stance = wantsTravel ? 'both' : this.request;
    const age = this.time - this.stateSince;
    switch (this.stanceState) {
      case 'both':
        if (want !== 'both' && !this.swings.some(Boolean) && !this.travel && Math.hypot(this.vx.value, this.vz.value) < 0.02) {
          this.support = want === 'left' ? 0 : 1;
          this.correction.lateral = this.correction.forward = 0;
          this.enter('shifting');
        }
        break;
      case 'shifting': {
        if (want === 'both' || (want === 'left' ? 0 : 1) !== this.support) { this.enter('both'); break; }
        const margin = this.singleMargin();
        const ready = margin !== null ? margin >= SINGLE_MARGIN_M && Math.abs(this.pelvisSprings.lateral.velocity.v) < 0.03
          : !this.pelvisSprings.lateral.moving(2e-3);
        if (age >= SHIFT_MIN_S && (ready || age > SHIFT_TIMEOUT_S)) this.raise();
        break;
      }
      case 'holding':
        if (want !== (this.support === 0 ? 'left' : 'right')) this.lower();
        break;
      default: break; // lifting / lowering finish in advanceFeet
    }
  }

  /** COM margin over the support foot alone (m), or null without a measured COM. */
  private singleMargin(): number | null {
    if (!this.com) return null;
    const foot = this.anchors[this.support] ?? this.feet[this.support];
    return supportMargin(this.com, convexHull(footPatch(foot, foot.yaw, this.body.foot)));
  }

  private raise(): void {
    const free = (1 - this.support) as 0 | 1, foot = this.feet[free], heading = this.heading.value;
    const toward = this.homeWorld(free, this.root.x, this.root.z, heading);
    const support = this.feet[this.support];
    // A little in toward the support foot and forward: the raised foot hangs under her, not out to the side.
    const inX = (support.x - toward.x) * 0.15 + Math.sin(heading) * 0.03, inZ = (support.z - toward.z) * 0.15 + Math.cos(heading) * 0.03;
    this.lift(free);
    this.swings[free] = { kind: 'raise', from: { x: foot.x, z: foot.z, yaw: foot.yaw, lift: foot.lift, pitch: foot.pitch }, to: { x: toward.x + inX, z: toward.z + inZ, yaw: heading, lift: RAISE_M }, u: 0, duration: RAISE_S, clearance: 0 };
    this.enter('lifting');
  }

  private lower(): void {
    const free = (1 - this.support) as 0 | 1, foot = this.feet[free], heading = this.heading.value;
    const home = this.homeWorld(free, this.root.x, this.root.z, heading);
    this.lift(free);
    this.swings[free] = { kind: 'lower', from: { x: foot.x, z: foot.z, yaw: foot.yaw, lift: foot.lift, pitch: foot.pitch }, to: { x: home.x, z: home.z, yaw: heading, lift: 0 }, u: 0, duration: LOWER_S, clearance: 0 };
    this.enter('lowering');
  }

  private updatePelvis(h: number): void {
    const local = [0, 1].map(i => this.toLocal(this.feet[i].x, this.feet[i].z)) as [Point2, Point2];
    const homeForward = (this.body.home[0].z + this.body.home[1].z) / 2;
    const mid = { x: (local[0].x + local[1].x) / 2, z: (local[0].z + local[1].z) / 2 - homeForward };
    const walk = this.walkWeight.value, crouch = STAND_CROUCH_M + (this.walkCrouch() - STAND_CROUCH_M) * walk;
    let lateral = mid.x, vertical = -crouch - BOB_M * 0.5 * walk, forward = 0;
    // Her weight stays over the support foot until the other foot is down again (then the hips come back between her feet).
    const single = this.stanceState === 'shifting' || this.stanceState === 'lifting' || this.stanceState === 'holding' || this.stanceState === 'lowering';
    if (single) {
      const s = local[this.support];
      // Over the support foot, corrected by the measured COM (slowly; bounded).
      if (this.com) {
        const comLocal = this.toLocal(this.com.x, this.com.z), foot = this.anchors[this.support] ?? this.feet[this.support];
        const center = this.toLocal(...centerOf(foot, this.body.foot));
        this.correction.lateral = clamp(this.correction.lateral + COM_GAIN * (center.x - comLocal.x) * h, -COM_LIMIT_M, COM_LIMIT_M);
        this.correction.forward = clamp(this.correction.forward + COM_GAIN * (center.z - comLocal.z) * h, -COM_LIMIT_M, COM_LIMIT_M);
      }
      lateral = s.x * 0.92 + this.correction.lateral;
      forward = this.correction.forward;
      vertical = -STAND_CROUCH_M - 0.012;
      if (this.stanceState === 'holding') {
        const margin = this.singleMargin() ?? SINGLE_MARGIN_M;
        lateral += Math.min(0.006, Math.max(0, margin) * 0.3) * this.shiftValue;
      }
    } else {
      const swinging = ([0, 1] as const).find(i => this.swings[i]?.kind === 'step');
      if (swinging !== undefined) {
        const u = this.swings[swinging]!.u, support = local[1 - swinging];
        lateral = mid.x + (support.x - mid.x) * SWAY * Math.sin(Math.PI * u);
        vertical += BOB_M * Math.sin(Math.PI * u) * walk;
      }
      lateral += WEIGHT_SHIFT_M * this.shiftValue * this.standWeight.value;
      this.correction.lateral *= 1 - Math.min(1, h * 2); this.correction.forward *= 1 - Math.min(1, h * 2);
    }
    const p = this.pelvisSprings;
    if (this.tiptoe.value > 0) vertical += this.tiptoeLift; // on her toes: the hips rise with the ankles
    p.lateral.target = lateral; p.vertical.target = vertical; p.forward.target = forward;
    p.lateral.advance(h); p.vertical.advance(h); p.forward.advance(h);
  }

  // ---- frames ------------------------------------------------------------------------------------------------------------------
  /** Foot i's home in the world for a root at (x, z) facing `heading`; `forward` overrides the home's forward offset (0: the hip). */
  private homeWorld(i: 0 | 1, x: number, z: number, heading: number, forward = this.body.home[i].z): Point2 {
    const across = this.body.home[i].x;
    return { x: x + across * Math.cos(heading) + forward * Math.sin(heading), z: z - across * Math.sin(heading) + forward * Math.cos(heading) };
  }
  /** World floor point → root-local (x toward her left, z forward). */
  private toLocal(x: number, z: number): Point2 {
    const dx = x - this.root.x, dz = z - this.root.z, c = Math.cos(this.heading.value), s = Math.sin(this.heading.value);
    return { x: dx * c - dz * s, z: dx * s + dz * c };
  }
}

/** The middle of a foot's patch (world). */
function centerOf(foot: { x: number; z: number; yaw: number }, size: FootSize): [number, number] {
  const c = polygonCenter(footPatch(foot, foot.yaw, size));
  return [c.x, c.z];
}
