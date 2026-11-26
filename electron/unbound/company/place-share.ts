/**
 * I-209 step 3: every character on stage is her own host with her own place keeper (electron/unbound/place-keeper.ts), but the two place
 * files are one book each (shared/unbound/company/place-book.ts). Two keepers writing their whole book would undo each other's last write.
 * So each keeper gets its own port onto one shared book per file: a keeper's write changes only her own record in the book (the one whose
 * id the port carries), and the whole book is written. A one-record file from before (`legacy`) belongs to the one you talk with: only her
 * port reads it as hers; an extra's port never sees it (she would take it as her own), and an extra's write gives it to the one you talk with
 * first, so it is never lost.
 */
import { emptyPlaceBook, parsePlaceBook, placeBookFile, type PlaceBook } from '../../../shared/unbound/company/place-book';
import type { SavedPlace } from '../../../shared/unbound/life/place-record';
import type { PlaceFilePort } from '../place-keeper';

type BookFile = ReturnType<typeof placeBookFile>;

export class SharedPlaceBook {
  private book: PlaceBook = emptyPlaceBook();
  private loading: Promise<void> | null = null;

  /** `file`: the real file (the profile's store); `primary`: the card of the one you talk with now (null: unknown). */
  constructor(private readonly file: PlaceFilePort & { clear?(): void | Promise<void> },private readonly primary: () => string | null) {}

  /** A keeper's port: `id()` is whose keeper it is (null: the one you talk with, as before I-209); `legacy`: this port may read a file from before. */
  portFor(id: () => string | null, legacy: boolean): PlaceFilePort & { clear(): void | Promise<void> } {
    return {
      load: async () => { await this.load(); return this.view(legacy); },
      save: value => this.save(id(), value),
      clear: () => this.save(id(), null),
    };
  }

  private load(): Promise<void> {
    return this.loading ??= Promise.resolve().then(() => this.file.load()).then(raw => { this.book = parsePlaceBook(raw); }, () => { this.book = emptyPlaceBook(); });
  }

  /** What a keeper reads: the book (and, for the one you talk with, a one-record file from before as it was). */
  private view(legacy: boolean): unknown {
    if (this.book.legacy) return legacy ? { ...this.book.legacy } : placeBookFile(this.book.places);
    return placeBookFile(this.book.places);
  }

  /** One keeper's write: only her own record changes (null: removed). */
  private save(id: string | null, value: SavedPlace | BookFile | null): void | Promise<void> {
    if (!id) { // the one keeper without characters (before I-209): its whole record, as it always wrote it
      this.book = value ? parsePlaceBook(value) : emptyPlaceBook();
      return this.flush();
    }
    if (this.book.legacy) { // a file from before is the one you talk with's (the keeper of hers would have adopted it the same way)
      const owner = this.primary() ?? id;
      if (!this.book.places.has(owner)) this.book.places.set(owner, this.book.legacy);
      this.book.legacy = null;
    }
    const written = value ? parsePlaceBook(value) : emptyPlaceBook();
    const own = written.places.get(id) ?? null;
    if (own) this.book.places.set(id, own); else this.book.places.delete(id);
    return this.flush();
  }

  /** The file's own answer goes back to the keeper (a failed write must not look like a kept place); a throw or a rejection reaches it the same way. */
  private flush(): void | Promise<void> {
    if (this.book.legacy) return this.file.save(this.book.legacy);
    if (this.book.places.size) return this.file.save(placeBookFile(this.book.places));
    return this.file.clear?.();
  }
}
