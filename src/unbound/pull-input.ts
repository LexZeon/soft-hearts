/**
 * Unbound v1 step 5「拉她」in Unbound (docs/claude/2026-11-18-unbound-step5-plan.md「5c」「5e」; record docs/claude/2026-11-18-unbound-step5.md).
 *
 * The page's side of a pull: the same session as the companion (shared/behaviors/pull/session.ts; a click stays a click, shared/unbound/click.ts),
 * the same body layer (src/stage/pull/, through the figure), and in Unbound:
 *   - the host first (`unbound:pull` start): it says whether she may be pulled now (not asleep) and how she takes it (her stance from
 *     her mood: shared/behaviors/pull/attitude.ts); meanwhile the pull is yours in the arbiter: her own things ease out, a walk brakes;
 *   - she follows by walking, the gait alone moving her feet (never faster than her walk; leaning moves her weight, so it also steps by itself).
 *     Holding her body or head (hair included) is the joystick (I-196, src/unbound/pull-stick.ts, rules in shared/unbound/pull-stick/): the press
 *     point is the centre, the pointer's offset from it says where she goes (down = toward you, up = away, left and right = across), in screen
 *     pixels; inside the dead zone nothing moves; a press that leaves it is a pull and never a touch, a press held still inside it is a touch
 *     (I-194, shared/unbound/pull-stick/press.ts). The wheel over her is the same walk in steps. Holding an arm only moves the arm and she
 *     steps sideways when it runs past a small share of her height (as before);
 *   - a pulled leg: she stands on the other foot (the gait lifts this one a little); released, both feet again. Her root stays on the floor;
 *   - the end: where she stands, if she walked along, is her place (the host keeps it, and her own walks wait a while).
 * Gates: the window must be taking the mouse, she is on screen. Nothing new is sensed or sent: the part, how hard, the direction, how long,
 * how it ended, what her body did, steps.
 * While she is doing something (shared/unbound/action-ends): a press that leaves the dead zone is first a tug: her
 * body, hair and clothes give toward it through the same body layer (bounded to a tug's size, no walking, nothing sent to the host), and the
 * action goes on; once it reaches ACTION_END_KNOBS.largePullPx from the press point the action ends (`endAction`) and this becomes the pull
 * exactly as it works when she is free. The wheel over her does nothing while she is doing something.
 */
import { PULL_KNOBS, PullSession, pullAttitudeNow, pullGiveNow, type PullGroup, type PullReport, type PullStanceOf } from '../../shared/stage';
import { pullReportMessage, type UnboundPullMessage } from '../../shared/unbound/pull';
import type { Camera } from 'three';
import { nearOutcome, type NearOutcome, type NearStations } from './pull-near'; // I-159 E: the two near stations
import { STICK_KNOBS, PressJudge, wheelNotches, type StickKnobs } from '../../shared/unbound/pull-stick'; // I-196, I-194
import { StickDrive } from './pull-stick';
import type { PullDotPorts } from './pull-dot';
import { ACTION_END_KNOBS, pressSize, tugTarget, type ActionEndKnobs, type ActionKind } from '../../shared/unbound/action-ends';

/** The figure's hit and view, as this file needs them (the figure passes src/stage/pull/stage-pull.ts's richer ones through). */
export interface StagePullHit { part: PullReport['part']; side: PullReport['side']; group: PullGroup; heightPx: number }
export interface StageView { camera: Camera; width: number; height: number }

export type { UnboundPullAnswer } from '../../shared/unbound/pull';
import type { UnboundPullAnswer } from '../../shared/unbound/pull';
export interface UnboundPullFigure {
  pullHit(view: StageView, x: number, y: number): StagePullHit | null;
  pullStart(hit: StagePullHit, view: StageView): boolean;
  pullTo(view: StageView, x: number, y: number): void;
  pullEnd(): void;
  setPullStance(stance: { compliance: number; pace: number } | null): void;
  pullShownM(): { x: number; z: number };
  readonly rootM: { x: number; z: number };
  followTo(point: { x: number; z: number }): void;
  setStance(stance: 'both' | 'left' | 'right'): void;
  readonly heightM: number;
  readonly report: { steps: number } | null;
}
export interface UnboundPullPorts {
  figure(): UnboundPullFigure | null;
  view(): StageView;
  /** The window takes the mouse, no peek plays, she is on screen. */
  eligible(): boolean;
  send(message: UnboundPullMessage): Promise<UnboundPullAnswer | void>;
  /** A floor x (m) kept inside her stand range (at the depth she is walking to). */
  clampX(xM: number, depthM?: number): number;
  /** A depth (m) kept inside her depth range (I-155). */
  clampDepth(depthM: number): number;
  clock(): number;
  /** I-159 E: the near stations (face, eyes) for her body and the camera now; null: not known (the pull then stops where it always did). */
  near?(): NearStations | null;
  /** The viewer's distance from the screen (m), for the drag-to-depth way in. */
  viewerDistanceM?(): number;
  /** I-159 E: she was let go nearer than the face station: what happens ('face': she walks back; 'eyes': the host plays the peek) and the face point. */
  nearEnd?(outcome: Exclude<NearOutcome, 'stay'>, face: { x: number; z: number }): void;
  /** Batch B: this part of her is not a pull now (her hand and arm while she holds your hand: shared/behaviors/pull/gates.ts). */
  refuse?(group: PullGroup): boolean;
  /** I-196: the small dot at the press point (the joystick's centre). */
  dot?: PullDotPorts;
  /** I-194: the press that began on her was held still: one touch (the page's ClickReporter.hold). */
  holdTouch?(): void;
  /** 2026-11-23: what she is doing now that a press on her meets (src/unbound/action-now.ts), or null: a press is the pull as before. */
  action?(): ActionKind | null;
  /** 2026-11-23: a large pull reached that action: end it (the arbiter's row) before this becomes the pull. */
  endAction?(kind: ActionKind): void;
}

/** Slipping free eases back at this share of her pace (slowly, never a pop). */
const SLIP_PACE = 0.5;
/** The dot shows once a press has lasted this long (ms), so a quick click does not blink one. Looks only. */
const DOT_AFTER_MS = 150;
/** What kind of pull this is: an arm or a leg (as before), the joystick on her body or head, or the wheel. */
type Mode = 'limb' | 'stick' | 'wheel';

export class UnboundPull {
  private readonly session: PullSession;
  private hit: StagePullHit | null = null;
  private figure: UnboundPullFigure | null = null;
  private last: { x: number; y: number } | null = null;
  private pressedAt = 0;
  /** null: not asked yet; false: the host said no; an answer: the body follows. */
  private answer: UnboundPullAnswer | null | false = null;
  private asking = false;
  private following = false;
  private stepsAtStart = 0;
  private followFrom = 0;
  private mode: Mode = 'limb';
  /** I-196: tells a click, a held-still press (touch) and a pull apart; the stick's centre is its anchor. */
  private readonly judge: PressJudge;
  private readonly drive: StickDrive;
  private dotShown = false;
  /** Wheel notches not yet given to the gait, and when the wheel last turned. */
  private wheelPending = 0;
  private lastWheelAt = 0;
  private endPlace: { xM: number; depthM: number } | null = null;
  /** I-159 E: the end report asks the host for the peek (she was let go at the eyes station). */
  private endNear = false;
  /** I-184: since when she has been held nearer than the gate (null: not now), and how long it was at the let-go (ms). */
  private nearSince: number | null = null;
  private endNearHeldMs = 0;
  /** 2026-11-23: the action she was doing when this press began (null: none), and the tug while it is small (its press point). */
  private during: ActionKind | null = null;
  private tug: { kind: ActionKind; anchor: { x: number; y: number } } | null = null;
  private pressPoint: { x: number; y: number } | null = null;

  constructor(private readonly ports: UnboundPullPorts, private readonly knobs = PULL_KNOBS, private readonly stick: StickKnobs = STICK_KNOBS,
    private readonly ends: ActionEndKnobs = ACTION_END_KNOBS) {
    this.session = new PullSession({ report: report => this.send(report) });
    this.judge = new PressJudge(stick);
    this.drive = new StickDrive({ viewerDistanceM: () => this.ports.viewerDistanceM?.() ?? 0.55, clampX: (x, depth) => this.ports.clampX(x, depth), clampDepth: depth => this.ports.clampDepth(depth) }, stick);
  }

  /** A press on her is in hand (it may still be a click or a touch) or a pull is going on: her own things yield. */
  get active(): boolean { return this.running || this.holding || !!this.tug; }
  private get running(): boolean { return this.session.phase !== 'idle'; }
  /** A real pull (not a press in hand, not a tug during an action). */
  get pulling(): boolean { return this.session.phase === 'pulling' && this.answer !== false && !this.tug; }
  /** 2026-11-23: a small press or pull on her while she does something (the action goes on). */
  get tugging(): boolean { return !!this.tug; }
  /** A press on her body or head that has not become a pull (nor a touch): it may still be a click, a touch (held still) or a pull. */
  private get holding(): boolean { return this.judge.phase === 'pending' || this.judge.phase === 'touched'; }

  /** A left press (window px). True when it is on her (a pull may follow; a quick one stays a click). */
  down(x: number, y: number): boolean {
    this.cancel();
    const figure = this.ports.eligible() ? this.ports.figure() : null;
    const hit = figure?.pullHit(this.ports.view(), x, y) ?? null;
    if (!figure || !hit || this.ports.refuse?.(hit.group) === true) return false;
    this.begin(figure, hit, { x, y });
    try { this.during = this.ports.action?.() ?? null; } catch { this.during = null; }
    if (hit.group === 'arm' || hit.group === 'leg') return this.session.down(x, y, this.pressedAt, { part: hit.part, side: hit.side }, hit.heightPx);
    this.mode = 'stick'; this.judge.down(x, y, this.pressedAt); // her body or head (hair): the joystick, once the pointer leaves the dead zone
    return true;
  }

  private begin(figure: UnboundPullFigure, hit: StagePullHit, at: { x: number; y: number } | null): void {
    this.figure = figure; this.hit = hit; this.last = at; this.pressPoint = at; this.pressedAt = this.ports.clock(); this.mode = 'limb'; this.dotShown = false; this.during = null; this.tug = null;
    this.answer = null; this.asking = false; this.following = false; this.endPlace = null; this.endNear = false; this.nearSince = null; this.endNearHeldMs = 0;
    this.wheelPending = 0; this.drive.reset();
  }

  move(x: number, y: number): void {
    if (this.tug) { this.tugMove(x, y); return; }
    if (this.holding) { if (this.judge.move(x, y) === 'started') { if (this.during) this.startTug(x, y); else this.startStick(x, y); } return; }
    if (!this.running) return;
    this.last = { x, y };
    if (this.session.move(x, y, this.ports.clock()) === 'started') { if (this.during && this.mode === 'limb') this.startTug(x, y); else this.ask(); }
  }

  /** 2026-11-23: a press left the dead zone while she does something: a tug first (her body gives a little, the action goes on). */
  private startTug(x: number, y: number): void {
    const figure = this.figure, hit = this.hit, anchor = this.mode === 'limb' ? this.pressPoint : this.judge.anchor, kind = this.during;
    if (!figure || !hit || !anchor || !kind) { this.drop(); return; }
    this.tug = { kind, anchor: { x: anchor.x, y: anchor.y } };
    figure.setPullStance(null);
    if (!figure.pullStart(hit, this.ports.view())) { this.tug = null; this.drop(); return; }
    this.tugMove(x, y);
  }
  /** Small: the body follows the pointer, held inside the tug's radius (bounded). Large: the action ends and this is the pull from here. */
  private tugMove(x: number, y: number): void {
    const tug = this.tug!;
    this.last = { x, y };
    if (pressSize(x - tug.anchor.x, y - tug.anchor.y, this.ends) === 'pull') {
      this.tug = null; this.during = null;
      try { this.ports.endAction?.(tug.kind); } catch { /* the pull goes on regardless */ }
      if (this.mode === 'limb') this.ask(); else this.startStick(x, y); // exactly the pull as it works when she is free
      return;
    }
    const at = tugTarget(tug.anchor, { x, y }, this.hit?.heightPx ?? 0, this.ends);
    this.figure?.pullTo(this.ports.view(), at.x, at.y);
  }
  /** The tug let go (or cancelled): her body eases back; nothing was sent, nothing is reported. */
  private endTug(): void {
    const figure = this.figure;
    this.tug = null;
    try { figure?.pullEnd(); } catch { /* a figure that went */ }
    if (this.running) this.session.drop();
    this.judge.cancel(); this.release(false);
  }

  /** The pointer left the dead zone: this press is a pull now (never a touch, and no click is reported for it). */
  private startStick(x: number, y: number): void {
    const anchor = this.judge.anchor, hit = this.hit, now = this.ports.clock();
    if (!anchor || !hit) { this.drop(); return; }
    this.last = { x, y }; this.pressedAt = now;
    this.session.down(anchor.x, anchor.y, now, { part: hit.part, side: hit.side }, hit.heightPx);
    if (this.session.move(x, y, now) === 'started' || this.session.begin()) { this.showDot(anchor); this.ask(); }
  }

  /** I-196: the wheel over her is the same walk in steps (a forward turn: closer). It is a short pull of its own that ends when the wheel stops. */
  wheel(x: number, y: number, deltaY: number, deltaMode = 0): void {
    const notches = wheelNotches(deltaY, deltaMode), now = this.ports.clock();
    if (notches === 0) return;
    if (this.mode === 'wheel' && this.running) { this.wheelPending += notches; this.lastWheelAt = now; return; }
    if (this.running || this.holding || this.tug) return; // a press in hand owns her
    let doing: ActionKind | null = null;
    try { doing = this.ports.action?.() ?? null; } catch { doing = null; }
    if (doing) return; // 2026-11-23: while she does something the wheel neither ends it nor walks her
    const figure = this.ports.eligible() ? this.ports.figure() : null, hit = figure?.pullHit(this.ports.view(), x, y) ?? null;
    if (!figure || !hit || this.ports.refuse?.(hit.group) === true) return;
    this.begin(figure, hit, null); this.mode = 'wheel';
    this.session.down(x, y, this.pressedAt, { part: hit.part, side: hit.side }, hit.heightPx);
    if (!this.session.begin()) return;
    this.wheelPending = notches; this.lastWheelAt = now;
    this.ask();
  }

  private showDot(at: { x: number; y: number }): void { if (!this.dotShown) { this.dotShown = true; this.ports.dot?.show(at.x, at.y); } }

  /** Every animation frame: a held press may become a touch; "still holding"; the body follows the mouse; she walks along; her attitude. */
  frame(): void {
    if (this.tug) { if (!this.ports.eligible() || this.ports.figure() !== this.figure) this.endTug(); return; }
    if (this.holding) { this.holdFrame(); return; }
    if (!this.running) return;
    if (!this.ports.eligible() || this.ports.figure() !== this.figure) { this.cancel(); return; }
    const now = this.ports.clock();
    if (this.session.tick(now) === 'started') this.ask();
    if (this.session.phase !== 'pulling' || !this.answer) return;
    const figure = this.figure!, view = this.ports.view();
    if (this.last && now >= this.followFrom) figure.pullTo(view, this.last.x, this.last.y);
    this.walk(figure, now);
    // I-184: how long you have held her at the nearest (nearer than the gate): a let-go after a hold there lets her decide what to do.
    const stations = this.ports.near?.() ?? null;
    if (stations && -figure.rootM.z < stations.gateDepthM) this.nearSince ??= now; else this.nearSince = null;
    const steps = (figure.report?.steps ?? this.stepsAtStart) - this.stepsAtStart;
    if (steps > 0) this.session.walked(steps);
    this.attitude(figure, now);
    if (this.mode === 'wheel' && this.running && now - this.lastWheelAt > this.stick.wheelIdleMs) this.finish(() => this.session.up(now)); // the wheel stopped: this pull is over
  }

  /** A press held still on her (past the hold time, inside the dead zone): one touch; the dot goes. Nothing else here is a touch. */
  private holdFrame(): void {
    if (!this.ports.eligible() || this.ports.figure() !== this.figure) { this.cancel(); return; }
    const now = this.ports.clock(), anchor = this.judge.anchor;
    if (this.judge.tick(now) === 'touch') { this.ports.dot?.hide(); this.ports.holdTouch?.(); }
    else if (anchor && this.judge.phase === 'pending' && now - this.pressedAt >= DOT_AFTER_MS) this.showDot(anchor);
  }

  up(): void {
    if (this.tug) { this.endTug(); return; }
    if (this.holding) { this.drop(); return; } // a click (the page's ClickReporter reports it) or a touch already made: not a pull, nothing to report
    this.finish(() => this.session.up(this.ports.clock()));
  }
  /** Esc, hidden, the window stopped taking the mouse, a peek, the model changed. */
  cancel(): void {
    if (this.tug) { this.endTug(); return; }
    if (this.holding) { this.drop(); return; }
    if (this.running) this.finish(() => this.session.cancel(this.ports.clock()));
  }
  /** A press that never became a pull: forgotten without a report. */
  private drop(): void { this.judge.cancel(); this.release(false); }

  private ask(): void {
    if (this.asking || this.answer !== null) return;
    this.asking = true;
    const hit = this.hit, figure = this.figure;
    void Promise.resolve().then(() => this.ports.send({ phase: 'start' })).then(answer => {
      this.asking = false;
      if (this.session.phase !== 'pulling' || this.hit !== hit) return;
      if (!answer || !answer.accepted) { this.answer = false; this.session.drop(); this.release(false); return; }
      this.answer = answer;
      this.stepsAtStart = figure?.report?.steps ?? 0;
      this.followFrom = this.ports.clock() + (answer.stance?.hesitateMs ?? 0);
      figure?.setPullStance(answer.stance ? { compliance: answer.stance.compliance, pace: answer.stance.pace } : null);
      if (!hit || !figure?.pullStart(hit, this.ports.view())) { this.cancel(); return; }
      if (this.mode === 'limb' && hit.group === 'leg' && hit.side) figure.setStance(hit.side === 'left' ? 'right' : 'left'); // weight onto the other foot first
    }, () => { this.asking = false; this.answer = false; this.session.drop(); this.release(false); });
  }

  /** Her feet follow: the stick or the wheel (her body or head), or an arm's sideways pull. */
  private walk(figure: UnboundPullFigure, now: number): void {
    if (this.mode === 'limb') { this.walkAlong(figure); return; }
    if (now < this.followFrom) return; // she hesitates first, as she does for any pull
    const anchor = this.judge.anchor, last = this.last;
    const offset = this.mode === 'stick' && anchor && last ? { dx: last.x - anchor.x, dy: last.y - anchor.y } : null;
    const notches = this.wheelPending; this.wheelPending = 0;
    this.drive.frame(figure, offset, notches);
  }

  /** Holding an arm: past a small share of her height sideways she steps that way (the arm's pull shows it). Up and down only move the arm. */
  private walkAlong(figure: UnboundPullFigure): void {
    if (this.hit?.group !== 'arm') return;
    const shown = figure.pullShownM(), root = figure.rootM, start = this.knobs.followStartShare * figure.heightM;
    if (Math.abs(shown.x) > start) {
      this.following = true;
      figure.followTo({ x: this.ports.clampX(root.x + shown.x - Math.sign(shown.x) * start, -root.z), z: root.z });
    } else if (this.following) { this.following = false; figure.followTo(root); }
  }

  private attitude(figure: UnboundPullFigure, now: number): void {
    const answer = this.answer;
    if (!answer || !answer.stance) return;
    const stance = answer.stance, strength = this.session.strength, sleepy = answer.sleepy ?? 0;
    const attitude = pullAttitudeNow(stance, strength, now - this.pressedAt, sleepy);
    if (attitude === 'slip') {
      figure.setPullStance({ compliance: pullGiveNow(stance, strength), pace: stance.pace * SLIP_PACE });
      this.finish(() => this.session.breakFree(now));
      return;
    }
    if (attitude === 'pull-back') this.session.respond('pulled-back');
    figure.setPullStance({ compliance: pullGiveNow(stance, strength), pace: stance.pace });
  }

  /** Ends the pull: where she stands (if she walked along) goes with the end report; the body eases back from what shows. */
  private finish(end: () => void): void {
    const figure = this.figure, walked = (figure?.report?.steps ?? this.stepsAtStart) - this.stepsAtStart > 0;
    const started = this.answer !== null && this.answer !== false;
    if (figure && started) {
      const root = figure.rootM;
      this.endPlace = walked ? { xM: root.x, depthM: -root.z } : null;
      const moved = this.following || this.drive.active;
      this.drive.stop(figure); // the stick's goal goes; she brakes where she is
      if (this.following || walked) figure.followTo(root); // she stays where she is (the host makes it her place)
      const stations = this.ports.near?.() ?? null, outcome = walked || moved ? nearOutcome(-root.z, stations) : 'stay';
      if (stations && outcome !== 'stay') { // I-159 E: nearer than the face station she does not stay: back to it (after the peek, at the eyes)
        const x = this.ports.clampX(root.x, stations.faceDepthM);
        this.endPlace = { xM: x, depthM: stations.faceDepthM }; this.endNear = outcome === 'eyes';
        this.endNearHeldMs = this.endNear && this.nearSince !== null ? Math.max(0, this.ports.clock() - this.nearSince) : 0;
        if (outcome === 'face') figure.followTo({ x, z: -stations.faceDepthM });
        this.ports.nearEnd?.(outcome, { x, z: -stations.faceDepthM });
      }
    }
    end();
    this.release(started);
  }

  private release(started: boolean): void {
    const figure = this.figure, hit = this.hit;
    if (started && figure) {
      figure.pullEnd();
      if (hit?.group === 'leg') figure.setStance('both');
    }
    this.hit = null; this.figure = null; this.last = null; this.following = false; this.drive.reset(); this.wheelPending = 0;
    this.judge.cancel(); this.dotShown = false; this.ports.dot?.hide();
    if (!this.running) this.answer = null;
  }

  private send(report: PullReport): void {
    // Only for a pull the host took (it said yes); a refused one is dropped without a word.
    if (this.answer === false) return;
    const place = report.ended === 'holding' ? null : this.endPlace;
    const near = report.ended !== 'holding' && this.endNear, stick = this.mode !== 'limb'; // I-196: the joystick and the wheel are pulls, never touches
    void Promise.resolve().then(() => this.ports.send(pullReportMessage(report, place, near, near ? this.endNearHeldMs : 0, stick))).catch(() => {});
  }
}
