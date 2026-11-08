import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AssetRegistry } from "../electron/assets";
import { SettingsStore } from "../electron/settings";
import { preserveStaleAssetClears, validateAssetBaseline, validateSettings } from "../electron/validation";
import type { AssetRef } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { getMotionLayerAssets, isMotionLayer, motionAssetBaseline, withMotionLayer } from "../shared/motion-layers";

const asset = (name: string): AssetRef => ({ path: `/granted/${name}.vmd`, name, url: `mmd-asset://granted/${name}.vmd` });

test("first channel activation preserves the legacy body and face, then edits channels independently", () => {
  const legacy = { ...structuredClone(DEFAULT_SETTINGS), motion: asset("legacy") };
  const original = structuredClone(legacy);
  assert.deepEqual(getMotionLayerAssets(legacy), { pose: legacy.motion, expression: legacy.motion, gesture: null });
  const gesture = withMotionLayer(legacy, "gesture", asset("wave"));
  assert.deepEqual(getMotionLayerAssets(gesture), { pose: legacy.motion, expression: legacy.motion, gesture: asset("wave") });
  const expression = withMotionLayer(gesture, "expression", asset("happy"));
  const pose = withMotionLayer(expression, "pose", asset("sit"));
  assert.deepEqual(getMotionLayerAssets(pose), { pose: asset("sit"), expression: asset("happy"), gesture: asset("wave") });
  const cleared = withMotionLayer(pose, "gesture", null);
  assert.deepEqual(getMotionLayerAssets(cleared), { pose: asset("sit"), expression: asset("happy"), gesture: null });
  assert.deepEqual(legacy, original);
  assert.equal(withMotionLayer(cleared, "expression", null).motionLayers!.expression, null);
});

test("untrusted settings cannot grant overlay paths, switch back to a stale asset, or remove layer mode", () => {
  const previous = withMotionLayer({ ...structuredClone(DEFAULT_SETTINGS), motion: asset("pose") }, "expression", asset("happy"));
  previous.motionLayers!.gesture = asset("wave");
  const forged = structuredClone(previous);
  forged.motionLayers = { gesture: asset("arbitrary-path"), expression: asset("old") };
  const accepted = validateSettings(forged, previous);
  assert.deepEqual(accepted.motionLayers, previous.motionLayers);
  delete forged.motionLayers;
  assert.deepEqual(validateSettings(forged, previous).motionLayers, previous.motionLayers);
  const legacy = structuredClone(DEFAULT_SETTINGS);
  assert.equal(validateSettings({ ...legacy, motionLayers: { gesture: asset("arbitrary"), expression: null } }, legacy).motionLayers, undefined);
  const cleared = validateSettings({ ...previous, motionLayers: { gesture: null, expression: null } }, previous);
  assert.deepEqual(cleared.motionLayers, { gesture: null, expression: null });
});

test("older saves cannot clear new channel selections and matching baselines can clear just their channel", () => {
  const older = withMotionLayer({ ...structuredClone(DEFAULT_SETTINGS), motion: asset("pose") }, "gesture", null);
  older.motionLayers!.expression = null;
  const current = withMotionLayer(withMotionLayer(older, "gesture", asset("new-gesture")), "expression", asset("new-face"));
  const stale = validateSettings(older, current);
  preserveStaleAssetClears(stale, current, motionAssetBaseline(older));
  assert.deepEqual(stale.motionLayers, current.motionLayers);
  const legacyStale = validateSettings({ ...older, motionLayers: { gesture: null, expression: null } }, current);
  preserveStaleAssetClears(legacyStale, current, { model: null, motion: older.motion!.path });
  assert.deepEqual(legacyStale.motionLayers, current.motionLayers);
  const explicit = validateSettings({ ...current, motionLayers: { ...current.motionLayers!, gesture: null } }, current);
  preserveStaleAssetClears(explicit, current, motionAssetBaseline(current));
  assert.equal(explicit.motionLayers!.gesture, null);
  assert.deepEqual(explicit.motionLayers!.expression, current.motionLayers!.expression);
});

test("channel and baseline validation rejects paths, objects and malformed layer records", () => {
  for (const layer of [null, undefined, "face", "../pose", "https://example.test", { layer: "pose" }]) assert.equal(isMotionLayer(layer), false);
  for (const layer of ["pose", "gesture", "expression"]) assert.equal(isMotionLayer(layer), true);
  for (const baseline of [null, [], {}, { model: null, motion: null, extra: null },
    { model: null, motion: null, motionLayers: null },
    { model: null, motion: null, motionLayers: { gesture: null } },
    { model: null, motion: null, motionLayers: { gesture: {}, expression: null } },
    { model: null, motion: null, motionLayers: { gesture: null, expression: null, pose: null } }])
    assert.throws(() => validateAssetBaseline(baseline), /资源保存基线/);
  assert.deepEqual(validateAssetBaseline({ model: null, motion: null }), { model: null, motion: null });
});

test("saved layers regrant local VMDs with fresh URLs and a missing overlay clears only its channel", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "soft-hearts-motion-layers-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("soft-hearts-motion-layers-"));
    await rm(directory, { recursive: true, force: true });
  });
  const poseFile = path.join(directory, "pose.vmd");
  const faceFile = path.join(directory, "face.vmd");
  await writeFile(poseFile, "Original pose fixture");
  await writeFile(faceFile, "Original expression fixture");
  const registry = new AssetRegistry();
  const pose = await registry.register(poseFile);
  const face = await registry.register(faceFile);
  const secret = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  const store = new SettingsStore(directory, secret, registry);
  const saved = withMotionLayer({ ...structuredClone(DEFAULT_SETTINGS), motion: pose }, "expression", face);
  saved.motionLayers!.gesture = { path: path.join(directory, "missing.vmd"), url: "mmd-asset://old/missing.vmd", name: "missing" };
  await store.persist(saved);
  const freshRegistry = new AssetRegistry();
  const restored = new SettingsStore(directory, secret, freshRegistry);
  await restored.load();
  assert.equal(restored.current.motion!.path, pose.path);
  assert.equal(restored.current.motionLayers!.expression!.path, face.path);
  assert.notEqual(restored.current.motionLayers!.expression!.url, face.url);
  assert.equal(await freshRegistry.resolve(restored.current.motionLayers!.expression!.url), face.path);
  assert.equal(restored.current.motionLayers!.gesture, null);
  assert.equal(await readFile(faceFile, "utf8"), "Original expression fixture");
});
