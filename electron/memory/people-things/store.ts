// I-088 item 2: `<profile>/people-things/<characterId>.json`, the user's decisions about her people and things (shared/memory/people-things/
// decisions.ts). One file per character, names only (no chat text, no note ids), bounded by the decision lists' own limits, written
// atomically (a temporary file beside it, then a rename), one write at a time. Never part of a character card export. An unreadable
// file is kept as it is and never overwritten in this session (the decisions then live in memory only).

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createAtomicFileWriter, type AtomicFileWriter } from '../../foundation/atomic-file';
import { MutationQueue } from '../../foundation/mutation-queue';
import { decisionsEmpty, emptyDecisions, readDecisions, type PeopleThingsDecisions } from '../../../shared/memory/people-things/decisions';

export const PEOPLE_THINGS_FOLDER = 'people-things';
const CHARACTER = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_BYTES = 1024 * 1024;

export const peopleThingsFile = (directory: string, characterId: string): string => path.join(directory, PEOPLE_THINGS_FOLDER, `${characterId}.json`);

/** Read only (the conversion reads the same file without opening a store): empty when missing or unreadable. */
export async function readPeopleThingsDecisions(directory: string, characterId: string): Promise<PeopleThingsDecisions> {
  if (!CHARACTER.test(characterId)) return emptyDecisions();
  try {
    const file = peopleThingsFile(directory, characterId);
    if ((await stat(file)).size > MAX_BYTES) return emptyDecisions();
    return readDecisions(JSON.parse(await readFile(file, 'utf8')));
  } catch { return emptyDecisions(); }
}

export interface PeopleThingsStoreOptions {
  /** The profile folder, or null before the app is ready (nothing is read or written). */
  directory(): string | null;
  write?: AtomicFileWriter;
}

export class PeopleThingsStore {
  private readonly cache = new Map<string, PeopleThingsDecisions>();
  private readonly blocked = new Set<string>();
  private readonly queue = new MutationQueue();
  private readonly write: AtomicFileWriter;
  constructor(private readonly options: PeopleThingsStoreOptions) { this.write = options.write ?? createAtomicFileWriter(); }

  async load(characterId: string): Promise<PeopleThingsDecisions> {
    const known = this.cache.get(characterId);
    if (known) return known;
    const directory = this.options.directory();
    let value = emptyDecisions();
    if (directory && CHARACTER.test(characterId)) {
      try {
        const file = peopleThingsFile(directory, characterId);
        if ((await stat(file)).size > MAX_BYTES) throw new Error('too large');
        value = readDecisions(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.blocked.add(characterId); }
    }
    return this.cache.get(characterId) ?? (this.cache.set(characterId, value), value);
  }

  /** What is in memory now (the last load or save); empty before the first load. */
  current(characterId: string): PeopleThingsDecisions { return this.cache.get(characterId) ?? emptyDecisions(); }

  /** Replace the decisions. Resolves after the file is written; rejects (and changes nothing) when it cannot be. */
  save(characterId: string, decisions: PeopleThingsDecisions): Promise<void> {
    return this.queue.run(async () => {
      const directory = this.options.directory();
      if (!directory || !CHARACTER.test(characterId)) throw new Error('现在还不能保存。');
      if (this.blocked.has(characterId)) throw new Error('这个角色的"人和事"文件读不出来，为了不覆盖它，这次没有保存。');
      const file = peopleThingsFile(directory, characterId);
      if (decisionsEmpty(decisions)) { await rm(file, { force: true }); this.cache.set(characterId, decisions); return; }
      await mkdir(path.dirname(file), { recursive: true });
      await this.write(file, JSON.stringify(decisions));
      this.cache.set(characterId, decisions);
    });
  }

  /**
   * I-144 (删角色并勾选「同时删除她的记忆」, through the recycle bin): this character's decisions go, file and memory. Also what the bin calls
   * before writing her file back, so no copy held here writes over it.
   */
  forget(characterId: string): Promise<void> {
    return this.queue.run(async () => {
      this.cache.delete(characterId); this.blocked.delete(characterId);
      const directory = this.options.directory();
      if (directory && CHARACTER.test(characterId)) await rm(peopleThingsFile(directory, characterId), { force: true });
    });
  }

  idle(): Promise<void> { return this.queue.idle(); }
}
