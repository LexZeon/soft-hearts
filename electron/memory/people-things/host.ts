// I-088 item 2 (docs/claude/2026-11-11-i088-people-and-things.md): the host side of "你生活里的人和事". It gathers the current character's
// entries from her notes (shared/memory/people-things/gather.ts) with the user's decisions (store.ts), keeps them ready for recall, and
// answers the control window's two operations. Local only: no model call, nothing leaves the profile, nothing goes into a card export.
//
// Recall never waits: it reads the entries computed last time (a note written a moment ago may not be in them yet) and, when they
// are missing or out of date, asks for a recompute on a timer. The page asks for a fresh computation every time.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { cleanName, joinNames, keepApart, pruneDecisions, removeNames, renameEntry, splitName, type PeopleThingsDecisions } from '../../../shared/memory/people-things/decisions';
import { gatherPeopleThings, type Gathered, type PeopleNoteInput } from '../../../shared/memory/people-things/gather';
import { aliasMatches, buildAliasIndex, type AliasIndex } from '../../../shared/memory/people-things/recall';
import { EMPTY_PEOPLE_THINGS_VIEW, peopleThingsView, readPeopleThingsOp, type PeopleThingsView } from '../../../shared/memory/people-things/view';
import { PEOPLE_THINGS_FOLDER, PeopleThingsStore } from './store';

export interface PeopleThingsDeps {
  readonly store: PeopleThingsStore;
  /** The profile folder (for the prune listing), or null. */
  directory(): string | null;
  /** The written notes of one character (people and things only), or throws when they cannot be told. */
  notesOf(characterId: string): readonly PeopleNoteInput[];
  currentCharacter(): string | null;
  /** Tests: run the deferred recompute at once instead of on a timer. */
  schedule?(task: () => void): void;
}

interface Cached { readonly gathered: Gathered; readonly index: AliasIndex }

export class PeopleThings {
  private readonly cache = new Map<string, Cached>();
  private readonly stale = new Set<string>();
  private readonly scheduled = new Set<string>();
  private disposed = false;
  constructor(private readonly deps: PeopleThingsDeps) {}

  /**
   * I-144 回收站: this character's decisions go (file and memory); also what the bin calls before writing her file back. `reloaded`: her
   * file was written back, so what is gathered for her is worked out again.
   */
  forgetCharacter(characterId: string): Promise<void> { this.cache.delete(characterId); this.stale.add(characterId); return this.deps.store.forget(characterId); }
  reloaded(characterId: string): void { this.cache.delete(characterId); this.stale.add(characterId); }

  /** The notes changed (a note was written; `removed`: a memory or note went, so names that outlive their notes are dropped). */
  notesChanged(removed: boolean): void {
    for (const key of this.cache.keys()) this.stale.add(key);
    const current = this.deps.currentCharacter();
    if (current) this.stale.add(current);
    if (removed) this.later(() => void this.prune().catch(() => undefined));
  }

  /** Recall (electron/memory/memory-notes/core.ts prepare): record id → the names of its entry the message used. Local and immediate. */
  matching(squashedMessage: string): ReadonlyMap<string, readonly string[]> | null {
    const character = this.deps.currentCharacter();
    if (!character) return null;
    const cached = this.cache.get(character);
    if (!cached || this.stale.has(character)) this.refreshLater(character);
    return cached ? aliasMatches(squashedMessage, cached.index) : null;
  }

  /** Make the character's entries ready now (start, character switch). */
  async warm(character: string | null = this.deps.currentCharacter()): Promise<void> {
    if (!character || this.disposed) return;
    try { await this.compute(character); } catch { /* recall simply has no aliases yet */ }
  }

  /** Entries for the character's alias lookups in conversion are read from the same decisions file (character-convert/snapshot.ts). */
  async view(): Promise<PeopleThingsView> {
    const character = this.deps.currentCharacter();
    if (!character) return EMPTY_PEOPLE_THINGS_VIEW;
    const { gathered } = await this.compute(character);
    return peopleThingsView(gathered.entries, gathered.pending);
  }

  /** One of the user's decisions. Resolves with the new view after the decisions are saved; rejects with a plain message and changes nothing. */
  async apply(value: unknown): Promise<PeopleThingsView> {
    const op = readPeopleThingsOp(value);
    if (!op) throw new Error('这个操作不对。');
    const character = this.deps.currentCharacter();
    if (!character) throw new Error('现在没有选中的角色。');
    const decisions = await this.deps.store.load(character);
    const { gathered } = await this.compute(character);
    const entryOf = (key: string) => gathered.entries.find(entry => entry.names.some(name => name.key === key));
    const entry = entryOf(op.key);
    if (!entry) throw new Error('这一项已经不在了，请刷新看看。');
    let next: PeopleThingsDecisions = decisions;
    if (op.kind === 'rename') {
      const text = cleanName(op.text);
      if (!text) throw new Error('名字不能是空的，也不能超过 24 个字。');
      next = renameEntry(decisions, op.key, text);
    } else if (op.kind === 'delete') next = removeNames(decisions, entry.names.map(name => name.key));
    else if (op.kind === 'split') {
      if (entry.names.length < 2) throw new Error('它只有一个叫法，没法再拆。');
      next = splitName(decisions, op.key, entry.names.map(name => name.key));
    } else if (op.kind === 'merge' || op.kind === 'confirm' || op.kind === 'refuse') {
      const other = entryOf(op.other);
      if (!other || other === entry) throw new Error('这一项已经不在了，请刷新看看。');
      next = op.kind === 'refuse' ? keepApart(decisions, op.key, op.other) : joinNames(decisions, op.key, op.other);
    }
    await this.deps.store.save(character, next);
    const fresh = await this.compute(character);
    return peopleThingsView(fresh.gathered.entries, fresh.gathered.pending);
  }

  private async compute(character: string): Promise<Cached> {
    const decisions = await this.deps.store.load(character);
    const gathered = gatherPeopleThings(this.deps.notesOf(character), decisions);
    const cached = { gathered, index: buildAliasIndex(gathered.entries) };
    this.cache.set(character, cached);
    this.stale.delete(character);
    return cached;
  }

  /** After the user deleted memories or notes: decisions that name something no note writes any more go (no name outlives its notes). */
  async prune(): Promise<void> {
    const directory = this.deps.directory();
    if (!directory) return;
    let files: string[];
    try { files = await readdir(path.join(directory, PEOPLE_THINGS_FOLDER)); } catch { return; }
    for (const file of files) {
      const character = /^([A-Za-z0-9_-]{1,100})\.json$/u.exec(file)?.[1];
      if (!character) continue;
      let notes: readonly PeopleNoteInput[];
      try { notes = this.deps.notesOf(character); } catch { continue; }
      const decisions = await this.deps.store.load(character);
      const gathered = gatherPeopleThings(notes, decisions);
      const pruned = pruneDecisions(decisions, gathered.live, gathered.seen);
      if (JSON.stringify(pruned) !== JSON.stringify(decisions)) await this.deps.store.save(character, pruned).catch(() => undefined);
      this.stale.add(character);
    }
  }

  private refreshLater(character: string): void {
    if (this.scheduled.has(character) || this.disposed) return;
    this.scheduled.add(character);
    this.later(() => { this.scheduled.delete(character); void this.warm(character); });
  }
  private later(task: () => void): void {
    if (this.deps.schedule) { this.deps.schedule(task); return; }
    const timer = setTimeout(() => { if (!this.disposed) task(); }, 0);
    timer.unref?.();
  }

  async dispose(): Promise<void> { this.disposed = true; await this.deps.store.idle(); }
}
