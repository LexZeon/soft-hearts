import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';

// Public Gene, default mood parameters and real Electron DOM/rendering. CDP
// pointer input is controlled test input, not a physical mouse/touchpad result.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
const source = process.env.MMD_TEST_APP_DIR ? await realpath(path.resolve(process.env.MMD_TEST_APP_DIR)) : null;
assert.ok(executable || source, 'Select a frozen source or isolated package.');
if (source) assert.notEqual(source.toLowerCase(), (await realpath(workspace)).toLowerCase(), 'Never run the shared working build.');
const output = path.join(workspace, '.local/hover-zones-smoke'); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'soft-hover-zones-'));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const asar = executable ? path.join(path.dirname(executable), 'resources/app.asar') : null;
const identity = { packaged: Boolean(executable), asarSha256: asar ? await hash(asar) : null, sourceMainSha256: source ? await hash(path.join(source, 'dist-electron/main.cjs')) : null, harnessSha256: await hash(fileURLToPath(import.meta.url)) };
const checks = [], errors = [], samples = {}; let instance, controls, pet, failure, appExited = false, phase = 'launch';
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
async function poll(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}
const state = () => pet.evaluate(() => window.__hoverRead());
const move = point => pet.mouse.move(point.x, point.y);
const visible = (row, zone) => row[zone].visible && row[zone].opacity > 0.95;
async function layout() {
  return pet.evaluate(() => ({ width: innerWidth, height: innerHeight,
    toolbar: document.querySelector('#pet-toolbar').getBoundingClientRect().toJSON(), chat: document.querySelector('.pet-chat').getBoundingClientRect().toJSON(),
    head: JSON.parse(document.querySelector('#stage canvas').dataset.interactionRegion ?? '{}'),
    reserved: [...document.querySelectorAll('.pet-toolbar,.pet-chat,[data-mood-ui]')].map(el => el.getBoundingClientRect().toJSON()).filter(r => r.width > 0 && r.height > 0) }));
}
async function far() { const l = await layout(); await move({ x: 2, y: Math.round(l.height * 0.55) }); }
async function settleHidden() { await far(); await poll(async () => { const s = await state(); return !s.toolbar.visible && !s.chat.visible && s.toolbar.opacity < 0.05 && s.chat.opacity < 0.05; }, 'both independent zones hidden'); }
async function near(zone) {
  const l = await layout(), r = l[zone], point = zone === 'toolbar' ? { x: r.left + r.width / 2, y: r.top + r.height + 20 } : { x: r.left + r.width / 2, y: r.top - 20 };
  assert.ok(point.x > 0 && point.y > 0 && point.x < l.width && point.y < l.height, `${zone} must have an in-window near-zone fixture`);
  await move(point); await poll(async () => visible(await state(), zone), `${zone} reveals nearby`); return point;
}
function headPoint(l, u = 0, v = 0) {
  const h = l.head, p = { x: h.x + h.axisXX * u + h.axisYX * v, y: h.y + h.axisXY * u + h.axisYY * v };
  const outside = r => p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom;
  assert.ok(p.x > 2 && p.y > 2 && p.x < l.width - 2 && p.y < l.height - 2 && l.reserved.every(outside), 'Gene scalp point must be visible and outside actual UI reservations'); return p;
}
async function positionHead() {
  // Configure a genuine camera fixture, never move/replace model geometry or UI.
  for (let attempt = 0; attempt < 5; attempt++) {
    const l = await layout(); if (Math.abs(l.head.y - 220) < 8) return;
    const s = await controls.evaluate(() => window.desktop.getSettings()), camera = s.camera;
    camera.targetY += (220 - l.head.y) * 2 * camera.distance * Math.tan(camera.fov * Math.PI / 360) / l.height;
    await controls.evaluate(value => window.desktop.savePetView({ camera: value }), camera); await pet.waitForTimeout(150);
  }
  assert.ok(Math.abs((await layout()).head.y - 220) < 15, 'Gene scalp must be away from the two hover zones');
}
async function enterHead() {
  const before = await pet.evaluate(() => performance.now()); await move(headPoint(await layout()));
  await poll(async () => { const s = await state(); return s.hand && s.local === 'rua'; }, 'immediate hand and local rua', 250);
  const elapsed = await pet.evaluate(start => performance.now() - start, before); assert.ok(elapsed <= 250, `entry took ${elapsed}ms`); return { before, elapsed };
}
async function close() {
  if (!instance) return;
  const current = instance, child = current.process(); instance = null; let timeout;
  try { await Promise.race([current.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Close timed out')), 10000); })]); }
  catch (error) { errors.push(`Cleanup: ${error.message}`); if (child.pid && child.exitCode === null) execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
  finally { clearTimeout(timeout); appExited = child.exitCode !== null; }
}
try {
  const env = (await createClaudeIsolation()).environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({ ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] } : { args: [source, `--user-data-dir=${profile}`] }), cwd: source ?? path.dirname(executable), env, timeout: 30000 });
  const watched = new WeakSet(), watch = page => { if (watched.has(page)) return; watched.add(page); page.on('pageerror', e => errors.push(e.message)); };
  instance.on('window', watch); await instance.firstWindow();
  const actual = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(path.resolve(actual.profile), profile); assert.equal(actual.packaged, Boolean(executable)); assert.equal(path.resolve(actual.appPath).toLowerCase(), path.resolve(asar ?? source).toLowerCase());
  await poll(async () => { for (const page of instance.windows()) { watch(page); if (!page.url().includes('index.html')) continue; if (new URL(page.url()).searchParams.has('pet')) pet = page; else controls = page; } return Boolean(pet && controls); }, 'two application windows', 20000);
  await pet.waitForSelector('#stage canvas'); await controls.waitForSelector('#stage canvas');
  await instance.evaluate(({ BrowserWindow, session }) => {
    const q = globalThis.__hoverQA = { remote: [], permissions: [] };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => { const denied = /^https?:/i.test(request.url); if (denied) q.remote.push(request.url); done({ cancel: denied }); });
    session.defaultSession.setPermissionCheckHandler(() => false); session.defaultSession.setPermissionRequestHandler((_web, permission, done) => { q.permissions.push(permission); done(false); });
    q.pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pet=1'));
    q.controls = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html') && !new URL(w.webContents.getURL()).searchParams.has('pet'));
  });
  await controls.evaluate(async () => {
    const s = await window.desktop.getSettings(); s.voice.enabled = false; s.voice.volume = 0; s.pet.followMouse = false; s.pet.breath = 0;
    s.provider = { kind: 'claude', model: '' }; await window.desktop.saveSettings(s); // Never chats: Claude Code is an inert placeholder here.
    await window.desktop.useBundledModel(); await window.desktop.recoverPet(); await window.desktop.setMoodExpressions(true);
  });
  await instance.evaluate(() => { globalThis.__hoverQA.controls.hide(); globalThis.__hoverQA.pet.focus(); globalThis.__hoverQA.pet.setTitle('soft hearts · Hover Gene 隔离验收'); });
  await poll(async () => Number.isFinite((await layout()).head.axisXX), 'public Gene head projection', 30000);
  assert.match((await controls.evaluate(() => window.desktop.getSettings())).model.name, /^gene\.pmx$/i);
  assert.deepEqual((await pet.evaluate(() => window.desktop.getMood())).parameters.baseline, { D: 50, O: 50, E: 50, N: 50, C: 50 });
  await pet.evaluate(() => {
    window.__hoverRows = [];
    window.__hoverRead = () => { const zone = selector => { const el = document.querySelector(selector); return { visible: el.classList.contains('is-visible'), opacity: Number(getComputedStyle(el).opacity) }; }, hand = document.querySelector('[data-pet-interaction-cursor]');
      return { at: performance.now(), toolbar: zone('#pet-toolbar'), chat: zone('.pet-chat'), local: document.querySelector('#mood-local-feedback')?.dataset.phase,
        hand: Boolean(hand && !hand.hidden && getComputedStyle(hand).display !== 'none'), feedback: JSON.parse(document.querySelector('#stage canvas').dataset.moodFeedback ?? '{}') }; };
    window.__hoverSampler = setInterval(() => { window.__hoverRows.push(window.__hoverRead()); if (window.__hoverRows.length > 3000) window.__hoverRows.shift(); }, 20);
  });
  const media = await pet.evaluate(() => window.desktop.getRuntimeState()); assert.equal(media.voiceInput || media.screenSharing || media.cameraSharing, false);
  assert.equal((await pet.evaluate(() => window.desktop.getSystemAudioState())).active, false); pass('public Gene/default baseline, system-temp profile, inputs and sharing off');

  phase = 'zone boundaries'; await positionHead(); await settleHidden();
  let l = await layout(); await move({ x: l.width / 2, y: l.height / 2 }); await pet.waitForTimeout(150);
  assert.equal((await state()).toolbar.visible || (await state()).chat.visible, false);
  l = await layout(); await move({ x: l.toolbar.left + l.toolbar.width / 2, y: l.toolbar.top + l.toolbar.height + 25 }); await pet.waitForTimeout(100);
  assert.equal((await state()).toolbar.visible, false, '25 DIP is outside the toolbar entry margin');
  await near('toolbar'); assert.equal((await state()).chat.visible, false);
  l = await layout(); await move({ x: l.toolbar.left + l.toolbar.width / 2, y: l.toolbar.top + l.toolbar.height + 28 }); await pet.waitForTimeout(1100); assert.ok(visible(await state(), 'toolbar'), '32 DIP exit hysteresis retains the toolbar');
  await move({ x: l.toolbar.left + l.toolbar.width / 2, y: l.toolbar.top + l.toolbar.height + 35 }); await pet.waitForTimeout(800); assert.ok(visible(await state(), 'toolbar'), 'leaving preserves the one-second grace');
  await poll(async () => (await state()).toolbar.opacity < 0.05, 'toolbar hides after one-second grace');
  l = await layout(); await move({ x: l.chat.left + l.chat.width / 2, y: l.chat.top - 25 }); await pet.waitForTimeout(100);
  assert.equal((await state()).chat.visible, false, '25 DIP is outside the chat entry margin');
  await near('chat'); assert.equal((await state()).toolbar.visible, false);
  l = await layout(); await move({ x: l.chat.left + l.chat.width / 2, y: l.chat.top - 28 }); await pet.waitForTimeout(1100); assert.ok(visible(await state(), 'chat'));
  await move({ x: l.chat.left + l.chat.width / 2, y: l.chat.top - 35 }); await pet.waitForTimeout(800); assert.ok(visible(await state(), 'chat'));
  await settleHidden(); pass('middle/other zone do not reveal controls; both zones obey 24 DIP entry, 32 DIP exit and one-second leave grace');

  phase = 'focus and adjustment priority'; await near('chat'); await pet.locator('#chat-input').fill('Hover验收保留草稿'); await far(); await pet.waitForTimeout(1300);
  assert.ok(visible(await state(), 'chat')); const outside = { x: 2, y: (await layout()).height * 0.55 }; await pet.mouse.click(outside.x, outside.y); await settleHidden();
  assert.equal(await pet.locator('#chat-input').inputValue(), 'Hover验收保留草稿'); await near('toolbar'); await pet.locator('#pet-size-toggle').click(); await far(); await pet.waitForTimeout(2300);
  assert.ok(visible(await state(), 'toolbar')); assert.equal(await pet.locator('#pet-size-toggle').getAttribute('aria-pressed'), 'true'); await pet.keyboard.press('Escape'); await settleHidden(); pass('input focus and window adjustment hold their own UI; blur/Escape release it and preserve drafts');

  phase = 'immediate hidden-toolbar contact'; await positionHead(); await settleHidden(); const initial = await pet.evaluate(() => window.desktop.getMood());
  samples.immediate = await enterHead(); await pet.waitForTimeout(2300);
  assert.equal((await state()).toolbar.visible, false, 'contact never reveals a hidden toolbar');
  const stationary = await pet.evaluate(() => window.desktop.getMood()); assert.equal(stationary.snapshot.lastInteractionAt, initial.snapshot.lastInteractionAt);
  assert.deepEqual(stationary.snapshot.values, initial.snapshot.values, 'stationary contact provides no reward');
  await settleHidden(); pass('first scalp hit shows hand/local rua within 250ms; stationary contact earns no reward and hidden toolbar stays hidden');

  phase = 'two-second contact deadline'; await near('toolbar'); const entry = await enterHead();
  while (await pet.evaluate(start => performance.now() - start < 2450, entry.before)) {
    const current = await layout(), offset = Math.sin(Date.now() / 90) * 0.008; await move(headPoint(current, offset)); await pet.waitForTimeout(80);
  }
  const trace = await pet.evaluate(start => window.__hoverRows.filter(row => row.at >= start), entry.before), contact = trace.find(row => row.hand && row.local === 'rua');
  assert.ok(contact); const hidden = trace.find(row => row.at > contact.at && !row.toolbar.visible); assert.ok(hidden, 'continuous movement must not restart the contact deadline');
  const delay = hidden.at - contact.at; assert.ok(delay >= 1750 && delay <= 2300, `toolbar fade starts after one two-second wait (${delay}ms)`);
  assert.ok(trace.filter(row => row.at - contact.at < 1700).every(row => visible(row, 'toolbar')), 'the ordinary one-second leave timer must not hide the toolbar during initial contact');
  assert.ok(trace.some(row => row.at >= hidden.at && row.toolbar.opacity > 0.05 && row.toolbar.opacity < 0.95), 'CSS fade has intermediate painted opacity');
  const faded = trace.find(row => row.at >= hidden.at && row.toolbar.opacity < 0.05); assert.ok(faded && faded.at - hidden.at < 400, 'fade duration is short, not a two-second animation');
  samples.contactDeadline = { delay, fadeMs: faded.at - hidden.at, trace }; await far(); await near('toolbar'); pass('visible toolbar waits two seconds from one contact entry, then fades quickly; repeated moves do not reset it and a fresh near-zone restores it');

  phase = 'cancelled deadline'; await enterHead(); await pet.waitForTimeout(250); await near('toolbar'); await pet.waitForTimeout(2250); assert.ok(visible(await state(), 'toolbar'), 'a cancelled old contact deadline cannot hide newly revealed controls');
  pass('leaving contact invalidates its old timer; renewed nearby UI remains visible');
  const guard = await instance.evaluate(() => ({ remote: globalThis.__hoverQA.remote, permissions: globalThis.__hoverQA.permissions })); assert.deepEqual(guard, { remote: [], permissions: [] });
  assert.equal(await pet.locator('#chat-input').inputValue(), 'Hover验收保留草稿'); assert.deepEqual(errors, []);
} catch (error) { failure = { phase, message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
  const guard = instance ? await instance.evaluate(() => ({ remoteRequests: globalThis.__hoverQA?.remote ?? [], permissionRequests: globalThis.__hoverQA?.permissions ?? [] })).catch(() => null) : null;
  if (pet && !pet.isClosed()) await pet.evaluate(() => clearInterval(window.__hoverSampler)).catch(() => {});
  await close(); if (errors.length || !appExited) process.exitCode = 1;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure || errors.length || !appExited ? 'failed' : 'passed', ...identity, checks, samples, errors, failure,
    normalProfileUsed: false, realProviderRequests: 0, physicalPointerVerified: false, guard, fixture: 'public Gene/default parameters; controlled CDP mouse; real camera positioning; DOM read-only sampler', cleanup: { appExited, serverStarted: false } }, null, 2));
}
