import assert from "node:assert/strict";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeIsolation } from "./lib/claude-smoke-fixture.mjs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, ".local", "bundled-assets-smoke");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
const catalog = JSON.parse(await readFile(path.join(appDirectory, "shared", "motion-catalog.json"), "utf8"));
assert.ok(!catalog.packs.some(pack => pack.id === "uka"), "Uka is excluded");
const pack = catalog.packs.find(pack => pack.id === "gene");
assert.ok(pack);
assert.equal(pack.motions.length, 40);
const optionalModel = process.env.MMD_TEST_MODEL ? await realpath(process.env.MMD_TEST_MODEL) : null;
// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({
  ...process.env,
  MMD_DESK_USER_DATA: profile,
});
delete env.ELECTRON_RUN_AS_NODE;
const startedAt = Date.now();
const checked = [];
const errors = [];
let instance;
let controls;
let pet;
let phase = "launch";
let report;
const watched = new WeakSet();

function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on("pageerror", error => errors.push(error.message));
  window.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
}

async function blockRemote() {
  return instance.evaluate(async ({ session }) => {
    const dispatcherKey = Symbol.for("undici.globalDispatcher.1");
    await fetch("data:text/plain,initialize-offline-test");
    if (!globalThis[dispatcherKey]?.dispatch) throw new Error("Node fetch dispatcher unavailable for offline test");
    globalThis.__bundledSmokeAttempts = [];
    globalThis[dispatcherKey] = {
      dispatch(options, handler) {
        globalThis.__bundledSmokeAttempts.push(String(options.origin) + options.path);
        handler.onError(new Error("BUNDLED_SMOKE_OFFLINE"));
        return false;
      },
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        globalThis.__bundledSmokeAttempts.push(details.url);
        callback({ cancel: true });
      },
    );
  });
}

async function launch() {
  const launchOptions = process.env.MMD_TEST_EXE
    ? { executablePath: process.env.MMD_TEST_EXE, args: [] }
    : { args: [appDirectory] };
  launchOptions.args.push(
    `--user-data-dir=${profile}`,
    "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost",
    "--proxy-server=http://127.0.0.1:9",
  );
  instance = await electron.launch({
    ...launchOptions,
    cwd: appDirectory,
    env,
    timeout: 30000,
  });
  instance.on("window", watch);
  await instance.firstWindow();
  const actualProfile = await instance.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(path.resolve(actualProfile), profile, "test must use its isolated profile; packaged tests need the explicit test-profile entry point");
  await blockRemote();
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const window of instance.windows()) watch(window);
    controls = instance.windows().find(window => window.url().includes("index.html") && !new URL(window.url()).searchParams.has("pet"));
    pet = instance.windows().find(window => window.url().includes("index.html") && new URL(window.url()).searchParams.has("pet"));
    if (controls && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet, "control and transparent companion windows exist");
  controls.setDefaultTimeout(15000);
  await controls.waitForFunction(() => !!window.desktop?.useBundledModel);
  // Reload behind the network guards so the renderer starts entirely offline.
  await Promise.all([controls.reload(), pet.reload()]);
  await controls.waitForSelector("#stage canvas");
  await navigateControlPage(controls, "appearance");
  await controls.waitForSelector("#motion-install-gene");
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

async function modelReady() {
  await controls.waitForFunction(() => {
    const status = document.querySelector("#stage-status")?.textContent ?? "";
    return status.includes("模型已就绪") || status.includes("VMD 播放中");
  }, null, { timeout: 45000 });
}

async function geneReady(expectedMotionId = "stand") {
  const motion = pack.motions.find(item => item.id === expectedMotionId);
  await waitForAsync(controls, async expected => {
    const current = await window.desktop.getSettings();
    return current.model?.name === "gene.pmx" &&
      current.motion?.path.replaceAll("\\", "/").endsWith(expected) &&
      current.motionLayers === undefined &&
      document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中");
  }, motion.relativePath, { timeout: 45000 });
  await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("VMD 播放中"), null, { timeout: 45000 });
}

async function activate(motion, layer = motionLayer(motion)) {
  const previous = await settings();
  await controls.locator("#motion-target-layer").selectOption(layer);
  await controls.locator("#motion-select-gene").selectOption(motion.id);
  await controls.locator("#motion-install-gene").click();
  await waitForAsync(controls, async expected => {
    const current = await window.desktop.getSettings();
    const asset = expected.layer === "pose" ? current.motion : current.motionLayers?.[expected.layer];
    const status = document.querySelector("#motion-status-gene")?.textContent ?? "";
    return asset?.path.replaceAll("\\", "/").endsWith(expected.relativePath) &&
      status.includes(`已启用 ${expected.name}`) && status.includes(expected.layerLabel) &&
      !document.querySelector("#motion-install-gene").disabled &&
      document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中");
  }, { ...motion, layer, layerLabel: layerLabels[layer] }, { timeout: 45000 });
  await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("VMD 播放中"), null, { timeout: 20000 });
  const current = await settings();
  for (const other of ["pose", "gesture", "expression"].filter(value => value !== layer))
    assert.deepEqual(layerAsset(current, other), layerAsset(previous, other), `activating ${layer} preserves ${other}`);
  return current;
}

async function remoteAttempts() {
  return instance.evaluate(() => [...(globalThis.__bundledSmokeAttempts ?? [])]);
}

async function snapshot(motionId) {
  const before = await settings();
  const current = await activate(pack.motions.find(motion => motion.id === motionId), "expression");
  assert.equal(current.motion?.name, "stand.vmd", "facial comparison uses the same Stand body pose");
  assert.deepEqual(current.motion, before.motion);
  assert.equal(current.motionLayers.gesture, null);
  assert.deepEqual(current.camera, before.camera);
  await controls.waitForTimeout(1000);
  const bytes = await controls.locator("#stage").screenshot({ path: path.join(output, `gene-${motionId}.png`) });
  return bytes.toString("base64");
}

try {
  await launch();
  phase = "fresh-default-gene";
  await geneReady();
  const initial = await settings();
  assert.equal(initial.model.name, "gene.pmx");
  assert.equal(initial.motion.name, "stand.vmd");
  assert.equal(initial.motionLayers, undefined, "fresh defaults retain legacy whole-VMD compatibility");
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
  assert.equal(await controls.locator("#motion-pack-uka").count(), 0);
  assert.equal(await controls.locator("#motion-pack-gene").count(), 1);
  await controls.waitForFunction(() => document.querySelector("#motion-count-gene")?.textContent === "40 / 40 已预装");
  const status = await controls.evaluate(() => window.desktop.getMotionLibrary());
  const geneStatus = status.packs.find(pack => pack.id === "gene");
  assert.equal(geneStatus.complete, true);
  assert.equal(geneStatus.bundled, true);
  assert.equal(geneStatus.installedMotionIds.length, 40);
  checked.push("fresh isolated profile loads bundled Gene and Stand in both windows; no Uka catalogue or UI");

  await controls.evaluate(async () => {
    const current = await window.desktop.getSettings();
    current.pet.followMouse = false;
    current.pet.breath = 0;
    current.voice.enabled = false;
    await window.desktop.saveSettings(current);
  });
  // Edit through the actual UI so its next queued save keeps the same marker.
  await navigateControlPage(controls, "providers");
  await controls.locator("#persona").fill("Isolated bundled asset smoke marker");
  await controls.locator("#persona").press("Tab");
  await controls.locator("#character-save").click();
  await waitForAsync(controls, async () => (await window.desktop.getSettings()).persona === "Isolated bundled asset smoke marker");
  await navigateControlPage(controls, "appearance");
  await controls.locator("#frame-full").click();
  phase = "offline-all-gene-motions";
  for (const motion of pack.motions) await activate(motion);
  assert.deepEqual(await remoteAttempts(), [], "40 bundled motion activations make no external requests");
  checked.push("all 40 Gene motions activate in their matching body or facial channel in both windows without external requests");

  await controls.locator("#motion-search-gene").fill("thinking");
  assert.equal(await controls.locator("#motion-select-gene option").count(), 1);
  assert.equal(await controls.locator("#motion-select-gene").inputValue(), "thinking");
  await controls.locator("#motion-search-gene").fill("");
  await controls.locator("#motion-pack-gene details").evaluate(element => { element.open = true; });
  assert.ok((await controls.locator("#motion-pack-gene .motion-pack-credit").textContent()).includes(pack.license.attribution));
  assert.ok((await controls.locator("#motion-pack-gene details").textContent()).includes("商标与设计权"));
  checked.push("English tags search and full author attribution, license and model-rights notice are visible");

  phase = "render-variation";
  await controls.locator("#use-bundled-model").click();
  await geneReady();
  await controls.locator("#frame-full").click();
  await controls.waitForTimeout(500); // Finish the explicit framing save before the fixed-camera comparison.
  const screenshots = { happy: await snapshot("happy"), angry: await snapshot("angry") };
  const pixels = await instance.evaluate(({ nativeImage }, images) => {
    const happy = nativeImage.createFromBuffer(Buffer.from(images.happy, "base64"));
    const angry = nativeImage.createFromBuffer(Buffer.from(images.angry, "base64"));
    const a = happy.toBitmap();
    const b = angry.toBitmap();
    let visible = 0;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] + a[i + 1] + a[i + 2] > 300) visible++;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) changed++;
    }
    return { visible, changed, size: happy.getSize() };
  }, screenshots);
  assert.ok(pixels.visible > 100 && pixels.changed > 20, "Gene renders and Happy/Angry visibly differ");
  checked.push("stage-only snapshots show distinct Happy/Angry expression layers over the same Stand body and camera");

  phase = "clear-only-body-pose";
  const beforeClear = await settings();
  await controls.locator("#motion-target-layer").selectOption("pose");
  await controls.locator("#clear-motion").click();
  await waitForAsync(controls, async () => (await window.desktop.getSettings()).motion === null);
  const afterClear = await settings();
  assert.deepEqual(afterClear.motionLayers.expression, beforeClear.motionLayers.expression,
    "the general clear button clears its selected body channel and keeps the independent face");
  assert.deepEqual(afterClear.motionLayers.gesture, beforeClear.motionLayers.gesture);
  checked.push("clearing the selected body channel preserves independent facial and gesture channels");

  phase = "privilege-boundary";
  const forbidden = await pet.evaluate(async () => {
    try { await window.desktop.useBundledModel(); return false; }
    catch { return true; }
  });
  assert.equal(forbidden, true);
  checked.push("companion window cannot invoke privileged bundled model selection");

  if (optionalModel) {
    phase = "preserve-user-model-on-restart";
    await instance.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, optionalModel);
    await controls.locator("#import-model").click();
    await waitForAsync(controls, async selected => {
      const current = await window.desktop.getSettings();
      return current.model?.path === selected && current.motion === null && current.motionLayers === undefined;
    }, optionalModel);
    await modelReady();
    assert.deepEqual(await remoteAttempts(), []);
    await instance.close();
    instance = null;
    await launch();
    await modelReady();
    const restoredPrivate = await settings();
    assert.equal(restoredPrivate.model.path, optionalModel, "existing user selection is preserved rather than overwritten by the bundled default");
    assert.equal(restoredPrivate.motion, null);
    assert.equal(restoredPrivate.motionLayers, undefined, "model replacement clears all former model's channels");
    checked.push("an explicit existing user model remains selected after restart");
  }

  phase = "restore-bundled-model";
  await controls.locator("#use-bundled-model").click();
  await geneReady();
  assert.equal((await settings()).persona, "Isolated bundled asset smoke marker", "selecting the bundled model preserves unrelated configuration");
  checked.push("Use bundled Gene restores its model and Stand while preserving unrelated settings");
  phase = "reset-defaults";
  await controls.evaluate(() => window.desktop.resetSettings());
  await geneReady();
  checked.push("reset settings restores the bundled Gene defaults");
  const finalAttempts = await remoteAttempts();
  assert.deepEqual(finalAttempts, []);
  assert.deepEqual(errors.filter(error => !error.includes("ERR_ABORTED")), []);
  report = {
    status: "PASS", appDirectory, packaged: !!process.env.MMD_TEST_EXE, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    testedMotions: pack.motions.map(motion => motion.id),
    testedLayers: pack.motions.map(motion => ({ id: motion.id, layer: motionLayer(motion) })), checked, pixels,
    externalRequests: finalAttempts, errors,
  };
  console.log(JSON.stringify({ ...report, testedMotions: report.testedMotions.length }, null, 2));
} catch (error) {
  report = {
    status: "FAILED", phase, appDirectory, packaged: !!process.env.MMD_TEST_EXE, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked,
    failure: error instanceof Error ? error.stack : String(error), errors,
  };
  throw error;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report ?? { status: "FAILED", phase, checked, errors }, null, 2));
  if (instance) await instance.close();
}
