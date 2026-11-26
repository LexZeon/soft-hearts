// "Recall by meaning": the vectors on disk, one file per character in `memory-vectors/` under the directory it is given (the caller
// passes the profile folder; tests pass a temporary one), next to the memories and the keyword index. The memory files are never
// touched. Each entry is keyed by the memory's id and carries the scope (character + connection) it belongs to, a signature of the
// text it was made from, and the vector; the file as a whole carries the model version, so a vector made by another model or recipe
// is never used (the file reads as empty and is recomputed). Writes go through the repo's atomic writer, one after another.

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { characterKey } from '../memory-keywords/store';
import { EMBEDDING_DIMS } from './engine';

export const VECTOR_FOLDER = 'memory-vectors';
export const VECTOR_FILE_VERSION = 1;

/** `vector` is null for a memory with too little of the user's own words to mean anything (kept so it is not looked at again). */
export interface VectorEntry { readonly scope: string; readonly signature: string; readonly vector: Float32Array | null }

export class CharacterVectors {
  readonly entries = new Map<string, VectorEntry>();
  dirty = false;
  lastSavedAt = 0;
  get size(): number { return this.entries.size; }
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}
function decode(text: string): Float32Array | null {
  try {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.byteLength !== EMBEDDING_DIMS * 4) return null;
    const vector = new Float32Array(EMBEDDING_DIMS);
    for (let i = 0; i < EMBEDDING_DIMS; i++) vector[i] = bytes.readFloatLE(i * 4);
    return vector.every(Number.isFinite) ? vector : null;
  } catch { return null; }
}

export function toFile(vectors: CharacterVectors, model: string): string {
  const records: [string, string, string, string][] = [];
  for (const [id, entry] of vectors.entries) records.push([id, entry.scope, entry.signature, entry.vector ? encode(entry.vector) : '']);
  return JSON.stringify({ version: VECTOR_FILE_VERSION, model, records });
}

/** Anything unreadable, of another model, or of another version reads as an empty set (never as an error). */
export function fromFile(text: string, model: string): CharacterVectors {
  const out = new CharacterVectors();
  try {
    const value = JSON.parse(text) as { version?: unknown; model?: unknown; records?: unknown };
    if (value.version !== VECTOR_FILE_VERSION || value.model !== model || !Array.isArray(value.records)) return out;
    for (const record of value.records) {
      if (!Array.isArray(record) || record.length !== 4 || !record.every(part => typeof part === 'string') || !record[0] || !record[1]) continue;
      const [id, scope, signature, packed] = record as string[];
      const vector = packed ? decode(packed) : null;
      if (packed && !vector) continue; // a damaged vector is simply recomputed
      out.entries.set(id, { scope, signature, vector });
    }
  } catch { /* an unreadable file is an empty one */ }
  return out;
}

export class VectorStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string, private readonly model: string, private readonly write: AtomicFileWriter = atomicWriteFile) {}

  private file(characterId: string): string { return path.join(this.root, VECTOR_FOLDER, `${characterKey(characterId)}.json`); }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  load(characterId: string): Promise<CharacterVectors> {
    return this.serial(async () => {
      try { return fromFile(await readFile(this.file(characterId), 'utf8'), this.model); } catch { return new CharacterVectors(); }
    });
  }

  save(characterId: string, vectors: CharacterVectors): Promise<void> {
    const text = toFile(vectors, this.model);
    return this.serial(async () => {
      await mkdir(path.join(this.root, VECTOR_FOLDER), { recursive: true });
      await this.write(this.file(characterId), text);
    });
  }

  /** Memories were deleted and the caller does not know whose they were: every character's file is checked and rewritten only when it held one. */
  removeFromAll(ids: readonly string[]): Promise<number> {
    return this.serial(async () => {
      let names: string[];
      try { names = await readdir(path.join(this.root, VECTOR_FOLDER)); } catch { return 0; }
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.root, VECTOR_FOLDER, name);
        let vectors: CharacterVectors;
        try { vectors = fromFile(await readFile(file, 'utf8'), this.model); } catch { continue; }
        let here = 0;
        for (const id of ids) if (vectors.entries.delete(id)) here++;
        if (!here) continue;
        await this.write(file, toFile(vectors, this.model)); removed += here;
      }
      return removed;
    });
  }

  forgetCharacter(characterId: string): Promise<void> {
    return this.serial(async () => { await rm(this.file(characterId), { force: true }); });
  }

  /** Every vector file goes (the component was deleted). */
  removeAll(): Promise<void> {
    return this.serial(async () => { await rm(path.join(this.root, VECTOR_FOLDER), { recursive: true, force: true }); });
  }
}
