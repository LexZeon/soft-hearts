import type { BigIntStats } from 'node:fs';
import path from 'node:path';

/**
 * The app's own packaged archive (app.asar), for model identity (blush-calibration.ts keyForModel; docs/claude/2026-11-27-model-checkup-not-saved.md).
 *
 * Electron's asar-aware fs answers stat() for a file INSIDE the archive with the current time as mtime/ctime, so the ordinary identity rule
 * ("stat, hash, stat again, same size/mtime/ctime/ino/dev") never holds there and every preinstalled model in the archive (Mumi, One) was
 * refused. The bundled Gene has its own reviewed path (createTrustedPackedModel: a pinned size and sha256). For the other entries this
 * capability gives the identity the archive itself has on the real disk: the archive file's own size/mtime/ctime/ino/dev, read through
 * original-fs and required to stay as they were when the app started, plus the entry's path inside it and its size. The key is still the
 * content's sha256, hashed once per process (the store's identity cache).
 *
 * Which archive is "own" is the host's decision from the app's real path (app.getAppPath(), resolved here), never a name: a user's folder
 * called app.asar elsewhere is not inside it and keeps the strict rule. An entry with an unpacked twin on the real disk (app.asar.unpacked)
 * is a real file and keeps the strict rule too.
 */
export class AppArchiveChanged extends Error {
  constructor() { super('应用资源已变化，请重启 soft hearts 后重新读取红晕校准。'); }
}

export interface PhysicalArchiveFiles {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<BigIntStats>;
}

export const physicalSignature = (info: BigIntStats) => `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.dev}`;

export interface OwnAppArchive {
  /** The archive file, resolved on the real disk. */
  readonly canonicalPath: string;
  /** The archive's own signature as it was when the app started; throws AppArchiveChanged (for the rest of this process) once it changed. */
  archiveSignature(): Promise<string>;
  /** The entry's path inside this archive ('/'-separated), or null when `file` is not inside it, or when it has an unpacked twin on the disk. */
  entryOf(file: string): Promise<string | null>;
}

/** The host makes this once, from app.getAppPath() of a packaged app, with original-fs as `physical` (the real disk, not the asar view). */
export async function createOwnAppArchive(archivePath: string, physical: PhysicalArchiveFiles): Promise<OwnAppArchive> {
  if (!path.isAbsolute(archivePath) || path.extname(archivePath).toLowerCase() !== '.asar') throw new Error('Not the app archive');
  const archive = await physical.realpath(archivePath).catch(() => { throw new Error('Not the app archive'); });
  const before = await physical.lstat(archive);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The app archive must be a physical regular file');
  const baseline = physicalSignature(before);
  let invalidated = false;
  const archiveSignature = async () => {
    if (invalidated) throw new AppArchiveChanged();
    try {
      const current = await physical.lstat(archive);
      if (!current.isFile() || current.isSymbolicLink() || physicalSignature(current) !== baseline) throw new AppArchiveChanged();
      return baseline;
    } catch { invalidated = true; throw new AppArchiveChanged(); }
  };
  const entryOf = async (file: string) => {
    const relative = path.relative(archive, path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try { await physical.lstat(path.join(`${archive}.unpacked`, relative)); return null; } // a real file on the disk: the strict rule
    catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== 'ENOENT' && code !== 'ENOTDIR') return null; }
    return relative.split(path.sep).join('/');
  };
  return Object.freeze({ canonicalPath: archive, archiveSignature, entryOf });
}
