import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';

// Coordinate the native lease before running. Public Gene and a disposable
// profile only; no chat, network service, capture, user profile or desktop image.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR || workspace);
const output = path.join(workspace, '.local/toolbar-collapse-smoke');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-toolbar-collapse-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile); await mkdir(output, { recursive: true });
const checks = [], errors = [], geometry = [], processIds = [];
let instance, pet, controls, report, phase = 'launch', closedInstances = 0, claude;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
async function poll(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}
async function launch() {
  claude ??= await createClaudeIsolation();
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'MMD_TEST_CODEX', 'MMD_TEST_LOCAL_URL', 'MMD_TEST_LOCAL_MODEL']) delete env[key];
  instance = await electron.launch({ ...(process.env.MMD_TEST_EXE ? {
    executablePath: path.resolve(process.env.MMD_TEST_EXE), args: [`--user-data-dir=${profile}`],
  } : { args: [appDirectory, `--user-data-dir=${profile}`] }), cwd: appDirectory, env });
  processIds.push(instance.process().pid);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  await instance.evaluate(({ session }) => {
    globalThis.__toolbarNetwork = []; globalThis.__toolbarPermissions = [];
    globalThis.fetch = () => { globalThis.__toolbarNetwork.push('host fetch'); return Promise.reject(Error('Toolbar fixture blocks remote requests.')); };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      globalThis.__toolbarNetwork.push('renderer request'); callback({ cancel: true });
    });
    session.defaultSession.setPermissionRequestHandler((_web, permission, callback) => { globalThis.__toolbarPermissions.push(permission); callback(false); });
  });
  await poll(() => {
    pet = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    controls = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    return pet && controls;
  }, 'trusted pet and controls windows');
  for (const page of instance.windows()) page.on('pageerror', error => errors.push(error.message));
  await pet.waitForSelector('#pet-toolbar-toggle');
  await controls.waitForSelector('#chat-input');
  await controls.evaluate(() => window.desktop.useBundledModel());
  await poll(() => pet.evaluate(() => /模型已就绪|VMD 播放中/.test(document.getElementById('pet-status').textContent)), 'Gene rendered', 30000);
}
async function close() {
  if (!instance) return;
  const owned = instance, child = owned.process(); instance = null;
  await owned.close();
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  closedInstances++;
}
async function near() {
  const rect = await pet.locator('#pet-toolbar-toggle').boundingBox(); assert.ok(rect);
  await pet.mouse.move(10, 270); await pet.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await poll(() => pet.evaluate(() => document.getElementById('pet-toolbar').classList.contains('is-visible')), 'toolbar near visibility');
}
async function folded(expected) {
  await poll(() => pet.evaluate(value => {
    const toolbar = document.getElementById('pet-toolbar'), toggle = document.getElementById('pet-toolbar-toggle');
    return toolbar.classList.contains('is-collapsed') === value && toggle.getAttribute('aria-expanded') === String(!value) && toggle.textContent === (value ? '<' : '>');
  }, expected), expected ? 'folded toolbar' : 'expanded toolbar');
}
async function state() {
  const settings = await pet.evaluate(async () => {
    const [value, runtime, audio] = await Promise.all([window.desktop.getSettings(), window.desktop.getRuntimeState(), window.desktop.getSystemAudioState()]);
    const asset = item => item ? { path: item.path, name: item.name } : null;
    return { model: asset(value.model), motion: asset(value.motion), layers: value.motionLayers ? { gesture: asset(value.motionLayers.gesture), expression: asset(value.motionLayers.expression) } : null,
      camera: value.camera, pet: value.pet, provider: value.provider, persona: value.persona, voice: value.voice, agent: value.agent, tts: value.tts, runtime, audio };
  });
  const bounds = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).getBounds());
  return { settings, bounds };
}
async function safe() {
  const value = await state();
  assert.equal(value.settings.runtime.voiceInput, false); assert.equal(value.settings.runtime.screenSharing, false); assert.equal(value.settings.runtime.cameraSharing, false); assert.equal(value.settings.audio.active, false);
  assert.deepEqual(await instance.evaluate(() => globalThis.__toolbarNetwork), []);
  assert.deepEqual(await instance.evaluate(() => globalThis.__toolbarPermissions), []);
}
try {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, model: null, motion: null,
    provider: { kind: 'claude', model: '' }, persona: 'Public toolbar fixture.', // Never chats: Claude Code is an inert placeholder here.
    pet: { visible: true, alwaysOnTop: true, clickThrough: false, followMouse: false, scale: 1, fps: 24 },
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 }, tts: { provider: 'system', apiHost: '', apiKey: '', introduced: true } }));
  await launch(); await folded(false); await near(); await safe();
  const toggle = pet.locator('#pet-toolbar-toggle');
  await toggle.hover();
  await poll(() => pet.evaluate(() => !document.getElementById('pet-tooltip').classList.contains('hidden') && document.getElementById('pet-tooltip').textContent === '收起工具栏'), 'expanded tooltip');
  const initial = await state();
  const expanded = await pet.locator('#pet-toolbar').boundingBox(); assert.ok(expanded && expanded.width > 100);
  await pet.locator('#pet-toolbar').screenshot({ path: path.join(output, 'toolbar-expanded.png') });
  check('startup is expanded with a readable manual button and near-hover tooltip');
  phase = 'collapse'; await toggle.click(); await folded(true);
  const collapsed = await pet.locator('#pet-toolbar').boundingBox(); assert.ok(collapsed);
  assert.ok(Math.abs(collapsed.width - 41) <= 1 && Math.abs(collapsed.height - 41) <= 1, 'real toolbar shrinks to the one-button footprint');
  geometry.push({ expanded: { width: expanded.width, height: expanded.height }, collapsed: { width: collapsed.width, height: collapsed.height } });
  const hiddenIds = await pet.evaluate(() => [...document.querySelectorAll('#pet-toolbar > button:not(#pet-toolbar-toggle)')].map(button => {
    if (getComputedStyle(button).display !== 'none' || button.getClientRects().length) throw Error(`Folded action remains in layout: ${button.id}`);
    return button.id;
  }));
  assert.ok(hiddenIds.length >= 9);
  await pet.locator('#pet-toolbar').screenshot({ path: path.join(output, 'toolbar-collapsed.png') });
  const oldPoint = { x: expanded.x + 12, y: expanded.y + 18 };
  assert.ok(oldPoint.x < collapsed.x - 24, 'old strip probe is outside the collapsed near zone');
  assert.equal(await pet.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest('#pet-toolbar')), oldPoint), false, 'no transparent old toolbar intercepts the model');
  await pet.mouse.move(oldPoint.x, oldPoint.y); await pause(1100); await folded(true); await near(); await folded(true);
  check('collapse removes other actions from layout and hit testing; pointer motion only reveals the small handle');
  phase = 'keyboard';
  await toggle.focus();
  for (let index = 0; index < 12; index++) {
    await pet.keyboard.press('Tab');
    assert.ok(!hiddenIds.includes(await pet.evaluate(() => document.activeElement?.id)), 'Tab cannot focus a folded action');
  }
  await toggle.focus(); await pet.keyboard.press('Enter'); await folded(false);
  await near(); await toggle.click(); await folded(true); await toggle.focus(); await pet.keyboard.press('Space'); await folded(false);
  check('hidden actions leave Tab order and the actual button expands through Enter and Space');
  phase = 'state-preservation';
  await pet.locator('#chat-input').fill('未发送的工具栏测试草稿');
  await near(); await toggle.click(); await folded(true);
  assert.equal(await pet.locator('#chat-input').inputValue(), '未发送的工具栏测试草稿');
  assert.deepEqual(await state(), initial); await safe();
  await pet.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await pet.evaluate(() => getComputedStyle(document.getElementById('pet-toolbar')).transitionDuration.split(',').every(value => parseFloat(value) === 0)));
  await pet.emulateMedia({ reducedMotion: 'no-preference' });
  check('manual folding preserves draft, model, camera, native bounds, settings and all disabled media; reduced motion removes transitions');
  phase = 'hide-show';
  for (const visible of [false, true]) {
    await instance.evaluate(({ BrowserWindow }, show) => {
      const owner = BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'));
      show ? owner.showInactive() : owner.hide();
    }, visible);
    await poll(() => instance.evaluate(({ BrowserWindow }, show) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).isVisible() === show, visible), 'native pet visibility');
  }
  await near(); await folded(true); await safe();
  assert.equal(await pet.locator('#chat-input').inputValue(), '未发送的工具栏测试草稿');
  check('hide and show preserve the same window folded state and draft');
  phase = 'restart'; await close(); await launch(); await folded(false); await near(); await safe();
  assert.deepEqual(errors, []);
  check('a full restart with the same disposable profile starts expanded; no preference is persisted');
  report = { ok: true };
} catch (error) { report = { ok: false, phase, failure: error.stack ?? String(error) }; console.error(error); process.exitCode = 1; }
finally {
  await close().catch(error => { errors.push(`owned close: ${error.message}`); process.exitCode = 1; });
  Object.assign(report ??= { ok: false }, { checks, errors, geometry, processIds, closedInstances,
    applicationMode: process.env.MMD_TEST_EXE ? 'packaged' : 'source',
    limits: ['Controlled Electron/CDP keyboard and mouse input is not physical input acceptance.', 'Direct scalp/contact fading is covered by targeted pure tests; this smoke does not synthesize a real scalp gesture.', 'All media remained disabled; no capture, cloud, normal profile or desktop screenshots were used.'] });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('soft-toolbar-collapse-'));
  await rm(resolved, { recursive: true, force: true });
}
