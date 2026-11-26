// I-088 第 1 条 她的"这阵子"回顾: where the look-backs live. One file per character and connection beside the profile files:
// `review-<scopeId>.json` ({ version: 1, scopeId, data }) with the same scope id as `profile-<scopeId>.json`. It is NOT part of the
// profile file on purpose (the same reason as the plans she remembers, electron/memory/upcoming/store.ts): a previous build reads profile
// files strictly by name and has never heard of this one, so an update or a fall back to the previous version cannot make a profile
// or a diary unreadable because of it.
//
// Rules: written with the atomic writer; read strictly (a file that does not read is left exactly as it is and nothing is written over
// it); bounded (data.ts REVIEW_LIMITS); not written when there is nothing to keep, deleted when it becomes empty. What she does by
// herself (writing a look-back, counting an answer that could not be used, deciding the week's mention) needs "允许记录" on at the
// moment the change runs, inside the same queue; what the user does (edit, delete) is always allowed, so that existing look-backs stay
// manageable after recording is switched off. Never exported with a character card, never sent anywhere.
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createAtomicFileWriter, type AtomicFileDependencies } from '../../foundation/atomic-file';
import { localDateKey } from '../diary/diary-dates';
import {
  compactReview, emptyReview, validateReviewData, withEdited, withoutReview, shownReviews,
  type ReviewData, type ReviewShown,
} from './data';
import { chooseOpening, recallReview, type ReviewRecalled } from './recall';
import type { ReviewKind } from './period';

const MAX_BYTES = 1_000_000;
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** What the user profile store needs from this store (electron/memory/user-profile.ts options). */
export interface ReviewPort {
  /** The scope is shown: its look-backs are read, so that the panel and recall can use them without waiting. */
  load(scopeId: string): Promise<void>;
  shown(scopeId: string): ReviewShown[];
  /** The user's own edit and delete in the panel (always allowed). Resolve to whether something changed. */
  edit(scopeId: string, kind: ReviewKind, key: string, text: string): Promise<boolean>;
  remove(scopeId: string, kind: ReviewKind, key: string): Promise<boolean>;
  /** A new conversation's opening: the line she may be given about last week ('' for none), decided once a week. Local, never waits. */
  openingLine(scopeId: string, now: number): string;
  /** The character's profile was deleted: so are her look-backs. */
  forget(scopeId: string): Promise<void>;
  /** I-144b: a single deletion's copy, and putting it back (ReviewStore). */
  reviewCopy?(scopeId: string, kind: ReviewKind, key: string): Promise<ReviewPart | null>;
  restoreReview?(part: ReviewPart): Promise<boolean>;
}

export interface ReviewStoreOptions {
  now?: () => number;
  atomic?: AtomicFileDependencies;
  /** Whether recording is on right now (the user's switch). What she does by herself is refused while it is not. */
  recording: () => boolean;
  random?: () => number;
}

/** I-144b: one look-back as the bin keeps it (ReviewStore.reviewCopy). */
export interface ReviewPart { scopeId: string; item: { at: number; value: ReviewData['items'][number] }; tries: ReviewData['tries']; marks: string[] }

export type ReviewChange =(state: ReviewData, at: number) => ReviewData | null;

export class ReviewStore implements ReviewPort {
  private readonly cache = new Map<string, ReviewData>();
  /** Scopes whose file did not read: never written over. */
  private readonly unreadable = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private withdrawn = 0;
  private readonly now: () => number;
  constructor(readonly directory: string, private readonly options: ReviewStoreOptions) {
    if (!path.isAbsolute(directory) || directory.includes('\0')) throw Error('回顾目录须由宿主提供。');
    this.now = options.now ?? Date.now;
  }

  file(scopeId: string): string {
    if (!hex(scopeId)) throw Error('回顾范围不正确。');
    return path.join(this.directory, `review-${scopeId}.json`);
  }

  private async read(scopeId: string): Promise<ReviewData | null> {
    let bytes: string;
    try { bytes = await readFile(this.file(scopeId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.unreadable.delete(scopeId); return null; } this.unreadable.add(scopeId); return null; }
    try {
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('too large');
      const data = JSON.parse(bytes) as { version?: unknown; scopeId?: unknown; data?: unknown };
      if (!data || data.version !== 1 || data.scopeId !== scopeId) throw Error('wrong file');
      const state = validateReviewData(data.data);
      this.unreadable.delete(scopeId);
      return state;
    } catch { this.unreadable.add(scopeId); return null; }
  }

  private async write(scopeId: string, state: ReviewData): Promise<void> {
    const kept = compactReview(state);
    if (!kept) { await rm(this.file(scopeId), { force: true }); this.cache.delete(scopeId); return; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await createAtomicFileWriter({ ...this.options.atomic })(this.file(scopeId), JSON.stringify({ version: 1, scopeId, data: kept }) + '\n');
    this.cache.set(scopeId, structuredClone(kept));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async load(scopeId: string): Promise<void> {
    await this.serial(async () => {
      const state = await this.read(scopeId);
      if (state) this.cache.set(scopeId, state); else this.cache.delete(scopeId);
    });
  }

  /** The look-backs as the writer needs them (a copy), after the file was read; null when the file does not read (then nothing is written). */
  async ensure(scopeId: string): Promise<ReviewData | null> {
    return this.serial(async () => {
      if (!this.cache.has(scopeId) && !this.unreadable.has(scopeId)) { const state = await this.read(scopeId); if (state) this.cache.set(scopeId, state); }
      if (this.unreadable.has(scopeId)) return null;
      return structuredClone(this.cache.get(scopeId) ?? emptyReview());
    });
  }
  /** In memory, as loaded or last saved. */
  peek(scopeId: string): ReviewData | undefined { const state = this.cache.get(scopeId); return state ? structuredClone(state) : undefined; }
  shown(scopeId: string): ReviewShown[] { return shownReviews(this.cache.get(scopeId)); }

  /**
   * Changes one character's look-backs. `by: 'her'` (the default) needs recording on and `valid()` (the writer's ticket) at the moment
   * it runs; `by: 'user'` does not. Resolves to whether it changed (and was saved); never throws.
   */
  change(scopeId: string, change: ReviewChange, by: 'her' | 'user' = 'her', valid: () => boolean = () => true): Promise<boolean> {
    return this.serial(async () => {
      try {
        if (!hex(scopeId) || (by === 'her' && (!this.options.recording() || !valid()))) return false;
        const known = this.cache.get(scopeId) ?? await this.read(scopeId);
        if (this.unreadable.has(scopeId)) return false;
        const next = change(known ? structuredClone(known) : emptyReview(), this.now());
        if (!next) return false;
        await this.write(scopeId, next);
        return true;
      } catch { return false; }
    });
  }

  async edit(scopeId: string, kind: ReviewKind, key: string, text: string): Promise<boolean> {
    const ok = await this.change(scopeId, (state, at) => withEdited(state, kind, key, text, at), 'user');
    if (ok) this.withdrawn++;
    return ok;
  }
  async remove(scopeId: string, kind: ReviewKind, key: string): Promise<boolean> {
    const ok = await this.change(scopeId, state => withoutReview(state, kind, key), 'user');
    if (ok) this.withdrawn++;
    return ok;
  }

  // ---- I-144b 单条删除也先进回收站 (electron/memory/recycle/items-wiring.ts) ----

  /** One look-back as the user is about to delete it, with its place, its tries and the blocked mark the deletion adds; null when absent. */
  reviewCopy(scopeId: string, kind: ReviewKind, key: string): Promise<ReviewPart | null> {
    return this.serial(async () => {
      if (!hex(scopeId)) return null;
      const state = this.cache.get(scopeId) ?? await this.read(scopeId);
      const at = state ? state.items.findIndex(item => item.kind === kind && item.key === key) : -1;
      if (!state || at < 0 || this.unreadable.has(scopeId)) return null;
      const after = withoutReview(state, kind, key);
      return { scopeId, item: { at, value: structuredClone(state.items[at]!) }, tries: state.tries.filter(entry => !after.tries.includes(entry)).map(entry => ({ ...entry })),
        marks: after.blocked.filter(mark => !state.blocked.includes(mark)) };
    });
  }
  /** Puts what reviewCopy copied back (left as it is when that period has a look-back again); the mark goes. Resolves to whether it came back. */
  async restoreReview(part: ReviewPart): Promise<boolean> {
    const value = part?.item?.value;
    if (!part || !hex(part.scopeId) || !value || (value.kind !== 'week' && value.kind !== 'month') || typeof value.key !== 'string' || !Array.isArray(part.marks) || !Array.isArray(part.tries))
      throw Error('回收站里这一项的数据不完整，原文件已保留。');
    let back = false;
    const ok = await this.change(part.scopeId, state => {
      const marks = new Set(part.marks.map(String));
      back = !state.items.some(item => item.kind === value.kind && item.key === value.key);
      const items = back ? [...state.items] : state.items;
      if (back) items.splice(Math.max(0, Math.min(items.length, part.item.at)), 0, structuredClone(value));
      return { ...state, items, blocked: state.blocked.filter(mark => !marks.has(mark)), tries: [...state.tries, ...part.tries.filter(entry => !state.tries.some(kept => kept.id === entry.id))] };
    }, 'user');
    if (!ok) throw Error('这段回顾现在放不回去（回顾文件读不出来），回收站里还留着。');
    if (back) this.withdrawn++;
    return back;
  }

  /** Changes whenever the user took something back: a recall made before is stale (MemoryStore.recallRevision). */
  get revision(): number { return this.withdrawn; }

  /**
   * MemoryStore.retrieve's hook: the look-back this message points at (period word, or what it names), or none. Only while recording is on,
   * and only what is already in memory: no file is read here.
   */
  recall(scopeId: string, text: string, now: number): ReviewRecalled[] {
    try {
      if (!hex(scopeId) || !this.options.recording()) return [];
      const hit = recallReview(this.cache.get(scopeId), text, localDateKey(now));
      return hit ? [hit] : [];
    } catch { return []; }
  }

  openingLine(scopeId: string, now: number): string {
    try {
      if (!hex(scopeId) || !this.options.recording() || this.unreadable.has(scopeId)) return '';
      const choice = chooseOpening(this.cache.get(scopeId), localDateKey(now), this.options.random);
      if (!choice) return '';
      // The decision is kept at once in memory (the next conversation sees it); the file follows in the queue.
      this.cache.set(scopeId, structuredClone(choice.next));
      void this.change(scopeId, state => ({ ...state, opening: choice.next.opening }), 'her');
      return choice.line;
    } catch { return ''; }
  }

  forget(scopeId: string): Promise<void> {
    return this.serial(async () => { this.cache.delete(scopeId); this.unreadable.delete(scopeId); await rm(this.file(scopeId), { force: true }); });
  }

  /** Waits for every queued change (tests, quitting). */
  settled(): Promise<void> { return this.queue.then(() => undefined); }
}
