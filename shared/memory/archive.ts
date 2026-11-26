// I-208 角色档案 (docs/claude/2026-11-24-i208-archive-step1.md): what one character's archive page is made of, and the one call that reads it.
// Read only. The archive never holds a copy of anything: it gathers what the memory stores already keep for ONE character (her diary, chat notes, her
// portrait of the user, dates the user told her, plans she remembers, familiarity, a card's milestone, a card's object with her margin notes) and shows it. Editing and deleting
// stay on the rows of the data map and in the recycle bin; the one exception is her margin notes (step 3: the page edits and deletes them; those two writes ride the
// `herAlarms` call, shared/cards/card-objects.ts, and this read call stays read only). Nothing here reaches a prompt.
// The wire shapes are here (the window imports the types and the kind list); the request check is a pure function the host imports directly.
import type { CardMilestoneView } from '../cards';

/**
 * The sections, in the order the page shows them. Step 3 (her objects and notes in the margin) adds its own kind here; a kind the page does not
 * know is left out, never drawn as something else, so the list can grow without a window and a host of different ages breaking each other.
 */
export const ARCHIVE_KINDS = ['diary', 'notes', 'portrait', 'anniversaries', 'plans', 'familiarity', 'milestone', 'object'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

export const ARCHIVE_LIMITS = Object.freeze({
  /** Items per section in one answer (the default, and the most the window can ask for). */
  pageDefault: 20, pageMax: 50,
  /** The words of one search: more than this is cut. */
  queryMax: 100,
  /** What one item shows of its text (the search still reads all of it). */
  itemChars: 600,
  /** Newest items kept per section when a character has more than this (older ones stay in their own stores, only the page stops listing them). */
  gatherMax: 1000,
  /** A character id, as the cards give them. */
  idMax: 200,
});

/** One line of the page. `date` is a local date key ('2026-11-23') or '' (a date the user told her has none). */
export interface ArchiveItem { readonly id: string; readonly date: string; readonly title: string; readonly text: string; /** A closed key the window turns into its own label (a fact, a plan that is waiting, a birthday...); '' when the item has none. */ readonly tag: string }
export interface ArchiveSection { readonly kind: ArchiveKind; /** Matches of the search (everything when the box is empty). */ readonly total: number; readonly items: readonly ArchiveItem[]; readonly more: boolean }

/** The window's one call. No path, no file name, no store name: a character id, the search words, and which page of which section. */
export interface CharacterArchiveRequest {
  readonly characterId: string;
  readonly query?: string;
  /** Only this section (a further page of it); without it every section's first page. */
  readonly kind?: ArchiveKind;
  readonly offset?: number;
  readonly limit?: number;
}
export interface CharacterArchiveView {
  readonly characterId: string;
  readonly query: string;
  readonly sections: readonly ArchiveSection[];
  /** The card's milestone as the user's page shows it; null when this card declares none (the page then has no such section). */
  readonly milestone: CardMilestoneView | null;
  /**
   * I-208 step 3: the card's object (Gene: 《地球投递须知》) as the page shows it: its name; the entries (tag 'entry', the page in `title`), pages she added herself (tag 'own', with the date) and her margin notes (tag 'note',
   * the page in `title` or '', the local date in `date`) are the items of the 'object' section. null when this card declares none (the page then has no such section).
   */
  readonly object: { readonly name: string } | null;
}

export interface ParsedArchiveRequest { characterId: string; query: string; kind: ArchiveKind | null; offset: number; limit: number }

/** The host's check of whatever arrived: anything that is not exactly the shape above throws a fixed message. */
export function parseArchiveRequest(value: unknown): ParsedArchiveRequest {
  const fail = (): never => { throw new Error('档案的请求格式不正确。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['characterId', 'query', 'kind', 'offset', 'limit'].includes(key))) return fail();
  const { characterId, query, kind, offset, limit } = input;
  if (typeof characterId !== 'string' || !characterId || characterId.length > ARCHIVE_LIMITS.idMax || /[\u0000-\u001f]/u.test(characterId)) return fail();
  if (query !== undefined && typeof query !== 'string') return fail();
  if (kind !== undefined && !ARCHIVE_KINDS.includes(kind as ArchiveKind)) return fail();
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) return fail();
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)) return fail();
  return {
    characterId,
    query: Array.from((query ?? '').trim()).slice(0, ARCHIVE_LIMITS.queryMax).join(''),
    kind: (kind as ArchiveKind | undefined) ?? null,
    offset: offset ?? 0,
    limit: Math.min(limit ?? ARCHIVE_LIMITS.pageDefault, ARCHIVE_LIMITS.pageMax),
  };
}
