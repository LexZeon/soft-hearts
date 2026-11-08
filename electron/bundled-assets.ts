import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import bundledData from "../shared/bundled-assets.json";
import catalogData from "../shared/motion-catalog.json";
import type { AssetRef } from "../shared/contracts";
import type { MotionCatalog, MotionDownloadFile, MotionPack } from "../shared/motion-library";
import { AssetRegistry } from "./assets";

export interface BundledAssetManifest {
  schemaVersion: 1;
  root: string;
  defaultMotionId: string;
  model: MotionDownloadFile;
  textures: MotionDownloadFile[];
}

interface Dependencies {
  manifest?: BundledAssetManifest;
  catalog?: MotionCatalog;
}

const MAX_BUNDLED_FILE = 128 * 1024 * 1024;
const invalid = () => new Error("预装资源缺失或损坏，请重新解压完整的软件包。");

function segments(relative: string): string[] {
  if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(relative)) throw invalid();
  const result = relative.split("/");
  if (result.some((part) => part === "." || part === "..")) throw invalid();
  return result;
}

/** Check from the trusted resource root, including Electron's virtual asar directories. */
export async function bundledFilePath(directory: string, relative: string): Promise<string> {
  const base = path.resolve(directory);
  const parts = segments(relative);
  try {
    const rootInfo = await lstat(base);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw invalid();
    const canonicalRoot = await realpath(base);
    let current = base;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
        throw invalid();
    }
    const canonicalFile = await realpath(current);
    if (path.relative(path.join(canonicalRoot, ...parts), canonicalFile) !== "") throw invalid();
    return current;
  } catch {
    throw invalid();
  }
}

/** Validate immutable bundled bytes before exposing a narrow native asset grant. */
export async function verifyBundledFile(
  directory: string,
  relative: string,
  file: MotionDownloadFile,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_BUNDLED_FILE ||
    !/^[a-f0-9]{64}$/.test(file.sha256)) throw invalid();
  const target = await bundledFilePath(directory, relative);
  if ((await lstat(target)).size !== file.bytes) throw invalid();
  const bytes = await readFile(target, { signal });
  signal?.throwIfAborted();
  if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw invalid();
  if (file.relativePath.endsWith(".vmd") &&
    bytes.subarray(0, 30).toString("ascii").replace(/\0.*$/, "") !== "Vocaloid Motion Data 0002")
    throw invalid();
  if (file.relativePath.endsWith(".pmx") && bytes.subarray(0, 4).toString("ascii") !== "PMX ") throw invalid();
  return target;
}

export class BundledAssets {
  private readonly manifest: BundledAssetManifest;
  private readonly pack: MotionPack;
  readonly directory: string;

  constructor(
    directory: string,
    private readonly registry: AssetRegistry,
    dependencies: Dependencies = {},
  ) {
    this.directory = path.resolve(directory);
    this.manifest = dependencies.manifest ?? bundledData as BundledAssetManifest;
    const catalog = dependencies.catalog ?? catalogData as MotionCatalog;
    const pack = catalog.packs.find((entry) => entry.id === "gene");
    if (!pack || this.manifest.schemaVersion !== 1 ||
      !/^[a-f0-9]{40}$/.test(pack.revision) ||
      this.manifest.root !== `mmdagent-ex/gene/${pack.revision}` ||
      this.manifest.model.relativePath !== "model/gene.pmx" ||
      this.manifest.model.originalPath !== "Gene.pmx" ||
      !pack.motions.some((motion) => motion.id === this.manifest.defaultMotionId) ||
      !this.manifest.textures.length || this.manifest.textures.length > 64)
      throw invalid();
    this.pack = pack;
    const raw = `https://raw.githubusercontent.com/mmdagent-ex/gene/${pack.revision}/`;
    const paths = new Set<string>();
    let size = 0;
    for (const file of [this.manifest.model, ...this.manifest.textures]) {
      segments(file.relativePath);
      segments(file.originalPath);
      if (file.downloadUrl !== raw + file.originalPath || paths.has(file.relativePath) ||
        (file !== this.manifest.model &&
          (!/^tex\/[a-zA-Z0-9._-]+\.(png|jpg|jpeg|bmp|tga|sph|spa)$/i.test(file.originalPath) ||
            file.relativePath !== `model/${file.originalPath}`))) throw invalid();
      paths.add(file.relativePath);
      size += file.bytes;
    }
    if (!Number.isSafeInteger(size) || size > MAX_BUNDLED_FILE) throw invalid();
  }

  async getModel(): Promise<AssetRef> {
    const root = this.manifest.root;
    let model = "";
    for (const file of [this.manifest.model, ...this.manifest.textures, ...this.pack.documents]) {
      const target = await verifyBundledFile(this.directory, `${root}/${file.relativePath}`, file);
      if (file === this.manifest.model) model = target;
    }
    // Register only the model folder: metadata and other packages remain outside its grant.
    return this.registry.register(model);
  }

  async getDefaultAssets(): Promise<{ model: AssetRef; motion: AssetRef }> {
    const model = await this.getModel();
    const motion = this.pack.motions.find((entry) => entry.id === this.manifest.defaultMotionId)!;
    const target = await verifyBundledFile(this.directory, `${this.manifest.root}/${motion.relativePath}`, motion);
    return { model, motion: await this.registry.register(target) };
  }
}
