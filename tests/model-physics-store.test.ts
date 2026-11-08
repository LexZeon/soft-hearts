import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, createAtomicFileWriter, type AtomicFileWriter } from "../electron/atomic-file";
import { ModelPhysicsSettingsStore } from "../electron/model-physics-settings";
import { DEFAULT_MODEL_PHYSICS, type ModelPhysicsSettings } from "../shared/model-physics";

const tuned: ModelPhysicsSettings = {
  hair: { enabled: true, strength: 0.79 },
  chest: { enabled: true, strength: 0.22 },
  quality: "high",
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "soft-hearts-physics-store-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("soft-hearts-physics-store-"));
    await rm(resolved, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, "physics-settings.json") };
}

const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";

test("a missing sidecar defaults off without creating its file or parent directory", async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, "not-created", "physics-settings.json");
  const store = new ModelPhysicsSettingsStore(file);
  assert.deepEqual(store.current, DEFAULT_MODEL_PHYSICS);
  assert.deepEqual(await store.load(), DEFAULT_MODEL_PHYSICS);
  await assert.rejects(readFile(file, "utf8"), missing);
  await assert.rejects(readdir(path.dirname(file)), missing);
});

test("a migration fallback is normalized in memory and never written by load", async t => {
  const { file } = await fixture(t);
  const store = new ModelPhysicsSettingsStore(file);
  const loaded = await store.load(tuned);
  assert.deepEqual(loaded, tuned);
  loaded.hair.enabled = false;
  assert.deepEqual(store.current, tuned);
  await assert.rejects(readFile(file, "utf8"), missing);
  assert.deepEqual(await store.load({ hair: { enabled: "true", strength: NaN }, chest: true, quality: "turbo" }), DEFAULT_MODEL_PHYSICS);
});

test("a committed sidecar survives a new host instance and overrides legacy fallback values", async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, "created-on-persist", "physics-settings.json");
  const store = new ModelPhysicsSettingsStore(file);
  assert.deepEqual(await store.persist(tuned), tuned);
  const restarted = new ModelPhysicsSettingsStore(file);
  assert.deepEqual(await restarted.load(DEFAULT_MODEL_PHYSICS), tuned);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, settings: tuned });
  assert.deepEqual(await readdir(path.dirname(file)), ["physics-settings.json"]);
});

test("malformed or unknown sidecars keep their bytes and use fallback while recognized settings normalize safely", async t => {
  const { file } = await fixture(t);
  for (const data of ["{broken", "null", "[]", JSON.stringify({ settings: tuned }),
    JSON.stringify({ version: 2, settings: tuned }), JSON.stringify({ version: 1, settings: null }),
    JSON.stringify({ version: 1, settings: [tuned] }), JSON.stringify({ version: 1, settings: true })]) {
    await writeFile(file, data, "utf8");
    const store = new ModelPhysicsSettingsStore(file);
    assert.deepEqual(await store.load(tuned), tuned);
    assert.equal(await readFile(file, "utf8"), data, "reading cannot overwrite malformed or future data");
  }
  const data = JSON.stringify({ version: 1, settings: { hair: { enabled: true, strength: null }, chest: { enabled: "true" }, quality: "turbo" } });
  await writeFile(file, data, "utf8");
  assert.deepEqual(await new ModelPhysicsSettingsStore(file).load(tuned), {
    hair: { enabled: true, strength: 0.65 }, chest: { enabled: false, strength: 0.35 }, quality: "standard",
  });
  assert.equal(await readFile(file, "utf8"), data);
});

test("an older build rewriting settings.json without physics cannot erase the independent sidecar", async t => {
  const { directory, file } = await fixture(t);
  await new ModelPhysicsSettingsStore(file).persist(tuned);
  const mainFile = path.join(directory, "settings.json");
  await writeFile(mainFile, JSON.stringify({ version: 1, physics: tuned, pet: { visible: true } }), "utf8");
  const sidecarBefore = await readFile(file, "utf8");
  await writeFile(mainFile, JSON.stringify({ version: 1, pet: { visible: false } }), "utf8");
  const oldSettings = JSON.parse(await readFile(mainFile, "utf8"));
  assert.equal(oldSettings.physics, undefined);
  assert.deepEqual(await new ModelPhysicsSettingsStore(file).load(oldSettings.physics), tuned);
  assert.equal(await readFile(file, "utf8"), sidecarBefore);
});

test("concurrent partial updates are serialized, captured on request and based on successful commits", async t => {
  const { file } = await fixture(t);
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let calls = 0, inFlight = 0, peak = 0;
  const snapshots: ModelPhysicsSettings[] = [];
  const writer: AtomicFileWriter = async (target, data) => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    snapshots.push(JSON.parse(data).settings);
    try {
      if (calls === 1) { firstStarted(); await blocked; }
      await atomicWriteFile(target, data);
    } finally { inFlight--; }
  };
  const store = new ModelPhysicsSettingsStore(file, writer);
  const firstInput = { hair: { enabled: true, strength: 0.8 } };
  const first = store.persist(firstInput);
  const second = store.persist({ chest: { enabled: true, strength: 0.2 }, quality: "low" });
  try {
    await Promise.race([started, first]);
    assert.deepEqual(store.current, DEFAULT_MODEL_PHYSICS);
    firstInput.hair.enabled = false;
    firstInput.hair.strength = 0;
  } finally { releaseFirst(); }
  const committed = await Promise.all([first, second]);
  assert.deepEqual(committed[0], { hair: { enabled: true, strength: 0.8 }, chest: { enabled: false, strength: 0.35 }, quality: "standard" });
  assert.deepEqual(committed[1], { hair: { enabled: true, strength: 0.8 }, chest: { enabled: true, strength: 0.2 }, quality: "low" });
  assert.deepEqual(snapshots, committed);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.deepEqual(store.current, committed[1]);
  assert.deepEqual(await new ModelPhysicsSettingsStore(file).load(), committed[1]);
});

test("failed atomic rename preserves disk and current, removes only its temporary, and permits recovery", async t => {
  const { directory, file } = await fixture(t);
  await new ModelPhysicsSettingsStore(file).persist(tuned);
  const originalBytes = await readFile(file, "utf8");
  const foreignTemporary = `${file}.unrelated.tmp`;
  await writeFile(foreignTemporary, "foreign temporary must survive", "utf8");
  const failure = Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
  const removed: string[] = [];
  let fail = true;
  const writer = createAtomicFileWriter({
    platform: "linux",
    rename: async (temporary, target) => {
      assert.equal(target, file);
      assert.equal(path.dirname(String(temporary)), directory);
      assert.match(path.basename(String(temporary)), /^physics-settings\.json\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/);
      if (fail) throw failure;
      await rename(temporary, target);
    },
    rm: async (temporary, options) => {
      const owned = String(temporary);
      assert.equal(path.dirname(owned), directory);
      assert.notEqual(owned, file);
      assert.notEqual(owned, foreignTemporary);
      assert.deepEqual(options, { force: true });
      removed.push(owned);
      await rm(temporary, options);
    },
  });
  const store = new ModelPhysicsSettingsStore(file, writer);
  await store.load();
  await assert.rejects(store.persist({ hair: { enabled: false }, quality: "low" }), error => error === failure);
  assert.deepEqual(store.current, tuned);
  assert.equal(await readFile(file, "utf8"), originalBytes);
  assert.equal(removed.length, 1);
  assert.deepEqual((await readdir(directory)).sort(), ["physics-settings.json", "physics-settings.json.unrelated.tmp"]);
  assert.equal(await readFile(foreignTemporary, "utf8"), "foreign temporary must survive");
  fail = false;
  assert.deepEqual(await store.persist({ chest: { enabled: false } }), { ...tuned, chest: { ...tuned.chest, enabled: false } });
  assert.equal(removed.length, 1);
  assert.deepEqual(await new ModelPhysicsSettingsStore(file).load(), store.current);
});

test("disk exports only version and normalized settings and result copies cannot mutate committed state", async t => {
  const { file } = await fixture(t);
  const input = Object.freeze({
    hair: Object.freeze({ enabled: true, strength: 0.7, modelPath: "private-model-must-not-be-copied.pmx" }),
    chest: Object.freeze({ enabled: false, strength: 0.3, damping: 42 }),
    quality: "standard",
    path: "private-sidecar-must-not-be-copied",
    characterId: "private-card-must-not-be-copied",
    history: ["private-history-must-not-be-copied"],
    permissions: { execute: true },
  });
  const store = new ModelPhysicsSettingsStore(file);
  const result = await store.persist(input);
  const expected = { hair: { enabled: true, strength: 0.7 }, chest: { enabled: false, strength: 0.3 }, quality: "standard" };
  const bytes = await readFile(file, "utf8");
  assert.deepEqual(JSON.parse(bytes), { version: 1, settings: expected });
  assert.equal(bytes.includes("private-"), false);
  result.hair.strength = 0;
  const current = store.current;
  current.chest.enabled = true;
  assert.deepEqual(store.current, expected);
  assert.equal(await readFile(file, "utf8"), bytes);
  assert.equal(input.hair.strength, 0.7);
});
