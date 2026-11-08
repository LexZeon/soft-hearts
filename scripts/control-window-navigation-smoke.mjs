import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { CONTROL_ROOTS } from './lib/control-navigation.mjs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Run only after the native/build lease is explicitly assigned. This harness
// uses a disposable profile, bundled Gene, local synthetic chat, and no devices.
// Keyboard/mouse input is Playwright controlled; physical-input QA is separate.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = await realpath(path.resolve(process.env.MMD_TEST_APP_DIR ?? source));
const executable = process.env.MMD_TEST_EXE ? await realpath(path.resolve(process.env.MMD_TEST_EXE)) : null;
const output = path.resolve(process.env.MMD_TEST_OUTPUT_DIR ?? path.join(source, '.local/control-window-navigation-smoke'));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-control-navigation-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile);
const checks = [], errors = [], screenshots = [], requests = [], routeSamples = [];
let instance, controls, pet, report, claude, phase = 'setup', closed = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const identity = {
  packaged: Boolean(executable),
  asarSha256: executable ? await hash(path.join(path.dirname(executable), 'resources/app.asar')) : null,
  harnessSha256: await hash(fileURLToPath(import.meta.url)),
};
async function poll(condition, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await pause(60); }
  throw Error(`Timed out: ${label} (${phase})`);
}
const state = () => controls.evaluate(() => window.desktop.getSettings());
const page = () => controls.locator('.tab-panel.active').getAttribute('id');
const leaf = target => controls.locator(`#control-navigation [data-nav-target="${target}"]`);
const group = id => controls.locator(`#control-navigation [data-nav-group][data-nav-node="${id}"]`);
const stats = () => instance.evaluate(() => {
  const q = globalThis.__controlNavigationQA;
  return { remote: q.remote, permissions: q.permissions, dialogs: q.dialogs, external: q.external,
    captures: q.captures, memoryLists: q.memoryLists, taskLists: q.taskLists, taskCapabilities: q.taskCapabilities,
    executions: q.executions, modelRequests: q.modelRequests };
});
async function expandTo(target) {
  const ancestors = await leaf(target).evaluate(node => {
    const result = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'UL' && parent.id.startsWith('control-nav-children-'))
        result.push(parent.id.slice('control-nav-children-'.length));
    }
    return result.reverse();
  });
  for (const id of ancestors) if (await group(id).getAttribute('aria-expanded') !== 'true') await group(id).click();
}
async function navigate(target) {
  assert.equal(await leaf(target).count(), 1, `one real navigation leaf for ${target}`);
  await expandTo(target);
  const destination = await leaf(target).getAttribute('data-nav-page');
  await leaf(target).click();
  await poll(async () => await page() === `tab-${destination}`, `page ${destination}`);
  assert.equal(await leaf(target).getAttribute('aria-current'), 'location');
  assert.equal(await controls.locator(`#${target}`).count(), 1, `real unique target ${target}`);
  return destination;
}
async function frameState() {
  return controls.evaluate(() => {
    const canvas = document.querySelector('#stage canvas');
    return { sameCanvas: canvas === globalThis.__controlNavigationCanvas,
      time: JSON.parse(canvas?.dataset.chatGesture ?? '{}').baseTime ?? null,
      status: document.querySelector('#stage-status')?.textContent,
      draft: document.querySelector('#chat-input')?.value };
  });
}
async function launch() {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({
    ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] }
      : { args: [appDirectory, `--user-data-dir=${profile}`] }),
    cwd: appDirectory, env, timeout: 30000,
  });
  await claude.install(instance);
  const watched = new WeakSet();
  const watch = window => { if (watched.has(window)) return; watched.add(window); window.on('pageerror', error => errors.push(error.message)); };
  instance.on('window', watch); await instance.firstWindow();
  const actual = await instance.evaluate(({ app }) => ({ profile: app.getPath('userData'), packaged: app.isPackaged }));
  assert.equal(path.resolve(actual.profile), profile, 'actual isolated profile');
  assert.equal(actual.packaged, Boolean(executable));
  await instance.evaluate(async ({ session, ipcMain, dialog, shell, desktopCapturer }, allowedOrigin) => {
    const q = globalThis.__controlNavigationQA = { remote: [], permissions: [], dialogs: [], external: [], captures: 0,
      memoryLists: 0, taskLists: 0, taskCapabilities: 0, executions: [], modelRequests: 0 };
    // Initialize and wrap Node fetch's dispatcher without allowing external I/O.
    await fetch('data:text/plain,control-navigation-offline-guard');
    const key = Symbol.for('undici.globalDispatcher.1'), previous = globalThis[key];
    if (!previous?.dispatch) throw Error('Node fetch dispatcher unavailable');
    globalThis[key] = {
      dispatch(options, handler) {
        if (String(options.origin) === allowedOrigin) return previous.dispatch(options, handler);
        q.remote.push(String(options.origin) + options.path);
        handler.onError(Error('CONTROL_NAVIGATION_OFFLINE')); return false;
      },
      close: (...args) => previous.close(...args), destroy: (...args) => previous.destroy(...args),
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
      if (request.url.startsWith('mmd-asset:') && /\.pm[dx](?:[?#]|$)/i.test(request.url)) q.modelRequests++;
      const blocked = /^https?:/i.test(request.url) && new URL(request.url).origin !== allowedOrigin;
      if (blocked) q.remote.push(request.url); done({ cancel: blocked });
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => { q.permissions.push(permission); done(false); });
    dialog.showOpenDialog = async () => { q.dialogs.push('open'); return { canceled: true, filePaths: [] }; };
    dialog.showSaveDialog = async () => { q.dialogs.push('save'); return { canceled: true, filePath: undefined }; };
    shell.openExternal = async () => { q.external.push('attempt'); };
    desktopCapturer.getSources = async () => { q.captures++; return []; };
    const fixture = (method, callback) => { ipcMain.removeHandler(`desk:${method}`); ipcMain.handle(`desk:${method}`, callback); };
    fixture('listMemories', (_event, query = {}) => { q.memoryLists++; return { records: [], total: 0, offset: query.offset ?? 0, limit: query.limit ?? 20, tags: [] }; });
    fixture('listCodexTasks', () => { q.taskLists++; return []; });
    fixture('codexTaskCapabilities', () => { q.taskCapabilities++; return { authenticated: false, login: 'none', computerControl: false, reason: 'Isolated navigation fixture; no app-server.' }; });
    for (const method of ['startCodexTask', 'continueCodexTask', 'respondCodexApproval']) fixture(method, () => { q.executions.push(method); throw Error('Navigation must never execute a task.'); });
  }, null); // No allowed HTTP origin: chat runs through the fake Claude Code process.
  await poll(() => {
    for (const window of instance.windows()) {
      watch(window);
      try { const url = new URL(window.url()); if (!url.pathname.endsWith('/index.html')) continue;
        if (url.searchParams.has('pet')) pet = window; else controls = window;
      } catch { /* Independent auxiliary windows need no route. */ }
    }
    return Boolean(controls && pet);
  }, 'controls and pet');
  controls.setDefaultTimeout(15000); pet.setDefaultTimeout(15000);
  // Reload only disposable windows after installing guards and IPC fixtures.
  await Promise.all([controls.reload(), pet.reload()]);
  await controls.waitForSelector('#control-navigation');
  await controls.waitForSelector('#character-name', { state: 'attached' });
  await poll(async () => {
    const snapshot = await controls.evaluate(() => {
      const canvas = document.querySelector('#stage canvas');
      return { ready: document.querySelector('#stage-status')?.textContent?.includes('VMD 播放中'), time: JSON.parse(canvas?.dataset.chatGesture ?? '{}').baseTime };
    });
    return snapshot.ready && Number.isFinite(snapshot.time);
  }, 'bundled Gene and animation diagnostics');
  await controls.evaluate(() => {
    globalThis.__controlNavigationCanvas = document.querySelector('#stage canvas');
    globalThis.__controlNavigationDangerClicks = [];
    const actions = new Set(['new-chat', 'import-model', 'use-bundled-model', 'import-motion', 'clear-motion', 'attach-screen', 'attach-camera',
      'frame-full', 'frame-portrait', 'reset-settings', 'confirm-reset', 'quit-app', 'open-mood', 'runtime-voice', 'runtime-screen', 'runtime-camera',
      'character-import', 'character-export', 'character-save', 'character-delete', 'test-voice']);
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest('[id]') : null;
      if (target && !target.closest('#control-navigation') && actions.has(target.id)) globalThis.__controlNavigationDangerClicks.push(target.id);
    }, true);
    document.querySelector('#chat-input').value = 'NAVIGATION_DRAFT_PRESERVED';
    document.querySelector('#character-description').value = 'UNSAVED_CHARACTER_TEXT';
  });
}
try {
  // Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs).
  claude = await createClaudeFixture({ root: temporary, respond: turn => {
    requests.push({ message: turn.currentUser });
    assert.equal(requests.at(-1).message, '帮我检查项目代码');
    return 'NAVIGATION_CHAT_FIXTURE';
  } });
  // No settings file: first launch must initialize the reviewed bundled model.
  phase = 'launch'; await launch();
  await controls.evaluate(async provider => {
    const current = await window.desktop.getSettings();
    await window.desktop.saveSettings({ ...current, provider: { ...current.provider, ...provider },
      voice: { ...current.voice, enabled: false, volume: 0 } });
  }, claude.provider);
  await pause(250);
  // Establish drafts after the intentional provider setup has finished its
  // context-change notifications; only navigation is under comparison below.
  await controls.evaluate(() => {
    document.querySelector('#chat-input').value = 'NAVIGATION_DRAFT_PRESERVED';
    document.querySelector('#character-description').value = 'UNSAVED_CHARACTER_TEXT';
  });
  const settingsBefore = await state(), cardsBefore = await controls.evaluate(() => window.desktop.getCharacterCards());
  const settingsBytes = await readFile(path.join(profile, 'settings.json'), 'utf8');
  const cardsBytes = await readFile(path.join(profile, 'characters.json'), 'utf8');
  phase = 'parent-groups';
  assert.equal(await page(), 'tab-chat');
  assert.equal(await controls.locator('#control-navigation > ul > li > [data-nav-group]').count(), CONTROL_ROOTS.length);
  const groupStats = await stats();
  for (const id of CONTROL_ROOTS) {
    const before = await group(id).getAttribute('aria-expanded');
    await group(id).click(); assert.notEqual(await group(id).getAttribute('aria-expanded'), before);
    await group(id).click(); assert.equal(await group(id).getAttribute('aria-expanded'), before);
    assert.equal(await page(), 'tab-chat', 'parents do not navigate');
  }
  assert.deepEqual(await stats(), groupStats, 'parents perform no host operations');
  pass('six parent rows expand and collapse without routing, host requests, or clearing the active page');

  phase = 'all-real-leaves';
  const targets = await controls.locator('#control-navigation [data-nav-target]').evaluateAll(nodes => nodes.map(node => node.dataset.navTarget));
  assert.ok(targets.length >= 30, 'existing controls are exposed as multiple leaf destinations');
  const beforeFrame = await frameState(), modelsBefore = (await stats()).modelRequests;
  let previousTime = beforeFrame.time;
  for (const target of targets) {
    const destination = await navigate(target);
    const current = await frameState();
    assert.equal(current.sameCanvas, true, `canvas retained at ${target}`);
    assert.ok(Number.isFinite(current.time) && current.time >= previousTime - 0.001, `mixer time retained at ${target}`);
    assert.equal(current.draft, 'NAVIGATION_DRAFT_PRESERVED');
    previousTime = current.time; routeSamples.push({ target, page: destination, time: current.time });
  }
  await pause(180);
  assert.ok((await frameState()).time > beforeFrame.time, 'animation continues throughout navigation');
  assert.equal((await stats()).modelRequests, modelsBefore, 'no navigation model reload');
  assert.deepEqual(await state(), settingsBefore);
  assert.deepEqual(await controls.evaluate(() => window.desktop.getCharacterCards()), cardsBefore);
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), settingsBytes);
  assert.equal(await readFile(path.join(profile, 'characters.json'), 'utf8'), cardsBytes);
  assert.deepEqual(await controls.evaluate(() => globalThis.__controlNavigationDangerClicks), []);
  assert.equal(await controls.locator('#character-description').inputValue(), 'UNSAVED_CHARACTER_TEXT');
  pass('all leaves locate real regions without executing target buttons; draft, cards, settings, canvas and animation progress remain');

  phase = 'same-page-lifecycle';
  await navigate('memory-query');
  const memoryBefore = (await stats()).memoryLists;
  await controls.locator('#memory-parameters').evaluate(node => { node.value = 'UNSAVED_MEMORY_PARAMETERS'; node.closest('details').open = false; });
  await navigate('memory-list'); await navigate('memory-detail'); await navigate('memory-parameters');
  assert.equal((await stats()).memoryLists, memoryBefore, 'same memory page does not refresh');
  assert.equal(await controls.locator('#memory-parameters').inputValue(), 'UNSAVED_MEMORY_PARAMETERS');
  assert.equal(await controls.locator('#memory-parameters').evaluate(node => node.closest('details').open), true);
  await navigate('provider-model'); await navigate('memory-query');
  await poll(async () => (await stats()).memoryLists === memoryBefore + 1, 'one memory refresh on a true page change');
  await navigate('codex-task-list');
  const agentBefore = await stats();
  await controls.locator('.codex-task-prompt').evaluate(node => { node.value = 'UNSAVED_TASK_DRAFT'; });
  await navigate('codex-task-consent'); await navigate('codex-task-form'); await navigate('codex-task-progress');
  const agentAfter = await stats();
  assert.equal(agentAfter.taskLists, agentBefore.taskLists); assert.equal(agentAfter.taskCapabilities, agentBefore.taskCapabilities);
  assert.equal(await controls.locator('.codex-task-prompt').inputValue(), 'UNSAVED_TASK_DRAFT');
  pass('same-page leaves preserve memory/task drafts and avoid redundant refresh; memory entry refreshes once');

  phase = 'appearance-lifecycle';
  await navigate('motion-library');
  await controls.locator('#motion-select-gene').selectOption('happy');
  await controls.locator('#motion-preview-gene').click();
  await poll(() => controls.locator('#motion-preview-summary').getAttribute('data-phase').then(value => value === 'playing'), 'temporary expression preview');
  await navigate('camera-section');
  assert.equal(await controls.locator('#motion-preview-summary').getAttribute('data-phase'), 'playing');
  await navigate('privacy-window');
  await poll(() => controls.locator('#motion-preview-summary').getAttribute('data-phase').then(value => value === 'idle'), 'preview stopped on page leave');
  await navigate('camera-edit'); await controls.locator('#camera-edit').click();
  assert.equal(await controls.locator('#camera-edit').getAttribute('aria-pressed'), 'true');
  await navigate('camera-section'); assert.equal(await controls.locator('#camera-edit').getAttribute('aria-pressed'), 'true');
  await navigate('chat-input'); assert.equal(await controls.locator('#camera-edit').getAttribute('aria-pressed'), 'false');
  pass('same appearance page preserves preview/edit mode; actual page leave stops preview and exits camera editing');

  phase = 'programmatic-routing';
  if (await group('agent').getAttribute('aria-expanded') === 'true') await group('agent').click();
  await pet.evaluate(() => window.desktop.proposeCodexTask('帮我检查项目代码'));
  await poll(async () => await page() === 'tab-agent', 'pet task proposal opens the actual task page');
  assert.equal(await group('agent').getAttribute('aria-expanded'), 'true');
  assert.ok((await controls.locator('.codex-task-prompt').inputValue()).includes('帮我检查项目代码'));
  assert.equal(requests.length, 0, 'proposal itself makes no chat request');
  assert.deepEqual((await stats()).executions, []);
  await navigate('chat-input'); await controls.locator('#chat-input').fill('帮我检查项目代码');
  await controls.locator('#chat-input').press('Enter');
  await poll(async () => await page() === 'tab-agent', 'ordinary chat task suggestion opens task page');
  await controls.locator('.codex-task-offer').getByRole('button', { name: '继续普通聊天', exact: true }).click();
  await poll(async () => await page() === 'tab-chat', 'continue ordinary chat uses the unified chat route');
  await poll(() => controls.locator('.message.assistant .message-body').last().textContent().then(value => value === 'NAVIGATION_CHAT_FIXTURE'), 'one synthetic local reply');
  assert.equal(requests.length, 1); assert.deepEqual((await stats()).executions, []);
  pass('programmatic task/chat navigation reveals ancestors without execution or duplicate chat requests');

  phase = 'keyboard-and-narrow-sidebar';
  const currentPage = await page(), privacy = group('privacy');
  await privacy.focus(); const expanded = await privacy.getAttribute('aria-expanded');
  await controls.keyboard.press('Enter'); assert.notEqual(await privacy.getAttribute('aria-expanded'), expanded);
  await controls.keyboard.press('Space'); assert.equal(await privacy.getAttribute('aria-expanded'), expanded);
  assert.equal(await page(), currentPage);
  await expandTo('privacy-window'); await leaf('privacy-window').focus(); await controls.keyboard.press('Enter');
  assert.equal(await page(), 'tab-privacy'); assert.equal(await leaf('privacy-window').getAttribute('aria-current'), 'location');
  await controls.keyboard.press('Tab');
  assert.equal(await controls.evaluate(() => document.activeElement?.matches('button,input,textarea,select,a,summary') ?? false), true);
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => { try { const url = new URL(value.webContents.getURL()); return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet'); } catch { return false; } });
    window.setSize(960, 680);
  });
  for (const id of await controls.locator('#control-navigation [data-nav-group]').evaluateAll(nodes => nodes.map(node => node.dataset.navNode))) {
    if (await group(id).getAttribute('aria-expanded') !== 'true') await group(id).click();
  }
  const geometry = await controls.locator('#control-navigation').evaluate(node => {
    const before = node.scrollTop; node.scrollTop = node.scrollHeight;
    return { width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight,
      scrollBefore: before, scrollAfter: node.scrollTop, sidebarHeight: node.closest('.sidebar').getBoundingClientRect().height,
      viewportHeight: window.innerHeight, rootScrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, 'no horizontal overflow in nested sidebar');
  assert.ok(geometry.scrollHeight > geometry.height && geometry.scrollAfter > 0, 'sidebar scrolls independently');
  assert.ok(geometry.sidebarHeight <= geometry.viewportHeight + 1, 'sidebar fits the native minimum-height viewport');
  assert.ok(geometry.rootScrollWidth <= geometry.viewportWidth + 1, 'navigation does not widen the application');
  const image = 'narrow-sidebar.png'; await controls.locator('.sidebar').screenshot({ path: path.join(output, image) }); screenshots.push(image);
  pass('native minimum window size supports independent sidebar scrolling, keyboard buttons and current/expanded accessibility state');

  phase = 'final-boundaries';
  const finalStats = await stats(), runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.deepEqual(finalStats.remote, []); assert.deepEqual(finalStats.permissions, []); assert.deepEqual(finalStats.dialogs, []);
  assert.deepEqual(finalStats.external, []); assert.equal(finalStats.captures, 0); assert.deepEqual(finalStats.executions, []);
  assert.equal(runtime.voiceInput || runtime.screenSharing || runtime.cameraSharing, false);
  assert.deepEqual(errors, []); claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  pass('zero external requests, native dialogs, media permissions/captures, paid TTS or task executions');
  report = { status: 'passed', ...identity, checks, routeSamples, screenshots, requests: requests.length, guards: finalStats,
    normalProfileUsed: false, physicalInputVerified: false,
    limits: ['Model retention uses canvas identity, model-request counts and existing mixer-time diagnostics; no private scene introspection.',
      'Codex capabilities/task lists and memory lists are local counted IPC fixtures; no real app-server or external service was exercised.',
      'Screenshot requires separate visual review; this script does not claim a human has reviewed it.'] };
} catch (error) {
  report = { status: 'failed', ...identity, phase, error: String(error), checks, routeSamples, errors,
    guards: instance ? await stats().catch(() => null) : null, normalProfileUsed: false, physicalInputVerified: false };
  console.error(error); process.exitCode = 1;
} finally {
  const child = instance?.process();
  await instance?.close().catch(error => { errors.push(`close: ${error.message}`); });
  if (child && child.exitCode === null && child.signalCode === null) {
    // Only the process started by this harness may be force-stopped.
    try {
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
      await poll(() => child.exitCode !== null || child.signalCode !== null, 'owned app process exit', 5000);
    } catch (error) { errors.push(`close: ${error.message}`); }
  }
  closed = !child || child.exitCode !== null || child.signalCode !== null;
  const fakeClaude = claude ? await claude.close() : null;
  // Resolve the created temporary root before any recursive removal.
  const tempRoot = path.resolve(os.tmpdir()), resolved = path.resolve(temporary);
  assert.ok(path.dirname(resolved).toLowerCase() === tempRoot.toLowerCase() && path.basename(resolved).startsWith('soft-control-navigation-'), 'cleanup stays inside this owned temporary directory');
  if (closed) await rm(resolved, { recursive: true, force: true }).catch(error => errors.push(`cleanup: ${error.message}`));
  if (!closed || errors.length) process.exitCode = 1;
  report ??= { status: 'failed', phase, checks };
  if (process.exitCode) report.status = 'failed';
  report.cleanup = { appExited: closed, fakeClaude, temporaryProfileRemoved: closed && errors.every(value => !value.startsWith('cleanup:')) };
  report.errors = errors;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
