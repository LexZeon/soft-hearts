/**
 * I-136 Unbound v1 step 5a「拉她」, the companion window's input (docs/claude/2026-11-18-unbound-step5-plan.md「5a」), with 5e (her attitude).
 *
 * PetInteraction hands it a left-button press that is not on her cheek (the cheek stays the pinch's). When the stage says the press
 * is on her (src/stage/mmd/pull.ts pullHit: not asleep, her hand not in a hand-hold), the pointer is captured like the pinch's and one
 * pull session runs (shared/behaviors/pull/session.ts): it becomes a pull after 8 px or 0.45 s, the stage's body answers while it
 * lasts, and the session's reports go to the host (preload `petTouch`; the host adds the place and its own time and checks every
 * field again). Cancelling (Esc, hidden, blur, the pointer lost, she fell asleep, the model changed) is PetInteraction's own
 * cancelContext, which ends here as 'cancelled' and the body eases back.
 *
 * 5e: when it starts, her stance comes from her mood now (shared/behaviors/pull/attitude.ts): how much she gives, how fast, a first
 * pause when you are new to each other. Every tick: on a hard pull she may pull back (less give; reported once as 'pulled-back'), and
 * on a hard, long pull she does not want she slips free (the session ends 'broke-free'; her body eases back slowly). Never scripted.
 */
import { PullSession, pullAttitudeNow, pullGiveNow, pullStanceOf, type PullGroup, type PullMoodReading, type PullReport, type PullStanceOf } from '../../shared/stage';

/** What the stage offers (src/stage/mmd/pull.ts). */
export interface PetPullStage {
  pullHit(x: number, y: number): { part: PullReport['part']; side: PullReport['side']; group: PullGroup; heightPx: number } | null;
  pullStart(hit: NonNullable<ReturnType<PetPullStage['pullHit']>>): boolean;
  pullTo(x: number, y: number): void;
  pullEnd(): void;
  pullStillAllowed(group: PullGroup): boolean;
  /** 5e: her mood now (null: none yet, she takes it plainly), and the give / pace the body layer uses. */
  pullMood?(): PullMoodReading | null;
  setPullStance?(stance: { compliance: number; pace: number } | null): void;
}
export interface PetPullOptions {
  stage: PetPullStage;
  /** preload petTouch (the host validates it again). */
  send(report: PullReport): void;
}

type Hit = NonNullable<ReturnType<PetPullStage['pullHit']>>;
/** Slipping free eases back at this share of her pace (slowly, never a pop). */
const SLIP_PACE = 0.5;

export class PetPull {
  private readonly session: PullSession;
  private pointer: number | null = null;
  private hit: Hit | null = null;
  private last: { x: number; y: number } | null = null;
  private stance: PullStanceOf | null = null;
  private sleepy = 0;
  private followFrom = 0;
  private pressedAt = 0;

  constructor(private readonly surface: HTMLElement, private readonly options: PetPullOptions, private readonly now: () => number) {
    this.session = new PullSession({ report: report => { try { options.send(report); } catch { /* a touch is never an error */ } } });
  }

  /** True while this pointer is ours (pressed or pulling). */
  owns(pointerId: number): boolean { return this.pointer !== null && pointerId === this.pointer; }
  get active(): boolean { return this.pointer !== null; }

  /** A press not on her cheek (`point`: CSS px in the surface). True when it is a press on her: the pointer is now ours. */
  press(pointerId: number, point: { x: number; y: number }): boolean {
    if (this.pointer !== null) return false;
    let hit: Hit | null = null;
    try { hit = this.options.stage.pullHit(point.x, point.y); } catch { hit = null; }
    if (!hit) return false;
    try { this.surface.setPointerCapture(pointerId); if (!this.surface.hasPointerCapture(pointerId)) return false; } catch { return false; }
    this.pointer = pointerId; this.hit = hit; this.last = { ...point }; this.pressedAt = this.now();
    this.session.down(point.x, point.y, this.pressedAt, { part: hit.part, side: hit.side }, hit.heightPx);
    return true;
  }

  move(point: { x: number; y: number }): void {
    if (this.pointer === null) return;
    this.last = { ...point };
    const phase = this.session.move(point.x, point.y, this.now());
    if (phase === 'started') this.begin();
    if ((phase === 'started' || phase === 'pulling') && this.now() >= this.followFrom) this.options.stage.pullTo(point.x, point.y);
  }

  /** The timer (PetInteraction's 100 ms): a held press becomes a pull; a long one reports "still holding" once; gates re-checked; her attitude. */
  tick(): void {
    if (this.pointer === null || !this.hit) return;
    if (this.session.phase === 'pulling' && !this.options.stage.pullStillAllowed(this.hit.group)) { this.cancel(); return; }
    if (this.session.tick(this.now()) === 'started') this.begin();
    if (this.session.phase !== 'pulling') return;
    if (this.last && this.now() >= this.followFrom) this.options.stage.pullTo(this.last.x, this.last.y);
    this.attitude();
  }

  /** The release: a pull ends 'released' (a press that never became one reports nothing). */
  release(): void {
    const pulling = this.session.phase === 'pulling';
    this.session.up(this.now());
    if (pulling) this.options.stage.pullEnd();
    this.drop();
  }

  /** Esc, hidden, blur, the pointer lost, she fell asleep, the model changed: 'cancelled'; she eases back. */
  cancel(): void {
    if (this.pointer === null) return;
    const pulling = this.session.phase === 'pulling';
    this.session.cancel(this.now());
    if (pulling) this.options.stage.pullEnd();
    this.drop();
  }

  private begin(): void {
    let mood: PullMoodReading | null = null;
    try { mood = this.options.stage.pullMood?.() ?? null; } catch { mood = null; }
    this.stance = mood ? pullStanceOf(mood) : null;
    this.sleepy = mood?.sleepy ?? 0;
    this.followFrom = this.now() + (this.stance?.hesitateMs ?? 0);
    this.options.stage.setPullStance?.(this.stance ? { compliance: this.stance.compliance, pace: this.stance.pace } : null);
    if (!this.hit || !this.options.stage.pullStart(this.hit)) this.cancel();
  }

  private attitude(): void {
    const stance = this.stance;
    if (!stance) return;
    const strength = this.session.strength, held = this.now() - this.pressedAt;
    const now = pullAttitudeNow(stance, strength, held, this.sleepy);
    if (now === 'slip') {
      this.options.stage.setPullStance?.({ compliance: pullGiveNow(stance, strength), pace: stance.pace * SLIP_PACE });
      this.session.breakFree(this.now());
      this.options.stage.pullEnd();
      this.drop();
      return;
    }
    if (now === 'pull-back') this.session.respond('pulled-back');
    this.options.stage.setPullStance?.({ compliance: pullGiveNow(stance, strength), pace: stance.pace });
  }

  private drop(): void {
    const pointer = this.pointer;
    this.pointer = null; this.hit = null; this.last = null; this.stance = null;
    if (pointer === null) return;
    try { if (this.surface.hasPointerCapture(pointer)) this.surface.releasePointerCapture(pointer); } catch { /* already released */ }
  }
}
