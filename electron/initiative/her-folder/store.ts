// 她的文件夹 (I-050): every disk operation in her folder. The folder is the one the user chose; the host keeps its real path
// from that moment and refuses to work when the folder now resolves somewhere else. Inside it, only top-level text files
// with checked names (names.ts) are touched; anything that is a link, a junction or another redirecting reparse point is
// refused, and every path is checked again by its real path right before use. Writes are atomic (temp file beside the
// target, then rename, which replaces a link instead of following it). Nothing here runs or opens a file.
//
// Changes keep a copy first, in `.她的旧版本/`: her own earlier version for 30 days; a user's file (one she did not write, or
// one the user changed after her) is kept with no end. Deleting moves the file to `.她的回收站/`, removed after 30 days.
// The record of what she wrote and what was kept lives in the app profile, not in her folder (see host.ts).
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import {
  HER_FOLDER_FILE_MAX_BYTES, HER_FOLDER_KEEP_MS, HER_FOLDER_RECENT, HER_FOLDER_TOTAL_MAX_BYTES, HER_FOLDER_TRASH_DIR,
  HER_FOLDER_VERSIONS_DIR, type HerFolderActionKind, type HerFolderActionView, type HerFolderRefusal,
} from '../../../shared/initiative/her-folder';
import { nameKey, sanitizeHerFileName } from './names';

/** What the profile keeps about her folder (host.ts persists it). Names and sizes only, never content. */
export interface HerFolderManifest {
  /** Files she wrote, by nameKey: their size and modification time right after her last write (a mismatch: the user changed it). */
  files: Record<string, { name: string; size: number; mtimeMs: number }>;
  /** Copies kept in the hidden subfolders, by id. `expiresAt` null: a user's original, kept until the user removes it. */
  backups: Record<string, { kind: 'version' | 'trash'; file: string; name: string; at: number; bytes: number; hers: boolean; expiresAt: number | null }>;
  /** Newest last. `backup`: the copy this action left (what the user can bring back). */
  actions: { id: string; at: number; kind: HerFolderActionKind; name: string; bytes: number; userFile: boolean; backup?: string }[];
}
export const emptyManifest = (): HerFolderManifest => ({ files: {}, backups: {}, actions: [] });

export type HerFolderOutcome =
  | { ok: true; action: HerFolderActionView }
  | { ok: false; why: HerFolderRefusal };

export class HerFolderRefused extends Error {
  constructor(readonly why: HerFolderRefusal) { super(`her folder: ${why}`); }
}
const refuse = (why: HerFolderRefusal): never => { throw new HerFolderRefused(why); };
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;

export interface HerFolderStoreOptions {
  /** The folder as the user chose it, and its real path at that moment. */
  folder: string;
  real: string;
  manifest: HerFolderManifest;
  /** Persists the manifest after every change (host.ts). */
  saveManifest(manifest: HerFolderManifest): Promise<void>;
  now?(): number;
  id?(): string;
  writeAtomic?: AtomicFileWriter;
  platform?: NodeJS.Platform;
}

export class HerFolderStore {
  readonly folder: string;
  readonly real: string;
  private readonly manifest: HerFolderManifest;
  private readonly platform: NodeJS.Platform;
  private readonly writeAtomic: AtomicFileWriter;
  constructor(private readonly options: HerFolderStoreOptions) {
    this.folder = options.folder; this.real = options.real; this.manifest = options.manifest;
    this.platform = options.platform ?? process.platform;
    this.writeAtomic = options.writeAtomic ?? atomicWriteFile;
  }

  /** The real path of a folder the user picked; refuses anything that is not a directory. */
  static async resolveFolder(folder: string): Promise<string> {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) refuse('outside');
    const real = await realpath(folder).catch(() => refuse('missing'));
    if (!(await stat(real)).isDirectory()) refuse('not-file');
    return real;
  }

  // ------------------------------------------------------------------ her actions

  /** 'write' replaces (or creates) the whole file; 'append' adds to its end (or creates it). */
  async write(rawName: unknown, content: string, mode: 'write' | 'append'): Promise<HerFolderOutcome> {
    return this.guard(async () => {
      const name = this.checkName(rawName);
      const root = await this.root();
      const target = path.join(root, name);
      const existing = await this.inspect(root, target);
      let text = content.replace(/\u0000/gu, '');
      if (mode === 'append' && existing) {
        if (existing.size > HER_FOLDER_FILE_MAX_BYTES) refuse('size');
        const before = await readFile(target, 'utf8');
        text = before + (before && !before.endsWith('\n') && !text.startsWith('\n') ? '\n' : '') + text;
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > HER_FOLDER_FILE_MAX_BYTES) refuse('size');
      const key = nameKey(name, this.platform), hers = !!existing && this.isHers(key, existing);
      // Her total after this: what she has now, plus the new text (her old version stays counted as the copy kept of it; a
      // user's kept original is the user's, not hers).
      if (await this.usedBytes() + bytes > HER_FOLDER_TOTAL_MAX_BYTES) refuse('total');
      const backup = existing ? await this.keepVersion(root, target, existing.name, existing.size, hers) : undefined;
      await this.writeAtomic(target, text);
      const after = await this.inspect(root, target);
      if (!after) refuse('failed');
      this.manifest.files[key] = { name: after!.name, size: after!.size, mtimeMs: after!.mtimeMs };
      const kind: HerFolderActionKind = !existing ? 'created' : mode === 'append' ? 'appended' : 'changed';
      return this.record(kind, after!.name, after!.size, !!existing && !hers, backup);
    });
  }

  /**
   * I-086: a picture of her own the app made (never from her reply, never a user's file): a new top-level PNG whose stem passes the
   * same name check as her text files, at most HER_FOLDER_FILE_MAX_BYTES, inside her total. It never replaces anything: a taken name
   * is refused ('failed'; the caller numbers it). Written beside the target first (exclusive create), then renamed into place.
   */
  async writePicture(stem: unknown, bytes: Uint8Array): Promise<HerFolderOutcome> {
    return this.guard(async () => {
      if (typeof stem !== 'string') refuse('name');
      const checked = sanitizeHerFileName(`${stem}.md`);
      if (!checked.ok || checked.name !== `${stem}.md`) refuse(checked.ok ? 'name' : checked.why);
      const png = bytes instanceof Uint8Array && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      if (!png) refuse('malformed');
      if (bytes.byteLength > HER_FOLDER_FILE_MAX_BYTES) refuse('size');
      const name = `${stem}.png`, root = await this.root(), target = path.join(root, name);
      if (await this.inspect(root, target)) refuse('failed');
      if (await this.usedBytes() + bytes.byteLength > HER_FOLDER_TOTAL_MAX_BYTES) refuse('total');
      const temporary = path.join(root, `.${randomBytes(6).toString('hex')}.tmp`);
      try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
      catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      const after = await this.inspect(root, target);
      if (!after) refuse('failed');
      this.manifest.files[nameKey(name, this.platform)] = { name: after!.name, size: after!.size, mtimeMs: after!.mtimeMs };
      return this.record('created', after!.name, after!.size, false, undefined);
    });
  }

  /** I-086: whether a top-level file of this checked name is there now and still exactly as she left it (null: not there). */
  async ownState(rawName: unknown): Promise<'hers' | 'user' | null> {
    try {
      const name = this.checkName(rawName), root = await this.root();
      const info = await this.inspect(root, path.join(root, name));
      return info ? (this.isHers(nameKey(info.name, this.platform), info) ? 'hers' : 'user') : null;
    } catch { return 'user'; }
  }

  /** Moves the file into her recycle bin (removed after 30 days). */
  async trash(rawName: unknown): Promise<HerFolderOutcome> {
    return this.guard(async () => {
      const name = this.checkName(rawName);
      const root = await this.root();
      const target = path.join(root, name);
      const existing = await this.inspect(root, target);
      if (!existing) refuse('missing');
      const key = nameKey(name, this.platform), hers = this.isHers(key, existing!);
      // A move adds nothing to her total: her file is counted in the bin instead of in the folder.
      const bin = await this.hidden(root, HER_FOLDER_TRASH_DIR);
      const file = `${this.stamp()} ${existing!.name}`;
      const destination = path.join(bin, file);
      await rename(target, destination);
      const id = this.newId();
      this.manifest.backups[id] = { kind: 'trash', file, name: existing!.name, at: this.now(), bytes: existing!.size, hers, expiresAt: this.now() + HER_FOLDER_KEEP_MS };
      delete this.manifest.files[key];
      return this.record('trashed', existing!.name, existing!.size, !hers, id);
    });
  }

  // ------------------------------------------------------------------ the user's restore (control window)

  /** Brings back what an action left: the version from before it, or the file from her recycle bin. */
  async restore(actionId: unknown): Promise<HerFolderOutcome> {
    return this.guard(async () => {
      const action = this.manifest.actions.find(item => item.id === actionId);
      const backup = action?.backup ? this.manifest.backups[action.backup] : undefined;
      if (!action || !backup) refuse('missing');
      const name = this.checkName(backup!.name);
      const root = await this.root();
      const dir = await this.hidden(root, backup!.kind === 'trash' ? HER_FOLDER_TRASH_DIR : HER_FOLDER_VERSIONS_DIR);
      const source = path.join(dir, backup!.file);
      if (path.basename(backup!.file) !== backup!.file || !(await this.inspect(dir, source))) refuse('missing');
      const target = path.join(root, name);
      const existing = await this.inspect(root, target);
      const key = nameKey(name, this.platform);
      // What is there now is kept too, so a restore can always be undone.
      if (existing) await this.keepVersion(root, target, existing.name, existing.size, this.isHers(key, existing));
      if (backup!.kind === 'trash') {
        await rename(source, target);
        delete this.manifest.backups[action!.backup!];
      } else {
        const temporary = path.join(root, `.${randomBytes(8).toString('hex')}.restore.tmp`);
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      }
      // The user chose this content: from now on it counts as the user's file.
      delete this.manifest.files[key];
      const after = await this.inspect(root, target);
      return this.record('restored', after?.name ?? name, after?.size ?? backup!.bytes, true, undefined);
    });
  }

  // ------------------------------------------------------------------ reading (inside the folder only)

  /** Her folder's top-level text files, for this turn's context: names, sizes and whether she wrote them. */
  async list(limit = 40): Promise<{ name: string; bytes: number; hers: boolean }[]> {
    const root = await this.root();
    const out: { name: string; bytes: number; hers: boolean }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const checked = sanitizeHerFileName(entry.name);
      if (!entry.isFile() || !checked.ok || checked.name !== entry.name) continue;
      const info = await this.inspect(root, path.join(root, entry.name)).catch(() => null);
      if (!info) continue;
      out.push({ name: info.name, bytes: info.size, hers: this.isHers(nameKey(info.name, this.platform), info) });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The text of one top-level file the user named, at most `maxChars`; null when it is not a plain text file inside. */
  async read(rawName: unknown, maxChars: number): Promise<string | null> {
    try {
      const name = this.checkName(rawName);
      const root = await this.root();
      const target = path.join(root, name);
      const info = await this.inspect(root, target);
      if (!info || info.size > HER_FOLDER_FILE_MAX_BYTES) return null;
      return (await readFile(target, 'utf8')).slice(0, maxChars);
    } catch { return null; }
  }

  // ------------------------------------------------------------------ upkeep and views

  /** Removes her versions and recycle-bin items older than 30 days (a user's kept original never expires). */
  async purge(): Promise<number> {
    let removed = 0;
    const now = this.now();
    let root: string | null = null;
    try { root = await this.root(); } catch { return 0; }
    for (const [id, backup] of Object.entries(this.manifest.backups)) {
      if (backup.expiresAt === null || backup.expiresAt > now) continue;
      try {
        const dir = await this.hidden(root, backup.kind === 'trash' ? HER_FOLDER_TRASH_DIR : HER_FOLDER_VERSIONS_DIR, false);
        const file = path.join(dir, backup.file);
        // Only the plain file it names, inside its own hidden subfolder; a link there is dropped from the record, never followed.
        if (path.basename(backup.file) === backup.file && await this.inspect(dir, file)) await unlink(file);
      } catch (error) { if (!(error instanceof HerFolderRefused) && code(error) !== 'ENOENT') continue; } // busy: try again next time
      delete this.manifest.backups[id];
      removed++;
    }
    if (removed) await this.options.saveManifest(this.manifest);
    return removed;
  }

  /** Bytes she has there: her files (while they are still as she left them) and the copies her changes keep. */
  async usedBytes(): Promise<number> {
    let total = 0;
    const root = await this.root();
    for (const [key, file] of Object.entries(this.manifest.files)) {
      const info = await this.inspect(root, path.join(root, file.name)).catch(() => null);
      if (info && this.isHers(key, info)) total += info.size;
    }
    for (const backup of Object.values(this.manifest.backups)) if (backup.hers) total += backup.bytes;
    return total;
  }

  /** The control page's list, newest first. */
  actions(): HerFolderActionView[] {
    return this.manifest.actions.slice(-HER_FOLDER_RECENT).reverse().map(action => {
      const backup = action.backup ? this.manifest.backups[action.backup] : undefined;
      return { id: action.id, at: action.at, kind: action.kind, name: action.name, bytes: action.bytes, userFile: action.userFile,
        restore: backup ? backup.kind : null };
    });
  }

  // ------------------------------------------------------------------ the checks

  private async guard(operation: () => Promise<HerFolderOutcome>): Promise<HerFolderOutcome> {
    try {
      await this.purge().catch(() => 0);
      return await operation();
    } catch (error) {
      if (error instanceof HerFolderRefused) return { ok: false, why: error.why };
      return { ok: false, why: 'failed' };
    }
  }

  private checkName(raw: unknown): string {
    const result = sanitizeHerFileName(raw);
    if (!result.ok) refuse(result.why);
    return (result as { name: string }).name;
  }

  /** The folder's real path now; it must still be the one the user chose (not moved or swapped for a link elsewhere). */
  private async root(): Promise<string> {
    const real = await realpath(this.folder).catch(() => refuse('missing'));
    if (!this.same(real, this.real)) refuse('moved');
    if (!(await stat(real)).isDirectory()) refuse('moved');
    return real;
  }

  /**
   * A path inside `dir` (one level down): null when nothing is there; refused when it is a link or junction, not a plain file,
   * or resolves anywhere but itself (a redirecting reparse point, an 8.3 short alias of another file).
   */
  private async inspect(dir: string, file: string): Promise<{ name: string; size: number; mtimeMs: number } | null> {
    if (!this.same(path.dirname(file), dir)) refuse('outside');
    let info;
    try { info = await lstat(file); } catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink()) refuse('link');
    if (!info.isFile()) refuse('not-file');
    const real = await realpath(file);
    if (!this.same(real, file)) refuse(this.same(path.dirname(real), dir) ? 'link' : 'outside');
    return { name: path.basename(real), size: info.size, mtimeMs: info.mtimeMs };
  }

  /** One of the hidden subfolders: made when missing (unless `create` is false); refused when it is a link or not a folder. */
  private async hidden(root: string, sub: string, create = true): Promise<string> {
    const dir = path.join(root, sub);
    let info;
    try { info = await lstat(dir); } catch (error) {
      if (code(error) !== 'ENOENT' || !create) throw error;
      await mkdir(dir);
      info = await lstat(dir);
    }
    if (info.isSymbolicLink()) refuse('link');
    if (!info.isDirectory()) refuse('not-file');
    const real = await realpath(dir);
    if (!this.same(real, dir)) refuse('link');
    return dir;
  }

  /** Copies the file as it is now into `.她的旧版本/` (exclusive create: never onto something already there). */
  private async keepVersion(root: string, target: string, name: string, bytes: number, hers: boolean): Promise<string> {
    const dir = await this.hidden(root, HER_FOLDER_VERSIONS_DIR);
    const dot = name.lastIndexOf('.');
    const file = `${name.slice(0, dot)}.${this.stamp()}${name.slice(dot)}`;
    await copyFile(target, path.join(dir, file), constants.COPYFILE_EXCL);
    const id = this.newId();
    this.manifest.backups[id] = { kind: 'version', file, name, at: this.now(), bytes, hers, expiresAt: hers ? this.now() + HER_FOLDER_KEEP_MS : null };
    return id;
  }

  /** She wrote this file and it is still exactly as she left it. */
  private isHers(key: string, info: { size: number; mtimeMs: number }): boolean {
    const mine = this.manifest.files[key];
    return !!mine && mine.size === info.size && mine.mtimeMs === info.mtimeMs;
  }

  private async record(kind: HerFolderActionKind, name: string, bytes: number, userFile: boolean, backup: string | undefined): Promise<HerFolderOutcome> {
    const action = { id: this.newId(), at: this.now(), kind, name, bytes, userFile, ...(backup ? { backup } : {}) };
    this.manifest.actions.push(action);
    if (this.manifest.actions.length > HER_FOLDER_RECENT * 2) this.manifest.actions.splice(0, this.manifest.actions.length - HER_FOLDER_RECENT * 2);
    await this.options.saveManifest(this.manifest);
    const backupEntry = backup ? this.manifest.backups[backup] : undefined;
    return { ok: true, action: { id: action.id, at: action.at, kind, name, bytes, userFile, restore: backupEntry ? backupEntry.kind : null } };
  }

  private same(a: string, b: string): boolean {
    const fold = (value: string) => { const resolved = path.resolve(value); return this.platform === 'linux' ? resolved : resolved.toLowerCase(); };
    return fold(a) === fold(b);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private newId(): string { return this.options.id?.() ?? randomBytes(12).toString('hex'); }
  /** A sortable local time plus a little randomness, so two copies in the same second never collide. */
  private stamp(): string {
    const d = new Date(this.now()), two = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
  }
}
