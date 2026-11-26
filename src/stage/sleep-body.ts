/**
 * I-078 第 1 步 (docs/claude/2026-11-11-i078-sleep-step1.md): her falling asleep and sleeping, as one stage layer.
 *
 * What she does, from the fatigue phase (shared/mood/fatigue.ts; A/F and her hormones set the timing, no fixed clock):
 *  - light-drowsy / drowsy: now and then a small action — a small yawn (the P1 yawn, offered as her own local cue), rubbing an
 *    eye (arm reach solved on her own skeleton), or nodding off and catching herself. Gaps are log-normal, never the same
 *    action twice in a row (shared/behaviors/sleep-body/schedule.ts).
 *  - falling-asleep: after a short delay she kneels down (seiza), the pillow or desk fades in, then she lies down on the
 *    pillow or leans onto the desk — whichever fits the user's camera (sleep-framing.ts; the camera is never touched).
 *  - asleep: no mouse gaze (fatigue view), closed eyes (the eyelid compositor, unchanged), slow breathing in the chest and
 *    shoulders, rare small movements (nuzzle the pillow, shift a hand, a sigh, curl up, settle the head) and a rare silent
 *    "zzz…" bubble. micro-awake: the head lifts a little; back to the same pose after.
 *  - waking: the reverse — up from the pose through seiza to standing — then a stretch (the P1 stretch, her own cue).
 * Neither camera fits a pose with the head well in frame → no body pose: the seated doze if that fits, else the standing doze
 * (I-024's head-only sleep pose, unchanged).
 *
 * Motion rules (R29, how-we-work「做事方式」2): one progress coordinate p (0 standing, 1 seiza, 2 the pose) moved by
 * minimum-jerk segments that start from the current position, speed and acceleration, so any phase change or interruption
 * turns around smoothly; the pose along p is C¹ in p (rounded corner at the waypoint). A new plan (camera moved, other pose)
 * cross-fades, also by minimum jerk; a different pose first goes back to the seiza region. Higher owners (a picked motion or
 * pose, music, previews, the game) take the body by the layer's own weight, which fades out and back. Every bone write goes
 * through the stage's program layer (remembered, restored next frame); grant children (付与) follow by delta.
 * Nothing here touches PMX/VMD bytes, the camera, or any host state.
 */
import { Quaternion, Vector3, type Bone, type Camera, type Object3D, type SkinnedMesh } from 'three';
import { MinJerk } from '../initiative';
import { sampleKeys } from '../mood';
import type { StrayBox } from './stray-pixels';
import { buildSleepRig, forward, posedPoint, REQUIRED_SLOTS, type PlacedPose, type SleepKind, type SleepRig } from './sleep-postures';
import { readPoseReactionView } from '../../shared/mood';
import type { CollisionProxy } from '../../shared/actions';
import type { MoodView } from '../../shared/mood';
import type { StandardBone } from '../../shared/actions';
import { candidateKey, sleepCandidates, type FrameView, type SleepCandidate } from './sleep-framing';
import { SleepProps } from './sleep-props';
import { SLEEP_BODY_KNOBS } from '../../shared/behaviors/sleep-body/knobs';
import { asleepGap, asleepWeights, breathRate, drowsyGap, drowsyWeights, habitSize, hugShare, moveSeconds, murmurGap, NEUTRAL_HORMONES, normalizedHormones, pickVariant, posePreferences, settleTimes, sleepHabitScale } from '../../shared/behaviors/sleep-body/schedule';
import type { AsleepMove, DrowsyAction, Hormones, Rng } from '../../shared/behaviors/sleep-body/schedule';
import { DEFAULT_FATIGUE_PARAMETERS } from '../../shared/mood';

export interface SleepBodyInput {
  owner: SkinnedMesh | null;
  rig: SleepRig | null;
  /** The fatigue phase (null: no fatigue view). */
  phase: string | null;
  A: number;
  F: number;
  hormones?: Hormones;
  /** The layer may show (能做睡姿 on, expressions on, posture > 0). */
  allowed: boolean;
  /** A higher owner holds her body this frame (picked motion or pose, music, a preview, the game). */
  yielding: boolean;
  /** Nobody is busy with her (no typing, speech, touch, chat gesture, reaction): a drowsy small action may start. */
  free: boolean;
  view: FrameView | null;
  /** Camera and window signature: a change re-checks the pose choice. */
  viewKey: string;
  /** Where the props go (the stage's scene). */
  scene: Object3D | null;
  /** I-078 第 2 步: her short wakefulness W (0..1, the fatigue view): how far a micro-wake has gone toward waking. Absent: 0. */
  W?: number;
  /** I-078 第 2 步: the user's hand is on her head or cheek now (a pat or a pinch, the stage's local contact). */
  touched?: boolean;
  /** I-078 第 3 步: the card's 睡相 as −1 calm … 0 middle … 1 restless (sleepHabitScale). Absent: the middle (step 1 exactly). */
  habit?: number;
}
export interface SleepBodyPort { remember(bone: Bone): void }
export interface SleepCue { id: string; kind: 'yawn' | 'stretch'; at: number }
export interface SleepMurmur { id: string; text: string }

export const SLEEP_BODY_MOTION = Object.freeze({
  /** Rounded corner of the path at the seiza waypoint (progress units). */
  corner: 0.35,
  /** Getting up passes the seiza waypoint this far (progress) before heading for standing. */
  waypointPass: 0.18,
  /** Where a pose change routes back to before the new plan cross-fades in (progress). */
  routeTo: 0.6,
  /** Plan cross-fade seconds. */
  crossfade: 1.6,
  /** Yield weight: out (a higher owner arrived) and back in, seconds. */
  yieldOut: 1.4, yieldIn: 2,
  /** How often (s) the pose choice is re-checked while engaged and nothing changed. */
  recheckS: 3,
  /** Micro-awake head lift (rad: neck, head; negative lifts) and its seconds. */
  liftNeck: -0.09, liftHead: -0.06, liftSeconds: 0.9,
  /** Ground-contact table step (progress units). */
  tableStep: 0.05,
});

/** ∫₀ᵘ smoothstep: the corner's shape (its slope eases from 0 to 1 with zero curvature change at both ends: C²). */
const cornerShape = (u: number) => u * u * u - u * u * u * u / 2;
/** C² ramp 0..1 over p 0..1 with the corner at 1 rounded over ±r (weight toward the seiza waypoint). */
export function towardWaypoint(p: number, r = SLEEP_BODY_MOTION.corner): number {
  if (p <= 0) return 0;
  if (p < 1 - r) return p;
  if (p > 1 + r) return 1;
  return p - 2 * r * cornerShape((p - (1 - r)) / (2 * r));
}
/** C² ramp 0..1 over p 1..2 with the corner at 1 rounded over ±r (weight toward the final pose). */
export function towardPose(p: number, r = SLEEP_BODY_MOTION.corner): number {
  const x = p - 1;
  if (x <= -r) return 0;
  if (x >= 1) return 1;
  if (x < r) return 2 * r * cornerShape((x + r) / (2 * r));
  return x;
}

interface Plan {
  candidate: SleepCandidate;
  /** Bone index → [waypoint, final] local rotation (center included). */
  rot: Map<number, [Quaternion, Quaternion]>;
  wpOffset: Vector3;
  finalOffset: Vector3;
  /** Extra center height (model units) per progress step, so the lowest body point stays on the floor in between. */
  ground: Float32Array;
}

/** [seconds, value] keys (monotone cubic Hermite, zero speed at the ends and at extremes). */
type Keys = [number, number][];
type Action = { kind: DrowsyAction | AsleepMove | 'lift'; t: number; duration: number; side: 1 | -1; amount: number; keys?: Keys; env?: Keys };

/**
 * The drowsy actions' timelines in seconds, varied per play. Sizes keep the peak angular acceleration under the R29 bound
 * (about 540°/s², the 0.15° unexpected step at 60 fps): a big swing (the forearm up to the eye, ~150°) needs ≥ 1.3 s.
 */
export function drowsyTimeline(kind: DrowsyAction, rng: Rng): { duration: number; keys: Keys; env?: Keys } {
  if (kind === 'nod') {
    // Nodding off: a slow droop (ease in), a beat, catching herself (a quick lift past upright), settling back.
    const droop = 2.2 + rng() * 1.2, hold = 0.25 + rng() * 0.4, catchUp = 0.8 + rng() * 0.15, settle = 0.9 + rng() * 0.3;
    const a = droop * 0.55, b = droop, c = b + hold, d = c + catchUp, e = d + settle;
    return { duration: e + 0.2, keys: [[0, 0], [a, 0.42], [b, 1], [c, 1], [d, -0.08], [e, 0], [e + 0.2, 0]] };
  }
  // Rub: raise the hand to the eye, rub in small circles, lower it.
  const raise = 1.6 + rng() * 0.3, rub = 1.4 + rng() * 0.8, lower = 1.6 + rng() * 0.3, total = raise + rub + lower;
  return { duration: total, keys: [[0, 0], [raise, 1], [raise + rub, 1], [total, 0]],
    env: [[0, 0], [raise - 0.25, 0], [raise + 0.45, 1], [raise + rub - 0.45, 1], [raise + rub + 0.25, 0], [total, 0]] };
}

const sleepish = (phase: string | null) => phase === 'asleep' || phase === 'micro-awake';
const drowsyPhase = (phase: string | null) => phase === 'light-drowsy' || phase === 'drowsy';
const finite = (v: number, fallback = 0) => Number.isFinite(v) ? v : fallback;

export class SleepBody {
  private owner: SkinnedMesh | null = null;
  private rig: SleepRig | null = null;
  private props: SleepProps | null = null;
  private plan: Plan | null = null;
  private fromPlan: Plan | null = null;
  private readonly fade = MinJerk.at(1);
  private pendingCandidate: SleepCandidate | null = null;
  private routing = false;
  private readonly p = MinJerk.at(0);
  private pTarget = 0;
  private readonly yieldW = MinJerk.at(0);
  private yieldGoal = 0;
  private readonly lift = MinJerk.at(0);
  private phase: string | null = null;
  private phaseAge = 0;
  private settle = { sitDelay: 3, sitDwell: 3 };
  private wasAsleep = false;
  private waking = false;
  private stretchIn = -1;
  private rubAfterWake = -1;
  private viewKey = '';
  private recheck = 0;
  private cooldown = 0;
  private betterFor = 0;
  private lastKind: SleepKind | null = null;
  private choice: SleepCandidate | null = null;
  private noFit = false;
  private drowsyIn = -1;
  private asleepIn = -1;
  private murmurIn = -1;
  private lastDrowsy: DrowsyAction | null = null;
  private lastAsleep: AsleepMove | null = null;
  private lastWord: string | null = null;
  private action: Action | null = null;
  /**
   * Persistent small offsets of the resting pose (a shifted hand, a curl, a settled head), each eased in. I-078 第 3 步 (a restless
   * 睡相 only): half turned over, the pillow hugged tighter, an arm out.
   */
  private readonly rest = { hand: MinJerk.at(0), curl: MinJerk.at(0), head: MinJerk.at(0), turn: MinJerk.at(0), hug: MinJerk.at(0), armOut: MinJerk.at(0) };
  private handSide: 1 | -1 = 1;
  private turnSide: 1 | -1 = 1;
  private armSide: 1 | -1 = -1;
  /** I-078 第 2 步: the touch overlay (a nuzzle into the pillow, the head turning on the arms), its cooldown, the last hum. */
  private stir: { t: number; duration: number; side: 1 | -1; kind: 'nuzzle' | 'turn' | 'nod' } | null = null;
  private stirCooldown = 0;
  private wasTouched = false;
  private lastBubbleAt = -Infinity;
  private lastHum: string | null = null;
  /** The highest W of this micro-wake (the head lifts by it: steps on events only) and W when she last left sleep. */
  private microPeak = 0;
  private lastW = 0;
  private woken = false;
  /** This frame's 睡相 (−1..1) and its size factor. */
  private habit = 0;
  private size = 1;
  private breathPhase = 0;
  private breathRateNow = 0.3;
  private cues: SleepCue[] = [];
  private murmurs: SleepMurmur[] = [];
  private serial = 0;
  private counts = { drowsy: 0, asleep: 0, murmur: 0, switches: 0, replans: 0 };
  /** Recent gaps and variants (diagnostics and tests: the "less mechanical" numbers). */
  readonly history: { at: number; kind: string; gap: number }[] = [];
  private clock = 0;
  private readonly scratch = { q: new Quaternion(), q2: new Quaternion(), q3: new Quaternion(), v: new Vector3(), before: new Map<number, Quaternion>() };

  constructor(private readonly rng: Rng = Math.random) {}

  /** Drop everything at once (model change, character change, hidden): props removed, upright, timers cleared. */
  reset(): void {
    this.props?.dispose(); this.props = null;
    this.plan = this.fromPlan = this.choice = this.pendingCandidate = null; this.routing = false;
    this.p.snap(0); this.pTarget = 0; this.yieldW.snap(0); this.yieldGoal = 0; this.lift.snap(0); this.fade.snap(1);
    this.phase = null; this.phaseAge = 0; this.wasAsleep = this.waking = false; this.stretchIn = this.rubAfterWake = -1;
    this.viewKey = ''; this.recheck = 0; this.betterFor = 0; this.noFit = false;
    this.drowsyIn = this.asleepIn = this.murmurIn = -1; this.action = null;
    for (const m of Object.values(this.rest)) m.snap(0);
    this.cues = []; this.murmurs = [];
    this.stir = null; this.stirCooldown = 0; this.wasTouched = false; this.microPeak = 0; this.lastW = 0; this.woken = false;
  }

  /**
   * P1 舞台少画 (stage-pace.ts): something of her sleep pose is easing right now (going down or up, a crossfade, a stir, an
   * action, a resting-pose shift, the micro-awake lift). While it does, the stage draws at full pace.
   */
  get moving(): boolean {
    if (this.stir || this.action || this.p.moving || this.yieldW.moving || this.lift.moving || this.fade.moving) return true;
    for (const value of Object.values(this.rest)) if (value.moving) return true;
    return false;
  }
  /** The body pose is (partly) shown or the props are: higher layers that would fight it (chat gestures) wait. */
  get engaged(): boolean { return this.p.x * this.yieldW.x > 0.02 || (this.props?.state.pillow ?? 0) > 0.01 || (this.props?.state.desk ?? 0) > 0.01; }
  /** Her own pose-reaction cues (yawn, stretch), taken once by the stage. */
  takeCue(): SleepCue | null { return this.cues.shift() ?? null; }
  private liveCue: SleepCue | null = null;
  /**
   * The pose-reaction view with her own cue over the host's (as 哈欠捂嘴's yawn is offered): held for a second so the reaction
   * takes it on its first free frame (once per id); null when she has none.
   */
  poseCueView(base: unknown, nowMs: number): unknown | null {
    if (this.liveCue && nowMs - this.liveCue.at > 1_000) this.liveCue = null;
    if (!this.liveCue) { const next = this.takeCue(); if (next) this.liveCue = { ...next, at: nowMs }; }
    if (!this.liveCue) return null;
    const real = readPoseReactionView(base);
    return { attention: real?.attention ?? 0, boost: real?.boost ?? 1, cue: { id: this.liveCue.id, kind: this.liveCue.kind, source: 'own', at: this.liveCue.at, strength: 1 } };
  }
  takeMurmur(): SleepMurmur | null { return this.murmurs.shift() ?? null; }
  /** Props' world corners while shown (the stray-pixel sentinel's reach). */
  propCorners(): { x: number; y: number; z: number }[] { return this.props?.corners() ?? []; }

  getState() {
    return { phase: this.phase, progress: +this.p.x.toFixed(3), target: this.pTarget, weight: +this.yieldW.x.toFixed(3), choice: candidateKey(this.choice),
      fits: this.choice ? +this.choice.fit.margin.toFixed(3) : null, noFit: this.noFit, routing: this.routing, crossfade: +this.fade.x.toFixed(3),
      action: this.action?.kind ?? null, props: this.props?.state ?? null, counts: { ...this.counts },
      stir: this.stir?.kind ?? null, lift: +this.lift.x.toFixed(3), habit: this.habit };
  }

  frame(delta: number, input: SleepBodyInput, port: SleepBodyPort): void {
    if (input.owner !== this.owner) { this.reset(); this.owner = input.owner; this.rig = null; }
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    this.clock += dt;
    if (!input.owner) return;
    if (input.rig !== this.rig) { this.props?.dispose(); this.props = null; this.plan = this.fromPlan = this.choice = null; this.rig = input.rig; }
    const rig = this.rig, h = input.hormones ?? NEUTRAL_HORMONES;
    this.lastW = Math.min(1, Math.max(0, finite(input.W ?? 0)));
    this.habit = Math.min(1, Math.max(-1, finite(input.habit ?? 0))); this.size = habitSize(this.habit);
    if (input.phase !== this.phase) this.enterPhase(input.phase, h);
    this.phaseAge += dt;
    const bodyOk = !!rig && REQUIRED_SLOTS.every(slot => rig.slot[slot] >= 0);

    // ---- the pose choice (camera aware), only while she is going down, down, or coming up
    const wantsDown = input.phase === 'falling-asleep' || sleepish(input.phase);
    if (rig && input.view && (wantsDown || this.p.x > 0.01)) this.choose(rig, input, h, dt, bodyOk);

    // ---- progress target from the phase
    let target = 0;
    if (this.choice && !this.noFit) {
      if (input.phase === 'falling-asleep') {
        const t = this.phaseAge, sit = moveSeconds('sit', h);
        target = t < this.settle.sitDelay ? 0 : t < this.settle.sitDelay + sit + this.settle.sitDwell ? 1 : 2;
        if (this.choice.kind === 'sit') target = t < this.settle.sitDelay ? 0 : 2;
      } else if (sleepish(input.phase)) target = 2;
    }
    if (this.routing) target = Math.min(target, SLEEP_BODY_MOTION.routeTo);
    // Getting up: first up to seiza, then to standing (the second segment starts before the first ends, so she does not stop;
    // passing the waypoint slowly keeps the turn from one move to the next soft).
    if (target < 1 && this.p.x > 1 + SLEEP_BODY_MOTION.waypointPass) target = 1;
    else if (target > 1 && this.p.x < 1 - SLEEP_BODY_MOTION.waypointPass) target = 1;
    this.setTarget(target, h);
    this.p.step(dt);
    if (this.routing && this.p.x <= SLEEP_BODY_MOTION.routeTo + 0.05 && this.pendingCandidate && rig) {
      this.adopt(rig, this.pendingCandidate); this.pendingCandidate = null; this.routing = false;
    }
    this.fade.step(dt);
    if (this.fade.x >= 1 && this.fromPlan) this.fromPlan = null;

    // ---- yield to higher owners (and to "not allowed")
    const goal = input.allowed && !input.yielding ? 1 : 0;
    if (goal !== this.yieldGoal) { this.yieldGoal = goal; this.yieldW.to(goal, goal ? SLEEP_BODY_MOTION.yieldIn : SLEEP_BODY_MOTION.yieldOut); }
    this.yieldW.step(dt);
    // I-078 第 2 步: half awake, the head lifts by how awake she is (the highest W of this micro-wake: it only steps up on a new
    // touch or message, never follows W's fade frame by frame); a plain touch lifts it as step 1 did, a message a little more.
    this.microPeak = input.phase === 'micro-awake' ? Math.max(this.microPeak, this.lastW) : 0;
    const woke = Math.min(1, this.microPeak / DEFAULT_FATIGUE_PARAMETERS.enoughWakeW);
    const liftGoal = input.phase === 'micro-awake' ? 1 + SLEEP_BODY_KNOBS.touch.liftMore * Math.max(0, woke - 0.3) / 0.7 : 0;
    if (Math.abs(liftGoal - this.lift.goal) > 1e-6) this.lift.to(liftGoal, SLEEP_BODY_MOTION.liftSeconds);
    this.lift.step(dt);
    for (const m of Object.values(this.rest)) m.step(dt);

    // ---- I-078 第 2 步: touched in her sleep (a new pat or pinch): a short overlay on the same pose, sometimes a tiny hum
    const touched = input.touched === true;
    this.stirCooldown -= dt;
    if (this.stir && (this.stir.t += dt) >= this.stir.duration) this.stir = null;
    if (touched && !this.wasTouched && sleepish(input.phase) && this.p.x > 1.5 && this.stirCooldown <= 0 && !this.stir) this.startStir();
    this.wasTouched = touched;

    // ---- waking: once up, a stretch (her own P1 stretch), sometimes an eye rub after it (more often when woken before she slept enough)
    if (this.waking && this.p.x < 0.12 && this.stretchIn < 0 && this.pTarget === 0) this.stretchIn = SLEEP_BODY_KNOBS.settle.stretchAfterS;
    if (this.stretchIn >= 0) {
      this.stretchIn -= dt;
      if (this.stretchIn < 0) {
        this.waking = false; this.cue('stretch');
        this.rubAfterWake = this.rng() < (this.woken ? SLEEP_BODY_KNOBS.touch.rubAfterWoken : 0.5) ? 6 + this.rng() * 4 : -1;
      }
    }
    if (this.rubAfterWake >= 0) { this.rubAfterWake -= dt; if (this.rubAfterWake < 0 && input.free && this.p.x < 0.05) this.start('rub', 1); }

    // ---- small actions: drowsy (standing), asleep (in the pose), murmurs
    this.schedule(input, h, dt);

    // ---- write
    const weight = this.yieldW.x;
    if (rig && (this.plan || this.fromPlan) && weight > 1e-4 && this.p.x > 1e-5) this.writePose(rig, port, weight, input.A, h, dt);
    else this.breathPhase = (this.breathPhase + dt * 0.25) % 1;
    if (rig && this.action) this.writeAction(rig, port, dt, weight);
    this.frameProps(input, dt);
  }

  // ------------------------------------------------------------------ phases and choice

  private enterPhase(phase: string | null, h: Hormones): void {
    const was = this.phase;
    this.phase = phase; this.phaseAge = 0;
    if (phase === 'falling-asleep') this.settle = settleTimes(h, this.rng);
    if (sleepish(phase)) this.wasAsleep = true;
    // Leaving sleep for good (awake, light-drowsy, drowsy): the reverse, then a stretch.
    if (!sleepish(phase) && phase !== 'falling-asleep' && (sleepish(was) || was === 'falling-asleep') && this.p.x > 0.3) {
      this.waking = this.wasAsleep; this.wasAsleep = false; this.stretchIn = -1;
      // I-078 第 2 步: woken by the user (her own waking leaves W near 0; a "醒醒" or touches and messages adding up leave it high).
      this.woken = this.lastW > 0.1;
    }
    if (!drowsyPhase(phase)) this.drowsyIn = -1;
    if (!sleepish(phase)) { this.asleepIn = -1; this.murmurIn = -1; }
  }

  private choose(rig: SleepRig, input: SleepBodyInput, h: Hormones, dt: number, bodyOk: boolean): void {
    const knobs = SLEEP_BODY_KNOBS.framing;
    const changed = input.viewKey !== this.viewKey;
    this.recheck -= dt; this.cooldown -= dt;
    if (!changed && this.choice && this.recheck > 0) return;
    if (this.choice && this.cooldown > 0) return; // a camera drag or window resize: at most twice a second
    this.cooldown = 0.5;
    this.viewKey = input.viewKey; this.recheck = SLEEP_BODY_MOTION.recheckS;
    const prefer = posePreferences(h, this.lastKind);
    const candidates = sleepCandidates({ rig, view: input.view!, prefer: bodyOk ? prefer : { sit: prefer.sit }, hug: hugShare(h) });
    const best = candidates.find(c => c.fits) ?? null;
    if (!this.choice) {
      // First choice of this sleep: never mid-pose (p is 0 here unless a model change interrupted).
      this.noFit = !best;
      if (best) { this.adopt(rig, best); this.lastKind = best.kind; }
      return;
    }
    const same = candidates.find(c => candidateKey(c) === candidateKey(this.choice));
    const stillFits = !!same && same.fits;
    if (!best) { this.noFit = true; return; } // nothing fits now: the progress target falls to 0 (she gets up to the standing doze)
    this.noFit = false;
    if (stillFits && same) {
      // Same pose: only re-slide when the head got close to the edge (hysteresis: a tiny camera move changes nothing).
      if (changed && same.fit.margin < knobs.headMargin * 1.5 && Math.abs(same.slide - this.choice.slide) > rig.height * 0.01) { this.adopt(rig, same); this.counts.replans++; }
      const better = best !== same && best.score > same.score + knobs.switchBetter;
      this.betterFor = better ? this.betterFor + Math.max(dt, changed ? 0 : SLEEP_BODY_MOTION.recheckS) : 0;
      if (!better || this.betterFor < knobs.switchAfterS) return;
    }
    // Another pose: go back to the seiza region first, then cross-fade the new plan in.
    this.betterFor = 0;
    if (candidateKey(best) === candidateKey(this.choice)) { this.adopt(rig, best); return; }
    this.counts.switches++;
    if (this.p.x <= SLEEP_BODY_MOTION.routeTo + 0.05) { this.adopt(rig, best); this.lastKind = best.kind; return; }
    this.pendingCandidate = best; this.routing = true; this.lastKind = best.kind;
  }

  /** Make `candidate` the plan; the previous plan cross-fades out. */
  private adopt(rig: SleepRig, candidate: SleepCandidate): void {
    const plan = buildPlan(rig, candidate);
    if (this.plan) { this.fromPlan = this.blendedSnapshot(); this.fade.snap(0); this.fade.to(1, SLEEP_BODY_MOTION.crossfade); }
    this.plan = plan; this.choice = candidate;
    this.props?.place({ pillow: candidate.placed.pillow, desk: candidate.placed.desk });
  }
  /** The plan as currently shown (mid cross-fade included), frozen, so a second change also starts from what is seen. */
  private blendedSnapshot(): Plan {
    const to = this.plan!, from = this.fromPlan, m = this.fade.x;
    if (!from || m >= 1) return to;
    const rot = new Map<number, [Quaternion, Quaternion]>();
    for (const [i, [w, f]] of to.rot) {
      const old = from.rot.get(i);
      rot.set(i, old ? [old[0].clone().slerp(w, m), old[1].clone().slerp(f, m)] : [w.clone(), f.clone()]);
    }
    const ground = to.ground.map((g, k) => (from.ground[k] ?? g) + (g - (from.ground[k] ?? g)) * m);
    return { candidate: to.candidate, rot, wpOffset: from.wpOffset.clone().lerp(to.wpOffset, m), finalOffset: from.finalOffset.clone().lerp(to.finalOffset, m), ground };
  }

  private setTarget(target: number, h: Hormones): void {
    if (target === this.pTarget) return;
    const rising = target < this.p.x;
    this.pTarget = target;
    const distance = Math.abs(target - this.p.x);
    const per = rising ? moveSeconds('rise', h) / 2 : target > 1.2 ? moveSeconds('lie', h) : moveSeconds('sit', h);
    this.p.to(target, Math.max(0.8, per * Math.min(2, Math.max(0.35, distance)) * (rising ? 1 : 1)));
  }

  // ------------------------------------------------------------------ small actions

  private schedule(input: SleepBodyInput, h: Hormones, dt: number): void {
    const phase = input.phase;
    if (this.action) return;
    if (drowsyPhase(phase) && this.p.x < 0.05 && !this.waking) {
      if (this.drowsyIn < 0) this.drowsyIn = this.gap('drowsy-gap', drowsyGap(phase!, input.F, h, this.rng));
      this.drowsyIn -= dt;
      if (this.drowsyIn <= 0) {
        if (!input.free || !input.allowed) { this.drowsyIn = 3 + this.rng() * 5; return; } // she is busy: a little later
        const kind = pickVariant(drowsyWeights(h), this.lastDrowsy, this.rng);
        this.drowsyIn = -1;
        if (!kind) return;
        this.lastDrowsy = kind; this.counts.drowsy++; this.history.push({ at: this.clock, kind, gap: 0 });
        if (kind === 'yawn') this.cue('yawn'); else this.start(kind, this.rng() < 0.5 ? 1 : -1);
      }
      return;
    }
    if (sleepish(phase) && this.p.x > 1.9 && this.pTarget === 2) {
      if (this.asleepIn < 0) this.asleepIn = this.gap('asleep-gap', asleepGap(input.A, h, this.rng, SLEEP_BODY_KNOBS, this.habit));
      if (this.murmurIn < 0) this.murmurIn = SLEEP_BODY_KNOBS.murmur.firstAfterS + this.gap('murmur-gap', murmurGap(this.rng)) * 0.5;
      this.asleepIn -= dt; this.murmurIn -= dt;
      if (this.asleepIn <= 0 && phase === 'asleep') {
        this.asleepIn = -1;
        const kind = pickVariant(asleepWeights(h, this.habit), this.lastAsleep, this.rng);
        if (kind) { this.lastAsleep = kind; this.counts.asleep++; this.history.push({ at: this.clock, kind, gap: 0 }); this.startAsleep(kind); }
      }
      if (this.murmurIn <= 0) {
        this.murmurIn = this.gap('murmur-gap', murmurGap(this.rng));
        if (phase === 'asleep' && input.free) {
          const words = SLEEP_BODY_KNOBS.murmur.words.filter(w => w !== this.lastWord);
          const text = words[Math.floor(this.rng() * words.length)] ?? 'zzz…';
          this.lastWord = text; this.counts.murmur++; this.lastBubbleAt = this.clock;
          this.murmurs.push({ id: `sleep-murmur-${++this.serial}`, text });
          this.history.push({ at: this.clock, kind: 'murmur', gap: 0 });
        }
      }
    }
  }
  private gap(kind: string, seconds: number): number { this.history.push({ at: this.clock, kind, gap: seconds }); if (this.history.length > 400) this.history.splice(0, 100); return seconds; }
  private cue(kind: 'yawn' | 'stretch'): void { this.cues.push({ id: `sleep-${kind}-${++this.serial}`, kind, at: Date.now() }); if (this.cues.length > 4) this.cues.shift(); }
  private start(kind: DrowsyAction, side: 1 | -1): void {
    if (this.action) return; // one at a time: a running one is never cut (it would jump)
    const timeline = drowsyTimeline(kind === 'yawn' ? 'nod' : kind, this.rng);
    this.action = { kind, t: 0, duration: timeline.duration, keys: timeline.keys, env: timeline.env, side, amount: kind === 'nod' ? 0.75 + this.rng() * 0.3 : 1 };
  }
  private startAsleep(kind: AsleepMove): void {
    const r = this.rng();
    // A side changes only while that offset is at rest (going out from 0): switching it while shown would move the other arm at once.
    switch (kind) {
      case 'hand': if (this.rest.hand.goal <= 0.5) this.handSide = this.handSide === 1 ? -1 : 1; this.rest.hand.to(this.rest.hand.goal > 0.5 ? 0 : 1, 1.6 + r); return;
      case 'curl': this.rest.curl.to(this.rest.curl.goal > 0.5 ? 0 : 1, 2.2 + r); return;
      case 'settle-head': this.rest.head.to((r * 2 - 1), 1.4 + this.rng()); return;
      // I-078 第 3 步 (a restless 睡相): half turning over, slow; hugging the pillow tighter; an arm out from under her.
      case 'turn': if (this.rest.turn.goal <= 0.5) this.turnSide = this.turnSide === 1 ? -1 : 1; this.rest.turn.to(this.rest.turn.goal > 0.5 ? 0 : 1, 3.4 + 1.2 * r); return;
      case 'hug': this.rest.hug.to(this.rest.hug.goal > 0.5 ? 0 : 1, 2.0 + r); return;
      case 'arm-out': if (this.rest.armOut.goal <= 0.5) this.armSide = this.armSide === 1 ? -1 : 1; this.rest.armOut.to(this.rest.armOut.goal > 0.5 ? 0 : 1, 2.4 + r); return;
      default: if (this.action) return; this.action = { kind, t: 0, duration: kind === 'nuzzle' ? 2.6 + r : 4.5 + r, side: this.rng() < 0.5 ? 1 : -1, amount: 0.8 + this.rng() * 0.4 };
    }
  }
  /**
   * I-078 第 2 步: a new touch in her sleep. Lying: she nuzzles into the pillow; at the desk: her head turns a little on her arms and
   * back; the seated doze: a small nod. Then the same pose again (an envelope from 0 back to 0, on top of the plan). Sometimes, never
   * often, a tiny silent hum in the bubble ("嗯…"), not right after another bubble.
   */
  private startStir(): void {
    const kind = this.plan?.candidate.kind === 'desk' ? 'turn' : this.plan?.candidate.kind === 'lie' ? 'nuzzle' : 'nod';
    const r = this.rng();
    this.stir = { t: 0, duration: kind === 'turn' ? 2.6 + 0.6 * r : 2.2 + 0.6 * r, side: this.rng() < 0.5 ? 1 : -1, kind };
    this.stirCooldown = SLEEP_BODY_KNOBS.touch.refractoryS;
    this.history.push({ at: this.clock, kind: `stir-${kind}`, gap: 0 });
    const t = SLEEP_BODY_KNOBS.touch;
    if (this.rng() < t.humChance && this.clock - this.lastBubbleAt >= t.humMinGapS) {
      const words = t.humWords.filter(w => w !== this.lastHum);
      const text = words[Math.floor(this.rng() * words.length)] ?? '嗯…';
      this.lastHum = text; this.lastBubbleAt = this.clock;
      this.murmurs.push({ id: `sleep-hum-${++this.serial}`, text });
      this.history.push({ at: this.clock, kind: 'hum', gap: 0 });
    }
  }

  // ------------------------------------------------------------------ writing

  private writePose(rig: SleepRig, port: SleepBodyPort, weight: number, A: number, h: Hormones, dt: number): void {
    const p = this.p.x, a = towardWaypoint(p), c = towardPose(p), m = this.fromPlan ? this.fade.x : 1;
    const to = this.plan!, from = this.fromPlan ?? to;
    const { q, q2, q3, before } = this.scratch;
    before.clear();
    for (const [i, [w1, f1]] of to.rot) {
      const bone = rig.bones[i].bone, old = from.rot.get(i);
      // waypoint and final of the shown plan (cross-fade), then the path: base → waypoint (a) → final (c), then the layer weight.
      q.copy(old ? old[0] : w1).slerp(w1, m);
      q2.copy(old ? old[1] : f1).slerp(f1, m);
      q3.copy(bone.quaternion).slerp(q, a).slerp(q2, c);
      port.remember(bone);
      before.set(i, bone.quaternion.clone());
      bone.quaternion.slerp(q3, weight);
    }
    // Center: the planned offsets along the path, plus the ground table (lowest point on the floor in between).
    const center = rig.bones[rig.slot.center].bone, v = this.scratch.v;
    const wp = from.wpOffset.clone().lerp(to.wpOffset, m), fin = from.finalOffset.clone().lerp(to.finalOffset, m);
    v.set(0, 0, 0).lerp(wp, a).lerp(fin, c);
    v.y += groundAt(from.ground, p) + (groundAt(to.ground, p) - groundAt(from.ground, p)) * m;
    port.remember(center);
    center.position.addScaledVector(v, weight);

    // Breathing in the pose: chest and shoulders, slower and deeper than awake; a sigh takes one big breath.
    const down = Math.max(a * 0.5, c), asleep = sleepish(this.phase) ? 1 : 0;
    const rate = asleep ? breathRate(A, h) : 0.3;
    this.breathRateNow += (rate - this.breathRateNow) * Math.min(1, dt * 0.5);
    this.breathPhase = (this.breathPhase + dt * this.breathRateNow) % 1;
    const sigh = this.action?.kind === 'sigh' ? sampleKeys([[0, 0], [0.3, 0.6], [0.5, 1], [0.75, 0.3], [1, 0]], this.action.t / this.action.duration) : 0;
    const breath = (Math.sin(this.breathPhase * Math.PI * 2) * (1 - sigh * 0.6) + sigh * 2.2) * SLEEP_BODY_KNOBS.asleep.breathDepth * down * weight;
    this.turn(rig, port, 'upperBody2', breath, 0, 0, before);
    this.turn(rig, port, 'shoulderLeft', 0, 0, breath * 0.7, before);
    this.turn(rig, port, 'shoulderRight', 0, 0, -breath * 0.7, before);

    // Resting-pose variety (asleep): a shifted hand, a curl, a settled head; and the micro-awake head lift. I-078 第 3 步: sized by
    // her 睡相 (exactly step 1 in the middle), plus (restless only) half turned over, the pillow hugged tighter (more with O), an arm out.
    const settled = c * weight;
    if (settled > 1e-4) {
      const s = this.size, hand = this.rest.hand.x * settled * s, curl = this.rest.curl.x * settled * s, head = this.rest.head.x * settled * s, lift = this.lift.x * settled;
      const side = this.handSide === 1 ? 'Left' : 'Right';
      this.turn(rig, port, `arm${side}`, 0.10 * hand, 0.08 * hand * this.handSide, 0, before);
      this.turn(rig, port, `elbow${side}`, 0, -0.18 * hand * this.handSide, 0, before);
      this.turn(rig, port, 'legLeft', -0.12 * curl, 0, 0, before); this.turn(rig, port, 'legRight', -0.08 * curl, 0, 0, before);
      this.turn(rig, port, 'kneeLeft', 0.16 * curl, 0, 0, before); this.turn(rig, port, 'kneeRight', 0.12 * curl, 0, 0, before);
      this.turn(rig, port, 'head', 0.035 * head, 0.03 * head, 0.03 * head, before);
      const turned = this.rest.turn.x * settled * s * this.turnSide, hug = this.rest.hug.x * settled * s * (1 + 0.5 * Math.max(0, h.O)), out = this.rest.armOut.x * settled * s;
      if (turned) {
        this.turn(rig, port, 'lowerBody', 0, 0.03 * turned, 0.05 * turned, before);
        this.turn(rig, port, 'upperBody', 0, 0.03 * turned, 0.04 * turned, before);
        this.turn(rig, port, turned > 0 ? 'kneeLeft' : 'kneeRight', 0.12 * Math.abs(turned), 0, 0, before);
        this.turn(rig, port, 'head', 0, -0.03 * turned, -0.05 * turned, before); // the head keeps its place on the pillow
      }
      if (hug) for (const [slot, sgn] of [['Left', 1], ['Right', -1]] as const) {
        this.turn(rig, port, `arm${slot}`, 0.05 * hug, 0.07 * hug * sgn, 0, before);
        this.turn(rig, port, `elbow${slot}`, 0, -0.12 * hug * sgn, 0, before);
      }
      if (out) {
        const slot = this.armSide === 1 ? 'Left' : 'Right';
        this.turn(rig, port, `arm${slot}`, -0.10 * out, -0.14 * out * this.armSide, 0, before);
        this.turn(rig, port, `elbow${slot}`, 0, 0.16 * out * this.armSide, 0, before);
      }
      // I-078 第 2 步: touched in her sleep, an overlay on the same pose that ends where it began.
      const stir = this.stir;
      if (stir) {
        const u = stir.t / stir.duration, k = settled;
        if (stir.kind === 'turn') {
          const e = sampleKeys([[0, 0], [0.4, 1], [0.72, 1], [1, 0]], u) * k * stir.side;
          this.turn(rig, port, 'neck', 0, 0.05 * e, 0, before);
          this.turn(rig, port, 'head', 0, 0.13 * e, 0.03 * e, before);
        } else {
          const env = sampleKeys([[0, 0], [0.3, 1], [0.7, 1], [1, 0]], u) * k, wiggle = Math.sin(u * Math.PI * 3) * env;
          if (stir.kind === 'nuzzle') {
            this.turn(rig, port, 'head', 0.03 * env, 0.07 * wiggle, 0.03 * wiggle * stir.side, before);
            this.turn(rig, port, 'neck', 0.02 * env, 0.02 * wiggle, 0, before);
          } else this.turn(rig, port, 'head', 0.04 * env, 0.03 * wiggle, 0, before);
        }
      }
      this.turn(rig, port, 'neck', SLEEP_BODY_MOTION.liftNeck * lift, 0, 0, before);
      this.turn(rig, port, 'head', SLEEP_BODY_MOTION.liftHead * lift, 0, 0, before);
    }
    this.followGrants(rig, port, before);
  }

  /** A local rotation (x pitch, y yaw, z roll; radians) after what is there, through the program layer. */
  private turn(rig: SleepRig, port: SleepBodyPort, slot: string, x: number, y: number, z: number, before?: Map<number, Quaternion>): void {
    const i = rig.slot[slot as keyof typeof rig.slot];
    if (i === undefined || i < 0 || (!x && !y && !z)) return;
    const bone = rig.bones[i].bone;
    port.remember(bone);
    if (before && !before.has(i)) before.set(i, bone.quaternion.clone());
    const q = this.scratch.q.setFromAxisAngle(AXIS_Y, y).multiply(this.scratch.q2.setFromAxisAngle(AXIS_X, x)).multiply(this.scratch.q3.setFromAxisAngle(AXIS_Z, z));
    bone.quaternion.multiply(q);
  }

  /** Grant children (付与) follow what this layer wrote, by delta: child ← child · g(before)⁻¹ · g(after). */
  private followGrants(rig: SleepRig, port: SleepBodyPort, before: Map<number, Quaternion>): void {
    for (const grant of rig.grants) {
      const old = before.get(grant.parent);
      if (!old) continue;
      const parent = rig.bones[grant.parent].bone, child = rig.bones[grant.child].bone;
      port.remember(child);
      if (!before.has(grant.child)) before.set(grant.child, child.quaternion.clone());
      const undo = this.scratch.q2.identity().slerp(old, grant.ratio).invert(), now = this.scratch.q3.identity().slerp(parent.quaternion, grant.ratio);
      child.quaternion.multiply(undo).multiply(now);
    }
  }

  /** Drowsy actions (standing) and asleep transients, on top of whatever is there. */
  private writeAction(rig: SleepRig, port: SleepBodyPort, dt: number, weight: number): void {
    const action = this.action!;
    action.t += dt;
    const u = Math.min(1, action.t / action.duration);
    const before = new Map<number, Quaternion>();
    // Drowsy actions belong to the standing body; asleep ones to the pose. A phase change mid-action lets it end on its own curve.
    switch (action.kind) {
      case 'nod': {
        // Nodding off (slow droop), a beat, then catching herself (quick lift with a little overshoot), settle.
        const k = sampleKeys(action.keys ?? [], action.t) * action.amount * weight; // a higher owner arriving takes it away with the layer weight
        this.turn(rig, port, 'neck', 0.11 * k, 0, 0.02 * k * action.side, before);
        this.turn(rig, port, 'head', 0.15 * k, 0, 0.035 * k * action.side, before);
        break;
      }
      case 'rub': this.rubEye(rig, port, weight, action, before); break;
      case 'nuzzle': {
        const env = sampleKeys([[0, 0], [0.25, 1], [0.75, 1], [1, 0]], u) * action.amount * this.p.x / 2 * weight;
        const wiggle = Math.sin(u * Math.PI * 4) * env;
        this.turn(rig, port, 'head', 0.02 * env, 0.06 * wiggle, 0.03 * wiggle * action.side, before);
        this.turn(rig, port, 'neck', 0.015 * env, 0.02 * wiggle, 0, before);
        break;
      }
      default: break; // 'sigh' is the breath (writePose)
    }
    this.followGrants(rig, port, before);
    if (action.t >= action.duration) this.action = null;
  }

  /** Rub one eye: the hand reaches in front of the eye (two-bone reach on her own arm), rubs in small circles, goes back down. */
  private rubEye(rig: SleepRig, port: SleepBodyPort, weight: number, action: Action, before: Map<number, Quaternion>): void {
    const side = action.side === 1 ? 'Left' : 'Right';
    const arm = rig.slot[`arm${side}`], elbow = rig.slot[`elbow${side}`], wrist = rig.slot[`wrist${side}`], head = rig.slot.head;
    if (arm < 0 || elbow < 0 || wrist < 0 || head < 0) return;
    const w = sampleKeys(action.keys ?? [], action.t) * weight;
    if (w <= 1e-4) return;
    const armBone = rig.bones[arm].bone, elbowBone = rig.bones[elbow].bone, headBone = rig.bones[head].bone;
    armBone.parent?.updateWorldMatrix(true, false); headBone.updateWorldMatrix(true, false);
    const shoulder = armBone.getWorldPosition(new Vector3());
    const l1 = rig.bones[elbow].rest.distanceTo(rig.bones[arm].rest), l2 = rig.bones[wrist].rest.distanceTo(rig.bones[elbow].rest);
    // The eye on this side, in front of the face by about a hand's thickness, circling a little while she rubs.
    const headQ = headBone.getWorldQuaternion(new Quaternion()), headP = headBone.getWorldPosition(new Vector3());
    const hc = rig.capsules.find(c => c.segment === 'head'), r = hc?.radius ?? rig.height * 0.05;
    // The circles fade in and out with zero speed at both ends (no start at full speed).
    const env = sampleKeys(action.env ?? [], action.t), keys = action.env ?? [[0, 0], [1, 0]];
    const from = keys[1]?.[0] ?? 0, to = keys[keys.length - 2]?.[0] ?? 1;
    const angle = Math.min(1, Math.max(0, (action.t - from) / Math.max(0.1, to - from))) * Math.PI * 2 * 1.6; // slow, small circles (sleepy rubbing)
    const eye = new Vector3(0.32 * r * action.side + (Math.cos(angle) - 1) * 0.09 * r * env, r * 0.55 + Math.sin(angle) * 0.07 * r * env, r * 1.55).applyQuaternion(headQ).add(headP);
    // The wrist goes a hand-length short of the eye (the fingers reach it).
    const handLen = rig.capsules.find(c => c.segment === `hand${side}`) ? r * 0.9 : r * 0.7;
    const toEye = eye.clone().sub(shoulder), dist = toEye.length();
    const reach = Math.min(l1 + l2 - 1e-3, Math.max(Math.abs(l1 - l2) + 1e-3, dist - handLen));
    const dir = toEye.normalize();
    // Elbow points down and out (pole), so the forearm comes up in front of the chest.
    const pole = new Vector3(action.side * 0.6, -1, -0.2).applyQuaternion(rig.bones[rig.slot.upperBody].bone.getWorldQuaternion(new Quaternion()));
    const side2 = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const cos = (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach), sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const elbowAt = shoulder.clone().addScaledVector(dir, l1 * cos).addScaledVector(side2, l1 * sin);
    const wristAt = shoulder.clone().addScaledVector(dir, reach);
    // World directions → local rotations (from the arm's own rest directions; the current parent rotations undone).
    const parentQ = armBone.parent!.getWorldQuaternion(new Quaternion());
    const upper = elbowAt.clone().sub(shoulder).normalize().applyQuaternion(parentQ.clone().invert());
    const armLocal = new Quaternion().setFromUnitVectors(rig.restDir[`arm${side}`]!, upper);
    // The bones between the arm and the elbow (the twist bone), parent to child, as they are now.
    const chain: Quaternion[] = [];
    for (let b = rig.bones[elbow].parent; b >= 0 && b !== arm; b = rig.bones[b].parent) chain.unshift(rig.bones[b].bone.quaternion);
    const mid = new Quaternion().copy(parentQ).multiply(armLocal);
    for (const link of chain) mid.multiply(link);
    const fore = wristAt.clone().sub(elbowAt).normalize().applyQuaternion(mid.clone().invert());
    const elbowLocal = new Quaternion().setFromUnitVectors(rig.restDir[`elbow${side}`]!, fore);
    for (const [i, bone, local] of [[arm, armBone, armLocal], [elbow, elbowBone, elbowLocal]] as const) {
      port.remember(bone);
      if (!before.has(i)) before.set(i, bone.quaternion.clone());
      bone.quaternion.slerp(local, w);
    }
  }

  // ------------------------------------------------------------------ props

  private frameProps(input: SleepBodyInput, dt: number): void {
    const plan = this.plan, kind = plan?.candidate.kind;
    const p = this.p.x, weight = this.yieldW.x;
    // Nothing fits the camera any more: the props go with her as she gets up to the standing doze.
    const settling = !this.noFit && ((input.phase === 'falling-asleep' && this.pTarget > 0) || sleepish(input.phase));
    const want = { pillow: kind === 'lie' && (settling || p > 0.8) ? weight : 0, desk: kind === 'desk' && (settling || p > 0.8) ? weight : 0 };
    if (!this.props && input.scene && (want.pillow > 0 || want.desk > 0) && plan) {
      this.props = new SleepProps(input.scene);
      this.props.place({ pillow: plan.candidate.placed.pillow, desk: plan.candidate.placed.desk });
    }
    if (!this.props) return;
    const pillow = plan?.candidate.placed.pillow, head = plan?.candidate.placed.head;
    let pressX = 0, pressZ = 0;
    if (pillow && head) {
      const dx = head.center.x - pillow.center.x, dz = head.center.z - pillow.center.z, cos = Math.cos(pillow.yaw), sin = Math.sin(pillow.yaw);
      pressX = dx * cos - dz * sin; pressZ = dx * sin + dz * cos;
      if (this.action?.kind === 'nuzzle') pressX += Math.sin(this.action.t / this.action.duration * Math.PI * 4) * 0.08 * (pillow.width);
      if (this.stir?.kind === 'nuzzle') { const u = this.stir.t / this.stir.duration; pressX += Math.sin(u * Math.PI * 3) * Math.sin(u * Math.PI) * 0.06 * pillow.width; }
    }
    const press = Math.max(0, Math.min(1, (p - 1.55) / 0.4)) * weight * (1 - 0.6 * this.lift.x);
    this.props.frame(dt, { ...want, press: kind === 'lie' ? press : 0, pressX, pressZ });
    if (this.props.state.pillow <= 0.002 && this.props.state.desk <= 0.002 && want.pillow === 0 && want.desk === 0 && p < 0.01) { this.props.dispose(); this.props = null; }
  }
}

const AXIS_X = new Vector3(1, 0, 0), AXIS_Y = new Vector3(0, 1, 0), AXIS_Z = new Vector3(0, 0, 1);

// ------------------------------------------------------------------ stage glue (kept here so MmdStage only feeds it)

export interface SleepBodyStageArgs {
  mesh: SkinnedMesh;
  rigCache: { mesh: SkinnedMesh; rig: SleepRig | null } | undefined;
  profile: { bone(slot: StandardBone): Bone | undefined; profile?: { collision?: CollisionProxy | null } | null } | null | undefined;
  baseY: number;
  view: MoodView | null | undefined;
  /** The capability card's 能做睡姿 (the same switch as I-024's head-only sleep pose). */
  sleepPose: boolean;
  camera: Camera;
  width: number;
  height: number;
  scene: Object3D;
  /** A higher owner holds her body. */
  yielding: boolean;
  /** Someone is busy with her (typing, speech, a touch, a reply, a chat gesture, a reaction, a camera or window move). */
  busy: boolean;
  /** I-078 第 2 步: the user's hand is on her head or cheek now. */
  touched?: boolean;
  /** I-078 第 3 步: the active card's 睡相 as stored (0 calm … 100 restless; absent = the middle). */
  sleepHabit?: unknown;
}
/** The layer's input from the stage's own state (the rig is built once per mesh, from the profile's slots and capsules). */
export function sleepBodyInput(args: SleepBodyStageArgs): SleepBodyInput & { rigCache: { mesh: SkinnedMesh; rig: SleepRig | null } } {
  const { mesh, view, camera } = args, fatigue = view?.fatigue, snapshot = view?.snapshot;
  const rigCache = args.rigCache?.mesh === mesh ? args.rigCache
    : { mesh, rig: args.profile ? buildSleepRig(mesh, slot => args.profile!.bone(slot), args.profile.profile?.collision, args.baseY) : null };
  const allowed = !!fatigue && args.sleepPose && view?.expressions === true && (snapshot?.intensity?.posture ?? 0) > 0;
  camera.updateMatrixWorld?.();
  const e = camera.matrixWorld.elements, fov = (camera as { fov?: number }).fov ?? 0;
  const viewKey = `${[e[0], e[2], e[8], e[10], e[12], e[13], e[14]].map(v => v.toFixed(2)).join(',')}|${fov}|${args.width}x${args.height}`;
  return { rigCache, owner: mesh, rig: rigCache.rig, phase: typeof fatigue?.phase === 'string' ? fatigue.phase : null, A: finite(fatigue?.A ?? 0), F: finite(fatigue?.F ?? 0),
    hormones: snapshot && view?.parameters ? normalizedHormones(snapshot.values, view.parameters.baseline) : undefined,
    allowed, yielding: args.yielding, free: !args.busy, view: { camera, width: args.width, height: args.height }, viewKey, scene: args.scene,
    W: finite(fatigue?.W ?? 0), touched: args.touched === true, habit: sleepHabitScale(args.sleepHabit) };
}

/** The stray-pixel sentinel's reach (stray-pixels.ts boneReach) widened by the props while they show (so a pillow is not a stray block). */
export function widenStrayReach(box: StrayBox | null, body: SleepBody | undefined, camera: Camera, width: number, height: number): StrayBox | null {
  const corners = box && body ? body.propCorners() : [];
  if (!box || !corners.length) return box;
  const out = { ...box }, p = new Vector3();
  for (const corner of corners) {
    p.set(corner.x, corner.y, corner.z).project(camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.z < -1 || p.z > 1) continue;
    const px = (p.x + 1) / 2 * width, py = (p.y + 1) / 2 * height;
    out.minX = Math.min(out.minX, px); out.maxX = Math.max(out.maxX, px); out.minY = Math.min(out.minY, py); out.maxY = Math.max(out.maxY, py);
  }
  return out;
}

/** Catmull-Rom on the ground table (C¹ in p, so the center's height has no kinks). */
function groundAt(table: Float32Array, p: number): number {
  const step = SLEEP_BODY_MOTION.tableStep, n = table.length;
  if (!n) return 0;
  const x = Math.min(n - 1, Math.max(0, p / step)), i = Math.min(n - 2, Math.floor(x)), t = x - i;
  const p0 = table[Math.max(0, i - 1)], p1 = table[i], p2 = table[Math.min(n - 1, i + 1)], p3 = table[Math.min(n - 1, i + 2)];
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

/** The plan for a candidate: waypoint/final rotations per bone and the ground table along the path (rest as the base). */
export function buildPlan(rig: SleepRig, candidate: SleepCandidate): Plan {
  const rot = new Map<number, [Quaternion, Quaternion]>();
  const wp = candidate.waypoint, fin = candidate.placed;
  for (const i of new Set([...wp.local.keys(), ...fin.local.keys()])) rot.set(i, [wp.local.get(i)?.clone() ?? new Quaternion(), fin.local.get(i)?.clone() ?? new Quaternion()]);
  const steps = Math.round(2 / SLEEP_BODY_MOTION.tableStep), ground = new Float32Array(steps + 1);
  const local = new Map<number, Quaternion>(), offset = new Vector3(), point = new Vector3();
  const skip = (segment: string) => segment === 'head' || (fin.kind === 'desk' && /^(forearm|hand)/.test(segment));
  for (let k = 0; k <= steps; k++) {
    const p = k * SLEEP_BODY_MOTION.tableStep, a = towardWaypoint(p), c = towardPose(p);
    for (const [i, [w, f]] of rot) local.set(i, new Quaternion().slerp(w, a).slerp(f, c));
    offset.set(0, 0, 0).lerp(wp.centerOffset, a).lerp(fin.centerOffset, c);
    const fk = forward(rig, local, offset);
    const lows: number[] = [];
    for (const cap of rig.capsules) {
      if (skip(cap.segment)) continue;
      lows.push(Math.min(posedPoint(rig, fk, cap.bone, cap.a, point).y, posedPoint(rig, fk, cap.bone, cap.b, point).y) - cap.radius);
    }
    // In between: the lowest point back on the floor (up or down). Standing is her own stance: its small residual (the
    // placements keep a hair of clearance) fades out as she leaves it.
    const floor = rig.floorY + rig.height * 0.004;
    ground[k] = floor - Math.min(...lows);
  }
  const standing = ground[0];
  for (let k = 0; k <= steps; k++) ground[k] -= standing * (1 - towardWaypoint(k * SLEEP_BODY_MOTION.tableStep));
  // The lowest point switches between contacts (feet, knees, hips): smooth the table so the height has no kinks, ends kept.
  for (let pass = 0; pass < 3; pass++) {
    const copy = ground.slice();
    for (let k = 1; k < steps; k++) {
      const at = (j: number) => copy[Math.min(steps, Math.max(0, j))];
      ground[k] = (at(k - 2) + 4 * at(k - 1) + 6 * at(k) + 4 * at(k + 1) + at(k + 2)) / 16;
    }
  }
  ground[0] = 0; ground[steps] = 0;
  return { candidate, rot, wpOffset: wp.centerOffset.clone(), finalOffset: fin.centerOffset.clone(), ground };
}

export type { PlacedPose };
