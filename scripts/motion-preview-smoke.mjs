import assert from "node:assert/strict";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeIsolation } from "./lib/claude-smoke-fixture.mjs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

// Uses a disposable profile; only stage images are captured. No chats, agents or media are started.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, ".local/motion-preview-smoke");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
const settingsFile = path.join(profile, "settings.json");
const catalog = JSON.parse(await readFile(path.join(appDirectory, "shared/motion-catalog.json"), "utf8"));
const totalMotions = catalog.packs.reduce((count, pack) => count + pack.motions.length, 0);
// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
delete env.ELECTRON_RUN_AS_NODE;
const startedAt = Date.now();
const checked = [];
const screenshots = [];
const errors = [];
const watched = new WeakSet();
let instance;
let controls;
let pet;
let petContentsId;
let phase = "launch";
let report;
let guardInstalled = false;

function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on("pageerror", error => errors.push({ kind: "pageerror", text: error.message }));
  window.on("console", message => {
    if (message.type() === "error") errors.push({ kind: "console", text: message.text() });
  });
}

// Explicitly await IPC predicates. An async callback in waitForFunction can be prematurely truthy.
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
async function previewPhase(expected) {
  await controls.waitForFunction(value => document.querySelector("#motion-preview-summary")?.dataset.phase === value, expected);
}
async function remoteAttempts() {
  return !instance || !guardInstalled ? [] : instance.evaluate(() => [...globalThis.__motionPreviewRemoteRequests]);
}
async function petMotionRequests() {
  return instance.evaluate((_, id) => globalThis.__motionPreviewAssetRequests.filter(request =>
    request.webContentsId === id && /\.vmd(?:[?#]|$)/i.test(request.url)), petContentsId);
}
async function visibleOptions() {
  return controls.evaluate(() => [...document.querySelectorAll(".motion-pack-card")]
    .filter(card => !card.hidden && getComputedStyle(card).display !== "none")
    .flatMap(card => [...card.querySelectorAll('select[id^="motion-select-"] option')].map(option => option.value)));
}
function motion(packId, id) {
  const pack = catalog.packs.find(value => value.id === packId);
  const clip = pack?.motions.find(value => value.id === id);
  assert.ok(pack && clip, `Required fixture ${packId}/${id} exists`);
  return { pack, clip };
}
async function clearFilters() {
  await controls.locator("#motion-filter-clear").click();
  await controls.waitForFunction(() => document.querySelector("#motion-filter-category")?.value === "all");
}
async function choose(packId, id) {
  await controls.locator(`#motion-select-${packId}`).selectOption(id);
}
async function beginPreview(packId, id, layer = "pose") {
  const { clip } = motion(packId, id);
  await controls.locator("#motion-target-layer").selectOption(layer);
  await choose(packId, id);
  await controls.locator(`#motion-preview-${packId}`).click();
  await previewPhase("playing");
  assert.ok((await controls.locator("#motion-preview-summary").textContent()).includes(clip.name));
  assert.ok((await controls.locator("#motion-preview-summary").textContent()).includes({
    pose: "身体姿态", gesture: "手势", expression: "面部表情",
  }[layer]));
  await controls.waitForFunction(() => document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中"));
}
async function stopPreview() {
  await controls.locator("#motion-preview-stop").click();
  await previewPhase("idle");
  await controls.waitForFunction(() => document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中"));
}
async function snapshot(label) {
  await controls.waitForTimeout(300);
  const relative = `${label}.png`;
  await controls.locator("#stage").screenshot({ path: path.join(output, relative) });
  screenshots.push(relative);
}
async function assertTemporary(before, beforeDisk, beforePetRequests, label) {
  assert.deepEqual(await settings(), before, `${label} must not alter host settings`);
  assert.equal(await savedBytes(), beforeDisk, `${label} must not alter persisted settings.json`);
  assert.deepEqual(await petMotionRequests(), beforePetRequests, `${label} must not request a VMD in the companion window`);
  assert.ok((await pet.locator("#pet-status").textContent()).includes("VMD 播放中"));
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
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath("userData"))), profile);
  await instance.evaluate(async ({ session }) => {
    const key = Symbol.for("undici.globalDispatcher.1");
    await fetch("data:text/plain,motion-preview-offline-guard");
    if (!globalThis[key]?.dispatch) throw new Error("Node fetch dispatcher unavailable for offline verification");
    globalThis.__motionPreviewRemoteRequests = [];
    globalThis.__motionPreviewAssetRequests = [];
    globalThis[key] = {
      dispatch(options, handler) {
        globalThis.__motionPreviewRemoteRequests.push(String(options.origin) + options.path);
        handler.onError(new Error("MOTION_PREVIEW_SMOKE_OFFLINE"));
        return false;
      },
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const remote = /^https?:/i.test(details.url);
      if (remote) globalThis.__motionPreviewRemoteRequests.push(details.url);
      if (details.url.startsWith("mmd-asset:")) globalThis.__motionPreviewAssetRequests.push({
        url: details.url, webContentsId: details.webContentsId,
      });
      callback({ cancel: remote });
    });
  });
  guardInstalled = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const window of instance.windows()) watch(window);
    // Ignore the independent reply window and any other non-controls auxiliary window.
    controls = instance.windows().find(window => {
      try { const url = new URL(window.url()); return url.pathname.endsWith("/index.html") && !url.searchParams.has("pet"); }
      catch { return false; }
    });
    pet = instance.windows().find(window => {
      try { const url = new URL(window.url()); return url.pathname.endsWith("/index.html") && url.searchParams.has("pet"); }
      catch { return false; }
    });
    if (controls && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet, "controls and companion windows exist");
  controls.setDefaultTimeout(15000);
  pet.setDefaultTimeout(15000);
  petContentsId = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => {
    try { return new URL(window.webContents.getURL()).searchParams.has("pet"); } catch { return false; }
  })?.webContents.id);
  assert.ok(Number.isInteger(petContentsId));
  await Promise.all([controls.reload(), pet.reload()]);
  await controls.waitForFunction(() => typeof window.desktop?.previewMotion === "function");
  await navigateControlPage(controls, "appearance");
  await controls.waitForSelector("#motion-filter-category");
  await poll(controls, async () => {
    const value = await window.desktop.getSettings();
    return value.model?.name === "gene.pmx" && value.motion?.name === "stand.vmd" &&
      document.querySelector("#stage-status")?.textContent?.includes("VMD 播放中");
  });
  await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("VMD 播放中"));
  await controls.locator("#frame-full").click();
  await controls.waitForTimeout(500); // Allow the explicit framing save to finish before byte comparisons.
  await previewPhase("idle");
}

try {
  await launch();
  const initial = await settings();
  const initialDisk = await savedBytes();
  const initialCards = await controls.evaluate(() => window.desktop.getCharacterCards());
  const initialPetRequests = await petMotionRequests();
  assert.equal(initial.provider.kind, "claude");
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.deepEqual(runtime, { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.equal((await visibleOptions()).length, totalMotions);
  checked.push("fresh Gene + Stand profile, all motions visible, media off");

  phase = "filter-category-and-tags";
  await controls.locator("#motion-filter-category").selectOption("idle");
  assert.equal((await visibleOptions()).length, 5);
  const loopLabel = await controls.locator('#motion-filter-tag option[value="loop"]').textContent();
  assert.match(loopLabel, /loop/i);
  assert.match(loopLabel, /\d/, "tag choices display a match count");
  await controls.locator("#motion-filter-tag").selectOption("loop");
  await controls.locator("#motion-filter-tag").selectOption("in-place");
  assert.equal((await visibleOptions()).length, 5, "loop AND in-place is intersected within idle");
  await controls.locator(".motion-filters").screenshot({ path: path.join(output, "tag-filters.png") });
  screenshots.push("tag-filters.png");
  await controls.locator('button[data-motion-filter-tag="loop"]').first().click();
  assert.equal((await visibleOptions()).length, 5);
  await clearFilters();
  assert.equal((await visibleOptions()).length, totalMotions);
  await controls.locator("#motion-search-100style-idles").fill("arms folded");
  assert.deepEqual(await controls.locator("#motion-select-100style-idles option").evaluateAll(options => options.map(option => option.value)), ["arms-folded-idle"]);
  await controls.locator("#motion-search-100style-idles").fill("arms no-such-tag-or-name");
  assert.equal(await controls.locator("#motion-select-100style-idles option").count(), 0);
  await controls.locator("#motion-search-100style-idles").fill("");
  assert.equal((await visibleOptions()).length, totalMotions);
  assert.ok((await controls.locator("#motion-filter-result").textContent()).trim());
  await assertTemporary(initial, initialDisk, initialPetRequests, "Filtering");
  checked.push("category, visible tag counts, AND tags, removable chips, clear and multiword search");

  phase = "preview-idle-stop-repeat";
  await beginPreview("100style-idles", "neutral-idle");
  await snapshot("neutral-idle-preview");
  await assertTemporary(initial, initialDisk, initialPetRequests, "Idle preview");
  await stopPreview();
  await assertTemporary(initial, initialDisk, initialPetRequests, "Stopping preview");
  await beginPreview("100style-idles", "neutral-idle");
  await stopPreview();
  checked.push("idle preview, stop/restore and replay do not alter saved motion or companion playback");

  phase = "preview-expression-and-filter-cancel";
  await beginPreview("gene", "happy", "expression");
  await snapshot("happy-preview");
  await controls.locator("#motion-pack-gene").screenshot({ path: path.join(output, "preview-buttons.png") });
  screenshots.push("preview-buttons.png");
  await assertTemporary(initial, initialDisk, initialPetRequests, "Expression preview");
  await controls.locator("#motion-filter-category").selectOption("dance");
  await previewPhase("idle");
  assert.equal((await visibleOptions()).length, 1);
  await clearFilters();
  checked.push("expression preview is temporary; excluding it with a category filter stops preview");

  phase = "preview-dance-selection-change";
  await beginPreview("fnoji-dances", "split-dance");
  await snapshot("split-dance-preview");
  await assertTemporary(initial, initialDisk, initialPetRequests, "Dance preview");
  await choose("gene", "thinking");
  await previewPhase("idle");
  await assertTemporary(initial, initialDisk, initialPetRequests, "Changing action selection");
  checked.push("dance preview is temporary; choosing another action stops without auto-enabling it");

  phase = "preview-camera-and-tab";
  await beginPreview("gene", "happy", "expression");
  await controls.locator("#camera-yaw").fill("12");
  await controls.locator("#camera-yaw").press("Tab");
  await poll(controls, async () => (await window.desktop.getSettings()).camera.yaw === 12);
  await previewPhase("playing");
  assert.deepEqual((await settings()).motion, initial.motion, "camera editing does not commit the temporary action");
  assert.deepEqual((await settings()).motionLayers, initial.motionLayers, "camera editing does not commit temporary facial layers");
  await navigateControlPage(controls, "providers");
  await previewPhase("idle");
  await navigateControlPage(controls, "appearance");
  const afterCamera = await settings();
  const afterCameraDisk = await savedBytes();
  const afterCameraPetRequests = await petMotionRequests();
  checked.push("camera save preserves preview and saved motion; leaving appearance stops preview");

  phase = "preview-then-enable";
  await beginPreview("gene", "happy", "expression");
  await assertTemporary(afterCamera, afterCameraDisk, afterCameraPetRequests, "Preview before enable");
  await controls.locator("#motion-install-gene").click();
  const happy = motion("gene", "happy");
  const suffix = `${happy.pack.source}/${happy.pack.id}/${happy.pack.revision}/${happy.clip.relativePath}`;
  await poll(controls, async expected => {
    const value = await window.desktop.getSettings();
    const status = document.querySelector("#motion-status-gene")?.textContent ?? "";
    return value.motionLayers?.expression?.path.replaceAll("\\", "/").endsWith(expected) &&
      status.includes("已启用 Happy") && status.includes("面部表情");
  }, suffix);
  await previewPhase("idle");
  assert.notEqual(await savedBytes(), afterCameraDisk);
  await pet.waitForFunction(() => document.querySelector("#pet-status")?.textContent?.includes("VMD 播放中"));
  await poll(controls, async () => (await window.desktop.getSettings()).motionLayers?.expression?.name === "happy.vmd");
  const enabledFace = await settings();
  assert.deepEqual(enabledFace.motion, initial.motion, "enabling a face preserves the body pose");
  assert.equal(enabledFace.motionLayers?.gesture, null, "enabling a face does not introduce a gesture");
  assert.ok((await controls.locator("#motion-layer-expression-name").textContent()).includes("happy.vmd"));
  assert.ok((await controls.locator("#motion-layer-pose-name").textContent()).includes(initial.motion.name));
  checked.push("Enable ends preview and persists only the selected facial channel, preserving the body pose");

  phase = "privilege-boundary";
  const forbidden = await pet.evaluate(async () => {
    try { await window.desktop.previewMotion("gene", "happy"); return false; }
    catch { return true; }
  });
  assert.equal(forbidden, true, "companion window cannot request a preview resource");
  assert.deepEqual(await controls.evaluate(() => window.desktop.getCharacterCards()), initialCards);
  checked.push("companion preview IPC is rejected and character cards are preserved");

  phase = "restore-default";
  await controls.locator("#use-bundled-model").click();
  await poll(controls, async () => (await window.desktop.getSettings()).motion?.name === "stand.vmd");
  await previewPhase("idle");
  const attempts = await remoteAttempts();
  assert.deepEqual(attempts, []);
  assert.deepEqual(errors.filter(error => !error.text.includes("ERR_ABORTED")), []);
  report = {
    status: "PASS", packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, screenshots,
    totalMotions, previewed: ["100style-idles/neutral-idle", "gene/happy", "fnoji-dances/split-dance"],
    remoteRequests: attempts, errors,
    limits: ["Late IPC responses and model changes during a pending preview require the isolated preview-controller regression tests; this UI harness does not monkeypatch IPC handlers."],
  };
  console.log(JSON.stringify({ status: report.status, checked: checked.length, elapsedSeconds: report.elapsedSeconds, remoteRequests: attempts, errors }, null, 2));
} catch (error) {
  report = { status: "FAILED", phase, packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, screenshots,
    remoteRequests: await remoteAttempts().catch(() => []), errors,
    failure: error instanceof Error ? error.stack : String(error) };
  throw error;
} finally {
  try { await writeFile(path.join(output, "report.json"), JSON.stringify(report ?? { status: "FAILED", phase, checked, errors }, null, 2) + "\n"); }
  finally { if (instance) await instance.close(); }
}
