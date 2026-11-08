// Prepared native QA only. Run after the owner explicitly hands back the native slot.
// Required: MMD_TEST_APP_DIR=<independent frozen source> OR MMD_TEST_EXE=<isolated package>.
// Both may be supplied to cross-check a packaged candidate's validated.json.
// Optional: MMD_TEST_MODEL=<separately authorized PMX/PMD>; private models are never copied or captured.
// This script never builds, calls providers, starts a server, or uses a normal profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeIsolation } from './lib/claude-smoke-fixture.mjs';

const harness = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(harness), '..');
const outputRoot = path.resolve(process.env.MMD_CHEEK_OUTPUT ?? path.join(workspace, '.local/cheek-pinch-native'));
assert.ok(outputRoot.split(path.sep).includes('.local'), 'Native evidence belongs in an ignored .local directory.');
const output = path.join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = async filename => sha(await readFile(filename));
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const checks = [], samples = {}, captures = [], errors = [];
const cleanup = { appClosed: false, forcedOwnedProcessStop: false, profileRemoved: false, serversStarted: 0 };
let source, executable, asar, proof, profile, modelPath, instance, controls, pet, identity, originalCard;
let frozenHashes, asarHash, sourceHash, failure, hostEvidence, finalChecks = false, guardInstalled = false;
let phase = 'preflight';
const privatePaths = [workspace];
const safe = value => {
  let result = String(value);
  for (const entry of [...privatePaths].sort((a, b) => b.length - a.length)) if (entry) result = result.split(entry).join('<isolated-path>');
  return result;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
async function wait(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(45);
  }
  throw Error(`Timeout in ${phase}: ${label}`);
}
async function builtHashes() {
  if (!source) return null;
  const result = {};
  async function visit(folder) {
    for (const item of await readdir(path.join(source, folder), { withFileTypes: true })) {
      const relative = path.join(folder, item.name);
      if (item.isDirectory()) await visit(relative);
      else if (/\.(?:js|cjs|mjs|css|html|wasm)$/i.test(item.name)) result[relative.replaceAll('\\', '/')] = await hash(path.join(source, relative));
    }
  }
  await visit('dist'); await visit('dist-electron');
  assert.ok(Object.keys(result).some(name => name.endsWith('main.cjs')), 'Candidate has a compiled Electron entry.');
  return result;
}
async function fingerprint() {
  if (!source || !proof?.inputs) return null;
  const entries = [];
  for (const relative of [...proof.inputs].sort()) {
    assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\')
      && !relative.split('/').some(part => part === '.' || part === '..'), 'Safe candidate input.');
    const file = await realpath(path.join(source, relative));
    assert.ok(within(source, file), 'Manifest source stays inside the candidate.');
    entries.push([relative, await hash(file)]);
  }
  return sha(JSON.stringify(entries));
}
function settingsSeed() {
  return {
    version: 1, model: null, motion: null,
    camera: { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 },
    // Claude-only edition; this smoke never chats (Claude Code is only an inert placeholder, see launch).
    provider: { kind: 'claude', model: '' },
    persona: '原创隔离捏脸验收。',
    pet: { visible: true, alwaysOnTop: false, clickThrough: false, followMouse: false,
      fps: 30, breath: 0, scale: 1, size: { width: 480, height: 640 } },
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 },
    voiceInput: { baseUrl: 'http://127.0.0.1:9/v1', model: 'unused-no-asr', language: 'zh', apiKey: '' },
    agent: { workingDirectory: '', model: '', writable: false },
  };
}
async function mood() { return controls.evaluate(() => window.desktop.getMood()); }
async function frame() {
  return pet.evaluate(async () => {
    const canvas = document.querySelector('#stage canvas'), local = document.querySelector('#mood-local-feedback');
    const cursor = document.querySelector('[data-pet-interaction-cursor]');
    return { now: performance.now(), local: local?.dataset.phase, sessionId: local?.dataset.sessionId ?? '',
      region: JSON.parse(canvas?.dataset.interactionRegion ?? 'null'),
      cheek: JSON.parse(canvas?.dataset.cheekPinch ?? 'null'),
      feedback: JSON.parse(canvas?.dataset.moodFeedback ?? '{}'),
      baseTime: JSON.parse(canvas?.dataset.chatGesture ?? '{}').baseTime,
      layerTimes: JSON.parse(canvas?.dataset.motionTransition ?? '{}').layerTimes,
      cursor: { visible: !!cursor && !cursor.hidden, text: cursor?.textContent ?? '' },
      snapshot: (await window.desktop.getMood()).snapshot,
      lastPointer: window.__cheekQA?.lastPointer ?? null,
    };
  });
}
async function collect(duration, interval = 80) {
  const result = [], deadline = Date.now() + duration;
  while (Date.now() < deadline) { result.push(await frame()); await pause(interval); }
  result.push(await frame()); return result;
}
async function geometry() {
  let result;
  await wait(async () => {
    result = await pet.evaluate(() => {
      const stage = document.querySelector('#stage'), rect = stage.getBoundingClientRect();
      const region = JSON.parse(stage.querySelector('canvas')?.dataset.interactionRegion ?? 'null');
      const reserved = [...document.querySelectorAll('#pet-toolbar,.pet-chat,.pet-window-help,.pet-resize-handle,[data-mood-ui]')]
        .map(element => element.getBoundingClientRect().toJSON()).filter(r => r.width > 0 && r.height > 0);
      return { ...region, rect: rect.toJSON(), reserved, width: innerWidth, height: innerHeight };
    });
    return result?.cheeks?.length === 2 && result.cheeks.every(c => ['x', 'y', 'axisXX', 'axisXY', 'axisYX', 'axisYY', 'referenceWidth'].every(k => Number.isFinite(c[k])));
  }, 'two finite visible cheek projections', 45_000);
  return result;
}
const usable = (geometry, point) => point.x > 2 && point.y > 2 && point.x < geometry.width - 2 && point.y < geometry.height - 2
  && geometry.reserved.every(r => point.x < r.left || point.x >= r.right || point.y < r.top || point.y >= r.bottom);
async function cheekPoint(side) {
  const g = await geometry(), c = g.cheeks.find(value => value.side === side);
  const result = { x: g.rect.left + c.x, y: g.rect.top + c.y, width: c.referenceWidth, side };
  assert.ok(usable(g, result), `${side} cheek center lies outside retained UI reservations.`);
  return result;
}
async function outside() {
  const target = await pet.evaluate(() => ({ x: 2, y: innerHeight - 2 }));
  await pet.mouse.move(target.x, target.y);
}
async function reveal(selector) {
  const rect = await pet.locator(selector).evaluate(element => element.getBoundingClientRect().toJSON());
  assert.ok(rect.width > 0 && rect.height > 0, `${selector} has a retained hover reservation.`);
  await pet.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await wait(() => pet.locator(selector).isVisible(), `${selector} becomes visible in its hover zone`);
}
async function frameFull() {
  const tab = await controls.locator('#frame-full').evaluate(element => element.closest('.tab-panel')?.id.replace(/^tab-/, ''));
  if (tab) await navigateControlPage(controls, tab);
  await controls.locator('#frame-full').click();
}
async function settle() {
  await outside();
  await wait(async () => (await mood()).snapshot.phase === 'idle', 'host returns to idle');
  await wait(async () => {
    const f = (await frame()).cheek;
    return f && !f.pinching && Math.hypot(f.headX, f.headY, f.headZ, f.bodyX, f.bodyY, f.bodyZ,
      f.headOffsetX, f.headOffsetY, f.bodyOffsetX, f.bodyOffsetY) < 0.002;
  }, 'smooth cheek layer returns to current base pose');
}
function finiteAndBounded(value) {
  assert.ok(value && ['headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ', 'headOffsetX', 'headOffsetY',
    'bodyOffsetX', 'bodyOffsetY', 'headWeight', 'bodyWeight', 'inputX', 'inputY'].every(key => Number.isFinite(value[key])), 'Finite cheek output and frozen input.');
  assert.ok(Math.hypot(value.headX, value.headY, value.headZ) <= Math.PI / 15 + 1e-6, 'Head rotation stays within 12 degrees.');
  assert.ok(Math.hypot(value.bodyX, value.bodyY, value.bodyZ) <= Math.PI / 30 + 1e-6, 'Body rotation stays within 6 degrees.');
  assert.ok(Math.hypot(value.headOffsetX, value.headOffsetY) <= 0.025 + 1e-6, 'Head displacement stays within 2.5% of model height.');
  assert.ok(Math.hypot(value.bodyOffsetX, value.bodyOffsetY) <= 0.02 + 1e-6, 'Body displacement stays within 2% of model height.');
}
async function capture(label) {
  if (modelPath) return; // Never save private-model images, even in the ignored report.
  const settings = await controls.evaluate(() => window.desktop.getSettings());
  assert.match(settings.model?.name ?? '', /^gene\.pmx$/i, 'Capture only bundled public Gene.');
  const file = `${label}.png`;
  await pet.locator('#stage').screenshot({ path: path.join(output, file), omitBackground: true });
  captures.push({ file, kind: 'isolated-public-Gene-stage', sample: await frame() });
}
async function press(side = 'left') {
  await settle(); await pet.bringToFront();
  const point = await cheekPoint(side);
  await pet.mouse.move(point.x, point.y);
  await wait(async () => { const value = await frame(); return value.local === 'cheek-hover' && value.cursor.visible && value.cursor.text === '👉'; }, 'immediate cheek-hover emoji', 1_000);
  const before = await mood(); await pet.mouse.down({ button: 'left' });
  await wait(async () => {
    const value = await frame();
    return value.local === 'cheek' && value.sessionId && value.cheek?.pinching && value.cursor.visible && value.cursor.text === '🤏';
  }, 'immediate held emoji and captured session', 1_000);
  const held = await frame();
  assert.equal(held.lastPointer?.trusted, true, 'Actual Playwright pointerdown reached the surface.');
  assert.ok(held.now - held.lastPointer.at < 1_000, 'Held feedback has no two-second entry delay.');
  assert.ok(held.lastPointer?.pointerId >= 0);
  assert.equal(held.snapshot.lastInteractionAt, before.snapshot.lastInteractionAt, 'Press alone gives no reward.');
  return { ...point, sessionId: held.sessionId, token: before.token, before: before.snapshot };
}
async function moveTo(origin, distance, duration = 560) {
  const g = await geometry();
  const candidates = [1, -1].map(sign => ({ x: origin.x + sign * origin.width * distance, y: origin.y, sign }));
  const target = candidates.find(value => usable(g, value));
  assert.ok(target, 'A complete drag remains inside the window and outside retained UI.');
  const start = await pet.evaluate(() => ({ ...window.__cheekQA.lastPosition }));
  const steps = Math.max(8, Math.ceil(duration / 65));
  for (let index = 1; index <= steps; index++) {
    const t = index / steps;
    await pet.mouse.move(start.x + (target.x - start.x) * t, start.y + (target.y - start.y) * t);
    await pause(duration / steps);
  }
  return target;
}
async function savedCheekIds(characterId) {
  let result;
  await wait(async () => {
    try {
      const contents = JSON.parse(await readFile(path.join(profile, 'mood-state.json'), 'utf8'));
      const row = contents.profiles.find(value => value.characterId === characterId);
      if (!row || row.state.lastInteractionAt !== (await mood()).snapshot.lastInteractionAt) return false;
      result = row.state.recentEventIds.filter(id => id.startsWith('cheek:')); return true;
    } catch { return false; }
  }, 'latest isolated mood save', 8_000);
  return result;
}
async function lateRejected(held) {
  const rejected = await pet.evaluate(async held => {
    try { await window.desktop.moodInteraction({ type: 'cheek', token: held.token, sessionId: held.sessionId,
      id: `${held.sessionId}-late`, activeMs: 500 }); return false; } catch { return true; }
  }, { token: held.token, sessionId: held.sessionId });
  assert.equal(rejected, true, 'A report for the actual cancelled/consumed mouse session is rejected.');
}
async function cancelled(label, action) {
  phase = label;
  const held = await press(); await moveTo(held, 0.24, 420);
  await action(held);
  await pet.mouse.up({ button: 'left' }).catch(() => {});
  await wait(async () => (await mood()).snapshot.phase === 'idle', `${label} host idle`);
  assert.equal((await mood()).snapshot.lastInteractionAt, held.before.lastInteractionAt, `${label} does not settle cancelled movement.`);
  await lateRejected(held);
  samples[label] = await frame();
  check(`${label}: held input cancelled, no reward, actual late session rejected`);
}
async function setVisible(visible) {
  await controls.evaluate(async visible => {
    const settings = await window.desktop.getSettings();
    await window.desktop.saveSettings({ ...settings, pet: { ...settings.pet, visible } });
  }, visible);
  await wait(() => instance.evaluate(({ BrowserWindow }, visible) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html?pet'));
    return !!window && window.isVisible() === visible;
  }, visible), `native pet visibility ${visible}`);
}
async function selectPrivate() {
  await instance.evaluate(({ dialog }, filename) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [filename] }; };
  }, modelPath);
  const tab = await controls.locator('#import-model').evaluate(element => element.closest('.tab-panel')?.id.replace(/^tab-/, ''));
  if (tab) await navigateControlPage(controls, tab);
  await controls.locator('#import-model').click();
  await wait(() => controls.evaluate(async expected => (await window.desktop.getSettings()).model?.path === expected, modelPath), 'authorized model loaded by the real picker path');
}
async function closeOwned() {
  if (!instance) return;
  const app = instance; instance = null;
  const child = app.process(); let timer;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned app close timeout')), 10_000); })]);
  } catch {
    if (child.pid && child.exitCode === null) {
      cleanup.forcedOwnedProcessStop = true;
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }
  } finally { clearTimeout(timer); }
  await wait(() => child.exitCode !== null || child.signalCode !== null, 'owned app process exited', 5_000);
  cleanup.appClosed = true;
}

try {
  assert.ok(process.env.MMD_TEST_APP_DIR || process.env.MMD_TEST_EXE, 'Explicitly select an independent frozen candidate or packaged executable.');
  source = process.env.MMD_TEST_APP_DIR ? await realpath(path.resolve(process.env.MMD_TEST_APP_DIR)) : null;
  executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
  if (source) assert.notEqual(source.toLowerCase(), (await realpath(workspace)).toLowerCase(), 'Do not launch the shared working build.');
  if (executable) { asar = await realpath(path.join(path.dirname(executable), 'resources/app.asar')); asarHash = await hash(asar); }
  if (source) {
    try { proof = JSON.parse(await readFile(path.join(path.dirname(source), 'validated.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (proof) {
      assert.equal(proof.version, 1); assert.ok(Array.isArray(proof.inputs) && proof.inputs.length);
      sourceHash = await fingerprint(); assert.equal(sourceHash, proof.sourceHash);
      if (executable) { assert.ok(within(path.dirname(source), executable)); assert.equal(asarHash, proof.asarSha256); }
    }
  }
  frozenHashes = await builtHashes();
  if (process.env.MMD_TEST_MODEL) { modelPath = await realpath(process.env.MMD_TEST_MODEL); assert.match(modelPath, /\.(?:pmx|pmd)$/i); }
  profile = await mkdtemp(path.join(await realpath(tmpdir()), 'soft-cheek-pinch-'));
  privatePaths.push(source, executable, asar, profile, modelPath, modelPath ? path.dirname(modelPath) : null);
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settingsSeed()), { mode: 0o600 });
  // Claude Code: inert placeholder + empty config folder; Codex: a missing path.
  const env = (await createClaudeIsolation()).environment(Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MMD_|^VITE_DEV_SERVER_URL$|^ELECTRON_RUN_AS_NODE$/.test(key))));
  env.MMD_DESK_USER_DATA = profile;
  phase = 'launch';
  const args = [`--user-data-dir=${profile}`, ...(sourceHash ? [`--soft-hearts-build=${sourceHash}`] : [])];
  instance = await electron.launch({ ...(executable ? { executablePath: executable, args } : { args: [source, ...args] }), cwd: source ?? path.dirname(executable), env, timeout: 30_000 });
  const watched = new WeakSet();
  const watch = page => {
    if (watched.has(page)) return; watched.add(page);
    page.on('pageerror', error => errors.push(safe(error.message)));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push(safe(message.text())); });
  };
  instance.on('window', watch); instance.windows().forEach(watch);
  await instance.firstWindow();
  identity = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath(), pid: process.pid,
    build: app.commandLine.getSwitchValue('soft-hearts-build') }));
  assert.equal((await realpath(identity.profile)).toLowerCase(), profile.toLowerCase());
  assert.equal((await realpath(identity.appPath)).toLowerCase(), (asar ?? source).toLowerCase());
  assert.equal(identity.packaged, !!executable);
  if (sourceHash) assert.equal(identity.build, sourceHash, 'Running process has the selected candidate build marker.');
  await instance.evaluate(({ session, desktopCapturer }) => {
    const qa = globalThis.__cheekQA = { blockedRequests: [], permissionRequests: [], providerCalls: 0, captureCalls: 0 };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
      const blocked = /^(?:https?|wss?):/i.test(details.url);
      if (blocked) qa.blockedRequests.push(new URL(details.url).origin);
      done({ cancel: blocked });
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { qa.permissionRequests.push(permission); done(false); });
    globalThis.fetch = async () => { qa.providerCalls++; throw Error('Provider access disabled in cheek QA'); };
    desktopCapturer.getSources = async () => { qa.captureCalls++; throw Error('Desktop capture disabled in cheek QA'); };
    for (const name of ['http', 'https']) for (const method of ['request', 'get'])
      process.getBuiltinModule(name)[method] = () => { qa.providerCalls++; throw Error('HTTP disabled in cheek QA'); };
  });
  guardInstalled = true;
  await wait(() => {
    for (const page of instance.windows()) {
      let url; try { url = new URL(page.url()); } catch { continue; }
      if (!url.pathname.endsWith('/index.html')) continue;
      if (url.searchParams.has('pet')) pet = page; else controls = page;
    }
    return controls && pet;
  }, 'both isolated windows');
  for (const page of [controls, pet]) {
    watch(page);
    await page.waitForFunction(() => !!window.desktop && !!document.querySelector('#stage canvas'));
    await page.evaluate(() => {
      window.__cheekQA = { mediaCalls: 0, lastPointer: null, lastPosition: null };
      if (navigator.mediaDevices) for (const name of ['getUserMedia', 'getDisplayMedia']) Object.defineProperty(navigator.mediaDevices, name,
        { configurable: true, value: async () => { window.__cheekQA.mediaCalls++; throw Error('Media disabled in cheek QA'); } });
      const stage = document.querySelector('#stage');
      stage.addEventListener('pointerdown', event => { window.__cheekQA.lastPointer = { at: performance.now(), pointerId: event.pointerId,
        trusted: event.isTrusted, button: event.button, buttons: event.buttons }; }, { capture: true });
      stage.addEventListener('pointermove', event => { window.__cheekQA.lastPosition = { x: event.clientX, y: event.clientY }; }, { capture: true });
    });
  }
  await controls.evaluate(async () => {
    await window.desktop.useBundledModel(); await window.desktop.recoverPet();
    const state = await window.desktop.saveCharacterCard({ name: 'M006 Gene隔离验收', description: '原创捏脸测试角色。', personality: '均衡。',
      scenario: '', greeting: '', examples: '', systemPrompt: '' });
    const card = state.cards.find(card => card.name === 'M006 Gene隔离验收');
    if (!card) throw Error('Fixture card was not created');
    await window.desktop.activateCharacterCard(card.id);
    await window.desktop.setMoodDeveloperMode(true); await window.desktop.setMoodExpressions(true);
  });
  if (modelPath) await selectPrivate();
  await frameFull();
  await geometry(); await settle();
  originalCard = (await mood()).characterId;
  samples.initial = await frame();
  assert.equal(samples.initial.snapshot.lastInteractionAt, null);
  finiteAndBounded(samples.initial.cheek);
  check('01 isolated profile and explicit candidate identity, guarded network/media, two visible cheek projections');

  phase = '02-immediate-two-sided-cursors-and-static-hold';
  for (const side of ['left', 'right']) {
    const held = await press(side);
    await capture(`gene-${side}-press`);
    await pause(650); await pet.mouse.up({ button: 'left' }); await settle();
    assert.equal((await mood()).snapshot.lastInteractionAt, held.before.lastInteractionAt, 'A static hold gives no reward.');
    await lateRejected(held);
  }
  check('02 each cheek immediately shows hover 👉 then held 🤏; static hold and late reports give no reward');

  phase = '03-near-far-continuous-follow-and-once-release';
  const held = await press(); const beforeIds = await savedCheekIds(originalCard);
  const firstBaseTime = (await frame()).baseTime;
  await moveTo(held, 0.12); await pause(350);
  samples.near = await frame(); finiteAndBounded(samples.near.cheek);
  assert.ok(samples.near.cheek.headWeight > 0.7 && samples.near.cheek.bodyWeight < 0.3);
  await capture('gene-near-pinch');
  await moveTo(held, 1.3, 800); await pause(350);
  samples.far = await frame(); finiteAndBounded(samples.far.cheek);
  assert.ok(samples.far.cheek.bodyWeight > 0.5 && samples.far.cheek.headWeight < samples.near.cheek.headWeight);
  assert.ok(Math.hypot(samples.far.cheek.bodyOffsetX, samples.far.cheek.bodyOffsetY) > Math.hypot(samples.near.cheek.bodyOffsetX, samples.near.cheek.bodyOffsetY) + 0.001);
  await capture('gene-far-pinch');
  samples.held = await collect(350); samples.held.forEach(row => finiteAndBounded(row.cheek));
  assert.ok(Number.isFinite(firstBaseTime) && samples.far.baseTime > firstBaseTime + 0.4, 'The base mixer advances while held.');
  await pet.mouse.up({ button: 'left' });
  await wait(async () => (await mood()).snapshot.event?.id === `cheek:${held.sessionId}`, 'one host-owned release reward');
  samples.afterRelease = await collect(700);
  samples.afterRelease.forEach(row => finiteAndBounded(row.cheek));
  const motionMagnitude = value => Math.hypot(value.headX, value.headY, value.headZ, value.bodyX, value.bodyY, value.bodyZ,
    value.headOffsetX, value.headOffsetY, value.bodyOffsetX, value.bodyOffsetY);
  assert.ok(samples.afterRelease.some(row => motionMagnitude(row.cheek) > 0.002 && motionMagnitude(row.cheek) < motionMagnitude(samples.far.cheek) * 0.95),
    'Release contains displayed intermediate values before returning to the base pose.');
  await settle();
  const accepted = await mood(), afterIds = await savedCheekIds(originalCard);
  assert.equal(accepted.snapshot.reason, '有效捏脸');
  assert.ok(accepted.snapshot.values.O > held.before.values.O);
  assert.deepEqual(afterIds.filter(id => !beforeIds.includes(id)), [`cheek:${held.sessionId}`]);
  await lateRejected(held); await pet.mouse.up({ button: 'left' });
  assert.equal((await mood()).snapshot.lastInteractionAt, accepted.snapshot.lastInteractionAt);
  await capture('gene-pinch-released');
  check('03 near-head/far-body weights, displayed limits, base-clock continuity, smooth release and exactly one canonical reward');

  await cancelled('04-native-window-blur', async () => { await controls.bringToFront(); });
  await pet.bringToFront(); await settle();
  await cancelled('05-real-lost-pointer-capture', async () => {
    await pet.evaluate(() => document.querySelector('#stage').releasePointerCapture(window.__cheekQA.lastPointer.pointerId));
  });
  await cancelled('06-native-hide', async () => { await setVisible(false); });
  await setVisible(true); await pet.bringToFront(); await settle();
  await cancelled('07-model-token-invalidation', async () => {
    await controls.evaluate(async () => { const s = await window.desktop.getSettings(); await window.desktop.saveSettings({ ...s, model: null, motion: null, motionLayers: undefined }); });
  });
  await controls.evaluate(() => window.desktop.useBundledModel());
  if (modelPath) await selectPrivate();
  await frameFull(); await geometry(); await settle();

  phase = '08-character-token-invalidation';
  const otherCard = await controls.evaluate(async () => {
    const state = await window.desktop.saveCharacterCard({ name: 'M006独立取消角色', description: '原创角色隔离夹具。', personality: '安静。',
      scenario: '', greeting: '', examples: '', systemPrompt: '' });
    return state.cards.find(card => card.name === 'M006独立取消角色')?.id;
  });
  assert.ok(otherCard);
  const roleHold = await press('right'); await moveTo(roleHold, 0.24, 420);
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), otherCard);
  await pet.mouse.up({ button: 'left' });
  await wait(async () => (await mood()).characterId === otherCard && (await mood()).snapshot.phase === 'idle', 'new character owns idle input');
  assert.equal((await mood()).snapshot.lastInteractionAt, null, 'Old held movement never rewards a new character.');
  await lateRejected(roleHold);
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), originalCard);
  assert.equal((await mood()).snapshot.lastInteractionAt, roleHold.before.lastInteractionAt, 'The previous character receives no cancellation reward.');
  await settle(); check('08 character-token switch cancels the actual held session and isolates both characters');

  phase = '09-camera-window-and-ui-priority';
  const previousInteraction = (await mood()).snapshot.lastInteractionAt;
  await reveal('#chat-input');
  await pet.locator('#chat-input').fill('原创M006未发送草稿');
  await reveal('#pet-camera-edit');
  await pet.locator('#pet-camera-edit').click();
  assert.equal(await pet.locator('#pet-camera-edit').getAttribute('aria-pressed'), 'true');
  let point = await cheekPoint('left'); await pet.mouse.move(point.x, point.y); await pet.mouse.down(); await pause(220); await pet.mouse.up();
  assert.notEqual((await frame()).local, 'cheek');
  await pet.keyboard.press('Escape'); await settle();
  await reveal('#pet-size-toggle');
  await pet.locator('#pet-size-toggle').click();
  assert.equal(await pet.locator('#pet-size-toggle').getAttribute('aria-pressed'), 'true');
  point = await cheekPoint('right'); await pet.mouse.move(point.x, point.y); await pet.mouse.down(); await pause(220); await pet.mouse.up();
  assert.notEqual((await frame()).local, 'cheek');
  await pet.locator('#pet-window-done').click(); await reveal('#chat-input'); await pet.locator('#chat-input').click();
  assert.notEqual((await frame()).local, 'cheek');
  assert.equal(await pet.locator('#chat-input').inputValue(), '原创M006未发送草稿');
  assert.equal((await mood()).snapshot.lastInteractionAt, previousInteraction);
  await settle(); check('09 camera edit, window adjustment and retained input UI take priority without reward or draft loss');

  phase = '10-rua-and-food-regression';
  const g = await geometry();
  const scalp = u => ({ x: g.rect.left + g.x + g.axisXX * u - g.axisYX * 0.3,
    y: g.rect.top + g.y + g.axisXY * u - g.axisYY * 0.3 });
  assert.ok([-0.3, 0, 0.3].every(u => usable(g, scalp(u))));
  let p = scalp(-0.3); await pet.mouse.move(p.x, p.y);
  await wait(async () => (await frame()).local === 'rua', 'scalp remains a separate contact');
  assert.equal((await frame()).cursor.text, '👋');
  for (let i = 1; i <= 9; i++) { p = scalp(-0.3 + 0.6 * i / 9); await pet.mouse.move(p.x, p.y); await pause(65); }
  await settle(); assert.equal((await mood()).snapshot.reason, '有效摸头');
  await pet.evaluate(() => { window.__cheekSnack = new DataTransfer(); window.__cheekSnack.items.add(new File([new Uint8Array([0])], 'original-snack.png', { type: 'image/png' })); });
  const mouthRegion = await geometry(), mouth = { x: mouthRegion.rect.left + mouthRegion.mouthX, y: mouthRegion.rect.top + mouthRegion.mouthY };
  assert.ok(usable(mouthRegion, mouth));
  const drag = type => pet.evaluate(({ type, mouth }) => document.querySelector('#stage').dispatchEvent(new DragEvent(type,
    { bubbles: true, cancelable: true, clientX: mouth.x, clientY: mouth.y, dataTransfer: window.__cheekSnack })), { type, mouth });
  await drag('dragenter'); await drag('dragover'); await pause(720); await drag('dragover');
  await wait(async () => (await mood()).snapshot.phase === 'food-ready', 'food still prepares separately');
  assert.equal((await frame()).cheek.pinching, false);
  await drag('drop'); await wait(async () => (await mood()).snapshot.reason === '接受一份点心', 'food release settles once');
  await pause(1_000); await settle();
  await pet.evaluate(() => { window.__cheekSnack = null; });
  check('10 scalp 👋 and valid rua remain independent; DOM snack preparation/release does not enter cheek mode');

  phase = '11-privacy-identity-and-cleanup';
  hostEvidence = await instance.evaluate(() => globalThis.__cheekQA);
  const rendererMedia = await Promise.all([controls, pet].map(page => page.evaluate(() => window.__cheekQA.mediaCalls)));
  assert.deepEqual(hostEvidence, { blockedRequests: [], permissionRequests: [], providerCalls: 0, captureCalls: 0 });
  assert.deepEqual(rendererMedia, [0, 0]);
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getSystemAudioState()), { active: false });
  assert.deepEqual(await builtHashes(), frozenHashes); if (asar) assert.equal(await hash(asar), asarHash);
  if (sourceHash) assert.equal(await fingerprint(), sourceHash);
  assert.deepEqual(errors, []); finalChecks = true;
  check('11 no provider/media/capture calls or errors, unchanged frozen bytes and private profile only');
} catch (error) {
  failure = { phase, message: safe(error.stack ?? error) }; process.exitCode = 1;
  try { samples.failure = await frame(); } catch { /* a failed launch has no renderer to read */ }
  console.error(safe(error.stack ?? error));
} finally {
  try { await closeOwned(); } catch (error) { failure ??= { phase: 'cleanup', message: safe(error.stack ?? error) }; process.exitCode = 1; }
  if (profile && cleanup.appClosed) {
    try {
      const actual = await realpath(profile), temporary = await realpath(tmpdir());
      assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
      assert.ok(path.basename(actual).startsWith('soft-cheek-pinch-'));
      await rm(actual, { recursive: true, force: true }); cleanup.profileRemoved = true;
    } catch (error) { errors.push(`isolated-profile-cleanup:${safe(error.message)}`); }
  }
  const report = { version: 1, status: failure ? 'failed' : finalChecks ? 'passed-pending-visual-review' : 'incomplete', failure,
    checks, samples, captures, errors, cleanup,
    identity: { sourceHash: sourceHash ?? null, asarSha256: asarHash ?? null, builtHashes: frozenHashes ?? null,
      harnessSha256: await hash(harness), packaged: identity?.packaged ?? null, pid: identity?.pid ?? null,
      actualBuild: identity?.build ?? null, explicitProfileVerified: !!identity && path.resolve(identity.profile).toLowerCase() === profile?.toLowerCase(),
      model: modelPath ? 'explicitly-authorized-private-model-no-captures' : 'bundled-public-Gene' },
    privacy: { host: hostEvidence ?? null, guardInstalled, realCloudRequests: guardInstalled ? 0 : null,
      normalProfileRead: identity && path.resolve(identity.profile).toLowerCase() === profile?.toLowerCase() ? false : null,
      privateAssetCopied: false, serversStarted: 0 },
    limits: ['Prepared harness; only an actual executed report establishes native results.',
      'Playwright pointer input and native window/capture lifecycle checks do not sign physical mouse/touchpad feel.',
      'Rendered offset diagnostics are numeric bounds; public Gene captures require owner visual review for actual model appearance.',
      'The cancellation fixtures use actual window blur/hide and DOM pointer-capture release; no real device unplug was tested.',
      'DOM DataTransfer verifies application food routing, not Explorer native drag-and-drop.',
      'No external services, physical media, speech, normal settings or profile credentials are used; private models are not copied or captured.'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
