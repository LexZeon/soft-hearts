import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MotionLibrary } from "../electron/motion-library";
import type { MotionCatalog, MotionDownloadFile, MotionPack } from "../shared/motion-library";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "soft-hearts-motion-library-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("soft-hearts-motion-library-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function fixture() {
  const bodies = new Map<string, Uint8Array>();
  const requests: { url: string; init?: RequestInit }[] = [];
  const catalog: MotionCatalog = { schemaVersion: 1, packs: [] };
  for (const id of ["gene"] as const) {
    const revision = "b".repeat(40);
    const upstream = `https://raw.githubusercontent.com/mmdagent-ex/${id}/${revision}/`;
    const file = (relativePath: string, originalPath: string, bytes: Uint8Array, url = upstream + originalPath): MotionDownloadFile => {
      bodies.set(url, bytes);
      return { relativePath, originalPath, downloadUrl: url, bytes: bytes.byteLength, sha256: digest(bytes) };
    };
    const vmd = Buffer.alloc(74);
    vmd.write("Vocaloid Motion Data 0002", 0, "ascii");
    vmd.write(id, 30, "ascii");
    catalog.packs.push({
      id, name: `${id} motions`, source: "mmdagent-ex", sourceUrl: `https://github.com/mmdagent-ex/${id}`, revision,
      license: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/", attribution: `CG-CA ${id} original author` },
      motions: [{ ...file("motions/expression/happy.vmd", "motion/01_happy.vmd", vmd),
        id: "happy", name: "Happy", category: "expression", tags: ["happy", "dialog"],
        durationFrames: 0, boneFrames: 0, morphFrames: 0 }],
      documents: [
        file("metadata/upstream-readme.md", "README.md", Buffer.from(`Original ${id} README and author guidelines`)),
        file("metadata/cc-by-4.0.txt", "license", Buffer.from("CC BY 4.0 test fixture"), "https://creativecommons.org/licenses/by/4.0/legalcode.txt"),
      ],
    });
  }
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    requests.push({ url: key, init });
    const bytes = bodies.get(key);
    assert.ok(bytes, `only known URLs are downloaded: ${key}`);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch;
  return { catalog, bodies, requests, fetcher };
}

const installedFile = (directory: string, pack: MotionPack, relativePath = pack.motions[0].relativePath) =>
  path.join(directory, "mmdagent-ex", pack.id, pack.revision, ...relativePath.split("/"));

test("motion packs install verified English paths with source, tags, attribution and reusable cache", async (t) => {
  const directory = await temporary(t);
  const fixtureData = fixture();
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
  assert.deepEqual((await library.getStatus()).packs.map((pack) => pack.complete), [false]);
  const progress: number[] = [];
  const result = await library.install("gene", "happy", (value) => progress.push(value.completed));
  const pack = fixtureData.catalog.packs[0];
  assert.equal(result, installedFile(directory, pack));
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(fixtureData.requests.length, 3);
  for (const request of fixtureData.requests) {
    assert.equal(request.init?.redirect, "error");
    assert.equal(request.init?.credentials, "omit");
  }
  const metadataDirectory = path.dirname(installedFile(directory, pack, "metadata/source.json"));
  const metadata = JSON.parse(await readFile(path.join(metadataDirectory, "source.json"), "utf8"));
  assert.equal(metadata.revision, pack.revision);
  assert.equal(metadata.motions[0].originalPath, "motion/01_happy.vmd");
  assert.deepEqual(metadata.motions[0].tags, ["happy", "dialog"]);
  assert.ok(Number.isFinite(Date.parse(metadata.downloadedAt)));
  assert.match(await readFile(path.join(metadataDirectory, "attribution.txt"), "utf8"), /CG-CA gene original author/);
  assert.equal((await library.getStatus()).packs[0].complete, true);
  await library.install("gene", "happy");
  assert.equal(fixtureData.requests.length, 3, "validated cache works without a network request");
  assert.equal(JSON.parse(await readFile(path.join(metadataDirectory, "source.json"), "utf8")).downloadedAt, metadata.downloadedAt);
  await writeFile(path.join(metadataDirectory, "source.json"), "null");
  assert.equal((await library.getStatus()).packs[0].complete, false);
  await library.install("gene", "happy");
  assert.equal((await library.getStatus()).packs[0].complete, true, "damaged metadata is regenerated");
  await library.install("gene", "happy");
  assert.match(await readFile(installedFile(directory, fixtureData.catalog.packs[0], "metadata/attribution.txt"), "utf8"), /trademark and design rights/);
});

test("corrupt cached motion is detected and repaired, not reported installed", async (t) => {
  const directory = await temporary(t);
  const fixtureData = fixture();
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
  const target = await library.install("gene", "happy");
  const original = await readFile(target);
  const corrupt = Buffer.from(original);
  corrupt[40] ^= 1;
  await writeFile(target, corrupt);
  const status = (await library.getStatus()).packs[0];
  assert.equal(status.complete, false);
  assert.deepEqual(status.installedMotionIds, []);
  await library.install("gene", "happy");
  assert.equal(fixtureData.requests.length, 4, "only the corrupted file is fetched again");
  assert.deepEqual(await readFile(target), original);
});

test("transparent gzip decoding uses the decoded body for size and hash verification", async (t) => {
  const directory = await temporary(t);
  const fixtureData = fixture();
  const gzipFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    // Native Fetch returns decoded bytes but retains wire-size/encoding headers.
    const response = await fixtureData.fetcher(url, init);
    const decoded = new Uint8Array(await response.arrayBuffer());
    return new Response(decoded, {
      headers: { "content-length": String(Math.max(1, decoded.byteLength - 10)), "content-encoding": "gzip" },
    });
  }) as typeof fetch;
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: gzipFetch });
  const target = await library.install("gene", "happy");
  assert.equal(digest(await readFile(target)), fixtureData.catalog.packs[0].motions[0].sha256);
  assert.equal((await library.getStatus()).packs[0].complete, true);

  const corruptDirectory = path.join(directory, "corrupt-decoded");
  const corrupted = (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await gzipFetch(url, init);
    const decoded = Buffer.from(await response.arrayBuffer());
    decoded[decoded.length - 1] ^= 1;
    return new Response(decoded, { headers: { "content-length": "1", "content-encoding": "gzip" } });
  }) as typeof fetch;
  const invalidLibrary = new MotionLibrary(corruptDirectory, { catalog: fixtureData.catalog, fetch: corrupted });
  await assert.rejects(invalidLibrary.install("gene", "happy"), /校验失败/);
  assert.equal((await invalidLibrary.getStatus()).packs[0].complete, false);
});

test("bad remote hashes and oversized responses cannot publish a motion or complete marker", async (t) => {
  for (const mode of ["hash", "oversized"] as const) {
    const directory = path.join(await temporary(t), mode);
    const fixtureData = fixture();
    const target = fixtureData.catalog.packs[0].motions[0];
    const bytes = Buffer.from(fixtureData.bodies.get(target.downloadUrl)!);
    bytes[40] ^= 1;
    fixtureData.bodies.set(target.downloadUrl, mode === "hash" ? bytes : Buffer.concat([bytes, Buffer.from([0])]));
    const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
    await assert.rejects(library.install("gene", "happy"), /校验失败|大小不正确/);
    await assert.rejects(lstat(installedFile(directory, fixtureData.catalog.packs[0])), /ENOENT/);
    assert.equal((await library.getStatus()).packs[0].complete, false);
    const contents = await readdir(path.dirname(installedFile(directory, fixtureData.catalog.packs[0], "metadata/source.json")));
    assert.ok(!contents.includes("source.json"));
    assert.ok(!contents.some((name) => name.endsWith(".partial")));
  }
});

test("arbitrary IDs, paths, unpinned hosts and redirect responses are rejected", async (t) => {
  const directory = await temporary(t);
  const fixtureData = fixture();
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
  for (const [packId, motionId] of [["uka", "happy"], ["../../other", "happy"], ["gene", "../../secret"], ["gene", { url: "https://evil.test" }], [null, "happy"]])
    await assert.rejects(library.install(packId, motionId), /编号不正确/);
  assert.equal(fixtureData.requests.length, 0);
  for (const modify of [
    (catalog: MotionCatalog) => { catalog.packs[0].motions[0].downloadUrl = "https://evil.test/01_happy.vmd"; },
    (catalog: MotionCatalog) => { catalog.packs[0].motions[0].relativePath = "motions/../secret.vmd"; },
    (catalog: MotionCatalog) => { catalog.packs[0].revision = "main"; },
  ]) {
    const catalog = structuredClone(fixtureData.catalog);
    modify(catalog);
    assert.throws(() => new MotionLibrary(directory, { catalog }), /不正确/);
  }
  const redirecting = new MotionLibrary(directory, { catalog: fixtureData.catalog,
    fetch: (async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })) as typeof fetch });
  await assert.rejects(redirecting.install("gene", "happy"), /HTTP 302/);
});

test("cancelled downloads reject reentry, leave no complete marker and can be retried", async (t) => {
  const directory = await temporary(t);
  const fixtureData = fixture();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const waitingFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    started();
  })) as typeof fetch;
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: waitingFetch });
  const pending = library.install("gene", "happy");
  await didStart;
  await assert.rejects(library.install("gene", "happy"), /仍在下载/);
  library.cancel();
  await assert.rejects(pending, /已取消/);
  assert.equal((await library.getStatus()).packs[0].complete, false);
  const retry = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
  await retry.install("gene", "happy");
  assert.equal((await retry.getStatus()).packs[0].complete, true);
});

test("cache directory junctions cannot escape the library", async (t) => {
  const temporaryRoot = await temporary(t);
  const outside = path.join(temporaryRoot, "outside");
  await mkdir(outside);
  const directory = path.join(temporaryRoot, "library");
  await mkdir(directory);
  await symlink(outside, path.join(directory, "mmdagent-ex"), process.platform === "win32" ? "junction" : "dir");
  const fixtureData = fixture();
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
  await assert.rejects(library.getStatus(), /符号链接或联接/);
  await assert.rejects(library.install("gene", "happy"), /符号链接或联接/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(fixtureData.requests.length, 0);
});

test("Windows AppData installations stay under the canonical library root, including MSIX virtualization", {
  skip: process.platform !== "win32" || !process.env.APPDATA,
}, async (t) => {
  const appDataDirectory = path.resolve(process.env.APPDATA!);
  const directory = await mkdtemp(path.join(appDataDirectory, "soft-hearts-motion-library-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), appDataDirectory);
    assert.ok(path.basename(directory).startsWith("soft-hearts-motion-library-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const fixtureData = fixture();
  const library = new MotionLibrary(directory, { catalog: fixtureData.catalog, fetch: fixtureData.fetcher });
  const target = await library.install("gene", "happy");
  const canonicalRoot = await realpath(directory);
  assert.equal(await realpath(target), path.join(canonicalRoot, path.relative(directory, target)));
  assert.equal((await library.getStatus()).packs[0].complete, true);
});
