import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { DEFAULT_TTS_CONFIG, effectiveTtsConfig, type TtsConfig } from "../shared/tts";
import { AssetRegistry } from "../electron/assets";
import { KEY_SENTINEL, publicSettings, SettingsStore, type SecretStorage } from "../electron/settings";
import { validateSettings } from "../electron/validation";
import { validateTtsConfig } from "../electron/tts";
import { petViewSettings } from "../electron/pet-view";

const tts = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: "bailian", apiHost: "https://user-console-host.example", region: "beijing", apiKey: "fixture-tts-secret", ...patch });
const secrets: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: bytes => {
    if (!bytes.toString().startsWith("encrypted:")) throw new Error("invalid ciphertext");
    return bytes.toString().slice("encrypted:".length);
  },
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "soft-hearts-tts-settings-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("soft-hearts-tts-settings-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, "settings.json"), store: new SettingsStore(directory, secrets, new AssetRegistry()) };
}

test("legacy settings keep optional TTS absent and getters can use a neutral system fallback", () => {
  const previous = structuredClone(DEFAULT_SETTINGS);
  delete previous.tts;
  assert.equal(previous.tts, undefined);
  const normalized = validateSettings(previous);
  assert.equal(normalized.tts, undefined);
  const fallback = validateTtsConfig(normalized.tts ?? DEFAULT_TTS_CONFIG);
  assert.equal(fallback.provider, "system");
  assert.equal(fallback.apiHost, "");
  assert.equal(fallback.apiKey, "");
  assert.equal(fallback.instruction, "");
  assert.deepEqual(fallback.styleBindings, []);
  const selected = { ...previous, tts: tts({ instruction: "local style" }) };
  const older = validateSettings(previous, selected);
  assert.equal(older.tts?.instruction, "local style");
});

test("Bailian TTS key is encrypted only in the host, redacted in public settings and restored on this machine", async t => {
  const { directory, file, store } = await fixture(t);
  const next = { ...structuredClone(DEFAULT_SETTINGS), tts: tts() };
  const accepted = await store.save(next);
  const raw = await readFile(file, "utf8"), disk = JSON.parse(raw);
  assert.equal(raw.includes("fixture-tts-secret"), false);
  assert.equal(disk.tts.apiKey, undefined);
  assert.equal(typeof disk.ttsApiKeyEncrypted, "string");
  assert.equal(accepted.tts?.apiKey, KEY_SENTINEL);
  assert.equal(store.current.tts?.apiKey, "fixture-tts-secret");
  const loaded = new SettingsStore(directory, secrets, new AssetRegistry());
  await loaded.load();
  assert.equal(loaded.current.tts?.apiKey, "fixture-tts-secret");
  assert.equal(publicSettings(loaded.current).tts?.apiKey, KEY_SENTINEL);
});

test("sentinel saves preserve only the same explicit host and region while changes and clearing wipe the old key", async t => {
  const { file, store } = await fixture(t);
  await store.save({ ...structuredClone(DEFAULT_SETTINGS), tts: tts() });
  await store.save({ ...publicSettings(store.current), tts: { ...publicSettings(store.current).tts!, rate: 0.8 } });
  assert.equal(store.current.tts?.apiKey, "fixture-tts-secret");
  await store.save({ ...publicSettings(store.current), tts: { ...publicSettings(store.current).tts!, apiHost: "https://other-user-console-host.example" } });
  assert.equal(store.current.tts?.apiKey, "");
  assert.equal(JSON.parse(await readFile(file, "utf8")).ttsApiKeyEncrypted, undefined);
  await store.save({ ...publicSettings(store.current), tts: tts() });
  await store.save({ ...publicSettings(store.current), tts: { ...publicSettings(store.current).tts!, region: "singapore" } });
  assert.equal(store.current.tts?.apiKey, "");
  await store.save({ ...publicSettings(store.current), tts: tts() });
  await store.save({ ...publicSettings(store.current), tts: { ...publicSettings(store.current).tts!, apiKey: "" } });
  assert.equal(store.current.tts?.apiKey, "");
  assert.equal(JSON.parse(await readFile(file, "utf8")).ttsApiKeyEncrypted, undefined);
});

test("unavailable OS encryption refuses TTS key persistence and leaves existing settings intact", async t => {
  const { directory, file, store } = await fixture(t);
  await store.save(structuredClone(DEFAULT_SETTINGS));
  const before = await readFile(file, "utf8");
  const locked = new SettingsStore(directory, { ...secrets, isEncryptionAvailable: () => false }, new AssetRegistry());
  await assert.rejects(locked.save({ ...structuredClone(DEFAULT_SETTINGS), tts: tts() }), /加密不可用/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(locked.current.tts?.apiKey ?? "", "");
});

test("plaintext, corrupt or foreign-machine TTS keys never become fallback credentials", async t => {
  const { directory, file } = await fixture(t);
  for (const [ciphertext, secret] of [[undefined, secrets], ["corrupt", secrets], [Buffer.from("encrypted:foreign-key").toString("base64"), { ...secrets, isEncryptionAvailable: () => false }]] as const) {
    await writeFile(file, JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), tts: tts({ apiKey: "plaintext-must-be-ignored" }), ...(ciphertext ? { ttsApiKeyEncrypted: ciphertext } : {}) }));
    const loaded = new SettingsStore(directory, secret, new AssetRegistry());
    await loaded.load();
    assert.equal(loaded.current.tts?.apiKey, "");
  }
});

test("private character/model style bindings persist separately and public copies cannot mutate host settings", async t => {
  const { directory, file, store } = await fixture(t);
  const style = { characterId: "local-character", modelPath: "C:\\private-test\\model.pmx", voice: "style_voice", instruction: "本机保存的角色风格。", emotion: "custom" as const, rate: 0.75 };
  await store.save({ ...structuredClone(DEFAULT_SETTINGS), tts: tts({ styleBindings: [style] }) });
  const publicCopy = publicSettings(store.current);
  publicCopy.tts!.styleBindings![0].instruction = "must not mutate host";
  assert.equal(store.current.tts?.styleBindings?.[0].instruction, style.instruction);
  const registry = new AssetRegistry();
  let registrations = 0;
  const register = registry.register.bind(registry);
  registry.register = async file => { registrations++; return register(file); };
  const loaded = new SettingsStore(directory, secrets, registry);
  await loaded.load();
  assert.equal(registrations, 0, "style paths are metadata and grant no file access");
  assert.equal(loaded.current.model, null);
  assert.deepEqual(loaded.current.tts?.styleBindings, [style]);
  assert.equal(effectiveTtsConfig(loaded.current.tts!, style.characterId, style.modelPath).instruction, style.instruction);
  assert.equal(effectiveTtsConfig(loaded.current.tts!, "another-character", style.modelPath).instruction, "");
  assert.equal(JSON.parse(await readFile(file, "utf8")).tts.instruction, "");
});

test("pet camera and scale changes preserve configured TTS secrets, connection and character styles", () => {
  const current = { ...structuredClone(DEFAULT_SETTINGS), tts: validateTtsConfig(tts({
    introduced: true,
    styleBindings: [{ characterId: "private-character", modelPath: "private-model.pmx", voice: "private_voice", instruction: "角色语气。", emotion: "custom", rate: 0.8 }],
  })) };
  const next = petViewSettings(current, { camera: { ...current.camera, yaw: 15 }, scale: 1.2 });
  assert.deepEqual(next.tts, current.tts);
  assert.equal(next.tts.apiKey, "fixture-tts-secret");
  assert.equal(next.camera.yaw, 15);
  assert.equal(next.pet.scale, 1.2);
});
