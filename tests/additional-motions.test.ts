import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MotionLibrary } from "../electron/motion-library";
import type { MotionCatalog, MotionDownloadFile, MotionPack } from "../shared/motion-library";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), "soft-hearts-additional-motions-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith("soft-hearts-additional-motions-"));
    await rm(temporary, { recursive: true, force: true });
  });
  const bundledDirectory = path.join(temporary, "bundled");
  const cache = path.join(temporary, "cache");
  const revision = "d".repeat(40);
  const bodies = new Map<string, Buffer>();
  const sourceUrl = "https://www.ianxmason.com/100style/";
  const descriptor = (relativePath: string, originalPath: string, body: Buffer): MotionDownloadFile => {
    bodies.set(relativePath, body);
    return { relativePath, originalPath, downloadUrl: sourceUrl,
      bytes: body.length, sha256: digest(body) };
  };
  // An original empty VMD: header/model name followed by zero keyframe counts.
  // These tests exercise verified resource activation, not animation retargeting.
  const vmd = Buffer.alloc(74);
  vmd.write("Vocaloid Motion Data 0002", 0, "ascii");
  vmd.write("fixture", 30, "ascii");
  const pack: MotionPack = {
    id: "100style-idles", name: "100STYLE Idle Fixtures", source: "100style", sourceUrl, revision,
    bundledOnly: true,
    modifications: "Original test fixture; no upstream motion data included.",
    compatibilityNote: "Resource validation fixture only; no visual compatibility claim.",
    license: {
      id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "The 100STYLE Dataset - Ian Mason; original empty VMD fixture by soft hearts contributors.",
    },
    motions: [{
      ...descriptor("motions/idle/neutral.vmd", "Neutral/Neutral_ID.bvh", vmd),
      id: "neutral", name: "Neutral", category: "idle", tags: ["idle", "neutral", "gene"],
      durationFrames: 0, boneFrames: 0, morphFrames: 0,
    }],
    documents: [
      descriptor("metadata/source.json", "source.json", Buffer.from(JSON.stringify({
        schemaVersion: 1, source: "100style", sourceUrl, revision,
        license: "CC-BY-4.0", modifications: "Original fixture only.",
      }) + "\n")),
      descriptor("metadata/attribution.txt", "attribution.txt", Buffer.from("The 100STYLE Dataset - Ian Mason\n")),
      descriptor("metadata/cc-by-4.0.txt", "legalcode.txt", Buffer.from("Original license fixture; no upstream data.\n")),
    ],
  };
  const catalog: MotionCatalog = { schemaVersion: 1, packs: [pack] };
  const root = path.join(bundledDirectory, pack.source, pack.id, revision);
  for (const [relative, body] of bodies) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  let fetches = 0;
  const fetcher = (async () => {
    fetches++;
    throw new Error("Additional adaptations must not fetch upstream BVH data");
  }) as typeof fetch;
  return { temporary, bundledDirectory, cache, catalog, pack, root, bodies, fetcher,
    fetches: () => fetches };
}

test("reviewed additional motions activate verified bundled VMD and preserve source documents offline", async (t) => {
  const data = await fixture(t);
  const library = new MotionLibrary(data.cache, {
    catalog: data.catalog, bundledDirectory: data.bundledDirectory, fetch: data.fetcher,
  });
  assert.deepEqual(await library.getStatus(), {
    directory: data.bundledDirectory,
    packs: [{ id: "100style-idles", installedMotionIds: ["neutral"], complete: true, bundled: true }],
  });
  const progress: number[] = [];
  const activated = await library.install("100style-idles", "neutral", value => progress.push(value.completed));
  assert.equal(activated, path.join(data.root, "motions", "idle", "neutral.vmd"));
  assert.equal(digest(await readFile(activated)), data.pack.motions[0].sha256);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  assert.equal(JSON.parse(await readFile(path.join(data.root, "metadata", "source.json"), "utf8")).sourceUrl,
    "https://www.ianxmason.com/100style/");
  assert.match(await readFile(path.join(data.root, "metadata", "attribution.txt"), "utf8"), /Ian Mason/);
  await assert.rejects(lstat(data.cache), /ENOENT/, "activation must not create a download cache");
  assert.equal(data.fetches(), 0);
});

test("same-size corruption in an additional bundled VMD rejects both status and activation without a download", async (t) => {
  const data = await fixture(t);
  const target = path.join(data.root, "motions", "idle", "neutral.vmd");
  const corrupt = Buffer.from(await readFile(target));
  corrupt[40] ^= 1;
  await writeFile(target, corrupt);
  const library = new MotionLibrary(data.cache, {
    catalog: data.catalog, bundledDirectory: data.bundledDirectory, fetch: data.fetcher,
  });
  await assert.rejects(library.getStatus(), /预装资源缺失或损坏/);
  await assert.rejects(library.install("100style-idles", "neutral"), /预装资源缺失或损坏/);
  assert.equal(data.fetches(), 0);
});

test("missing or changed additional attribution and license files prevent activation", async (t) => {
  const data = await fixture(t);
  const library = new MotionLibrary(data.cache, {
    catalog: data.catalog, bundledDirectory: data.bundledDirectory, fetch: data.fetcher,
  });
  const attribution = path.join(data.root, "metadata", "attribution.txt");
  const original = await readFile(attribution);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  await writeFile(attribution, changed);
  await assert.rejects(library.install("100style-idles", "neutral"), /预装资源缺失或损坏/);
  await writeFile(attribution, original);
  await rm(path.join(data.root, "metadata", "cc-by-4.0.txt"));
  await assert.rejects(library.getStatus(), /预装资源缺失或损坏/);
  await assert.rejects(library.install("100style-idles", "neutral"), /预装资源缺失或损坏/);
  assert.equal(data.fetches(), 0);
});

test("an additional pack without a bundle never downloads its upstream BVH provenance URL", async (t) => {
  const data = await fixture(t);
  data.pack.motions[0].downloadUrl = "https://www.ianxmason.com/100style/Neutral/Neutral_ID.bvh";
  const library = new MotionLibrary(data.cache, { catalog: data.catalog, fetch: data.fetcher });
  assert.deepEqual((await library.getStatus()).packs, [
    { id: "100style-idles", installedMotionIds: [], complete: false },
  ]);
  await assert.rejects(library.install("100style-idles", "neutral"), /仅随完整软件包预装/);
  assert.equal(data.fetches(), 0);
});

test("noncommercial FNA and UNA source paths cannot enter the additional motion catalog", async (t) => {
  const data = await fixture(t);
  for (const originalPath of ["FNA/clip.bvh", "UNA/clip.bvh", "GENEA2022/fna/clip.bvh", "sub/UNA_clip.bvh", "FNA.bvh"]) {
    const catalog = structuredClone(data.catalog);
    catalog.packs[0].motions[0].originalPath = originalPath;
    assert.throws(() => new MotionLibrary(data.cache, { catalog }), /许可筛选不正确/, originalPath);
  }
  assert.equal(data.fetches(), 0);
});

test("additional packs require the reviewed source identity, pinned revision and complete attribution", async (t) => {
  const data = await fixture(t);
  const invalid: ((pack: MotionPack) => void)[] = [
    pack => { pack.source = "unreviewed-source"; },
    pack => { pack.sourceUrl = "https://unreviewed.example/100style/"; },
    pack => { pack.revision = "main"; },
    pack => { pack.bundledOnly = false; },
    pack => { delete pack.bundledOnly; },
    pack => { pack.license.id = "CC-BY-NC-4.0"; },
    pack => { pack.license.attribution = ""; },
    pack => { pack.modifications = ""; },
    pack => { pack.compatibilityNote = ""; },
  ];
  for (const mutate of invalid) {
    const catalog = structuredClone(data.catalog);
    mutate(catalog.packs[0]);
    assert.throws(() => new MotionLibrary(data.cache, { catalog }), /附加动作来源或授权不正确/);
  }
  for (const required of ["metadata/source.json", "metadata/attribution.txt", "metadata/cc-by-4.0.txt"]) {
    const catalog = structuredClone(data.catalog);
    catalog.packs[0].documents = catalog.packs[0].documents.filter(file => file.relativePath !== required);
    assert.throws(() => new MotionLibrary(data.cache, { catalog }), /附加动作大小或署名文件不正确/, required);
  }
  assert.equal(data.fetches(), 0);
});
