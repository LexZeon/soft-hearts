// The file behind 一起听 (electron/listen-together/core.ts): `listen-together.json` in the profile directory. Raw segments (the
// latest few, by count and age) and the long-term notes per character, plus the ids of notes the user deleted (so a late result
// never brings one back). No audio. An unreadable file is set aside (renamed), never overwritten or deleted.

import path from 'node:path';
import { readFile, rename, stat } from 'node:fs/promises';
import { createAtomicFileWriter, type AtomicFileWriter } from '../atomic-file';
import { LISTEN_LIMITS, type ListenLanguage, type ListenNote, type ListenPiece, type ListenSegment } from '../../shared/listen-together';
import { NOTE_CAPS } from '../../shared/listen-note';
import { emptyListenFile, type ListenFile } from './core';

export const LISTEN_FILE = 'listen-together.json';
const MAX_BYTES = 16 * 1024 * 1024;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const language = (v: unknown): v is ListenLanguage => v === null || v === 'zh' || v === 'en' || v === 'ja';

function piece(value: unknown): ListenPiece | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || !finite(v.at) || !finite(v.end) || v.end < v.at || !str(v.text, LISTEN_LIMITS.pieceChars) || !v.text || !language(v.language)) return null;
  return { at: v.at, end: v.end, text: v.text, language: v.language };
}
function segment(value: unknown): ListenSegment | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || !id(v.id) || !id(v.characterId) || (v.kind !== 'music' && v.kind !== 'show') || !finite(v.startedAt)
    || !finite(v.lastHeardAt) || !(v.endedAt === null || finite(v.endedAt)) || !Array.isArray(v.pieces) || typeof v.notedUpTo !== 'number'
    || !Number.isFinite(v.notedUpTo) || !finite(v.notedAt)) return null;
  const pieces = v.pieces.map(piece);
  if (pieces.some(p => !p)) return null;
  return { id: v.id, characterId: v.characterId, kind: v.kind, startedAt: v.startedAt, lastHeardAt: v.lastHeardAt, endedAt: v.endedAt as number | null,
    pieces: pieces as ListenPiece[], notedUpTo: v.notedUpTo, notedAt: v.notedAt };
}
function note(value: unknown): ListenNote | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || !id(v.id) || !id(v.characterId) || !id(v.segmentId) || (v.kind !== 'music' && v.kind !== 'show')
    || !['歌', '剧', '视频', '其他'].includes(v.what as string) || !str(v.gist, NOTE_CAPS.gist) || !str(v.mood, NOTE_CAPS.mood) || !str(v.hook, NOTE_CAPS.hook)
    || !Array.isArray(v.points) || v.points.length > NOTE_CAPS.points || !v.points.every(p => str(p, NOTE_CAPS.point)) || typeof v.mention !== 'boolean'
    || !finite(v.startedAt) || !finite(v.endedAt) || typeof v.local !== 'boolean' || !Array.isArray(v.languages) || !v.languages.every(l => l === 'zh' || l === 'en' || l === 'ja')
    || !finite(v.createdAt) || !finite(v.updatedAt) || !Number.isSafeInteger(v.rolls) || !(v.talkedAt === null || finite(v.talkedAt))) return null;
  return { id: v.id, characterId: v.characterId, segmentId: v.segmentId, kind: v.kind, what: v.what as ListenNote['what'], gist: v.gist, mood: v.mood,
    points: [...v.points] as string[], mention: v.mention, hook: v.hook, startedAt: v.startedAt, endedAt: v.endedAt, local: v.local,
    languages: [...v.languages] as ListenNote['languages'], createdAt: v.createdAt, updatedAt: v.updatedAt, rolls: v.rolls as number, talkedAt: v.talkedAt as number | null };
}

/** Lenient per entry: one bad entry is dropped, the rest stays. A wrong top level is an unreadable file. */
export function validateListenFile(value: unknown): ListenFile | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || !Array.isArray(v.segments) || !Array.isArray(v.notes) || !Array.isArray(v.deletedNotes)) return null;
  return { version: 1, segments: v.segments.map(segment).filter((s): s is ListenSegment => !!s).slice(-LISTEN_LIMITS.hardSegments),
    notes: v.notes.map(note).filter((n): n is ListenNote => !!n), deletedNotes: v.deletedNotes.filter(id).slice(-5_000) };
}

export class ListenStore {
  readonly file: string;
  private readonly write: AtomicFileWriter;
  constructor(directory: string, options: { writeFile?: AtomicFileWriter; now?: () => number } = {}) {
    this.file = path.join(directory, LISTEN_FILE);
    this.write = options.writeFile ?? createAtomicFileWriter();
    this.now = options.now ?? Date.now;
  }
  private readonly now: () => number;
  /** True when an unreadable file could not be set aside: nothing is written over it. */
  readOnly = false;

  async load(): Promise<ListenFile> {
    let text: string;
    try {
      if ((await stat(this.file)).size > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'EBIG' });
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyListenFile();
      await this.setAside(); return emptyListenFile();
    }
    let parsed: ListenFile | null = null;
    try { parsed = validateListenFile(JSON.parse(text)); } catch { parsed = null; }
    if (!parsed) { await this.setAside(); return emptyListenFile(); }
    return parsed;
  }

  save(file: ListenFile): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    return this.write(this.file, JSON.stringify(file));
  }

  /** Keep the unreadable file for the user (renamed beside it), so the next save cannot overwrite it. */
  private async setAside(): Promise<void> {
    try { await rename(this.file, `${this.file}.unreadable-${this.now()}`); } catch { this.readOnly = true; /* left where it is, never overwritten */ }
  }
}
