/**
 * I-081 第 3 步 (docs/claude/2026-11-11-i081-gaze.md): the stage side of "she looks at you or at the mouse". One object the stage
 * asks once per frame, before the gaze split; it turns
 *  - the host's reading (where pose sensing says you are, window.desktop.userGaze, shared/behaviors/gaze-attention/interface.ts),
 *  - the keyed cursor offset the stage already computed,
 *  - her mood view,
 * into the raw gaze aim the stage feeds to gazeTargets (procedural.ts). The chooser (shared/behaviors/gaze-attention/choose.ts) picks
 * who she looks at; this only follows where you are and blends. I-167 (docs/claude/2026-11-21-gaze-at-user.md): your head's place
 * is keyed like the cursor (pointer-keys.ts) and the line from her eyes to your head is taken every frame, so she follows you as
 * quickly as she follows the mouse, with the same eyes-first, head-for-wider-angles split (gazeTargets); whether your head points
 * at her (looking.ts) decides eye contact and the shy look-away.
 *
 * Exactly as before I-081 while the chooser is not engaged and fully settled: `active` is false and the stage uses its own old
 * expression, byte for byte. The "look at you" moments (life's gazeBlend: a glance when you come back, answering a wave, her own
 * look-at-you moments, while she speaks) look toward `userX`, `userY` while pose knows where you are (`known`), else straight ahead
 * as before. Pure numbers; no three.js, no I/O.
 */
import { GazeAttention, gazeMoodFrom, type GazeAttentionEvent, type GazeMoodSource, type GazeReadout } from '../../shared/behaviors/gaze-attention/choose';
import { userAim, type UserGazePoint } from '../../shared/behaviors/gaze-attention/geometry';
import type { UserGazeReading } from '../../shared/behaviors/gaze-attention/interface';
import { GAZE_ATTENTION_KNOBS, type GazeAttentionKnobs } from '../../shared/behaviors/gaze-attention/knobs';
import { LookingAtHer } from '../../shared/behaviors/gaze-attention/looking';
import { PointerKeys, dampCritical, gazeTargets } from '../stage';

export interface StageGazeInput {
  readonly delta: number;
  /** "跟着鼠标看" on and she may look around (the stage's own `follow`). */
  readonly follow: boolean;
  /** The fatigue frame's gazeAllowed. */
  readonly allowed: boolean;
  /** The keyed cursor minus her eyes (the stage's old raw aim; 0 when not following). */
  readonly mouseX: number;
  readonly mouseY: number;
  /** Her projected eyes (the pointer's units). */
  readonly originX: number;
  readonly originY: number;
  readonly thinking?: boolean;
  readonly speaking?: boolean;
  /** The host's latest reading (null: none, or sensing off). */
  readonly reading: UserGazeReading | null;
  readonly mood: (GazeMoodSource & { snapshot?: { event?: { id?: string; context?: string; ageMs?: number } | null } }) | null | undefined;
}

export interface StageGazeOut {
  /** False: use the old aim exactly (mouseX, mouseY); nothing of I-081 shows. */
  readonly active: boolean;
  /** The chooser's aim (replaces mouseX, mouseY while active). */
  readonly x: number;
  readonly y: number;
  /** Where the "look at you" moments look (0, 0 = straight ahead, as before, while pose does not know where you are). */
  readonly userX: number;
  readonly userY: number;
  /**
   * The gaze split for this frame (procedural.ts gazeTargets), blended per target AFTER each is split into eyes and head: a switch
   * then moves the eyes straight from one target's share to the other's, instead of along the line between the two aims (which
   * can pass near straight ahead, where gazeTargets hands almost everything to the eyes and back: a visible wobble, measured
   * 2026-11-11 on Gene). The pull, the extras and toUser are the stage's own terms, added to every target as before.
   */
  targets(pull: number, extraX: number, extraY: number, toUser: number, hasEyes: boolean): ReturnType<typeof gazeTargets>;
}

const finite = (value: number) => Number.isFinite(value) ? value : 0;

export class StageGazeAttention {
  private readonly chooser: GazeAttention;
  private readonly aim = { x: 0, y: 0 };
  private readonly velocity = { known: 0 };
  /** I-167: where your head is (x, y) and how far (dx, dy), as keys like the cursor's. */
  private readonly place = new PointerKeys();
  private readonly depth = new PointerKeys();
  private readonly lookingAt: LookingAtHer;
  private known = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private moving = 0;
  private lastEvent: string | null = null;
  /** I-169: the newest reading's point (a reference, nothing copied; only the developer readout reads it). */
  private heard: UserGazePoint | null = null;
  private readonly out = { active: false, x: 0, y: 0, userX: 0, userY: 0, targets: (pull: number, extraX: number, extraY: number, toUser: number, hasEyes: boolean) => this.split(pull, extraX, extraY, toUser, hasEyes) };
  private readonly parts = { mouseX: 0, mouseY: 0, mouse: 1, user: 0, away: 0, awayX: 0, awayY: 0 };
  private diagnosticsAt = -Infinity;
  private diagnosticsText = 'null';
  private last: ReturnType<GazeAttention['frame']> | null = null;

  constructor(random: () => number = Math.random, private readonly knobs: GazeAttentionKnobs = GAZE_ATTENTION_KNOBS) {
    this.chooser = new GazeAttention(random, knobs);
    this.lookingAt = new LookingAtHer(knobs.looking);
  }

  frame(input: StageGazeInput): StageGazeOut {
    const dt = Number.isFinite(input.delta) ? Math.min(0.1, Math.max(0, input.delta)) : 0;
    const reading = input.reading, point = reading?.present ? reading.point : null;
    // Where you are (I-167): each new reading is a key, as the cursor's are (pointer-keys.ts: a straight line to the newest key over the
    // time the last one took), so a steadily moving head gives her look a steady speed; then the angle from her eyes to your head, each
    // frame (her eyes move with her body), turned `aim` of the way. The stage's own head / eye followers smooth it as they do the cursor.
    if (point) {
      this.heard = point;
      const at = this.place.frame(dt, point.x, point.y), far = this.depth.frame(dt, point.dx, point.dy);
      const goal = userAim({ x: at.x, y: at.y, dx: far.x, dy: far.y }, input.originX, input.originY, this.knobs.camera.aim);
      this.aim.x = goal.x; this.aim.y = goal.y;
    }
    this.known = dampCritical(this.known, point ? 1 : 0, 5, dt, this.velocity, 'known');
    if (this.known < 1e-4 && !point) { this.known = 0; this.velocity.known = 0; this.place.reset(); this.depth.reset(); }
    // I-167: whether your head points at her (eye contact and the shy look-away need it); not known without the head's direction.
    const looking = this.lookingAt.frame(dt, point, point ? reading?.turn ?? null : null, input.originX, input.originY);
    // How much the cursor moves (as procedural life measures it).
    const dx = input.mouseX - this.lastMouseX, dy = input.mouseY - this.lastMouseY;
    this.lastMouseX = finite(input.mouseX); this.lastMouseY = finite(input.mouseY);
    const speed = dt > 0 ? Math.sqrt(finite(dx) ** 2 + finite(dy) ** 2) / dt : 0, target = Math.min(1, speed / 0.6);
    this.moving += (target - this.moving) * (1 - Math.exp(-dt / (target > this.moving ? 0.08 : 1.2)));
    // A fresh warm moment (praise, support): she looks at you once.
    const event = input.mood?.snapshot?.event;
    const praised = !!event && typeof event.id === 'string' && event.id !== this.lastEvent && (event.context === 'positive' || event.context === 'support')
      && typeof event.ageMs === 'number' && event.ageMs < 3_000;
    if (event && typeof event.id === 'string') this.lastEvent = event.id;
    const frame = this.last = this.chooser.frame({ dt, allowed: input.allowed, mouse: input.follow, thinking: input.thinking, speaking: input.speaking,
      user: reading ? { present: reading.present, facing: reading.facing, energy: reading.energy, looking } : null, pointerMoving: this.moving,
      mood: gazeMoodFrom(input.mood), screen: reading?.screen ?? null, praised });
    const userX = this.known > 0 ? this.aim.x * this.known : 0, userY = this.known > 0 ? this.aim.y * this.known : 0;
    const out = this.out;
    out.active = frame.engaged || frame.mouse !== 1;
    out.userX = userX; out.userY = userY;
    const parts = this.parts;
    parts.mouseX = input.mouseX; parts.mouseY = input.mouseY; parts.mouse = frame.mouse; parts.user = frame.user; parts.away = frame.away; parts.awayX = frame.awayX; parts.awayY = frame.awayY;
    if (!out.active) { out.x = input.mouseX; out.y = input.mouseY; return out; }
    // Looking away is aside from you (when pose knows where you are), else aside from straight ahead.
    out.x = frame.mouse * input.mouseX + frame.user * userX + frame.away * (userX + frame.awayX);
    out.y = frame.mouse * input.mouseY + frame.user * userY + frame.away * (userY + frame.awayY);
    return out;
  }

  /** StageGazeOut.targets: each target split into eyes and head on its own, then blended by the chooser's weights. */
  private split(pull: number, extraX: number, extraY: number, toUser: number, hasEyes: boolean): ReturnType<typeof gazeTargets> {
    const p = this.parts, ux = this.out.userX, uy = this.out.userY;
    const addX = extraX + ux * toUser, addY = extraY + uy * toUser;
    const sum = { headWeight: 0, headX: 0, headY: 0, eyeX: 0, eyeY: 0 };
    const add = (weight: number, x: number, y: number) => {
      if (!(weight > 0)) return;
      const t = gazeTargets(x * pull + addX, y * pull + addY, hasEyes);
      sum.headWeight += weight * t.headWeight; sum.headX += weight * t.headX; sum.headY += weight * t.headY; sum.eyeX += weight * t.eyeX; sum.eyeY += weight * t.eyeY;
    };
    add(p.mouse, p.mouseX, p.mouseY);
    add(p.user, ux, uy);
    add(p.away, ux + p.awayX, uy + p.awayY);
    return sum;
  }

  takeEvents(): GazeAttentionEvent[] { return this.chooser.takeEvents(); }

  /** I-169, developer mode only: the chooser's readout and where your head is (the newest reading, the cursor's units; null while pose does not know). Read only. */
  readout(): { chosen: GazeReadout; user: UserGazePoint | null } {
    return { chosen: this.chooser.readout(), user: this.known > 0 ? this.heard : null };
  }

  /** `data-gaze-attention` text (developer checks), refreshed at most every 250 ms of the caller's clock; never coordinates. */
  diagnostics(nowMs: number): string {
    if (!(nowMs - this.diagnosticsAt < 250)) {
      this.diagnosticsAt = nowMs;
      const f = this.last, r = (value: number) => Math.round(value * 100) / 100;
      this.diagnosticsText = f ? JSON.stringify({ engaged: f.engaged, target: f.target, user: r(f.user), mouse: r(f.mouse), away: r(f.away), known: r(this.known), why: this.chooser.why }) : 'null';
    }
    return this.diagnosticsText;
  }
}
