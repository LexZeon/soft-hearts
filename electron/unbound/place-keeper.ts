/**
 * Where she stands when she comes out: two places, kept apart.
 *  - the last place: where her last walk ended (step 4); what she comes out at when no default is set;
 *  - the default place: the one spot the user set ("设为默认位置" in the full-screen small panel, their Claude's set_setting
 *    unbound_default_place, or, since I-212, the user's own words to her: her hidden ⟪keep-place⟫ / ⟪clear-place⟫ in her reply to them,
 *    electron/unbound/place-marks.ts). When one is set she starts there on EVERY entry, whatever her wandering or pulls did since. Her own
 *    moves never write it; only `setHere` and `clear` do.
 * The host asks `startAt` when it builds her world for an entry; every other rebuild (the screen changed, the viewing distance moved) keeps where she is.
 *
 * I-209 step 1 (2026-11-24, several characters on stage): each character has her own two places (shared/unbound/company/place-book.ts).
 * Everything without an id is for the character you talk with (`character()`); `startFor` / `walkedFor` are an extra's. A file from
 * before holds one record: it is the character you talk with's (she was the only one ever out), given to her as soon as she is known
 * and written as a book on the next write. Without `character()` (null) the keeper works as before, one record per file.
 *
 * I-212: a place is kept as she looked on the screen (across, size;
 * shared/unbound/screen-terms), so another screen shows her as the user set her. An old record in metres is used as it is until her height
 * is known (`adopt`, the page's ready report), then converted ONCE with this screen and her height and written in the new form.
 *
 * 2026-11-24: the default place may be anywhere she can stand by walking, as near as "only the face"
 * (DEFAULT_PLACE_RANGES in the record file; the near limit of this screen is checked in `keepHere`). The last place and pulls keep the old range.
 * `keepHere` always answers with a word (kept, or why not); the panel and the journal say it.
 */
import { DEFAULT_PLACE_RANGES, legacyToLook, savedPlaceOf, withinSavedSizes, type PlaceKeepRefusal, type SavedPlace } from '../../shared/unbound/life/place-record';
import { farthestWalkSize, nearestWalkSize } from '../../shared/unbound/her-position';
import { emptyPlaceBook, parsePlaceBook, placeBookFile, type PlaceBook } from '../../shared/unbound/company/place-book';
import { lookOfPlacement, placementOfLook, type LookSpot, type ScreenFrame } from '../../shared/unbound/screen-terms';
import { clampPlacement, placementAcross, type Placement } from '../../shared/unbound/world';
import { withTimeout } from './host-ports';

/** A place file: what it holds (JSON), a write (one record before I-209, a book after), and its removal. */
export interface PlaceFilePort { load(): Promise<unknown>; save(value: SavedPlace | ReturnType<typeof placeBookFile>): void | Promise<void>; clear?(): void | Promise<void> }
export interface PlaceKeeperPorts {
  /** The last places (`unbound-place.json`); absent: none kept. */
  last?: PlaceFilePort;
  /** The default places (`unbound-default-place.json`); absent: none can be set. */
  fixed?: PlaceFilePort & { clear(): void };
}
/** Where she stands now while she is out: the screen, her placement and her height (null until the page reported it). */
export interface PlaceHere { frame: ScreenFrame; at: Placement; heightM: number | null }
/** An entry's start: by screen terms (`look`, placed with her real height once the page knows it), or in metres (where she already is, an old record). */
export type PlaceStart = { look: LookSpot; placement?: undefined } | { look?: undefined; placement: Placement };
type Kind = 'last' | 'fixed';
/** What the user's "set as default" click came to: kept, or the one reason it kept nothing (closed words; the journal row uses the same). */
export type PlaceKeepOutcome = 'kept' | PlaceKeepRefusal;
/** The float slack of "she stands exactly at the nearest walk limit" (a walk lands on it; the round trip through metres drifts in the last digits). */
const NEAR_SLACK = 1e-6;
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

export class PlaceKeeper {
  private readonly books: Record<Kind, PlaceBook> = { last: emptyPlaceBook(), fixed: emptyPlaceBook() };
  /**
   * `here`: where she stands now on this screen while she is out; null when she is not (nothing can be kept then). `character`: the card
   * of the one you talk with (null: unknown, one record per file as before I-209).
   */
  constructor(private readonly ports: () => PlaceKeeperPorts, private readonly here: () => PlaceHere | null = () => null,
    private readonly character: () => string | null = () => null) {}

  private loading: Promise<void> | null = null;
  /** Reads what is kept, once (missing, unreadable or out of range: nothing); the host starts it at once so a panel or the channel can read `look()` before her first entry. */
  load(): Promise<void> { return this.loading ??= this.read(); }
  private async read(): Promise<void> {
    const ports = this.ports(), read = async (port: { load(): Promise<unknown> }) => parsePlaceBook(await withTimeout(Promise.resolve().then(() => port.load()), 2_000, null));
    if (ports.last) { this.books.last = await read(ports.last); this.narrowLast(); }
    if (ports.fixed) this.books.fixed = await read(ports.fixed);
  }

  /** The last places keep the old range (a file holds the wider default-place range): a record outside it is brought to its edge, never dropped. */
  private narrowLast(): void {
    const book = this.books.last;
    if (book.legacy) book.legacy = withinSavedSizes(book.legacy);
    for (const [id, record] of book.places) book.places.set(id, withinSavedSizes(record));
  }

  /** The record of `kind` for the character you talk with (a file from before is hers: adopted the first time she is known). */
  private own(kind: Kind): SavedPlace | null {
    const book = this.books[kind], id = this.character();
    if (!id) return book.legacy;
    if (book.legacy) { if (!book.places.has(id)) book.places.set(id, book.legacy); book.legacy = null; }
    return book.places.get(id) ?? null;
  }
  /** The last write's outcome (true: reached the disk, or nothing to write): 2026-11-25, a write that failed used to be forgotten while the panel said 已设. */
  private settled: Promise<boolean> = Promise.resolve(true);
  /** Whether everything written so far reached the disk; the panel's click waits for it before it says 已设. */
  persisted(): Promise<boolean> { return this.settled; }
  private track(run: () => void | Promise<void> | undefined): void {
    try { this.settled = Promise.resolve(run()).then(() => true, () => false); } catch { this.settled = Promise.resolve(false); } // still kept in memory for this run
  }
  private write(kind: Kind, id: string | null, record: SavedPlace | null): void {
    const book = this.books[kind], port = this.ports()[kind];
    if (!id) { book.legacy = record; this.track(() => (record ? port?.save(record) : port?.clear?.())); return; }
    if (book.legacy) this.own(kind); // a file from before goes to the one you talk with first
    if (record) book.places.set(id, record); else book.places.delete(id);
    this.track(() => (book.places.size || book.legacy ? port?.save(placeBookFile(book.places)) : port?.clear?.()));
  }

  /** Whether a default place is set (the character you talk with). */
  get hasDefault(): boolean { return !!this.own('fixed'); }
  /** The default place's look (null: none set, or an old record whose screen and height are not known yet). */
  get defaultLook(): LookSpot | null { const fixed = this.own('fixed'); return fixed?.version === 2 ? { across: fixed.across, size: fixed.size } : null; }

  /**
   * An entry's start: the default place when one is set, else where she already is, else the last place, else `first()` (the first
   * appearance). A record in screen terms starts as a look (the host places it with her real height); an old one in metres as it was.
   */
  startAt(frame: ScreenFrame, current: Placement | null, first: () => LookSpot): PlaceStart {
    const fixed = this.own('fixed'), last = this.own('last');
    if (fixed) { this.write('last', this.character(), withinSavedSizes(fixed)); return startOf(frame, fixed); } // she stands there now: that is also where she last stood
    if (current) return { placement: clampPlacement(current) };
    return last ? startOf(frame, last) : { look: first() };
  }

  /** Her height is known (the page's ready report): her old records (metres) convert once with this screen and her height, and are written anew. */
  adopt(frame: ScreenFrame, heightM: number): void {
    for (const kind of ['last', 'fixed'] as const) {
      const record = this.own(kind);
      if (record?.version !== 1) continue;
      const look = legacyToLook(frame, heightM, record);
      if (look) this.write(kind, this.character(), look);
    }
  }

  /** A walk of hers ended here: kept as the last place (never the default). Nothing without her height. */
  walked(frame: ScreenFrame, at: Placement, heightM: number | null): void { this.walkedFor(this.character(), frame, at, heightM); }

  /** I-209: an extra's start on this screen for her height (her default place, else her last place); null when nothing is kept for her. */
  startFor(id: string, frame: ScreenFrame, heightM: number): Placement | null {
    const record = this.books.fixed.places.get(id) ?? this.books.last.places.get(id) ?? null;
    if (!record) return null;
    return record.version === 2 ? placementOfLook(frame, heightM, record) : clampPlacement(placementAcross(frame, record.across, record.depthM));
  }
  /** I-209: a walk of `id` ended here (null: the one you talk with, or the single record before I-209). */
  walkedFor(id: string | null, frame: ScreenFrame, at: Placement, heightM: number | null): void {
    const look = lookOfPlacement(frame, heightM, at), record = look ? savedPlaceOf(look) : null;
    if (record) this.write('last', id, record);
  }

  /** What a panel shows: whether a default place is set, and whether she can be kept where she stands (she is out). */
  look(): { set: boolean; here: boolean } { return { set: this.hasDefault, here: this.here() !== null && !!this.ports().fixed }; }

  /** The user set where she stands now as the default place; false when it kept nothing (`keepHere` says why). */
  setHere(): boolean { return this.keepHere() === 'kept'; }

  /**
   * The same, with the answer in a word. She can be kept anywhere she can stand by walking: across 5-95% (a pull to the very edge is kept at the edge),
   * size from the far walk limit up to this screen's near walk limit, "only the face" (shared/unbound/her-position/reach.ts, the limit her own
   * walks use). Nothing is kept, and nothing written, when she is not out, mid-walk (`walking`: her place is moving), her height is not known yet, or she
   * is pulled nearer than the near limit.
   */
  keepHere(walking = false): PlaceKeepOutcome {
    const ports = this.ports(), now = this.here();
    if (!now || !ports.fixed) return 'not-out';
    if (now.heightM === null) return 'no-height';
    if (walking) return 'moving'; // the caller knows (the panel asks her life host); her place in the host is where the walk began
    const look = lookOfPlacement(now.frame, now.heightM, now.at), nearest = nearestWalkSize(now.frame, now.heightM);
    if (!look || nearest === null) return 'no-height';
    const far = Math.min(farthestWalkSize(), DEFAULT_PLACE_RANGES.size[0]);
    if (look.size > nearest * (1 + NEAR_SLACK) || look.size < far) return 'out-of-reach';
    const record = savedPlaceOf({ across: clamp(look.across, DEFAULT_PLACE_RANGES.across), size: look.size }, DEFAULT_PLACE_RANGES.size);
    if (!record) return 'out-of-reach';
    this.write('fixed', this.character(), record);
    return 'kept';
  }

  /** The user cleared the default place: she comes out at the last place again. */
  clear(): void { this.own('fixed'); this.write('fixed', this.character(), null); }
}

function startOf(frame: ScreenFrame, record: SavedPlace): PlaceStart {
  return record.version === 2 ? { look: { across: record.across, size: record.size } } : { placement: clampPlacement(placementAcross(frame, record.across, record.depthM)) };
}
