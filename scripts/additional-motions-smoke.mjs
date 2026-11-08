import assert from "node:assert/strict";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeIsolation } from "./lib/claude-smoke-fixture.mjs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";

// Stage-only captures and the temporary profile remain private and ignored.
// This harness never sends a chat, starts an agent or enables media capture.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, ".local", "additional-motions-smoke");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
const catalog = JSON.parse(await readFile(path.join(appDirectory, "shared", "motion-catalog.json"), "utf8"));
const bundledManifest = JSON.parse(await readFile(path.join(appDirectory, "shared", "bundled-assets.json"), "utf8"));
const gene = catalog.packs.find(pack => pack.id === "gene");
const additional = catalog.packs.filter(pack => pack.id !== "gene");
assert.equal(catalog.schemaVersion, 1);
assert.ok(gene, "Gene remains in the catalog");
assert.equal(gene.motions.length, 40);
assert.equal(bundledManifest.defaultMotionId, "stand");
assert.equal(additional.reduce((count, pack) => count + pack.motions.length, 0), 13,
  "the reviewed batch contains 13 additional motions");
assert.equal(catalog.packs.some(pack => pack.id === "uka"), false);
for (const pack of catalog.packs) {
  assert.match(pack.id, /^[a-z0-9-]+$/);
  assert.match(pack.source, /^[a-z0-9-]+$/);
  assert.match(pack.revision, /^[a-f0-9]{40}$/);
  for (const motion of pack.motions) {
    assert.match(motion.id, /^[a-z0-9-]+$/);
    assert.doesNotMatch(motion.originalPath, /(^|[\\/])(FNA|UNA)([\\/._-]|$)/i,
      "noncommercial FNA and UNA are excluded");
  }
  if (pack.id !== "gene") {
    // T-211: the project's own pack (Codex's actions) carries the repository licence and a provenance note instead.
    const owned = pack.id === "soft-hearts-actions";
    assert.equal(pack.bundledOnly, true);
    assert.equal(pack.license.id, owned ? "MIT" : "CC-BY-4.0");
    assert.ok(pack.license.attribution.trim());
    assert.ok(pack.modifications.trim());
    for (const name of owned ? ["source.json", "provenance.md"] : ["source.json", "attribution.txt", "cc-by-4.0.txt"])
      assert.ok(pack.documents.some(document => document.relativePath === `metadata/${name}`));
  }
}

// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
delete env.ELECTRON_RUN_AS_NODE;
const parser = new MMDParser.Parser();
const startedAt = Date.now();
const errors = [];
const testedMotions = [];
const checked = [];
const metadata = [];
const searches = [];
const watched = new WeakSet();
let instance;
let controls;
let pet;
let initial;
let initialCards;
let baseline;
let phase = "launch";
let report;
let guardInstalled = false;

function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on("pageerror", error => errors.push({ kind: "pageerror", text: error.message, window: window.url() }));
  window.on("console", message => {
    if (message.type() === "error") errors.push({ kind: "console", text: message.text(), window: window.url() });
  });
}

async function blockNetwork() {
  await instance.evaluate(async ({ session }) => {
    const key = Symbol.for("undici.globalDispatcher.1");
    await fetch("data:text/plain,initialize-additional-offline-test");
    if (!globalThis[key]?.dispatch) throw new Error("Node fetch dispatcher unavailable for offline test");
    globalThis.__additionalSmokeAttempts = [];
    globalThis[key] = {
      dispatch(options, handler) {
        globalThis.__additionalSmokeAttempts.push({ kind: "node", url: String(options.origin) + options.path });
        handler.onError(new Error("ADDITIONAL_MOTIONS_SMOKE_OFFLINE"));
        return false;
      },
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        globalThis.__additionalSmokeAttempts.push({ kind: "electron", url: details.url });
        callback({ cancel: true });
      },
    );
  });
  guardInstalled = true;
}

async function networkAttempts() {
  if (!instance || !guardInstalled) return [];
  return instance.evaluate(() => [...(globalThis.__additionalSmokeAttempts ?? [])]);
}

// Playwright's injected poller treats a Promise as truthy; explicitly await async IPC predicates.
async function waitForAsync(window, predicate, arg, { timeout = 45000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.evaluate(predicate, arg)) return;
    await window.waitForTimeout(50);
  }
  throw new Error('Timed out awaiting the actual asynchronous application state.');
}

async function settings() {
  return controls.evaluate(() => window.desktop.getSettings());
}

const layerLabels = { pose: "身体姿态", gesture: "手势", expression: "面部表情" };
const motionLayer = motion => motion.category === "expression" ? "expression" : motion.category === "gesture" ? "gesture" : "pose";
function layerAsset(value, layer) {
  return layer === "pose" ? value.motion : layer === "expression" && !value.motionLayers ? value.motion : value.motionLayers?.[layer] ?? null;
}

async function assertMediaOff() {
  const state = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.deepEqual(state, {
    voiceInput: false, screenSharing: false, cameraSharing: false,
    voiceOwner: null, cameraOwner: null,
  }, "motion browsing must leave all media sharing off");
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false },
    "motion browsing must leave system audio analysis off");
  return state;
}

function unrelated(current) {
  return { provider: current.provider, persona: current.persona, voice: current.voice,
    voiceInput: current.voiceInput, agent: current.agent };
}

function sanitized(current) {
  const result = structuredClone(current);
  for (const config of [result.provider, result.voiceInput])
    if (config && Object.hasOwn(config, "apiKey")) config.apiKey = config.apiKey ? "[redacted]" : "";
  return result;
}

async function installStatusObserver(window, selector) {
  await window.evaluate(target => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`Missing stage status: ${target}`);
    globalThis.__additionalSmokeStatusEvents = [];
    new MutationObserver(() => {
      globalThis.__additionalSmokeStatusEvents.push(element.textContent ?? "");
    }).observe(element, { childList: true, characterData: true, subtree: true });
  }, selector);
}

async function launch() {
  const options = process.env.MMD_TEST_EXE
    ? { executablePath: process.env.MMD_TEST_EXE, args: [] }
    : { args: [appDirectory] };
  options.args.push(`--user-data-dir=${profile}`,
    "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost", "--proxy-server=http://127.0.0.1:9");
  instance = await electron.launch({ ...options, cwd: appDirectory, env, timeout: 30000 });
  instance.on("window", watch);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath("userData"))), profile,
    "the app must use this harness's fresh profile");
  await blockNetwork();
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const window of instance.windows()) watch(window);
    controls = instance.windows().find(window => window.url().includes("index.html") && !new URL(window.url()).searchParams.has("pet"));
    pet = instance.windows().find(window => window.url().includes("index.html") && new URL(window.url()).searchParams.has("pet"));
    if (controls && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet, "control and companion windows exist");
  controls.setDefaultTimeout(15000);
  pet.setDefaultTimeout(15000);
  await controls.waitForFunction(() => !!window.desktop?.getMotionLibrary);
  await Promise.all([controls.reload(), pet.reload()]);
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html') && !new URL(win.webContents.getURL()).searchParams.has('pet'));
    window?.show(); window?.focus();
  });
  await controls.bringToFront();
  await controls.waitForSelector("#stage canvas");
  await navigateControlPage(controls, "appearance");
  await controls.waitForSelector("#motion-install-gene");
}

async function geneReady() {
  const expected = `${gene.source}/${gene.id}/${gene.revision}/motions/pose/stand.vmd`;
  await waitForAsync(controls, async suffix => {
    const value = await window.desktop.getSettings();
    return value.model?.name === "gene.pmx" && value.motion?.path.replaceAll("\\", "/").endsWith(suffix) &&
      value.motionLayers === undefined &&
      document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中");
  }, expected, { timeout: 45000 });
  await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("VMD 播放中"),
    null, { timeout: 45000 });
}

async function activate(pack, motion) {
  const layer = motionLayer(motion);
  const previous = await settings();
  await Promise.all([controls, pet].map(window => window.evaluate(() => {
    globalThis.__additionalSmokeStatusEvents = [];
  })));
  await controls.locator("#motion-target-layer").selectOption(layer);
  await controls.locator(`#motion-select-${pack.id}`).selectOption(motion.id);
  await controls.locator(`#motion-install-${pack.id}`).click();
  const suffix = `${pack.source}/${pack.id}/${pack.revision}/${motion.relativePath}`;
  await waitForAsync(controls, async expected => {
    const value = await window.desktop.getSettings();
    const asset = expected.layer === "pose" ? value.motion : value.motionLayers?.[expected.layer];
    const status = document.querySelector(`#motion-status-${expected.packId}`)?.textContent ?? "";
    return asset?.path.replaceAll("\\", "/").endsWith(expected.suffix) &&
      status.includes(`已启用 ${expected.name}`) && status.includes(expected.layerLabel) &&
      !document.querySelector(`#motion-install-${expected.packId}`)?.disabled &&
      document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中");
  }, { suffix, packId: pack.id, name: motion.name, layer, layerLabel: layerLabels[layer] }, { timeout: 45000 });
  const current = await settings();
  if (layerAsset(previous, layer)?.url !== layerAsset(current, layer)?.url) {
    for (const window of [controls, pet]) {
      await window.waitForFunction(() =>
        globalThis.__additionalSmokeStatusEvents.some(text => text.includes("VMD 播放中")),
      null, { timeout: 45000 });
    }
  }
  await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("VMD 播放中"),
    null, { timeout: 45000 });
  assert.equal(current.model.path, initial.model.path, "selecting an action preserves Gene");
  for (const other of ["pose", "gesture", "expression"].filter(value => value !== layer))
    assert.deepEqual(layerAsset(current, other), layerAsset(previous, other), `activating ${layer} preserves ${other}`);
  assert.deepEqual(unrelated(current), unrelated(baseline), "selecting an action preserves unrelated settings");
  return current;
}

async function sourceMetadata(pack) {
  return instance.evaluate(({ app }, entry) => {
    const fs = process.getBuiltinModule("fs");
    const nativePath = process.getBuiltinModule("path");
    const root = nativePath.join(app.getAppPath(), "assets", "bundled", entry.source, entry.id, entry.revision, "metadata");
    return {
      source: JSON.parse(fs.readFileSync(nativePath.join(root, "source.json"), "utf8")),
      attribution: fs.readFileSync(nativePath.join(root, "attribution.txt"), "utf8"),
      licenseBytes: fs.statSync(nativePath.join(root, "cc-by-4.0.txt")).size,
    };
  }, { source: pack.source, id: pack.id, revision: pack.revision });
}

async function parsedMotion(asset, motion) {
  const base64 = await instance.evaluate((_, file) => process.getBuiltinModule("fs").readFileSync(file).toString("base64"), asset.path);
  const bytes = Buffer.from(base64, "base64");
  const value = parser.parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  assert.equal(value.metadata.motionCount, motion.boneFrames);
  assert.equal(value.metadata.morphCount, motion.morphFrames);
  assert.equal(value.metadata.cameraCount, 0, "no camera motion is bundled");
  assert.ok(value.motions.every(frame => [...frame.position, ...frame.rotation].every(Number.isFinite)));
  assert.ok(value.morphs.every(frame => Number.isFinite(frame.weight)));
  const lastFrame = Math.max(0, ...value.motions.map(frame => frame.frameNum), ...value.morphs.map(frame => frame.frameNum));
  assert.equal(lastFrame, motion.durationFrames);
  return { ...value.metadata, lastFrame, durationSeconds: lastFrame / 30,
    uniqueBoneNames: new Set(value.motions.map(frame => frame.boneName)).size,
    uniqueMorphNames: new Set(value.morphs.map(frame => frame.morphName)).size,
    finiteValues: true };
}

async function capturePair(pack, motion) {
  const directory = path.join(output, pack.id);
  await mkdir(directory, { recursive: true });
  if (motion.category === "dance") {
    // Review wide poses without changing the product's rule that motion selection preserves the user's camera.
    await controls.evaluate(async () => {
      const value = await window.desktop.getSettings();
      value.camera.distance *= 1.4;
      await window.desktop.saveSettings(value);
    });
  }
  await controls.waitForTimeout(700);
  const a = await controls.locator("#stage").screenshot({ path: path.join(directory, `${motion.id}-a.png`) });
  await controls.waitForTimeout(motion.category === "dance" ? 6000 : 600);
  const b = await controls.locator("#stage").screenshot({ path: path.join(directory, `${motion.id}-b.png`) });
  const pixels = await instance.evaluate(({ nativeImage }, images) => {
    const first = nativeImage.createFromBuffer(Buffer.from(images.a, "base64"));
    const second = nativeImage.createFromBuffer(Buffer.from(images.b, "base64"));
    const left = first.toBitmap();
    const right = second.toBitmap();
    let changedPixels = 0;
    for (let offset = 0; offset < Math.min(left.length, right.length); offset += 4) {
      if (Math.abs(left[offset] - right[offset]) + Math.abs(left[offset + 1] - right[offset + 1]) +
        Math.abs(left[offset + 2] - right[offset + 2]) > 15) changedPixels++;
    }
    return { size: first.getSize(), sameSize: left.length === right.length, changedPixels };
  }, { a: a.toString("base64"), b: b.toString("base64") });
  assert.ok(pixels.sameSize && pixels.size.width > 0 && pixels.size.height > 0);
  return { a: `${pack.id}/${motion.id}-a.png`, b: `${pack.id}/${motion.id}-b.png`, ...pixels };
}

async function checkSearchAndAttribution(pack) {
  const card = controls.locator(`#motion-pack-${pack.id}`);
  const details = card.locator("details");
  await details.locator("summary").click();
  await card.locator(".motion-pack-credit").waitFor({ state: "visible" });
  assert.ok((await card.locator(".motion-pack-credit").textContent()).includes(pack.license.attribution));
  const text = await details.textContent();
  for (const required of [pack.license.id, pack.license.url, pack.sourceUrl, pack.revision])
    assert.ok(text.includes(required), `${pack.id} displays ${required}`);
  if (pack.id === "gene") return;
  assert.ok(text.includes(pack.modifications));
  for (const category of new Set(pack.motions.map(motion => motion.category))) {
    await controls.locator(`#motion-search-${pack.id}`).fill(category);
    const found = await controls.locator(`#motion-select-${pack.id} option`).evaluateAll(options => options.map(option => option.value));
    assert.deepEqual(found.sort(), pack.motions.filter(motion => motion.category === category).map(motion => motion.id).sort());
    searches.push({ packId: pack.id, query: category, kind: "category", found });
  }
  const tag = pack.motions[0].tags.at(-1);
  assert.ok(tag, "each additional motion has tags");
  await controls.locator(`#motion-search-${pack.id}`).fill(tag);
  const found = await controls.locator(`#motion-select-${pack.id} option`).evaluateAll(options => options.map(option => option.value));
  assert.ok(found.includes(pack.motions[0].id), `${pack.id} is searchable by tag ${tag}`);
  searches.push({ packId: pack.id, query: tag, kind: "tag", found });
  await controls.locator(`#motion-search-${pack.id}`).fill("");
  await details.locator("summary").click();
}

try {
  await launch();
  phase = "fresh-defaults";
  await geneReady();
  initial = await settings();
  initialCards = await controls.evaluate(() => window.desktop.getCharacterCards());
  assert.equal(initial.model.name, "gene.pmx");
  assert.equal(initial.motion.name, "stand.vmd");
  assert.equal(initial.provider.kind, "claude");
  assert.equal(initial.voice.enabled, false);
  await assertMediaOff();
  checked.push("fresh isolated profile defaults to Gene + Stand, Claude, voice/media off");
  const status = await controls.evaluate(() => window.desktop.getMotionLibrary());
  assert.equal(status.packs.length, catalog.packs.length);
  for (const pack of catalog.packs) {
    const installed = status.packs.find(value => value.id === pack.id);
    assert.ok(installed?.complete && installed.bundled, `${pack.id} is completely bundled`);
    assert.deepEqual([...installed.installedMotionIds].sort(), pack.motions.map(motion => motion.id).sort());
    await controls.waitForFunction(expected => document.querySelector(`#motion-count-${expected.id}`)?.textContent ===
      `${expected.count} / ${expected.count} 已预装`, { id: pack.id, count: pack.motions.length });
    await checkSearchAndAttribution(pack);
    if (pack.id !== "gene") {
      const record = await sourceMetadata(pack);
      assert.equal(record.source.packId, pack.id);
      assert.equal(record.source.revision, pack.revision);
      assert.equal(record.source.license.id, "CC-BY-4.0");
      assert.ok(record.attribution.includes(pack.license.attribution));
      assert.ok(record.licenseBytes > 10000, "the full license accompanies the motions");
      for (const motion of record.source.motions)
        assert.doesNotMatch(motion.originalPath, /(^|[\\/])(FNA|UNA)([\\/._-]|$)/i);
      metadata.push({ packId: pack.id, ...record });
    }
  }
  checked.push("all packs are bundled; source, author, CC BY 4.0 and modification records are visible; categories/tags search");

  // Disable only procedural movement in the disposable profile for useful images.
  await controls.evaluate(async () => {
    const value = await window.desktop.getSettings();
    value.pet.followMouse = false;
    value.pet.breath = 0;
    await window.desktop.saveSettings(value);
  });
  await controls.locator("#frame-full").click();
  baseline = await settings();
  assert.deepEqual(unrelated(baseline), unrelated(initial));
  await installStatusObserver(controls, "#stage-status");
  await installStatusObserver(pet, "#pet-status");
  phase = "all-motion-activations";
  for (const pack of catalog.packs) {
    if (pack.id !== "gene") {
      // Review each source with Stand underneath, rather than retaining the preceding source's gesture.
      await controls.locator("#use-bundled-model").click();
      await geneReady();
      await controls.locator("#frame-full").click();
    }
    for (const motion of pack.motions) {
      phase = `activate-${pack.id}-${motion.id}`;
      const current = await activate(pack, motion);
      const layer = motionLayer(motion);
      const active = layerAsset(current, layer);
      assert.ok(active);
      const record = { packId: pack.id, motionId: motion.id, category: motion.category, layer,
        activePath: active.path, controlsPlaying: true, companionPlaying: true };
      if (pack.id !== "gene") {
        record.parsed = await parsedMotion(active, motion);
        record.snapshots = await capturePair(pack, motion);
      }
      testedMotions.push(record);
    }
  }
  checked.push("all 40 Gene motions and all 13 additional motions activate in their matching body, gesture or facial channel in both windows offline");

  phase = "restore-default-motion";
  await controls.locator("#use-bundled-model").click();
  await geneReady();
  const final = await settings();
  assert.deepEqual(unrelated(final), unrelated(initial), "restoring Gene preserves provider, persona, voice and agent settings");
  assert.deepEqual(await controls.evaluate(() => window.desktop.getCharacterCards()), initialCards,
    "action browsing preserves the active character card and its text");
  const runtime = await assertMediaOff();
  const attempts = await networkAttempts();
  assert.deepEqual(attempts, [], "motion activation never requests external services");
  assert.deepEqual(errors.filter(error => !error.text.includes("ERR_ABORTED")), []);
  checked.push("Gene + Stand restored; provider, character cards and media-off state preserved");
  report = {
    status: "PASS", packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked,
    initialSettings: sanitized(initial), finalSettings: sanitized(final), runtime,
    counts: { packs: catalog.packs.length, gene: gene.motions.length,
      additional: additional.reduce((count, pack) => count + pack.motions.length, 0), tested: testedMotions.length },
    testedMotions, searches, metadata, networkAttempts: attempts, errors,
    visualReview: "Stage-only image pairs require visual review; loading and pixel changes alone do not establish retargeting quality.",
  };
  console.log(JSON.stringify({ status: report.status, counts: report.counts,
    elapsedSeconds: report.elapsedSeconds, networkAttempts: attempts, errors, output }, null, 2));
} catch (error) {
  const uiState = await controls?.evaluate(() => ({
    selected: document.querySelector('#motion-select-gene')?.value,
    target: document.querySelector('#motion-target-layer')?.value,
    statuses: [...document.querySelectorAll('.motion-pack-status')].map(node => node.textContent),
    stage: document.querySelector('#stage-status')?.textContent,
    toast: document.querySelector('#toast')?.textContent,
    focused: document.hasFocus(),
  })).catch(() => null);
  report = {
    status: "FAILED", phase, packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, testedMotions, searches, metadata,
    networkAttempts: await networkAttempts().catch(() => []), errors, uiState,
    failure: error instanceof Error ? error.stack : String(error),
  };
  throw error;
} finally {
  try {
    await writeFile(path.join(output, "report.json"), JSON.stringify(report ?? { status: "FAILED", phase, errors }, null, 2) + "\n");
  } finally {
    if (instance) await instance.close();
  }
}
