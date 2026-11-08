/** Prepare the reviewed Gene model, referenced textures and motions for offline distribution. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";

if (process.argv.length > 2) throw new Error("No options are supported. Review a new source revision before changing this script.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revision = "c7eace43dffaccff6ad0597433ef85fa57c91e03";
const relativeRoot = `mmdagent-ex/gene/${revision}`;
const bundleRoot = path.join(root, "assets", "bundled", ...relativeRoot.split("/"));
const sourceUrl = "https://github.com/mmdagent-ex/gene";
const rawBase = `https://raw.githubusercontent.com/mmdagent-ex/gene/${revision}/`;
const modelCache = path.join(root, ".local", "motion-validation-models", "gene", revision);
const motionCache = path.join(root, ".local", "motion-library", "mmdagent-ex", "gene", revision);
const catalogPath = path.join(root, "shared", "motion-catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const pack = catalog.packs.find(entry => entry.id === "gene");
if (catalog.schemaVersion !== 1 || !pack || pack.revision !== revision || pack.motions.length !== 40)
  throw new Error("The reviewed Gene motion catalogue does not match this bundle revision.");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function target(relative) {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9.-]+)+$/.test(relative) || relative.split("/").some(part => part === "." || part === ".."))
    throw new Error(`Unreviewed bundle filename: ${relative}`);
  return path.join(bundleRoot, ...relative.split("/"));
}
async function save(relative, bytes) {
  const file = target(relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
async function download(url, maxBytes) {
  const address = new URL(url);
  const approved = address.protocol === "https:" && !address.username && !address.password && !address.hash &&
    (["api.github.com", "raw.githubusercontent.com", "creativecommons.org"].includes(address.hostname));
  if (!approved) throw new Error(`Unapproved download source: ${url}`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "soft-hearts-bundled-assets" },
        redirect: "error", signal: AbortSignal.timeout(60_000), credentials: "omit",
      });
      if (!response.ok || response.redirected) throw new Error(`HTTP ${response.status}: ${url}`);
      if (!response.body) throw new Error(`Empty response: ${url}`);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error(`Download exceeds the reviewed limit: ${url}`);
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

const tree = JSON.parse((await download(`https://api.github.com/repos/mmdagent-ex/gene/git/trees/${revision}?recursive=1`, 2 * 1024 * 1024)).toString("utf8"));
if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("The upstream Git tree is incomplete.");
const upstreamFiles = new Map(tree.tree.filter(file => file.type === "blob").map(file => [file.path, file]));
let reusedFiles = 0;
let downloadedFiles = 0;
async function upstreamBytes(originalPath, relativePath, expected) {
  const file = upstreamFiles.get(originalPath);
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 32 * 1024 * 1024)
    throw new Error(`Unreviewed upstream file or size: ${originalPath}`);
  const candidates = [target(relativePath), path.join(modelCache, ...originalPath.split("/"))];
  if (expected) candidates.push(path.join(motionCache, ...relativePath.split("/")));
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(candidate);
      if (bytes.length === file.size && gitBlob(bytes) === file.sha && (!expected || sha256(bytes) === expected.sha256)) {
        reusedFiles++;
        return bytes;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const bytes = await download(rawBase + originalPath, Math.min(32 * 1024 * 1024, file.size));
  if (bytes.length !== file.size || gitBlob(bytes) !== file.sha || (expected && sha256(bytes) !== expected.sha256))
    throw new Error(`Upstream bytes do not match the pinned Git tree: ${originalPath}`);
  downloadedFiles++;
  return bytes;
}
function descriptor(relativePath, originalPath, bytes) {
  return { relativePath, originalPath, downloadUrl: rawBase + originalPath, sha256: sha256(bytes), bytes: bytes.length };
}

const modelBytes = await upstreamBytes("Gene.pmx", "model/gene.pmx");
if (modelBytes.toString("ascii", 0, 4) !== "PMX ") throw new Error("The pinned model is not PMX.");
const model = descriptor("model/gene.pmx", "Gene.pmx", modelBytes);
await save(model.relativePath, modelBytes);
const parsed = new MMDParser.Parser().parsePmx(toArrayBuffer(modelBytes), true);
const texturePaths = [...new Set(parsed.textures.map(value => value.replace(/\\/g, "/")))].sort();
if (texturePaths.some(value => !/^tex\/[a-z0-9._-]+\.png$/.test(value)))
  throw new Error("A texture reference needs a manual English-path review.");
const textures = [];
let originalModelBytes = modelBytes.length;
for (const originalPath of texturePaths) {
  const relativePath = `model/${originalPath}`;
  const bytes = await upstreamBytes(originalPath, relativePath);
  originalModelBytes += bytes.length;
  if (originalModelBytes > 128 * 1024 * 1024) throw new Error("The model exceeds the reviewed bundle limit.");
  textures.push(descriptor(relativePath, originalPath, bytes));
  await save(relativePath, bytes);
}

for (const motion of pack.motions) {
  const bytes = await upstreamBytes(motion.originalPath, motion.relativePath, motion);
  if (bytes.length !== motion.bytes || bytes.toString("ascii", 0, 30).replace(/\0.*$/, "") !== "Vocaloid Motion Data 0002")
    throw new Error(`Invalid motion bytes: ${motion.id}`);
  await save(motion.relativePath, bytes);
}
for (const document of pack.documents) {
  let bytes;
  for (const candidate of [target(document.relativePath), path.join(motionCache, ...document.relativePath.split("/"))]) {
    try {
      const candidateBytes = await readFile(candidate);
      if (candidateBytes.length === document.bytes && sha256(candidateBytes) === document.sha256) {
        bytes = candidateBytes;
        reusedFiles++;
        break;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!bytes) {
    bytes = await download(document.downloadUrl, document.bytes);
    downloadedFiles++;
  }
  if (bytes.length !== document.bytes || sha256(bytes) !== document.sha256)
    throw new Error(`The bundled license document changed: ${document.relativePath}`);
  await save(document.relativePath, bytes);
}

const rightsNotice = "Gene model trademark and design rights remain with the copyright holder. Academic and personal non-commercial uses are permitted as described in the upstream README; other commercial uses of the model require contacting the author.";
const modifications = "Model, referenced textures and VMD bytes are unmodified. Gene.pmx was renamed externally to model/gene.pmx; original model texture references are preserved. Motion filenames and folders were normalized to English kebab-case; descriptive categories and tags were added.";
const record = {
  schemaVersion: 1,
  packId: "gene", source: pack.source, sourceUrl, revision,
  license: pack.license, rightsNotice, modifications,
  model: { ...model, id: "gene", name: "Gene", category: "model", tags: ["mmd", "pmx", "avatar", "gene", "bundled"] },
  textures: textures.map(file => ({ ...file, category: "texture", tags: ["mmd", "texture", "gene"] })),
  motions: pack.motions,
  documents: pack.documents,
  defaultMotionId: "stand",
  upstreamGitBlobs: Object.fromEntries([model, ...textures, ...pack.motions].map(file => [file.originalPath, upstreamFiles.get(file.originalPath).sha])),
};
await save("metadata/source.json", `${JSON.stringify(record, null, 2)}\n`);
await save("metadata/attribution.txt", `${pack.license.attribution}\n\nLicense: ${pack.license.id}\n${pack.license.url}\nSource: ${sourceUrl}\nRevision: ${revision}\n\n${modifications}\n\n${rightsNotice}\n\nKeep this attribution, the license text and upstream-readme.md with redistributions. The original README includes the author's usage guidelines. The MIT license for soft hearts source code does not replace this asset license.\n`);
await writeFile(path.join(root, "shared", "bundled-assets.json"), `${JSON.stringify({
  schemaVersion: 1, root: relativeRoot, defaultMotionId: "stand", model, textures,
}, null, 2)}\n`);
await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, packs: [pack] }, null, 2)}\n`);
const files = [model, ...textures, ...pack.motions, ...pack.documents];
console.log(JSON.stringify({
  source: sourceUrl, revision, bundleDirectory: bundleRoot,
  modelFiles: 1, textures: textures.length, motions: pack.motions.length,
  sourceFiles: files.length, generatedMetadata: 2,
  sourceBytes: files.reduce((total, file) => total + file.bytes, 0),
  largestSourceFileBytes: Math.max(...files.map(file => file.bytes)),
  reusedFiles, downloadedFiles,
}, null, 2));
