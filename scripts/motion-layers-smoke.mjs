import assert from "node:assert/strict";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeIsolation } from "./lib/claude-smoke-fixture.mjs";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

// Disposable profile; no chat, agent, microphone, camera or system audio is started.
// Capture only the application stage, never the user's desktop or other windows.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, ".local/motion-layers-smoke");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
const settingsFile = path.join(profile, "settings.json");
const catalog = JSON.parse(await readFile(path.join(appDirectory, "shared/motion-catalog.json"), "utf8"));
// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
delete env.ELECTRON_RUN_AS_NODE;
const startedAt = Date.now();
const checked = [];
const screenshots = [];
const errors = [];
const remoteHistory = [];
const watched = new WeakSet();
let instance;
let controls;
let pet;
let petContentsId;
let phase = "launch";
let report;
let guardInstalled = false;
let testedExternalModel = false;
let externalModel = process.env.MMD_TEST_MODEL ?? "";

function redactExternal(value) {
  let result = value;
  for (const file of new Set([process.env.MMD_TEST_MODEL, externalModel].filter(Boolean))) {
    for (const variant of new Set([file, file.replaceAll("\\", "/"), file.replaceAll("\\", "\\\\")]))
      result = result.replaceAll(variant, "[external MMD]");
  }
  return result;
}

function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on("pageerror", error => errors.push({ kind: "pageerror", text: error.message }));
  window.on("console", message => {
    if (message.type() === "error") errors.push({ kind: "console", text: message.text() });
  });
}

// Await the IPC result explicitly; a Promise-returning injected predicate can be prematurely truthy.
async function poll(window, predicate, arg, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await window.evaluate(predicate, arg)) return;
    await window.waitForTimeout(50);
  }
  throw new Error(`Timed out awaiting application state during ${phase}`);
}

async function settings() { return controls.evaluate(() => window.desktop.getSettings()); }
async function savedBytes() { return readFile(settingsFile, "utf8"); }
function assets(value) {
  return { pose: value.motion, gesture: value.motionLayers?.gesture ?? null,
    expression: value.motionLayers ? value.motionLayers.expression : value.motion };
}
function assetNames(value) {
  return Object.fromEntries(Object.entries(assets(value)).map(([layer, asset]) => [layer, asset?.name ?? null]));
}
function unrelated(value) {
  return { modelPath: value.model?.path ?? null, provider: value.provider, persona: value.persona,
    voice: value.voice, voiceInput: value.voiceInput, agent: value.agent };
}
function fixture(packId, id) {
  const pack = catalog.packs.find(entry => entry.id === packId);
  const motion = pack?.motions.find(entry => entry.id === id);
  assert.ok(pack && motion, `Required motion exists: ${packId}/${id}`);
  return { pack, motion, suffix: `${pack.source}/${pack.id}/${pack.revision}/${motion.relativePath}` };
}
async function remoteAttempts() {
  return !instance || !guardInstalled ? [] : instance.evaluate(() => [...globalThis.__motionLayersRemoteRequests]);
}
async function petMotionRequests() {
  return instance.evaluate((_, id) => globalThis.__motionLayersAssetRequests.filter(request =>
    request.webContentsId === id && /\.vmd(?:[?#]|$)/i.test(request.url)), petContentsId);
}
async function previewPhase(expected) {
  await controls.waitForFunction(value => document.querySelector("#motion-preview-summary")?.dataset.phase === value, expected);
}
async function bothPlaying(layered = true) {
  const expected = layered ? "身体 / 手势 / 表情独立" : "VMD 播放中";
  await controls.waitForFunction(text => document.querySelector("#stage-status")?.textContent?.includes(text), expected);
  await pet.waitForFunction(text => document.querySelector("#pet-status")?.textContent?.includes(text), expected);
}
async function assertNames(expected) {
  await poll(controls, async names => {
    const value = await window.desktop.getSettings();
    const refs = { pose: value.motion, gesture: value.motionLayers?.gesture ?? null,
      expression: value.motionLayers ? value.motionLayers.expression : value.motion };
    return Object.entries(names).every(([layer, name]) => {
      if ((refs[layer]?.name ?? null) !== name) return false;
      const summary = document.querySelector(`#motion-layer-${layer}-name`)?.textContent ?? "";
      return name === null ? summary === "未启用" : summary.includes(name);
    });
  }, expected);
}
async function choose(layer, packId, motionId) {
  await controls.locator("#motion-target-layer").selectOption(layer);
  await controls.locator(`#motion-select-${packId}`).selectOption(motionId);
  await previewPhase("idle");
}
async function activate(layer, packId, motionId) {
  const entry = fixture(packId, motionId);
  await choose(layer, packId, motionId);
  await controls.locator(`#motion-install-${packId}`).click();
  await poll(controls, async expected => {
    const value = await window.desktop.getSettings();
    const ref = expected.layer === "pose" ? value.motion : value.motionLayers?.[expected.layer];
    return ref?.path.replaceAll("\\", "/").endsWith(expected.suffix)
      && document.querySelector(`#motion-status-${expected.packId}`)?.textContent?.includes(`已启用 ${expected.name}`)
      && !document.querySelector(`#motion-install-${expected.packId}`)?.disabled;
  }, { layer, suffix: entry.suffix, packId, name: entry.motion.name });
  await bothPlaying();
  return settings();
}
async function snapshot(label) {
  await controls.waitForTimeout(350);
  const name = `${label}.png`;
  await controls.locator("#stage").screenshot({ path: path.join(output, name) });
  screenshots.push(name);
}
async function assertTemporary(before, disk, petRequests) {
  assert.deepEqual(await settings(), before, "preview does not change host settings");
  assert.equal(await savedBytes(), disk, "preview does not change settings.json");
  assert.deepEqual(await petMotionRequests(), petRequests, "preview does not load a VMD in the pet");
  await bothPlaying();
}
async function assertMediaOff() {
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), {
    voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null,
  });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
}

async function launch() {
  guardInstalled = false;
  const options = process.env.MMD_TEST_EXE
    ? { executablePath: process.env.MMD_TEST_EXE, args: [] }
    : { args: [appDirectory] };
  options.args.push(`--user-data-dir=${profile}`,
    "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost", "--proxy-server=http://127.0.0.1:9");
  instance = await electron.launch({ ...options, cwd: appDirectory, env, timeout: 30000 });
  instance.on("window", watch);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath("userData"))), profile);
  await instance.evaluate(async ({ session }) => {
    const key = Symbol.for("undici.globalDispatcher.1");
    await fetch("data:text/plain,motion-layers-offline-guard");
    if (!globalThis[key]?.dispatch) throw new Error("Node fetch dispatcher unavailable for offline verification");
    globalThis.__motionLayersRemoteRequests = [];
    globalThis.__motionLayersAssetRequests = [];
    globalThis[key] = { dispatch(options, handler) {
      globalThis.__motionLayersRemoteRequests.push(String(options.origin) + options.path);
      handler.onError(new Error("MOTION_LAYERS_SMOKE_OFFLINE"));
      return false;
    } };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const remote = /^https?:/i.test(details.url);
      if (remote) globalThis.__motionLayersRemoteRequests.push(details.url);
      if (details.url.startsWith("mmd-asset:")) globalThis.__motionLayersAssetRequests.push({
        url: details.url, webContentsId: details.webContentsId,
      });
      callback({ cancel: remote });
    });
  });
  guardInstalled = true;
  controls = undefined;
  pet = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const window of instance.windows()) {
      watch(window);
      try {
        const url = new URL(window.url());
        if (!url.pathname.endsWith("/index.html")) continue;
        if (url.searchParams.has("pet")) pet = window;
        else controls = window;
      } catch { /* Auxiliary windows do not participate. */ }
    }
    if (controls && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet, "controls and pet windows exist");
  controls.setDefaultTimeout(15000);
  pet.setDefaultTimeout(15000);
  petContentsId = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => {
    try { return new URL(window.webContents.getURL()).searchParams.has("pet"); } catch { return false; }
  })?.webContents.id);
  assert.ok(Number.isInteger(petContentsId));
  await Promise.all([controls.reload(), pet.reload()]);
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => {
      const url = new URL(win.webContents.getURL());
      return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet');
    });
    window?.show(); window?.focus(); window?.webContents.focus();
  });
  await controls.bringToFront();
  await controls.waitForFunction(() => typeof window.desktop?.clearMotionLayer === "function");
  await navigateControlPage(controls, "appearance");
  await controls.waitForSelector("#motion-target-layer");
  await bothPlaying(false);
  await controls.waitForFunction(() => !document.querySelector("#motion-install-gene")?.disabled);
}

try {
  await launch();
  const initial = await settings();
  const initialCards = await controls.evaluate(() => window.desktop.getCharacterCards());
  assert.equal(initial.model?.name, "gene.pmx");
  assert.equal(initial.motion?.name, "stand.vmd");
  assert.equal(initial.motionLayers, undefined, "the old whole-VMD configuration starts in compatible mode");
  await assertMediaOff();
  await controls.evaluate(async () => {
    const value = await window.desktop.getSettings();
    value.pet.followMouse = false;
    value.pet.breath = 0;
    await window.desktop.saveSettings(value);
  });
  await controls.locator("#frame-full").click();
  await controls.waitForTimeout(500);
  checked.push("fresh isolated Gene + Stand profile, compatible legacy playback, all media off");

  phase = "activate-three-channels";
  await activate("pose", "gene", "stand");
  await activate("gesture", "mpi-embm-gestures", "conversation-neutral");
  await activate("expression", "gene", "happy");
  const three = await settings();
  await assertNames({ pose: "stand.vmd", gesture: "conversation-neutral.vmd", expression: "happy.vmd" });
  assert.deepEqual(unrelated(three), unrelated(initial));
  await snapshot("stand-conversation-happy");
  await controls.locator(".motion-layers").screenshot({ path: path.join(output, "three-channel-controls.png") });
  screenshots.push("three-channel-controls.png");
  checked.push("UI enables Stand body, MPI conversation gesture and Happy expression; three summaries and both stages agree");

  phase = "change-pose-preserves-overlays";
  const changedPose = await activate("pose", "100style-idles", "arms-folded-idle");
  assert.deepEqual(changedPose.motionLayers, three.motionLayers);
  await assertNames({ pose: "arms-folded-idle.vmd", gesture: "conversation-neutral.vmd", expression: "happy.vmd" });
  await snapshot("changed-pose-same-gesture-face");
  checked.push("changing the body channel retains gesture and expression assets");

  phase = "change-expression-preserves-body-and-gesture";
  const changedFace = await activate("expression", "gene", "angry");
  assert.deepEqual(changedFace.motion, changedPose.motion);
  assert.deepEqual(changedFace.motionLayers.gesture, changedPose.motionLayers.gesture);
  await assertNames({ pose: "arms-folded-idle.vmd", gesture: "conversation-neutral.vmd", expression: "angry.vmd" });
  await snapshot("same-body-gesture-angry-face");
  checked.push("changing the expression channel retains body and gesture assets");

  phase = "clear-only-gesture";
  await controls.locator("#motion-layer-gesture-clear").click();
  await assertNames({ pose: "arms-folded-idle.vmd", gesture: null, expression: "angry.vmd" });
  await bothPlaying();
  const cleared = await settings();
  assert.deepEqual(cleared.motion, changedFace.motion);
  assert.deepEqual(cleared.motionLayers.expression, changedFace.motionLayers.expression);
  await snapshot("gesture-cleared-body-face-retained");
  checked.push("clearing gesture preserves body and expression and restores the body channel's own upper-body pose");

  phase = "temporary-expression-preview";
  await activate("gesture", "mpi-embm-gestures", "conversation-neutral");
  await choose("expression", "gene", "smile");
  const beforePreview = await settings();
  const beforeDisk = await savedBytes();
  const beforePetRequests = await petMotionRequests();
  await controls.locator("#motion-preview-gene").click();
  await previewPhase("playing");
  assert.ok((await controls.locator("#motion-preview-summary").textContent()).includes("面部表情"));
  await assertNames(assetNames(beforePreview));
  await snapshot("temporary-smile-preview");
  await assertTemporary(beforePreview, beforeDisk, beforePetRequests);
  await controls.locator("#motion-preview-stop").click();
  await previewPhase("idle");
  await assertTemporary(beforePreview, beforeDisk, beforePetRequests);
  checked.push("expression preview is temporary in controls, retains saved channel summaries, changes no disk/pet motion and restores on stop");

  phase = "host-privilege-and-forged-assets";
  const rejected = await controls.evaluate(async () => {
    const results = [];
    for (const operation of [
      () => window.desktop.clearMotionLayer("../expression"),
      () => window.desktop.installMotionPack("gene", "happy", "face"),
      () => window.desktop.selectAsset("motion", { layer: "expression" }),
    ]) {
      try { await operation(); results.push(false); } catch { results.push(true); }
    }
    return results;
  });
  assert.deepEqual(rejected, [true, true, true]);
  const petRejected = await pet.evaluate(async () => {
    const results = [];
    for (const operation of [
      () => window.desktop.clearMotionLayer("gesture"),
      () => window.desktop.previewMotion("gene", "happy"),
      () => window.desktop.installMotionPack("gene", "happy", "expression"),
    ]) {
      try { await operation(); results.push(false); } catch { results.push(true); }
    }
    return results;
  });
  assert.deepEqual(petRejected, [true, true, true]);
  const beforeForged = await settings();
  await controls.evaluate(async () => {
    const value = await window.desktop.getSettings();
    const forged = { path: "C:\\unauthorized-motion-layer\\face.vmd", name: "forged.vmd", url: "file:///unauthorized/face.vmd" };
    value.motion = forged;
    value.motionLayers = { gesture: forged, expression: forged };
    await window.desktop.saveSettings(value);
  });
  assert.deepEqual(await settings(), beforeForged, "renderer paths cannot grant or replace a host-authorized layer");
  await assertNames(assetNames(beforeForged));
  checked.push("invalid layers and forged asset paths are refused; pet cannot clear, preview or enable motions");

  phase = "late-save-does-not-clear-new-overlays";
  const beforeStale = await settings();
  await controls.evaluate(async old => {
    const current = await window.desktop.getSettings();
    current.motionLayers = { gesture: null, expression: null };
    await window.desktop.saveSettings(current, { model: old.model?.path ?? null, motion: old.motion?.path ?? null });
  }, initial);
  assert.deepEqual(await settings(), beforeStale);
  checked.push("a stale legacy save without channel baselines cannot clear the new gesture or expression");

  phase = "restart-persistence";
  const persisted = await settings();
  const persistedNames = assetNames(persisted);
  remoteHistory.push(...await remoteAttempts());
  await instance.close();
  instance = undefined;
  await launch();
  await bothPlaying();
  await assertNames(persistedNames);
  const restarted = await settings();
  for (const layer of ["pose", "gesture", "expression"])
    assert.equal(assets(restarted)[layer]?.path, assets(persisted)[layer]?.path, `${layer} persists and regrants after restart`);
  assert.deepEqual(unrelated(restarted), unrelated(initial));
  assert.deepEqual(await controls.evaluate(() => window.desktop.getCharacterCards()), initialCards);
  await assertMediaOff();
  await snapshot("three-channels-after-restart");
  checked.push("restart restores and regrants all three channels in both windows while provider/cards/media stay unchanged");

  if (externalModel) {
    phase = "external-model-native-import";
    if (!path.isAbsolute(externalModel) || ![".pmx", ".pmd"].includes(path.extname(externalModel).toLowerCase()))
      throw new Error("MMD_TEST_MODEL must identify an existing absolute PMX/PMD file.");
    try {
      externalModel = await realpath(externalModel);
      if (!(await stat(externalModel)).isFile()) throw new Error("Not a file");
    } catch { throw new Error("The authorized MMD_TEST_MODEL file is unavailable."); }
    await instance.evaluate(({ dialog }, modelFile) => {
      globalThis.__motionLayersOriginalDialog = dialog.showOpenDialog;
      dialog.showOpenDialog = async (...args) => {
        if (!args.at(-1)?.title?.includes("选择 MMD 模型")) throw new Error("Unexpected native picker in external-model smoke");
        return { canceled: false, filePaths: [modelFile] };
      };
    }, externalModel);
    try {
      await controls.locator("#import-model").click();
      await poll(controls, async expected => {
        const value = await window.desktop.getSettings();
        return value.model?.path === expected && value.motion === null && !value.motionLayers
          && document.querySelector("#stage-status")?.textContent?.includes("模型已就绪");
      }, externalModel);
      await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("模型已就绪"));
    } finally {
      await instance.evaluate(({ dialog }) => {
        dialog.showOpenDialog = globalThis.__motionLayersOriginalDialog;
        delete globalThis.__motionLayersOriginalDialog;
      });
    }
    await assertNames({ pose: null, gesture: null, expression: null });
    await controls.locator("#frame-full").click();
    await controls.waitForTimeout(500);
    await activate("pose", "gene", "stand");
    await activate("gesture", "mpi-embm-gestures", "conversation-neutral");
    await activate("expression", "gene", "happy");
    await assertNames({ pose: "stand.vmd", gesture: "conversation-neutral.vmd", expression: "happy.vmd" });
    await snapshot("external-model-three-channels");
    await controls.locator(".motion-layers").screenshot({ path: path.join(output, "external-model-channel-controls.png") });
    screenshots.push("external-model-channel-controls.png");
    testedExternalModel = true;
    checked.push("authorized external MMD imports through native picker, clears former layers, then plays Stand + conversation + Happy in both windows");

    phase = "external-model-clear-body-preserves-overlays";
    await controls.locator("#motion-layer-pose-clear").click();
    await assertNames({ pose: null, gesture: "conversation-neutral.vmd", expression: "happy.vmd" });
    await bothPlaying();
    await snapshot("external-model-body-cleared");
    checked.push("external MMD body clear preserves gesture and expression");

    phase = "external-model-clear-face-preserves-gesture";
    await controls.locator("#motion-layer-expression-clear").click();
    await assertNames({ pose: null, gesture: "conversation-neutral.vmd", expression: null });
    await bothPlaying();
    await snapshot("external-model-face-cleared-gesture-retained");
    await assertMediaOff();
    checked.push("external MMD expression clear preserves gesture; all media remain off");
  }

  remoteHistory.push(...await remoteAttempts());
  assert.deepEqual(remoteHistory, []);
  assert.deepEqual(errors.filter(error => !error.text.includes("ERR_ABORTED")), []);
  report = { status: "PASS", packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, screenshots,
    genePersistedChannels: persistedNames, finalChannels: assetNames(await settings()), testedExternalModel,
    remoteRequests: remoteHistory, errors,
    limits: ["Bone/property precedence and uninterrupted action time are asserted by motion-layers unit tests; stage images require visual review and do not prove compatibility with every MMD."],
  };
  console.log(JSON.stringify({ status: report.status, checked: checked.length, elapsedSeconds: report.elapsedSeconds,
    finalChannels: report.finalChannels, testedExternalModel, remoteRequests: remoteHistory, errors, output }, null, 2));
} catch (error) {
  const windowState = instance ? await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ url: win.webContents.getURL(), visible: win.isVisible(), minimized: win.isMinimized(), bounds: win.getBounds() }))).catch(() => []) : [];
  const controlState = controls ? await controls.evaluate(() => {
    const button = document.querySelector('#control-navigation [data-nav-group][data-nav-node="appearance"]');
    return { url: location.href, hidden: document.hidden, width: innerWidth, height: innerHeight, bodyClass: document.body.className, rect: button?.getBoundingClientRect().toJSON(), display: button ? getComputedStyle(button).display : null };
  }).catch(() => null) : null;
  if (controls) await controls.screenshot({ path: path.join(output, 'failure-app.png') }).catch(() => {});
  report = { status: "FAILED", phase, packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    windowState, controlState,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, screenshots,
    remoteRequests: [...remoteHistory, ...await remoteAttempts().catch(() => [])], errors, testedExternalModel,
    failure: redactExternal(error instanceof Error ? error.stack : String(error)) };
  const failure = new Error(`Motion layers smoke failed during ${phase}`);
  failure.stack = report.failure;
  throw failure;
} finally {
  try { await writeFile(path.join(output, "report.json"), redactExternal(JSON.stringify(report ?? { status: "FAILED", phase, errors }, null, 2)) + "\n"); }
  finally { if (instance) await instance.close(); }
}
