/**
 * I-193: what her walks leave in the experience journal, as closed words and numbers (never a word of chat).
 *  - one 'go-beat' row for every "go where" word she wrote: the word, whether she walked ('went') or not ('stayed') with the closed reason, and the
 *    metres the walk is for (the way from where she stood to where she was sent);
 *  - one 'place-moved' row for every walk of her own life that ended: whose walk it was, where she stands now in rough words (side, range) and how
 *    many metres she moved. A walk you cut short writes the metres she really covered.
 * The rows are what shared/unbound/life/host.ts hands its `journal` port; electron/wiring/unbound-wiring.ts adds the character and writes them
 * (shared/stage/journal-entries.ts keeps the same closed lists, a test holds them equal).
 */
import type { LifeSpot } from '../life/action';
import type { GoTarget, GoWord } from './ask';
import type { GoBlock } from './gates';
import { herPosition, type HerRange, type HerSide } from './words';

/** Why a go-word did not walk (closed words). 'close-moment': a peek or kiss / hug was on (the gate's 'busy'). */
export const GO_STAY_WHYS = ['not-shown', 'asleep', 'pulled', 'playing', 'typing', 'close-moment', 'already-there', 'cursor-stale', 'covered', 'no-place', 'queued', 'dropped'] as const;
export type GoStayWhy = (typeof GO_STAY_WHYS)[number];
export const PLACE_MOVE_BY = ['go-word', 'own'] as const;
export type PlaceMoveBy = (typeof PLACE_MOVE_BY)[number];

export type LifeJournalRow =
  /** `target` (I-193 numbers): what ⟦go 30% 1.2m⟧ asked, as she wrote it (percent across, told metres); only when numbers were given. */
  | { type: 'go-beat'; word: GoWord; outcome: 'went' | 'stayed'; why: GoStayWhy | null; metres: number | null; target?: GoTarget }
  | { type: 'place-moved'; by: PlaceMoveBy; side: HerSide; range: HerRange; metres: number };

/** The gate's word as the journal's. */
export const goStayWhyOfBlock = (block: GoBlock): GoStayWhy => (block === 'busy' ? 'close-moment' : block);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Metres between two points of her floor (world metres: across the screen, behind it); null when either is not known. */
export function metresBetween(a: { xM: number; depthM: number } | null | undefined, b: { xM: number; depthM: number } | null | undefined): number | null {
  if (!a || !b || !finite(a.xM) || !finite(a.depthM) || !finite(b.xM) || !finite(b.depthM)) return null;
  return Math.round(Math.hypot(a.xM - b.xM, a.depthM - b.depthM) * 10) / 10;
}

const withTarget = (target: GoTarget | null | undefined) => (target && (target.percent !== undefined || target.metres !== undefined) ? { target: { ...target } } : {});
export const goWentRow = (word: GoWord, metres: number | null, target?: GoTarget | null): LifeJournalRow => ({ type: 'go-beat', word, outcome: 'went', why: null, metres, ...withTarget(target) });
export const goStayedRow = (word: GoWord, why: GoStayWhy, target?: GoTarget | null): LifeJournalRow => ({ type: 'go-beat', word, outcome: 'stayed', why, metres: null, ...withTarget(target) });
/** The row for a walk that ended where she stands now (`spot`); null when her place is not known. */
export function placeMovedRow(by: PlaceMoveBy, spot: LifeSpot | null | undefined, metres: number | null): LifeJournalRow | null {
  const p = herPosition(spot);
  return p && metres !== null ? { type: 'place-moved', by, side: p.side, range: p.range, metres } : null;
}
