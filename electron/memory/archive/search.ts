// I-208 the archive's search and paging, pure (docs/claude/2026-11-24-i208-archive-step1.md). One box: a plain substring over what the item shows and a few
// words it carries for the search only (Chinese and English both), case and width folded. Newest first. Nothing here reads a file or the clock.
import { ARCHIVE_KINDS, ARCHIVE_LIMITS, type ArchiveItem, type ArchiveKind, type ArchiveSection, type ParsedArchiveRequest } from '../../../shared/memory/archive';

/** What a store hands over for one line: `sort` is its time (newest first), `words` are extra search words that are not shown. */
export interface RawArchiveItem extends ArchiveItem { readonly sort: number; readonly words: string }
export type RawArchive = { readonly [K in ArchiveKind]: readonly RawArchiveItem[] };

/** Case and width folded, so "Gene" finds "gene" and a full-width letter finds its plain one. */
export const fold = (text: string): string => text.normalize('NFKC').toLocaleLowerCase();

const shorten = (text: string, max: number): string => { const chars = Array.from(text); return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`; };
const shown = (item: RawArchiveItem): ArchiveItem => ({ id: item.id, date: item.date, title: shorten(item.title, 120), text: shorten(item.text, ARCHIVE_LIMITS.itemChars), tag: item.tag });

/** One section: the matches of the query, newest first, one page of them. */
export function archiveSection(kind: ArchiveKind, items: readonly RawArchiveItem[], request: Pick<ParsedArchiveRequest, 'query' | 'offset' | 'limit'>): ArchiveSection {
  const needle = fold(request.query);
  const hits = items.filter(item => !needle || fold(`${item.title}\n${item.text}\n${item.words}`).includes(needle))
    .sort((a, b) => b.sort - a.sort || a.id.localeCompare(b.id));
  const page = hits.slice(request.offset, request.offset + request.limit);
  return { kind, total: hits.length, items: page.map(shown), more: request.offset + page.length < hits.length };
}

/** Every section (the first page of each), or only the asked one (a further page of it). */
export function archiveSections(raw: RawArchive, request: ParsedArchiveRequest): ArchiveSection[] {
  const kinds = request.kind ? [request.kind] : ARCHIVE_KINDS;
  return kinds.map(kind => archiveSection(kind, raw[kind] ?? [], request.kind ? request : { ...request, offset: 0 }));
}
