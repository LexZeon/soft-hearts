/**
 * I-185: a kiss or a hug from her reply where she does not walk: the companion window (window-mode does not walk; she does it where she
 * stands), and the lighter hug any stage plays when the real one cannot (lean in, arms open a little). The same plan and curves as the
 * full-screen performance (plan.ts, timeline.ts), without the walk:
 *   lean   leanChannels, scaled (`lean`): a kiss closes her eyes and puckers (PuckerGate: only in a pause, never while she speaks), a small
 *          head tilt; a hug brings her arms forward and wraps them in ('full'), only opens them a little ('small'), or not at all ('none')
 *   hold   the plan's hold (her own length, I-192), on while she speaks up to the cap and a moment after so the pucker shows (arrival/hold.ts)
 *   back   backChannels: the act eases back while the after-beat comes in (a cancel: from where every channel is, carrying its speed)
 *   settle settleChannels: everything fades to rest
 * Her arms give way (eased) while a game, an offer or her reach holds them, as on the full-screen stage. Pure: the caller gives dt.
 */
import type { MoodReading } from '../director';
import { chooseAfterBeat } from './after-beat';
import { planCloseMoment, type CloseMomentPlan } from './plan';
import { PuckerGate, REST_CHANNELS, SETTLE_FADE_S, S5, backChannels, backLength, leanChannels, settleChannels, type CloseChannels } from './timeline';
import type { CloseMomentKnobs } from './knobs';
import { HoldClock, holdGoesOn } from '../arrival';
import { HoldFrames } from './frames';

export type InPlaceArms = 'full' | 'small' | 'none';
export const IN_PLACE = Object.freeze({
  /** The window's lean, of the full-screen plan's (her body is framed closer in the window). */
  windowLean: 0.55,
  /** The lighter hug: its lean and how far her arms open (of a full hug's weight; never wrapped). */
  smallLean: 0.45, smallArms: 0.35,
  /** Seconds for her arms to give way when something takes them (or come back). */
  armsGateS: 0.4,
  /** I-203: the in-place lean and the way back keep their own pace (the full-screen one follows the storyboard). */
  approachS: Object.freeze({ kiss: 1.3, hug: 2.0 }), backS: 1.25,
});
/** A calm reading (no mood of its own here: the window page plans locally; the after-beat is a neutral card's). */
export const NEUTRAL_READING: Readonly<MoodReading> = Object.freeze({ D: 50, O: 50, E: 50, N: 50, C: 50, A: 0.2, B: 0, M: 0 });

/** A plan for an in-place kiss or hug (`random` in [0, 1)). */
export function inPlacePlan(kind: 'kiss' | 'hug', random: () => number, knobs?: CloseMomentKnobs): CloseMomentPlan {
  const after = chooseAfterBeat({ mood: NEUTRAL_READING, label: null }, random());
  const plan = planCloseMoment({ kind, after, via: 'chat', mood: NEUTRAL_READING, label: null, ...(knobs ? { knobs } : {}) }, random);
  // I-203 sped up the full-screen rhythm (the storyboard's ~1.7 s); the window keeps its small in-place version's own pace (a hug's arms in
  // place take longer to come round than a walk-up's lean).
  return { ...plan, approachS: IN_PLACE.approachS[kind], backS: IN_PLACE.backS };
}

export type InPlacePhase = 'lean' | 'hold' | 'back' | 'settle' | 'done';
export interface InPlaceFrame {
  /** Every channel as shown (lean and tilt already scaled; arms and wrap as her arms show them). */
  channels: CloseChannels;
  /** The pucker as shown (PuckerGate). */
  pucker: number;
  phase: InPlacePhase;
}

export class InPlaceClose {
  phase: InPlacePhase = 'lean';
  private t = 0;
  private since = 0;
  private shown: CloseChannels = { ...REST_CHANNELS };
  private before: CloseChannels = { ...REST_CHANNELS };
  private from: CloseChannels = { ...REST_CHANNELS };
  private lastStep = 0;
  private velocity: Partial<CloseChannels> | null = null;
  private cancelled = false;
  private readonly pucker = new PuckerGate();
  private armsOk = 1;
  private hold = new HoldClock();
  /** It reached its hold (once). */
  held = false;
  /** I-203: her let-go (the companion window maps ⟦let-go⟧ here: she lets go at that point in her words). */
  private readonly frames = new HoldFrames();

  constructor(readonly plan: CloseMomentPlan, readonly options: { arms: InPlaceArms; lean: number }) {}

  /** I-203 ⟦let-go⟧: holding: she lets go now (a planned way back, not a cancel); still leaning in: once she has held the floor. */
  letGo(): void { if (this.phase === 'lean' || this.phase === 'hold') this.frames.letGo(this.phase === 'hold' ? this.beat : null); }

  get active(): boolean { return this.phase !== 'done'; }
  get kind(): CloseMomentPlan['kind'] { return this.plan.kind; }
  private get beat(): number { return this.t - this.since; }
  private go(phase: InPlacePhase): void { this.phase = phase; this.since = this.t; }

  /** A new reply, a stop, asleep, a lost scope: back from wherever every channel is, each carrying its speed ("禁止只是不开始新的动作"). */
  cancel(): void {
    if (this.cancelled || this.phase === 'back' || this.phase === 'settle' || this.phase === 'done') return;
    this.cancelled = true;
    this.from = { ...this.shown };
    const step = this.lastStep, before = this.before, shown = this.shown;
    this.velocity = step > 0 ? Object.fromEntries((Object.keys(shown) as (keyof CloseChannels)[]).map(key => [key, (shown[key] - before[key]) / step])) : null;
    this.go('back');
  }

  /** One frame. `mouth`: I-175's "may a closed-mouth shape start now" and the held "she is speaking"; `armsFree`: nothing holds her arms. */
  frame(dt: number, mouth: { mayStart: boolean; speaking: boolean }, armsFree: boolean): InPlaceFrame {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.t += step;
    const plan = this.plan;
    let act: CloseChannels;
    switch (this.phase) {
      case 'lean':
        act = this.scaled(leanChannels(plan, this.beat));
        if (this.beat >= plan.approachS) { this.go('hold'); this.hold = new HoldClock(); }
        break;
      case 'hold':
        act = this.scaled(leanChannels(plan, plan.approachS));
        this.held = true;
        this.hold.frame(step, mouth.speaking);
        if (!this.frames.goesOn(holdGoesOn(this.hold.state(plan.holdS, mouth.speaking)), this.hold.beat, this.t)) { this.from = { ...act }; this.go('back'); }
        break;
      case 'back':
        act = backChannels(plan, this.from, this.beat, this.cancelled, this.velocity);
        if (this.beat >= backLength(plan, this.cancelled)) { this.from = { ...act }; this.go('settle'); }
        break;
      case 'settle':
        act = settleChannels(this.from, this.beat);
        if (this.beat >= SETTLE_FADE_S) this.go('done');
        break;
      default:
        act = { ...REST_CHANNELS };
    }
    this.before = this.shown; this.shown = act; this.lastStep = step;
    const pucker = this.pucker.frame(step, act.pucker, mouth.mayStart, mouth.speaking);
    this.armsOk = Math.min(1, Math.max(0, this.armsOk + (armsFree ? 1 : -1) * step / IN_PLACE.armsGateS));
    const arms = act.arms * S5(this.armsOk);
    return { channels: { ...act, arms, wrap: arms > 1e-4 ? act.wrap : 0 }, pucker, phase: this.phase };
  }

  /** The act's channels at this stage's size: lean and tilt scaled, the arms by `options.arms` ('small': open, never wrapped). */
  private scaled(c: CloseChannels): CloseChannels {
    const lean = Math.max(0, this.options.lean), arms = this.options.arms;
    return { ...c, lean: c.lean * lean, tilt: c.tilt * lean,
      arms: arms === 'full' ? c.arms : arms === 'small' ? c.arms * IN_PLACE.smallArms : 0, wrap: arms === 'full' ? c.wrap : 0 };
  }
}
