import { _electron as electron } from 'playwright';
import { CONTROL_ROOTS, navigateControlPage } from './lib/control-navigation.mjs';
import { SMOKE_CLAUDE_MODEL_ALIASES, SMOKE_POSE } from './lib/smoke-expectations.mjs';
import { SMOKE_CLAUDE_MODEL, createSmokeIsolation, installRendererBoundary, inspectRendererBoundary, rejectExternalSmokeFlags } from './lib/smoke-isolation.mjs';
import { FAKE_CLAUDE_REPLY } from './lib/fake-claude.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { writeTestMotion } from './create-test-motion.mjs';

rejectExternalSmokeFlags(process.env);
assert.ok(process.env.MMD_TEST_EXE && process.env.MMD_TEST_PREPARED && process.env.MMD_TEST_PREPARED_SHA256,
  'Use desktop:update --prepare: default smoke requires an exact packaged executable and prepared identity.');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(source, '.local', 'smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const received = [], errors = [], checks = [];
const reply = FAKE_CLAUDE_REPLY.join('');
let instance, isolation, page, pet, report, primary, activeSettled = false, activeStopped = false, phase = 'setup';
const ownedResources = { version: 1, stage: 'not-created', root: null, profile: null, executable: null, proof: null, sdkProcessPid: null, mainPid: null };
const saveOwnedResources = stage => { ownedResources.stage = stage; writeFileSync(path.join(output, 'owned-resources.json'), JSON.stringify(ownedResources, null, 2) + '\n'); };
const cleanup = { sdkCloseResolved: false, actualMainExited: false, fakeClaudeExited: false, profileRemoved: false };
const activeEnd = performance.now() + 180000;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Still in the system's process list. On Windows this also sees a process stuck while ending, which
// `process.kill(pid, 0)` already reports as gone (its exit code is set) — the 2026-11-03 pose exit hang.
const processListed = pid => process.platform !== 'win32' ? (() => { try { process.kill(pid, 0); return true; } catch { return false; } })()
  : execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).includes(`"${pid}"`);
let poseWorkerExit = null;
const remember = error => { primary ??= { phase, failure: error?.stack ?? String(error) }; process.exitCode = 1; };
const step = () => assert.ok(!activeStopped && performance.now() < activeEnd, 'Smoke active deadline expired.');
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), Math.max(1, milliseconds)); })]); }
  finally { clearTimeout(timer); }
}
async function poll(predicate, label, maximum = 20000) {
  const end = Math.min(activeEnd, performance.now() + maximum);
  while (performance.now() < end) { step(); if (await predicate()) return; await pause(60); }
  throw Error('Timed out: ' + label);
}
// Chat reaches a fake Claude Code process (scripts/lib/fake-claude.mjs) through the app's own launch code; its log
// is the receipt. 'WAIT' is held until the app interrupts or closes that turn.
const latest = record => isolation.fakeClaude().turns.find(turn => turn.key === record.turn.key);
// I-037 新的反应方式 (on by default outside the stable channel): each sent message may also start one reaction judge, a Claude
// Code turn that is not in the chat conversation format (the fake refuses it, the app falls back to its own score). Chat turns
// are counted apart; judge turns are bounded to one per sent message, so any other caller reaching Claude still fails the smoke.
const chatTurns = () => isolation.fakeClaude().turns.filter(turn => turn.parsed !== false);
async function send(prompt) {
  step(); phase = 'send:' + prompt;
  const before = new Set(isolation.fakeClaude().turns.map(turn => turn.key)), index = received.length;
  assert.equal(prompt, ['你好', 'WAIT', '新的对话'][index], 'Only the three declared serial UI cases may reach the fake Claude Code.');
  await isolation.beforeMessage(instance, page);
  await page.locator('#chat-input').fill(prompt); await page.locator('#send-chat').click();
  let turn;
  await poll(() => {
    const fresh = chatTurns().filter(value => !before.has(value.key));
    assert.ok(fresh.length <= 1, 'Only the declared serial UI case may reach the fake Claude Code.');
    turn = fresh[0]; return !!turn;
  }, 'actual fake Claude Code turn');
  assert.ok(turn.parsed && turn.currentUser === prompt && turn.imageCount === 0, 'The fake Claude Code must receive exactly the declared message in the app\'s conversation format.');
  received.push({ prompt, turn, id: null });
  await poll(async () => {
    const starts = await page.evaluate(() => window.__smokeEvents.started);
    const start = starts.at(-1);
    if (!start || received.some(record => record.id === start.id)) return false;
    assert.equal(start.owner, 'controls'); received[index].id = start.id; return true;
  }, 'accepted controls ID associated with the fake Claude Code turn');
  return received[index];
}
async function setDeveloperMode(enabled) {
  await navigateControlPage(page, 'privacy', { target: 'privacy-developer' });
  const before = await page.evaluate(() => window.desktop.getMood());
  if (before.developerMode !== enabled) await page.locator('#open-mood').click();
  for (const window of [page, pet]) await window.waitForFunction(value => document.body.classList.contains('developer-mode') === value, enabled);
  assert.equal((await page.evaluate(() => window.desktop.getMood())).developerMode, enabled);
}
/**
 * I-001 local pose sensing, in the packaged app, without a download and without any camera (2026-11-03: in the
 * stable build the pet's camera button seemed to do nothing). The host is up, its bundled files are in app.asar,
 * the inference process starts from there and answers, and a refused camera click says why in the pet and brings
 * the control window's question into view — the second time too.
 */
async function checkPoseHost() {
  const view = await page.evaluate(() => window.desktop.getPoseSensing());
  const key = `${process.platform}-${process.arch}`;
  assert.deepEqual({ phase: view.phase, prompt: view.prompt, downloadBytes: view.downloadBytes, componentVersion: view.componentVersion },
    { phase: SMOKE_POSE.phase, prompt: false, downloadBytes: SMOKE_POSE.downloadBytes[key], componentVersion: SMOKE_POSE.componentVersion },
    'The local pose-sensing host must be up in the packaged app, with nothing installed in the owned LOCALAPPDATA.');
  const files = await instance.evaluate(({ app }, names) => {
    const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
    return names.map(name => fs.existsSync(path.join(app.getAppPath(), 'dist-electron', name)));
  }, Object.values(SMOKE_POSE.bundle));
  assert.deepEqual(files, Object.values(SMOKE_POSE.bundle).map(() => true), 'Packaged pose-sensing files are missing from app.asar.');
  // The real worker entry, forked the way the app forks it, with a runtime path that does not exist: it must start
  // inside the package, refuse to load ("runtime") and end on stop. Nothing native is loaded. It ends itself
  // without the normal exit path (electron/pose/worker.ts endProcess, 2026-11-03), so the exit code is the
  // system's; what matters is that the process is really gone at once, not lingering into the app's own quit.
  const worker = await instance.evaluate(async ({ app, utilityProcess }, { name, missing }) => {
    const path = process.getBuiltinModule('node:path');
    const env = {};
    for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    const child = utilityProcess.fork(path.join(app.getAppPath(), 'dist-electron', name), [], { serviceName: 'soft hearts next smoke pose check', stdio: 'ignore', env });
    const messages = [];
    let pid = null, stoppedAt = 0;
    child.on('spawn', () => { pid = child.pid ?? null; });
    return new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve({ messages, code: 'timeout', pid }); }, 15000);
      child.on('message', message => { messages.push(message); stoppedAt = Date.now(); child.postMessage({ type: 'stop' }); });
      child.on('exit', code => { clearTimeout(timer); resolve({ messages, code, pid, exitMs: Date.now() - stoppedAt }); });
      child.postMessage({ type: 'init', runtimeEntry: missing, detector: missing, pose: missing, detectorSha256: '0'.repeat(64), poseSha256: '0'.repeat(64), prefer: null, dmlBad: false });
    });
  }, { name: SMOKE_POSE.bundle.worker, missing: path.join(isolation.root, 'no-pose-runtime', 'onnxruntime-node') });
  assert.deepEqual(worker.messages, [{ type: 'failed', reason: 'runtime' }], 'The packaged pose worker must start from app.asar and answer.');
  assert.ok(typeof worker.code === 'number' && worker.exitMs < 1500, 'The packaged pose worker must end on stop: ' + JSON.stringify(worker));
  assert.ok(Number.isInteger(worker.pid), 'The pose worker process id must be known.');
  const workerStart = performance.now();
  while (processListed(worker.pid) && performance.now() - workerStart < 3000) await pause(50);
  poseWorkerExit = { exitMs: worker.exitMs, goneMs: Math.round(performance.now() - workerStart), listed: processListed(worker.pid) };
  assert.equal(poseWorkerExit.listed, false, 'The pose worker process must be gone, not lingering after its exit event.');
  // The user's path: only the pet on screen, click its camera button; then again with the control window on the chat page.
  const controlsWindow = what => instance.evaluate(({ BrowserWindow }, what) => {
    const win = BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('pet'));
    if (what === 'hide') win.hide();
    return win.isVisible();
  }, what);
  for (const attempt of ['first click, control window hidden', 'second click, control window on the chat page']) {
    if (attempt.startsWith('first')) assert.equal(await controlsWindow('hide'), false);
    else { await navigateControlPage(page, 'chat'); await pet.evaluate(() => document.getElementById('toast')?.classList.remove('show')); }
    // I-036: the camera button expands the two switches; 「姿势识别」 is the one that needs the component.
    await pet.evaluate(() => {
      const button = document.getElementById('pet-camera-sharing');
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      document.querySelector('#pet-camera-panel [data-camera-switch="cameraLocal"]').click();
    });
    await pet.waitForFunction(line => { const toast = document.getElementById('toast'); return toast?.classList.contains('show') && toast.textContent === line; }, SMOKE_POSE.refusedLine, { timeout: 5000 })
      .catch(() => assert.fail('The pet must say why the camera stayed off (' + attempt + ').'));
    await poll(() => controlsWindow('look'), 'control window shown (' + attempt + ')', 5000);
    // Still readable a moment later: mood broadcasts used to wipe it at once (src/ui/ImmersiveNotice.ts).
    await pause(1500);
    assert.equal(await pet.evaluate(line => { const toast = document.getElementById('toast'); return !!toast?.classList.contains('show') && toast.textContent === line; }, SMOKE_POSE.refusedLine), true,
      'The pet\'s line must stay up long enough to read (' + attempt + ').');
    await page.waitForFunction(() => document.getElementById('tab-privacy')?.classList.contains('active') && document.querySelector('#pose-sensing .pose-question')?.hidden === false
      && /下载/.test(document.querySelector('#pose-sensing .pose-question')?.textContent ?? ''), null, { timeout: 5000 })
      .catch(() => assert.fail('The control window must show the download question (' + attempt + ').'));
    const media = await pet.evaluate(() => window.desktop.getRuntimeState());
    assert.equal(media.cameraSharing, false, 'A refused camera stays off.');
    assert.equal('cameraRefused' in media, false, 'The reason never enters the shared state.');
  }
  assert.equal((await page.evaluate(() => window.desktop.dismissPosePrompt())).prompt, false);
}
async function run() {
  isolation = await createSmokeIsolation({ source, executable: process.env.MMD_TEST_EXE, proofFile: process.env.MMD_TEST_PREPARED,
    proofSha256: process.env.MMD_TEST_PREPARED_SHA256 });
  Object.assign(ownedResources, { root: isolation.root, profile: isolation.profile, executable: isolation.executable,
    proof: { sourceHash: isolation.proof.sourceHash, asarSha256: isolation.proof.asarSha256, executableSha256: isolation.proof.executableSha256, inputCount: isolation.proof.inputs.length } });
  saveOwnedResources('isolation-created');
  // An explicitly configured synthetic profile, not fresh-Gene first-run proof. Claude-only: no address or key.
  await writeFile(path.join(isolation.profile, 'settings.json'), JSON.stringify({ version: 1, model: null, motion: null,
    provider: { kind: 'claude', model: SMOKE_CLAUDE_MODEL }, persona: 'Public synthetic smoke companion. No local tasks.',
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 }, pet: { visible: true, alwaysOnTop: true, clickThrough: false, scale: 1, followMouse: false, fps: 24 } }));
  await isolation.beforeLaunch(); step(); phase = 'launch';
  instance = await electron.launch({ executablePath: isolation.executable, args: [`--user-data-dir=${isolation.profile}`], cwd: source, env: isolation.environment(), timeout: 30000 });
  const sdkProcess = instance.process(); // Read this owned SDK child once, before any close.
  ownedResources.sdkProcessPid = Number.isSafeInteger(sdkProcess?.pid) && sdkProcess.pid > 0 ? sdkProcess.pid : null;
  saveOwnedResources('sdk-process-returned');
  const running = await isolation.running(instance); // Retain actual PID before any later hook failure.
  ownedResources.mainPid = running.mainPid;
  saveOwnedResources('actual-main-verified');
  await instance.firstWindow(); await isolation.install(instance);
  await poll(() => { page = instance.windows().find(window => /index\.html(?:\?|$)/.test(window.url()) && !new URL(window.url()).searchParams.has('pet'));
    pet = instance.windows().find(window => /index\.html(?:\?|$)/.test(window.url()) && new URL(window.url()).searchParams.has('pet')); return page && pet; }, 'two owned windows');
  for (const window of [page, pet]) {
    window.on('pageerror', error => { remember(error); errors.push(error.message); });
    await window.waitForSelector('#chat-input');
    await window.locator('#voice-action-slot > [role="status"]').waitFor({ state: 'attached' });
    assert.equal(await window.locator('#voice-action-slot button[data-voice-action]').count(), 0,
      'Manual start/finish buttons were explicitly removed; the host-owned continuation status remains.');
    // Declare initial documents ready before accepting the first message.
    await window.evaluate(installRendererBoundary);
    await window.evaluate(inspectRendererBoundary);
    await window.evaluate(() => { window.__smokeEvents = { started: [], stream: [] };
      window.desktop.onChatStarted(event => window.__smokeEvents.started.push({ id: event.id, owner: event.owner }));
      window.desktop.onStream(event => window.__smokeEvents.stream.push({ id: event.id, kind: event.kind, type: event.type, text: event.text })); });
  }
  await page.waitForSelector('#stage canvas');
  assert.deepEqual(await page.locator('#control-navigation > .control-nav-roots > li > button[data-nav-group]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-nav-node'))), [...CONTROL_ROOTS]);
  if (process.env.MMD_TEST_MODEL) {
    phase = 'optional-model'; step();
    await setDeveloperMode(true);
    await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, process.env.MMD_TEST_MODEL);
    await navigateControlPage(page, 'appearance'); await page.locator('#import-model').click();
    await page.waitForFunction(() => document.querySelector('#stage-status')?.textContent === '模型已就绪', null, { timeout: 45000 });
    await page.locator('#frame-portrait').click(); await pause(800);
    await page.screenshot({ path: path.join(output, 'model-preview.png') });
    assert.match(await page.locator('#model-name').textContent(), /\.pmx|\.pmd/i);
    await page.locator('#camera-yaw').fill('35'); await page.locator('#camera-yaw').press('Tab');
    await poll(async () => (await page.evaluate(() => window.desktop.getSettings())).camera.yaw === 35, 'camera degrees persisted');
    await page.locator('#camera-yaw').fill('0'); await page.locator('#camera-yaw').press('Tab');
    const motionPath = path.join(output, 'original-test-motion.vmd'); await writeTestMotion(motionPath);
    await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, motionPath);
    await page.locator('#import-motion').click();
    await page.waitForFunction(() => document.querySelector('#stage-status')?.textContent?.includes('VMD 播放中'));
    await pause(350); await page.locator('#clear-motion').click();
    await page.waitForFunction(async () => (await window.desktop.getSettings()).motion === null); await pause(300);
    await setDeveloperMode(false);
  }
  phase = 'claude-connection'; step();
  await navigateControlPage(page, 'providers');
  await poll(async () => await page.locator('#provider-model').inputValue() === SMOKE_CLAUDE_MODEL
    && (await page.evaluate(() => window.desktop.getSettings())).provider.kind === 'claude', 'synthetic Claude connection loaded');
  assert.deepEqual(await page.evaluate(async () => window.desktop.listModels((await window.desktop.getSettings()).provider)), [...SMOKE_CLAUDE_MODEL_ALIASES], 'Claude-only model aliases, no network discovery.');
  await navigateControlPage(page, 'chat'); await page.locator('#new-chat').click();
  const first = await send('你好');
  await page.waitForFunction(() => document.querySelector('#chat-state')?.textContent === '回复完成');
  assert.match(await page.locator('.message.assistant').last().textContent(), /你好，桌面伙伴已连接/);
  assert.ok(first.turn.opening && first.turn.historyLength === 0, 'A new conversation opens its Claude Code session with an empty history window.');
  const waiting = await send('WAIT');
  await page.waitForFunction(id => window.__smokeEvents.stream.some(event => event.id === id && event.kind === 'chat' && event.type === 'status' && event.text === '正在连接模型…'), waiting.id);
  await page.waitForFunction(() => document.querySelector('#chat-state')?.textContent === '正在回复…');
  assert.equal(waiting.turn.spawn, first.turn.spawn, 'The next message must reuse the conversation\'s persistent Claude Code process.');
  assert.ok(!waiting.turn.opening && waiting.turn.historyLength === 0, 'A follow-up turn sends only what the session has not seen.');
  await page.locator('#new-chat').click();
  // Interrupt control request, closed stdin or an ended process: any of them stops the held turn.
  await poll(() => { const spawn = isolation.fakeClaude().spawns.find(value => value.index === waiting.turn.spawn);
    return latest(waiting).interrupted || spawn.stdinEnded || isolation.fakeClaudeGone(spawn.pid); }, 'actual pending Claude Code turn cancelled');
  assert.equal(await page.locator('.message').count(), 0);
  const next = await send('新的对话'); await page.waitForFunction(() => document.querySelector('#chat-state')?.textContent === '回复完成');
  assert.notEqual(next.turn.spawn, first.turn.spawn, 'A new conversation must not continue the old Claude Code process.');
  assert.ok(next.turn.opening && next.turn.historyLength === 0, 'History cleared: the new session opens with an empty history window.');
  phase = 'fake-claude-receipts';
  await poll(() => [first, next].every(record => latest(record).replies === 1), 'actual fake Claude Code replies finished');
  for (const window of [page, pet]) {
    for (const record of received) {
      await poll(async () => { const events = await window.evaluate(id => window.__smokeEvents.stream.filter(event => event.id === id), record.id);
        const done = events.filter(event => event.type === 'done').length, error = events.filter(event => event.type === 'error').length;
        assert.ok(done <= (record === waiting ? 0 : 1) && error <= (record === waiting ? 1 : 0));
        return done === (record === waiting ? 0 : 1) && error === (record === waiting ? 1 : 0); }, 'exact accepted-ID terminal');
      if (record !== waiting) assert.equal(await window.evaluate(id => window.__smokeEvents.stream.filter(event => event.id === id && event.type === 'delta').map(event => event.text).join(''), record.id), reply);
    }
  }
  assert.equal(latest(waiting).replies, 0); assert.ok([first, next].every(record => latest(record).replies === 1 && !latest(record).interrupted));
  assert.equal(received.length, 3); assert.equal(new Set(received.map(record => record.id)).size, 3);
  assert.equal(chatTurns().length, 3, 'Only the three declared UI cases may reach the fake Claude Code as chat.');
  const judges = isolation.fakeClaude().turns.length - chatTurns().length;
  assert.ok(judges <= received.length, `Besides chat, at most one I-037 reaction judge per sent message may reach the fake Claude Code (${judges}).`);
  phase = 'archive-once';
  const archived = () => page.evaluate(async ids => {
    const messages = [];
    for (let offset = 0; ; offset += 50) {
      const listing = await window.desktop.listMemories({ offset, limit: 50 });
      for (const record of listing.records)
        for (let messageOffset = 0; messageOffset < record.messageCount; messageOffset += 10) {
          const part = await window.desktop.readMemory(record.id, { messageOffset, messageLimit: 10, textLimit: 200 });
          messages.push(...part.messages.filter(message => ids.includes(message.turnId)).map(({ turnId, role, status, content }) => ({ turnId, role, status, content })));
        }
      if (offset + listing.records.length >= listing.total) break;
    }
    return messages;
  }, received.map(record => record.id));
  await poll(async () => { const messages = await archived(); return [first, next].every(record => messages.some(message => message.turnId === record.id && message.role === 'assistant' && message.status === 'complete')); }, 'completed replies archived');
  const archive = await archived();
  for (const record of received) {
    const own = archive.filter(message => message.turnId === record.id);
    assert.deepEqual(own.filter(message => message.role === 'user').map(message => message.content), [record.prompt], 'One archived user original per turn.');
    const assistant = own.filter(message => message.role === 'assistant');
    if (record === waiting) assert.ok(assistant.every(message => message.status !== 'complete'), 'A cancelled turn is never archived as complete.');
    else assert.deepEqual(assistant.map(message => [message.content, message.status]), [[reply, 'complete']], 'Each completed reply is archived exactly once.');
  }
  checks.push('navigation roots', 'Claude-only connection and model aliases', 'Claude Code stream-json through the packaged launch path (fake CLI)', 'streamed body and exact accepted IDs',
    'persistent session reused for the next message', 'new-chat cancels the pending turn', 'history cleared; new conversation opens a fresh process', 'archived once per turn');
  phase = 'UI-and-denials'; step();
  assert.equal(await page.evaluate(async () => { try { await navigator.mediaDevices.getUserMedia({ video: true }); return false; } catch { return true; } }), true);
  assert.equal(await pet.evaluate(async () => { try { await window.desktop.saveSettings(await window.desktop.getSettings()); return false; } catch { return true; } }), true, 'pet cannot change privileged settings');
  await page.screenshot({ path: path.join(output, 'controls.png') }); await pet.screenshot({ path: path.join(output, 'pet.png'), omitBackground: true });
  checks.push('harness camera denial; no native device opened', 'pet privilege boundary');
  phase = 'pose-host'; step();
  await checkPoseHost();
  checks.push('pose host up in the packaged app (owned empty LOCALAPPDATA)', 'packaged pose worker starts and answers', 'refused camera click explained in the pet and asked again in the control window');
  await navigateControlPage(page, 'privacy');
  const petVisible = () => instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'))?.isVisible());
  await page.locator('#pet-visible').uncheck(); await poll(async () => await petVisible() === false, 'pet hidden');
  await page.locator('#pet-visible').check(); await poll(async () => await petVisible() === true, 'pet shown');
  const metrics = await instance.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ type: metric.type, workingSetMB: Math.round(metric.memory.workingSetSize / 1024), cpu: metric.cpu.percentCPUUsage })));
  const showControls = show => instance.evaluate(({ BrowserWindow }, show) => { const controls = BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('pet')); if (show) { controls.show(); controls.focus(); } else controls.hide(); }, show);
  await setDeveloperMode(true);
  await showControls(false); assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('pet'))?.isVisible()), false);
  await page.waitForFunction(() => document.querySelector('#stage-status')?.textContent?.includes('预览已暂停'), null, { polling: 100 });
  await pause(1000); const petOnlyMetrics = await instance.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ type: metric.type, workingSetMB: Math.round(metric.memory.workingSetSize / 1024), cpu: metric.cpu.percentCPUUsage })));
  await showControls(true); assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && !new URL(win.webContents.getURL()).searchParams.has('pet'))?.isVisible()), true);
  if (process.env.MMD_TEST_MODEL) await page.waitForFunction(() => document.querySelector('#stage-status')?.textContent === '模型已就绪');
  await setDeveloperMode(false);
  const boundary = await isolation.evidence(instance);
  assert.equal(boundary.fetchAttempts, 0); assert.equal(boundary.captureAttempts + boundary.taskAttempts + boundary.browserAttempts + boundary.realtimeAttempts, 0);
  // Claude Code launches. Chat: only the conversation's process and the fresh one after new-chat (a spare may be pre-started).
  // I-037 reactions (on in development builds) launch their own judges: one-shot calls, or the warm judge process
  // (electron/inner-loop/warm-line.ts), which may start at any moment while the app is idle. They are told apart by their system
  // prompt once each fake process said hello (2026-11-07: a warm judge started before this check made the old single count 5).
  assert.deepEqual(boundary.claude.denied, []);
  for (const spawn of boundary.claude.spawned) {
    assert.equal(spawn.model, SMOKE_CLAUDE_MODEL);
    assert.deepEqual(spawn.findings, { electronRunAsNode: false, sessionVariables: 0, configDirMatches: true, noColor: true, noAutoUpdater: true, ownedTurnFolder: true, hidden: true },
      'Claude Code must start hidden, in its empty turn folder, with the sanitized environment.');
  }
  await poll(() => { const spawns = isolation.fakeClaude().spawns; return spawns.length >= boundary.claude.spawned.length && spawns.every(spawn => spawn.start); }, 'every launched fake Claude Code started');
  const fake = isolation.fakeClaude();
  const judgeLaunches = fake.spawns.filter(spawn => spawn.start?.reactionJudge === true).length;
  const chatLaunches = fake.spawns.length - judgeLaunches;
  assert.ok(chatLaunches >= 2 && chatLaunches <= 4, `Unexpected number of Claude Code chat launches (${chatLaunches} chat, ${judgeLaunches} reaction judge).`);
  assert.ok(judgeLaunches <= received.length + 2, `At most one reaction-judge launch per sent message, plus the warm judge and one rebuild (${judgeLaunches}).`);
  for (const spawn of fake.spawns) assert.ok(spawn.start?.argvOk === true && spawn.start.model === SMOKE_CLAUDE_MODEL && spawn.cwdEmpty === true && spawn.unexpected === 0,
    'The fake Claude Code saw the exact isolation flags, the selected model, an empty folder and only stream-json input.');
  const protocol = await Promise.all([page, pet].map(window => window.evaluate(() => window.__smokeEvents)));
  for (const events of protocol) {
    assert.deepEqual(events.started.map(event => event.id), received.map(record => record.id));
    assert.ok(events.started.every(event => event.owner === 'controls'));
    assert.ok(events.stream.every(event => received.some(record => record.id === event.id) && event.kind === 'chat'));
    for (const record of received) {
      const own = events.stream.filter(event => event.id === record.id);
      assert.equal(own.filter(event => event.type === 'done').length, record === waiting ? 0 : 1);
      assert.equal(own.filter(event => event.type === 'error').length, record === waiting ? 1 : 0);
      if (record !== waiting) assert.equal(own.filter(event => event.type === 'delta').map(event => event.text).join(''), reply);
    }
  }
  assert.equal(boundary.permissions.filter(event => event.kind === 'request').length, 0); assert.ok(boundary.permissions.every(event => event.returnedDenied)); assert.equal(boundary.permissionOverflow, false);
  const documents = await Promise.all(instance.windows().map(window => window.evaluate(inspectRendererBoundary)));
  assert.equal(await page.evaluate(inspectRendererBoundary).then(value => value.mediaAbsent), false, 'Owned index must expose the expected media API before testing its denial.');
  assert.equal(documents.reduce((sum, value) => sum + value.speech + value.realtime, 0), 0);
  assert.deepEqual(documents.flatMap(value => value.media), ['getUserMedia']);
  const runtime = await page.evaluate(async () => ({ settings: await window.desktop.getSettings(), media: await window.desktop.getRuntimeState(), audio: await window.desktop.getSystemAudioState(), ambient: await window.desktop.getAmbientAudioState() }));
  assert.equal(runtime.settings.voice.enabled, false); assert.equal(runtime.media.voiceInput || runtime.media.screenSharing || runtime.media.cameraSharing || runtime.audio.active || runtime.ambient.active, false);
  assert.deepEqual(errors, []);
  checks.push('pet hide/show', 'hidden preview unload and restore');
  const turns = isolation.fakeClaude().turns;
  return { version: 1, status: 'PASS', preparedSha256: process.env.MMD_TEST_PREPARED_SHA256, modelTested: !!process.env.MMD_TEST_MODEL, freshGeneFirstRunVerified: false, checks, boundary, protocol, documents, metrics, petOnlyMetrics, poseWorkerExit,
    receipts: received.map(record => { const turn = turns.find(value => value.key === record.turn.key);
      return { prompt: record.prompt, acceptedId: record.id, fakeClaude: { spawn: turn.spawn, seq: turn.seq, opening: turn.opening, historyLength: turn.historyLength, replies: turn.replies, interrupted: turn.interrupted } }; }),
    fakeClaude: isolation.fakeClaude().spawns.map(({ index, cwdEmpty, start, stdinEnded, unexpected }) => ({ index, cwdEmpty, argvOk: start?.argvOk ?? false, model: start?.model ?? null, stdinEnded, unexpected })),
    untestedExternal: ['desktop snapshots and real capture', 'real Claude Code CLI, login and model service', 'real Codex', 'speaker listening and physical input'],
    startupLimit: 'Filtered env, missing Codex locator, inert Claude Code placeholder with empty config folder, and synthetic settings precede launch. Fetch/browser/media hooks and the Claude Code interposer install later; no blanket startup-zero or OS sandbox claim.' };
}
let work;
try {
  work = Promise.resolve().then(run).finally(() => { activeSettled = true; });
  report = await bounded(work, activeEnd - performance.now(), 'Smoke active deadline');
  if (performance.now() >= activeEnd) throw Error('Smoke completed after its active deadline.');
} catch (error) { remember(error); report = { status: 'FAIL', ...primary }; console.error(primary.failure); }
finally {
  activeStopped = true;
  const end = performance.now() + 30000, remaining = cap => Math.max(1, Math.min(cap, end - performance.now() - 1000));
  const save = () => { const bytes = JSON.stringify(report, null, 2) + '\n'; writeFileSync(path.join(output, 'report.json'), bytes); if (isolation) writeFileSync(isolation.resultFile, bytes); };
  const watchdog = setTimeout(() => { report ??= {}; Object.assign(report, { status: 'FAIL', cleanupIncomplete: true, cleanup, nativeExitNotInferredFromRunner: true }); if (primary) Object.assign(report, primary); try { save(); } finally { process.exit(1); } }, 30000);
  const pending = new Set();
  const attempt = async (label, action, cap) => {
    pending.add(label);
    const operation = Promise.resolve().then(action).finally(() => pending.delete(label));
    try { return await bounded(operation, remaining(cap), label); } catch (error) { remember(error); errors.push(label); return null; }
  };
  if (instance) {
    await attempt('final-boundary', async () => { const value = await isolation.evidence(instance); assert.equal(value.fetchAttempts, 0); assert.deepEqual(value.claude.denied, []); return value; }, 750);
    // Diagnostics only (an SDK-close timeout used to leave no clue which process kept the app's pipes open).
    const processes = await bounded(instance.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type }))), 750, 'app-processes').catch(() => null);
    if (processes) cleanup.appProcesses = processes;
    const closeStart = performance.now();
    cleanup.sdkCloseResolved = await attempt('SDK-close', async () => { await instance.close(); return true; }, 8000) === true;
    cleanup.sdkCloseMs = Math.round(performance.now() - closeStart);
  } else cleanup.sdkCloseResolved = true;
  if (isolation) { cleanup.actualMainExited = await attempt('actual-main-exit', () => isolation.waitForMainExit(4000), 4500) === true; cleanup.main = isolation.mainExit(); }
  if (cleanup.appProcesses) { try { cleanup.appProcessesListedAfterClose = cleanup.appProcesses.filter(entry => processListed(entry.pid)); } catch { /* diagnostics only */ } }
  // Each fake exits once the app closes its stdin or ends it; none may outlive the app.
  if (isolation) cleanup.fakeClaudeExited = await attempt('fake-claude-exit', () => isolation.waitForFakeClaudeExit(4000), 4500) === true;
  else cleanup.fakeClaudeExited = true;
  if (work && !activeSettled) await attempt('late-active-work', () => work.catch(() => {}), 500);
  if (isolation && cleanup.sdkCloseResolved && cleanup.actualMainExited && cleanup.fakeClaudeExited && activeSettled) cleanup.profileRemoved = await attempt('owned-profile-remove', async () => { await isolation.cleanup(); return true; }, 2000) === true;
  report ??= { status: 'FAIL' }; report.cleanup = cleanup; report.errors = errors;
  // Hashing the package again takes longer at below-normal priority on half the cores (I-030, the user at the computer): 4 s timed
  // out once on 2026-11-04 although nothing was wrong. Still inside the 30 s cleanup budget.
  const identity = isolation && await attempt('final-package-identity', () => isolation.finishIdentity(), 15000); if (identity) report.identity = identity;
  report.pendingCleanup = [...pending];
  if (primary || !cleanup.sdkCloseResolved || !cleanup.actualMainExited || !cleanup.profileRemoved || !cleanup.fakeClaudeExited || !activeSettled || pending.size || performance.now() >= end) { report.status = 'FAIL'; process.exitCode = 1; }
  if (primary) Object.assign(report, primary);
  try { save(); if (performance.now() >= end) { report.status = 'FAIL'; process.exitCode = 1; save(); } }
  catch (error) { remember(error); console.error('Smoke report could not be saved.'); }
  finally { clearTimeout(watchdog); }
  console.log('Smoke report: ' + path.relative(source, path.join(output, 'report.json')));
  if (!cleanup.sdkCloseResolved || !activeSettled || pending.size) process.exit(1);
}
