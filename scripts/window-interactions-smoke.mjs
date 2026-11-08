import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';

// Real isolated Electron/preload/native bounds and rendering, with a controlled
// native-DIP cursor fixture. This does not test a physical mouse or touchpad.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
// Source mode runs this checkout's own build (`pnpm build` first), like the other source smokes.
// The Codex-era rule "frozen source only, never the shared working build" belonged to its shared
// multi-agent workspace and native lease; each Claude worktree is its own build (2026-11-02 smoke triage).
const source = executable ? null : await realpath(path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace));
const output = path.join(workspace, '.local/window-interactions-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const asar = executable ? path.join(path.dirname(executable), 'resources/app.asar') : null;
const identity = { packaged: Boolean(executable), asarSha256: asar ? await hash(asar) : null, harnessSha256: await hash(fileURLToPath(import.meta.url)) };
const cases = [], errors = [], captures = [], trajectories = [];
let instance, controls, pet, failure, phase = 'launch', cleanup = false, modelRequests = 0;
const pass = label => { cases.push(label); console.log(`PASS ${label}`); };
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected} (native DIP rounding)`);
async function poll(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}
const bounds = () => instance.evaluate(() => globalThis.__windowQA.win.getBounds());
const cursor = point => instance.evaluate((_electron, value) => { globalThis.__windowQA.cursor = value; }, point);
const stats = () => instance.evaluate(() => ({ writes: globalThis.__windowQA.writes, events: globalThis.__windowQA.events,
  remote: globalThis.__windowQA.remote, permissions: globalThis.__windowQA.permissions, screenReads: globalThis.__windowQA.screenReads }));
const settings = () => controls.evaluate(() => window.desktop.getSettings());
const preserved = value => {
  const asset = ref => ref ? { path: ref.path, name: ref.name } : ref;
  return { ...Object.fromEntries(['camera', 'provider', 'persona', 'voice', 'tts', 'voiceInput', 'agent'].map(key => [key, value[key]])),
    model: asset(value.model), motion: asset(value.motion), motionLayers: value.motionLayers ? Object.fromEntries(Object.entries(value.motionLayers).map(([key, ref]) => [key, asset(ref)])) : undefined };
};
async function focus() { await instance.evaluate(() => { const q = globalThis.__windowQA; q.win.show(); q.win.focus(); }); }
async function mode(enabled = true) {
  await focus();
  const button = pet.locator('#pet-size-toggle'), pressed = await button.getAttribute('aria-pressed');
  if ((pressed === 'true') !== enabled) { const r = await button.boundingBox(); await pet.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await button.click(); }
  await poll(() => pet.evaluate(want => document.body.classList.contains('window-adjusting') === want, enabled), 'window adjustment mode');
  assert.equal(await pet.locator('.pet-window-adjustment').evaluate(el => getComputedStyle(el).display !== 'none'), enabled, 'the border and corner handles appear only in explicit window adjustment');
}
async function begin(selector) {
  await focus();
  const r = await pet.locator(selector).boundingBox(); assert.ok(r, `${selector} exists`);
  const start = await bounds(), point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  await cursor({ x: start.x + point.x, y: start.y + point.y });
  await pet.mouse.move(point.x, point.y); await pet.mouse.down();
  await poll(() => pet.locator(selector).evaluate(el => el.classList.contains('dragging')), 'pointer capture starts');
  await pet.waitForTimeout(40);
  const config = await settings();
  return { start, logicalSize: config.pet.size ?? { width: Math.round(400 * (config.pet.scale ?? 1)), height: Math.round(560 * (config.pet.scale ?? 1)) }, cursor: { x: start.x + point.x, y: start.y + point.y } };
}
async function move(fixture, dx, dy) { await cursor({ x: fixture.cursor.x + dx, y: fixture.cursor.y + dy }); await pet.waitForTimeout(50); return bounds(); }
async function release() { await pet.mouse.up(); await poll(() => pet.evaluate(() => !document.querySelector('.dragging')), 'pointer capture releases'); await pet.waitForTimeout(100); }
async function unchangedAfterStop() {
  const at = await bounds(); await instance.evaluate(() => { globalThis.__windowQA.cursor.x += 80; globalThis.__windowQA.cursor.y += 50; });
  await pet.waitForTimeout(150); assert.deepEqual(await bounds(), at, 'a stopped operation must not move again');
}
async function capture(label, referenceRatio) {
  const metrics = await pet.evaluate(() => {
    const canvas = document.querySelector('#stage canvas'), r = JSON.parse(canvas.dataset.interactionRegion ?? '{}');
    if (canvas !== window.__windowQACanvas) throw Error('Canvas was replaced during window interaction');
    return { width: innerWidth, height: innerHeight, bufferWidth: canvas.width, bufferHeight: canvas.height,
      axisRatio: Math.hypot(r.axisXX, r.axisXY) / Math.hypot(r.axisYX, r.axisYY) };
  });
  assert.ok(Math.abs(metrics.bufferWidth / metrics.bufferHeight - metrics.width / metrics.height) < 0.015, 'drawing buffer follows the viewport aspect');
  assert.ok(Number.isFinite(metrics.axisRatio) && metrics.axisRatio > 0);
  if (referenceRatio) assert.ok(Math.abs(metrics.axisRatio / referenceRatio - 1) < 0.18, 'projected Gene proportions remain natural across viewport ratios');
  const native = await instance.evaluate(async () => {
    const image = await globalThis.__windowQA.win.webContents.capturePage(), bitmap = image.toBitmap(), size = image.getSize(); let opaque = 0, modelOpaque = 0;
    for (let n = 3; n < bitmap.length; n += 4) if (bitmap[n] > 16) { opaque++; const pixel = (n - 3) / 4, x = pixel % size.width, y = Math.floor(pixel / size.width);
      if (x > size.width * 0.25 && x < size.width * 0.75 && y > Math.min(100, size.height * 0.25) && y < size.height - 80) modelOpaque++; }
    return { empty: image.isEmpty(), opaque, modelOpaque, size };
  });
  assert.equal(native.empty, false); assert.ok(native.opaque > 1000 && native.modelOpaque > 100, 'the native frame contains model pixels outside the toolbar and input');
  await pet.locator('#stage').screenshot({ path: path.join(output, `${label}.png`), omitBackground: true });
  captures.push({ label, ...metrics, native }); return metrics.axisRatio;
}
async function resize(corner, width, height) {
  await mode(); const before = await settings(), f = await begin(`#pet-resize-${corner}`);
  const west = corner.endsWith('w'), north = corner.startsWith('n');
  const actual = await move(f, (width - f.logicalSize.width) * (west ? -1 : 1), (height - f.logicalSize.height) * (north ? -1 : 1));
  near(actual.width, width, 'native width'); near(actual.height, height, 'native height');
  assert.ok(Math.abs((west ? actual.x + actual.width : actual.x) - (west ? f.start.x + f.start.width : f.start.x)) <= 2, 'opposite x corner stays fixed within native DIP rounding');
  assert.ok(Math.abs((north ? actual.y + actual.height : actual.y) - (north ? f.start.y + f.start.height : f.start.y)) <= 2, 'opposite y corner stays fixed within native DIP rounding');
  assert.deepEqual((await settings()).pet.size, before.pet.size, 'live resizing does not persist each sample');
  await release(); await poll(async () => JSON.stringify((await settings()).pet.size) === JSON.stringify({ width, height }), 'release persists dimensions');
  return actual;
}
async function close() {
  if (!instance) return;
  const current = instance, child = current.process(); instance = null; let timer;
  try { await Promise.race([current.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Close timed out')), 10000); })]); }
  catch (error) { if (child.pid && child.exitCode === null) execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); errors.push(`Cleanup: ${error.message}`); }
  finally { clearTimeout(timer); cleanup = child.exitCode !== null; }
}
async function launch() {
  const env = (await createClaudeIsolation()).environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({ ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] } : { args: [source, `--user-data-dir=${profile}`] }), cwd: source ?? path.dirname(executable), env, timeout: 30000 });
  const watched = new WeakSet();
  const watch = page => { if (watched.has(page)) return; watched.add(page); page.on('pageerror', e => errors.push(e.message)); page.on('request', request => { if (/\.pmx(?:[?#]|$)/i.test(request.url())) modelRequests++; }); };
  instance.on('window', watch); await instance.firstWindow();
  for (const page of instance.windows()) watch(page);
  const actual = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(path.resolve(actual.profile), profile); assert.equal(actual.packaged, Boolean(executable));
  assert.equal(path.resolve(actual.appPath).toLowerCase(), path.resolve(asar ?? source).toLowerCase());
  await instance.evaluate(({ BrowserWindow, screen, session }) => {
    const q = globalThis.__windowQA = { writes: [], events: [], remote: [], permissions: [], screenReads: [], cursor: { x: 0, y: 0 } };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => { const denied = /^https?:/i.test(request.url); if (denied) q.remote.push(request.url); done({ cancel: denied }); });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_web, permission, done) => { q.permissions.push(permission); done(false); });
    screen.getCursorScreenPoint = () => { if (q.screenReads.length < 500) q.screenReads.push({ at: Date.now(), ...q.cursor }); return { ...q.cursor }; };
    for (const win of BrowserWindow.getAllWindows()) {
      const url = win.webContents.getURL(); if (!url.includes('index.html')) continue;
      if (new URL(url).searchParams.has('pet')) q.win = win; else q.controls = win;
    }
  });
  await poll(async () => {
    for (const page of instance.windows()) { if (!page.url().includes('index.html')) continue; if (new URL(page.url()).searchParams.has('pet')) pet = page; else controls = page; }
    return Boolean(pet && controls);
  }, 'two application windows', 20000);
  await pet.waitForSelector('#stage canvas'); await controls.waitForSelector('#stage canvas');
  await instance.evaluate(({ BrowserWindow }) => { const q = globalThis.__windowQA; q.win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pet=1')); q.controls = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html') && !new URL(w.webContents.getURL()).searchParams.has('pet')); });
  // CDP owns this fixture's pressed pointer. Native moves under the real idle
  // OS cursor otherwise inject buttons=0 and invalidate synthetic capture.
  // Ignore native input only; CDP still exercises the actual DOM/preload path.
  await instance.evaluate(() => {
    const win = globalThis.__windowQA.win, ignore = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = () => ignore(true);
    win.setIgnoreMouseEvents(true);
  });
}

try {
  await launch(); phase = 'Gene fixture';
  await controls.evaluate(async () => {
    const s = await window.desktop.getSettings(); s.pet.followMouse = false; s.pet.breath = 0; s.voice.enabled = false; s.voice.volume = 0;
    s.provider = { kind: 'claude', model: '' }; await window.desktop.saveSettings(s); // Never chats: Claude Code is an inert placeholder here.
    await window.desktop.useBundledModel(); await window.desktop.recoverPet();
  });
  await poll(() => pet.locator('#stage canvas').evaluate(c => Number.isFinite(JSON.parse(c.dataset.interactionRegion ?? '{}').axisXX)), 'Gene native render', 30000);
  assert.match((await settings()).model.name, /^gene\.pmx$/i);
  await instance.evaluate(() => {
    const q = globalThis.__windowQA; q.controls.hide(); q.win.focus(); q.win.setTitle('soft hearts · 窗口交互隔离验收');
    for (const method of ['setPosition', 'setBounds']) { const original = q.win[method].bind(q.win); q.win[method] = (...args) => { q.writes.push({ method, args }); return original(...args); }; }
    for (const event of ['show', 'hide', 'resize']) q.win.on(event, () => q.events.push(event));
  });
  await pet.evaluate(() => {
    window.__windowQACanvas = document.querySelector('#stage canvas'); document.querySelector('#chat-input').value = '保留窗口调整草稿';
    window.__windowQAEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'blur', 'resize']) window.addEventListener(type, event => {
      window.__windowQAEvents.push({ type, at: performance.now(), target: event.target?.id, x: event.clientX, y: event.clientY, buttons: event.buttons, dragging: document.querySelector('.dragging')?.id, adjusting: document.body.classList.contains('window-adjusting') });
      if (window.__windowQAEvents.length > 150) window.__windowQAEvents.shift();
    }, true);
  });
  const baseline = preserved(await settings()), moodBefore = await pet.evaluate(() => window.desktop.getMood()), requestCount = modelRequests;
  const runtime = await pet.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(runtime.voiceInput || runtime.screenSharing || runtime.cameraSharing, false);
  assert.equal((await pet.evaluate(() => window.desktop.getSystemAudioState())).active, false);
  assert.equal(await pet.locator('.pet-window-adjustment').evaluate(el => getComputedStyle(el).display), 'none');
  assert.equal(await pet.locator('#pet-resize-nw').evaluate(el => el.getBoundingClientRect().width), 0, 'hidden adjustment handles reserve no normal companion area');
  pass('isolated public Gene, media off, no provider or normal profile');

  phase = 'continuous hold'; const f = await begin('#pet-move-window'), beforeMove = await stats();
  for (const [dx, dy] of [[25, 12], [70, 25], [30, 5], [-25, -10], [0, 0]]) {
    const actual = await move(f, dx, dy); near(actual.x, Math.round(f.start.x + dx), 'native x'); near(actual.y, Math.round(f.start.y + dy), 'native y');
    near(actual.width, f.start.width, 'held width never accumulates rounding'); near(actual.height, f.start.height, 'held height never accumulates rounding'); trajectories.push(actual);
  }
  const stable = await bounds(), writes = (await stats()).writes.length;
  await pet.waitForTimeout(200); assert.equal((await stats()).writes.length, writes);
  await pet.evaluate(() => { for (const screenX of [9999, -5000, 12, 8000]) document.querySelector('#pet-move-window').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, buttons: 1, screenX, screenY: screenX })); });
  await pet.waitForTimeout(80); assert.deepEqual(await bounds(), stable); assert.equal((await stats()).writes.length, writes);
  const afterMove = await stats(); assert.deepEqual(afterMove.events.filter(e => e !== 'resize'), beforeMove.events.filter(e => e !== 'resize'));
  assert.ok(afterMove.writes.slice(beforeMove.writes.length).every(r => r.method === 'setBounds' && r.args[0].width === f.start.width && r.args[0].height === f.start.height), 'movement always commands the original dimensions, never rounded native dimensions');
  await release(); await unchangedAfterStop(); pass('fixed geometry commands prevent cumulative fractional-DPI growth; stationary and renderer jitter cause zero extra writes/show/hide');

  phase = 'repeated continuous holds';
  for (let hold = 0; hold < 3; hold++) {
    const held = await begin('#pet-move-window'), writesBefore = (await stats()).writes.length;
    for (let step = 0; step < 12; step++) {
      const dx = Math.round(Math.sin(step * Math.PI / 3) * 60), dy = Math.round(Math.sin(step * Math.PI / 2) * 20);
      const actual = await move(held, dx, dy);
      near(actual.x, Math.round(held.start.x + dx), 'repeated hold x'); near(actual.y, Math.round(held.start.y + dy), 'repeated hold y');
      near(actual.width, held.logicalSize.width, 'repeated hold width'); near(actual.height, held.logicalSize.height, 'repeated hold height');
      trajectories.push({ hold, step, ...actual });
      if (step === 3 || step === 9) await capture(`gene-held-${hold}-${step}`);
      assert.equal(await pet.locator('#pet-move-window').evaluate(el => el.classList.contains('dragging')), true, 'native captures preserve the held operation');
    }
    const heldWrites = (await stats()).writes.length; await pet.waitForTimeout(1000);
    assert.equal((await stats()).writes.length, heldWrites, 'one stationary held second performs no geometry writes');
    assert.ok((await stats()).writes.slice(writesBefore).every(row => row.method === 'setBounds' && row.args[0].width === held.logicalSize.width && row.args[0].height === held.logicalSize.height));
    await release(); await unchangedAfterStop();
  }
  pass('three repeated twelve-point holds preserve logical dimensions and nonempty native model samples; each stationary held second performs no writes');

  phase = 'four corners'; await mode(); const ratio = await capture('gene-before');
  for (const corner of ['nw', 'ne', 'sw', 'se']) { const b = await bounds(); await resize(corner, b.width + 20, b.height + 15); await capture(`gene-${corner}`, ratio); }
  const staleSettings = await settings(); assert.ok(staleSettings.pet.size, 'stale form must contain an older nonempty size');
  await resize('se', 640, 280); const wideBounds = await bounds(); await capture('gene-wide', ratio);
  await controls.evaluate(old => window.desktop.saveSettings({ ...old, voice: { ...old.voice, rate: 1.1 } }), staleSettings);
  assert.deepEqual((await settings()).pet.size, { width: 640, height: 280 }); assert.equal((await settings()).voice.rate, 1.1);
  assert.deepEqual(await bounds(), wideBounds, 'an old full form must not replay its obsolete window size or corner');
  await controls.evaluate(async rate => { const current = await window.desktop.getSettings(); await window.desktop.saveSettings({ ...current, voice: { ...current.voice, rate } }); }, baseline.voice.rate);
  pass('queued older full settings with a nonempty size preserve the new dimensions and corner while accepting unrelated voice edits');
  await resize('se', 280, 650); await capture('gene-tall', ratio);
  assert.deepEqual(preserved(await settings()), baseline); assert.equal(modelRequests, requestCount);
  assert.equal(await pet.locator('#chat-input').inputValue(), '保留窗口调整草稿');
  assert.equal((await pet.evaluate(() => window.desktop.getMood())).snapshot.lastInteractionAt, moodBefore.snapshot.lastInteractionAt);
  pass('four fixed opposite corners and wide/tall viewports preserve Gene proportions, canvas/model, camera, draft and non-size settings; persist only on release');

  phase = 'mode lifecycle'; await pet.keyboard.press('Escape'); await poll(() => pet.locator('#pet-size-toggle').getAttribute('aria-pressed').then(v => v === 'false'), 'Escape exits mode');
  await mode(); await pet.locator('#pet-window-done').click(); assert.equal(await pet.locator('#pet-size-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await pet.locator('.pet-window-adjustment').evaluate(el => getComputedStyle(el).display), 'none');
  await mode(); await begin('#pet-resize-se'); await pet.keyboard.press('Escape'); await pet.mouse.up(); await unchangedAfterStop();
  // CDP retains its synthetic pointer capture across OS focus requests. Exercise
  // both real registered blur handlers explicitly; this is not physical alt-tab.
  await mode(); await begin('#pet-resize-se'); await instance.evaluate(() => globalThis.__windowQA.win.emit('blur'));
  await pet.evaluate(() => window.dispatchEvent(new Event('blur')));
  await poll(() => pet.evaluate(() => !document.body.classList.contains('window-adjusting')), 'blur exits mode'); await pet.mouse.up(); await unchangedAfterStop();
  await mode(); await begin('#pet-resize-se'); await instance.evaluate(() => globalThis.__windowQA.win.hide());
  await poll(() => pet.evaluate(() => !document.body.classList.contains('window-adjusting')), 'hide exits mode'); await pet.mouse.up(); await unchangedAfterStop(); await focus();
  pass('done/Escape, hold Escape, host+renderer blur event fixtures and actual native hide stop movement');

  phase = 'authorization';
  assert.equal(await controls.evaluate(async () => { try { await window.desktop.setPetWindowOperation('move'); return false; } catch { return true; } }), true);
  assert.equal(await pet.evaluate(async () => { try { await window.desktop.setPetWindowOperation('not-a-window-operation'); return false; } catch { return true; } }), true);
  assert.equal(await pet.locator('#pet-size-toggle').getAttribute('aria-pressed'), 'false');
  assert.deepEqual((await stats()).remote, []); assert.deepEqual((await stats()).permissions, []); pass('controls and invalid operations rejected, no network or device permissions');

  phase = 'camera viewport ratios';
  const nativeBeforeCamera = await bounds();
  await instance.evaluate(() => globalThis.__windowQA.controls.showInactive());
  await controls.waitForFunction(() => /模型已就绪|VMD 播放中/.test(document.querySelector('#stage-status')?.textContent ?? ''), null, { timeout: 30000 });
  const eye = camera => {
    const yaw = camera.yaw * Math.PI / 180, pitch = camera.pitch * Math.PI / 180;
    return [camera.targetX + Math.sin(yaw) * Math.cos(pitch) * camera.distance, camera.targetY + Math.sin(pitch) * camera.distance, (camera.targetZ ?? 0) + Math.cos(yaw) * Math.cos(pitch) * camera.distance];
  };
  for (const [width, height] of [[285, 790], [640, 280], [400, 560]]) {
    await instance.evaluate((_electron, size) => globalThis.__windowQA.win.setBounds({ x: 80, y: 40, ...size }), { width, height });
    await pet.waitForFunction(size => Math.abs(innerWidth - size.width) <= 1 && Math.abs(innerHeight - size.height) <= 1, { width, height });
    await controls.locator('#frame-portrait').click();
    const framed = await controls.evaluate(() => Object.fromEntries(['yaw', 'pitch', 'distance', 'targetX', 'targetY', 'fov'].map(key => [key, Number(document.querySelector(`#camera-${key}`).value)])));
    await poll(async () => { const current = (await settings()).camera; return Object.entries(framed).every(([key, value]) => Math.abs(current[key] - value) < 0.011); }, 'the full portrait preset has been committed before light rotation');
    await pet.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await focus(); await pet.evaluate(() => document.querySelector('#pet-camera-edit').click());
    await poll(() => pet.locator('#pet-camera-edit').getAttribute('aria-pressed').then(value => value === 'true'), 'camera mode in native viewport');
    for (const [dx, dy] of [[2, 0], [-4, 2]]) {
      const cameraBefore = (await settings()).camera, point = { x: width * 0.5, y: height * 0.55 };
      await pet.mouse.move(point.x, point.y); await pet.mouse.down();
      await pet.waitForTimeout(100); assert.deepEqual((await settings()).camera, cameraBefore, 'pressing alone never changes camera');
      await pet.mouse.move(point.x + dx, point.y + dy); await pet.mouse.up();
      await poll(async () => Math.abs((await settings()).camera.yaw - cameraBefore.yaw) > 0.1, 'small drag is saved');
      const cameraAfter = (await settings()).camera, oldEye = eye(cameraBefore), newEye = eye(cameraAfter);
      assert.ok(Object.values(cameraAfter).every(Number.isFinite));
      assert.ok(Math.hypot(...newEye.map((value, index) => value - oldEye[index])) < 1e-7, `small rotations preserve eye across viewport ratios: ${JSON.stringify({width,height,cameraBefore,cameraAfter,oldEye,newEye})}`);
      await capture(`gene-camera-${width}x${height}-${Math.abs(dx)}px`);
    }
    await pet.keyboard.press('Escape'); await pet.waitForTimeout(400);
  }
  await pet.evaluate(camera => window.desktop.savePetView({ camera }), baseline.camera);
  await instance.evaluate((_electron, saved) => globalThis.__windowQA.win.setBounds(saved), nativeBeforeCamera);
  assert.deepEqual(preserved(await settings()), baseline);
  pass('285x790, 640x280 and 400x560 native viewports keep a fixed eye and nonempty model samples after 2–4 CSS px left drags');

  phase = 'restart'; const finalSize = (await settings()).pet.size; await close(); assert.equal(cleanup, true); cleanup = false;
  controls = pet = null; await launch(); await poll(async () => (await settings()).pet.size?.width === finalSize.width, 'persisted size');
  await poll(async () => { const b = await bounds(); return Math.abs(b.width - finalSize.width) <= 1 && Math.abs(b.height - finalSize.height) <= 1; }, 'native dimensions restored');
  assert.deepEqual(preserved(await settings()), baseline);
  assert.equal(await pet.locator('#pet-size-toggle').getAttribute('aria-pressed'), 'false');
  const restarted = await pet.evaluate(() => window.desktop.getRuntimeState()); assert.equal(restarted.voiceInput || restarted.screenSharing || restarted.cameraSharing, false);
  assert.deepEqual((await stats()).remote, []); assert.deepEqual((await stats()).permissions, []);
  pass('restart restores explicit window dimensions without adjustment consent, device capture or unrelated configuration changes');
  assert.deepEqual(errors, []);
} catch (error) { failure = { phase, message: error.message, stack: error.stack, stats: instance ? await stats().catch(() => null) : null, dom: pet ? await pet.evaluate(() => ({ toast:document.querySelector('#toast')?.textContent, dragging:!!document.querySelector('.dragging'), focused:document.hasFocus(), events: window.__windowQAEvents })).catch(() => null) : null }; console.error(error); process.exitCode = 1; }
finally {
  await close();
  if (errors.length || !cleanup) process.exitCode = 1;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure || errors.length || !cleanup ? 'failed' : 'passed', ...identity,
    mockCursor: true, nativeOSPointerIgnored: true, physicalPointerVerified: false, blurFixture: 'host and renderer event dispatch; OS focus transfer was not verified', normalProfileUsed: false, cases, trajectories, captures, errors, failure, cleanup: { appExited: cleanup } }, null, 2));
}
