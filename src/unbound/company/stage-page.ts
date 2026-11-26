/**
 * I-209 step 3: her page's part
 * of the shared stage. Every character on stage is her own full screen (this same page, her own window); the stage coordinator in the host
 * (electron/unbound/company/stage.ts) tells each page where the others stand. Here, every frame:
 *
 *  - before her body moves: whatever set her goal this frame (her own walk, your pull, her close moment, her words' steps) is kept clear
 *    of the others (keepApart): she stops where they touch, never walks into anyone; someone coming at her while she is free makes her
 *    step aside first (asideGoal), and when she cannot (the screen's edge), the one coming stops at contact on her own page;
 *  - she is sent back: she walks out of the screen on her nearer side, then says so (her window closes);
 *  - her body goes to the coordinator (about 20 times a second while she moves, twice a second while she stands);
 *  - the frame-cost guard (step 1) counts the frames while two or more are on stage;
 *  - (2026-11-25) her camera frames her own body, alone or not (`camera`).
 * Alone on stage (the coordinator's view says one, or no view yet) nothing here moves her and no body is reported: the page is what it was.
 * All motion here is goals for her gait (she walks, at her walking speed at most); nothing sets a bone or a position (R29: no teleporting).
 */
import { Vector3 } from 'three';
import type { UnboundCompanyApi } from '../../../electron/unbound/company/preload-api';
import { asideGoal, keepApart, obstaclesFor, parseStageView, type StageBody, type StageView } from '../../../shared/unbound/company/bodies';
import { CompanyGuard } from '../../../shared/unbound/company/guard';
import { ExtraPace, FULL_PACE, type OwnInvolvement, type PaceDecision } from '../../../shared/unbound/company/extra-pace';
import { FrameSampler } from '../../../shared/unbound/company/frame-sampler';
import { placementAcross } from '../../../shared/unbound/world';
import type { UnboundScene } from '../../../shared/unbound/scene';
import type { UnboundWorld } from '../../../shared/unbound/scene';
import type { Frustum } from '../../../shared/unbound/world';
import type { FloorFraming, FramedFigure } from '../floor-framing';

/** The figure as the stage reads and steers it (UnboundFigure). */
export interface StageFigure {
  readonly rootM: { x: number; z: number };
  readonly goalM: { x: number; z: number };
  readonly velocityM: { x: number; z: number };
  readonly heightM: number;
  readonly walking: boolean;
  readonly mesh: { readonly skeleton: { readonly bones: readonly { getWorldPosition(target: Vector3): Vector3 }[] } };
  followTo(point: { x: number; z: number }): void;
}
export interface StagePageEnv {
  api: Pick<UnboundCompanyApi, 'stageBody' | 'stageLeft' | 'onStage' | 'companyGuard' | 'stageFrames'> | null;
  figure(): StageFigure | null;
  scene(): UnboundScene | null;
  /** Her face's height above her floor (m), once measured (FloorFraming.faceHeightM). */
  faceM(): number | null;
  /** The close-up eye's dip her kiss asks now (Director.cameraDipM). */
  dipM(): number;
  /** A close moment of hers plays (Director.active). */
  closing(): boolean;
  /** You are pulling her. */
  pulled(): boolean;
  /** Something of hers or yours moves her now (her own walk, an act, her words' steps, the walk back to her face station, a pull, a close moment). */
  occupied(): boolean;
  /** World units per metre (UNITS_PER_M). */
  unitsPerM: number;
  /** 三人同框别卡: what she is doing now that keeps her at full rate (she speaks, is touched, walks, plays a close moment, dances). Absent: she always draws at full rate. */
  involvement?(): OwnInvolvement;
}

export const STAGE_PAGE_KNOBS = Object.freeze({
  /** Report at most this often while she moves, and at least this often while she stands (ms). */
  moveReportMs: 50, stillReportMs: 500,
  /** How often she looks whether to step aside (ms), and how often her width is measured again (ms). */
  asideEveryMs: 150, radiusEveryMs: 500,
  /** Her width beyond her bones (skin, sleeves, hair's ends; m), and its bounds (m). */
  radiusPadM: 0.05, radiusMinM: 0.15, radiusMaxM: 0.6,
  /** Where she may stand across the screen (as the saved places), and just outside it (where she walks out to). */
  across: Object.freeze([0.07, 0.93] as const), outAcross: Object.freeze([-0.15, 1.15] as const),
  /** How near and how far back a step aside may take her (m behind the screen): not into the lens's close-up, not out of the room. */
  depths: Object.freeze([1.5, 20] as const),
  /** A sent-back walk gives up after this (ms); the host closes her window anyway a little later. */
  leaveMs: 7_000,
  /** The IPC on top of a view's age (s), for the prediction. */
  ipcS: 0.03,
});

export class StagePage {
  private view: StageView | null = null;
  private receivedAt = 0;
  private readonly guard = new CompanyGuard();
  private guardPresent = 1;
  private aside: { x: number; z: number } | null = null;
  private leaving: { x: number; z: number; since: number; told: boolean } | null = null;
  private lastReport = -1e9;
  private lastKey = '';
  private lastAsideLook = -1e9;
  private radius = 0.25;
  private radiusAt = -1e9;
  private readonly scratch = new Vector3();
  private wanted: { x: number; z: number } | null = null;
  private readonly extraPace = new ExtraPace();
  private readonly sampler = new FrameSampler();
  private focused = true;
  private decided: PaceDecision = FULL_PACE;  /** Frames where her goal was held short of someone (tests, the probe). */
  held = 0;

  constructor(private readonly env: StagePageEnv) {}

  /** Listen to the coordinator (once her page runs). */
  start(): void { this.env.api?.onStage(value => this.receive(value, performance.now())); }
  /** The coordinator's view (tests call it directly). */
  receive(value: unknown, now: number): void {
    const view = parseStageView(value);
    if (!view) return;
    this.view = view; this.receivedAt = now;
    if (view.present !== this.guardPresent) { this.guardPresent = view.present; this.guard.changed(now, view.present); }
    if (view.present < 2) { this.aside = null; }
  }

  /** The last pace this page asked for, and whether the stage says you are with her (the probe, tests). */
  get lastPace(): PaceDecision { return this.decided; }
  get isFocused(): boolean { return this.focused; }
  /** How many are on stage (1 before any view). */
  get present(): number { return this.view?.present ?? 1; }
  /** Anything of the stage's own moving her (her step aside, her walk out): the frame-rate governor draws at the full rate. */
  get busy(): boolean { return !!this.aside || !!this.leaving; }
  /** The others as the coordinator last said (tests, the probe). */
  get others(): StageView['others'] { return this.view?.others ?? []; }

  /**
   * Her camera, every frame after her body's frame (2026-11-25): alone or with others, her window frames HER OWN body against the one floor line every window shares (the work area's
   * bottom), exactly as alone: her feet stay on it wherever she stands, and nobody else's depth ever moves her camera. Step 3 framed every
   * window by the nearest one's body; pulling one nearer then lowered and raised everyone else on screen.
   */
  camera(dt: number, framing: Pick<FloorFraming, 'follow'>, world: UnboundWorld | null, figure: FramedFigure | null, nearM: number | undefined, dipM: number): Frustum | null {
    return framing.follow(dt, world, figure, nearM, dipM);
  }
  /**
   * 三人同框别卡 (shared/unbound/company/extra-pace.ts), every animation frame before she is admitted: the one you are with draws as she
   * always did; an idle extra draws at most idleFps frames a second and, once settled, one pixel tier lower. Alone on stage: always full.
   */
  pace(now: number): PaceDecision {
    const view = this.view, own = this.env.involvement?.();
    this.focused = !view || view.focus === undefined || view.focus === view.self;
    if (!own) return this.decided = FULL_PACE;
    return this.decided = this.extraPace.step(now, this.present, { focused: this.focused, ...own });
  }

  /** The frame-cost guard and the frame-time row (every drawn frame): once a minute the page's numbers go to the host's journal. */
  feed(now: number, intervalMs: number, fps: number, tier: string): void {
    const verdict = this.guard.feed(now, intervalMs, fps);
    if (verdict) void this.env.api?.companyGuard(verdict).catch(() => {});
    const minute = this.sampler.feed(now, intervalMs, this.decided.idle);
    if (minute) void this.env.api?.stageFrames({ ...minute, tier, withYou: this.focused }).catch(() => {});
  }

  /** Every frame, after everything that sets her goal and before her body's frame. */
  frame(now: number): void {
    const figure = this.env.figure(), view = this.view, scene = this.env.scene();
    if (!figure || !view || view.present < 2 || !scene) { this.aside = null; return; }
    const lead = (now - this.receivedAt) / 1000 + STAGE_PAGE_KNOBS.ipcS;
    // Her width is measured while she stands (a walking arm swing is not her width; her reach while she stands, a kiss or a hug, is).
    if (now - this.radiusAt >= STAGE_PAGE_KNOBS.radiusEveryMs && !figure.walking) { this.radius = this.measureRadius(figure); this.radiusAt = now; }
    const root = figure.rootM, depth = -root.z, world = scene.world;
    const bounds = { minX: placementAcross(world, STAGE_PAGE_KNOBS.across[0], depth).xM, maxX: placementAcross(world, STAGE_PAGE_KNOBS.across[1], depth).xM,
      minDepthM: STAGE_PAGE_KNOBS.depths[0], maxDepthM: STAGE_PAGE_KNOBS.depths[1] };
    const occupied = this.env.occupied();
    // She is sent back: she walks out on her nearer side (the others still kept clear of), then says so once.
    if (view.leave) {
      if (!this.leaving) { const right = root.x >= 0; this.leaving = { x: placementAcross(world, STAGE_PAGE_KNOBS.outAcross[right ? 1 : 0], depth).xM, z: root.z, since: now, told: false }; }
      if (!occupied) figure.followTo({ x: this.leaving.x, z: this.leaving.z });
      const out = Math.abs(root.x - this.leaving.x) < 0.15 || now - this.leaving.since > STAGE_PAGE_KNOBS.leaveMs;
      if (out && !this.leaving.told) { this.leaving.told = true; void this.env.api?.stageLeft().catch(() => {}); }
    } else this.leaving = null;
    // Someone coming at her while she is free: a step aside (looked at every asideEveryMs; a pull, her own walk or her moment takes over).
    if (occupied) this.aside = null;
    else if (!this.leaving && now - this.lastAsideLook >= STAGE_PAGE_KNOBS.asideEveryMs) {
      this.lastAsideLook = now;
      const goal = this.aside ? null : asideGoal(this.body(figure, true), view.others, bounds, lead);
      if (goal) { this.aside = goal; figure.followTo(goal); }
    }
    // Whatever set her goal, never into anyone.
    const goal = figure.goalM, kept = keepApart(root, goal, obstaclesFor(this.radius, view.others, lead));
    this.wanted = goal; // the way she wants to go (reported: the one in her way can step out of it), even while held short
    if (kept !== goal) { figure.followTo(kept); this.held++; }
    // Her step aside ended: that is her place now (the host keeps it, so nothing walks her back).
    let arrived = false;
    if (this.aside && !figure.walking && Math.hypot(root.x - this.aside.x, root.z - this.aside.z) < 0.04) { this.aside = null; arrived = true; }
    this.report(now, figure, arrived);
  }

  private body(figure: StageFigure, free: boolean): StageBody {
    const root = figure.rootM, v = figure.velocityM, height = figure.heightM;
    return { xM: root.x, depthM: -root.z, radiusM: this.radius, heightM: height > 0 ? height : 1.6, faceM: Math.max(0, this.env.faceM() ?? height * 0.92),
      dipM: Math.min(1, Math.max(0, this.env.dipM() || 0)), vxM: Math.max(-20, Math.min(20, v.x || 0)), vdM: Math.max(-20, Math.min(20, -(v.z || 0))),
      pulled: this.env.pulled(), closing: this.env.closing(), free, ...this.goalOf(figure) };
  }

  private report(now: number, figure: StageFigure, arrived: boolean): void {
    const free = !this.env.occupied() && !this.leaving && !this.aside;
    const body = this.body(figure, free), moving = Math.hypot(body.vxM, body.vdM) > 0.02;
    const key = `${body.pulled}${body.closing}${body.free}`;
    const due = arrived || key !== this.lastKey || now - this.lastReport >= (moving ? STAGE_PAGE_KNOBS.moveReportMs : STAGE_PAGE_KNOBS.stillReportMs);
    if (!due) return;
    this.lastReport = now; this.lastKey = key;
    void this.env.api?.stageBody({ ...body, ...(arrived ? { arrived: true } : {}) }).catch(() => {});
  }

  /** Her goal when it is away from her root (the way she is going: the one she walks at can step out of it). */
  private goalOf(figure: StageFigure): { goal?: { xM: number; depthM: number } } {
    const g = this.wanted ?? figure.goalM, r = figure.rootM;
    return Number.isFinite(g.x) && Number.isFinite(g.z) && Math.hypot(g.x - r.x, g.z - r.z) > 0.05 ? { goal: { xM: g.x, depthM: -g.z } } : {};
  }

  /** Half her width round her root now: the farthest of her bones across the floor (hair and hands included), plus skin and sleeves. */
  private measureRadius(figure: StageFigure): number {
    const root = figure.rootM, k = this.env.unitsPerM, height = figure.heightM > 0 ? figure.heightM : 1.6;
    let far = 0;
    for (const bone of figure.mesh.skeleton.bones) {
      const p = bone.getWorldPosition(this.scratch), y = p.y / k;
      const d = Math.hypot(p.x / k - root.x, p.z / k - root.z);
      // Only what is part of her body: a helper bone left below the floor or off in the air (a physics weight with no physics) is not her width.
      if (Number.isFinite(d) && y > -0.05 && y < height * 1.3 && d < height * 0.5 && d > far) far = d;
    }
    const r = far + STAGE_PAGE_KNOBS.radiusPadM;
    return Math.min(STAGE_PAGE_KNOBS.radiusMaxM, Math.max(STAGE_PAGE_KNOBS.radiusMinM, r));
  }
}
