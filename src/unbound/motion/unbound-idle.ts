/**
 * Unbound's idle under everything else (the StayStill model, bundled-idle.ts).
 *
 * Before this, while nothing drove her the Unbound window showed the companion's stand motion and breath only (the director and her acts
 * hand the figure REST targets when they finish). Now the learned idle is laid under whatever drives her, by priority and never
 * cut:
 *   - The director (peek, the opening beat before she speaks) and her own acts keep writing their targets as before, through
 *     `wrap(figure)`; this layer remembers the last ones and adds the idle on top with a weight.
 *   - The weight is a critically damped spring toward 1 while she just stands (`idleWanted`) and toward 0 while anything else
 *     drives her, walks, turns, settles her feet or stands on one foot: it starts and ends with zero speed, a reversal half way is
 *     smooth, and the intent layer's springs filter the sum again. Nothing is ever switched in one frame.
 *   - The idle's own clock keeps running at weight 0, so it fades back in from a moving state, not from a restart.
 * Without an idle yet (the files still loading) the owner's targets pass through exactly as before. The desktop companion does not use this.
 */
import { REST_TARGETS, type BodySense, type PoseTargets } from './generator';
import { layerIdle, type LearnedIdle } from './learned-idle';
import { TalkCalm } from '../../../shared/stage';
import { idleHeadScale } from '../../../shared/behaviors/part-mix/lids-head';

/** What the director and her acts drive (UnboundFigure): the members they already use. */
export interface IdleBody { readonly sense: BodySense | null; setPoseTargets(targets: PoseTargets): void; readonly intentIdle: boolean }

/** How fast the idle comes in after something else let go, and goes when something takes over (s, roughly 10–90 %). */
export const UNBOUND_IDLE_FADE = Object.freeze({ inS: 2.5, outS: 0.6 });
/** A critically damped spring rises 10–90 % in about 3.36 / ω. */
const OMEGA_PER_RISE = 3.36;

/** Whether the idle should play now: she stands on both feet and nothing else drives her body. */
export function idleWanted(state: { performing: boolean; walking: boolean; moving: boolean; stance: string }): boolean {
  return !state.performing && !state.walking && !state.moving && (state.stance === 'both' || state.stance === 'holding');
}

export class UnboundIdleLayer {
  private idle: LearnedIdle | null = null;
  private body: IdleBody | null = null;
  private proxy: IdleBody | null = null;
  private owner: PoseTargets = { ...REST_TARGETS };
  private dirty = false;
  private layered = false;
  private w = 0;
  private v = 0;
  private generation = 0;
  /** The last sample (held while the idle's clock stands still). */
  private held: PoseTargets | null = null;
  /** I-170: while you talk, the idle's own head and neck calm (the owners' targets say `talking`); eased, any frame rate. */
  private readonly calm = new TalkCalm();
  /** How much of the idle's head motion is laid on now (I-170; 1 when nobody talks). */
  get headCalm(): number { return this.calm.value; }
  /** The source shown ('model+events', 'procedural'; null until the files are read). */
  get source(): string | null { return this.idle?.id ?? null; }
  get learned(): boolean { return this.idle?.learned ?? false; }
  /** How much of the idle is laid on now (0..1). */
  get weight(): number { return Math.min(1, Math.max(0, this.w)); }
  /** The idle's channels on the last frame (for measurements; null without an idle). */
  get channels(): Float32Array | null { return this.idle?.generator.last ?? null; }

  /** `make` builds the idle for a body of a given height (once the data it needs is there; null: none). */
  constructor(private readonly make: (heightM: number) => Promise<LearnedIdle | null>) {}

  /** A new figure: the idle starts at weight 0 and is rebuilt for her height (her previous one is dropped). */
  attach(body: IdleBody, heightM: number): void {
    const generation = ++this.generation;
    this.body = body; this.proxy = null; this.idle = null;
    this.owner = { ...REST_TARGETS }; this.dirty = false; this.layered = false; this.w = 0; this.v = 0; this.held = null; this.calm.reset();
    void this.make(heightM).then(idle => { if (generation === this.generation) this.idle = idle; }, () => { /* no idle: she stands as before */ });
  }

  /** What the director and her acts write to instead of the figure (the figure itself when it is not the attached one). */
  wrap<T extends IdleBody>(body: T): IdleBody {
    if (body !== this.body) return body;
    return this.proxy ??= {
      get sense() { return body.sense; },
      get intentIdle() { return body.intentIdle; },
      setPoseTargets: (targets: PoseTargets) => { this.owner = targets; this.dirty = true; },
    };
  }

  /** A quick move of the idle is under way (step 4: a pause waits for it to end; T-248 B1). */
  get quickBusy(): boolean { return this.idle?.quickBusy?.() ?? false; }

  /**
   * Once a frame, after the director and her acts, before her own frame: hands the figure this frame's targets. `rate` (step 4,
   * T-248 B1, 0..1): the idle's own clock runs at this rate (her pause slows it to 0 on a curve, holds, and speeds it up again): its
   * phase pauses, not its size; at a rate of (almost) 0 the last sample is held, the idle is not stepped at all.
   */
  frame(dt: number, wanted: boolean, rate = 1): void {
    const body = this.body;
    if (!body) return;
    const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    if (!this.idle) { if (this.dirty) { body.setPoseTargets(this.owner); this.dirty = false; } return; }
    const r = Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 1));
    const sample = r < 1e-3 && this.held ? this.held : (this.held = this.idle.frame(step * r));
    this.spring(wanted ? 1 : 0, step);
    const calm = this.calm.frame(step, this.owner.talking === true);
    if (this.w > 0) {
      body.setPoseTargets(layerIdle(this.owner, sample, this.weight, idleHeadScale(calm, this.owner.headHeld ?? 0))); // I-175: a nod or a tilt holds the head: her own sway yields
      this.layered = true; this.dirty = false;
    } else if (this.dirty || this.layered) {
      body.setPoseTargets(this.owner);
      this.layered = false; this.dirty = false;
    }
  }

  /** The weight's critically damped spring, stepped exactly (any frame rate gives the same curve). */
  private spring(goal: number, dt: number): void {
    if (dt <= 0) return;
    const omega = OMEGA_PER_RISE / (goal > this.w ? UNBOUND_IDLE_FADE.inS : UNBOUND_IDLE_FADE.outS);
    const x0 = this.w - goal, j = this.v + omega * x0, e = Math.exp(-omega * dt);
    this.w = goal + (x0 + j * dt) * e;
    this.v = (this.v - omega * j * dt) * e;
    if (goal === 0 && Math.abs(this.w) < 1e-4 && Math.abs(this.v) < 1e-3) { this.w = 0; this.v = 0; }
  }
}
