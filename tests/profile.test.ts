import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareProfileDirectory } from "../electron/profile";

test("profile rename prefers the previous profile, copies only settings and retains sources", async () => {
  const appData = await mkdtemp(path.join(os.tmpdir(), "soft-profile-"));
  try {
    const legacy = path.join(appData, "delicate-hearts");
    const older = path.join(appData, "mmd-desk-mate");
    await mkdir(path.join(legacy, "chat"), { recursive: true });
    await mkdir(older);
    const settings = JSON.stringify({
      model: { path: "C:/private-model/model.pmx" },
      camera: { yaw: 35, pitch: 8 },
    });
    await writeFile(path.join(legacy, "settings.json"), settings);
    await writeFile(path.join(older, "settings.json"), "older settings");
    await writeFile(path.join(legacy, "chat", "private.json"), "private chat");
    await writeFile(path.join(legacy, "auth.json"), "private credential");
    const directory = prepareProfileDirectory(appData);
    // Without an explicit profile (a source run): the development folder; only the stable channel uses soft-hearts-claude.
    assert.equal(directory, path.join(appData, "soft-hearts-claude-dev"));
    await assert.rejects(readdir(path.join(appData, "soft-hearts-claude")));
    assert.equal(
      await readFile(path.join(directory, "settings.json"), "utf8"),
      settings,
    );
    assert.deepEqual(await readdir(directory), ["settings.json"]);
    assert.equal(
      await readFile(path.join(legacy, "settings.json"), "utf8"),
      settings,
    );
    assert.equal(
      await readFile(path.join(legacy, "chat", "private.json"), "utf8"),
      "private chat",
    );
    assert.equal(
      await readFile(path.join(older, "settings.json"), "utf8"),
      "older settings",
    );
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});

test("profile rename falls back to the older profile only when previous settings are absent", async () => {
  const appData = await mkdtemp(path.join(os.tmpdir(), "soft-fallback-"));
  try {
    await mkdir(path.join(appData, "delicate-hearts"));
    const older = path.join(appData, "mmd-desk-mate");
    await mkdir(older);
    await writeFile(path.join(older, "settings.json"), "older settings");
    const directory = prepareProfileDirectory(appData);
    assert.equal(
      await readFile(path.join(directory, "settings.json"), "utf8"),
      "older settings",
    );
    assert.deepEqual(await readdir(directory), ["settings.json"]);
    assert.equal(
      await readFile(path.join(older, "settings.json"), "utf8"),
      "older settings",
    );
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});

test("profile rename never overwrites an existing canonical settings file", async () => {
  const appData = await mkdtemp(path.join(os.tmpdir(), "soft-existing-"));
  try {
    await mkdir(path.join(appData, "mmd-desk-mate"));
    await mkdir(path.join(appData, "delicate-hearts"));
    await mkdir(path.join(appData, "soft-hearts-claude-dev"));
    await writeFile(
      path.join(appData, "mmd-desk-mate", "settings.json"),
      "legacy",
    );
    await writeFile(
      path.join(appData, "delicate-hearts", "settings.json"),
      "previous profile",
    );
    const current = path.join(appData, "soft-hearts-claude-dev", "settings.json");
    await writeFile(current, "current user choices");
    prepareProfileDirectory(appData);
    assert.equal(await readFile(current, "utf8"), "current user choices");
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});

test("a private profile override never imports personal settings", async () => {
  const appData = await mkdtemp(path.join(os.tmpdir(), "soft-private-"));
  try {
    await mkdir(path.join(appData, "mmd-desk-mate"));
    await mkdir(path.join(appData, "delicate-hearts"));
    await writeFile(
      path.join(appData, "mmd-desk-mate", "settings.json"),
      "personal settings",
    );
    await writeFile(
      path.join(appData, "delicate-hearts", "settings.json"),
      "previous personal settings",
    );
    const override = path.join(appData, "test-profile");
    assert.equal(prepareProfileDirectory(appData, override), override);
    assert.deepEqual(await readdir(override), []);
    await assert.rejects(readdir(path.join(appData, "soft-hearts-claude")));
    await assert.rejects(readdir(path.join(appData, "soft-hearts-claude-dev")));
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});
