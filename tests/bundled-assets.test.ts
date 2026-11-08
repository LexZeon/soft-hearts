import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AssetRegistry } from "../electron/assets";
import { BundledAssets, type BundledAssetManifest } from "../electron/bundled-assets";
import { MotionLibrary } from "../electron/motion-library";
import type { MotionCatalog, MotionDownloadFile } from "../shared/motion-library";

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), "soft-hearts-bundled-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith("soft-hearts-bundled-"));
    await rm(temporary, { recursive: true, force: true });
  });
  const directory = path.join(temporary, "bundled");
  const revision = "c".repeat(40);
  const root = `mmdagent-ex/gene/${revision}`;
  const raw = `https://raw.githubusercontent.com/mmdagent-ex/gene/${revision}/`;
  const bytes = new Map<string, Buffer>();
  const descriptor = (relativePath: string, originalPath: string, body: Buffer, downloadUrl = raw + originalPath): MotionDownloadFile => {
    bytes.set(relativePath, body);
    return { relativePath, originalPath, downloadUrl, bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex") };
  };
  const manifest: BundledAssetManifest = {
    schemaVersion: 1, root, defaultMotionId: "stand",
    model: descriptor("model/gene.pmx", "Gene.pmx", Buffer.from("PMX Original fixture model")),
    textures: [descriptor("model/tex/face.png", "tex/face.png", Buffer.from("fixture texture"))],
  };
  const catalog: MotionCatalog = { schemaVersion: 1, packs: [{
    id: "gene", name: "Gene Dialog Motions", source: "mmdagent-ex", revision,
    sourceUrl: "https://github.com/mmdagent-ex/gene",
    license: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/", attribution: "Original fixture credit" },
    motions: ["stand", "happy"].map((id) => {
      const body = Buffer.alloc(74);
      body.write("Vocaloid Motion Data 0002", 0, "ascii");
      body.write(id, 30, "ascii");
      const category = id === "stand" ? "pose" as const : "expression" as const;
      return { ...descriptor(`motions/${category}/${id}.vmd`, `motion/${id}.vmd`, body),
        id, name: id, category, tags: [id], durationFrames: 0, boneFrames: 0, morphFrames: 0 };
    }),
    documents: [
      descriptor("metadata/upstream-readme.md", "README.md", Buffer.from("Original guidelines and copyright")),
      descriptor("metadata/cc-by-4.0.txt", "legalcode.txt", Buffer.from("Fixture license"), "https://creativecommons.org/licenses/by/4.0/legalcode.txt"),
    ],
  }] };
  for (const [relative, body] of bytes) {
    const target = path.join(directory, root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await writeFile(path.join(directory, root, "metadata", "private.png"), "not granted");
  return { temporary, directory, root, manifest, catalog, bytes };
}

test("bundled Gene defaults are verified offline and grant only the model and selected motion folders", async (t) => {
  const data = await fixture(t);
  const registry = new AssetRegistry();
  const bundled = new BundledAssets(data.directory, registry, data);
  const selected = await bundled.getDefaultAssets();
  assert.equal(selected.model.name, "gene.pmx");
  assert.equal(selected.motion.name, "stand.vmd");
  assert.equal(await registry.resolve(selected.model.url), selected.model.path);
  const modelOrigin = selected.model.url.slice(0, selected.model.url.lastIndexOf("/") + 1);
  assert.equal(await readFile(await registry.resolve(`${modelOrigin}tex/face.png`), "utf8"), "fixture texture");
  await assert.rejects(registry.resolve(`${modelOrigin}..%2fmetadata/private.png`), /目录以外/);
  const motionOrigin = selected.motion.url.slice(0, selected.motion.url.lastIndexOf("/") + 1);
  await assert.rejects(registry.resolve(`${motionOrigin}..%2f..%2fmetadata/private.png`), /目录以外/);
});

test("bundled Gene motion status and activation never fetch or populate a user download cache", async (t) => {
  const data = await fixture(t);
  const cache = path.join(data.temporary, "user-cache");
  let fetched = false;
  const library = new MotionLibrary(cache, {
    catalog: data.catalog, bundledDirectory: data.directory,
    fetch: (async () => { fetched = true; throw new Error("Network forbidden"); }) as typeof fetch,
  });
  const status = await library.getStatus();
  assert.equal(status.directory, data.directory);
  assert.deepEqual(status.packs, [{ id: "gene", installedMotionIds: ["stand", "happy"], complete: true, bundled: true }]);
  const file = await library.install("gene", "happy");
  assert.equal(file, path.join(data.directory, data.root, "motions", "expression", "happy.vmd"));
  assert.equal(fetched, false);
  await assert.rejects(readFile(path.join(cache, "mmdagent-ex", "gene", data.catalog.packs[0].revision, "metadata", "source.json")), /ENOENT/);
  await assert.rejects(library.install("uka", "happy"), /编号不正确/);
});

test("missing or changed bundled files fail clearly rather than falling back to network", async (t) => {
  const data = await fixture(t);
  const registry = new AssetRegistry();
  const bundled = new BundledAssets(data.directory, registry, data);
  const texture = path.join(data.directory, data.root, "model", "tex", "face.png");
  const original = await readFile(texture);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  await writeFile(texture, changed);
  await assert.rejects(bundled.getModel(), /预装资源缺失或损坏/);
  await writeFile(texture, original);
  const motion = data.catalog.packs[0].motions[1];
  const target = path.join(data.directory, data.root, ...motion.relativePath.split("/"));
  await writeFile(target, Buffer.alloc(motion.bytes));
  const library = new MotionLibrary(path.join(data.temporary, "cache"), {
    catalog: data.catalog, bundledDirectory: data.directory,
    fetch: (async () => { throw new Error("Must not fetch missing bundled data"); }) as typeof fetch,
  });
  await assert.rejects(library.getStatus(), /预装资源缺失或损坏/);
  await assert.rejects(library.install("gene", "stand"), /预装资源缺失或损坏/);
});

test("bundle manifests reject traversal, unexpected roots, remote hosts and duplicate texture paths", async (t) => {
  const data = await fixture(t);
  for (const mutate of [
    (manifest: BundledAssetManifest) => { manifest.root = "mmdagent-ex/../private"; },
    (manifest: BundledAssetManifest) => { manifest.textures[0].relativePath = "model/../../private.png"; },
    (manifest: BundledAssetManifest) => { manifest.model.downloadUrl = "https://evil.test/Gene.pmx"; },
    (manifest: BundledAssetManifest) => { manifest.textures.push(manifest.textures[0]); },
  ]) {
    const manifest = structuredClone(data.manifest);
    mutate(manifest);
    assert.throws(() => new BundledAssets(data.directory, new AssetRegistry(), { manifest, catalog: data.catalog }), /预装资源缺失或损坏/);
  }
});

test("bundled subdirectory junctions cannot redirect model or texture access", async (t) => {
  const data = await fixture(t);
  const original = path.join(data.directory, data.root, "model", "tex");
  const outside = path.join(data.temporary, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "face.png"), data.bytes.get("model/tex/face.png")!);
  // The generated fixture directory is the exact checked target of this move.
  await rm(path.join(original, "face.png"));
  await rmdir(original);
  await symlink(outside, original, process.platform === "win32" ? "junction" : "dir");
  const bundled = new BundledAssets(data.directory, new AssetRegistry(), data);
  await assert.rejects(bundled.getModel(), /预装资源缺失或损坏/);
});
