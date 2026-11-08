// I-048: watch notes on disk, one file per character: the frame descriptions and story summaries haiku wrote, kept long term, each
// with its keywords. The keywords also go into the character's keyword index (source 'watch') under the id "watch:<id>"; forgetting
// removes the notes, those index entries and the character's cached screenshots. Only under the directory given; the heard
// transcript is never written here.

import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { characterKey, type KeywordIndexStore } from '../memory-keywords/store';
import type { ScreenshotCache } from './screenshots';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from '../../shared/behaviors/watch-timeline/knobs';
import { sanitizeKeyword, type Keyword } from '../../shared/memory-keywords/keyword';

export const WATCH_NOTES_FOLDER = 'watch-notes';
export const WATCH_NOTE_CHARS = 600;

export interface WatchNote {
  readonly id: string;
  readonly kind: 'frame' | 'summary';
  /** The moment it is about (a frame: its capture time). */
  readonly at: number;
  readonly text: string;
  readonly keywords: readonly Keyword[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
export const watchNoteKeywordId = (id: string) => `watch:${id}`;

function clean(raw: unknown): WatchNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !ID.test(item.id) || (item.kind !== 'frame' && item.kind !== 'summary')) return null;
  if (typeof item.at !== 'number' || !Number.isFinite(item.at) || typeof item.text !== 'string' || CONTROL.test(item.text)) return null;
  const text = Array.from(item.text.trim()).slice(0, WATCH_NOTE_CHARS).join('');
  if (!text) return null;
  const keywords = (Array.isArray(item.keywords) ? item.keywords : []).flatMap(keyword => sanitizeKeyword(keyword) ?? []);
  return { id: item.id, kind: item.kind, at: item.at, text, keywords };
}

export class WatchNotesStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly ports: { keywords?: Pick<KeywordIndexStore, 'update' | 'removeSource'>; screenshots?: Pick<ScreenshotCache, 'forget'> } = {},
    private readonly knobs: WatchTimelineKnobs['notes'] = WATCH_TIMELINE_KNOBS.notes,
    private readonly write: AtomicFileWriter = atomicWriteFile,
  ) {}

  private file(characterId: string): string { return path.join(this.root, WATCH_NOTES_FOLDER, `${characterKey(characterId)}.json`); }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async read(characterId: string): Promise<WatchNote[]> {
    try {
      const data = JSON.parse(await readFile(this.file(characterId), 'utf8'));
      return Array.isArray(data?.notes) ? data.notes.flatMap((note: unknown) => clean(note) ?? []) : [];
    } catch { return []; }
  }

  /** The character's notes, oldest first. */
  list(characterId: string): Promise<WatchNote[]> { return this.serial(() => this.read(characterId)); }

  /**
   * Keep one note (a repeated id replaces the old one). Over `keptNotes` the oldest go, and their keywords with them. Returns false
   * when the note is not acceptable.
   */
  add(characterId: string, note: WatchNote): Promise<boolean> {
    const accepted = clean(note);
    if (!accepted) return Promise.resolve(false);
    return this.serial(async () => {
      const notes = (await this.read(characterId)).filter(old => old.id !== accepted.id);
      notes.push(accepted);
      notes.sort((a, b) => a.at - b.at);
      const dropped = notes.splice(0, Math.max(0, notes.length - Math.max(1, this.knobs.keptNotes)));
      await mkdir(path.join(this.root, WATCH_NOTES_FOLDER), { recursive: true });
      await this.write(this.file(characterId), JSON.stringify({ version: 1, notes }));
      await this.ports.keywords?.update(characterId, index => {
        for (const old of dropped) index.remove(watchNoteKeywordId(old.id));
        index.set(watchNoteKeywordId(accepted.id), 'watch', accepted.at, accepted.keywords);
      });
      return true;
    });
  }

  /** Forget everything watching left for this character: notes, their keywords, and the cached screenshots. */
  forget(characterId: string): Promise<void> {
    return this.serial(async () => {
      await rm(this.file(characterId), { force: true });
      await this.ports.keywords?.removeSource(characterId, 'watch');
      await this.ports.screenshots?.forget(characterId);
    });
  }
}
