import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MotionLibrary } from "../electron/motion-library";
import type { MotionCatalog, MotionDownloadFile, MotionPack } from "../shared/motion-library";

async function fixture(t: TestContext, kind: "gene" | "additional" = "additional") {
  const directory = await mkdtemp(path.join(tmpdir(), "soft-hearts-motion-preview-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("soft-hearts-motion-preview-"));
    await rm(directory, { recursive: true, force: true });
  });
  const bundledDirectory = path.join(directory, "bundled");
  const cache = path.join(directory, "cache");
  const revision = "a".repeat(40);
  const isGene = kind === "gene";
  const sourceUrl = isGene ? "https://github.com/mmdagent-ex/gene" : "https://www.ianxmason.com/100style/";
  const raw = `https://raw.githubusercontent.com/mmdagent-ex/gene/${revision}/`;
  const files = new Map<string, Buffer>();
  const file = (relativePath: string, originalPath: string, body: Buffer, url = isGene ? raw + originalPath : sourceUrl): MotionDownloadFile => {
    files.set(relativePath, body);
    return { relativePath, originalPath, downloadUrl: url, bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex") };
  };
  const body = Buffer.alloc(74);
  body.write("Vocaloid Motion Data 0002", 0, "ascii");
  body.write("Original fixture", 30, "ascii");
  const category = isGene ? "pose" as const : "idle" as const;
  const pack: MotionPack = {
    id: isGene ? "gene" : "100style-idles", name: "Preview fixture",
    source: isGene ? "mmdagent-ex" : "100style", sourceUrl, revision,
    ...(isGene ? {} : { bundledOnly: true }),
    modifications: "Original empty VMD fixture by soft hearts contributors.",
    compatibilityNote: "Resource validation only; no external motion content.",
    license: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/", attribution: "Original fixture author" },
    motions: ["selected", "other"].map(id => ({
      ...file(`motions/${category}/${id}.vmd`, isGene ? `motion/${id}.vmd` : `100STYLE/${id}.bvh`, body),
      id, name: id, category, tags: [category], durationFrames: 0, boneFrames: 0, morphFrames: 0,
    })),
    documents: isGene ? [
      file("metadata/upstream-readme.md", "README.md", Buffer.from("Original author and usage guidelines")),
      file("metadata/cc-by-4.0.txt", "license", Buffer.from("Original license fixture"), "https://creativecommons.org/licenses/by/4.0/legalcode.txt"),
    ] : [
      file("metadata/source.json", "source.json", Buffer.from('{"source":"fixture"}')),
      file("metadata/attribution.txt", "attribution.txt", Buffer.from("Original fixture author")),
      file("metadata/cc-by-4.0.txt", "legalcode.txt", Buffer.from("Original license fixture")),
    ],
  };
  const catalog: MotionCatalog = { schemaVersion: 1, packs: [pack] };
  const root = path.join(bundledDirectory, pack.source, pack.id, revision);
  for (const [relative, bytes] of files) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  let fetches = 0;
  const fetcher = (async () => { fetches++; throw new Error("Preview must stay offline"); }) as typeof fetch;
  const library = new MotionLibrary(cache, { bundledDirectory, catalog, fetch: fetcher });
  return { directory, bundledDirectory, cache, root, pack, catalog, library, fetcher, fetches: () => fetches };
}

test("preview resolves just the selected reviewed VMD and its notices without fetching or creating a cache", async t => {
  for (const kind of ["gene", "additional"] as const) {
    const data = await fixture(t, kind);
    // An unrelated damaged clip must not prevent temporary playback of an intact selected clip.
    await writeFile(path.join(data.root, data.pack.motions[1].relativePath), Buffer.from("damaged"));
    const before = await readFile(path.join(data.root, data.pack.motions[0].relativePath));
    const target = await data.library.resolvePreview(data.pack.id, "selected");
    assert.equal(target, path.join(data.root, data.pack.motions[0].relativePath));
    assert.deepEqual(await readFile(target), before);
    await assert.rejects(lstat(data.cache), /ENOENT/);
    assert.equal(data.fetches(), 0);
  }
});

test("preview rejects unknown IDs and renderer-supplied paths or URLs", async t => {
  const data = await fixture(t);
  for (const [packId, motionId] of [
    ["missing", "selected"], [data.pack.id, "missing"], [null, "selected"],
    [data.pack.id, "../selected.vmd"], [data.pack.id, "https://example.test/motion.vmd"],
    [{ id: data.pack.id }, "selected"], [data.pack.id, { path: "motion.vmd" }],
  ]) await assert.rejects(data.library.resolvePreview(packId, motionId), /动作包或动作编号不正确/);
  await assert.rejects(lstat(data.cache), /ENOENT/);
  assert.equal(data.fetches(), 0);
});

test("preview rejects same-size corrupted VMD or changed license and attribution bytes", async t => {
  const data = await fixture(t);
  for (const relative of [data.pack.motions[0].relativePath, "metadata/attribution.txt", "metadata/cc-by-4.0.txt"]) {
    const target = path.join(data.root, relative);
    const original = await readFile(target);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(target, changed);
    await assert.rejects(data.library.resolvePreview(data.pack.id, "selected"), /预装资源缺失或损坏/);
    await writeFile(target, original);
  }
  await assert.rejects(lstat(data.cache), /ENOENT/);
  assert.equal(data.fetches(), 0);
});

test("preview rejects a missing notice or absent bundled resource directory without downloading", async t => {
  const data = await fixture(t);
  await rm(path.join(data.root, "metadata/source.json"));
  await assert.rejects(data.library.resolvePreview(data.pack.id, "selected"), /预装资源缺失或损坏/);
  const unbundled = new MotionLibrary(data.cache, { catalog: data.catalog, fetch: data.fetcher });
  await assert.rejects(unbundled.resolvePreview(data.pack.id, "selected"), /预览需要完整的预装动作资源/);
  await assert.rejects(lstat(data.cache), /ENOENT/);
  assert.equal(data.fetches(), 0);
});
