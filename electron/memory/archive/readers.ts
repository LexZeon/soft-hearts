// Read-only readers of what one character's memory files hold (taken out of electron/cards/character-convert/snapshot.ts on 2026-11-24 for I-208,
// docs/claude/2026-11-24-i208-archive-step1.md: the card conversion and the archive page read the same files the same way, so there is one reader).
// Files are only opened for reading: an unreadable notes or profile file is skipped, never renamed or rewritten (MemoryNotesStore.load would set it
// aside, so it is not used here). No Electron import: tests drive it with real files.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryNote, NoteSegmentInfo } from '../../../shared/memory';
import type { UpcomingStored } from '../../../shared/behaviors/upcoming/interface';
import { validateUpcoming } from '../../../shared/behaviors/upcoming/state';
import type { UserDiaryEntry } from '../diary/diary-data';
import { MEMORY_NOTES_FILE, validateMemoryNotesFile } from '../memory-notes/store';
import { RECORDING_ON_MARKER, userProfileScopeId, type UserProfileEntry } from '../user-profile';

export const PROFILE_FOLDER_NAME = 'user-profiles';
const MAX_READ_BYTES = 16 * 1024 * 1024;

export async function readJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > MAX_READ_BYTES) throw new Error('too large');
  return JSON.parse(await readFile(file, 'utf8'));
}

/** One scope's profile file, read only; null when it is missing or unreadable. Only entries and diary are taken. */
export async function readSourceProfile(profileDirectory: string, characterId: string, providerScope: string): Promise<{ entries: UserProfileEntry[]; diary: UserDiaryEntry[]; changedAt: number; recording: boolean } | null> {
  const file = path.join(profileDirectory, PROFILE_FOLDER_NAME, `profile-${userProfileScopeId({ characterId, providerScope })}.json`);
  let value: Record<string, unknown>;
  try { value = await readJson(file) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const entries = (Array.isArray(value.entries) ? value.entries : []).filter((entry): entry is UserProfileEntry =>
    !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.text === 'string' && !!entry.text.trim()
    && ['fact', 'preference', 'pending_inference'].includes(entry.kind) && Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.updatedAt))
    .map(entry => ({ id: entry.id, kind: entry.kind, text: entry.text, manual: entry.manual === true,
      source: { requestId: String(entry.source?.requestId ?? ''), messageId: String(entry.source?.messageId ?? ''), quote: String(entry.source?.quote ?? '') },
      createdAt: entry.createdAt, updatedAt: entry.updatedAt }));
  const diary = (Array.isArray(value.diary) ? value.diary : []).filter((entry): entry is UserDiaryEntry =>
    !!entry && typeof entry === 'object' && typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && typeof entry.text === 'string'
    && !!entry.text.trim() && Number.isSafeInteger(entry.writtenAt))
    .map(entry => ({ date: entry.date, text: entry.text, writtenAt: entry.writtenAt, ...(Number.isSafeInteger(entry.editedAt) ? { editedAt: entry.editedAt } : {}),
      ...(typeof entry.meme === 'string' && entry.meme.trim() ? { meme: entry.meme } : {}) }));
  const changedAt = Math.max(0, ...entries.map(entry => entry.updatedAt), ...diary.map(entry => entry.editedAt ?? entry.writtenAt));
  const recording = Array.isArray(value.blocked) && value.blocked.includes(RECORDING_ON_MARKER);
  return { entries, diary, changedAt, recording };
}

/** Her notes for these chat scopes (memory-notes.json, read only); an unreadable file means none. */
export async function readSourceNotes(profileDirectory: string, scopes: ReadonlySet<string>, segments: readonly NoteSegmentInfo[]): Promise<(MemoryNote & { scope: string })[]> {
  let file;
  try { file = validateMemoryNotesFile(await readJson(path.join(profileDirectory, MEMORY_NOTES_FILE))); } catch { file = null; }
  if (!file) return [];
  const scopeOf = new Map(segments.filter(segment => scopes.has(segment.scope)).map(segment => [segment.id, segment.scope]));
  const deleted = new Set(file.deleted);
  return file.notes.filter(note => scopeOf.has(note.recordId) && !deleted.has(note.recordId))
    .map(note => ({ ...structuredClone(note), scope: scopeOf.get(note.recordId)! }))
    .sort((a, b) => b.segmentAt - a.segmentAt || a.recordId.localeCompare(b.recordId));
}

/** The plans she remembers for one scope (`upcoming-<scopeId>.json`, read only, strict: a file that does not read means none). */
export async function readSourceUpcoming(profileDirectory: string, characterId: string, providerScope: string): Promise<UpcomingStored | null> {
  const scopeId = userProfileScopeId({ characterId, providerScope });
  try {
    const value = await readJson(path.join(profileDirectory, PROFILE_FOLDER_NAME, `upcoming-${scopeId}.json`)) as { version?: unknown; scopeId?: unknown; upcoming?: unknown };
    if (!value || value.version !== 1 || value.scopeId !== scopeId) return null;
    return validateUpcoming(value.upcoming);
  } catch { return null; }
}
