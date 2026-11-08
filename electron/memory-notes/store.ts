// The file behind I-021 (electron/memory-notes/core.ts): `memory-notes.json` beside `memories.jsonl` in the profile directory.
// One note per chat segment (by record id), the ids of notes the user deleted (never written again while the segment stays),
// failed attempts per segment text, and today's call count. It never holds a copy of the conversation itself. An unreadable file
// is set aside (renamed), never overwritten or deleted; `memories.jsonl` is never opened here.

import path from 'node:path';
import { readFile, rename, stat } from 'node:fs/promises';
import { createAtomicFileWriter, type AtomicFileWriter } from '../atomic-file';
import type { MemoryNote } from '../../shared/memory-notes/interface';
import { NOTE_CAPS } from '../../shared/memory-notes/note';

export const MEMORY_NOTES_FILE = 'memory-notes.json';
const MAX_BYTES = 16 * 1024 * 1024;

export interface MemoryNotesFile {
  version: 1;
  notes: MemoryNote[];
  /** Record ids whose note the user deleted. */
  deleted: string[];
  /**
   * Of those, the ones whose memory went into the recycle bin (when): if it comes back, its note is still deleted. Dropped once
   * the bin cannot hold it any more (core.ts PARKED_DAYS), or when the memory is deleted for good. Optional in older files.
   */
  parked: { recordId: string; at: number }[];
  /** Segments whose text the small model failed to note, per text (a changed text starts over). */
  failed: { recordId: string; source: string; attempts: number }[];
  /** Calls started on one local day (the daily cap). */
  calls: { day: string; count: number };
}
export const emptyMemoryNotesFile = (): MemoryNotesFile => ({ version: 1, notes: [], deleted: [], parked: [], failed: [], calls: { day: '', count: 0 } });

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(v);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && Array.from(v).length <= max && !CONTROL.test(v);
const strings = (v: unknown, items: number, max: number, min = 0): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= items && v.every(item => str(item, max) && !!item.trim());

function note(value: unknown): MemoryNote | null {
  const v = value as Record<string, unknown> | null;
  const b = v?.body as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object' || !id(v.recordId) || !id(v.source) || !finite(v.segmentAt) || !finite(v.writtenAt) || !b || typeof b !== 'object'
    || !str(b.title, NOTE_CAPS.title) || !b.title.trim() || !str(b.summary, NOTE_CAPS.summary) || !b.summary.trim() || !str(b.mood, NOTE_CAPS.mood)
    || !strings(b.people, NOTE_CAPS.people, NOTE_CAPS.person) || !strings(b.things, NOTE_CAPS.things, NOTE_CAPS.thing)
    || !strings(b.plans, NOTE_CAPS.plans, NOTE_CAPS.plan) || !strings(b.tags, NOTE_CAPS.tagsMax, NOTE_CAPS.tag, 1)) return null;
  return { recordId: v.recordId, source: v.source, segmentAt: v.segmentAt, writtenAt: v.writtenAt,
    body: { title: b.title, summary: b.summary, people: [...b.people], things: [...b.things], mood: b.mood, plans: [...b.plans], tags: [...b.tags] } };
}

/** Lenient per entry: one bad entry is dropped, the rest stays. A wrong top level is an unreadable file. */
export function validateMemoryNotesFile(value: unknown): MemoryNotesFile | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || !Array.isArray(v.notes) || !Array.isArray(v.deleted) || !Array.isArray(v.failed)) return null;
  const calls = v.calls as Record<string, unknown> | undefined;
  const notes = new Map<string, MemoryNote>();
  for (const item of v.notes.map(note)) if (item) notes.set(item.recordId, item);
  const parked = new Map<string, number>();
  for (const item of Array.isArray(v.parked) ? v.parked : []) if (item && typeof item === 'object' && id(item.recordId) && finite(item.at)) parked.set(item.recordId, item.at);
  return {
    version: 1, notes: [...notes.values()], deleted: [...new Set(v.deleted.filter(id))],
    parked: [...parked].map(([recordId, at]) => ({ recordId, at })),
    failed: v.failed.filter((item): item is MemoryNotesFile['failed'][number] => !!item && typeof item === 'object' && id(item.recordId) && id(item.source)
      && Number.isSafeInteger(item.attempts) && item.attempts > 0 && item.attempts <= 100).map(item => ({ recordId: item.recordId, source: item.source, attempts: item.attempts })),
    calls: calls && typeof calls.day === 'string' && calls.day.length <= 20 && Number.isSafeInteger(calls.count) && (calls.count as number) >= 0
      ? { day: calls.day, count: calls.count as number } : { day: '', count: 0 },
  };
}

export class MemoryNotesStore {
  readonly file: string;
  private readonly write: AtomicFileWriter;
  private readonly now: () => number;
  /** True when an unreadable file could not be set aside: nothing is written over it. */
  readOnly = false;
  constructor(directory: string, options: { writeFile?: AtomicFileWriter; now?: () => number } = {}) {
    this.file = path.join(directory, MEMORY_NOTES_FILE);
    this.write = options.writeFile ?? createAtomicFileWriter();
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<MemoryNotesFile> {
    let text: string;
    try {
      if ((await stat(this.file)).size > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'EBIG' });
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyMemoryNotesFile();
      await this.setAside(); return emptyMemoryNotesFile();
    }
    let parsed: MemoryNotesFile | null = null;
    try { parsed = validateMemoryNotesFile(JSON.parse(text)); } catch { parsed = null; }
    if (!parsed) { await this.setAside(); return emptyMemoryNotesFile(); }
    return parsed;
  }

  save(file: MemoryNotesFile): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    return this.write(this.file, JSON.stringify(file));
  }

  /** Keep the unreadable file for the user (renamed beside it), so the next save cannot overwrite it. */
  private async setAside(): Promise<void> {
    try { await rename(this.file, `${this.file}.unreadable-${this.now()}`); } catch { this.readOnly = true; /* left where it is, never overwritten */ }
  }
}
