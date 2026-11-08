import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import catalogData from "../shared/motion-catalog.json";
import type {
  CatalogMotion,
  MotionCatalog,
  MotionDownloadFile,
  MotionDownloadProgress,
  MotionLibraryStatus,
  MotionPack,
} from "../shared/motion-library";
import { verifyBundledFile } from "./bundled-assets";
import { queryReviewedGeneCatalog } from './motion-tag-consumer';
import { parseMotionTagPreferences } from '../shared/r32/motion-tag-contracts';
import type { HostMotionTagSnapshot } from '../shared/r32/host-motion-tag-query';
import type { MotionWeightAsset } from '../shared/motion-weights';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/legalcode.txt";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const isMotion = (file: MotionDownloadFile): file is CatalogMotion => "id" in file;
const additionalSources: Partial<Record<MotionPack["id"], readonly [string, string]>> = {
  "100style-idles": ["100style", "https://www.ianxmason.com/100style/"],
  "mpi-embm-gestures": ["mpi-embm", "https://figshare.com/articles/dataset/MPI_EMBM_Database_Mocap_Files/1220428"],
  "genea-2022-gestures": ["genea-2022", "https://zenodo.org/records/6977157"],
  "fnoji-dances": ["fnoji", "https://booth.pm/ja/items/8103074"],
  "soft-hearts-actions": ["soft-hearts-next", "https://github.com/LexZeon/soft-hearts-next"],
};
/** Packs made for this project (T-211: Codex's original VMDs): the repository's own licence and a provenance note, no upstream notice. */
const projectOwned: ReadonlySet<MotionPack["id"]> = new Set(["soft-hearts-actions"]);
const bundleRelative = (pack: MotionPack, relative: string) => `${pack.source}/${pack.id}/${pack.revision}/${relative}`;

interface Dependencies {
  fetch?: typeof fetch;
  catalog?: MotionCatalog;
  bundledDirectory?: string;
  /** Host-only current context, never a renderer-supplied admission object. */
  readMotionTagSnapshot?: () => HostMotionTagSnapshot | null;
}

/** Downloads only reviewed, pinned motion files. It never runs upstream scripts. */
export class MotionLibrary {
  private readonly catalog: MotionCatalog;
  private readonly fetcher: typeof fetch;
  private task: AbortController | null = null;
  private readonly bundledDirectory?: string;
  private readonly readMotionTagSnapshot: () => HostMotionTagSnapshot | null;
  readonly directory: string;

  constructor(directory: string, dependencies: Dependencies = {}) {
    this.directory = path.resolve(directory);
    this.catalog = dependencies.catalog ?? (catalogData as MotionCatalog);
    this.fetcher = dependencies.fetch ?? fetch;
    this.bundledDirectory = dependencies.bundledDirectory && path.resolve(dependencies.bundledDirectory);
    this.readMotionTagSnapshot = dependencies.readMotionTagSnapshot ?? (() => null);
    this.validateCatalog();
  }

  cancel(): void {
    this.task?.abort(new Error("动作下载已取消。"));
  }

  async getStatus(preferences?: unknown): Promise<MotionLibraryStatus> {
    const soft = preferences === undefined ? undefined : parseMotionTagPreferences(preferences);
    const packs: MotionLibraryStatus["packs"] = [];
    for (const pack of this.catalog.packs) {
      if (this.bundledDirectory) {
        await this.verifyBundle(pack);
        packs.push({ id: pack.id, installedMotionIds: pack.motions.map((motion) => motion.id), complete: true, bundled: true });
        continue;
      }
      if (pack.bundledOnly) {
        packs.push({ id: pack.id, installedMotionIds: [], complete: false });
        continue;
      }
      const installedMotionIds: string[] = [];
      let complete = true;
      for (const file of [...pack.motions, ...pack.documents]) {
        const valid = await this.validFile(pack, file);
        if (isMotion(file) && valid) installedMotionIds.push(file.id);
        if (!valid) complete = false;
      }
      if (complete) {
        try {
          const marker = await this.readMetadata(pack, "source.json");
          const source = JSON.parse(marker.toString("utf8"));
          complete = source?.revision === pack.revision && source?.packId === pack.id &&
            (await this.readMetadata(pack, "attribution.txt")).toString("utf8") === this.attribution(pack);
        } catch (error) {
          if (!missing(error) && !(error instanceof SyntaxError)) throw error;
          complete = false;
        }
      }
      packs.push({ id: pack.id, installedMotionIds, complete });
    }
    const status = { directory: this.bundledDirectory ?? this.directory, packs };
    return soft === undefined ? status : { ...status,
      tagQuery: queryReviewedGeneCatalog(this.catalog, status, this.readMotionTagSnapshot, soft) };
  }

  /** Stable metadata for installed catalog assets; this grants no resource or playback. */
  async taggableAssets(packId: unknown): Promise<MotionWeightAsset[]> {
    const pack = this.catalog.packs.find(row => row.id === packId);
    if (!pack) throw Error('动作包编号不正确。');
    const status = await this.getStatus();
    const installed = status.packs.find(row => row.id === pack.id);
    return pack.motions.filter(motion => installed?.installedMotionIds.includes(motion.id)).map(motion => ({
      packId: pack.id, motionId: motion.id,
      assetKey: `${pack.source}/${pack.id}@${pack.revision}/${motion.id}`, sha256: motion.sha256,
    }));
  }

  /** Resolve a reviewed local clip for temporary playback without installing or cancelling anything. */
  async resolvePreview(packId: unknown, motionId: unknown): Promise<string> {
    const pack = this.catalog.packs.find((entry) => entry.id === packId);
    const motion = pack?.motions.find((entry) => entry.id === motionId);
    if (!pack || !motion) throw new Error("动作包或动作编号不正确。");
    if (!this.bundledDirectory) throw new Error("预览需要完整的预装动作资源，不会自动下载。");
    for (const document of pack.documents)
      await verifyBundledFile(this.bundledDirectory, bundleRelative(pack, document.relativePath), document);
    return verifyBundledFile(this.bundledDirectory, bundleRelative(pack, motion.relativePath), motion);
  }

  async install(
    packId: unknown,
    motionId: unknown,
    onProgress?: (progress: MotionDownloadProgress) => void,
  ): Promise<string> {
    const pack = this.catalog.packs.find((entry) => entry.id === packId);
    const motion = pack?.motions.find((entry) => entry.id === motionId);
    if (!pack || !motion) throw new Error("动作包或动作编号不正确。");
    if (this.task) throw new Error("另一个动作包仍在下载，请等待或取消。");
    const controller = new AbortController();
    this.task = controller;
    try {
      if (this.bundledDirectory) {
        await this.verifyBundle(pack, controller.signal, onProgress);
        return path.join(this.bundledDirectory, pack.source, pack.id, pack.revision, ...motion.relativePath.split("/"));
      }
      if (pack.bundledOnly) throw new Error("此动作仅随完整软件包预装，请重新解压资源后启用。");
      const files = [...pack.documents, ...pack.motions];
      let completed = 0;
      let downloaded = false;
      for (const file of files) {
        controller.signal.throwIfAborted();
        if (!(await this.validFile(pack, file))) {
          const bytes = await this.download(file, controller.signal);
          controller.signal.throwIfAborted();
          this.verifyBytes(file, bytes);
          await this.atomicWrite(pack, file.relativePath, bytes, controller.signal);
          downloaded = true;
        }
        controller.signal.throwIfAborted();
        completed++;
        onProgress?.({ packId: pack.id, completed, total: files.length, fileName: file.relativePath });
      }
      let downloadedAt = new Date().toISOString();
      if (!downloaded) {
        try {
          const previous = JSON.parse((await this.readMetadata(pack, "source.json")).toString("utf8"));
          if (previous?.revision === pack.revision && typeof previous?.downloadedAt === "string" &&
            Number.isFinite(Date.parse(previous.downloadedAt))) downloadedAt = previous.downloadedAt;
        } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error; }
      }
      await this.atomicWrite(pack, "metadata/attribution.txt", this.attribution(pack), controller.signal);
      // Written last: an interrupted download cannot become a complete installation.
      await this.atomicWrite(pack, "metadata/source.json", JSON.stringify({
        schemaVersion: 1,
        packId: pack.id,
        source: pack.source,
        sourceUrl: pack.sourceUrl,
        revision: pack.revision,
        downloadedAt,
        license: pack.license,
        modifications: "File names and folders normalized to English; VMD file contents unchanged.",
        compatibleModel: pack.id,
        compatibilityNote: "Morph and bone names are model-specific; other MMD models may need adaptation.",
        motions: pack.motions,
        documents: pack.documents,
      }, null, 2) + "\n", controller.signal);
      controller.signal.throwIfAborted();
      return this.filePath(pack, motion.relativePath);
    } finally {
      if (this.task === controller) this.task = null;
    }
  }

  private async verifyBundle(
    pack: MotionPack,
    signal?: AbortSignal,
    onProgress?: (progress: MotionDownloadProgress) => void,
  ): Promise<void> {
    const files = [...pack.documents, ...pack.motions];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      await verifyBundledFile(this.bundledDirectory!, bundleRelative(pack, file.relativePath), file, signal);
      signal?.throwIfAborted();
      onProgress?.({ packId: pack.id, completed: index + 1, total: files.length, fileName: file.relativePath });
    }
  }

  private validateCatalog(): void {
    if (this.catalog.schemaVersion !== 1 || !this.catalog.packs.length || this.catalog.packs.length > 6)
      throw new Error("动作目录版本不正确。");
    const packIds = new Set<string>();
    for (const pack of this.catalog.packs) {
      if (pack.id !== "gene") {
        this.validateAdditionalPack(pack, packIds);
        continue;
      }
      if (pack.id !== "gene" || packIds.has(pack.id) ||
        pack.source !== "mmdagent-ex" || !/^[a-f0-9]{40}$/.test(pack.revision) ||
        pack.sourceUrl !== `https://github.com/mmdagent-ex/${pack.id}` ||
        pack.license.id !== "CC-BY-4.0" ||
        pack.license.url !== "https://creativecommons.org/licenses/by/4.0/" ||
        !pack.license.attribution || !pack.motions.length || !pack.documents.length)
        throw new Error("动作目录来源不正确。");
      packIds.add(pack.id);
      const paths = new Set<string>();
      const ids = new Set<string>();
      let bytes = 0;
      for (const file of [...pack.motions, ...pack.documents]) {
        this.validateRelative(file.relativePath);
        if (paths.has(file.relativePath) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
          !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE_BYTES)
          throw new Error("动作目录文件不正确。");
        paths.add(file.relativePath);
        bytes += file.bytes;
        const url = new URL(file.downloadUrl);
        if (url.search || url.hash || url.username || url.password || url.port || url.protocol !== "https:")
          throw new Error("动作下载地址不正确。");
        const upstream = `https://raw.githubusercontent.com/mmdagent-ex/${pack.id}/${pack.revision}/`;
        if (isMotion(file)) {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(file.id) || ids.has(file.id) ||
            !["pose", "expression", "reaction"].includes(file.category) ||
            file.relativePath !== `motions/${file.category}/${file.id}.vmd` ||
            !/^motion\/[a-zA-Z0-9_-]+\.vmd$/.test(file.originalPath) ||
            file.downloadUrl !== upstream + file.originalPath)
            throw new Error("动作目录名称或地址不正确。");
          ids.add(file.id);
        } else {
          const readme = file.relativePath === "metadata/upstream-readme.md" &&
            file.originalPath === "README.md" && file.downloadUrl === upstream + "README.md";
          const license = file.relativePath === "metadata/cc-by-4.0.txt" && file.downloadUrl === LICENSE_URL;
          if (!readme && !license) throw new Error("动作授权文档地址不正确。");
        }
      }
      if (bytes > MAX_PACK_BYTES || !paths.has("metadata/upstream-readme.md") || !paths.has("metadata/cc-by-4.0.txt"))
        throw new Error("动作包大小或授权文档不正确。");
    }
  }

  private validateAdditionalPack(pack: MotionPack, packIds: Set<string>): void {
    const source = additionalSources[pack.id];
    const owned = projectOwned.has(pack.id);
    const licensed = owned ? pack.license.id === "MIT" && pack.license.url === "https://github.com/LexZeon/soft-hearts-next/blob/main/LICENSE"
      : pack.license.id === "CC-BY-4.0" && pack.license.url === "https://creativecommons.org/licenses/by/4.0/";
    if (!source || packIds.has(pack.id) || pack.source !== source[0] || pack.sourceUrl !== source[1] ||
      pack.bundledOnly !== true || !/^[a-f0-9]{40}$/.test(pack.revision) || !licensed ||
      !pack.license.attribution?.trim() || !pack.modifications?.trim() || !pack.compatibilityNote?.trim() || !pack.motions.length)
      throw new Error("附加动作来源或授权不正确。");
    packIds.add(pack.id);
    const paths = new Set<string>();
    const ids = new Set<string>();
    let total = 0;
    for (const file of [...pack.motions, ...pack.documents]) {
      this.validateRelative(file.relativePath);
      if (paths.has(file.relativePath) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE_BYTES)
        throw new Error("附加动作文件不正确。");
      const url = new URL(file.downloadUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port)
        throw new Error("附加动作来源地址不正确。");
      paths.add(file.relativePath);
      total += file.bytes;
      if (isMotion(file)) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(file.id) || ids.has(file.id) ||
          !["idle", "gesture", "dance"].includes(file.category) ||
          file.relativePath !== `motions/${file.category}/${file.id}.vmd` ||
          !file.originalPath || /(^|[\\/])(FNA|UNA)([\\/._-]|$)/i.test(file.originalPath))
          throw new Error("附加动作名称或许可筛选不正确。");
        ids.add(file.id);
      } else if (!/^metadata\/[a-z0-9.-]+\.(txt|md|json)$/.test(file.relativePath)) {
        throw new Error("附加动作署名路径不正确。");
      }
    }
    if (total > MAX_PACK_BYTES || !paths.has("metadata/source.json") || (owned ? !paths.has("metadata/provenance.md")
      : !paths.has("metadata/attribution.txt") || !paths.has("metadata/cc-by-4.0.txt")))
      throw new Error("附加动作大小或署名文件不正确。");
  }

  private validateRelative(relative: string): void {
    if (!/^[a-z0-9-]+(?:\/[a-z0-9.-]+)+$/.test(relative) ||
      relative.split("/").some((part) => part === "." || part === ".."))
      throw new Error("动作文件路径不正确。");
  }

  private filePath(pack: MotionPack, relative: string): string {
    this.validateRelative(relative);
    return path.join(this.directory, "mmdagent-ex", pack.id, pack.revision, ...relative.split("/"));
  }

  /** Reject symlinks/junctions before creating or accessing any cache descendant. */
  private async safeDirectory(directory: string, create: boolean): Promise<boolean> {
    const absolute = path.resolve(directory);
    const relative = path.relative(this.directory, absolute);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("动作缓存目录超出资源库。");
    const root = path.parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) {
        try { await mkdir(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      let info;
      try { info = await lstat(current); }
      catch (error) { if (missing(error) && !create) return false; throw error; }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("动作缓存目录不能使用符号链接或联接。");
    }
    // Windows MSIX may virtualize AppData without exposing a symlink to lstat.
    // Anchor descendants to the trusted library root's canonical location, while
    // the checks above still reject every explicit symlink/junction component.
    const canonicalRoot = await realpath(this.directory);
    const resolved = await realpath(absolute);
    if (path.relative(path.join(canonicalRoot, relative), resolved) !== "")
      throw new Error("动作缓存目录解析到其他位置。");
    return true;
  }

  private async validFile(pack: MotionPack, file: MotionDownloadFile): Promise<boolean> {
    const target = this.filePath(pack, file.relativePath);
    if (!(await this.safeDirectory(path.dirname(target), false))) return false;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("动作缓存文件不能使用符号链接。");
      if (!info.isFile() || info.size !== file.bytes) return false;
      this.verifyBytes(file, await readFile(target));
      return true;
    } catch (error) {
      if (missing(error) || (error instanceof Error && error.message === "动作文件校验失败。")) return false;
      throw error;
    }
  }

  private verifyBytes(file: MotionDownloadFile, bytes: Uint8Array): void {
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256 ||
      (file.relativePath.endsWith(".vmd") && Buffer.from(bytes.subarray(0, 30)).toString("ascii").replace(/\0.*$/, "") !== "Vocaloid Motion Data 0002"))
      throw new Error("动作文件校验失败。");
  }

  private async readMetadata(pack: MotionPack, name: string): Promise<Buffer> {
    const target = this.filePath(pack, `metadata/${name}`);
    if (!(await this.safeDirectory(path.dirname(target), false))) {
      const error = new Error("Metadata absent") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES)
      throw new Error("动作来源记录不正确。");
    return readFile(target);
  }

  private async atomicWrite(pack: MotionPack, relative: string, bytes: Uint8Array | string, signal: AbortSignal): Promise<void> {
    const target = this.filePath(pack, relative);
    await this.safeDirectory(path.dirname(target), true);
    signal.throwIfAborted();
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("动作缓存文件不正确。");
    } catch (error) { if (!missing(error)) throw error; }
    const temporary = `${target}.${randomBytes(8).toString("hex")}.partial`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      signal.throwIfAborted();
      await this.safeDirectory(path.dirname(target), false);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async download(file: MotionDownloadFile, signal: AbortSignal): Promise<Uint8Array> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const response = await this.fetcher(file.downloadUrl, { signal: combined, redirect: "error", credentials: "omit" });
    combined.throwIfAborted();
    if (!response.ok || response.redirected || (response.url && response.url !== file.downloadUrl))
      throw new Error(`动作下载失败（HTTP ${response.status}）。`);
    const length = response.headers.get("content-length");
    // Fetch transparently decompresses gzip/br bodies while retaining the encoded
    // Content-Length header. The catalog hashes and counts the decoded bytes.
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if ((length !== null && (!encoding || encoding === "identity") && Number(length) !== file.bytes) || !response.body) {
      await response.body?.cancel();
      throw new Error("动作下载大小不正确。");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        combined.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > file.bytes || size > MAX_FILE_BYTES) throw new Error("动作下载超过大小限制。");
        chunks.push(value);
      }
      combined.throwIfAborted();
      return Buffer.concat(chunks, size);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private attribution(pack: MotionPack): string {
    return `${pack.license.attribution}\n\nLicense: ${pack.license.id}\n${pack.license.url}\nSource: ${pack.sourceUrl}\nRevision: ${pack.revision}\n\nChanges: file names and folders normalized to English; VMD contents unchanged.\nKeep this attribution, the license and upstream-readme.md when sharing.\nThe upstream README includes the authors' usage guidelines.\n${pack.id === "gene" ? "Gene model trademark and design rights are reserved; other commercial uses of that model require contacting the author. This package contains motions, not the model.\n" : ""}Motion bone and morph names target the original model; other MMD models may require adaptation.\n`;
  }
}
