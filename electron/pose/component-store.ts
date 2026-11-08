/**
 * Pose-sensing component manager (I-001 stage 1): download on request, verify, import offline, delete,
 * clean old versions. Lives under `%LOCALAPPDATA%\soft-hearts-claude\components\` (never the roaming
 * profile, never a synced folder); one folder per component version and platform:
 *
 *   components/pose-v<N>/<platform>/{runtime,models,licenses}/…, installed.json, route.json
 *   components/.staging-pose-v<N>-<platform>/   files verified so far (an interrupted download resumes here)
 *   components/.download/                       archives while they download (*.partial until verified)
 *
 * Nothing is trusted from an archive except bytes that match the built-in manifest; paths never reach a renderer.
 *
 * Runtime source: this platform's small pack on the project's GitHub Release first
 * (same files as the npm tarballs, byte for byte); if it cannot be downloaded (network, HTTP error, cut off), the npm
 * tarballs are fetched instead and the progress says so. A pack that arrives but fails its hash is discarded and
 * reported (`verify-failed`); the retry then goes to the official tarballs.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ComponentVerifyError, extractTarGz, extractZipFile, findZipDirectory, inflateZipEntry, parseZipEntries, pickZipEntry, verifyFile, zipEntrySpan,
} from './archive';
import {
  POSE_MANIFEST, POSE_MODEL_FILES, POSE_RUNTIME_ENTRY, archiveFiles, downloadBytes, installedBytes, neededArchives, officialDownloadBytes, packProblem,
  type ManifestArchive, type ManifestFile, type ManifestPack, type PoseManifest, type PosePlatform,
} from './manifest';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number; ok: boolean; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
export interface ComponentProgress {
  stage: 'downloading' | 'installing'; done: number; total: number;
  /** True while the official tarballs are downloaded instead of this platform's small pack (`total` is then the bigger number). */
  fallback?: boolean;
}
export type ComponentFailure = 'download-failed' | 'verify-failed' | 'canceled';
export class ComponentInstallError extends Error {
  constructor(readonly failure: ComponentFailure, message: string) { super(message); this.name = 'ComponentInstallError'; }
}
export interface ImportResult { accepted: number; rejected: number; complete: boolean }
export interface RouteRecord { fingerprint: string; route: 'dml' | 'cpu'; dmlBad: boolean; p90: { dml: number | null; cpu: number | null } }
export interface PoseRuntimePaths { runtimeEntry: string; detector: string; pose: string; detectorSha256: string; poseSha256: string }

export interface ComponentStoreOptions {
  /** `%LOCALAPPDATA%\soft-hearts-claude\components` (absolute). */
  root: string;
  platform: PosePlatform;
  manifest?: PoseManifest;
  /** Electron `net.fetch` in the app; a fake in tests. Called only from `install()`. */
  fetch: FetchLike;
  /** Folder with the licence texts copied into every installed component (`dist-electron/pose-licenses`). */
  licenseDir: string;
  /** Upper bound for an imported file (bytes). */
  maxImportBytes?: number;
  /**
   * Folder name of this component (`<component>-v<N>`); 'pose' by default. The local speech recognizer uses the same
   * store as 'asr' (electron/asr/manifest.ts), under its own root so the two never clean up each other's files.
   */
  component?: string;
  /**
   * Installed platform folders of other components with byte-identical files to copy instead of downloading
   * (the onnxruntime-node runtime is the same for pose sensing and speech recognition). Each file is hash-checked.
   */
  reuseDirs?: () => readonly string[];
}

const MAX_IMPORT_BYTES = 300 * 1024 * 1024;

function safeRelative(rel: string): string {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`unsafe component path: ${rel}`);
  return rel;
}

/** Where components live on this computer; null when there is no per-user local app-data folder. */
export function defaultComponentRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env.LOCALAPPDATA;
  return local && path.isAbsolute(local) ? path.join(local, 'soft-hearts-claude', 'components') : null;
}

export class PoseComponentStore {
  private readonly manifest: PoseManifest;
  private readonly root: string;
  private readonly component: string;
  private readonly dirName: RegExp;
  private installedFlag = false;
  private busy: Promise<unknown> | null = null;
  /** The small pack arrived but failed verification in this session: use the official sources from now on. */
  private packRejected = false;

  constructor(private readonly options: ComponentStoreOptions) {
    if (!path.isAbsolute(options.root)) throw new Error('component root must be absolute');
    this.root = path.resolve(options.root);
    this.component = options.component ?? 'pose';
    if (!/^[a-z][a-z0-9]{0,15}$/.test(this.component)) throw new Error('component name must be short lowercase letters and digits');
    this.dirName = new RegExp(`^${this.component}-v(\\d+)$`);
    this.manifest = options.manifest ?? POSE_MANIFEST;
    for (const archive of this.manifest.archives) if (archive.kind === 'file') {
      const kept = Object.values(archive.files).flat();
      if (kept.length !== 1 || !archive.sha256 || kept[0]!.size !== archive.size || kept[0]!.sha256 !== archive.sha256)
        throw new Error(`file ${archive.id}: needs exactly one kept file with the archive's own size and SHA-256`);
    }
    for (const archive of this.manifest.archives) for (const file of archiveFiles(archive, options.platform)) safeRelative(file.to);
    for (const file of this.manifest.generated) safeRelative(file.to);
    const problem = packProblem(this.manifest, options.platform);
    if (problem) throw new Error(problem);
  }

  get platform(): PosePlatform { return this.options.platform; }
  get version(): number { return this.manifest.version; }
  /** Synchronous view for the camera toggle (refreshed by refresh(), install, import and remove). */
  get installed(): boolean { return this.installedFlag; }
  get working(): boolean { return this.busy !== null; }
  /** What the first download fetches: with this platform's small pack when there is one (about 85 MB instead of 170). */
  get downloadBytes(): number { return downloadBytes(this.manifest, this.options.platform, !!this.pack()); }
  /** The same download from the official sources only (shown while falling back). */
  get officialDownloadBytes(): number { return officialDownloadBytes(this.manifest, this.options.platform); }
  private pack(): ManifestPack | null { return this.packRejected ? null : this.manifest.packs?.[this.options.platform] ?? null; }
  get installedBytes(): number { return this.installedFlag ? installedBytes(this.manifest, this.options.platform) : 0; }

  private versionDir(version = this.manifest.version) { return path.join(this.root, `${this.component}-v${version}`); }
  private platformDir(version = this.manifest.version) { return path.join(this.versionDir(version), this.options.platform); }
  private stagingDir() { return path.join(this.root, `.staging-${this.component}-v${this.manifest.version}-${this.options.platform}`); }
  /** The installed folder of this version and platform (null when not installed); main process only, never sent to a window. */
  installedDir(): string | null { return this.installedFlag ? this.platformDir() : null; }
  /** Absolute path of one kept file (`to` from the manifest) when installed. */
  installedFile(to: string): string | null {
    if (!this.installedFlag || !this.files().some(file => file.to === to)) return null;
    return path.join(this.platformDir(), ...safeRelative(to).split('/'));
  }
  private downloadDir() { return path.join(this.root, '.download'); }
  private files(): ManifestFile[] { return neededArchives(this.manifest, this.options.platform).flatMap(a => archiveFiles(a, this.options.platform)); }

  /** Absolute paths for the inference process (main process only). Null when not installed. */
  runtimePaths(): PoseRuntimePaths | null {
    if (!this.installedFlag) return null;
    const dir = this.platformDir();
    const detector = this.files().find(file => file.to === POSE_MODEL_FILES.detector);
    const pose = this.files().find(file => file.to === POSE_MODEL_FILES.pose);
    if (!detector || !pose) return null;
    return { runtimeEntry: path.join(dir, ...POSE_RUNTIME_ENTRY.split('/')), detector: path.join(dir, ...detector.to.split('/')),
      pose: path.join(dir, ...pose.to.split('/')), detectorSha256: detector.sha256, poseSha256: pose.sha256 };
  }

  /** Quick check (marker + sizes, no hashing) and housekeeping; call at startup. */
  async refresh(): Promise<boolean> {
    this.installedFlag = await this.checkInstalled();
    if (!this.busy) await this.cleanup().catch(() => undefined);
    return this.installedFlag;
  }
  private async checkInstalled(): Promise<boolean> {
    const dir = this.platformDir();
    try {
      const marker = JSON.parse(await readFile(path.join(dir, 'installed.json'), 'utf8')) as { version?: unknown; platform?: unknown };
      if (marker.version !== this.manifest.version || marker.platform !== this.options.platform) return false;
      for (const file of this.files()) {
        const info = await stat(path.join(dir, ...file.to.split('/')));
        if (!info.isFile() || info.size !== file.size) return false;
      }
      return true;
    } catch { return false; }
  }

  /**
   * Remove leftovers: `.partial` downloads and, once this version is installed, every other version folder
   * (R45: the portable app has no uninstaller, so the app cleans up after itself).
   */
  async cleanup(): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    let names: string[] = [];
    try { names = await readdir(this.root); } catch { return { removed }; }
    for (const name of names) {
      const full = path.join(this.root, name);
      const version = this.dirName.exec(name);
      const stale = name === '.download' || (name.startsWith('.staging-') && name !== path.basename(this.stagingDir()))
        || (!!version && Number(version[1]) !== this.manifest.version && this.installedFlag);
      if (!stale) continue;
      await this.removeInside(full);
      removed.push(name);
    }
    return { removed };
  }

  private async removeInside(target: string): Promise<void> {
    const relative = path.relative(this.root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('refusing to delete outside the component root');
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }

  /** Delete every pose component on this computer (all versions, partial downloads, route cache). */
  async remove(): Promise<void> {
    await this.exclusive(async () => {
      let names: string[] = [];
      try { names = await readdir(this.root); } catch { /* nothing there */ }
      for (const name of names) if (this.dirName.test(name) || name === '.download' || name.startsWith('.staging-')) await this.removeInside(path.join(this.root, name));
      this.installedFlag = false;
    });
  }

  // ------------------------------------------------------------------ route cache (self-test result)

  async readRoute(): Promise<RouteRecord | null> {
    try {
      const value = JSON.parse(await readFile(path.join(this.platformDir(), 'route.json'), 'utf8')) as RouteRecord;
      const ms = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 60_000);
      return typeof value.fingerprint === 'string' && value.fingerprint.length <= 512 && (value.route === 'dml' || value.route === 'cpu')
        && typeof value.dmlBad === 'boolean' && value.p90 && ms(value.p90.dml) && ms(value.p90.cpu) ? value : null;
    } catch { return null; }
  }
  async writeRoute(record: RouteRecord): Promise<void> {
    if (!this.installedFlag) return;
    await writeFile(path.join(this.platformDir(), 'route.json'), JSON.stringify(record));
  }
  async clearRoute(): Promise<void> { await rm(path.join(this.platformDir(), 'route.json'), { force: true }); }

  // ------------------------------------------------------------------ install

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) return Promise.reject(new Error('component operation already running'));
    const run = work().finally(() => { this.busy = null; });
    this.busy = run;
    return run;
  }

  /** Download what is missing (only after the user clicked「下载」), verify everything, then activate atomically. */
  install(signal: AbortSignal, onProgress: (progress: ComponentProgress) => void = () => {}): Promise<void> {
    return this.exclusive(async () => {
      if (await this.checkInstalled()) { this.installedFlag = true; return; }
      const staging = this.stagingDir();
      await mkdir(path.join(staging, '.done'), { recursive: true });
      let todo: ManifestArchive[] = [];
      for (const archive of neededArchives(this.manifest, this.options.platform))
        if (!await this.archiveDone(archive) && !await this.reuseFromOtherVersion(archive)) todo.push(archive);
      const declared = this.manifest.packs?.[this.options.platform];
      const pack = this.pack();
      const usePack = !!pack && todo.some(archive => pack.replaces.includes(archive.id));
      const replaced = (archive: ManifestArchive) => !!pack && pack.replaces.includes(archive.id);
      const sum = (list: ManifestArchive[]) => list.reduce((total, archive) => total + archive.networkBytes, 0);
      // Fallback = this platform has a pack, but its files come from the npm tarballs this time.
      let fallback = !usePack && todo.some(archive => !!declared?.replaces.includes(archive.id));
      let total = usePack ? pack!.networkBytes + sum(todo.filter(archive => !replaced(archive))) : sum(todo);
      let done = 0;
      const tell = (stage: ComponentProgress['stage'] = 'downloading') =>
        onProgress({ stage, done: Math.min(done, total), total, ...(fallback ? { fallback } : {}) });
      const report = (bytes: number) => { done += bytes; tell(); };
      tell();
      try {
        if (usePack) {
          signal.throwIfAborted();
          try {
            const files = await this.fetchPack(pack!, signal, report);
            for (const archive of todo.filter(replaced)) await this.stage(archive, this.fromPack(archive, files));
            todo = todo.filter(archive => !replaced(archive));
            done = pack!.networkBytes; tell();
          } catch (error) {
            if (signal.aborted) throw error;
            if (error instanceof ComponentVerifyError) { this.packRejected = true; throw error; }
            // Not reachable, HTTP error or cut off: the same files from the official tarballs instead, and say so.
            fallback = true; done = 0; total = sum(todo); tell();
          }
        }
        for (const archive of todo) {
          signal.throwIfAborted();
          const before = done;
          if (archive.kind === 'file') await this.stageDownloaded(archive, await this.downloadWhole(archive, signal, report));
          else await this.stage(archive, await this.fetchArchive(archive, signal, report));
          done = before + archive.networkBytes;
          tell();
        }
        done = total; tell('installing');
        await this.activate();
      } catch (error) {
        throw this.classify(error, signal);
      } finally {
        await rm(this.downloadDir(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      }
    });
  }

  private classify(error: unknown, signal?: AbortSignal): ComponentInstallError {
    if (error instanceof ComponentInstallError) return error;
    if (signal?.aborted) return new ComponentInstallError('canceled', 'canceled');
    if (error instanceof ComponentVerifyError) return new ComponentInstallError('verify-failed', error.message);
    return new ComponentInstallError('download-failed', error instanceof Error ? error.message : String(error));
  }

  private async archiveDone(archive: ManifestArchive): Promise<boolean> {
    if (!existsSync(path.join(this.stagingDir(), '.done', archive.id))) return false;
    for (const file of archiveFiles(archive, this.options.platform)) {
      try { if (statSync(path.join(this.stagingDir(), ...file.to.split('/'))).size !== file.size) return false; }
      catch { return false; }
    }
    return true;
  }

  /**
   * An older installed version, or another component's installed folder (`reuseDirs`), with byte-identical files (the
   * models, the onnxruntime runtime) saves the download. Each file is hashed while it is read and copied, never trusted.
   */
  private async reuseFromOtherVersion(archive: ManifestArchive): Promise<boolean> {
    let names: string[] = [];
    try { names = await readdir(this.root); } catch { names = []; }
    const dirs = names.filter(name => { const version = this.dirName.exec(name); return !!version && Number(version[1]) !== this.manifest.version; })
      .map(name => path.join(this.root, name, this.options.platform));
    try { for (const dir of this.options.reuseDirs?.() ?? []) if (path.isAbsolute(dir)) dirs.push(path.resolve(dir)); } catch { /* none offered */ }
    for (const dir of dirs) {
      const found = new Map<ManifestFile, string>();
      try {
        for (const file of archiveFiles(archive, this.options.platform)) {
          const source = path.join(dir, ...file.to.split('/'));
          const info = await stat(source);
          if (!info.isFile() || info.size !== file.size || (await hashFile(source)).sha256Hex !== file.sha256) throw new Error('differs');
          found.set(file, source);
        }
      } catch { continue; }
      await this.stageCopies(archive, found);
      return true;
    }
    return false;
  }

  /** Copy hash-checked files into staging (no bytes in memory), checking each copy once more, then mark the archive done. */
  private async stageCopies(archive: ManifestArchive, files: Map<ManifestFile, string>): Promise<void> {
    const staging = this.stagingDir();
    for (const [file, source] of files) {
      const target = path.join(staging, ...file.to.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, `${target}.partial`);
      const copied = await stat(`${target}.partial`);
      if (copied.size !== file.size || (await hashFile(`${target}.partial`)).sha256Hex !== file.sha256) {
        await rm(`${target}.partial`, { force: true });
        throw new ComponentVerifyError(`copy differs: ${file.to}`);
      }
      await rename(`${target}.partial`, target);
    }
    await mkdir(path.join(staging, '.done'), { recursive: true });
    await writeFile(path.join(staging, '.done', archive.id), '');
  }

  /** A `file` archive: its verified download becomes the kept file directly (the archive hash is the file hash). */
  private async stageDownloaded(archive: ManifestArchive, downloaded: string): Promise<void> {
    const [file] = archiveFiles(archive, this.options.platform);
    if (!file) throw new ComponentVerifyError(`no kept file: ${archive.id}`);
    const target = path.join(this.stagingDir(), ...file.to.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true });
    await rename(downloaded, target);
    await mkdir(path.join(this.stagingDir(), '.done'), { recursive: true });
    await writeFile(path.join(this.stagingDir(), '.done', archive.id), '');
  }

  /** Write verified bytes into staging, then mark the archive done (files first, marker last). */
  private async stage(archive: ManifestArchive, files: Map<ManifestFile, Buffer>): Promise<void> {
    const staging = this.stagingDir();
    for (const [file, data] of files) {
      verifyFile(file, data);
      const target = path.join(staging, ...file.to.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(`${target}.partial`, data);
      await rename(`${target}.partial`, target);
    }
    await mkdir(path.join(staging, '.done'), { recursive: true });
    await writeFile(path.join(staging, '.done', archive.id), '');
  }

  /** All archives staged: add the generated files and licences, write the marker, move into place. */
  private async activate(): Promise<void> {
    const staging = this.stagingDir();
    for (const archive of neededArchives(this.manifest, this.options.platform))
      if (!await this.archiveDone(archive)) throw new ComponentVerifyError(`incomplete: ${archive.id}`);
    for (const file of this.manifest.generated) {
      const target = path.join(staging, ...file.to.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text);
    }
    await mkdir(path.join(staging, 'licenses'), { recursive: true });
    for (const name of await readdir(this.options.licenseDir).catch(() => [] as string[]))
      if (name.endsWith('.txt')) await copyFile(path.join(this.options.licenseDir, name), path.join(staging, 'licenses', name));
    await rm(path.join(staging, '.done'), { recursive: true, force: true });
    await writeFile(path.join(staging, 'installed.json'), JSON.stringify({ component: this.component, version: this.manifest.version,
      platform: this.options.platform, files: this.files().length, bytes: installedBytes(this.manifest, this.options.platform),
      installedAt: new Date().toISOString() }));
    const target = this.platformDir();
    await this.removeInside(target);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(staging, target);
    this.installedFlag = await this.checkInstalled();
    if (!this.installedFlag) throw new ComponentVerifyError('activation check failed');
    await this.cleanup().catch(() => undefined);
  }

  // ------------------------------------------------------------------ network

  /** The whole pack → `.download` (size and SHA-256 checked while streaming), then every kept file against its official hash. */
  private async fetchPack(pack: ManifestPack, signal: AbortSignal, report: (bytes: number) => void): Promise<Map<ManifestFile, Buffer>> {
    const file = await this.downloadWhole(pack, signal, report);
    return extractTarGz(file, archiveFiles(pack, this.options.platform), signal);
  }
  /** The pack's verified bytes, keyed by the replaced archive's own manifest entries (staging checks them once more). */
  private fromPack(archive: ManifestArchive, files: Map<ManifestFile, Buffer>): Map<ManifestFile, Buffer> {
    const byPath = new Map([...files].map(([file, data]) => [file.to, data] as const));
    return new Map(archiveFiles(archive, this.options.platform).map(file => {
      const data = byPath.get(file.to);
      if (!data) throw new ComponentVerifyError(`missing in pack: ${file.to}`);
      return [file, data] as const;
    }));
  }

  private async fetchArchive(archive: ManifestArchive, signal: AbortSignal, report: (bytes: number) => void): Promise<Map<ManifestFile, Buffer>> {
    const wanted = archiveFiles(archive, this.options.platform);
    if (archive.kind === 'zip' && archive.rangeEntry) {
      const ranged = await this.fetchZipEntries(archive, wanted, signal, report).catch(error => {
        if (signal.aborted || error instanceof ComponentVerifyError) throw error;
        return null; // the server did not honour ranges: fall back to the whole archive
      });
      if (ranged) return ranged;
    }
    const file = await this.downloadWhole(archive, signal, report);
    return archive.kind === 'tgz' ? extractTarGz(file, wanted, signal) : extractZipFile(file, wanted);
  }

  private async range(archive: ManifestArchive, start: number, end: number, signal: AbortSignal, report: (bytes: number) => void): Promise<Buffer> {
    const response = await this.options.fetch(archive.url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    if (response.status !== 206) { await response.body?.cancel().catch(() => undefined); throw new Error(`range not supported (${response.status})`); }
    const data = Buffer.from(await response.arrayBuffer());
    report(data.length);
    if (data.length !== end - start + 1) throw new Error('short range response');
    return data;
  }

  private async fetchZipEntries(archive: ManifestArchive, wanted: readonly ManifestFile[], signal: AbortSignal, report: (bytes: number) => void) {
    const tailStart = Math.max(0, archive.size - 65_557);
    const tail = await this.range(archive, tailStart, archive.size - 1, signal, report);
    const dir = findZipDirectory(tail, archive.size);
    const directory = dir.offset >= tailStart
      ? tail.subarray(dir.offset - tailStart, dir.offset - tailStart + dir.size)
      : await this.range(archive, dir.offset, dir.offset + dir.size - 1, signal, report);
    const entries = parseZipEntries(directory);
    const found = new Map<ManifestFile, Buffer>();
    for (const file of wanted) {
      const entry = pickZipEntry(entries, file);
      if (entry.compressedSize > file.size * 2 + 1024) throw new ComponentVerifyError('implausible zip entry');
      const end = Math.min(archive.size - 1, entry.localOffset + zipEntrySpan(entry) - 1);
      found.set(file, inflateZipEntry(entry, await this.range(archive, entry.localOffset, end, signal, report), file));
    }
    return found;
  }

  /** Whole archive → `.download/<id>.partial` with the size and hash checked while streaming, then renamed. */
  private async downloadWhole(archive: ManifestArchive, signal: AbortSignal, report: (bytes: number) => void): Promise<string> {
    const dir = this.downloadDir();
    await mkdir(dir, { recursive: true });
    const final = path.join(dir, `${archive.id}.${archive.kind}`), partial = `${final}.partial`;
    const response = await this.options.fetch(archive.url, { signal });
    if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error(`download failed (${response.status})`); }
    const hash = createHash(archive.sha256 ? 'sha256' : 'sha512');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > archive.size) { callback(new ComponentVerifyError(`archive larger than expected: ${archive.id}`)); return; }
        hash.update(chunk); report(chunk.length); callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), meter, createWriteStream(partial), { signal });
      if (size !== archive.size || !archiveHashMatches(archive, hash.digest())) throw new ComponentVerifyError(`archive hash mismatch: ${archive.id}`);
      await rename(partial, final);
      return final;
    } catch (error) { await rm(partial, { force: true }).catch(() => undefined); throw error; }
  }

  // ------------------------------------------------------------------ offline import

  /**
   * Files the user picked (archives as downloaded from the same URLs, or the bare model files). Each one is
   * recognised only by size + hash against the built-in manifest; anything else is rejected and left untouched.
   */
  importFiles(paths: readonly string[], onProgress: (progress: ComponentProgress) => void = () => {}): Promise<ImportResult> {
    return this.exclusive(async () => {
      let accepted = 0, rejected = 0;
      await mkdir(path.join(this.stagingDir(), '.done'), { recursive: true });
      const archives = neededArchives(this.manifest, this.options.platform);
      const loose = new Map<string, Buffer>(); // by SHA-256: one file can satisfy identical entries (e.g. two version.js)
      for (const [index, candidate] of paths.slice(0, 64).entries()) {
        onProgress({ stage: 'installing', done: index, total: paths.length });
        try {
          const info = await lstat(candidate);
          if (!info.isFile() || info.size > (this.options.maxImportBytes ?? MAX_IMPORT_BYTES)) { rejected++; continue; }
          const { sha256Hex, sha512 } = await hashFile(candidate);
          const pack = this.manifest.packs?.[this.options.platform];
          if (pack && pack.size === info.size && pack.sha256 === sha256Hex) { // the Release pack, downloaded by hand
            const files = await extractTarGz(candidate, archiveFiles(pack, this.options.platform));
            for (const archive of archives.filter(a => pack.replaces.includes(a.id))) await this.stage(archive, this.fromPack(archive, files));
            accepted++; continue;
          }
          const archive = archives.find(a => a.size === info.size && archiveHashMatches(a, a.sha256 ? Buffer.from(sha256Hex, 'hex') : sha512));
          if (archive) {
            const wanted = archiveFiles(archive, this.options.platform);
            if (archive.kind === 'file') await this.stageCopies(archive, new Map([[wanted[0]!, candidate]]));
            else await this.stage(archive, archive.kind === 'tgz' ? await extractTarGz(candidate, wanted) : await extractZipFile(candidate, wanted));
            accepted++; continue;
          }
          if (!this.files().some(f => f.size === info.size && f.sha256 === sha256Hex)) { rejected++; continue; }
          loose.set(sha256Hex, await readFile(candidate));
          accepted++;
        } catch { rejected++; }
      }
      for (const archive of archives) {
        const files = archiveFiles(archive, this.options.platform);
        if (await this.archiveDone(archive) || !files.every(file => loose.has(file.sha256))) continue;
        await this.stage(archive, new Map(files.map(file => [file, loose.get(file.sha256)!])));
      }
      let complete = true;
      for (const archive of archives) if (!await this.archiveDone(archive)) complete = false;
      if (complete) await this.activate();
      onProgress({ stage: 'installing', done: paths.length, total: paths.length });
      return { accepted, rejected, complete };
    });
  }
}

function archiveHashMatches(archive: ManifestArchive, digest: Buffer): boolean {
  if (archive.sha256) return digest.toString('hex') === archive.sha256;
  return !!archive.integrity && `sha512-${digest.toString('base64')}` === archive.integrity;
}

async function hashFile(file: string): Promise<{ sha256Hex: string; sha512: Buffer }> {
  const a = createHash('sha256'), b = createHash('sha512');
  for await (const chunk of createReadStream(file)) { a.update(chunk as Buffer); b.update(chunk as Buffer); }
  return { sha256Hex: a.digest('hex'), sha512: b.digest() };
}
