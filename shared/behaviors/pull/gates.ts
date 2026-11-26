/**
 * I-136 step 5「拉她」: when pressing on her is not a pull (docs/claude/2026-11-18-unbound-step5-plan.md「什么时候拉不动」, 「我自己定的」).
 *
 *  - asleep: pulling someone asleep either wakes her or drags a sleeping body; both need their own design, so the first version does
 *    neither (a press does nothing; a pull going on when she falls asleep ends as cancelled and eases back);
 *  - peeking: while she leans close to the camera (Unbound), a press is not a pull, as a click is not a click then;
 *  - her hand is busy (the companion: she reaches for your hand or holds it, I-087): a press on her hand or arm belongs to holding hands;
 *    the rest of her can still be pulled.
 * Pure: the stage and Unbound pass what they see. scripts/dev/mutations/stage.json P4 / P5 guard it.
 */
import type { PullGroup } from './session';

export interface PullGates {
  asleep: boolean;
  peeking: boolean;
  handBusy: boolean;
}

/** Null when it may be pulled; otherwise the reason (for the developer readout). */
export function pullRefusal(gates: PullGates, group: PullGroup): 'asleep' | 'peeking' | 'hand-busy' | null {
  if (gates.asleep) return 'asleep';
  if (gates.peeking) return 'peeking';
  if (gates.handBusy && group === 'arm') return 'hand-busy';
  return null;
}

/** Fatigue phases that count as asleep (shared/mood/fatigue.ts): a pull is not offered, and one going on ends. */
export const PULL_ASLEEP_PHASES: ReadonlySet<string> = new Set(['asleep', 'micro-awake']);

/**
 * I-174 item 6 (docs/claude/2026-11-21-i174-parity-fixes.md): the window and full-screen ask the same question with the same mood view, so
 * a press on her while she sleeps is refused up front in both (before, full-screen let the press start and only the host said no).
 */
export function pullGatesOf(view: { fatigue?: { phase?: string | null } | null } | null | undefined, handBusy: boolean): PullGates {
  const phase = view?.fatigue?.phase;
  return { asleep: !!phase && PULL_ASLEEP_PHASES.has(phase), peeking: false, handBusy };
}
