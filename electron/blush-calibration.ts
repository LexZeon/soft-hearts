import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BLUSH_CALIBRATION, validateBlushCalibration,
  type BlushCalibration, type BlushCalibrationView,
} from '../shared/blush';

export const MAX_BLUSH_CALIBRATIONS = 64;
const MAX_FILE_BYTES = 128_000;
interface StoredProfile { modelKey: string; calibration: BlushCalibration }
interface StoredCalibrations { version: 1; revision?: number; profiles: StoredProfile[] }
interface CachedIdentity { signature: string; modelKey: string }
class ModelChanged extends Error {}
class AppArchiveChanged extends Error {
  constructor() { super('应用资源已变化，请重启 soft hearts 后重新读取红晕校准。'); }
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function modelKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('脸红校准需要当前模型的内容身份，不能提交路径或网址。');
  return value;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown calibration field');
}
const modelStat = (file: string) => stat(file, { bigint: true });
const signature = (info: BigIntStats) => `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.dev}`;
interface ModelSnapshot { signature: string; size: bigint; expectedKey?: string }
interface ModelFiles {
  realpath(file: string): Promise<string>;
  stat(file: string): Promise<BigIntStats>;
  read(file: string): AsyncIterable<Uint8Array>;
}
const modelFiles: ModelFiles = { realpath, stat: modelStat, read: file => createReadStream(file) };
interface PhysicalArchiveFiles {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<BigIntStats>;
}
export interface TrustedPackedModel {
  readonly canonicalPath: string;
  readonly bytes: bigint;
  readonly expectedKey: string;
  archiveSignature(): Promise<string>;
}
interface StoreOptions {
  /** Host-created capability for the exact reviewed packed model, never renderer input. */
  packedModel?: TrustedPackedModel;
  /** Narrow filesystem seam for pure tests; production uses the ordinary Node APIs. */
  modelFiles?: ModelFiles;
}

/**
 * The host supplies original-fs here, after identifying its own packaged app archive.
 * A filename ending in .asar alone never grants a model the packed-file policy.
 */
export async function createTrustedPackedModel(
  archivePath: string, relativeEntry: string, expected: { bytes: number; sha256: string }, physical: PhysicalArchiveFiles,
): Promise<TrustedPackedModel> {
  if (!path.isAbsolute(archivePath) || path.extname(archivePath).toLowerCase() !== '.asar'
    || !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(relativeEntry)
    || relativeEntry.split('/').some(part => part === '.' || part === '..')
    || !['.pmx', '.pmd'].includes(path.extname(relativeEntry).toLowerCase())
    || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1) throw new Error('Invalid trusted packed model');
  const expectedKey = modelKey(expected.sha256);
  const archive = await physical.realpath(archivePath);
  const before = await physical.lstat(archive);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The app archive must be a physical regular file');
  const baseline = signature(before);
  const canonicalPath = path.join(archive, ...relativeEntry.split('/'));
  const unpackedPath = path.join(`${archive}.unpacked`, ...relativeEntry.split('/'));
  let invalidated = false;
  const archiveSignature = async () => {
    if (invalidated) throw new AppArchiveChanged();
    try {
      const current = await physical.lstat(archive);
      if (!current.isFile() || current.isSymbolicLink() || signature(current) !== baseline) throw new AppArchiveChanged();
      // Unpacked entries can change without changing the archive. They are never
      // covered by this capability, including an unpacked file appearing later.
      try { await physical.lstat(unpackedPath); throw new AppArchiveChanged(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
      return baseline;
    } catch { invalidated = true; throw new AppArchiveChanged(); }
  };
  await archiveSignature();
  return Object.freeze({ canonicalPath, bytes: BigInt(expected.bytes), expectedKey, archiveSignature });
}

/**
 * Host-only local model adaptation. Paths are accepted only by keyForModel(),
 * which the host must call with its already approved PMX/PMD reference. The
 * stored document contains content hashes and five positioning numbers only.
 */
export class BlushCalibrationStore {
  private readonly file: string;
  private readonly profiles = new Map<string, BlushCalibration>();
  private readonly identityCache = new Map<string, CachedIdentity>();
  private readonly pendingHashes = new Map<string, Promise<string>>();
  private revision = 0;
  private loaded = false;
  private readBlocked = false;
  private storageError = '';
  private queue: Promise<unknown> = Promise.resolve();
  private readonly modelFiles: ModelFiles;

  constructor(private readonly directory: string, private readonly options: StoreOptions = {}) {
    this.file = path.join(directory, 'blush-calibrations.json');
    this.modelFiles = options.modelFiles ?? modelFiles;
  }

  load(): Promise<void> {
    return this.serialize(async () => {
      let raw: unknown;
      try {
        await mkdir(this.directory, { recursive: true });
        const info = await stat(this.file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Invalid calibration file');
        raw = JSON.parse(await readFile(this.file, 'utf8'));
      } catch (error) {
        this.loaded = true;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.profiles.clear(); this.revision = 0; this.readBlocked = false; this.storageError = '';
        } else this.blockRead();
        return;
      }
      try {
        if (!isObject(raw)) throw new Error('Invalid calibration data');
        onlyKeys(raw, ['version', 'revision', 'profiles']);
        if (raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > MAX_BLUSH_CALIBRATIONS
          || (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0))) throw new Error('Invalid calibration version');
        const next = new Map<string, BlushCalibration>();
        for (const row of raw.profiles) {
          if (!isObject(row)) throw new Error('Invalid calibration profile');
          onlyKeys(row, ['modelKey', 'calibration']);
          const key = modelKey(row.modelKey);
          if (next.has(key)) throw new Error('Duplicate calibration identity');
          next.set(key, validateBlushCalibration(row.calibration));
        }
        this.profiles.clear();
        for (const [key, calibration] of next) this.profiles.set(key, calibration);
        this.revision = (raw.revision as number | undefined) ?? 0;
        this.loaded = true; this.readBlocked = false; this.storageError = '';
      } catch { this.loaded = true; this.blockRead(); }
    });
  }

  /** No model contents or paths are copied or persisted. Cache is keyed by local stat identity. */
  async keyForModel(approvedModelPath: string): Promise<string> {
    if (typeof approvedModelPath !== 'string' || !path.isAbsolute(approvedModelPath) || approvedModelPath.length > 32768
      || approvedModelPath.includes('\0') || !['.pmx', '.pmd'].includes(path.extname(approvedModelPath).toLowerCase()))
      throw new Error('请使用主进程已授权的本地 PMX/PMD 模型。');
    let canonical: string;
    try { canonical = await this.modelFiles.realpath(approvedModelPath); }
    catch { throw new Error('当前模型无法读取，不能确定脸红校准身份。'); }
    for (let attempt = 0; attempt < 2; attempt++) {
      let before: ModelSnapshot;
      try { before = await this.snapshot(canonical); }
      catch (error) {
        if (error instanceof AppArchiveChanged) { this.identityCache.delete(canonical); throw error; }
        throw new Error('当前模型无法读取，不能确定脸红校准身份。');
      }
      const stamp = before.signature;
      const cached = this.identityCache.get(canonical);
      if (cached?.signature === stamp) {
        this.identityCache.delete(canonical); this.identityCache.set(canonical, cached);
        return cached.modelKey;
      }
      const request = `${canonical}\0${stamp}`;
      let pending = this.pendingHashes.get(request);
      if (!pending) {
        pending = this.hashModel(canonical, before);
        this.pendingHashes.set(request, pending);
      }
      try {
        const key = await pending;
        this.identityCache.delete(canonical); this.identityCache.set(canonical, { signature: stamp, modelKey: key });
        while (this.identityCache.size > MAX_BLUSH_CALIBRATIONS) this.identityCache.delete(this.identityCache.keys().next().value!);
        return key;
      } catch (error) {
        if (error instanceof AppArchiveChanged) { this.identityCache.delete(canonical); throw error; }
        if (!(error instanceof ModelChanged)) throw new Error('当前模型无法读取，不能确定脸红校准身份。');
      } finally { if (this.pendingHashes.get(request) === pending) this.pendingHashes.delete(request); }
    }
    throw new Error('模型文件正在变化，请等保存完成后重新读取校准。');
  }

  get(key: string | null): BlushCalibrationView {
    this.ready();
    if (key !== null) modelKey(key);
    return {
      modelKey: key,
      calibration: { ...(key === null ? DEFAULT_BLUSH_CALIBRATION : this.profiles.get(key) ?? DEFAULT_BLUSH_CALIBRATION) },
      revision: this.revision,
      ...(this.storageError ? { storageError: this.storageError } : {}),
    };
  }

  set(key: string, value: unknown): Promise<BlushCalibrationView> {
    const validatedKey = modelKey(key), calibration = validateBlushCalibration(value);
    return this.serialize(async () => {
      this.ready();
      if (this.readBlocked) throw new Error(this.storageError);
      if (!this.profiles.has(validatedKey) && this.profiles.size >= MAX_BLUSH_CALIBRATIONS) throw new Error(`本机脸红校准最多保存 ${MAX_BLUSH_CALIBRATIONS} 个模型。`);
      if (JSON.stringify(this.profiles.get(validatedKey)) === JSON.stringify(calibration)) return this.get(validatedKey);
      if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error('脸红校准修订号已达到上限，无法继续保存。');
      const next = new Map(this.profiles); next.set(validatedKey, calibration);
      const revision = this.revision + 1;
      const stored: StoredCalibrations = { version: 1, revision, profiles: [...next].map(([modelKey, calibration]) => ({ modelKey, calibration })) };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true });
        await writeFile(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        this.storageError = '脸红校准保存失败，原文件和上次生效值保持不变。请检查本机数据目录后重试。';
        throw new Error(this.storageError);
      }
      this.profiles.clear(); for (const [modelKey, saved] of next) this.profiles.set(modelKey, saved);
      this.revision = revision; this.storageError = '';
      return this.get(validatedKey);
    });
  }

  async flush(): Promise<void> { await this.queue; }
  private ready(): void { if (!this.loaded) throw new Error('脸红校准尚未载入。'); }
  private blockRead(): void {
    this.readBlocked = true;
    this.storageError = '脸红校准文件无法读取，现有文件未改动；为保留原内容，本次禁止保存。修复 blush-calibrations.json 并重新载入后再试。';
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
  private async snapshot(canonical: string): Promise<ModelSnapshot> {
    const packed = this.options.packedModel;
    const trusted = packed && path.relative(packed.canonicalPath, canonical) === '' ? packed : undefined;
    const archive = trusted ? await trusted.archiveSignature() : null;
    const info = await this.modelFiles.stat(canonical);
    if (!info.isFile()) throw new Error('当前模型不是普通文件。');
    if (trusted) {
      if (info.size !== trusted.bytes) throw new Error('Bundled model size mismatch');
      return { signature: `packed:${archive}:file:${info.size}`, size: info.size, expectedKey: trusted.expectedKey };
    }
    return { signature: `file:${signature(info)}`, size: info.size };
  }
  private async hashModel(canonical: string, expected: ModelSnapshot): Promise<string> {
    const hash = createHash('sha256');
    let bytes = 0n;
    for await (const chunk of this.modelFiles.read(canonical)) { hash.update(chunk); bytes += BigInt(chunk.byteLength); }
    if ((await this.snapshot(canonical)).signature !== expected.signature || bytes !== expected.size) throw new ModelChanged();
    const key = hash.digest('hex');
    if (expected.expectedKey && key !== expected.expectedKey) throw new Error('Bundled model hash mismatch');
    return key;
  }
}
