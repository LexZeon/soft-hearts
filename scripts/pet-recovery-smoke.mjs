import assert from "node:assert/strict";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeIsolation } from "./lib/claude-smoke-fixture.mjs";
import { armSmokeWatchdog, closeElectron } from "./lib/electron-cleanup.mjs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

// A disposable profile only. No chat, Codex task, media or desktop capture is started.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const output = path.join(workspace, ".local/pet-recovery-smoke");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "profile-"));
const optionalModel = process.env.MMD_TEST_MODEL ? await realpath(process.env.MMD_TEST_MODEL) : null;
// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
delete env.ELECTRON_RUN_AS_NODE;
const checked = [];
const screenshots = [];
const errors = [];
const watched = new WeakSet();
const startedAt = Date.now();
let instance;
// A failing or hung run still closes its own window (scripts/lib/electron-cleanup.mjs).
const disarm = armSmokeWatchdog(() => instance, 270_000, "pet-recovery-smoke");
let controls;
let pet;
let phase = "launch";
let report;

function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on("pageerror", error => errors.push(error.message));
  window.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
}

// Await IPC predicates ourselves: waitForFunction(async ...) may treat a Promise as truthy.
async function poll(window, predicate, arg, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.evaluate(predicate, arg)) return;
    await window.waitForTimeout(50);
  }
  throw new Error(`Timed out during ${phase}`);
}

async function settings() { return controls.evaluate(() => window.desktop.getSettings()); }
async function remoteAttempts() { return instance.evaluate(() => [...globalThis.__petRecoveryRemoteRequests]); }
async function nativeState() {
  return instance.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows();
    const isPet = window => {
      try { const url = new URL(window.webContents.getURL()); return url.pathname.endsWith("/index.html") && url.searchParams.has("pet"); }
      catch { return false; }
    };
    const companion = windows.find(isPet);
    const panel = windows.find(window => {
      try { const url = new URL(window.webContents.getURL()); return url.pathname.endsWith("/index.html") && !url.searchParams.has("pet"); }
      catch { return false; }
    });
    if (!companion || !panel) throw new Error("Recovery windows are unavailable");
    const area = screen.getDisplayMatching(panel.getBounds()).workArea;
    const scale = Math.min(1, area.width / 400, area.height / 560);
    const width = Math.max(1, Math.floor(400 * scale));
    const height = Math.max(1, Math.floor(560 * scale));
    return {
      visible: companion.isVisible(), minimized: companion.isMinimized(), alwaysOnTop: companion.isAlwaysOnTop(),
      opacity: companion.getOpacity(), bounds: companion.getBounds(), workArea: area,
      expectedScale: scale,
      expectedBounds: { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height },
      ignoreMouseCalls: [...(globalThis.__petRecoveryIgnoreMouseCalls ?? [])],
    };
  });
}

function preserved(value) {
  const { camera: _camera, pet: _pet, ...rest } = value;
  // Legacy whole-VMD playback has no overlay state; IPC can retain an optional
  // undefined key while the persisted JSON omits it.
  if (rest.motionLayers === undefined) delete rest.motionLayers;
  return rest;
}

async function ready() {
  await controls.waitForFunction(() => /模型已就绪|模型已载入|VMD 播放中/.test(document.querySelector("#stage-status")?.textContent ?? ""), null, { timeout: 90000 });
  await pet.waitForFunction(() => /模型已就绪|模型已载入|VMD 播放中/.test(document.querySelector("#pet-status")?.textContent ?? ""), null, { timeout: 90000 });
}

async function assertRecovered(before, cards, runtime) {
  await poll(controls, async () => {
    const value = await window.desktop.getSettings();
    return value.pet.visible === true && value.pet.alwaysOnTop === true && value.pet.clickThrough === false &&
      value.pet.followMouse === true && value.pet.fps === 30 && value.pet.breath === 0.5 &&
      value.camera.yaw === 0 && value.camera.pitch === 0 && value.camera.fov === 32 &&
      Number.isFinite(value.camera.distance) && value.camera.distance > 0 && Math.abs(value.camera.distance - 30) > 0.00001;
  });
  await ready();
  const actual = await settings();
  const state = await nativeState();
  assert.equal(actual.pet.scale, state.expectedScale, "default scale is fitted only for a small work area");
  assert.deepEqual(state.bounds, state.expectedBounds, "companion is centered in the controls display work area");
  assert.equal(state.visible, true);
  assert.equal(state.minimized, false);
  assert.equal(state.alwaysOnTop, true);
  assert.equal(state.opacity, 1);
  assert.equal(state.ignoreMouseCalls.at(-1), false, "the native window no longer ignores mouse events");
  assert.deepEqual(preserved(actual), preserved(before), "recovery preserves assets, connections, persona, voice and agent settings");
  assert.deepEqual(await controls.evaluate(() => window.desktop.getCharacterCards()), cards);
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), runtime);
  assert.ok([actual.camera.targetX, actual.camera.targetY, actual.camera.targetZ ?? 0].every(Number.isFinite));
  const disk = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
  assert.deepEqual(disk.camera, actual.camera, "automatic full-body framing is saved");
  assert.equal(disk.pet.visible, true);
  assert.equal(disk.pet.scale, actual.pet.scale);
  await controls.waitForFunction(() => !document.querySelector("#recover-pet")?.disabled);
  assert.ok((await controls.locator("#recover-pet").textContent()).includes("一键恢复桌宠"));
  return { native: state, camera: actual.camera, pet: actual.pet };
}

async function launch() {
  const options = process.env.MMD_TEST_EXE ? { executablePath: process.env.MMD_TEST_EXE, args: [] } : { args: [appDirectory] };
  options.args.push(`--user-data-dir=${profile}`, "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost", "--proxy-server=http://127.0.0.1:9");
  instance = await electron.launch({ ...options, cwd: appDirectory, env, timeout: 30000 });
  instance.on("window", watch);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath("userData"))), profile);
  await instance.evaluate(async ({ session }) => {
    const key = Symbol.for("undici.globalDispatcher.1");
    await fetch("data:text/plain,pet-recovery-offline-guard");
    if (!globalThis[key]?.dispatch) throw new Error("Node fetch dispatcher unavailable for offline verification");
    globalThis.__petRecoveryRemoteRequests = [];
    globalThis[key] = {
      dispatch(options, handler) {
        globalThis.__petRecoveryRemoteRequests.push(String(options.origin) + options.path);
        handler.onError(new Error("PET_RECOVERY_SMOKE_OFFLINE"));
        return false;
      },
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      globalThis.__petRecoveryRemoteRequests.push(details.url);
      callback({ cancel: true });
    });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const window of instance.windows()) watch(window);
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
  assert.ok(controls && pet, "controls and companion windows exist; auxiliary reply windows are ignored");
  controls.setDefaultTimeout(15000);
  pet.setDefaultTimeout(15000);
  await controls.waitForFunction(() => typeof window.desktop?.recoverPet === "function");
  // The preload can be ready before the original loadFile promise settles.
  // Reloading earlier aborts startup and opens Electron's native error dialog.
  // A fresh profile gets the preinstalled public Gene, so this is an ordinary immersive
  // start: only the pet is shown and the controls stay closed (electron/initial-controls.ts,
  // tests/initial-controls.test.ts, R37). The old check waited for a visible controls window.
  const loadedBy = Date.now() + 30000;
  let startup = null;
  while (Date.now() < loadedBy) {
    startup = await instance.evaluate(({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('index.html'));
      const isPet = win => new URL(win.webContents.getURL()).searchParams.has('pet');
      return { count: all.length, loaded: all.every(win => !win.webContents.isLoadingMainFrame()),
        petVisible: all.some(win => isPet(win) && win.isVisible()), controlsVisible: all.some(win => !isPet(win) && win.isVisible()) };
    });
    if (startup.count === 2 && startup.loaded && startup.petVisible) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(startup?.count === 2 && startup.loaded && startup.petVisible, `initial app startup finished before the harness reloads: ${JSON.stringify(startup)}`);
  assert.ok((await settings()).model, "a fresh profile starts with the preinstalled Gene model");
  assert.equal(startup.controlsVisible, false, "an ordinary start with a ready model and visible pet keeps the controls closed");
  await Promise.all([controls.reload(), pet.reload()]);
  await controls.waitForSelector("#recover-pet");
  // Open the controls the way a user does: the pet toolbar's settings button.
  // A hidden controls window does not render its stage, so its status is read after this.
  await pet.waitForSelector("#open-controls", { state: "attached" });
  await pet.evaluate(() => document.getElementById("open-controls").click());
  await poll(controls, () => !document.hidden);
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => {
    try { const url = new URL(win.webContents.getURL()); return url.pathname.endsWith("/index.html") && !url.searchParams.has("pet") && win.isVisible(); }
    catch { return false; }
  })), true, "the pet's settings button opens the controls window");
  await ready();
  checked.push("ordinary start shows only the pet; the pet's settings button opens the controls");
  if (optionalModel) {
    await instance.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, optionalModel);
    await controls.evaluate(async () => {
      await window.desktop.selectAsset("model");
      await window.desktop.installMotionPack("gene", "stand");
    });
    await poll(controls, async selected => (await window.desktop.getSettings()).model?.path === selected, optionalModel, 90000);
    await ready();
    checked.push("optional authorized external model is referenced read-only and remains external");
  }
}

try {
  await launch();
  phase = "topbar-visibility";
  for (const tab of ["chat", "appearance", "providers", "agent", "privacy"]) {
    await navigateControlPage(controls, tab);
    await controls.locator("#recover-pet").waitFor({ state: "visible" });
  }
  await controls.locator(".topbar").screenshot({ path: path.join(output, "recovery-button.png") });
  screenshots.push("recovery-button.png");
  checked.push("prominent topbar recovery button remains visible in every controls tab");

  const before = await settings();
  const cards = await controls.evaluate(() => window.desktop.getCharacterCards());
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.deepEqual(runtime, { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.ok(before.model && before.motion, "a model and enabled motion make preservation observable");

  phase = "hidden-offscreen-view";
  await controls.evaluate(async () => {
    const value = await window.desktop.getSettings();
    value.pet = { ...value.pet, visible: false, alwaysOnTop: false, clickThrough: true, scale: 0.5, fps: 60, breath: 1, followMouse: false };
    value.camera = { yaw: 135, pitch: 55, distance: 180, targetX: 80, targetY: -80, targetZ: 40, fov: 70 };
    await window.desktop.saveSettings(value);
  });
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => {
      try { return new URL(window.webContents.getURL()).searchParams.has("pet"); } catch { return false; }
    });
    if (!window) throw new Error("Companion window missing");
    globalThis.__petRecoveryIgnoreMouseCalls = [];
    const original = window.setIgnoreMouseEvents.bind(window);
    window.setIgnoreMouseEvents = (...args) => { globalThis.__petRecoveryIgnoreMouseCalls.push(args[0]); return original(...args); };
    window.hide();
    window.setBounds({ x: -10000, y: -10000, width: 200, height: 280 });
    window.setAlwaysOnTop(false);
    window.setOpacity(0.3);
  });
  assert.equal((await nativeState()).visible, false);
  await controls.locator("#recover-pet").click();
  const first = await assertRecovered(before, cards, runtime);
  checked.push("hidden, offscreen, undersized, transparent/click-through companion is visible, default sized and centered");
  checked.push("default display settings and automatic full-body camera are saved without changing selected assets or connections");
  await pet.locator("#stage").screenshot({ path: path.join(output, "recovered-pet-stage.png") });
  screenshots.push("recovered-pet-stage.png");

  phase = "repeat-and-minimized";
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => {
      try { return new URL(window.webContents.getURL()).searchParams.has("pet"); } catch { return false; }
    })?.minimize();
  });
  await controls.locator("#recover-pet").click();
  const second = await assertRecovered(before, cards, runtime);
  assert.deepEqual(second.native.bounds, first.native.bounds);
  checked.push("repeated recovery restores a minimized companion and remains centered");

  phase = "privilege-boundary";
  assert.equal(await pet.evaluate(async () => {
    try { await window.desktop.recoverPet(); return false; } catch { return true; }
  }), true);
  checked.push("companion window cannot invoke the controls-only recovery IPC");
  const attempts = await remoteAttempts();
  assert.deepEqual(attempts, []);
  assert.deepEqual(errors.filter(error => !error.includes("ERR_ABORTED")), []);
  report = { status: "PASS", packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile, optionalExternalModel: !!optionalModel,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, screenshots, first, second, remoteRequests: attempts, errors };
  console.log(JSON.stringify({ status: report.status, checks: checked.length, elapsedSeconds: report.elapsedSeconds, remoteRequests: attempts, errors }, null, 2));
} catch (error) {
  report = { status: "FAILED", phase, packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), checked, screenshots,
    failure: error instanceof Error ? error.stack : String(error), remoteRequests: instance ? await remoteAttempts().catch(() => []) : [], errors };
  throw error;
} finally {
  try { await writeFile(path.join(output, "report.json"), JSON.stringify(report ?? { status: "FAILED", phase, checked, errors }, null, 2) + "\n"); }
  finally {
    const shutdown = await closeElectron(instance);
    disarm();
    if (!shutdown.closed) { process.exitCode = 1; console.error("pet-recovery-smoke: Electron did not close by itself", shutdown); }
  }
}
