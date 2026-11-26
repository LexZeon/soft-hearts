// I-134 step 3: where her note about the user lives. One file per character and connection beside the profile files:
// `her-note-<scopeId>.json` ({ version: 1, scopeId, versions }), the scope id being the user profile's own. Newest version first, the last
// MAX_VERSIONS kept so she can be rolled back (I-133: low visibility, a way back). Rules, as for the other stores beside the profile:
// written with the atomic writer; read tolerantly (a file that does not read counts as no note and is never written over until the user
// clears it); never exported with a character card, never part of diagnostics, never logged. `current()` is synchronous on purpose: the
// chat session asks for it when a conversation starts and must not wait.
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createAtomicFileWriter, type AtomicFileDependencies } from '../../foundation/atomic-file';
import { userProfileScopeId, type UserProfileScope } from '../user-profile';

export const HER_NOTE_MAX_VERSIONS = 5;
export const HER_NOTE_MAX_CHARS = 3000;
const MAX_BYTES = 200_000;

/** `cutoffAt`: the createdAt of the last message this version covered; the next rewrite reads what came after it. */
/**
 * `form` (I-139, only written under the switch): 'relaxed' = written in the "我注意到……" form from her previous page and the new chat;
 * 'raw' = written again from the whole raw chat archive. Absent: the I-134 form. The writer reads it to decide the next write.
 */
export type HerNoteForm = 'relaxed' | 'raw';
export interface HerNoteVersion { text: string; writtenAt: number; cutoffAt: number; form?: HerNoteForm }

const copyVersion = (v: HerNoteVersion): HerNoteVersion =>
  ({ text: v.text, writtenAt: v.writtenAt, cutoffAt: v.cutoffAt, ...(v.form === 'relaxed' || v.form === 'raw' ? { form: v.form } : {}) });

function validVersion(value: unknown): value is HerNoteVersion {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && v.text.trim() !== '' && v.text.length <= HER_NOTE_MAX_CHARS
    && Number.isFinite(v.writtenAt) && Number.isFinite(v.cutoffAt);
}

export class HerNoteStore {
  private readonly cache = new Map<string, HerNoteVersion[]>();
  /** Scopes whose file did not read: nothing is written over it. */
  private readonly unreadable = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private readonly atomic?: AtomicFileDependencies) {
    if (!path.isAbsolute(directory) || directory.includes('\0')) throw Error('笔记目录须由宿主提供。');
  }

  file(scope: UserProfileScope): string { return path.join(this.directory, `her-note-${userProfileScopeId(scope)}.json`); }

  private load(scope: UserProfileScope): HerNoteVersion[] {
    const id = userProfileScopeId(scope), hit = this.cache.get(id);
    if (hit) return hit;
    let versions: HerNoteVersion[] = [];
    try {
      const bytes = readFileSync(this.file(scope), 'utf8');
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('too large');
      const data = JSON.parse(bytes) as { version?: unknown; scopeId?: unknown; versions?: unknown };
      if (!data || data.version !== 1 || data.scopeId !== id || !Array.isArray(data.versions)) throw Error('wrong file');
      versions = data.versions.filter(validVersion).slice(0, HER_NOTE_MAX_VERSIONS).map(copyVersion);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.unreadable.add(id);
    }
    this.cache.set(id, versions);
    return versions;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(scope: UserProfileScope, versions: HerNoteVersion[]): Promise<void> {
    const id = userProfileScopeId(scope);
    if (!versions.length) { await rm(this.file(scope), { force: true }); this.unreadable.delete(id); this.cache.set(id, []); return; }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    await createAtomicFileWriter({ ...this.atomic })(this.file(scope), JSON.stringify({ version: 1, scopeId: id, versions }) + '\n');
    this.unreadable.delete(id);
    this.cache.set(id, versions);
  }

  /** The note she reads at the start of a conversation, or null. */
  current(scope: UserProfileScope): HerNoteVersion | null { return this.load(scope)[0] ?? null; }
  /** Newest first; index 0 is the current one. */
  versions(scope: UserProfileScope): readonly HerNoteVersion[] { return this.load(scope).map(copyVersion); }

  /** A new current version; older ones beyond the last five fall away. Resolves false when the file is unreadable (kept as it is) or the text is not usable. */
  add(scope: UserProfileScope, version: HerNoteVersion): Promise<boolean> {
    return this.serial(async () => {
      const id = userProfileScopeId(scope);
      if (!validVersion(version)) return false;
      const existing = this.load(scope);
      if (this.unreadable.has(id)) return false;
      await this.persist(scope, [copyVersion(version), ...existing].slice(0, HER_NOTE_MAX_VERSIONS));
      return true;
    });
  }

  /** Go back to version `index` (as in versions()): the newer ones are dropped, so the next rewrite reads the chat after that one's cutoff again. */
  rollback(scope: UserProfileScope, index: number): Promise<boolean> {
    return this.serial(async () => {
      const existing = this.load(scope);
      if (!Number.isInteger(index) || index < 0 || index >= existing.length) return false;
      if (index === 0) return true;
      await this.persist(scope, existing.slice(index));
      return true;
    });
  }

  /** Forget the note and every version of it (also what "允许记录" turning off does). */
  /** I-144 回收站: her file was written back from the bin; what is held here for this scope is read again from it. */
  reload(scope: UserProfileScope): Promise<void> {
    const id = userProfileScopeId(scope);
    return this.serial(async () => { this.cache.delete(id); this.unreadable.delete(id); });
  }
  clear(scope: UserProfileScope): Promise<void> {
    return this.serial(async () => { await this.persist(scope, []); });
  }
}
