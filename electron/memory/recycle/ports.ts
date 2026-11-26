// I-144 回收站：完整复原. Every row of the data map
// that says recycle: 'take' (electron/foundation/data-map.ts) has one port here: `capture` copies what the store holds for a character (or
// one of her connections) without changing anything, `remove` takes it out of the store, `restore` writes a capture back exactly. A
// deletion captures every row first, writes the bin entry, and only then removes; finding back restores every row. The registry type is
// made from the table, so a 'take' row without all three does not compile.
// Helpers for the two shapes the stores have: one file (or folder) per character or connection, copied byte for byte; and one shared
// file keyed by character, where the character's part goes back at the place it was.
// No Electron import.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryScope } from '../../../shared/memory/memory';
import type { RecycleId } from '../../foundation/data-map';
export { putKeyed, putListed, takeKeyed, takeListed, type KeyedPart, type ListedPart } from '../../foundation/keyed-part';

/** One store's part of a recycle entry, for a target of type T (a connection scope, or a character id). */
export interface RecyclePortOf<P extends 'scope' | 'character', T> {
  readonly per: P;
  /** What the store holds for the target now, as JSON-able data (bytes as base64); null/undefined when nothing. Changes nothing. */
  capture(target: T): Promise<unknown>;
  /** Takes it out of the store (after the bin entry is safely written). captured: what capture returned. */
  remove(target: T, captured: unknown): Promise<unknown>;
  /** Writes a capture back exactly. */
  restore(target: T, captured: unknown): Promise<void>;
}
export type ScopePort = RecyclePortOf<'scope', MemoryScope>;
export type CharacterPort = RecyclePortOf<'character', string>;
export type RecyclePort = ScopePort | CharacterPort;

/** Every 'take' row of the data map. null: that store is not running in this session (nothing of it to keep or put back now). */
export type RecycleRegistry = { readonly [K in RecycleId]: RecyclePort | null };

// ---- one file (or a folder of files) per character or connection: byte for byte ----

/** Files by their path relative to the store's root (always '/'), contents in base64. */
export interface CapturedFiles { files: Record<string, string> }

const SAFE_SEGMENT = /^[^\\/:*?"<>|\0]{1,200}$/;
function insideRoot(root: string, relative: string): string {
  const segments = relative.split('/');
  if (!segments.length || segments.some(segment => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) throw new Error('回收站里的文件名不正确。');
  const full = path.join(root, ...segments);
  if (path.relative(root, full).startsWith('..') || path.isAbsolute(path.relative(root, full))) throw new Error('回收站里的文件名不正确。');
  return full;
}

/** Writes bytes beside the file and renames it into place (the folder is made when missing). */
export async function writeBytesAtomic(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(String(code)) || attempt >= 5) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/**
 * What lives at `rel` (a file, or every file below a folder), relative to `root`: null when nothing is there. Read failures other than a
 * missing file reject, so a deletion never goes ahead with a copy that is short of something.
 */
export async function captureFiles(root: string, rels: readonly string[]): Promise<CapturedFiles | null> {
  const files: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    const full = insideRoot(root, rel);
    let names: string[] | null = null;
    try { names = await readdir(full); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code !== 'ENOTDIR') throw error;
    }
    if (names) { for (const name of names.sort()) if (!name.endsWith('.tmp')) await walk(`${rel}/${name}`); return; }
    try { files[rel] = (await readFile(full)).toString('base64'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  for (const rel of rels) await walk(rel);
  return Object.keys(files).length ? { files } : null;
}

/**
 * Writes captured files back byte for byte. Only names that `allowed` accepts (the store's own names for this target) are written;
 * anything else in the capture is refused, so a bin file can never write elsewhere.
 */
export async function restoreFiles(root: string, captured: unknown, allowed: (rel: string) => boolean): Promise<void> {
  const files = (captured as CapturedFiles | null)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
  const entries = Object.entries(files);
  for (const [rel, base64] of entries) if (typeof base64 !== 'string' || !allowed(rel)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
  for (const [rel, base64] of entries) await writeBytesAtomic(insideRoot(root, rel), Buffer.from(base64, 'base64'));
}

/** Removes the files or folders (missing is fine). */
export async function removeFiles(root: string, rels: readonly string[]): Promise<void> {
  for (const rel of rels) await rm(insideRoot(root, rel), { recursive: true, force: true });
}

/** A rel path under `folder` whose name is any one file (`folder/<name>`), or exactly one of `names`. */
export function allowedRels(names: readonly string[], folders: readonly string[] = []): (rel: string) => boolean {
  return rel => names.includes(rel) || folders.some(folder => rel.startsWith(`${folder}/`) && !rel.slice(folder.length + 1).includes('/'));
}

/**
 * A port for a store that keeps one file (or folder) per target and may hold it in memory: capture copies the files byte for byte;
 * remove is the store's own forget; restore lets the store drop what it holds (drop, default the same forget, so no copy held there is
 * left to write over what comes back), writes the files, then tells the store to read them again (reloaded).
 */
export function filesPort<P extends 'scope' | 'character', T extends (P extends 'scope' ? MemoryScope : string)>(per: P, options: {
  root: () => string;
  /** The target's files and folders, relative to root ('/'-separated). */
  rels(target: T): string[];
  /** Folders whose direct files belong to the target (our-things/<id>/…). */
  folders?(target: T): string[];
  remove(target: T): Promise<unknown>;
  drop?(target: T): Promise<unknown>;
  reloaded?(target: T): Promise<unknown> | unknown;
}): RecyclePortOf<P, T> {
  return {
    per,
    capture: target => captureFiles(options.root(), [...options.rels(target), ...(options.folders?.(target) ?? [])]),
    remove: target => options.remove(target),
    restore: async (target, captured) => {
      await (options.drop ?? options.remove)(target);
      await restoreFiles(options.root(), captured, allowedRels(options.rels(target), options.folders?.(target) ?? []));
      await options.reloaded?.(target);
    },
  };
}
