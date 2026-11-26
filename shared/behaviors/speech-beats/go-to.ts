/**
 * I-193 numbers (plan decision 2 "米加横向百分比"): the only digits a speak-along marker may
 * hold, in `go`'s suffix: ⟦go 30% 1.2m⟧, a whole percent across the screen (\d{1,3}%) and/or told metres from the user (\d+(\.\d)?m), at least one,
 * each at most once. Every other marker with a digit is dropped as before (choose.ts judge).
 *
 * The stream filter holds a marker until it can judge it; these patterns say which held prefixes may still become a valid `go` marker, so a chunk
 * that ends inside the number keeps it held (never shown, never read aloud), and what a broken numbered marker held is thrown away whole, with
 * the rest of it up to its ⟧ (its digits never fall into the text). Pure.
 */
import type { SpeechBeatGoTo } from './interface';

const PERCENT = /^\d{1,3}%$/u;
const METRES = /^\d+(?:\.\d)?m$/u;
/** The largest numbers kept (the host clamps further: an out-of-range number walks to the edge). */
export const GO_TO_MAX = Object.freeze({ percent: 999, metres: 999.9 });

/** The parts after `go` (already lower-cased and split) as kept; null when a part is not a number of the two kinds, or neither is there. */
export function readGoTo(parts: readonly string[]): SpeechBeatGoTo | null {
  if (parts.length < 1 || parts.length > 2) return null;
  let percent: number | undefined, metres: number | undefined;
  for (const part of parts) {
    if (percent === undefined && PERCENT.test(part)) percent = Number(part.slice(0, -1));
    else if (metres === undefined && METRES.test(part)) metres = Number(part.slice(0, -1));
    else return null;
  }
  if (metres !== undefined && !(metres <= GO_TO_MAX.metres)) return null;
  return goToOf({ percent, metres }) ?? null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A beat's `goTo` as kept (from a stream event, an archive, a beat copy): whole percent 0..999, metres 0..999.9 to one decimal; undefined when neither. */
export function goToOf(value: unknown): SpeechBeatGoTo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const percent = finite(v.percent) && Number.isInteger(v.percent) && v.percent >= 0 && v.percent <= GO_TO_MAX.percent ? v.percent : undefined;
  const metres = finite(v.metres) && v.metres >= 0 && v.metres <= GO_TO_MAX.metres ? Math.round(v.metres * 10) / 10 : undefined;
  if (percent === undefined && metres === undefined) return undefined;
  return Object.freeze({ ...(percent !== undefined ? { percent } : {}), ...(metres !== undefined ? { metres } : {}) });
}

/** How a kept target is written back into her history (⟦go 30% 1.2m⟧, as she wrote it); '' for none. */
export const goToText = (goTo: SpeechBeatGoTo | undefined): string =>
  !goTo ? '' : [goTo.percent !== undefined ? `${goTo.percent}%` : '', goTo.metres !== undefined ? `${goTo.metres}m` : ''].filter(Boolean).map(part => ` ${part}`).join('');

/**
 * A held marker body that may still become a valid `go` marker (the filter keeps holding it): `go`, then parts that are a percent or metres so
 * far (a digit run, a run with % or m, a decimal point with at most one digit after it). `double`: the [[ ]] bracket, whose first ] may have come.
 */
const PENDING = /^\s*go(?:\s+(?:\d{1,3}%?|\d+(?:\.\d?)?m?))*\s*$/iu;
const PENDING_DOUBLE = /^\s*go(?:\s+(?:\d{1,3}%?|\d+(?:\.\d?)?m?))*\s*\]?$/iu;
export const goPending = (body: string, double: boolean): boolean => (double ? PENDING_DOUBLE : PENDING).test(body);
/**
 * Her own ⟦ marker that broke after a word and a suffix (⟦go 12.34m⟧, ⟦come-near 1m⟧, ⟦tilt 30%⟧): all of what was held of it (letters, digits, '.',
 * '%') is thrown away, never shown. Before numbers only letters were thrown away; now that her sentence mentions a number, a digit in another word's
 * suffix must not fall into her text either.
 */
export const BROKEN_SUFFIX = /^\s*[a-z][a-z-]*\s[a-z0-9 .%-]*/iu;
/** What may follow a broken numbered marker up to its ⟧ and is thrown away with it (at most markerMaxChars characters). */
export const MARKERISH = /^[a-z0-9 .%-]$/iu;
