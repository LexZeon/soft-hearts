/**
 * I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): what she adds on top of a kiss or a hug is HER choice, never the animation's. The user:
 * "撩头发，撅嘴，害羞是抱抱亲亲的角色选择。" The kiss and the hug only walk up, arrive, hold and leave; these lie on top of that line:
 *
 *   pucker  her lips pushed out at the closest (a kiss; only in a pause, PuckerGate)
 *   tuck    on the way back she tucks her hair behind her ear (her arm reach's 'tuck'; a model whose arms the engine cannot move: nothing)
 *   blush   her cheeks colour as she comes close
 * Shyness afterwards (blush, looking away) is the after-beat (after-beat.ts, by her character). Each extra is a closed word: her own words can
 * name them (`planCloseMoment({ extras })`), else `chooseCloseExtras` draws them from her mood and character. Pure.
 */
import type { CloseAct, CloseReading } from './chooser';

export const CLOSE_EXTRAS = ['pucker', 'tuck', 'blush'] as const;
export type CloseExtra = (typeof CLOSE_EXTRAS)[number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** The chance of each extra for this act (each 0..1, drawn on its own). A shy step back takes none: it is a different act. */
export function closeExtraChances(kind: CloseAct, r: CloseReading): Record<CloseExtra, number> {
  if (kind === 'shy') return { pucker: 0, tuck: 0, blush: 0 };
  return {
    // A kiss: most often, more when she is bold and warm, less when tense.
    pucker: kind === 'kiss' ? clamp01(0.5 + 0.3 * r.boldness + 0.2 * r.warmth - 0.3 * r.tension) : 0,
    // Tucking her hair afterwards: a little shy and unsure, less when she is bold.
    tuck: clamp01(0.18 + 0.3 * (1 - r.boldness) + 0.15 * r.tension + 0.1 * r.warmth),
    // Blushing as she comes close: tenser and warmer.
    blush: clamp01(0.35 + 0.3 * r.tension + 0.1 * r.warmth),
  };
}

/** Her extras by chance (`random` in [0, 1), one draw per extra, in CLOSE_EXTRAS order). */
export function chooseCloseExtras(kind: CloseAct, r: CloseReading, random: () => number): CloseExtra[] {
  const chances = closeExtraChances(kind, r);
  return CLOSE_EXTRAS.filter(extra => clamp01(random()) < chances[extra]);
}

/** Only the closed words, once each, in CLOSE_EXTRAS order (what crossed IPC or came from her words). null when it is not a list. */
export function parseCloseExtras(value: unknown, kind?: CloseAct): CloseExtra[] | null {
  if (!Array.isArray(value)) return null;
  const set = new Set(value.filter((v): v is CloseExtra => (CLOSE_EXTRAS as readonly unknown[]).includes(v)));
  if (kind && kind !== 'kiss') set.delete('pucker'); // a hug has no pucker
  if (kind === 'shy') set.clear();
  return CLOSE_EXTRAS.filter(extra => set.has(extra));
}
