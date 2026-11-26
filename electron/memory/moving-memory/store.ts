// I-139 A3: where her "most moving thing" lives (opening layer 2). One file per character and connection beside the profile files, like
// her note (electron/memory/her-note/store.ts): `moving-memory-<scopeId>.json`. Newest version first, the last MAX_VERSIONS kept so the user can
// bring an older one back. The user can delete the current one: it stays in the list (a recycle bin of its own) but is no longer read.
// Rules as for the other stores beside the profile: atomic writes; tolerant reads (a file that does not read counts as nothing and is never
// written over until the user clears it); never exported with a character card, never in diagnostics, never logged. `current()` is
// synchronous on purpose: the chat session asks for it while assembling an opening and must not wait.
// Security review 2026-11-15: a stored version whose words read like an instruction to a model is never loaded; the user's deletions are
// remembered as words (`deleted`) so an overlapping quote is not picked again; `prune` drops every version whose record is gone; the
// buttons name a version by `chosenAt`, not by its place in the list.
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createAtomicFileWriter, type AtomicFileDependencies } from '../../foundation/atomic-file';
import { userProfileScopeId, type UserProfileScope } from '../user-profile';
import { isDateKey } from '../diary/diary-dates';
import { looksLikeInstruction } from './quote-check';

export const MOVING_MEMORY_MAX_VERSIONS = 10;
export const MOVING_MEMORY_MAX_CHARS = 200;
/** How many of the user's deleted quotes are remembered (so they are not picked again). */
export const MOVING_MEMORY_MAX_DELETED = 20;
const MAX_BYTES = 100_000;

/** `quoteRef`: where in the archive the words are (the record's createdAt and who said it), so they can be found again. */
export interface MovingMemoryVersion {
  date: string;
  text: string;
  quoteRef: { at: number; role: 'user' | 'assistant' };
  chosenAt: number;
  why?: string;
}

/**
 * What the store keeps besides the versions: `cleared`, nothing is current (the user deleted it, or its record went); `deleted`, the words
 * the user deleted, newest first; the last handoff's day and how far it read.
 */
export interface MovingMemoryState {
  versions: readonly MovingMemoryVersion[];
  cleared: boolean;
  deleted: readonly string[];
  lastHandoffDay: string;
  lastHandoffCutoffAt: number;
}

function usableText(text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== '' && text.length <= MOVING_MEMORY_MAX_CHARS && !/[\r\n]/u.test(text) && !looksLikeInstruction(text);
}
function validVersion(value: unknown): value is MovingMemoryVersion {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>, ref = v.quoteRef as Record<string, unknown> | undefined;
  return isDateKey(v.date) && usableText(v.text)
    && !!ref && Number.isFinite(ref.at) && (ref.role === 'user' || ref.role === 'assistant')
    && Number.isFinite(v.chosenAt) && (v.why === undefined || (typeof v.why === 'string' && v.why.length <= 400));
}
const copy = (v: MovingMemoryVersion): MovingMemoryVersion => ({ date: v.date, text: v.text, quoteRef: { at: v.quoteRef.at, role: v.quoteRef.role }, chosenAt: v.chosenAt, ...(v.why ? { why: v.why } : {}) });
const empty = (): MovingMemoryState => ({ versions: [], cleared: false, deleted: [], lastHandoffDay: '', lastHandoffCutoffAt: 0 });
const remember = (deleted: readonly string[], text: string) => [text, ...deleted.filter(d => d !== text)].slice(0, MOVING_MEMORY_MAX_DELETED);

export class MovingMemoryStore {
  private readonly cache = new Map<string, MovingMemoryState>();
  /** Scopes whose file did not read: nothing is written over it. */
  private readonly unreadable = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private readonly atomic?: AtomicFileDependencies) {
    if (!path.isAbsolute(directory) || directory.includes('\0')) throw Error('记忆目录须由宿主提供。');
  }

  file(scope: UserProfileScope): string { return path.join(this.directory, `moving-memory-${userProfileScopeId(scope)}.json`); }

  private load(scope: UserProfileScope): MovingMemoryState {
    const id = userProfileScopeId(scope), hit = this.cache.get(id);
    if (hit) return hit;
    let state = empty();
    try {
      const bytes = readFileSync(this.file(scope), 'utf8');
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('too large');
      const data = JSON.parse(bytes) as Record<string, unknown>;
      if (!data || data.version !== 1 || data.scopeId !== id || !Array.isArray(data.versions)) throw Error('wrong file');
      const versions = data.versions.filter(validVersion).slice(0, MOVING_MEMORY_MAX_VERSIONS).map(copy);
      const cleared = data.cleared === true;
      // Files from before `deleted` existed: the deleted current one is the one deleted quote known.
      const deleted = Array.isArray(data.deleted) ? data.deleted.filter((d): d is string => typeof d === 'string' && d.trim() !== '' && d.length <= MOVING_MEMORY_MAX_CHARS)
        : cleared && versions[0] ? [versions[0].text] : [];
      state = {
        versions, cleared, deleted: deleted.slice(0, MOVING_MEMORY_MAX_DELETED),
        lastHandoffDay: typeof data.lastHandoffDay === 'string' && (data.lastHandoffDay === '' || isDateKey(data.lastHandoffDay)) ? data.lastHandoffDay : '',
        lastHandoffCutoffAt: Number.isFinite(data.lastHandoffCutoffAt) ? Number(data.lastHandoffCutoffAt) : 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.unreadable.add(id);
    }
    this.cache.set(id, state);
    return state;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(scope: UserProfileScope, state: MovingMemoryState): Promise<void> {
    const id = userProfileScopeId(scope);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    await createAtomicFileWriter({ ...this.atomic })(this.file(scope), JSON.stringify({ version: 1, scopeId: id, ...state, versions: state.versions.map(copy), deleted: [...state.deleted] }) + '\n');
    this.unreadable.delete(id);
    this.cache.set(id, state);
  }

  /** The thing she opens with, or null (none yet, or the user deleted it). */
  current(scope: UserProfileScope): MovingMemoryVersion | null {
    const state = this.load(scope);
    return state.cleared ? null : state.versions[0] ? copy(state.versions[0]) : null;
  }
  /** Everything kept, newest first (index 0 is the current one unless `cleared`). */
  state(scope: UserProfileScope): MovingMemoryState {
    const s = this.load(scope);
    return { ...s, versions: s.versions.map(copy), deleted: [...s.deleted] };
  }

  /** A new current version; a version with the same words as the newest is not stacked. False when the file is unreadable or the version is not usable. */
  add(scope: UserProfileScope, version: MovingMemoryVersion): Promise<boolean> {
    return this.serial(async () => {
      const id = userProfileScopeId(scope);
      if (!validVersion(version)) return false;
      const s = this.load(scope);
      if (this.unreadable.has(id)) return false;
      const rest = s.versions[0]?.text === version.text ? s.versions.slice(1) : [...s.versions];
      await this.persist(scope, { ...s, versions: [copy(version), ...rest].slice(0, MOVING_MEMORY_MAX_VERSIONS), cleared: false });
      return true;
    });
  }

  /** Remember that a handoff looked today (also what keeps it to once a day) and how far into the archive it read. */
  noteHandoff(scope: UserProfileScope, day: string, cutoffAt: number): Promise<boolean> {
    return this.serial(async () => {
      const id = userProfileScopeId(scope);
      const s = this.load(scope);
      if (this.unreadable.has(id) || !isDateKey(day) || !Number.isFinite(cutoffAt)) return false;
      await this.persist(scope, { ...s, lastHandoffDay: day, lastHandoffCutoffAt: Math.max(s.lastHandoffCutoffAt, cutoffAt) });
      return true;
    });
  }

  /**
   * The user deletes the current one, named by its `chosenAt` (what the window showed): it is no longer read, its words are remembered as
   * deleted, and it stays in the list so it can come back. False when that one is not the current one any more.
   */
  deleteCurrent(scope: UserProfileScope, chosenAt: number): Promise<boolean> {
    return this.serial(async () => {
      const s = this.load(scope), first = s.versions[0];
      if (this.unreadable.has(userProfileScopeId(scope)) || !first || s.cleared || !Number.isFinite(chosenAt) || first.chosenAt !== chosenAt) return false;
      await this.persist(scope, { ...s, cleared: true, deleted: remember(s.deleted, first.text) });
      return true;
    });
  }

  /** Bring the version chosen at `chosenAt` back as the current one (its words are no longer counted as deleted). False when it is not kept. */
  restore(scope: UserProfileScope, chosenAt: number): Promise<boolean> {
    return this.serial(async () => {
      const s = this.load(scope);
      const index = Number.isFinite(chosenAt) ? s.versions.findIndex(v => v.chosenAt === chosenAt) : -1;
      if (this.unreadable.has(userProfileScopeId(scope)) || index < 0) return false;
      if (index === 0 && !s.cleared) return true;
      const picked = s.versions[index]!;
      await this.persist(scope, { ...s, versions: [picked, ...s.versions.filter((_, i) => i !== index)], cleared: false, deleted: s.deleted.filter(d => d !== picked.text) });
      return true;
    });
  }

  /**
   * A chat record was deleted or changed: every version (current or older) and every deleted quote whose words `stillThere` no longer finds is
   * removed entirely. What is read changes at once (synchronously); the file follows on the queue, checked again when its turn comes. When
   * the current one goes, nothing older takes its place by itself. `stillThere` throwing counts as still there (nothing is lost on a misread).
   */
  prune(scope: UserProfileScope, stillThere: (text: string, date?: string) => boolean): Promise<boolean> {
    const id = userProfileScopeId(scope);
    const kept = (text: string, date?: string) => { try { return stillThere(text, date); } catch { return true; } };
    const pruned = (s: MovingMemoryState): MovingMemoryState | null => {
      const versions = s.versions.filter(v => kept(v.text, v.date)), deleted = s.deleted.filter(d => kept(d));
      if (versions.length === s.versions.length && deleted.length === s.deleted.length) return null;
      const currentGone = !s.cleared && !!s.versions[0] && versions[0] !== s.versions[0];
      return { ...s, versions, deleted, cleared: versions.length > 0 && (s.cleared || currentGone) };
    };
    const before = this.load(scope);
    if (this.unreadable.has(id)) return Promise.resolve(false);
    const now = pruned(before);
    if (!now) return Promise.resolve(false);
    this.cache.set(id, now);
    return this.serial(async () => {
      const latest = this.load(scope), next = pruned(latest) ?? latest;
      if (!this.unreadable.has(id)) await this.persist(scope, next);
      return true;
    });
  }

  /** I-144 回收站: her file was written back from the bin; what is held here for this scope is read again from it. */
  reload(scope: UserProfileScope): Promise<void> {
    const id = userProfileScopeId(scope);
    return this.serial(async () => { this.cache.delete(id); this.unreadable.delete(id); });
  }

  /**
   * I-144: the one the user deleted ("删掉这一件") stayed in the list so it could come back; its time in the recycle bin is up, so it goes for
   * good (its words stay remembered as deleted, so the same quote is not picked again). Only while it is not the current one.
   */
  dropVersion(scope: UserProfileScope, chosenAt: number): Promise<boolean> {
    return this.serial(async () => {
      const s = this.load(scope), index = Number.isFinite(chosenAt) ? s.versions.findIndex(v => v.chosenAt === chosenAt) : -1;
      if (this.unreadable.has(userProfileScopeId(scope)) || index < 0 || (index === 0 && !s.cleared)) return false;
      const versions = s.versions.filter((_, i) => i !== index);
      await this.persist(scope, { ...s, versions, cleared: versions.length > 0 && (s.cleared || index === 0) });
      return true;
    });
  }

  /**
   * Forget everything (what "允许记录" turning off does). What is read is empty at once and stays empty even when the file cannot be removed
   * (EBUSY, EPERM): then the file is overwritten with an empty state if it can be, and the call still rejects so a caller can report it.
   */
  clear(scope: UserProfileScope): Promise<void> {
    const id = userProfileScopeId(scope);
    this.cache.set(id, empty());
    return this.serial(async () => {
      try { await (this.atomic?.rm ?? rm)(this.file(scope), { force: true }); this.unreadable.delete(id); }
      catch (error) {
        try { await this.persist(scope, empty()); } catch { /* The cache is empty all the same; nothing private is logged. */ }
        throw Error('那件事的文件暂时删不掉，已不再读取。', { cause: (error as NodeJS.ErrnoException)?.code });
      } finally { this.cache.set(id, empty()); }
    });
  }
}
