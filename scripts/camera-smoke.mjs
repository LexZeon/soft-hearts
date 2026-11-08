import { _electron as electron } from "playwright";
import { navigateControlPage } from "./lib/control-navigation.mjs";
import { createClaudeIsolation } from "./lib/claude-smoke-fixture.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Use a source or packaged build with an isolated profile. This test never opens
// the user's normal profile, sends chat, or accesses a screen/camera device.
const output = path.resolve(".local/camera-smoke");
await mkdir(output, { recursive: true });
const profile = path.join(output, "profile");
const executable = process.env.MMD_TEST_EXE ? path.resolve(process.env.MMD_TEST_EXE) : null;
// No chat: Claude Code is only an inert placeholder with an empty config folder; Codex is a missing path.
const claude = await createClaudeIsolation();
const env = claude.environment({
  ...process.env,
  MMD_DESK_USER_DATA: profile,
});
delete env.ELECTRON_RUN_AS_NODE;
delete env.MMD_TEST_EXE;
const checks = [];
const errors = [];
const nativeDrags = [];
const builds = [];
const smallDragFrames = [];
const precisionSamples = [];
const tabSamples = [];
let instance;
let page;
let pet;
let report;
let packaged = null;

const fields = [
  "yaw",
  "pitch",
  "distance",
  "targetX",
  "targetY",
  "targetZ",
  "fov",
];
const canonical = (camera) =>
  Object.fromEntries(fields.map((key) => [key, camera[key] ?? 0]));
const center = (camera) => [
  camera.targetX,
  camera.targetY,
  camera.targetZ ?? 0,
];
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const norm = (vector) => Math.hypot(...vector);
const dot = (a, b) =>
  a.reduce((sum, value, index) => sum + value * b[index], 0);
function basis(camera) {
  const yaw = (camera.yaw * Math.PI) / 180;
  const pitch = (camera.pitch * Math.PI) / 180;
  return {
    forward: [
      -Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ],
    right: [Math.cos(yaw), 0, -Math.sin(yaw)],
    up: [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      -Math.cos(yaw) * Math.sin(pitch),
    ],
  };
}
function eye(camera) {
  const forward = basis(camera).forward;
  return center(camera).map((value, index) => value - forward[index] * camera.distance);
}
function eyeUnchanged(actual, expected, label) {
  assert.ok(norm(subtract(eye(actual), eye(expected))) < 1e-6, `${label}: rotation must preserve the camera eye`);
}
const angleDelta = (after, before) => ((after - before + 540) % 360) - 180;
const scalarNear = (actual, expected, label, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
async function shifted(window, action) {
  await window.keyboard.down('Shift');
  try { return await action(); } finally { await window.keyboard.up('Shift'); }
}
function near(actual, expected, label, tolerance = 1e-6) {
  for (const field of fields)
    assert.ok(
      Math.abs(actual[field] - expected[field]) <= tolerance,
      `${label}: ${field} changed (${expected[field]} -> ${actual[field]})`,
    );
}
function orientationUnchanged(actual, expected, label) {
  for (const field of ["yaw", "pitch", "distance", "fov"])
    assert.ok(
      Math.abs(actual[field] - expected[field]) < 1e-6,
      `${label}: ${field} changed`,
    );
}
function movedAlong(before, after, direction, label) {
  const delta = subtract(center(after), center(before));
  assert.ok(norm(delta) > 0.005, `${label}: camera did not move`);
  assert.ok(
    dot(delta, direction) / (norm(delta) * norm(direction)) > 0.98,
    `${label}: movement followed the wrong direction`,
  );
  orientationUnchanged(after, before, label);
}
async function camera() {
  const value = canonical(
    (await page.evaluate(() => window.desktop.getSettings())).camera,
  );
  assert.ok(fields.every(field => Number.isFinite(value[field])), 'all persisted camera coordinates must remain finite');
  return value;
}
async function settled() {
  await page.waitForTimeout(550);
  return camera();
}
async function frameFromButton(preset) {
  await page.locator(`#frame-${preset}`).click();
  const desired = await page.evaluate(() => Object.fromEntries(['yaw', 'pitch', 'distance', 'targetX', 'targetY', 'fov'].map(key => [key, Number(document.querySelector(`#camera-${key}`).value)])));
  const deadline = Date.now() + 6000; let current;
  do { current = await camera(); if (Object.keys(desired).every(key => Math.abs(current[key] - desired[key]) <= 0.006) && Math.abs(current.targetZ) < 1e-6) break; await page.waitForTimeout(50); } while (Date.now() < deadline);
  for (const key of Object.keys(desired)) scalarNear(current[key], desired[key], `complete ${preset} framing saved ${key}`, 0.006);
  scalarNear(current.targetZ, 0, `${preset} framing saved targetZ`);
  await pet.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const confirmed = await camera(); near(confirmed, current, `${preset} framing remains stable across two render frames`); return confirmed;
}
async function bounds(petWindow = true) {
  return instance.evaluate(
    ({ BrowserWindow }, wantedPet) =>
      BrowserWindow.getAllWindows()
        .find(
          (win) =>
            win.webContents.getURL().includes("index.html") &&
            new URL(win.webContents.getURL()).searchParams.has("pet") ===
            wantedPet,
        )
        ?.getBounds(),
    petWindow,
  );
}
async function waitForBounds(predicate, label) {
  const deadline = Date.now() + 3000;
  let current;
  do {
    current = await bounds();
    if (predicate(current)) return current;
    await pet.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.fail(`${label}: native bounds remained ${JSON.stringify(current)}`);
}
async function launch() {
  instance = await electron.launch({
    ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] } : { args: ["."] }),
    env, timeout: 30000,
  });
  await instance.firstWindow();
  const identity = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath("userData") }));
  packaged = identity.packaged;
  assert.deepEqual(identity, { packaged: !!executable, profile });
  for (let attempt = 0; attempt < 100; attempt++) {
    page = instance
      .windows()
      .find(
        (window) =>
          window.url().includes("index.html") &&
          !new URL(window.url()).searchParams.has("pet"),
      );
    pet = instance
      .windows()
      .find(
        (window) =>
          window.url().includes("index.html") &&
          new URL(window.url()).searchParams.has("pet"),
      );
    if (page && pet) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page && pet, "both app windows exist");
  // Keep OS hover/capture messages from replacing the controlled CDP pointer.
  // This fixture validates DOM/IPC/native geometry, not physical input consent.
  await instance.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const ignore = win.setIgnoreMouseEvents.bind(win);
      win.setIgnoreMouseEvents = () => ignore(true);
      win.setIgnoreMouseEvents(true);
    }
  });
  for (const window of [page, pet])
    window.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#stage canvas");
  await pet.waitForSelector("#stage canvas");
  builds.push(
    await Promise.all(
      [page, pet].map((window) =>
        window.evaluate(() =>
          [...document.scripts].map((script) => script.src.split("/").at(-1)),
        ),
      ),
    ),
  );
  await navigateControlPage(page, "appearance");
}
async function close() {
  if (!instance) return;
  const current = instance;
  instance = undefined;
  let timer;
  try {
    await Promise.race([
      current.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Electron close timeout")),
          10000,
        );
      }),
    ]);
  } catch {
    const child = current.process();
    if (child.pid && child.exitCode === null) {
      if (process.platform === "win32")
        execFileSync(
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32/taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
      else child.kill("SIGKILL");
    }
  } finally {
    clearTimeout(timer);
  }
}
async function enter(window = page, selector = "#camera-edit") {
  if (window === pet) await approachPetControl(selector);
  if ((await window.locator(selector).getAttribute("aria-pressed")) !== "true")
    await window.locator(selector).click();
  // A framing button leaves edit mode enabled but takes focus away from canvas.
  await window.locator('#stage canvas').focus();
  await window.waitForFunction(
    (id) =>
      document.querySelector(id)?.getAttribute("aria-pressed") === "true" &&
      document.activeElement === document.querySelector("#stage canvas"),
    selector,
  );
}
async function approachPetControl(selector) {
  const point = await pet.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  // Move first, like a user. Waiting for visibility before moving would leave
  // the pointer touching the head while mood intentionally hides the toolbar.
  await pet.mouse.move(point.x, point.y);
}
async function drag(window, button, dx, dy) {
  const box = await window.locator("#stage canvas").boundingBox();
  assert.ok(box, "camera canvas is visible");
  const x = box.x + box.width * 0.46;
  const y = box.y + box.height * 0.54;
  await window.mouse.move(x, y);
  await window.mouse.down({ button });
  try {
    await window.mouse.move(x + dx, y + dy, { steps: 4 });
  } finally {
    await window.mouse.up({ button });
  }
}
async function visibleModelFrame(label) {
  const viewport = await pet.locator('#stage canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height, bufferWidth: canvas.width, bufferHeight: canvas.height, devicePixelRatio,
      reserved: [...document.querySelectorAll('#pet-toolbar,.pet-chat,#pet-tooltip,#pet-edit-help,[data-mood-ui],#toast')]
        .map(el => el.getBoundingClientRect().toJSON()).filter(r => r.width > 0 && r.height > 0) };
  });
  assert.ok(['width', 'height', 'bufferWidth', 'bufferHeight', 'devicePixelRatio'].every(key => Number.isFinite(viewport[key])) && viewport.width > 0 && viewport.height > 0);
  assert.ok(Math.abs(viewport.bufferWidth / viewport.bufferHeight - viewport.width / viewport.height) < 0.015, 'canvas buffer and viewport keep the same aspect ratio');
  assert.ok(viewport.bufferWidth / viewport.width > 0 && viewport.bufferWidth / viewport.width <= 1.51 && viewport.bufferHeight / viewport.height <= 1.51, 'render DPR remains bounded');
  const native = await instance.evaluate(async ({ BrowserWindow }, viewport) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html') && new URL(w.webContents.getURL()).searchParams.has('pet'));
    const image = await win.webContents.capturePage(), bitmap = image.toBitmap(), size = image.getSize(); let modelPixels = 0;
    for (let n = 3; n < bitmap.length; n += 4) {
      const pixel = (n - 3) / 4, x = pixel % size.width, y = Math.floor(pixel / size.width);
      const cssX = x * viewport.width / size.width, cssY = y * viewport.height / size.height;
      const outsideUI = viewport.reserved.every(r => cssX < r.left || cssX >= r.right || cssY < r.top || cssY >= r.bottom);
      if (bitmap[n] > 16 && outsideUI && x > size.width * 0.2 && x < size.width * 0.8 && y > size.height * 0.2 && y < size.height * 0.78) modelPixels++;
    }
    return { empty: image.isEmpty(), modelPixels, size };
  }, viewport);
  assert.equal(native.empty, false); assert.ok(native.modelPixels > 100, `${label}: model pixels remain visible outside toolbar/chat`);
  smallDragFrames.push({ label, viewport, native, camera: await camera() });
}
async function smallRotationChecks(window, label) {
  const box = await window.locator('#stage canvas').boundingBox(); assert.ok(box);
  const x = box.x + box.width * 0.46, y = box.y + box.height * 0.54;
  const before = await camera(); await window.mouse.move(x, y); await window.mouse.down({ button: 'left' });
  try {
    near(await settled(), before, `${label} pressed without movement`);
    await visibleModelFrame(`${label}-pressed-still`);
  } finally { await window.mouse.up({ button: 'left' }); }
  for (const [dx, dy] of [[2, 0], [-4, 2]]) {
    const from = await camera(); await drag(window, 'left', dx, dy); const to = await settled();
    assert.ok(Math.abs(to.yaw - from.yaw) > 0.1, `${label}: a ${Math.abs(dx)}px drag changes yaw`);
    eyeUnchanged(to, from, `${label} ${Math.abs(dx)}px drag`);
    assert.ok(Math.abs(to.distance - from.distance) < 1e-6); await visibleModelFrame(`${label}-${Math.abs(dx)}px`);
  }
  checks.push(`${label}: pressed-still and 2–4 CSS px drags keep a finite fixed eye and nonempty model frame`);
}
async function tabFramingChecks(window, selector, fullReference, label) {
  const outside = await page.evaluate(async () => { const { camera, ...settings } = await window.desktop.getSettings(); return { settings, cards: await window.desktop.getCharacterCards() }; });
  const geometry = [await bounds(false), await bounds()];
  await drag(window, 'left', 20, 8); const displaced = await settled();
  await window.keyboard.press('Tab'); const framed = await settled();
  for (const field of fields.filter(field => window === page || field !== 'distance')) scalarNear(framed[field], fullReference[field], `${label} Tab full framing ${field}`);
  assert.ok(norm(subtract(center(framed), center(displaced))) > 0.005 || Math.abs(angleDelta(framed.yaw, displaced.yaw)) > 0.1, 'Tab genuinely reframes the displaced view');
  assert.equal(await window.locator(selector).getAttribute('aria-pressed'), 'true');
  assert.equal(await window.evaluate(() => document.activeElement === document.querySelector('#stage canvas')), true);
  assert.deepEqual([await bounds(false), await bounds()], geometry, 'Tab does not resize or move either native window');
  assert.deepEqual(await page.evaluate(async () => { const { camera, ...settings } = await window.desktop.getSettings(); return { settings, cards: await window.desktop.getCharacterCards() }; }), outside, 'Tab preserves cards, models, voice and all non-camera settings');
  await visibleModelFrame(`${label}-tab-full`);
  await drag(window, 'left', 8, -4); const inputBefore = await settled();
  const input = window === pet ? '#chat-input' : '#camera-yaw';
  const draft = window === pet ? await window.locator(input).inputValue() : null;
  await window.locator(input).focus(); await window.keyboard.press('Tab'); near(await settled(), inputBefore, `${label} input Tab must keep the displaced camera`);
  if (window === pet) assert.equal(await window.locator(input).inputValue(), draft);
  assert.equal(await window.locator(selector).getAttribute('aria-pressed'), 'true');
  await window.locator('#stage canvas').focus(); tabSamples.push({ label, camera: framed, nonCameraPreserved: true, geometryPreserved: true });
  checks.push(`${label}: canvas Tab reframes the current model fully and keeps edit mode/geometry/cards/voice; input Tab does not reframe`);
}
async function hold(window, key, milliseconds = 240) {
  await window.keyboard.down(key);
  try {
    await window.waitForTimeout(milliseconds);
  } finally {
    await window.keyboard.up(key);
  }
  return settled();
}
async function nativeDrag(dx, dy) {
  const startingBounds = await bounds();
  await pet.locator("#stage canvas").hover();
  await approachPetControl('#pet-move-window');
  const box = await pet.locator("#pet-move-window").boundingBox();
  assert.ok(box, "dedicated pet move button exists");
  const x = box.x + box.width * 0.37;
  const y = box.y + box.height * 0.6;
  const hit = await pet.evaluate(
    ({ x, y }) => {
      const events = [];
      const record = (event) =>
        events.push({
          type: event.type,
          target: event.target?.id || event.target?.tagName,
          screenX: event.screenX,
          screenY: event.screenY,
          clientX: event.clientX,
          clientY: event.clientY,
          buttons: event.buttons,
          pointerId: event.pointerId,
          capture:
            event.pointerId !== undefined &&
            document
              .querySelector("#pet-move-window")
              .hasPointerCapture(event.pointerId),
          editing: document
            .querySelector("#pet-camera-edit")
            .getAttribute("aria-pressed"),
        });
      for (const type of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "lostpointercapture",
        "blur",
      ])
        window.addEventListener(type, record);
      window.nativeDragProbe = events;
      window.clearNativeDragProbe = () => {
        for (const type of [
          "pointerdown",
          "pointermove",
          "pointerup",
          "pointercancel",
          "lostpointercapture",
          "blur",
        ])
          window.removeEventListener(type, record);
      };
      return {
        target: document.elementFromPoint(x, y)?.outerHTML.slice(0, 250),
        focused: document.activeElement?.id,
        editing: document
          .querySelector("#pet-camera-edit")
          .getAttribute("aria-pressed"),
      };
    },
    { x, y },
  );
  await pet.mouse.move(x, y);
  await instance.evaluate(({ BrowserWindow, screen }, cursor) => {
    globalThis.__cameraCursorOriginal = screen.getCursorScreenPoint;
    globalThis.__cameraCursor = cursor;
    screen.getCursorScreenPoint = () => ({ ...globalThis.__cameraCursor });
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('pet=1')).focus();
  }, { x: Math.round(startingBounds.x + x), y: Math.round(startingBounds.y + y) });
  await pet.mouse.down({ button: "left" });
  await pet.waitForTimeout(80); // Allow the begin IPC to sample the initial native cursor.
  // Test real host movement with a controlled native DIP cursor; CDP client
  // coordinates must not impersonate the OS cursor or feed window relocation back.
  try {
    await instance.evaluate((_electron, delta) => {
      globalThis.__cameraCursor.x += delta.x; globalThis.__cameraCursor.y += delta.y;
    }, { x: dx, y: dy });
    await pet.waitForTimeout(80);
  } finally {
    await pet.mouse.up({ button: "left" });
    await instance.evaluate(({ screen }) => { screen.getCursorScreenPoint = globalThis.__cameraCursorOriginal; });
  }
  await pet.waitForTimeout(350);
  const events = await pet.evaluate(() => {
    window.clearNativeDragProbe();
    return window.nativeDragProbe;
  });
  nativeDrags.push({
    startingBounds,
    finalBounds: await bounds(),
    dx,
    dy,
    hit,
    events,
    workArea: await instance.evaluate(
      ({ screen }, current) => screen.getDisplayMatching(current).workArea,
      startingBounds,
    ),
  });
}

try {
  await launch();
  if (process.env.MMD_TEST_MODEL) {
    await instance.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, process.env.MMD_TEST_MODEL);
    await page.locator("#import-model").click();
    await page.waitForFunction(
      () =>
        /模型已就绪|VMD 播放中/.test(document.querySelector("#stage-status")?.textContent ?? ''),
      null,
      { timeout: 45000 },
    );
    await page.locator("#frame-portrait").click();
    if (process.env.MMD_EXPECT_BEHAVIOR_SUPPORTED === 'false') {
      assert.equal(await page.evaluate(() => window.desktop.isBehaviorModelSupported()), false);
      await pet.waitForFunction(() => JSON.parse(document.querySelector('#stage canvas')?.dataset.behaviorMotion ?? 'null')?.state?.degraded === 'unsupported-target', null, { timeout: 45000 });
      checks.push('the authorized non-Gene model is rejected by the host content check and the new face layer explicitly falls back');
    }
  }
  await settled();
  assert.equal(
    await page.locator("#camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  let before = await camera();
  await drag(page, "left", 45, 20);
  near(await settled(), before, "inactive left drag");
  await hold(page, "w");
  near(await camera(), before, "inactive movement key");
  checks.push("adjustment mode defaults off and gates mouse/keyboard input");

  await page.waitForFunction(() => /模型已就绪|VMD 播放中/.test(document.querySelector('#stage-status')?.textContent ?? ''), null, { timeout: 45000 });
  await pet.waitForFunction(() => /模型已就绪|VMD 播放中/.test(document.querySelector('#pet-status')?.textContent ?? ''), null, { timeout: 45000 });
  const fullReference = await frameFromButton('full'); await enter();
  await tabFramingChecks(page, '#camera-edit', fullReference, 'controls camera');
  await frameFromButton('portrait');
  await enter();
  await smallRotationChecks(page, 'controls camera');
  before = await camera();
  await drag(page, "left", 65, 25);
  let after = await settled();
  assert.ok(
    Math.abs(after.yaw - before.yaw) > 1 &&
      Math.abs(after.pitch - before.pitch) > 1,
    "left drag rotates yaw and pitch",
  );
  eyeUnchanged(after, before, 'left drag');
  assert.ok(Math.abs(after.distance - before.distance) < 1e-6);
  checks.push("held left mouse turns in place without translating the camera eye");

  before = after;
  await shifted(page, () => drag(page, 'left', -45, 10));
  after = await settled();
  scalarNear(angleDelta(after.yaw, before.yaw), 45 * 0.25 * 0.25, 'Shift left drag yaw is quarter strength');
  scalarNear(after.pitch - before.pitch, 10 * 0.25 * 0.25, 'Shift left drag pitch is quarter strength');
  eyeUnchanged(after, before, 'Shift left drag');
  precisionSamples.push({ channel: 'left', yawDelta: angleDelta(after.yaw, before.yaw), pitchDelta: after.pitch - before.pitch });
  before = after; await hold(page, 'Shift'); near(await camera(), before, 'Shift alone must not move the camera');
  checks.push('Shift left drag rotates at one-quarter strength with fixed eye; Shift alone never rises');

  before = after;
  const axes = basis(before);
  await drag(page, "right", 55, 24);
  after = await settled();
  movedAlong(
    before,
    after,
    axes.right.map((value, index) => -55 * value + 24 * axes.up[index]),
    "right mouse pan",
  );
  assert.ok(
    Math.abs(after.targetZ - before.targetZ) > 0.0001,
    "screen-plane pan persists its depth component",
  );
  checks.push("held right mouse pans in the camera plane including depth");

  const normalPan = subtract(eye(after), eye(before)); before = after;
  await shifted(page, () => drag(page, 'right', 55, 24)); after = await settled();
  const finePan = subtract(eye(after), eye(before));
  assert.ok(norm(subtract(finePan, normalPan.map(value => value * 0.25))) < 1e-6, 'Shift right pan is quarter strength');
  orientationUnchanged(after, before, 'Shift right pan'); before = after;
  await drag(page, 'right', 55, 24); after = await settled();
  assert.ok(norm(subtract(subtract(eye(after), eye(before)), normalPan)) < 1e-6, 'releasing Shift restores full pan strength');
  precisionSamples.push({ channel: 'right', ratio: norm(finePan) / norm(normalPan) });
  before = after; await page.mouse.wheel(0, 120); after = await settled();
  const normalZoom = (after.distance - before.distance) / before.distance; before = after;
  await shifted(page, () => page.mouse.wheel(0, 120)); after = await settled();
  const fineZoom = (after.distance - before.distance) / before.distance; scalarNear(fineZoom, normalZoom * 0.25, 'Shift wheel scales the ordinary distance change to one quarter');
  before = after; await page.mouse.wheel(0, 120); after = await settled(); scalarNear((after.distance - before.distance) / before.distance, normalZoom, 'wheel strength returns after Shift release');
  precisionSamples.push({ channel: 'wheel', relativeDistanceChangeRatio: fineZoom / normalZoom });
  before = after; const ordinaryTravel = await hold(page, 'w', 600), ordinaryDistance = norm(subtract(eye(ordinaryTravel), eye(before)));
  before = ordinaryTravel; const fineTravel = await shifted(page, () => hold(page, 'w', 600)), fineDistance = norm(subtract(eye(fineTravel), eye(before)));
  assert.ok(fineDistance / ordinaryDistance > 0.15 && fineDistance / ordinaryDistance < 0.35, 'held Shift makes timed keyboard travel approximately one quarter, allowing native frame timing');
  precisionSamples.push({ channel: 'keyboard', ratio: fineDistance / ordinaryDistance, timingTolerance: [0.15, 0.35] });
  const releasedPrecision = await settled(); await page.waitForTimeout(200); near(await camera(), releasedPrecision, 'released precision movement must not stick');
  checks.push('Shift right pan/wheel are one quarter, keyboard travel is approximately one quarter, and release restores ordinary input');

  for (const [key, axis, sign] of [
    ["w", "forward", 1],
    ["s", "forward", -1],
    ["d", "right", 1],
    ["a", "right", -1],
    ["Space", "vertical", 1],
    ["z", "vertical", -1],
  ]) {
    await enter();
    before = await camera();
    const direction =
      axis === "vertical"
        ? [0, sign, 0]
        : basis(before)[axis].map((value) => value * sign);
    after = await hold(page, key);
    movedAlong(before, after, direction, `keyboard ${key}`);
    const released = after;
    await page.waitForTimeout(300);
    near(await camera(), released, `released ${key} does not drift`);
  }
  checks.push(
    "WASD follows view forward/right; Space and Z move world up/down; release stops",
  );

  await enter();
  await page.keyboard.down("w");
  try {
    await page.waitForTimeout(130);
    await page.locator("#camera-yaw").focus();
    before = await settled();
    await page.waitForTimeout(350);
    near(await camera(), before, "canvas blur clears held movement");
  } finally {
    await page.keyboard.up("w");
  }
  await navigateControlPage(page, "chat");
  before = await settled();
  await page.locator("#chat-input").focus();
  await page.keyboard.type("wasdz", { delay: 25 });
  assert.equal(await page.locator("#chat-input").inputValue(), "wasdz");
  await page.keyboard.press('Tab');
  near(await settled(), before, "typing does not operate the camera");
  checks.push("focus loss releases held keys and chat typing stays unaffected");

  await navigateControlPage(page, "appearance");
  await enter();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  before = await settled();
  await drag(page, "left", 30, 15);
  near(await settled(), before, "Esc disables rotation");
  await enter();
  await page.locator("#camera-edit").click();
  assert.equal(
    await page.locator("#camera-edit").getAttribute("aria-pressed"),
    "false",
    "Done button really exits, including canvas blur ordering",
  );
  checks.push("Esc and the Done button exit adjustment mode");

  await enter();
  await page.keyboard.down("w");
  await page.waitForTimeout(100);
  await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes("index.html") && !new URL(win.webContents.getURL()).searchParams.has("pet"))
      ?.hide(),
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#camera-edit")?.getAttribute("aria-pressed") ===
      "false",
    null,
    { polling: 100 },
  );
  before = await settled();
  await page.waitForTimeout(350);
  near(await camera(), before, "native hide releases movement");
  await instance.evaluate(({ BrowserWindow }) => {
    const controls = BrowserWindow.getAllWindows().find(
      (win) => win.webContents.getURL().includes("index.html") && !new URL(win.webContents.getURL()).searchParams.has("pet"),
    );
    controls?.show();
    controls?.focus();
  });
  await page.keyboard.up("w");
  if (process.env.MMD_TEST_MODEL)
    await page.waitForFunction(
      () =>
        /模型已就绪|VMD 播放中/.test(document.querySelector("#stage-status")?.textContent ?? ''),
    );
  near(await settled(), before, "showing the window keeps its camera framing");
  assert.equal(
    await page.locator("#camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  checks.push(
    "native hide exits edit mode, releases movement, and restores the preview on show",
  );

  await pet.bringToFront();
  await pet.waitForSelector("#pet-camera-edit");
  await pet.locator('#stage canvas').focus();
  await pet.mouse.move(-20, -20);
  // A negative CDP position does not reliably produce the native window-leave
  // event after switching between Electron windows on Windows.
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      new URL(candidate.webContents.getURL()).searchParams.has("pet"),
    );
    window.webContents.sendInputEvent({ type: "mouseLeave", x: -20, y: -20 });
  });
  const effectiveOpacity = () =>
    pet.locator("#pet-camera-edit").evaluate((element) => {
      let opacity = 1;
      for (let current = element; current; current = current.parentElement)
        opacity *= Number(getComputedStyle(current).opacity);
      return opacity;
    });
  await pet.waitForFunction(
    () =>
      Number(getComputedStyle(document.querySelector("#pet-toolbar")).opacity) <
      0.15,
    null,
    { timeout: 3000 },
  );
  assert.ok(
    (await effectiveOpacity()) < 0.15,
    "pet toolbar is hidden outside hover",
  );
  let box = await pet.locator("#stage canvas").boundingBox();
  await approachPetControl('#pet-camera-edit');
  await pet.waitForFunction(() => {
    let opacity = 1;
    for (
      let current = document.querySelector("#pet-camera-edit");
      current;
      current = current.parentElement
    )
      opacity *= Number(getComputedStyle(current).opacity);
    return opacity > 0.85;
  });
  checks.push("desktop pet toolbar appears near its actual controls");
  await pet.waitForFunction(
    () =>
      document.querySelector("#pet-window-size").textContent ===
      `窗口 ${window.innerWidth} × ${window.innerHeight}`,
  );
  for (const [selector, label] of [
    ["#pet-move-window", /按住拖动窗口/],
    ["#pet-size-toggle", /窗口调整/],
    ["#pet-camera-edit", /镜头/],
    ["#pet-voice-input", /语音输入.*关闭/],
    ["#pet-screen-sharing", /屏幕共享.*关闭/],
    ["#pet-camera-sharing", /摄像头共享.*关闭/],
    ["#pet-system-audio-sharing", /系统声音律动.*关闭/],
    ["#pet-developer-mode", /开发者模式.*关闭/],
    ["#open-controls", /打开控制窗口/],
  ]) {
    await approachPetControl(selector);
    await pet.locator(selector).hover();
    await pet.locator("#pet-tooltip").waitFor({ state: "visible" });
    assert.match(
      await pet.locator("#pet-tooltip").textContent(),
      label,
      `${selector} tooltip explains its action`,
    );
    assert.equal(
      await pet.locator(selector).getAttribute("aria-describedby"),
      "pet-tooltip",
    );
    const inside = await pet.locator("#pet-tooltip").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    });
    assert.ok(inside, `${selector} tooltip fits inside the pet window`);
  }
  await pet.locator("#stage canvas").hover();
  await pet.locator("#pet-tooltip").waitFor({ state: "hidden" });
  checks.push(
    "all nine toolbar actions show readable tooltips inside the pet window; current dimensions are shown",
  );

  const initialBounds = await bounds();
  await approachPetControl('#pet-size-toggle');
  await pet.locator("#pet-size-toggle").click();
  await pet.waitForFunction(() => document.body.classList.contains('window-adjusting'));
  for (const corner of ['nw', 'ne', 'sw', 'se']) assert.ok(await pet.locator(`#pet-resize-${corner}`).isVisible());
  await pet.keyboard.press('Escape');
  assert.equal(await pet.locator('#pet-size-toggle').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await bounds(), initialBounds);
  checks.push(
    "window adjustment exposes four corners and Escape exits without changing geometry; sustained resize has a separate host/UI smoke",
  );

  assert.equal(
    await pet.locator("#pet-camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  before = await camera();
  const dragBounds = await bounds();
  await drag(pet, "left", -28, -18);
  assert.deepEqual(
    await bounds(),
    dragBounds,
    "ordinary pet canvas drag does not move the native window",
  );
  near(
    await settled(),
    before,
    "inactive pet canvas does not rotate the camera",
  );
  await nativeDrag(-28, -18);
  let moved = await bounds();
  assert.ok(
    Math.hypot(moved.x - dragBounds.x, moved.y - dragBounds.y) > 2,
    "holding the dedicated move button drags the native pet window",
  );
  near(await settled(), before, "pet move button does not rotate the camera");
  const releasedBounds = await bounds();
  await pet.mouse.move(50, 50);
  await pet.waitForTimeout(200);
  assert.deepEqual(
    await bounds(),
    releasedBounds,
    "releasing the move button stops dragging",
  );
  checks.push(
    "only the held pet move button drags its native window; canvas and released mouse stay still",
  );

  await page.evaluate(() => {
    window.cameraSyncProbe = null;
    window.desktop.onSettings((settings) => {
      window.cameraSyncProbe = settings.camera;
    });
  });
  await frameFromButton('portrait');
  await enter(pet, "#pet-camera-edit");
  await smallRotationChecks(pet, 'pet camera');
  await tabFramingChecks(pet, '#pet-camera-edit', fullReference, 'pet camera');
  before = await camera();
  const editedBounds = await bounds();
  await drag(pet, "left", 32, 10);
  after = await settled();
  assert.ok(
    Math.abs(after.yaw - before.yaw) > 1,
    "pet left drag edits the camera",
  );
  eyeUnchanged(after, before, 'pet left drag');
  assert.deepEqual(
    await bounds(),
    editedBounds,
    "pet camera rotation does not drag the native window",
  );
  before = after;
  await drag(pet, "right", 30, 12);
  after = await settled();
  assert.ok(
    norm(subtract(center(after), center(before))) > 0.005,
    "pet right mouse pans",
  );
  orientationUnchanged(after, before, "pet right pan");
  assert.deepEqual(
    await bounds(),
    editedBounds,
    "pet camera pan does not move the native window",
  );
  before = after;
  after = await hold(pet, "w");
  movedAlong(before, after, basis(before).forward, "pet keyboard W");
  await page.waitForFunction(() => !!window.cameraSyncProbe);
  near(
    canonical(await page.evaluate(() => window.cameraSyncProbe)),
    after,
    "pet camera changes synchronize to controls",
  );
  await pet.keyboard.press("Escape");
  assert.equal(
    await pet.locator("#pet-camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  const restoredDragBounds = await bounds();
  await nativeDrag(-22, -14);
  moved = await bounds();
  assert.ok(
    Math.hypot(moved.x - restoredDragBounds.x, moved.y - restoredDragBounds.y) >
      2,
    "dedicated move button works after Esc exits editing",
  );
  checks.push(
    "pet camera edit uses mouse/keyboard without moving its native window; dedicated move button works after Esc",
  );

  const saved = await settled();
  assert.ok(
    Math.abs(saved.targetZ) > 0.005,
    "the saved view retains nonzero target depth after camera-plane/world travel",
  );
  await page.bringToFront();
  await page.screenshot({ path: path.join(output, "camera-controls.png") });
  await close();
  await launch();
  if (process.env.MMD_TEST_MODEL)
    await page.waitForFunction(
      () =>
        /模型已就绪|VMD 播放中/.test(document.querySelector("#stage-status")?.textContent ?? ''),
      null,
      { timeout: 45000 },
    );
  near(await camera(), saved, "restart preserves full 3D camera coordinates");
  assert.equal(
    await page.locator("#camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(
    await pet.locator("#pet-camera-edit").getAttribute("aria-pressed"),
    "false",
  );
  checks.push(
    "full target XYZ framing persists across restart while adjustment mode resets off",
  );
  assert.deepEqual(errors, []);
  report = {
    status: "PASS",
    packaged,
    modelTested: !!process.env.MMD_TEST_MODEL,
    checks,
    camera: saved,
    errors,
    builds,
    smallDragFrames,
    precisionSamples,
    tabSamples,
    nativeOsInputSuppressed: true,
    physicalPointerVerified: false,
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report = {
    status: "FAILED",
    packaged,
    checks,
    error: error.message,
    errors,
    builds,
    nativeDrags,
    smallDragFrames,
    precisionSamples,
    tabSamples,
    nativeOsInputSuppressed: true,
    physicalPointerVerified: false,
    ui: await pet?.evaluate(() => ({ body: document.body.className, active: document.activeElement?.id,
      toolbar: document.querySelector('#pet-toolbar')?.className,
      keyboardFocus: document.querySelector('#pet-toolbar :focus-visible')?.id,
      hovered: [...document.querySelectorAll(':hover')].map(element => element.id || element.tagName) })).catch(() => null),
  };
  try {
    await page?.screenshot({
      path: path.join(output, "failure.png"),
      timeout: 5000,
    });
  } catch {}
  throw error;
} finally {
  const reportText = JSON.stringify(
    report ?? { status: "FAILED", packaged, checks, errors, builds, nativeDrags },
    null,
    2,
  );
  await writeFile(
    path.join(output, "report.json"),
    reportText,
  );
  await writeFile(
    path.join(output, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    reportText,
  );
  await writeFile(
    path.join(output, "native-drag.json"),
    JSON.stringify(nativeDrags, null, 2),
  );
  await close();
}
