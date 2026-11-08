import type { FatigueView } from '../../shared/fatigue-runtime';

export interface FatigueFrame {
  readonly gazeAllowed: boolean;
  readonly gazeStrength: number;
  readonly gazeResponse: number;
  readonly eyelids: number;
  /** gene-local-face: the reviewed Gene; model-card: another model whose capability card has 能闭眼 on (I-024);
   * model-fallback: another model without it; card-off: the user turned 能闭眼 off on the character page. */
  readonly reason: 'inactive' | 'gene-local-face' | 'model-card' | 'model-fallback' | 'card-off';
}
export const NEUTRAL_FATIGUE_FRAME: FatigueFrame = Object.freeze({ gazeAllowed: true, gazeStrength: 1, gazeResponse: 1, eyelids: 0, reason: 'inactive' });
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

/** Display-only eye layer. It never gates hit-testing, controls, clocks or speech. */
export class FatiguePresentation {
  private eyelids = 0;
  reset(): void { this.eyelids = 0; }
  /**
   * `eyelids` (I-024): the model's capability card allows the drowsy lids (the stage decides: the reviewed Gene unless
   * the user turned 能闭眼 off; any other model only when its card has it on and it has a blink morph). Absent: the old
   * rule, reviewed Gene only. The levels are the same for every model; the blink morph is written through the profile.
   */
  frame(view: FatigueView | undefined, delta: number, gates: { verifiedGene: boolean; eyelids?: boolean; expressions: boolean; faceBlocked: boolean; contact: boolean }): FatigueFrame {
    if (!view || typeof view.gazeAllowed !== 'boolean' || typeof view.sleeping !== 'boolean'
      || !['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'].includes(view.phase)) {
      this.reset(); return NEUTRAL_FATIGUE_FRAME;
    }
    const dt = Number.isFinite(delta) ? clamp(delta, 0, .1) : 0;
    const F = Number.isFinite(view.F) ? clamp(view.F, 0, 1) : 0;
    const allowed = typeof gates.eyelids === 'boolean' ? gates.eyelids : gates.verifiedGene;
    const enabled = allowed && gates.expressions && !gates.faceBlocked;
    const levels = { awake: 0, 'light-drowsy': .10, drowsy: .24, 'falling-asleep': .45, asleep: .98, 'micro-awake': .80 };
    const target = enabled ? levels[view.phase] : 0;
    // A sleeping contact gives a tiny eye movement; host W decides whether this
    // becomes micro-awake/full wake. No local transition or extra event is made.
    const touch = view.sleeping && gates.contact ? .035 : 0;
    this.eyelids += (Math.max(0, target - touch) - this.eyelids) * (1 - Math.exp(-dt * 5));
    return Object.freeze({ gazeAllowed: view.gazeAllowed, gazeStrength: view.gazeAllowed ? 1 - F * .5 : 0,
      gazeResponse: view.gazeAllowed ? 1 - F * .45 : 1, eyelids: this.eyelids,
      reason: gates.verifiedGene ? gates.eyelids === false ? 'card-off' : 'gene-local-face' : enabled || allowed ? 'model-card' : 'model-fallback' });
  }
}
