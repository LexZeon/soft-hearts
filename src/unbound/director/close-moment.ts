/**
 * I-184 (docs/claude/2026-11-22-i184-unbound-kiss.md): a close moment as the director plays it — a kiss, a hug, or shying back a step —
 * through the same channel as the peek (the host decided which and planned it: shared/unbound/close-moments/).
 * I-192 (docs/claude/2026-11-22-i192-arrival-targets.md): the kiss and the hug are her FACE coming to the lens, like the peek: an arrival
 * target in viewer space (shared/unbound/arrival/), never so near that any of her (nose, bangs, hair) comes into the camera.
 * I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): the user's kiss storyboard and the hug's last frame. Where she goes is close-target.ts.
 *
 *   notice  she sees you (her eyes to the lens), a moment
 *   walk    to where she begins: her head about a fifth of the screen's width, centred (the storyboard's 01); a moment standing there
 *   lean    one step in to the stand point while she leans (about half by 0.9 s, the storyboard's 02), the arrival loop brings her face the
 *           last centimetres (03): a kiss tilts her head and closes her eyes, her eyes in the upper part of the screen and her mouth in the
 *           lower, centred; a hug turns her face OUTWARD (to the screen's right), her ear three quarters across, eyes closed, a small smile,
 *           her arms open toward the screen's edges (her arm reach's 'aim', only while no game, offer or reach holds them and the engine can
 *           move them). Her own choices lie on top (the plan's extras: the pucker only in a pause, PuckerGate; the blush)
 *   hold    as long as she decides (her mood, familiarity, character; at least 1.5 s), on while she speaks up to the cap, and a moment after
 *           she stops so a pucker shows (shared/unbound/arrival/hold.ts). Only a face that really arrived holds (T-264)
 *   back    she steps back toward where she began (about 1.2 s) while everything eases back, the after-beat (by her character) comes in, and
 *           if she chose it she tucks her hair behind her ear (05)
 *   settle  she walks back to where she stood while the after-beat fades; done when she is there
 * Every channel is a goal on a quintic curve, laid on her springs: she never jumps. A cancel (a large pull, a full-screen program) goes to
 * `back` from wherever every channel is, carrying each channel's speed ("禁止只是不开始新的动作，不是定住").
 */
import type { PeekCancelReason, PeekCommand, PeekPhase } from '../../../shared/unbound/director';
import {
  HoldFrames, PuckerGate, REST_CHANNELS, SETTLE_FADE_S, backChannels, backLength, leanChannels, settleChannels, type CloseChannels, type CloseMomentPlan,
} from '../../../shared/unbound/close-moments';
import { ARRIVAL_KNOBS, HoldClock, axisPlace, headPointNow, holdGoesOn, usableFace, windowPoint, type HeadOffset, type ScreenSpot } from '../../../shared/unbound/arrival';
import type { BodySense, MotionIntent } from '../motion/generator';
import { FaceArrivalCheck, faceAimNow } from '../motion/arrive';
import { CLOSE_AWAY, closeFace, closeHands } from './close-pose';
import { closeTarget } from './close-target';
export { hugArm } from './close-pose'; // I-185: moved there (the window and the lighter hug share it)
import type { NearStations } from '../pull-near';
import type { DirectorAction, DirectorBody, DirectorWorld, Performance } from './director';

/** What the performance reads from the page (main.ts hands these in). */
export interface CloseMomentHooks {
  /** Her near stations for the camera and her body now (null: not known). */
  near(): NearStations | null;
  /** I-175: may a closed-mouth shape start now (closedMouthMayStart), and the held "she is speaking". */
  mouth(): { mayStart: boolean; speaking: boolean };
  /** No game, offer or reach for your hand holds her arms. */
  armsFree(): boolean;
  /**
   * I-192 follow-up (Codex T-261): the engine can move her arms on this model at all (ArmReach measured her head; a VRM's standard body has
   * no mesh of its own, so it cannot today). false: the hug is the same walk-up and face arrival, her arms simply stay still, and the report
   * says so (the host records the hug with its arms still). Absent: not known.
   */
  armsCan?(): boolean;
}

export const CLOSE_BEATS = Object.freeze({
  /** Closer than this (m, root to the stand point) she does not walk. */
  walkFromM: 0.08,
  walkTimeoutS: 30,
  settleTimeoutS: 40,
  /** Seconds for her arms to come in or give way when a game takes them. */
  armsGateS: 0.4,
  /** Looking away: how far to the side and down at a full `away` (rad). */
  awayYaw: CLOSE_AWAY.yaw, awayPitch: CLOSE_AWAY.pitch,
  /** Of her toes' rise, how much the stand solve may count on (the rest is the loop's). */
  tiptoeShare: 0.75,
  /** A hug's head yaw lets the eye-head coordinator take this much of the turn into her head (her eyes are closed). */
  turnRecenter: 0.9,
  /** I-192 follow-up: from this share of the lean on, the arrival check may push her stop out so her eyes and mouth fit. */
  checkFrom: 0.6,
  /** I-203: standing where she begins this long before the step in (the storyboard's 01: "安静地看着你"). */
  startStillS: 0.35,
  /** I-203: the step in is a walk: about this many seconds of the lean (the storyboard's 0.9 of 1.7 s), at most `stepMaxMps`. */
  stepShare: 0.55, stepMaxMps: 1.3,
  /**
   * I-203: the arrival loop may raise her onto her toes only once her feet are set after the step in, over this long (s): she never steps
   * while up on her toes (a step on tiptoe made her hips drop and jump: measured 0.6–4 cm in a frame).
   */
  toesAfterStepS: 0.3,
  /** I-203: the arrival's bounded wait starts once her toes may be used, or at the latest this long after the lean (s). */
  toesWaitCapS: 3,
  /** I-203: the lean's clock slows from this share of approachS while her feet still step, and eases its rate over this long (s). */
  leanWaitFrom: 0.45, leanRateS: 0.15,
  /**
   * I-203: the step back after the hold goes at most this far (m): a step back while facing you (her gait turns round for anything longer);
   * the rest of the way home is `settle`'s walk.
   */
  stepBackM: 0.55,
  /** I-203: the kiss's eye dip: how fast it follows what her toes cannot give (1/s, m/s at most) and in which share of backS it eases out. */
  dipGain: 4, dipRateMps: 0.1, dipOutShare: 0.8, dipToesShare: 0.3,
  /** I-203: how far a full-screen hug's arms wrap forward round you (of hugArm's way; her model's arms must be movable). */
  hugWrap: 0.6,
});

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const S5 = (u: number) => { const x = clamp01(u); return x * x * x * (10 + x * (-15 + 6 * x)); };

/**
 * Where her face is going (decide): its distance along the axis, the point (the kiss: below her eyes; the hug: her ear) and where in the window
 * it goes, the lean the solve allows. I-192 follow-up: `framedM` the distance her point really goes to (pushed out when her eyes and mouth would
 * not fit), `arrived` whether the hold began with her face there (false: the bounded wait ran out), `waitS` how long after the lean it took.
 */
interface FaceArrivalPlan { distanceM: number; dropM: number; mouthDropM: number; lean: number; fitM: number; clipped: boolean; framedM: number; arrived: boolean | null; waitS: number;
  /** I-203: the hug's point (her ear, head frame) or null (the kiss's `dropM` below her eyes), and where in the window it goes. */
  point: HeadOffset | null; spot: ScreenSpot;
  /** I-203: where she began (her head a fifth of the width) and whether she walked there; her head's width (m). */
  start: { x: number; z: number }; walkedToStart: boolean; headM: number }

class CloseMomentPerformance implements Performance {
  phase: PeekPhase = 'notice';
  cancelled: PeekCancelReason | null = null;
  private t = 0;
  private since = 0;
  private stand: { x: number; z: number } | null = null;
  private home: { x: number; z: number };
  /** I-203: where she begins and comes back to (the storyboard's 01 and 05); her step back's point. */
  private start: { x: number; z: number } | null = null;
  private stepBack: { x: number; z: number } | null = null;
  private stepSpeed: number | null = null;
  private stillFor = 0;
  /** I-203: 0..1, how much of her toes the arrival loop may use yet (it waits for her feet to be set after the step in). */
  private toesGate = 0;
  /** I-203: the lean's own clock (s), its rate (0..1, eased) and when it reached approachS (beat s; null: not yet). */
  private leanClock = 0;
  private leanRate = 1;
  private leanDoneAt: number | null = null;
  /** I-203: in back, she is down off her toes (her step back may start; it stays started). */
  private offToes = false;
  /** The channels as last shown (a cancel and each later beat start from them). */
  private shown: CloseChannels = { ...REST_CHANNELS };
  private from: CloseChannels = { ...REST_CHANNELS };
  /** The channels a frame before `shown`, and that frame's length: a cancel carries each channel's speed into its way back. */
  private before: CloseChannels = { ...REST_CHANNELS };
  private lastStep = 0;
  private velocity: Partial<CloseChannels> | null = null;
  private readonly pucker = new PuckerGate();
  private puckerShown = 0;
  /** 0..1 progress of the arms' own gate (a game taking her arms eases them out; S5 of it is applied). */
  private armsOk = 1;
  private readonly side: 1 | -1;
  /** I-192: her face's arrival (null: shy, or her eyes unknown: the plain lean as before); where the arrival's distance eases from. */
  private face: FaceArrivalPlan | null = null;
  private startDistance: number | null = null;
  private hold = new HoldClock();
  /** The head turn at the closest (rad, + = toward her left): the plan's (a hug: outward, to the screen's right). */
  private readonly yaw: number;
  /** I-192 follow-up: whether her face really got there (eyes and mouth / the hug's ear in the window, out of the camera); null: no face arrival. */
  private check: FaceArrivalCheck | null = null;

  constructor(readonly id: string, private readonly plan: CloseMomentPlan, world: DirectorWorld, private readonly hooks: CloseMomentHooks) {
    this.home = { ...world.home };
    this.side = plan.tiltRad >= 0 ? 1 : -1;
    this.yaw = plan.yawRad;
  }
  private armsCan(): boolean | null { try { const can = this.hooks.armsCan?.(); return typeof can === 'boolean' ? can : null; } catch { return null; } }
  /**
   * I-192 follow-up (Codex T-261): for the host's report, whether her arms can move on this model at all. A hug on a model whose arms the
   * engine cannot move is still the whole hug the user asked for (her face coming to the lens, not the hands closing): she walks over and her face
   * arrives; only her arms stay still, and the host records that (never that they moved).
   */
  get extra(): { arms?: boolean } {
    const arms = this.armsCan();
    return arms !== null ? { arms } : {};
  }

  /** The pucker as shown last frame (tests, the record). */
  get puckerNow(): number { return this.puckerShown; }
  get channels(): Readonly<CloseChannels> { return this.shown; }
  /** I-192: the face target (tests, the record): distance from the lens, and whether the clip guard stopped her earlier than the fit. */
  get target(): Readonly<FaceArrivalPlan> | null { return this.face; }
  private get beat(): number { return this.t - this.since; }
  private go(phase: PeekPhase): void { this.phase = phase; this.since = this.t; }

  /** 2026-11-23: a large pull took her: this performance stops placing her (the pull walks her); its way back still eases her face and body. */
  private placeFree = false;
  yieldPlace(): void { this.placeFree = true; this.stand = null; }

  /**
   * I-203 frames from her reply (the host relays what the page reached): ⟦let-go⟧ ends her hold at that point in her words (written before
   * she arrived: once she has held the floor); ⟦pause⟧ keeps her holding through it (`seconds`). Ignored once she is on her way back.
   */
  private readonly frames = new HoldFrames();
  frame(word: 'let-go' | 'pause', seconds = 0): void {
    if (this.cancelled || this.phase === 'back' || this.phase === 'settle' || this.phase === 'done') return;
    if (word === 'let-go') this.frames.letGo(this.phase === 'hold' ? this.beat : null);
    else this.frames.keep(this.t, seconds);
  }
  /** Her let-go was written (tests, the record). */
  get letGoAsked(): boolean { return this.frames.letGoAsked; }

  cancel(reason: PeekCancelReason): void {
    if (this.cancelled || this.phase === 'back' || this.phase === 'settle' || this.phase === 'done') return;
    this.cancelled = reason;
    this.from = { ...this.shown };
    if (this.phase === 'notice' || this.phase === 'walk') this.stand = null; // not there yet: she turns back home, not on to the front
    const step = this.lastStep, before = this.before, shown = this.shown;
    this.velocity = step > 0 ? Object.fromEntries((Object.keys(shown) as (keyof CloseChannels)[]).map(key => [key, (shown[key] - before[key]) / step])) : null;
    this.goBack();
  }

  next(dt: number, world: DirectorWorld, sense: BodySense | null, body: DirectorBody): { intent: MotionIntent; t: number } {
    const step = Math.max(0, Math.min(0.1, dt));
    this.t += step;
    this.lastSense = sense;
    const plan = this.plan, mouth = this.hooks.mouth();
    let channels: CloseChannels = this.shown, place: { x: number; z: number } | null = null;
    switch (this.phase) {
      case 'notice':
        channels = { ...REST_CHANNELS };
        if (this.beat >= plan.noticeS && sense) this.decide(world, sense);
        break;
      case 'walk': {
        // To where she begins (I-203), or (no eyes known) straight to the old face station.
        const goal = this.start ?? this.stand!;
        place = goal;
        const there = !!sense && !sense.moving && Math.hypot(sense.root.x - goal.x, sense.root.z - goal.z) < 0.05;
        this.stillFor = there ? this.stillFor + step : 0;
        if (there && (!this.start || this.stillFor >= CLOSE_BEATS.startStillS)) this.startLean(world, sense!);
        else if (this.beat > CLOSE_BEATS.walkTimeoutS) { this.cancelled = 'timeout'; this.from = { ...this.shown }; this.stand = null; this.goBack(); }
        break;
      }
      case 'lean': {
        place = this.stand;
        // I-203: the lean's own clock. The first part (the lean in while she steps) runs with time; its last part (the face's arrival, her eyes
        // closing, her head turning) waits, eased, while her feet are still stepping, so she arrives as her step ends, never mid-stride.
        const stepping = !!sense && (sense.stepping ?? sense.moving), a = plan.approachS;
        const want = stepping ? 1 - S5((this.leanClock - CLOSE_BEATS.leanWaitFrom * a) / (0.15 * a)) : 1;
        this.leanRate += (want - this.leanRate) * (1 - Math.exp(-step / CLOSE_BEATS.leanRateS));
        this.leanClock = Math.min(a, this.leanClock + step * this.leanRate);
        channels = this.scaled(leanChannels(plan, this.leanClock));
        // Her toes come in only once her feet are set: never a step on her toes.
        // (settled: no step, no turn still under way: a late turn of hers is taken with a step, and never on her toes)
        if (sense && !sense.moving) this.toesGate = Math.min(1, this.toesGate + step / CLOSE_BEATS.toesAfterStepS);
        // I-192 follow-up (Codex T-263): the lean's timer is not her arrival. From the lean's last part the check pushes her arrival distance
        // out as far as her eyes and mouth need; the hold starts when her face is there (both eyes and her mouth in the window — the hug: her
        // ear — nothing of her head nearer than the guard); after a bounded wait it did not happen and she backs off (T-264; she never freezes).
        const checked = this.check && sense && this.leanClock >= CLOSE_BEATS.checkFrom * a
          ? this.check.frame(step, world.lens, sense, this.face!.dropM, this.face!.mouthDropM, usableFace(sense.face)) : null;
        if (this.leanClock < a) {
          // A step that never ends (her feet kept busy) cannot hold the lean forever: past the walk's own limit she backs off (T-264's way).
          if (this.beat > a + CLOSE_BEATS.walkTimeoutS) { if (this.face) { this.face.arrived = false; this.face.waitS = 0; } this.cancel('unreached'); }
          break;
        }
        // The bounded wait counts once her toes may be used (she has stopped stepping and turning), at most toesWaitCapS after the lean.
        if (this.leanDoneAt === null && (this.toesGate >= 1 || this.beat > a + CLOSE_BEATS.toesWaitCapS)) this.leanDoneAt = this.beat;
        const waited = this.leanDoneAt === null ? 0 : this.beat - this.leanDoneAt;
        // T-264: with a face to arrive (the check exists) she is there only when it says so; a frame without her measured is not "there".
        const there = !this.check || (!!sense && !!checked?.reached);
        if (there) { if (this.face) { this.face.arrived = true; this.face.waitS = waited; } this.go('hold'); this.hold = new HoldClock(); }
        else if (waited >= ARRIVAL_KNOBS.arriveWaitS) {
          // The wait ran out with her face not in the window: it did not happen. She never kisses or hugs nothing: she backs off the way a
          // cancel does (from where every channel is, carrying their speed) and the host is told why ('unreached').
          if (this.face) { this.face.arrived = false; this.face.waitS = waited; }
          this.cancel('unreached');
        }
        break;
      }
      case 'hold':
        place = this.stand;
        if (sense && !sense.moving) this.toesGate = Math.min(1, this.toesGate + step / CLOSE_BEATS.toesAfterStepS);
        channels = this.scaled(leanChannels(plan, plan.approachS));
        // Only an arrived face holds (T-264): it keeps her eyes and mouth in the window (out only).
        if (this.check && sense && this.face?.arrived) this.check.frame(step, world.lens, sense, this.face!.dropM, this.face!.mouthDropM, usableFace(sense.face), true); // keeps her in the window
        this.hold.frame(step, mouth.speaking);
        // I-192: as long as she decides; on while she speaks (up to the cap), and a moment after, so the pucker shows when she is quiet.
        // I-203: her frames over the plain rule: a let-go ends it at its place, a pause keeps it on; with neither, once her words and her own length are done.
        if (!this.frames.goesOn(holdGoesOn(this.hold.state(plan.holdS, mouth.speaking)), this.hold.beat, this.t)) { this.from = { ...channels }; this.goBack(); }
        break;
      case 'back':
        // I-203: a step back toward where she began (facing you), while everything eases back (the storyboard's 05).
        // She steps only once she is down off her toes (the loop's reach eases out first, in the first part of back).
        if (this.shown.reach < 0.05 && (!sense || sense.offsets.up < 0.005)) this.offToes = true;
        place = this.placeFree ? null : (this.offToes ? this.stepBack : this.stand) ?? this.stand ?? this.home;
        channels = backChannels(plan, this.from, this.beat, this.cancelled !== null, this.velocity);
        if (this.beat >= backLength(plan, this.cancelled !== null)) { this.from = { ...channels }; this.go('settle'); }
        break;
      case 'settle': {
        place = this.placeFree ? null : this.home;
        channels = settleChannels(this.from, this.beat);
        const home = this.placeFree || !!sense && !sense.moving && Math.hypot(sense.root.x - this.home.x, sense.root.z - this.home.z) < 0.05 && body.intentIdle;
        if ((home && this.beat >= SETTLE_FADE_S) || this.beat > CLOSE_BEATS.settleTimeoutS || !sense) this.go('done');
        break;
      }
      case 'done': default:
        return { intent: { kind: 'rest' }, t: this.beat };
    }
    this.before = this.shown; this.shown = channels; this.lastStep = step;
    // The pucker shows only in a pause (I-175): it waits while she speaks and eases back if she starts.
    this.puckerShown = this.pucker.frame(step, channels.pucker, mouth.mayStart, mouth.speaking);
    // Her arms give way (eased) while a game, an offer or her reach holds them; they never fight those.
    this.armsOk = clamp01(this.armsOk + (this.hooks.armsFree() ? 1 : -1) * step / CLOSE_BEATS.armsGateS);
    this.updateDip(step, world, sense);
    return { intent: this.intent(world, channels, place), t: this.t };
  }

  /** `back`: her step back goes toward where she began, at most stepBackM (a back step facing you; the rest is settle's walk). */
  /**
   * I-203: the kiss's eye dip (the lead's review: the storyboard's eyes in the upper part and mouth in the lower part need her face on the axis,
   * and the close-up camera sits above what her toes can reach): from the lean's last part and through the hold, whatever of her face's
   * height her toes cannot still give is asked of the camera (an integral, rate-limited, at most ARRIVAL_KNOBS.kissDipMaxM); it eases back to 0
   * over `back`. The floor framing follows it on its own spring (src/unbound/floor-framing.ts), so it is never shown as a jump.
   */
  private dip = 0;
  private dipAtBack = 0;
  get cameraDipM(): number { return this.dip; }
  private updateDip(step: number, world: DirectorWorld, sense: BodySense | null): void {
    const f = this.face, a = this.plan.approachS;
    if (this.plan.kind !== 'kiss' || !f) { this.dip = 0; return; }
    if (this.phase === 'back' || this.phase === 'settle') {
      this.dip = this.phase === 'back' ? this.dipAtBack * (1 - S5(this.beat / Math.max(0.3, CLOSE_BEATS.dipOutShare * this.plan.backS))) : 0;
      return;
    }
    const aim = sense && ((this.phase === 'lean' && this.leanClock >= CLOSE_BEATS.checkFrom * a) || this.phase === 'hold') ? faceAimNow(sense.eyes, f.dropM) : null;
    if (!aim || !sense) return;
    const short = windowPoint(world.lens, f.framedM, f.spot).y - aim.y, toesLeft = Math.max(0, sense.tiptoeRise * S5(this.toesGate) - sense.offsets.up);
    const change = Math.max(-CLOSE_BEATS.dipRateMps, Math.min(CLOSE_BEATS.dipRateMps, CLOSE_BEATS.dipGain * (short - CLOSE_BEATS.dipToesShare * toesLeft - 0.002))) * step;
    this.dip = Math.min(ARRIVAL_KNOBS.kissDipMaxM, Math.max(0, this.dip + change));
  }

  private goBack(): void {
    this.dipAtBack = this.dip;
    const from = this.stand, to = this.start ?? this.home;
    if (from && !this.placeFree) {
      const dx = to.x - from.x, dz = to.z - from.z, d = Math.hypot(dx, dz), k = d > 1e-6 ? Math.min(1, CLOSE_BEATS.stepBackM / d) : 0;
      this.stepBack = { x: from.x + dx * k, z: from.z + dz * k };
      this.offToes = false;
    } else this.stepBack = null;
    this.go('back');
  }

  /** The plan's lean as the arrival solve allows it (a lens above her face: she leans less, so her face can still come up to it). */
  private scaled(c: CloseChannels): CloseChannels {
    const face = this.face, wanted = this.plan.leanRad;
    if (!face || !(wanted > 1e-6)) return c;
    // I-203: she leans in as the plan says while she steps (the storyboard's 02), then settles to the lean her arrival allows as her face arrives
    // (the camera sits at about her standing face height: leaning deeper would leave her face below it).
    const k = S5((this.leanClock - CLOSE_BEATS.leanWaitFrom * this.plan.approachS) / ((1 - CLOSE_BEATS.leanWaitFrom) * this.plan.approachS));
    return { ...c, lean: c.lean * (1 + (face.lean / wanted - 1) * k) };
  }

  /** End of the notice: where her face goes, where she stands for it and where she begins; walk there first if she is farther. */
  private decide(world: DirectorWorld, sense: BodySense): void {
    if (this.plan.kind === 'shy') { this.stand = { x: sense.root.x, z: sense.root.z }; this.startLean(world, sense); return; }
    const lens = world.lens;
    const target = closeTarget(this.plan, lens, sense, this.yaw, CLOSE_BEATS.tiptoeShare);
    if (!target) { this.stand = { x: lens.camera.x, z: -(this.hooks.near()?.faceDepthM ?? 0.9) }; this.go('walk'); return; } // no eyes: the old face station
    this.face = { distanceM: target.distanceM, dropM: target.dropM, mouthDropM: target.mouthDropM, lean: target.lean, fitM: target.fitM, clipped: target.clipped,
      framedM: target.distanceM, arrived: null, waitS: 0, point: target.point, spot: target.spot, start: target.start, walkedToStart: target.walkToStart, headM: target.headM };
    this.check = new FaceArrivalCheck(target.distanceM, undefined, target.spot, target.point);
    this.stand = target.stand;
    this.start = target.start;
    if (target.walkToStart) this.go('walk');
    else this.startLean(world, sense); // already at (or nearer than) where she begins: the step in starts from here
  }

  /** The lean begins (the storyboard's 01): the step in to the stand point is a walk of about stepShare of the lean. */
  private startLean(world: DirectorWorld, sense: BodySense): void {
    // I-203: solved again from where she begins, with the camera as it is now (the floor framing moves it as she comes).
    const again = this.face ? closeTarget(this.plan, world.lens, sense, this.yaw, CLOSE_BEATS.tiptoeShare) : null;
    if (again && this.face) {
      Object.assign(this.face, { distanceM: again.distanceM, dropM: again.dropM, mouthDropM: again.mouthDropM, lean: again.lean, fitM: again.fitM, clipped: again.clipped,
        framedM: again.distanceM, point: again.point, spot: again.spot, headM: again.headM });
      this.check = new FaceArrivalCheck(again.distanceM, undefined, again.spot, again.point);
      this.stand = again.stand;
    }
    const stand = this.stand;
    if (stand && this.face) {
      const d = Math.hypot(sense.root.x - stand.x, sense.root.z - stand.z);
      this.stepSpeed = Math.min(CLOSE_BEATS.stepMaxMps, Math.max(this.plan.walkSpeedMps, d / Math.max(0.3, CLOSE_BEATS.stepShare * this.plan.approachS)));
    }
    this.startDistance = null;
    this.toesGate = 0;
    this.leanClock = 0; this.leanRate = 1; this.leanDoneAt = null;
    this.go('lean');
  }

  /** Where her point is now along the axis (the kiss: below her eyes; the hug: her ear). */
  private pointAlong(world: DirectorWorld, sense: BodySense | null): number | null {
    const f = this.face;
    if (!f || !sense) return null;
    const p = f.point ? headPointNow(sense.eyes, f.point) : faceAimNow(sense.eyes, f.dropM);
    return p ? axisPlace(world.lens, p).along : null;
  }

  private intent(world: DirectorWorld, c: CloseChannels, place: { x: number; z: number } | null): MotionIntent {
    const face = closeFace(c, this.puckerShown), hug = this.plan.kind === 'hug';
    const arms = hug ? c.arms * S5(this.armsOk) : 0;
    // I-203: her arms open and come forward round you (past the screen's edges, below and beside the frame): her face is far enough now
    // (the hug's head share) that they stay out of the picture and never reach the viewer's eye plane (measured).
    let hands = closeHands(arms, c.wrap * CLOSE_BEATS.hugWrap);
    // I-203, her own choice: tucking her hair behind her ear on the way back (the hand on the side her head tilts toward).
    if (c.tuck > 1e-4 || c.slide > 1e-4) {
      const tuck = { weight: c.tuck * S5(this.armsOk), pose: 'tuck' as const, wave: 0, slide: c.slide };
      hands = this.side === 1 ? { ...hands, left: tuck } : { ...hands, right: tuck };
    }
    const f = this.face, turn = this.yaw * c.turn;
    if (f && this.check) f.framedM = this.check.framedM; // the arrival distance, pushed out while her eyes and mouth would not fit
    // The arrival's distance eases from where her point was when the reach began (she is still stepping in) to its own.
    if (f && c.reach > 1e-4 && this.startDistance === null) this.startDistance = Math.max(f.framedM, this.pointAlong(world, this.lastSense) ?? f.framedM + 0.15);
    if (c.reach <= 1e-4 && this.phase === 'lean') this.startDistance = null;
    const from = this.startDistance ?? f?.framedM ?? 0;
    const arrive = f && c.reach > 1e-4 ? { dropM: f.dropM, distanceM: from + (f.framedM - from) * Math.min(1, c.reach), weight: c.reach, chase: this.phase === 'lean' || this.phase === 'hold', toes: S5(this.toesGate),
      ...(f.point ? { point: f.point, spot: f.spot } : {}) } : undefined;
    const speed = this.phase === 'lean' && this.stepSpeed !== null ? this.stepSpeed : this.plan.walkSpeedMps;
    return {
      kind: 'showcase', lens: world.lens, gaze: { mode: 'lens', yaw: this.side * CLOSE_BEATS.awayYaw * c.away + turn, pitch: CLOSE_BEATS.awayPitch * c.away },
      place, walkSpeedMps: place ? speed : null, ...(this.phase === 'lean' && place ? { walkBrisk: true } : {}),
      lean: c.lean, tilt: c.tilt, nod: 0.06 * c.away, bias: { yaw: 0, pitch: 0 }, gazeRecenter: 0.6 + (CLOSE_BEATS.turnRecenter - 0.6) * c.turn, hands, face, blink: 0,
      stillness: this.phase === 'hold' ? 0.4 : 0.1, tempo: 'calm', ...(arrive ? { arrive } : {}),
    };
  }
  /** The last sense seen (the reach's starting distance reads it). */
  private lastSense: BodySense | null = null;
}

/** The action for the director's list (main.ts): it plays plans whose action is 'close-moment'. */
export function closeMomentAction(hooks: CloseMomentHooks): DirectorAction {
  return {
    id: 'close-moment',
    begin: (command: Extract<PeekCommand, { type: 'start' }>, world: DirectorWorld) => new CloseMomentPerformance(command.id, command.plan as CloseMomentPlan, world, hooks),
  };
}
