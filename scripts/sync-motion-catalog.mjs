/**
 * Refresh the reviewed, pinned public motion catalogue and a private local cache.
 * No models or private user assets are downloaded. Run with --update-source to
 * review the latest upstream main commits; normal reruns retain pinned commits.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";

if (process.argv.slice(2).some(argument => argument !== "--update-source"))
  throw new Error("Unsupported option. This script downloads motions and license documents only.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "shared", "motion-catalog.json");
const cacheRoot = path.join(root, ".local", "motion-library");
const licenseUrl = "https://creativecommons.org/licenses/by/4.0/";
const licenseTextUrl = `${licenseUrl}legalcode.txt`;
const parser = new MMDParser.Parser();
let previous;
try { previous = JSON.parse(await readFile(catalogPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const names = {
  normal: ["normal", "Normal", "pose"],
  happy: ["happy", "Happy", "expression"],
  laugh: ["laugh", "Laugh", "expression"],
  smile: ["smile", "Smile", "expression"],
  littlesmile: ["little-smile", "Little Smile", "expression"],
  gracefulsmile: ["graceful-smile", "Graceful Smile", "expression"],
  embarassedsmile: ["embarrassed-smile", "Embarrassed Smile", "expression"],
  annoyedsmile: ["annoyed-smile", "Annoyed Smile", "expression"],
  surprise: ["surprise", "Surprise", "reaction"],
  unexpected: ["unexpected", "Unexpected", "reaction"],
  impressed: ["impressed", "Impressed", "reaction"],
  admiration: ["admiration", "Admiration", "expression"],
  expectant: ["expectant", "Expectant", "expression"],
  convinced: ["convinced", "Convinced", "reaction"],
  crisp: ["crisp", "Crisp", "expression"],
  proud: ["proud", "Proud", "expression"],
  thinking: ["thinking", "Thinking", "reaction"],
  nothankyou: ["no-thank-you", "No Thank You", "reaction"],
  compassion: ["compassion", "Compassion", "expression"],
  triumphant: ["triumphant", "Triumphant", "expression"],
  introuble: ["in-trouble", "In Trouble", "reaction"],
  disgust: ["disgust", "Disgust", "expression"],
  apology: ["apology", "Apology", "reaction"],
  stressed: ["stressed", "Stressed", "expression"],
  embarrasing: ["embarrassed", "Embarrassed", "expression"],
  sharpeyessuspicion: ["sharp-eyes-suspicion", "Sharp Eyes Suspicion", "expression"],
  mortifying: ["mortifying", "Mortifying", "reaction"],
  provoking: ["provoking", "Provoking", "reaction"],
  sleepy: ["sleepy", "Sleepy", "expression"],
  terrified: ["terrified", "Terrified", "expression"],
  stunned: ["stunned", "Stunned", "expression"],
  disappointed: ["disappointed", "Disappointed", "expression"],
  frustrated: ["frustrated", "Frustrated", "reaction"],
  angry: ["angry", "Angry", "expression"],
  sad: ["sad", "Sad", "expression"],
  afraid: ["afraid", "Afraid", "expression"],
  anxious: ["anxious", "Anxious", "expression"],
  sentimental: ["sentimental", "Sentimental", "expression"],
  ashamed: ["ashamed", "Ashamed", "expression"],
  stand: ["stand", "Stand", "pose"],
};

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function download(url, maxBytes = 2 * 1024 * 1024) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || ![
    "api.github.com", "raw.githubusercontent.com", "creativecommons.org",
  ].includes(parsed.hostname)) throw new Error(`Unapproved download host: ${url}`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "soft-hearts-motion-catalog", Accept: "application/vnd.github+json" },
        redirect: "error", signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      if (Number(response.headers.get("content-length")) > maxBytes)
        throw new Error(`File exceeds catalogue limit: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`File exceeds catalogue limit: ${url}`);
      return bytes;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
async function json(url) { return JSON.parse((await download(url)).toString("utf8")); }
async function writeCached(base, relativePath, bytes) {
  const target = path.join(base, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
function descriptor(relativePath, originalPath, downloadUrl, bytes) {
  return { relativePath, originalPath, downloadUrl, sha256: digest(bytes), bytes: bytes.length };
}
function matchesGitBlob(bytes, file) {
  return bytes.length === file.size && createHash("sha1")
    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === file.sha;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const itemIndex = index++;
      results[itemIndex] = await fn(items[itemIndex], itemIndex);
    }
  }));
  return results;
}

const licenseBytes = await download(licenseTextUrl);
const packs = [];
for (const id of ["gene"]) {
  const old = previous?.packs.find(pack => pack.id === id);
  const revision = old && !process.argv.includes("--update-source")
    ? old.revision
    : (await json(`https://api.github.com/repos/mmdagent-ex/${id}/commits/main`)).sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Invalid upstream commit: ${revision}`);
  const tree = await json(`https://api.github.com/repos/mmdagent-ex/${id}/git/trees/${revision}?recursive=1`);
  if (tree.truncated) throw new Error(`Truncated upstream tree for ${id}`);
  const files = tree.tree.filter(file => file.type === "blob" && /^motion\/[^/]+\.vmd$/i.test(file.path))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (files.length !== 40) throw new Error(`Review required: expected 40 ${id} motions, found ${files.length}`);
  const sourceUrl = `https://github.com/mmdagent-ex/${id}`;
  const rawBase = `https://raw.githubusercontent.com/mmdagent-ex/${id}/${revision}`;
  const base = path.join(cacheRoot, "mmdagent-ex", id, revision);
  const motions = await mapLimit(files, 4, async file => {
    const key = path.posix.basename(file.path, ".vmd").replace(/^\d+_/, "").toLowerCase();
    const named = names[key];
    if (!named) throw new Error(`Review English naming for ${file.path}`);
    const [motionId, name, category] = named;
    const downloadUrl = `${rawBase}/${file.path}`;
    const bytes = await download(downloadUrl);
    if (!matchesGitBlob(bytes, file)) throw new Error(`Unexpected Git blob for ${file.path}`);
    const parsed = parser.parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
    if (parsed.metadata.magic !== "Vocaloid Motion Data 0002") throw new Error(`Invalid VMD: ${file.path}`);
    if (parsed.cameras.length) throw new Error(`Camera motion requires review: ${file.path}`);
    const relativePath = `motions/${category}/${motionId}.vmd`;
    await writeCached(base, relativePath, bytes);
    const tags = ["mmd", "vmd", "dialog", category, motionId];
    if (parsed.motions.length) tags.push("body-motion");
    if (parsed.morphs.length) tags.push("facial-expression");
    return {
      id: motionId, name, category, tags,
      ...descriptor(relativePath, file.path, downloadUrl, bytes),
      durationFrames: Math.max(0, ...parsed.motions.map(frame => frame.frameNum), ...parsed.morphs.map(frame => frame.frameNum)),
      boneFrames: parsed.motions.length, morphFrames: parsed.morphs.length,
    };
  });
  const readmeUrl = `${rawBase}/README.md`;
  const readmeBytes = await download(readmeUrl);
  const readme = readmeBytes.toString("utf8");
  if (!readme.includes("Files in this repository are licensed") || !readme.includes("CC-BY 4.0"))
    throw new Error(`Upstream license scope requires review: ${id}`);
  const attribution = readme.match(/```text\s*\n(CG-CA[^\n]+)\n```/)?.[1].trimEnd();
  if (!attribution) throw new Error(`Missing upstream attribution: ${id}`);
  const documents = [
    descriptor("metadata/upstream-readme.md", "README.md", readmeUrl, readmeBytes),
    descriptor("metadata/cc-by-4.0.txt", "legalcode.txt", licenseTextUrl, licenseBytes),
  ];
  await writeCached(base, documents[0].relativePath, readmeBytes);
  await writeCached(base, documents[1].relativePath, licenseBytes);
  const pack = {
    id, name: "Gene Dialog Motions",
    source: "mmdagent-ex", sourceUrl, revision,
    license: { id: "CC-BY-4.0", url: licenseUrl, attribution },
    motions, documents,
  };
  packs.push(pack);
  await writeCached(base, "metadata/attribution.txt", `${attribution}\n\nLicense: CC BY 4.0\n${licenseUrl}\nSource: ${sourceUrl}\nRevision: ${revision}\n\nVMD contents are unmodified. Filenames and directories were normalized to English kebab-case.\nCategories and tags are descriptive metadata maintained by soft hearts; they do not enable automatic moods or behaviors.\nThe upstream README and usage guidelines are retained in upstream-readme.md.\n`);
  await writeCached(base, "metadata/source.json", `${JSON.stringify({
    schemaVersion: 1, downloadedAt: new Date().toISOString(), ...pack,
    modifications: "VMD bytes unchanged; filenames and directories normalized to English kebab-case. Added descriptive categories and tags.",
  }, null, 2)}\n`);
  console.log(JSON.stringify({
    pack: id, revision, motions: motions.length,
    bytes: motions.reduce((total, motion) => total + motion.bytes, 0),
    categories: Object.fromEntries(["pose", "expression", "reaction"].map(category => [category, motions.filter(motion => motion.category === category).length])),
    boneFrames: motions.reduce((total, motion) => total + motion.boneFrames, 0),
    morphFrames: motions.reduce((total, motion) => total + motion.morphFrames, 0),
    localDirectory: base,
  }, null, 2));
}
// Adapted packs have a separate reviewed preparation pipeline; never discard them on a Gene refresh.
packs.push(...(previous?.packs ?? []).filter(pack => pack.bundledOnly === true && pack.id !== "gene"));
await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, packs }, null, 2)}\n`);
