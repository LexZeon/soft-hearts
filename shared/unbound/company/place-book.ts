/**
 * I-209 step 1: where each character stands, one record per character (shared/unbound/life/place-record.ts SavedPlace: across the screen
 * 0..1 and, since I-212, her size on the screen; nothing about the user). The two place files (`unbound-place.json`, `unbound-default-place.json`) hold a
 * book of these since 2026-11-24:
 *
 *     { "version": 2, "places": { "<card id>": { "version": 2, "across": 0.62, "size": 0.55 }, ... } }
 *
 * (A record from before I-212 has { "version": 1, ..., "depthM": 7.4 }: kept as it is until the keeper converts it with her height.)
 *
 * A file from before (one record, version 1) reads as `legacy`: the place keeper gives it to the character you talk with (the one whose
 * place it was) and writes the book on its next write. Anything unreadable, out of range or over the limit is left out, never guessed.
 */
import { DEFAULT_PLACE_RANGES, parseSavedPlace, type PlaceSizeRange, type SavedPlace } from '../life/place-record';
import { COMPANY_ID } from './presence';

/** More cards than anyone keeps; a file with more entries keeps the first ones (a hand-edited file cannot grow the read without end). */
export const PLACE_BOOK_MAX = 64;

export interface PlaceBook { places: Map<string, SavedPlace>; legacy: SavedPlace | null }

export function emptyPlaceBook(): PlaceBook { return { places: new Map(), legacy: null }; }

/** A file's content (already JSON-parsed) as a book; null or anything else: an empty book. */
export function parsePlaceBook(value: unknown, sizeRange: PlaceSizeRange = DEFAULT_PLACE_RANGES.size): PlaceBook {
  const book = emptyPlaceBook();
  const single = parseSavedPlace(value, sizeRange);
  if (single) { book.legacy = single; return book; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return book;
  const v = value as Record<string, unknown>;
  if (v.version !== 2 || !v.places || typeof v.places !== 'object' || Array.isArray(v.places)) return book;
  for (const [id, raw] of Object.entries(v.places as Record<string, unknown>)) {
    if (book.places.size >= PLACE_BOOK_MAX) break;
    const place = parseSavedPlace(raw, sizeRange);
    if (place && COMPANY_ID.test(id)) book.places.set(id, place);
  }
  return book;
}

/** The book as the file holds it (only valid ids and records; at most PLACE_BOOK_MAX). */
export function placeBookFile(places: ReadonlyMap<string, SavedPlace>, sizeRange: PlaceSizeRange = DEFAULT_PLACE_RANGES.size): { version: 2; places: Record<string, SavedPlace> } {
  const out: Record<string, SavedPlace> = {};
  let n = 0;
  for (const [id, raw] of places) {
    const place = parseSavedPlace(raw, sizeRange);
    if (!place || !COMPANY_ID.test(id) || n >= PLACE_BOOK_MAX) continue;
    out[id] = place.version === 2 ? { version: 2, across: place.across, size: place.size } : { version: 1, across: place.across, depthM: place.depthM }; n++;
  }
  return { version: 2, places: out };
}
