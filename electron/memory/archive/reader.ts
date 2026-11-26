// I-208 角色档案, host side (docs/claude/2026-11-24-i208-archive-step1.md): what ONE character's memory holds, gathered for the page, read only.
// It reads the stores' own files through the same readers the card conversion uses (readers.ts) and keeps no copy: the only thing held here is the
// last answer for a few seconds, so paging and a typed search do not read the files again for every keystroke. Every read is keyed by the character id
// the request names: her connections' profile files (diary, portrait, plans), her chat notes (only the chat scopes of those connections), her
// relationship file; another character's files are never opened. Nothing here writes anything, and nothing here reaches a prompt.
// No Electron import: tests drive it with real files.
import type { CardMilestone, CardObject } from '../../../shared/foundation/character-card';
import { cardMilestoneView } from '../../../shared/cards';
import { parseSpecialDates } from '../../../shared/memory';
import type { NoteSegmentInfo, RelationshipData } from '../../../shared/memory';
import { effectiveDays, dayNumber } from '../../../shared/memory/relationship';
import { shownUpcoming } from '../../../shared/behaviors/upcoming/state';
import { ARCHIVE_KINDS, ARCHIVE_LIMITS, parseArchiveRequest, type ArchiveKind, type CharacterArchiveView } from '../../../shared/memory/archive';
import { localDateKey } from '../diary/diary-dates';
import { readSourceNotes, readSourceProfile, readSourceUpcoming } from './readers';
import { objectArchiveItems } from './object-items';
import { archiveSections, type RawArchive, type RawArchiveItem } from './search';

export interface ArchivePorts {
  profileDirectory: string;
  /** The card as the card store has it (only the milestone and object declarations are read); undefined: no such card, so an empty archive and nothing opened. */
  card(characterId: string): { readonly milestone?: CardMilestone; readonly object?: CardObject } | undefined;
  /** Every connection her memories may sit under (the data map's: the current one, the usual model names, the ones the chat archive learned). */
  providerScopes(characterId: string): string[];
  noteScope(scope: { characterId: string; providerScope: string }): string;
  noteSegments(now: number): readonly NoteSegmentInfo[];
  /** RelationshipHost.snapshot: read only, a missing file is not created. */
  relationship(characterId: string): Promise<RelationshipData>;
  now(): number;
}

/** How long one gathering is reused (paging through a section, a search typed in a few steps). */
const REUSE_MS = 3000;

const dayOf = (ms: number): string => { try { return localDateKey(ms); } catch { return ''; } };

export class CharacterArchiveReader {
  private last: { readonly characterId: string; readonly at: number; readonly raw: RawArchive; readonly milestone: CharacterArchiveView['milestone']; readonly object: CharacterArchiveView['object'] } | null = null;
  constructor(private readonly ports: ArchivePorts) {}

  /** The one call: `value` is whatever the window sent; anything but a valid request throws a fixed message. */
  async read(value: unknown): Promise<CharacterArchiveView> {
    const request = parseArchiveRequest(value);
    // The user profile page asks for the milestone alone: the card and her relationship file are all that is read.
    const gathered = request.kind === 'milestone' ? await this.collect(request.characterId, this.ports.now(), 'milestone')
      : await this.gather(request.characterId, !request.query && request.offset === 0); // opening reads the files again; a further page and a typed search reuse the last reading
    return { characterId: request.characterId, query: request.query, sections: archiveSections(gathered.raw, request), milestone: gathered.milestone, object: gathered.object };
  }

  /** The card's milestone as the page shows it (null: the card declares none) and as a line of the archive. */
  private milestoneOf(card: { readonly milestone?: CardMilestone }, relationship: RelationshipData): { view: CharacterArchiveView['milestone']; items: RawArchiveItem[] } {
    const view = card.milestone ? cardMilestoneView(card.milestone, relationship.cardMilestone?.date ?? null) : null;
    return { view, items: view ? [{ id: 'milestone', date: view.date ?? '', title: view.name, text: view.done ? view.reached : view.notYet, tag: view.done ? 'reached' : 'notYet', sort: 0, words: '里程碑 milestone' }] : [] };
  }

  private async gather(characterId: string, fresh = false): Promise<NonNullable<CharacterArchiveReader['last']>> {
    const now = this.ports.now();
    if (!fresh && this.last && this.last.characterId === characterId && now - this.last.at >= 0 && now - this.last.at < REUSE_MS) return this.last;
    const gathered = await this.collect(characterId, now);
    this.last = { characterId, at: now, ...gathered };
    return this.last;
  }

  private async collect(characterId: string, now: number, only?: 'milestone'): Promise<{ raw: RawArchive; milestone: CharacterArchiveView['milestone']; object: CharacterArchiveView['object'] }> {
    const empty = Object.fromEntries(ARCHIVE_KINDS.map(kind => [kind, [] as RawArchiveItem[]])) as unknown as { [K in ArchiveKind]: RawArchiveItem[] };
    const card = this.ports.card(characterId);
    if (!card) return { raw: empty, milestone: null, object: null }; // not one of her cards: no file is opened for it
    if (only === 'milestone') { const { view, items } = this.milestoneOf(card, await this.ports.relationship(characterId)); return { raw: { ...empty, milestone: items }, milestone: view, object: null }; }
    const scopes = [...new Set(this.ports.providerScopes(characterId))];
    const cap = (list: RawArchiveItem[]): RawArchiveItem[] => list.sort((a, b) => b.sort - a.sort).slice(0, ARCHIVE_LIMITS.gatherMax); // the newest stay when there are more than the page lists

    // Diary and portrait: each connection's profile file (a model the user typed earlier has its own); the same day written twice keeps the later one.
    const diary = new Map<string, RawArchiveItem & { readonly written: number }>();
    const portrait: RawArchiveItem[] = [], told: string[] = [];
    const plans: RawArchiveItem[] = [];
    for (const [index, providerScope] of scopes.entries()) {
      const profile = await readSourceProfile(this.ports.profileDirectory, characterId, providerScope);
      for (const entry of profile?.diary ?? []) {
        const written = entry.editedAt ?? entry.writtenAt, before = diary.get(entry.date);
        if (!before || written > before.written)
          diary.set(entry.date, { id: `diary:${entry.date}`, date: entry.date, title: entry.meme ?? '', text: entry.text, tag: '', sort: Date.parse(`${entry.date}T12:00:00`) || written, words: '', written });
      }
      for (const entry of profile?.entries ?? []) {
        portrait.push({ id: `portrait:${index}:${entry.id}`, date: dayOf(entry.updatedAt), title: '', text: entry.text, tag: entry.kind, sort: entry.updatedAt, words: '' });
        told.push(entry.text);
      }
      const upcoming = await readSourceUpcoming(this.ports.profileDirectory, characterId, providerScope);
      for (const item of shownUpcoming(upcoming, now))
        plans.push({ id: `plan:${index}:${item.id}`, date: dayOf(item.dueAt), title: '', text: item.said ? `${item.what}（${item.said}）` : item.what, tag: item.state, sort: item.dueAt, words: '' });
    }

    // Chat notes: only the chat scopes of her connections.
    const scopeKeys = new Set(scopes.map(providerScope => this.ports.noteScope({ characterId, providerScope })));
    const notes = (await readSourceNotes(this.ports.profileDirectory, scopeKeys, this.ports.noteSegments(now))).map<RawArchiveItem>(note => ({
      id: `note:${note.recordId}`, date: dayOf(note.segmentAt), title: note.body.title, text: [note.body.summary, ...note.body.plans].filter(Boolean).join('\n'),
      tag: '', sort: note.segmentAt, words: [...note.body.people, ...note.body.things, ...note.body.tags, note.body.mood].filter(Boolean).join(' ') }));

    // Dates the user told her (a birthday, an anniversary): worked out from her portrait's own words, the way the special days find them.
    const anniversaries = parseSpecialDates(told).map<RawArchiveItem>((date, index) => ({
      id: `anniversary:${date.kind}-${date.month}-${date.day}`, date: '', title: '', text: `${date.month}-${date.day}`, tag: date.kind, sort: -index,
      words: `${date.kind === 'birthday' ? '生日 birthday' : '纪念日 anniversary'} ${date.month}月${date.day}日` }));

    // Familiarity: the numbers of her relationship file, as they are.
    const relationship = await this.ports.relationship(characterId);
    const familiarity: RawArchiveItem[] = [];
    const known = relationship.days.length || relationship.qualityDays.length || relationship.today.rounds || relationship.backfilled.length;
    if (known) {
      const met = Date.parse(`${relationship.metDate}T12:00:00`) || 0;
      familiarity.push(
        { id: 'familiarity:met', date: relationship.metDate, title: '', text: String(dayNumber(relationship.metDate, dayOf(now))), tag: 'met', sort: 6 + met, words: '认识 第一次 met first' },
        { id: 'familiarity:days', date: '', title: '', text: String(relationship.days.length), tag: 'days', sort: 5 + met, words: '天数 days together' },
        { id: 'familiarity:effective', date: '', title: '', text: String(Math.round(effectiveDays(relationship))), tag: 'effective', sort: 4 + met, words: '有效天数 effective days familiarity 熟悉度' },
        { id: 'familiarity:quality', date: '', title: '', text: String(relationship.qualityDays.length), tag: 'quality', sort: 3 + met, words: '特别的瞬间 quality moments' });
    }
    if (relationship.nickname) familiarity.push({ id: 'familiarity:nickname', date: '', title: '', text: relationship.nickname, tag: 'nickname', sort: 2, words: '称呼 nickname' });
    const callsHer = relationship.herNicknames ?? (relationship.herNickname ? [relationship.herNickname] : []);
    if (callsHer.length) familiarity.push({ id: 'familiarity:her', date: '', title: '', text: callsHer.join(' / '), tag: 'herNickname', sort: 1, words: '称呼 nickname' });

    // The card's milestone: only when the card declares one.
    const { view: milestone, items: milestoneItems } = this.milestoneOf(card, relationship);

    return {
      raw: { diary: cap([...diary.values()].map(({ written: _written, ...item }) => item)), notes: cap(notes), portrait: cap(portrait), anniversaries, plans: cap(plans),
        familiarity, milestone: milestoneItems, object: objectArchiveItems(card.object, relationship.objectNotes ?? []) },
      milestone, object: card.object ? { name: card.object.name } : null,
    };
  }
}
