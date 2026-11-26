// 她的文件夹 (I-050) host side. Off by default; the user turns it on by choosing a folder in the native dialog (the renderer never
// sends a path). On a chat turn about the folder (shared/initiative/her-folder.ts mentionsHerFolder), this turn's private context gets the
// instruction and the folder's file list (proposal.ts); after a complete reply, a valid block from that same turn is written by
// store.ts. A turn from before the switch changed (off, or another folder) writes nothing; so does a cancelled or late reply,
// since only a completed, current turn hands its block over (electron/brain/companion.ts).
//
// Where the record lives: `<profile>/her-folder.json` (the folder, its real path, which files she wrote, the copies kept and
// the recent actions; names and sizes only). Not in her folder, so nothing placed there can make a user's file look like hers
// (which would shorten how long its original is kept), and the control page reads it without scanning the folder.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { MutationQueue } from '../../foundation/mutation-queue';
import {
  HER_FOLDER_TOTAL_MAX_BYTES, asksHerToKeepSomething, isHerFolderActionKind, mentionsHerFolder,
  type HerFolderActionKind, type HerFolderNoteView, type HerFolderRefusal, type HerFolderView,
} from '../../../shared/initiative/her-folder';
import { HER_FOLDER_HINT_LINE, mayHint, mentionedInReply, readMentions, type HerFolderMentions } from './mention';
import { nameKey, sanitizeHerFileName } from './names';
import { herFolderInstruction, parseHerFileBlock, type HerFolderTurnData } from './proposal';
import { HerFolderStore, emptyManifest, type HerFolderManifest, type HerFolderOutcome } from './store';

/** One experience-journal line (shared/memory/journal.ts 'her-folder'): names and sizes only, never content. */
export interface HerFolderJournalInput {
  type: 'her-folder'; characterId: string | null; action: HerFolderActionKind | 'refused' | 'mentioned';
  name?: string; bytes?: number; userFile?: boolean; why?: HerFolderRefusal; by: 'her' | 'user';
}

export interface HerFolderHostOptions {
  /** The profile folder (null before the app is ready). */
  profileDirectory(): string | null;
  /** The native folder dialog; resolves to the chosen absolute path, or null when cancelled. */
  pickFolder(defaultPath: string | null): Promise<string | null>;
  /** Shows the folder in the file manager (never opens or runs a file in it). */
  openPath(folder: string): Promise<unknown>;
  /** The control page's view changed. */
  broadcast(view: HerFolderView): void;
  /** Sends the note under her reply (or its removal) to the window that owns the reply. */
  sendNote(owner: number, view: HerFolderNoteView): void;
  journal?(input: HerFolderJournalInput): void;
  characterId?(): string | null;
  now?(): number;
  writeAtomic?: AtomicFileWriter;
  platform?: NodeJS.Platform;
}

/** The turn's ticket: which switch state it was built under; null on a turn that gets nothing new. */
export interface HerFolderTurn { ticket: number; real: string; instruction: (start: string, end: string) => string }

/** The ticket of something she makes on her own (beginKeepsake): the switch state and the real folder it was made under. */
export interface HerKeepTicket { readonly ticket: number; readonly real: string }
export type HerKeepOutcome = { ok: true; name: string; bytes: number } | { ok: false; why: HerFolderRefusal };

/** I-056: a turn that carries the "you may mention the folder once" line (beginHint), and the character it was for. */
export interface HerFolderHintTurn { readonly characterId: string; readonly line: string }

interface Saved { v: 1; enabled: boolean; folder: string | null; real: string | null; manifest: HerFolderManifest; /** I-056 */ mentions: HerFolderMentions }

type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

export class HerFolderHost {
  private state: Saved = { v: 1, enabled: false, folder: null, real: null, manifest: emptyManifest(), mentions: {} };
  private store: HerFolderStore | null = null;
  /** Changes whenever the switch or the folder changes: a turn built before that writes nothing. */
  private generation = 0;
  private readonly queue = new MutationQueue();
  private note: { view: HerFolderNoteView; owner: number } | null = null;
  private readonly writeAtomic: AtomicFileWriter;
  constructor(private readonly options: HerFolderHostOptions) { this.writeAtomic = options.writeAtomic ?? atomicWriteFile; }

  private file(): string | null { const dir = this.options.profileDirectory(); return dir ? path.join(dir, 'her-folder.json') : null; }

  async load(): Promise<void> {
    const file = this.file();
    if (!file) return;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<Saved>;
      const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : emptyManifest();
      this.state = {
        v: 1, enabled: raw.enabled === true && typeof raw.folder === 'string' && typeof raw.real === 'string',
        folder: typeof raw.folder === 'string' ? raw.folder : null, real: typeof raw.real === 'string' ? raw.real : null,
        manifest: { files: { ...(manifest.files ?? {}) }, backups: { ...(manifest.backups ?? {}) },
          actions: Array.isArray(manifest.actions) ? manifest.actions.filter(item => item && isHerFolderActionKind(item.kind)) : [] },
        mentions: readMentions(raw.mentions),
      };
    } catch { /* No file yet (or unreadable): off. */ }
    this.rebuild();
  }

  private rebuild(): void {
    this.store = this.state.folder && this.state.real ? new HerFolderStore({ folder: this.state.folder, real: this.state.real, manifest: this.state.manifest,
      saveManifest: () => this.save(), now: this.options.now, writeAtomic: this.writeAtomic, platform: this.options.platform }) : null;
  }

  private async save(): Promise<void> {
    const file = this.file();
    if (file) await this.writeAtomic(file, JSON.stringify(this.state));
  }

  async view(): Promise<HerFolderView> {
    let used = 0;
    if (this.store && this.state.enabled) { try { used = await this.store.usedBytes(); } catch { used = 0; } }
    return { enabled: this.state.enabled, folder: this.state.folder, actions: this.store?.actions() ?? [], usedBytes: used, limitBytes: HER_FOLDER_TOTAL_MAX_BYTES };
  }

  enabled(): boolean { return this.state.enabled && !!this.store; }

  // ------------------------------------------------------------------ the switch (control window only)

  /** Turning it on: the user picks a folder in the native dialog. Cancelled: nothing changes. */
  choose(): Promise<HerFolderView> {
    return this.queue.run(async () => {
      const picked = await this.options.pickFolder(this.state.folder);
      if (!picked) return this.view();
      const real = await HerFolderStore.resolveFolder(picked);
      const same = !!this.state.real && this.state.real.toLowerCase() === real.toLowerCase();
      this.state = { v: 1, enabled: true, folder: picked, real, manifest: same ? this.state.manifest : emptyManifest(), mentions: this.state.mentions };
      this.generation++; this.dropNote();
      this.rebuild();
      await this.save();
      return this.publish();
    });
  }

  /** Off: no instruction on any turn and no write, also for a reply already on its way. The folder and its files stay. */
  turnOff(): Promise<HerFolderView> {
    this.generation++; this.dropNote(); // at once, before the queue: a write still waiting there sees the new generation
    return this.queue.run(async () => {
      this.state.enabled = false;
      await this.save();
      return this.publish();
    });
  }

  // ------------------------------------------------------------------ a chat turn

  /** A message about her folder while it is on: this turn's instruction and file list. Otherwise null (nothing new on the turn). */
  async beginTurn(userText: unknown): Promise<HerFolderTurn | null> {
    if (!this.enabled() || !mentionsHerFolder(userText)) return null;
    const store = this.store!, ticket = this.generation;
    const data: HerFolderTurnData = { files: [], named: null };
    try {
      data.files = await store.list();
      const text = String(userText).slice(0, 4000);
      const named = data.files.find(file => text.includes(file.name) || (file.name.lastIndexOf('.') >= 2 && text.includes(file.name.slice(0, file.name.lastIndexOf('.')))));
      if (named) { const content = await store.read(named.name, 12_000); if (content !== null) data.named = { name: named.name, text: content }; }
    } catch { /* A folder that cannot be read: she still gets the instruction; the write is checked again anyway. */ }
    if (ticket !== this.generation || !this.enabled()) return null;
    return { ticket, real: store.real, instruction: (start, end) => herFolderInstruction(start, end, data) };
  }

  /**
   * After a complete, current reply: a valid block of this turn is queued for writing. True when it was taken (the host will
   * add the note under her reply once it is written). A stale turn, the switch off, or a malformed block: false, nothing written.
   */
  offer(turn: HerFolderTurn | null | undefined, owner: number, raw: string | null | undefined): boolean {
    if (!turn || !raw) return false;
    if (turn.ticket !== this.generation || !this.enabled() || this.state.real !== turn.real) { this.refused('stale'); return false; }
    const proposal = parseHerFileBlock(raw);
    if (!proposal) { this.refused('malformed'); return false; }
    void this.queue.run(async () => {
      // Checked again where it takes effect: turned off (or another folder chosen) while it waited writes nothing.
      if (turn.ticket !== this.generation || !this.enabled() || this.state.real !== turn.real) { this.refused('stale'); return; }
      const store = this.store!;
      const outcome = proposal.op === 'delete' ? await store.trash(proposal.name) : await store.write(proposal.name, proposal.content, proposal.op);
      this.after(outcome, 'her');
      if (outcome.ok && turn.ticket === this.generation) this.showNote(owner, outcome.action.kind, outcome.action.name);
      await this.publish();
    }).catch(() => {});
    return true;
  }

  // ------------------------------------------------------------------ I-056: mention it once while it was never turned on

  /**
   * A message asking her to write or keep something, while the folder has never been chosen (off since the start; once the user
   * has turned it on, even if off again, they know it): this turn's private context gets HER_FOLDER_HINT_LINE. Each such turn
   * spends one of HER_FOLDER_HINT_MAX chances for this character; null when there is nothing to add.
   */
  beginHint(userText: unknown): HerFolderHintTurn | null {
    const characterId = this.options.characterId?.() ?? null;
    if (this.state.enabled || this.state.folder !== null || !characterId || !asksHerToKeepSomething(userText)) return null;
    const mention = this.state.mentions[characterId];
    if (!mayHint(mention)) return null;
    this.state.mentions = { ...this.state.mentions, [characterId]: { hints: (mention?.hints ?? 0) + 1, done: false } };
    void this.queue.run(() => this.save()).catch(() => {});
    return { characterId, line: HER_FOLDER_HINT_LINE };
  }

  /**
   * After a complete reply of a hint turn: true when her reply mentioned the folder (the caller then adds the 「带我去」 button).
   * That ends the hints for this character and leaves one journal line without content. Nothing when the folder was turned on
   * in the meantime or the character changed.
   */
  hintDone(turn: HerFolderHintTurn | null | undefined, reply: unknown): boolean {
    if (!turn || this.state.enabled || this.state.folder !== null || !mentionedInReply(reply)) return false;
    if ((this.options.characterId?.() ?? null) !== turn.characterId) return false;
    const mention = this.state.mentions[turn.characterId];
    if (mention?.done) return false; // once is once
    this.state.mentions = { ...this.state.mentions, [turn.characterId]: { hints: mention?.hints ?? 1, done: true } };
    void this.queue.run(() => this.save()).catch(() => {});
    this.journal({ type: 'her-folder', characterId: null, action: 'mentioned', by: 'her' });
    return true;
  }

  /** I-056, for tests and the record: this character's hints so far and whether she mentioned it. */
  mentionState(characterId: string): { hints: number; done: boolean } {
    const mention = this.state.mentions[characterId];
    return { hints: mention?.hints ?? 0, done: mention?.done === true };
  }

  // ------------------------------------------------------------------ a keepsake (not from a chat turn; I-050 step 2)

  /**
   * The ticket for something she makes on her own (electron/initiative/her-folder/keepsake.ts): bound to the current switch and the real
   * folder, exactly like a chat turn's. Null while the folder is off. The keepsake's long model call happens between this and
   * `keep`; a switch that changed in between makes `keep` write nothing.
   */
  beginKeepsake(): HerKeepTicket | null {
    return this.enabled() ? { ticket: this.generation, real: this.state.real! } : null;
  }

  /** The names in the folder (top level, text files), so a new keepsake does not repeat one. Empty while off or unreadable. */
  async fileNames(): Promise<string[]> {
    if (!this.enabled()) return [];
    try { return (await this.store!.list(60)).map(file => file.name); } catch { return []; }
  }

  /** Is this ticket still the current switch and folder (what `keep` checks again where the write takes effect)? */
  keepsakeCurrent(ticket: HerKeepTicket | null | undefined): boolean {
    return !!ticket && ticket.ticket === this.generation && this.enabled() && this.state.real === ticket.real;
  }

  /**
   * Leaves a new text file she made on her own. The same checks as a chat turn's block (name, size, type, links, total, versions and
   * recycle bin, the journal line with names and sizes only). It never replaces a file that is already there: a taken name gets
   * "（2）", "（3）"… and the user's files are never touched. No note under a reply (there is no reply).
   */
  keep(ticket: HerKeepTicket | null | undefined, rawName: unknown, content: unknown): Promise<HerKeepOutcome> {
    if (!this.keepsakeCurrent(ticket)) { this.refused('stale'); return Promise.resolve({ ok: false, why: 'stale' }); }
    if (typeof content !== 'string' || !content.trim()) { this.refused('malformed'); return Promise.resolve({ ok: false, why: 'malformed' }); }
    return this.queue.run(async (): Promise<HerKeepOutcome> => {
      if (!this.keepsakeCurrent(ticket)) { this.refused('stale'); return { ok: false, why: 'stale' }; }
      const store = this.store!;
      let outcome: HerFolderOutcome = { ok: false, why: 'failed' };
      try {
        const taken = new Set((await store.list(500)).map(file => nameKey(file.name, this.options.platform)));
        const wanted = sanitizeHerFileName(rawName);
        if (!wanted.ok) { this.refused(wanted.why); return { ok: false, why: wanted.why }; }
        let name = wanted.name;
        for (let n = 2; taken.has(nameKey(name, this.options.platform)) && n < 50; n++) {
          const dot = wanted.name.lastIndexOf('.');
          name = `${wanted.name.slice(0, dot)}（${n}）${wanted.name.slice(dot)}`;
        }
        if (taken.has(nameKey(name, this.options.platform))) { this.refused('failed'); return { ok: false, why: 'failed' }; }
        outcome = await store.write(name, content, 'write');
      } catch { outcome = { ok: false, why: 'failed' }; }
      this.after(outcome, 'her');
      await this.publish();
      return outcome.ok ? { ok: true, name: outcome.action.name, bytes: outcome.action.bytes } : { ok: false, why: outcome.why };
    });
  }

  /**
   * I-086 我们的小东西: the app's own small text list in her folder (the same list as the control page, words only). Created when it is
   * not there, replaced (her old version kept as always) while it is still exactly as she left it; once the user changed it, it is left
   * alone (refused 'stale'). Same ticket, name, size, type and total checks as everything she writes.
   */
  syncText(ticket: HerKeepTicket | null | undefined, rawName: unknown, content: unknown): Promise<HerKeepOutcome> {
    if (!this.keepsakeCurrent(ticket)) return Promise.resolve({ ok: false, why: 'stale' });
    if (typeof content !== 'string' || !content.trim()) return Promise.resolve({ ok: false, why: 'malformed' });
    return this.queue.run(async (): Promise<HerKeepOutcome> => {
      if (!this.keepsakeCurrent(ticket)) return { ok: false, why: 'stale' };
      const store = this.store!;
      const state = await store.ownState(rawName);
      if (state === 'user') return { ok: false, why: 'stale' };
      const outcome = await store.write(rawName, content, 'write');
      this.after(outcome, 'her');
      await this.publish();
      return outcome.ok ? { ok: true, name: outcome.action.name, bytes: outcome.action.bytes } : { ok: false, why: outcome.why };
    });
  }

  /**
   * I-086: a picture of her own (a PNG the app rendered from her stage) under a new name: "（2）", "（3）"… when taken; never replaces a
   * file. The ticket, the name check (the stem as for her text files), the size and the total are the folder's own.
   */
  keepPicture(ticket: HerKeepTicket | null | undefined, stem: unknown, bytes: Uint8Array): Promise<HerKeepOutcome> {
    if (!this.keepsakeCurrent(ticket)) { this.refused('stale'); return Promise.resolve({ ok: false, why: 'stale' }); }
    return this.queue.run(async (): Promise<HerKeepOutcome> => {
      if (!this.keepsakeCurrent(ticket)) { this.refused('stale'); return { ok: false, why: 'stale' }; }
      let outcome: HerFolderOutcome = { ok: false, why: 'failed' };
      for (let n = 1; n < 20; n++) {
        outcome = await this.store!.writePicture(n === 1 ? stem : `${String(stem)}（${n}）`, bytes);
        if (outcome.ok || outcome.why !== 'failed') break;
      }
      this.after(outcome, 'her');
      await this.publish();
      return outcome.ok ? { ok: true, name: outcome.action.name, bytes: outcome.action.bytes } : { ok: false, why: outcome.why };
    });
  }

  /** Waits for queued writes (tests, quitting). */
  idle(): Promise<void> { return this.queue.idle(); }

  // ------------------------------------------------------------------ the user's side

  /** Brings back a version or a recycle-bin item (control window). */
  restore(actionId: unknown): Promise<HerFolderView> {
    return this.queue.run(async () => {
      if (!this.store) return this.view();
      const outcome = await this.store.restore(actionId);
      this.after(outcome, 'user');
      if (!outcome.ok) throw new Error(outcome.why === 'missing' ? '这一项已经找不到了。' : '没能恢复这一项。');
      return this.publish();
    });
  }

  /** Shows the folder (control window, or the note's button from the window that owns it). Only while it is on. */
  async open(): Promise<boolean> {
    if (!this.enabled() || !this.state.folder) return false;
    await this.options.openPath(this.state.folder);
    return true;
  }
  async openFromNote(sender: number, request: unknown): Promise<boolean> {
    const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {};
    const note = this.note;
    if (!note || input.noteId !== note.view.noteId) return false;
    if (sender !== note.owner) throw new Error('请求来源未授权。');
    return this.open();
  }

  register(scopedHost: Register): void {
    scopedHost('getHerFolder', () => this.view(), true);
    scopedHost('chooseHerFolder', () => this.choose(), true);
    scopedHost('turnOffHerFolder', () => this.turnOff(), true);
    scopedHost('restoreHerFolderItem', (_sender, id) => this.restore(id), true);
    scopedHost('openHerFolder', () => this.open(), true);
    scopedHost('openHerFolderFromNote', (sender, request) => this.openFromNote(sender, request), false);
  }

  // ------------------------------------------------------------------ internals

  private after(outcome: HerFolderOutcome, by: 'her' | 'user'): void {
    if (outcome.ok) this.journal({ type: 'her-folder', characterId: null, action: outcome.action.kind, name: outcome.action.name, bytes: outcome.action.bytes, userFile: outcome.action.userFile, by });
    else this.journal({ type: 'her-folder', characterId: null, action: 'refused', why: outcome.why, by });
  }
  private refused(why: HerFolderRefusal): void { this.journal({ type: 'her-folder', characterId: null, action: 'refused', why, by: 'her' }); }
  private journal(input: HerFolderJournalInput): void {
    try { this.options.journal?.({ ...input, characterId: this.options.characterId?.() ?? null }); } catch { /* the journal never changes her folder */ }
  }

  private showNote(owner: number, action: HerFolderActionKind, name: string): void {
    this.dropNote();
    const view: HerFolderNoteView = { kind: 'her-folder-note', version: 1, noteId: randomUUID(), action, name, state: 'open' };
    this.note = { view, owner };
    try { this.options.sendNote(owner, structuredClone(view)); } catch { /* the window may be gone */ }
  }
  private dropNote(): void {
    const note = this.note;
    this.note = null;
    if (note) { try { this.options.sendNote(note.owner, { ...note.view, state: 'gone' }); } catch { /* gone */ } }
  }
  private async publish(): Promise<HerFolderView> {
    const view = await this.view();
    try { this.options.broadcast(view); } catch { /* no control window */ }
    return view;
  }
}
