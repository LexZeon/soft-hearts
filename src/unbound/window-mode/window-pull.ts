/**
 * I-154 batch 1, row 29「拉她」in the companion window on Unbound's engine (docs/claude/2026-11-19-unbound-in-window.md).
 *
 * The companion's own pull input (the pull session in src/mood/: 8 px or 0.45 s, her attitude from her mood, the reports to the host)
 * talks to the stage's seven pull members; this answers them with the figure's pull layer (figure.pullHit…, the same src/stage/pull/
 * layer the old stage uses, without its legs). What she does is the old stage's pull feel: the part you hold follows within its limits,
 * her body leans, her head turns; on release, cancel or slipping free she eases back from what shows (the layer's springs). The
 * difference is her legs: they are the gait's. A pulled leg puts her weight on the other foot (the gait lifts this one a little) and
 * both feet come back on release. She never walks along here: the window mode has no walk, her place stays the origin (the gait's goal
 * is never changed; a balance step comes back to it by itself).
 *
 * Gates (the old stage's, src/stage/mmd/pull.ts):
 *  - a hit only on her own body, when she is shown: the capsule ray test of the figure that is shown now;
 *  - a pull starts only from a hit this window made for the figure shown now (a stale hit from the last model, or one made up, does not);
 *  - not while she is asleep, nor by the hand while her hand is busy (shared/behaviors/pull/gates.ts); a pull going on ends when that changes.
 * scripts/dev/mutations/unbound.json window-pull-* guard them.
 */
import type { Camera } from 'three';
import { pullGatesOf, pullRefusal, type PullGroup, type PullMoodReading } from '../../../shared/stage';
import type { StageSurface } from '../../stage';

type S = StageSurface;
export type WindowPullHit = NonNullable<ReturnType<S['pullHit']>>;
export interface WindowPullView { camera: Camera; width: number; height: number }

/** What this needs of the figure (src/unbound/figure.ts). */
export interface WindowPullFigure {
  pullHit(view: WindowPullView, x: number, y: number): WindowPullHit | null;
  pullStart(hit: WindowPullHit, view: WindowPullView): boolean;
  pullTo(view: WindowPullView, x: number, y: number): void;
  pullEnd(): void;
  setPullStance(stance: { compliance: number; pace: number } | null): void;
  setStance(stance: 'both' | 'left' | 'right'): void;
  readonly pullEngaged: boolean;
}

/** Her mood as the stage was last told it (the old stage's moodView, the fields the pull reads). */
export interface WindowPullMood {
  snapshot: { values: PullMoodReading['values']; intensity?: { playful?: number } };
  parameters: { baseline: PullMoodReading['baseline'] };
  fatigue?: { phase?: string; A?: number } | null;
}

export interface WindowPullPorts {
  /** The figure shown now, or null (none loaded yet, or changing). */
  figure(): WindowPullFigure | null;
  view(): WindowPullView;
  /** Shown: the host shows the window and the page is visible. */
  shown(): boolean;
  mood(): WindowPullMood | null;
  /** Her hand is taken for holding hands (the hands layer). */
  handBusy(): boolean;
}

export class WindowPull {
  /** Each hit this made, and the figure it was made on: only those start a pull. */
  private issued = new WeakMap<object, WindowPullFigure>();
  private held: { figure: WindowPullFigure; group: PullGroup; leg: 'left' | 'right' | null } | null = null;

  constructor(private readonly ports: WindowPullPorts) {}

  /** The piece of her under the point (CSS px in the window), when a press there may become a pull; null otherwise. */
  hit(x: number, y: number): WindowPullHit | null {
    const figure = this.ports.shown() ? this.ports.figure() : null;
    if (!figure) return null;
    const hit = figure.pullHit(this.ports.view(), x, y);
    if (!hit || pullRefusal(this.gates(), hit.group)) return null;
    this.issued.set(hit, figure);
    return hit;
  }

  /** The press became a pull: her body starts to answer from what it shows. */
  start(hit: WindowPullHit): boolean {
    const figure = this.ports.figure();
    if (!figure || !hit || this.issued.get(hit) !== figure) return false;
    if (!this.ports.shown() || pullRefusal(this.gates(), hit.group)) return false;
    if (this.held) this.end();
    if (!figure.pullStart(hit, this.ports.view())) return false;
    // A pulled leg: her weight goes onto the other foot first; the gait lifts this one a little (window mode: she does not walk).
    const leg = hit.group === 'leg' && hit.side ? hit.side : null;
    if (leg) figure.setStance(leg === 'left' ? 'right' : 'left');
    this.held = { figure, group: hit.group, leg };
    return true;
  }

  to(x: number, y: number): void {
    const held = this.held;
    if (held && held.figure === this.ports.figure() && Number.isFinite(x + y)) held.figure.pullTo(this.ports.view(), x, y);
  }

  /** Released, cancelled, slipped free: she eases back (the layer's springs; never a jump), both feet again. */
  end(): void {
    const held = this.held;
    this.held = null;
    if (!held) return;
    held.figure.pullEnd();
    if (held.leg) held.figure.setStance('both');
  }

  /** A pull going on may continue: the same figure, shown, not asleep, her hand not taken meanwhile. */
  stillAllowed(group: PullGroup): boolean {
    const figure = this.ports.figure();
    return !!figure && (!this.held || this.held.figure === figure) && this.ports.shown() && pullRefusal(this.gates(), group) === null;
  }

  setStance(stance: { compliance: number; pace: number } | null): void { this.ports.figure()?.setPullStance(stance); }

  /** Her mood now, as the pull attitude reads it (the old stage's reading); null before the first mood view. */
  mood(): PullMoodReading | null {
    const view = this.ports.mood();
    return view ? { values: view.snapshot.values, baseline: view.parameters.baseline, sleepy: view.fatigue?.A ?? 0, playful: view.snapshot.intensity?.playful } : null;
  }

  /** Held, or still easing back (the stage's pace keeps full while it lasts). */
  get engaged(): boolean { return this.held !== null || this.ports.figure()?.pullEngaged === true; }

  /** A new model: whatever was held belonged to the old one (its figure is gone with it). */
  forget(): void { this.held = null; this.issued = new WeakMap(); }

  /** One rule with full-screen (I-174 item 6: shared/behaviors/pull/gates.ts pullGatesOf). */
  private gates() { return pullGatesOf(this.ports.mood(), this.ports.handBusy()); }
}
