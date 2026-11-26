// I-071 v2 第三步 转换: what the source character remembers, read once and READ ONLY (rule: memories and logs are never
// modified). Files are only opened for reading: an unreadable notes or profile file is skipped, never renamed or rewritten
// (MemoryNotesStore.load would set it aside, so it is not used here). No Electron import: tests drive it with real stores.
// (the file readers moved to electron/memory/archive/readers.ts)
import path from 'node:path';
import type { CharacterCard } from '../../../shared/foundation/character-card';
import { cardLanguageOf } from '../../../shared/foundation/character-card';
import { CONVERSION_LIMITS, CONVERSION_PERSONA_EXCERPT_CHARS, conversionNames, type ConversionCounts, type ConversionName, type ConversionRecordingSource } from '../../../shared/cards/character-convert';
import type { MemoryNote } from '../../../shared/memory';
import type { NoteSegmentInfo } from '../../../shared/memory';
import type { RelationshipData } from '../../../shared/memory';
import type { TtsStyleBinding } from '../../../shared/foundation/tts-config';
import { characterProviderScopes } from '../character-forget';
import type { UserDiaryEntry } from '../../memory';
import { PROFILE_FOLDER_NAME, readJson, readSourceNotes, readSourceProfile } from '../../memory';
import { userProfileScopeId, type UserProfileEntry } from '../../memory';
import { findAddressForms, findCandidateNames, findProperNouns, type CandidateName } from './addresses';
import { readPeopleThingsDecisions } from '../../memory';
import { gatherPeopleThings } from '../../../shared/memory/people-things/gather'; // direct, not via shared/memory: the page would pull this host-only module into the renderer bundle (docs/claude/2026-11-16-overhaul-parts-2.md)
import { validateReviewData, type ReviewEntry } from '../../memory';

export { PROFILE_FOLDER_NAME, readSourceNotes, readSourceProfile };

export interface ConversionSourcePorts {
  profileDirectory: string;
  /** The card as the card store has it, with the model it goes with (host only); undefined when there is no such card. */
  card(id: string): Promise<(CharacterCard & { modelPath?: string }) | undefined> | (CharacterCard & { modelPath?: string }) | undefined;
  /** Read only: RelationshipHost.snapshot. */
  relationship(characterId: string): Promise<RelationshipData>;
  /** The connection scopes her memories may sit under (forgettableProviderScopes) and the current one. */
  providerScopes(): string[];
  currentProviderScope(): string;
  memory: {
    noteScope(scope: { characterId: string; providerScope: string }): string;
    noteSegments(now: number): readonly NoteSegmentInfo[];
    providerScopesOf?(characterId: string): string[];
  };
  /** The reading voice: the provider in use and this character's own voice settings (one per model she was read with). */
  voice(characterId: string): { provider: 'system' | 'bailian' | 'fish'; bindings: TtsStyleBinding[] };
  now(): number;
}

export interface SourceProfile {
  providerScope: string;
  /** The source scope's own "允许记录" (its marker in the profile file); the new card carries it, nothing wider. */
  recording: boolean;
  entries: UserProfileEntry[];
  /** The last CONVERSION_LIMITS.diaryDays days, oldest first. */
  diary: UserDiaryEntry[];
}

export interface SourceSnapshot {
  /** I-088 第 1 条: her newest weekly and monthly look-backs (oldest first), carried like the diary days. Absent: none. */
  reviews?: ReviewEntry[];
  card: CharacterCard & { modelPath?: string };
  relationship: RelationshipData;
  /** Her notes, newest first, at most CONVERSION_LIMITS.notes; `at` is the segment's own time. */
  notes: (MemoryNote & { scope: string })[];
  notesTotal: number;
  profile: SourceProfile | null;
  voice: ReturnType<ConversionSourcePorts['voice']>;
  names: ConversionName[];
  /** Fix 6: frequent names and short quoted words from her memories that are not offered (the assistant judges them; data, not instructions). */
  candidates: CandidateName[];
  counts: ConversionCounts;
  /** Fix 8: the names one person goes by in her notes (people-and-things, with the user's merges): a left-out name's group. */
  aliasGroups?: string[][];
  /** Fix 8 (Codex T-240 F07): where the new card's 「允许记录」 really comes from (the shared switch, or the carried profile's marker). */
  recordingSource?: ConversionRecordingSource;
}

const shiftDays = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
};
export const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * I-088 第 1 条: one scope's look-backs (`review-<scopeId>.json`, read only): the newest CONVERSION_LIMITS.reviewWeeks weeks and reviewMonths months,
 * oldest first. A file that is missing or does not read means none.
 */
export async function readSourceReviews(profileDirectory: string, characterId: string, providerScope: string, total?: { count: number }): Promise<ReviewEntry[]> {
  const scopeId = userProfileScopeId({ characterId, providerScope });
  try {
    const value = await readJson(path.join(profileDirectory, PROFILE_FOLDER_NAME, `review-${scopeId}.json`)) as { version?: unknown; scopeId?: unknown; data?: unknown };
    if (!value || value.version !== 1 || value.scopeId !== scopeId) return [];
    const items = validateReviewData(value.data).items;
    if (total) total.count = items.filter(item => item.kind === 'week' || item.kind === 'month').length;
    const newest = (kind: 'week' | 'month', count: number) => items.filter(item => item.kind === kind).sort((a, b) => b.key.localeCompare(a.key)).slice(0, count);
    return [...newest('week', CONVERSION_LIMITS.reviewWeeks), ...newest('month', CONVERSION_LIMITS.reviewMonths)]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)).map(item => structuredClone(item));
  } catch { return []; }
}

/**
 * Fix 8 (Codex T-240 F07): the user's shared 「允许记录」 choice (user-profiles/recording.json, read only; UserProfileStore writes it):
 * true / false when chosen, null when never chosen (then each card's own marker decides).
 */
export async function readRecordingChoice(profileDirectory: string): Promise<boolean | null> {
  try {
    const raw = await readJson(path.join(profileDirectory, PROFILE_FOLDER_NAME, 'recording.json')) as { version?: unknown; on?: unknown };
    return raw && raw.version === 1 && typeof raw.on === 'boolean' ? raw.on : null;
  } catch { return null; }
}

/** The text her notes, diary and profile carry (for finding the forms of address that only live there). */
export function addressTexts(notes: readonly MemoryNote[], profile: SourceProfile | null, reviews: readonly ReviewEntry[] = []): string[] {
  const out: string[] = [];
  for (const { body } of notes) out.push(body.title, body.summary, body.mood, ...body.people, ...body.things, ...body.plans);
  for (const entry of profile?.entries ?? []) out.push(entry.text);
  for (const entry of profile?.diary ?? []) out.push(entry.text, entry.meme ?? '');
  for (const entry of reviews) out.push(entry.text, entry.carry ?? '');
  return out.filter(Boolean);
}

const cardTexts = (card: CharacterCard): string[] => [card.description, card.personality, card.scenario, card.greeting, card.examples, card.systemPrompt, card.understandingNotes ?? ''].filter(Boolean);

/** The persona as the Claude 助手 reads it to propose names (bounded; the rules and setting first, examples last). */
export function personaExcerpt(card: CharacterCard): string {
  const parts: [string, string][] = [['description', card.description], ['personality', card.personality], ['scenario', card.scenario], ['systemPrompt', card.systemPrompt],
    ['understandingNotes', card.understandingNotes ?? ''], ['greeting', card.greeting], ['examples', card.examples]];
  const text = parts.filter(([, value]) => value.trim()).map(([field, value]) => `[${field}]\n${value.trim()}`).join('\n\n');
  const chars = Array.from(text);
  return chars.length <= CONVERSION_PERSONA_EXCERPT_CHARS ? text : `${chars.slice(0, CONVERSION_PERSONA_EXCERPT_CHARS - 1).join('')}…`;
}

/** The persona's own text (name and card fields): where a name found by the assistant counts as found in the persona. */
export const personaCorpus = (card: CharacterCard): string => [card.name, ...cardTexts(card)].join('\n');

/** Everything the conversion reads that a name can occur in: the card's persona and her memories (an `extra` name must occur here). */
export function sourceCorpus(snapshot: Pick<SourceSnapshot, 'card' | 'notes' | 'profile'> & { reviews?: readonly ReviewEntry[] }): string {
  return [snapshot.card.name, ...cardTexts(snapshot.card), ...addressTexts(snapshot.notes, snapshot.profile, snapshot.reviews), ...snapshot.notes.flatMap(note => [...note.body.tags])].join('\n');
}

/** Everything the conversion carries, read once. Throws a fixed message when the card is gone. */
export async function readSourceSnapshot(characterId: string, ports: ConversionSourcePorts): Promise<SourceSnapshot> {
  const card = await ports.card(characterId);
  if (!card) throw new Error('这张角色卡不在了。');
  const relationship = structuredClone(await ports.relationship(characterId));
  const providerScopes = characterProviderScopes(characterId, ports.providerScopes(), id => ports.memory.providerScopesOf?.(id) ?? []);
  const scopeKeys = new Set(providerScopes.map(providerScope => ports.memory.noteScope({ characterId, providerScope })));
  const all = await readSourceNotes(ports.profileDirectory, scopeKeys, ports.memory.noteSegments(ports.now()));
  const notes = all.slice(0, CONVERSION_LIMITS.notes);
  // Her profile and diary: the current connection's file, else the one changed last (a model the user typed earlier).
  const current = ports.currentProviderScope();
  let profile: SourceProfile | null = null, best = -1;
  for (const providerScope of [current, ...providerScopes.filter(scope => scope !== current)]) {
    const read = await readSourceProfile(ports.profileDirectory, characterId, providerScope);
    if (!read || (!read.entries.length && !read.diary.length && !read.recording)) continue;
    const rank = providerScope === current ? Number.MAX_SAFE_INTEGER : read.changedAt;
    if (rank > best) { best = rank; profile = { providerScope, recording: read.recording, entries: read.entries, diary: read.diary }; }
  }
  let diaryOlder = 0;
  if (profile) {
    const since = shiftDays(localDay(ports.now()), -CONVERSION_LIMITS.diaryDays);
    diaryOlder = profile.diary.filter(entry => entry.date <= since).length;
    profile.diary = profile.diary.filter(entry => entry.date > since).sort((a, b) => a.date.localeCompare(b.date));
  }
  const reviewTotal = { count: 0 };
  const reviews = await readSourceReviews(ports.profileDirectory, characterId, profile?.providerScope ?? current, reviewTotal);
  const counts: ConversionCounts = {
    notes: all.length, notesCarried: notes.length, ...(reviews.length ? { reviews: reviews.length } : {}),
    ...(diaryOlder ? { diaryOlder } : {}), ...(reviewTotal.count > reviews.length ? { reviewsOlder: reviewTotal.count - reviews.length } : {}),
    profileEntries: profile?.entries.length ?? 0, diaryDays: profile?.diary.length ?? 0, memes: profile?.diary.filter(entry => entry.meme).length ?? 0,
    knownDays: relationship.days.length, qualityDays: relationship.qualityDays.length,
    metDate: relationship.days.length || relationship.backfilled.length || relationship.qualityDays.length ? relationship.metDate : null,
  };
  const texts = addressTexts(notes, profile, reviews), known = [card.name, relationship.nickname ?? '', relationship.herNickname ?? ''];
  const people = notes.flatMap(note => note.body.people);
  // I-088: the names one person goes by (read only: the same gathering as the page "你生活里的人和事", with the user's own decisions).
  const decisions = await readPeopleThingsDecisions(ports.profileDirectory, characterId);
  const gathered = gatherPeopleThings(notes.map(note => ({ recordId: note.recordId, at: note.segmentAt, people: note.body.people, things: note.body.things })), decisions);
  const aliasGroups = gathered.entries.filter(entry => entry.kind === 'person' && entry.names.length > 1).map(entry => entry.names.map(name => name.text));
  const aliases = findAddressForms(texts, known, people, aliasGroups);
  // A pattern match in the persona counts as a proper noun only when her notes name it too (people or things); the assistant reads
  // the persona itself and proposes the rest.
  const named = [...people, ...notes.flatMap(note => note.body.things)].map(entry => entry.toLocaleLowerCase());
  const looksLikeName = (text: string) => named.some(entry => entry.includes(text.toLocaleLowerCase()));
  const terms = findProperNouns(cardTexts(card), [...known, ...aliases.map(alias => alias.text)], [...cardTexts(card), ...texts], looksLikeName);
  const recordingSource: ConversionRecordingSource = { global: await readRecordingChoice(ports.profileDirectory), otherConnection: !!profile && profile.providerScope !== current };
  return { card: structuredClone(card), relationship, notes, notesTotal: all.length, profile, ...(reviews.length ? { reviews } : {}), voice: ports.voice(characterId),
    aliasGroups, recordingSource,
    names: conversionNames(card, relationship, aliases, terms), counts,
    candidates: findCandidateNames(texts, people, [...known, ...aliases.map(alias => alias.text), ...terms.map(term => term.text)]) };
}

/** The language a snapshot's card speaks. */
export const snapshotLanguage = (snapshot: SourceSnapshot) => cardLanguageOf(snapshot.card);
