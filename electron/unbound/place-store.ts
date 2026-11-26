/**
 * Unbound v1 step 4: where she last stood, kept in the profile (`unbound-place.json`; the data map's row 'unbound-place'), and
 * (2026-11-23) the place the user set as her default (`unbound-default-place.json`, row 'unbound-default-place'): the same store, the
 * same record (shared/unbound/life/place-record.ts: across the screen 0..1, since I-212 her size on the screen (old files: metres behind it), and a version; nothing about the user),
 * another file. Read once before her first entry; written atomically, one write at a time. A missing, unreadable or out-of-range
 * file gives null: she comes out at the default corner.
 * I-209 step 1 (2026-11-24): a file may hold a book, one record per character ({ version: 2, places: { <card id>: record } };
 * shared/unbound/company/place-book.ts); a one-record file from before still reads as it did (the keeper gives it to the one you talk with).
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { DEFAULT_PLACE_RANGES, parseSavedPlace, type PlaceSizeRange, type SavedPlace } from '../../shared/unbound/life/place-record';
import { parsePlaceBook, placeBookFile } from '../../shared/unbound/company/place-book';

type PlaceBookFile = ReturnType<typeof placeBookFile>;
/** A book (I-209) is the one shape with a `places` map; a single record (v1 metres, v2 screen terms since I-212) has none. */
const isBook = (value: unknown): boolean => !!value && typeof value === 'object' && (value as { version?: unknown }).version === 2 && 'places' in (value as object);

export const UNBOUND_PLACE_FILE = 'unbound-place.json';
/** The place the user set as the one she starts at (2026-11-23); her own walks never write it. */
export const UNBOUND_DEFAULT_PLACE_FILE = 'unbound-default-place.json';

export interface UnboundPlaceStoreDeps { read?(file: string): Promise<string>; write?: AtomicFileWriter; remove?(file: string): Promise<void> }

export class UnboundPlaceStore {
  private readonly file: string;
  private readonly write: AtomicFileWriter;
  private readonly read: (file: string) => Promise<string>;
  private readonly remove: (file: string) => Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(directory: string, deps: UnboundPlaceStoreDeps = {}, file: string = UNBOUND_PLACE_FILE) {
    this.file = path.join(directory, file);
    this.write = deps.write ?? atomicWriteFile;
    this.read = deps.read ?? (target => readFile(target, 'utf8'));
    this.remove = deps.remove ?? (target => rm(target, { force: true }));
  }

  /** The saved place (a one-record file), the book (I-209), or null. */
  async load(): Promise<SavedPlace | PlaceBookFile | null> {
    try {
      const value: unknown = JSON.parse(await this.read(this.file));
      return parseSavedPlace(value, DEFAULT_PLACE_RANGES.size) ?? (isBook(value) ? placeBookFile(parsePlaceBook(value, DEFAULT_PLACE_RANGES.size).places, DEFAULT_PLACE_RANGES.size) : null);
    } catch { return null; }
  }

  /** Keeps a place (only a valid one; only its three fields), or a book of them (I-209; only valid ids and records). */
  save(place: SavedPlace | PlaceBookFile): Promise<void> {
    // 2026-11-25: a record the file may not hold is an error told to the writer (the place keeper, then the panel), not a silent drop that still says 已设.
    if (isBook(place)) {
      const book = placeBookFile(parsePlaceBook(place, DEFAULT_PLACE_RANGES.size).places, DEFAULT_PLACE_RANGES.size);
      if (Object.keys(book.places).length !== Object.keys((place as PlaceBookFile).places).length) return Promise.reject(new Error('a place record outside what may be kept'));
      return this.queue(() => this.write(this.file, JSON.stringify(book, null, 2)));
    }
    const record = parseSavedPlace(place, DEFAULT_PLACE_RANGES.size);
    if (!record) return Promise.reject(new Error('a place record outside what may be kept'));
    const kept = record.version === 2 ? { version: 2, across: record.across, size: record.size } : { version: 1, across: record.across, depthM: record.depthM };
    return this.queue(() => this.write(this.file, JSON.stringify(kept, null, 2)));
  }

  /** Forgets the kept place (the file goes; a missing file is fine). */
  clear(): Promise<void> { return this.queue(() => this.remove(this.file)); }

  private queue(run: () => Promise<void>): Promise<void> {
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }
}
