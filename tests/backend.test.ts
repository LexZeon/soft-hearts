import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetRegistry } from "../electron/assets";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import {
  validateAgentModel,
  validateChatRequest,
  validateProvider,
  validateServiceBaseUrl,
  validateSettings,
  validateVoiceInput,
} from "../electron/validation";
import {
  KEY_SENTINEL,
  publicSettings,
  resolveVoiceInputKey,
  SettingsStore,
} from "../electron/settings";
import { memoryProviderScope } from "../electron/companion";
import type { AppSettings } from "../shared/contracts";
import {
  codexArguments,
  codexEnvironment,
  chatCatalog,
} from "../electron/codex";

test("local asset paths stay inside the explicitly selected directory", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mmd-assets-"));
  try {
    await mkdir(path.join(tmp, "model"));
    await mkdir(path.join(tmp, "model", "纹理"));
    await writeFile(path.join(tmp, "model", "小满.pmx"), "PMX ");
    await writeFile(path.join(tmp, "model", "纹理", "脸.png"), "image");
    await writeFile(path.join(tmp, "outside.png"), "private");
    await writeFile(path.join(tmp, "model", "secret.txt"), "private");
    const registry = new AssetRegistry();
    const asset = await registry.register(
      path.join(tmp, "model", "小满.pmx"),
    );
    assert.equal(await registry.resolve(asset.url), asset.path);
    const origin =
      new URL(asset.url).origin === "null"
        ? asset.url.slice(0, asset.url.lastIndexOf("/") + 1)
        : "";
    assert.equal(
      await readFile(
        await registry.resolve(
          `${origin}${encodeURIComponent("纹理")}/${encodeURIComponent("脸.png")}`,
        ),
        "utf8",
      ),
      "image",
    );
    await assert.rejects(registry.resolve(`${origin}..%2foutside.png`));
    await assert.rejects(registry.resolve(`${origin}secret.txt`));
    await assert.rejects(registry.resolve("mmd-asset://unknown/secret.png"));
    registry.clear();
    await assert.rejects(registry.resolve(asset.url));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("settings do not let the renderer grant file or agent directory access", () => {
  const next = structuredClone(DEFAULT_SETTINGS);
  next.model = {
    path: "C:/private/file.pmx",
    name: "file",
    url: "file:///private/file.pmx",
  };
  next.agent.workingDirectory = "C:/";
  next.camera.distance = Number.NaN;
  next.pet.fps = 1000;
  const valid = validateSettings(next);
  assert.equal(valid.model, null);
  assert.equal(valid.agent.workingDirectory, "");
  assert.equal(valid.camera.distance, DEFAULT_SETTINGS.camera.distance);
  assert.equal(valid.pet.fps, 60, 'an invalid rate falls back to the default (60 since R29f)');
});

test("camera degrees and rendering FPS survive a settings round trip", () => {
  const next = structuredClone(DEFAULT_SETTINGS);
  next.camera = {
    yaw: 150,
    pitch: 55,
    distance: 42,
    targetX: -3,
    targetY: 12,
    fov: 50,
  };
  next.pet.fps = 24;
  const result = validateSettings(next);
  assert.deepEqual(result.camera, { ...next.camera, targetZ: 0 });
  assert.equal(result.pet.fps, 24);
});

test("chat validation bounds history and only accepts image snapshots", () => {
  const result = validateChatRequest({
    id: "test-1",
    messages: Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? "user" : "assistant",
      content: "x".repeat(10000),
    })),
    attachments: [],
  });
  assert.ok(result.messages.length <= 24);
  assert.ok(result.messages.reduce((n, m) => n + m.content.length, 0) <= 48000);
  assert.throws(() =>
    validateChatRequest({
      id: "../bad",
      messages: [{ role: "user", content: "a" }],
    }),
  );
  assert.throws(() =>
    validateChatRequest({
      id: "a",
      messages: [{ role: "system", content: "a" }],
    }),
  );
  assert.throws(() =>
    validateChatRequest({
      id: "a",
      messages: [{ role: "user", content: "a" }],
      attachments: [{ source: "screen", dataUrl: "file:///secret.png" }],
    }),
  );
});

test("speech-recognition service URL rejects credentials, queries and arbitrary protocols", () => {
  for (const baseUrl of ["file:///secrets", "https://key:secret@example.com", "https://example.com?key=secret", "https://example.com/v1#x"])
    assert.throws(() => validateVoiceInput({ baseUrl, model: "whisper-1" }), /HTTP\(S\)/);
  assert.throws(() => validateServiceBaseUrl("ftp://example.com"));
  assert.equal(validateVoiceInput({ baseUrl: "http://127.0.0.1:8000/v1/", model: " whisper-1 " }).baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(validateVoiceInput({ baseUrl: "http://127.0.0.1:8000/v1", model: " whisper-1 " }).model, "whisper-1");
});

test("retired OpenAI-compatible and Ollama connections load as the default Claude connection", () => {
  const fresh = validateProvider(DEFAULT_SETTINGS.provider);
  assert.deepEqual(fresh, { kind: "claude", baseUrl: DEFAULT_SETTINGS.provider.baseUrl, model: "" });
  for (const old of [
    { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", apiKey: "sk-private" },
    { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", apiKey: "" },
    { kind: "openai", baseUrl: "file:///not-even-a-url", model: "x" },
    { kind: "something-else", model: "y" },
    null,
  ]) {
    const migrated = validateProvider(old);
    // Their model names mean nothing to Claude Code; the key is never carried over.
    assert.deepEqual(migrated, fresh, JSON.stringify(old));
    assert.equal(memoryProviderScope(migrated), memoryProviderScope(DEFAULT_SETTINGS.provider));
  }
  // Claude (and the Codex edition's "codex") keep their stored connection so chat memory stays in scope.
  const claude = { kind: "claude", baseUrl: "http://127.0.0.1:11434/v1", model: "sonnet" };
  assert.deepEqual(validateProvider({ ...claude, apiKey: "stray" }), claude);
  assert.deepEqual(validateProvider({ ...claude, kind: "codex" }), claude);
  const settings = validateSettings({ ...structuredClone(DEFAULT_SETTINGS), provider: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" } });
  assert.deepEqual(settings.provider, fresh);
});

test("a task model left over from Codex or the OpenAI-compatible/Ollama era loads as Claude Code's default", async () => {
  // Claude Code aliases and Claude model ids pass unchanged.
  for (const kept of ["sonnet", "opus", "haiku", "fable", "Fable", "default", "opusplan", "sonnet[1m]", "claude-sonnet-4-5", "claude-fable-5-1", "claude-opus-4-1-20250805",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-3-5-sonnet-v2@20241022", "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc"])
    assert.equal(validateAgentModel(kept), kept, kept);
  assert.equal(validateAgentModel("  sonnet  "), "sonnet");
  // Model names Claude Code would reject become "" (its default), so a task never starts with them.
  for (const stale of ["gpt-5-codex", "gpt-5.1-codex-max", "gpt-5", "o4-mini", "o3", "gpt-4o", "qwen3:8b", "llama3.1:8b", "deepseek-r1:14b", "fixture-chat",
    "sonnet --dangerously-skip-permissions", "claude\nsonnet", 42, null, undefined, {}])
    assert.equal(validateAgentModel(stale), "", JSON.stringify(stale));
  const settings = validateSettings({ ...structuredClone(DEFAULT_SETTINGS), agent: { workingDirectory: "", model: "gpt-5-codex", writable: false } });
  assert.equal(settings.agent.model, "");
  assert.equal(validateSettings({ ...structuredClone(DEFAULT_SETTINGS), agent: { workingDirectory: "", model: "opus", writable: false } }).agent.model, "opus");
  // Loading an old profile cleans it in memory (what the task runner reads) and the next save writes it.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mmd-agent-model-"));
  try {
    const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" };
    const legacy = { ...structuredClone(DEFAULT_SETTINGS), provider: { kind: "codex", baseUrl: DEFAULT_SETTINGS.provider.baseUrl, model: "" },
      agent: { workingDirectory: "C:/legacy/project", model: "gpt-5.1-codex", writable: true } };
    await writeFile(path.join(tmp, "settings.json"), JSON.stringify(legacy));
    const store = new SettingsStore(tmp, secret, new AssetRegistry());
    await store.load();
    assert.deepEqual(store.current.agent, { workingDirectory: "C:/legacy/project", model: "", writable: true });
    await store.save(publicSettings(store.current));
    const disk = JSON.parse(await readFile(path.join(tmp, "settings.json"), "utf8"));
    assert.equal(disk.agent.model, "");
    assert.equal(disk.agent.workingDirectory, "C:/legacy/project", "only the model is migrated");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a retired chat key stays byte-for-byte on disk, is never decrypted, and is never re-created", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mmd-retired-key-"));
  const calls: string[] = [];
  const secret = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => { calls.push("encrypt"); return Buffer.from([...s].reverse().join("")); },
    decryptString: (b: Buffer) => { calls.push("decrypt"); return [...b.toString()].reverse().join(""); },
  };
  const ciphertext = Buffer.from("legacy-ciphertext-bytes").toString("base64");
  try {
    const legacy = { ...structuredClone(DEFAULT_SETTINGS), provider: { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" }, apiKeyEncrypted: ciphertext };
    delete (legacy as { voiceInput?: unknown }).voiceInput;
    await writeFile(path.join(tmp, "settings.json"), JSON.stringify(legacy));
    const store = new SettingsStore(tmp, secret, new AssetRegistry());
    await store.load();
    assert.deepEqual(calls, [], "the old chat key is not decrypted");
    assert.deepEqual(store.current.provider, validateProvider(null));
    assert.equal("apiKey" in publicSettings(store.current).provider, false);
    // A renderer that still sends a chat key cannot store it.
    const sent = publicSettings(store.current) as AppSettings & { provider: { apiKey?: string } };
    sent.provider.apiKey = "new-chat-key";
    sent.persona = "changed";
    await store.save(sent);
    assert.deepEqual(calls, [], "no chat key is encrypted");
    const disk = JSON.parse(await readFile(path.join(tmp, "settings.json"), "utf8"));
    assert.equal(disk.apiKeyEncrypted, ciphertext, "old ciphertext untouched");
    assert.equal(disk.provider.kind, "claude");
    assert.equal("apiKey" in disk.provider, false);
    assert.ok(!JSON.stringify(disk).includes("new-chat-key"));
    const restored = new SettingsStore(tmp, secret, new AssetRegistry());
    await restored.load();
    await restored.save(publicSettings(restored.current));
    assert.equal(JSON.parse(await readFile(path.join(tmp, "settings.json"), "utf8")).apiKeyEncrypted, ciphertext);
    assert.deepEqual(calls, []);
    // A profile without the old field never gains one.
    const clean = await mkdtemp(path.join(os.tmpdir(), "mmd-no-retired-key-"));
    try {
      const fresh = new SettingsStore(clean, secret, new AssetRegistry());
      await fresh.load(); await fresh.save(structuredClone(DEFAULT_SETTINGS));
      assert.equal("apiKeyEncrypted" in JSON.parse(await readFile(path.join(clean, "settings.json"), "utf8")), false);
    } finally { await rm(clean, { recursive: true, force: true }); }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("unavailable OS secret storage never falls back to a plaintext speech key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mmd-secret-"));
  try {
    const store = new SettingsStore(
      tmp,
      {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => "",
      },
      new AssetRegistry(),
    );
    await store.load();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.voiceInput!.apiKey = "no-plaintext";
    await assert.rejects(store.save(settings), /加密/);
    await assert.rejects(readFile(path.join(tmp, "settings.json")));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a redacted speech key is never silently forwarded to a different service URL", () => {
  const previous = { baseUrl: "https://original.example/v1", model: "a", language: "zh", apiKey: "private-key" };
  assert.equal(resolveVoiceInputKey({ ...previous, apiKey: KEY_SENTINEL }, previous).apiKey, "private-key");
  assert.equal(resolveVoiceInputKey({ ...previous, baseUrl: "https://new.example/v1", apiKey: KEY_SENTINEL }, previous).apiKey, "");
});

test("Claude chat and agent use distinct tool permissions and never bypass sandbox", () => {
  const chat = codexArguments({
    kind: "chat",
    model: "",
    workingDirectory: "isolated",
    writable: true,
    prompt: "a",
  });
  assert.equal(chat[chat.indexOf("--sandbox") + 1], "read-only");
  assert.ok(chat.includes("--ignore-user-config"));
  assert.ok(chat.includes("--ignore-rules"));
  assert.ok(chat.includes("features.shell_tool=false"));
  assert.ok(chat.includes("features.multi_agent=false"));
  assert.ok(chat.includes("features.apps=false"));
  assert.ok(chat.includes("features.plugins=false"));
  assert.ok(!chat.includes("--dangerously-bypass-approvals-and-sandbox"));
  const agent = codexArguments({
    kind: "agent",
    model: "selected-model",
    workingDirectory: "chosen",
    writable: true,
    prompt: "a",
  });
  assert.equal(agent[agent.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(agent.includes("features.multi_agent=true"));
  assert.ok(agent.includes("selected-model"));
});

test("Claude children never inherit a parent app tool pipe, identity or permission override", () => {
  const before = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  process.env.CODEX_APP_TOOLS_PIPE_PATH = "private-parent-pipe";
  try {
    const environment = codexEnvironment();
    assert.equal(environment.CODEX_APP_TOOLS_PIPE_PATH, undefined);
    assert.equal(environment.CODEX_THREAD_ID, undefined);
    assert.equal(environment.CODEX_PERMISSION_PROFILE, undefined);
  } finally {
    if (before === undefined) delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
    else process.env.CODEX_APP_TOOLS_PIPE_PATH = before;
  }
});

test("Claude chat removes catalog-forced tools without substituting model identities", () => {
  const result = JSON.parse(
    chatCatalog(
      JSON.stringify({
        models: [
          {
            slug: "user-selected",
            shell_type: "unified_exec",
            apply_patch_tool_type: "freeform",
            multi_agent_version: "v2",
            tool_mode: "code_mode_only",
            experimental_supported_tools: ["clock"],
            supports_search_tool: true,
            context_window: 1000,
          },
        ],
      }),
    ),
  );
  assert.equal(result.models[0].slug, "user-selected");
  assert.equal(result.models[0].context_window, 1000);
  assert.equal(result.models[0].shell_type, "disabled");
  assert.equal(result.models[0].tool_mode, undefined);
  assert.equal(result.models[0].apply_patch_tool_type, undefined);
  assert.equal(result.models[0].multi_agent_version, undefined);
  assert.deepEqual(result.models[0].experimental_supported_tools, []);
});
