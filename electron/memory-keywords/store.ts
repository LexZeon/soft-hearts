// I-049 step 1: the keyword index on disk, one file per character, in its own folder under the directory it is given (the caller
// passes the character's profile folder; tests pass a temporary one). The note files are never touched. Writes go through the
// repo's atomic writer and are done one after another, so two updates cannot overwrite each other.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { KeywordIndex } from '../../shared/memory-keywords/keyword-index';
import { MEMORY_KEYWORDS_KNOBS, type KeywordSource, type MemoryKeywordsKnobs } from '../../shared/memory-keywords/knobs';

export const KEYWORD_FOLDER = 'memory-keywords';

/** A folder or file name for a character id: readable part plus a hash, so two ids never share one and no id can leave the folder. */
export function characterKey(characterId: string): string {
  if (typeof characterId !== 'string' || !characterId.trim()) throw new Error('character id is empty');
  const slug = characterId.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 24) || 'c';
  return `${slug}-${createHash('sha256').update(characterId).digest('hex').slice(0, 10)}`;
}

export class KeywordIndexStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly write: AtomicFileWriter = atomicWriteFile,
    private readonly knobs: MemoryKeywordsKnobs = MEMORY_KEYWORDS_KNOBS,
  ) {}

  private file(characterId: string): string { return path.join(this.root, KEYWORD_FOLDER, `${characterKey(characterId)}.json`); }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(characterId: string): Promise<KeywordIndex> {
    try { return KeywordIndex.fromFile(JSON.parse(await readFile(this.file(characterId), 'utf8')), this.knobs); }
    catch { return new KeywordIndex(this.knobs); }
  }
  private async save(characterId: string, index: KeywordIndex): Promise<void> {
    await mkdir(path.join(this.root, KEYWORD_FOLDER), { recursive: true });
    await this.write(this.file(characterId), JSON.stringify(index.toFile()));
  }

  /** The character's index (empty when there is no file or it cannot be read). */
  load(characterId: string): Promise<KeywordIndex> { return this.serial(() => this.read(characterId)); }

  /** Read, change, write back. Returns what `change` returned. */
  update<T>(characterId: string, change: (index: KeywordIndex) => T): Promise<T> {
    return this.serial(async () => {
      const index = await this.read(characterId);
      const result = change(index);
      await this.save(characterId, index);
      return result;
    });
  }

  /** A note was deleted or forgotten: its keywords go too. */
  removeNote(characterId: string, noteId: string): Promise<boolean> { return this.update(characterId, index => index.remove(noteId)); }
  removeSource(characterId: string, source: KeywordSource): Promise<number> { return this.update(characterId, index => index.removeSource(source)); }

  /**
   * A memory was deleted and the caller does not know whose index held it: every character's file is checked and rewritten only when
   * it held one of the ids. Returns how many keyword records went.
   */
  removeFromAll(noteIds: readonly string[]): Promise<number> {
    return this.serial(async () => {
      let names: string[];
      try { names = await readdir(path.join(this.root, KEYWORD_FOLDER)); } catch { return 0; }
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.root, KEYWORD_FOLDER, name);
        let index: KeywordIndex;
        try { index = KeywordIndex.fromFile(JSON.parse(await readFile(file, 'utf8')), this.knobs); } catch { continue; }
        let here = 0;
        for (const id of noteIds) if (index.remove(id)) here++;
        if (!here) continue;
        await this.write(file, JSON.stringify(index.toFile()));
        removed += here;
      }
      return removed;
    });
  }

  /** Forget the character's whole index file. */
  forgetCharacter(characterId: string): Promise<void> {
    return this.serial(() => rm(this.file(characterId), { force: true }));
  }
}
