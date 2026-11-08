import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPhysicsRuntime } from './verify-physics-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(await readFile(path.join(root, "shared/motion-catalog.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "shared/bundled-assets.json"), "utf8"));
assert.equal(catalog.schemaVersion, 1);
assert.ok(catalog.packs.length >= 1 && catalog.packs.length <= 6);
const pack = catalog.packs.find(entry => entry.id === "gene");
assert.equal(pack.id, "gene");
assert.match(pack.revision, /^[a-f0-9]{40}$/);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.root, `mmdagent-ex/gene/${pack.revision}`);
assert.equal(manifest.model.relativePath, "model/gene.pmx");
assert.equal(pack.motions.length, 40);
assert.ok(pack.motions.some(motion => motion.id === manifest.defaultMotionId));
const bundledRoot = path.join(root, "assets/bundled");
const base = path.join(bundledRoot, manifest.root);
const files = [manifest.model, ...manifest.textures, ...pack.motions, ...pack.documents];
const permitted = new Set(["metadata/source.json", "metadata/attribution.txt"].map(file => `${manifest.root}/${file}`));
for (const file of files) {
  assert.match(file.relativePath, /^[a-z0-9.-]+(?:\/[a-z0-9.-]+)+$/);
  assert.ok(!file.relativePath.split("/").includes(".."));
  const bytes = await readFile(path.join(base, ...file.relativePath.split("/")));
  assert.equal(bytes.length, file.bytes, `${file.relativePath} size`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `${file.relativePath} SHA-256`);
  permitted.add(`${manifest.root}/${file.relativePath}`);
}
const additionalSources = {
  "100style-idles": "100style",
  "mpi-embm-gestures": "mpi-embm",
  "genea-2022-gestures": "genea-2022",
  "fnoji-dances": "fnoji",
};
let additionalCount = 0, ownedCount = 0;
// Project-owned motions (made for soft hearts, e.g. by Codex in T-211): no upstream licence, a provenance note instead.
const ownedSources = { "soft-hearts-actions": "soft-hearts-next" };
for (const owned of catalog.packs.filter(entry => Object.hasOwn(ownedSources, entry.id))) {
  assert.equal(owned.bundledOnly, true);
  assert.equal(owned.source, ownedSources[owned.id]);
  assert.equal(owned.license.id, "MIT");
  assert.match(owned.revision, /^[a-f0-9]{40}$/);
  assert.ok(owned.modifications && owned.compatibilityNote && owned.license.attribution);
  const ownedRoot = `${owned.source}/${owned.id}/${owned.revision}`;
  const names = new Set();
  for (const file of [...owned.motions, ...owned.documents]) {
    assert.match(file.relativePath, /^[a-z0-9.-]+(?:\/[a-z0-9.-]+)+$/);
    assert.ok(!names.has(file.relativePath), "Duplicate owned resource");
    names.add(file.relativePath);
    const body = await readFile(path.join(bundledRoot, ownedRoot, ...file.relativePath.split("/")));
    assert.equal(body.length, file.bytes, `${owned.id}/${file.relativePath} size`);
    assert.equal(createHash("sha256").update(body).digest("hex"), file.sha256, `${owned.id}/${file.relativePath} SHA-256`);
    permitted.add(`${ownedRoot}/${file.relativePath}`);
  }
  for (const name of ["metadata/source.json", "metadata/provenance.md"]) assert.ok(names.has(name));
  const provenance = JSON.parse(await readFile(path.join(bundledRoot, ownedRoot, "metadata/source.json"), "utf8"));
  assert.equal(provenance.revision, owned.revision);
  assert.equal(provenance.license.id, "MIT");
  // The revision is the content: SHA-1 of the sorted "<sha256>  <id>.vmd" lines, so a changed clip needs a new folder.
  const lines = owned.motions.map(motion => `${motion.sha256}  ${motion.id}.vmd\n`).sort().join("");
  assert.equal(createHash("sha1").update(lines).digest("hex"), owned.revision, `${owned.id} revision`);
  assert.deepEqual(provenance.motions.map(motion => motion.sha256), owned.motions.map(motion => motion.sha256));
  ownedCount += owned.motions.length;
}
for (const extra of catalog.packs.filter(entry => entry.id !== "gene" && !Object.hasOwn(ownedSources, entry.id))) {
  assert.equal(extra.bundledOnly, true);
  assert.equal(extra.source, additionalSources[extra.id]);
  assert.equal(extra.license.id, "CC-BY-4.0");
  assert.match(extra.revision, /^[a-f0-9]{40}$/);
  assert.ok(extra.modifications && extra.compatibilityNote && extra.license.attribution);
  const extraRoot = `${extra.source}/${extra.id}/${extra.revision}`;
  const names = new Set();
  for (const file of [...extra.motions, ...extra.documents]) {
    assert.match(file.relativePath, /^[a-z0-9.-]+(?:\/[a-z0-9.-]+)+$/);
    assert.ok(!file.relativePath.split("/").includes(".."));
    assert.ok(!names.has(file.relativePath), "Duplicate extra resource");
    names.add(file.relativePath);
    assert.ok(!/(^|[\\/])(FNA|UNA)([\\/._-]|$)/i.test(file.originalPath), "Noncommercial GENEA groups excluded");
    const body = await readFile(path.join(bundledRoot, extraRoot, ...file.relativePath.split("/")));
    assert.equal(body.length, file.bytes, `${extra.id}/${file.relativePath} size`);
    assert.equal(createHash("sha256").update(body).digest("hex"), file.sha256, `${extra.id}/${file.relativePath} SHA-256`);
    permitted.add(`${extraRoot}/${file.relativePath}`);
  }
  for (const name of ["metadata/source.json", "metadata/attribution.txt", "metadata/cc-by-4.0.txt"]) assert.ok(names.has(name));
  const notice = await readFile(path.join(bundledRoot, extraRoot, "metadata/attribution.txt"), "utf8");
  assert.ok(notice.includes(extra.license.attribution) && notice.includes(extra.license.url) && notice.includes(extra.sourceUrl));
  const provenance = JSON.parse(await readFile(path.join(bundledRoot, extraRoot, "metadata/source.json"), "utf8"));
  assert.equal(provenance.revision, extra.revision);
  assert.equal(provenance.license.id, "CC-BY-4.0");
  additionalCount += extra.motions.length;
}
async function inspect(directory, prefix = "") {
  for (const name of await readdir(directory)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), `Bundled assets cannot contain links: ${relative}`);
    if (info.isDirectory()) await inspect(absolute, relative);
    else assert.ok(info.isFile() && permitted.delete(relative), `Unreviewed bundled file: ${relative}`);
  }
}
await inspect(bundledRoot);
assert.equal(permitted.size, 0, "All reviewed resources and notices are present");
const provenance = JSON.parse(await readFile(path.join(base, "metadata/source.json"), "utf8"));
assert.ok(JSON.stringify(provenance).includes(pack.revision));
const attribution = await readFile(path.join(base, "metadata/attribution.txt"), "utf8");
assert.ok(attribution.includes(pack.license.attribution));
assert.ok(attribution.includes(pack.license.url));
assert.match(attribution, /trademark|design rights/i);
await verifyPhysicsRuntime();
console.log(`Bundled assets verified: Gene ${pack.motions.length} motions; ${additionalCount} additional motions with provenance; ${ownedCount} project-owned motions; fixed Ammo runtime.`);
