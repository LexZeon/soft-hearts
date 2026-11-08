import { _electron as electron } from "playwright";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeFixture } from "./lib/claude-smoke-fixture.mjs";
import { armSmokeWatchdog, closeElectron } from "./lib/electron-cleanup.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

// Original synthetic cards + localhost mock only. User profiles and services stay untouched.
const output = path.resolve(".local/character-cards-smoke");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "soft-cards-e2e-"));
const profile = path.join(temporary, "profile");
const executable = process.env.MMD_TEST_EXE ? path.resolve(process.env.MMD_TEST_EXE) : null;
const workspace = path.join(temporary, "workspace");
await mkdir(profile);
await mkdir(workspace);
const legacy = "LEGACY_PERSONA_PRESERVED_EXACTLY";
const requests = [],
  checks = [],
  errors = [];
let instance, controls, pet, report;
// A failing or hung run still closes its own window (scripts/lib/electron-cleanup.mjs).
const disarm = armSmokeWatchdog(() => instance, 360_000, "character-cards-smoke");
let packaged = null;
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs). Each recorded request keeps a
// Chat Completions-style `messages` view (persona as system, then history, then the user message); every send
// below follows a context change, so it opens a fresh Claude Code session carrying the full persona and history.
const claude = await createClaudeFixture({
  root: temporary,
  respond: (turn) => {
    requests.push({ messages: turn.messages, opening: turn.opening });
    return `REPLY:${turn.currentUser}`;
  },
});
await writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    version: 1,
    persona: legacy,
    model: null,
    motion: null,
    provider: claude.provider,
    voiceInput: { baseUrl: "http://127.0.0.1:9/v1", model: "fixture-asr-unused", language: "zh" },
    voice: { enabled: false, voiceURI: "", rate: 1.1, volume: 0.4 },
    pet: {
      visible: true,
      clickThrough: false,
      followMouse: false,
      fps: 24,
      scale: 1,
    },
    agent: {
      workingDirectory: workspace,
      model: "sonnet",
      writable: true,
    },
  }),
);
const draft = (name, fields = {}) => ({
  name,
  description: "",
  personality: "",
  scenario: "",
  greeting: "",
  examples: "",
  systemPrompt: "",
  ...fields,
});
const state = () => controls.evaluate(() => window.desktop.getCharacterCards());
async function waitFor(condition, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function launch() {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MMD_TEST_EXE;
  instance = await electron.launch({
    ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] } : { args: ["."] }),
    env, timeout: 30000,
  });
  await claude.install(instance);
  await instance.firstWindow();
  const identity = await instance.evaluate(({ app }) => ({
    profile: app.getPath("userData"),
    packaged: app.isPackaged,
  }));
  packaged = identity.packaged;
  assert.deepEqual(identity, { profile, packaged: !!executable });
  await waitFor(() => {
    controls = instance
      .windows()
      .find(
        (page) =>
          page.url().includes("index.html") &&
          !new URL(page.url()).searchParams.has("pet"),
      );
    pet = instance
      .windows()
      .find(
        (page) =>
          page.url().includes("index.html") &&
          new URL(page.url()).searchParams.has("pet"),
      );
    return controls && pet;
  }, "both isolated windows");
  for (const [kind, page] of [
    ["controls", controls],
    ["pet", pet],
  ]) {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(`${kind}: ${error.message}`));
    await page.waitForFunction(() => !!window.desktop?.getCharacterCards);
  }
  await controls.waitForSelector("#character-new", { state: "attached" });
}
async function cardsTab() {
  await controls.bringToFront();
  await navigateControlPage(controls, "providers");
}
async function fillCard(values) {
  await controls.locator("details.character-more").evaluate((node) => {
    node.open = true;
  });
  for (const [key, value] of Object.entries(values))
    await controls
      .locator(key === "systemPrompt" ? "#persona" : `#character-${key}`)
      .fill(value);
}
async function saved(name) {
  await waitFor(
    async () => (await state()).cards.some((card) => card.name === name),
    `saved ${name}`,
  );
  await controls.waitForFunction(
    () => !document.getElementById("character-new").disabled,
    undefined,
    { polling: 100 },
  );
  return (await state()).cards.find((card) => card.name === name);
}
async function greeting(text) {
  await controls.waitForFunction(
    (expected) =>
      [...document.querySelectorAll(".message.assistant .message-body")].at(-1)
        ?.textContent === expected,
    text,
    { polling: 100 },
  );
  await pet.waitForFunction(
    (expected) =>
      document.getElementById("pet-answer-body")?.textContent === expected,
    text,
    { polling: 100 },
  );
}
async function send(page, text) {
  if (page === controls) await navigateControlPage(controls, "chat");
  await page.bringToFront();
  await page.locator("#chat-input").focus();
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
  await greeting(`REPLY:${text}`);
  await pet.waitForFunction(
    () => !document.getElementById("send-chat").classList.contains("hidden"),
    undefined,
    { polling: 100 },
  );
}
async function nativeOpen(file) {
  await instance.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, file);
}
async function nativeSave(file) {
  await instance.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);
}
async function injectPeerState(context, marker) {
  await pet.evaluate(
    ({ context, marker }) =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel("soft-hearts-chat");
        channel.postMessage({
          type: "state",
          context,
          history: [
            { role: "user", content: marker },
            { role: "assistant", content: "OLD_PEER_REPLY" },
          ],
          activeChat: null,
          activeUser: null,
          reply: "",
          chatOwner: null,
        });
        setTimeout(() => {
          channel.close();
          resolve();
        }, 100);
      }),
    { context, marker },
  );
}
const connectionSnapshot = (settings) => ({
  provider: settings.provider,
  voiceInput: settings.voiceInput,
  voice: settings.voice,
  agent: settings.agent,
  followMouse: settings.pet.followMouse,
  fps: settings.pet.fps,
});

try {
  await launch();
  const initial = await state();
  // An existing (legacy-persona) profile keeps its migrated default card active and gets the
  // preinstalled Gene card added beside it, never activated (docs/mood/gene-preinstalled-card.md
  // 「首装与已有用户」, user-confirmed 2026-10-27). The old check expected the default card alone.
  assert.equal(initial.cards.length, 2);
  assert.equal(initial.cards[0].systemPrompt, legacy);
  assert.equal(initial.activeId, initial.cards[0].id);
  assert.equal(initial.cards[1].name, "Gene");
  assert.notEqual(initial.cards[1].systemPrompt, legacy);
  assert.equal(
    (await controls.evaluate(() => window.desktop.getSettings())).persona,
    legacy,
  );
  // With a second card present the active card may be deleted (only the last card cannot).
  assert.equal(await controls.locator("#character-delete").isDisabled(), false);
  const defaultId = initial.activeId;
  const settings = await controls.evaluate(() => window.desktop.getSettings());
  // Claude-only: chat has no key (a sent one is never stored); the speech-recognition key still must survive.
  settings.voiceInput.apiKey = "FIXTURE_ASR_KEY";
  const configured = await controls.evaluate(
    (value) => window.desktop.saveSettings(value),
    settings,
  );
  // Direct host setup has no caller echo; reload this test renderer to consume its ack.
  await controls.reload();
  await controls.waitForSelector("#character-new", { state: "attached" });
  const before = connectionSnapshot(configured);
  const runtimeBefore = await controls.evaluate(() =>
    window.desktop.getRuntimeState(),
  );
  check("legacy persona migrates once and stays active beside the inactive preinstalled Gene card");

  for (const action of [
    "saveCharacterCard",
    "activateCharacterCard",
    "deleteCharacterCard",
    "bindCharacterModel",
    "importCharacterCard",
    "exportCharacterCard",
  ]) {
    await assert.rejects(
      pet.evaluate(
        ({ action, id, card }) => {
          if (action === "saveCharacterCard")
            return window.desktop[action](card);
          if (action === "bindCharacterModel")
            return window.desktop[action](id, true);
          return window.desktop[action](id);
        },
        { action, id: defaultId, card: draft("Forbidden") },
      ),
      /未授权/,
    );
  }
  assert.equal(
    (await pet.evaluate(() => window.desktop.getCharacterCards())).activeId,
    defaultId,
  );
  check(
    "pet can read character state but every character write remains controls-only",
  );

  await send(controls, "BEFORE_SWITCH");
  const system = requests.at(-1).messages[0].content;
  assert.ok(system === legacy || system.startsWith(`${legacy}\n\n`), 'the original persona stays intact before runtime context');
  if (system !== legacy) assert.match(system.slice(legacy.length), /<sh-state-[a-f0-9]{32}>/);
  assert.equal((await controls.evaluate(() => window.desktop.getSettings())).persona, legacy, 'runtime mood instructions never replace the stored persona');
  await cardsTab();
  await controls.locator("#character-new").click();
  const cardA = draft("Fixture A", {
    description: "ROLE_DESCRIPTION_A",
    personality: "ROLE_PERSONALITY_A",
    scenario: "ROLE_SCENARIO_A",
    greeting: "GREETING_A",
    examples: "ROLE_EXAMPLE_A",
    systemPrompt: "ROLE_SYSTEM_A",
  });
  await fillCard(cardA);
  await controls.locator("#character-save").click();
  const a = await saved(cardA.name);
  assert.equal((await state()).activeId, defaultId);
  await greeting("REPLY:BEFORE_SWITCH");
  check("new card saves inactive without replacing the current conversation");
  await controls.locator("#character-save-activate").click();
  await waitFor(async () => (await state()).activeId === a.id, "activate A");
  await greeting("GREETING_A");
  assert.equal(await controls.locator(".message").count(), 1);
  assert.deepEqual(
    connectionSnapshot(
      await controls.evaluate(() => window.desktop.getSettings()),
    ),
    before,
  );
  assert.deepEqual(
    await controls.evaluate(() => window.desktop.getRuntimeState()),
    runtimeBefore,
  );
  check(
    "activation clears both histories, shows greeting and preserves connections, keys, privacy and agent permissions",
  );
  await send(pet, "CARD_A_CHAT");
  for (const value of [
    cardA.name,
    cardA.description,
    cardA.personality,
    cardA.scenario,
    cardA.examples,
    cardA.systemPrompt,
  ])
    assert.ok(requests.at(-1).messages[0].content.includes(value));
  assert.ok(!requests.at(-1).messages[0].content.includes(cardA.greeting));
  assert.equal(
    requests.at(-1).messages.find((message) => message.role === "assistant")
      .content,
    cardA.greeting,
  );
  check(
    "active role fields reach the fake Claude Code's opening turn with greeting in history only",
  );

  await cardsTab();
  await fillCard({
    name: "Fixture A Edited",
    description: "ROLE_DESCRIPTION_EDITED",
    greeting: "GREETING_EDITED",
  });
  await controls.locator("#character-save").click();
  await saved("Fixture A Edited");
  await greeting("GREETING_EDITED");
  const stale = { ...configured, persona: legacy };
  await controls.evaluate((value) => window.desktop.saveSettings(value), stale);
  assert.ok(
    (
      await controls.evaluate(() => window.desktop.getSettings())
    ).persona.includes("ROLE_DESCRIPTION_EDITED"),
  );
  check(
    "editing an active card refreshes greeting and stale general settings cannot overwrite its persona",
  );
  await controls.locator("#character-duplicate").click();
  await fillCard({ name: "Fixture A Copy" });
  await controls.locator("#character-save").click();
  const copy = await saved("Fixture A Copy");
  assert.notEqual(copy.id, a.id);
  assert.equal((await state()).activeId, a.id);
  await controls.locator("#character-save-activate").click();
  await greeting("GREETING_EDITED");
  await waitFor(
    async () => (await state()).activeId === copy.id,
    "activate copy",
  );
  await controls.locator("#character-select").selectOption(a.id);
  await waitFor(
    async () => (await state()).activeId === a.id,
    "selector reactivates original",
  );
  check(
    "duplicate creates an independent inactive UUID and the selector activates stored cards",
  );

  const flatPath = path.join(output, "flat-original.json");
  const flat = {
    name: "Literal Flat",
    description: "<script>globalThis.CARD_EXECUTED=true</script>",
    first_mes: "FLAT_GREETING",
    mes_example: "FLAT_EXAMPLE",
  };
  // Strict imports reject capabilities atomically; legacy text compatibility
  // must be exercised with a separate, text-only flat card.
  const rejectedPath = path.join(output, "flat-forbidden-fields.json");
  await writeFile(rejectedPath, JSON.stringify({
    ...flat, name: "Rejected Flat Capabilities",
    modelPath: "C:/DO_NOT_IMPORT/private.pmx", apiKey: "DO_NOT_IMPORT_SECRET",
  }));
  await controls.waitForFunction(() => !document.getElementById("character-import").disabled);
  const rejectedBefore = {
    cards: await state(),
    settings: await controls.evaluate(() => window.desktop.getSettings()),
    runtime: await controls.evaluate(() => window.desktop.getRuntimeState()),
    cardsDisk: await readFile(path.join(profile, "characters.json"), "utf8"),
    settingsDisk: await readFile(path.join(profile, "settings.json"), "utf8"),
  };
  await nativeOpen(rejectedPath);
  await controls.locator("#character-import").click();
  await controls.waitForFunction(() => {
    const status = document.getElementById("character-status");
    return status?.classList.contains("character-error") && /未支持字段/.test(status.textContent)
      && !document.getElementById("character-import").disabled;
  });
  assert.deepEqual(await state(), rejectedBefore.cards);
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSettings()), rejectedBefore.settings);
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), rejectedBefore.runtime);
  assert.equal(await readFile(path.join(profile, "characters.json"), "utf8"), rejectedBefore.cardsDisk);
  assert.equal(await readFile(path.join(profile, "settings.json"), "utf8"), rejectedBefore.settingsDisk);
  assert.equal(await controls.evaluate(() => globalThis.CARD_EXECUTED), undefined);
  check("native flat import rejects path/key fields without changing cards, activation, settings, permissions or stored files");
  await writeFile(flatPath, JSON.stringify(flat));
  await nativeOpen(flatPath);
  await controls.locator("#character-import").click();
  const flatCard = await saved(flat.name);
  assert.equal((await state()).activeId, a.id);
  assert.equal(flatCard.modelName, undefined);
  assert.equal(
    await controls.locator("#character-description").inputValue(),
    flat.description,
  );
  assert.equal(
    await controls.evaluate(() => globalThis.CARD_EXECUTED),
    undefined,
  );
  assert.equal(await controls.locator("#character-cards script").count(), 0);
  const v2Path = path.join(output, "v2-original.json");
  await writeFile(
    v2Path,
    JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Tavern Fixture",
        description: "V2_DESCRIPTION",
        personality: "V2_PERSONALITY",
        scenario: "V2_SCENARIO",
        first_mes: "V2_GREETING",
        mes_example: "V2_EXAMPLES",
        system_prompt: "V2_SYSTEM",
      },
    }),
  );
  await nativeOpen(v2Path);
  await controls.locator("#character-import").click();
  const v2 = await saved("Tavern Fixture");
  assert.notEqual(v2.id, flatCard.id);
  assert.equal(v2.greeting, "V2_GREETING");
  assert.equal(v2.examples, "V2_EXAMPLES");
  assert.equal((await state()).activeId, a.id);
  check(
    "native JSON import supports flat and Tavern V2 cards with new inactive IDs and literal safe text",
  );

  await controls.locator("#character-select").selectOption(a.id);
  const bundled = JSON.parse(
    await readFile("shared/bundled-assets.json", "utf8"),
  );
  const genePath = await instance.evaluate(({ app }, relative) =>
    process.getBuiltinModule('path').join(app.getAppPath(), 'assets', 'bundled', relative.root, relative.model),
    { root: bundled.root, model: bundled.model.relativePath });
  await navigateControlPage(controls, "appearance");
  if (packaged) await controls.locator('#use-bundled-model').click();
  else { await nativeOpen(genePath); await controls.locator('#import-model').click(); }
  await waitFor(
    async () =>
      (await controls.evaluate(() => window.desktop.getSettings())).model
        ?.path === genePath,
    "native bundled Gene selection",
  );
  await cardsTab();
  await controls.locator("#character-bind-model").click();
  await waitFor(
    async () =>
      (await state()).cards.find((card) => card.id === a.id).modelName,
    "Gene binding",
  );
  const stored = JSON.parse(
    await readFile(path.join(profile, "characters.json"), "utf8"),
  );
  assert.equal(
    stored.cards.find((card) => card.id === a.id).modelPath,
    "bundled:gene",
  );
  const exportedPath = path.join(output, "exported-original.json");
  await nativeSave(exportedPath);
  await controls.locator("#character-export").click();
  await waitFor(
    () =>
      readFile(exportedPath, "utf8")
        .then(() => true)
        .catch(() => false),
    "native export",
  );
  const exported = await readFile(exportedPath, "utf8");
  for (const secret of [
    "modelPath",
    "modelName",
    "apiKey",
    "FIXTURE_CHAT_KEY",
    "FIXTURE_ASR_KEY",
    genePath,
    workspace,
    "bundled:gene",
  ])
    assert.ok(!exported.includes(secret));
  assert.equal(JSON.parse(exported).format, "soft-hearts-character-card");
  const unbound = await controls.evaluate(() => window.desktop.getSettings());
  unbound.model = null;
  await controls.evaluate(
    (value) => window.desktop.saveSettings(value),
    unbound,
  );
  assert.equal(
    (await controls.evaluate(() => window.desktop.getSettings())).model,
    null,
  );
  await controls.evaluate(
    (id) => window.desktop.activateCharacterCard(id),
    a.id,
  );
  assert.equal(
    (await controls.evaluate(() => window.desktop.getSettings())).model.path,
    genePath,
  );
  const oldNullEdit = { ...unbound, camera: { ...unbound.camera, yaw: 17 } };
  await controls.evaluate(
    (value) =>
      window.desktop.saveSettings(value, { model: null, motion: null }),
    oldNullEdit,
  );
  const afterStaleSave = await controls.evaluate(() =>
    window.desktop.getSettings(),
  );
  assert.equal(
    afterStaleSave.model.path,
    genePath,
    "an old null snapshot must not clear a newly bound model",
  );
  assert.equal(
    afterStaleSave.camera.yaw,
    17,
    "unrelated current edits should still save",
  );
  await controls.evaluate(
    (value) =>
      window.desktop.saveSettings(
        { ...value, model: null },
        { model: value.model.path, motion: value.motion?.path ?? null },
      ),
    afterStaleSave,
  );
  assert.equal(
    (await controls.evaluate(() => window.desktop.getSettings())).model,
    null,
    "a current native asset baseline may explicitly clear the model",
  );
  await controls.evaluate(
    (id) => window.desktop.activateCharacterCard(id),
    a.id,
  );
  assert.equal(
    (await controls.evaluate(() => window.desktop.getSettings())).model.path,
    genePath,
  );
  check(
    "host-selected Gene binding survives stale asset snapshots, re-applies the model and exports no paths or keys",
  );

  await nativeOpen(exportedPath);
  await controls.locator("#character-import").click();
  await waitFor(
    async () => (await state()).cards.length === 7, // includes the preinstalled Gene card
    "soft hearts re-import",
  );
  const reimported = (await state()).cards.at(-1);
  assert.notEqual(reimported.id, a.id);
  assert.equal(reimported.modelName, undefined);
  await controls.locator("#character-select").selectOption(copy.id);
  await controls.locator("#character-delete").click();
  await waitFor(
    async () => !(await state()).cards.some((card) => card.id === copy.id),
    "delete active copy",
  );
  assert.equal((await state()).activeId, defaultId);
  await controls.evaluate(
    (id) => window.desktop.activateCharacterCard(id),
    a.id,
  );
  await greeting("GREETING_EDITED");
  check(
    "portable JSON round-trips as text-only data and active deletion selects a remaining card",
  );

  const oldContextState = await state();
  const oldContext = `${oldContextState.revision ?? 0}:${oldContextState.activeId}`;
  await controls.evaluate(
    (id) => window.desktop.activateCharacterCard(id),
    defaultId,
  );
  await controls.waitForFunction(
    () =>
      document
        .getElementById("character-active")
        ?.textContent.includes("默认伙伴"),
    undefined,
    { polling: 100 },
  );
  await controls.waitForFunction(
    () => !document.querySelector(".message"),
    undefined,
    { polling: 100 },
  );
  await injectPeerState(oldContext, "OLD_CONTEXT_MARKER");
  await send(controls, "AFTER_OLD_CONTEXT");
  assert.ok(
    !JSON.stringify(requests.at(-1).messages).includes("OLD_CONTEXT_MARKER"),
  );
  assert.equal(
    requests.at(-1).messages.filter((message) => message.role === "user")
      .length,
    1,
  );
  await controls.locator("#new-chat").click();
  const currentContextState = await state();
  const currentContext = `${currentContextState.revision ?? 0}:${currentContextState.activeId}`;
  await injectPeerState(currentContext, "CURRENT_CONTEXT_LATE_MARKER");
  await send(controls, "AFTER_NEW_CHAT");
  const outbound = JSON.stringify(requests.at(-1).messages);
  for (const marker of [
    "OLD_CONTEXT_MARKER",
    "CURRENT_CONTEXT_LATE_MARKER",
    "AFTER_OLD_CONTEXT",
  ])
    assert.ok(!outbound.includes(marker));
  assert.equal(
    requests.at(-1).messages.filter((message) => message.role === "user")
      .length,
    1,
  );
  await controls.evaluate(
    (id) => window.desktop.activateCharacterCard(id),
    a.id,
  );
  await greeting("GREETING_EDITED");
  check(
    "late peer history cannot cross role revisions or restore old context after New chat",
  );

  const beforeRestart = await state();
  await instance.close();
  instance = null;
  await launch();
  assert.deepEqual(await state(), beforeRestart);
  await greeting("GREETING_EDITED");
  await send(pet, "AFTER_RESTART");
  assert.equal(
    requests.at(-1).messages.find((message) => message.role === "assistant")
      ?.content,
    "GREETING_EDITED",
    "first chat after restart includes the active greeting as history",
  );
  const persisted = JSON.parse(
    await readFile(path.join(profile, "characters.json"), "utf8"),
  );
  assert.equal(
    persisted.cards.find((card) => card.id === a.id).modelPath,
    "bundled:gene",
  );
  await controls.evaluate(
    (id) => window.desktop.activateCharacterCard(id),
    a.id,
  );
  assert.equal(
    (await controls.evaluate(() => window.desktop.getSettings())).model.path,
    genePath,
  );
  assert.deepEqual(
    connectionSnapshot(
      await controls.evaluate(() => window.desktop.getSettings()),
    ),
    before,
  );
  assert.deepEqual(errors, []);
  assert.ok(requests.every((request) => request.opening === true), "every send opened a fresh Claude Code session");
  claude.assertClean();
  check(
    "restart preserves cards, active greeting, provider settings and stable bundled model binding",
  );
  report = {
    status: "PASS",
    packaged,
    checks,
    cardCount: (await state()).cards.length,
    mockRequests: requests.length,
    noPrivateProfile: true,
    noMediaDevices: true,
    errors,
  };
  console.log(JSON.stringify(report));
} catch (error) {
  report = {
    status: "FAIL",
    packaged,
    checks,
    error: String(error),
    errors,
    cardState: controls ? await state().catch(() => null) : null,
  };
  console.error(JSON.stringify(report));
  for (const [name, page] of [
    ["controls", controls],
    ["pet", pet],
  ])
    if (page)
      await page
        .screenshot({
          path: path.join(output, `failure-${name}.png`),
          timeout: 5000,
        })
        .catch(() => {});
  throw error;
} finally {
  const shutdown = await closeElectron(instance);
  disarm();
  if (!shutdown.closed) { process.exitCode = 1; console.error("character-cards-smoke: Electron did not close by itself", shutdown); }
  const fakeClaude = await claude.close();
  if (report) report.fakeClaude = fakeClaude;
  await rm(temporary, { recursive: true, force: true });
  if (report)
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
}
