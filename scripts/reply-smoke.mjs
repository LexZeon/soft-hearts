import { _electron as electron } from 'playwright';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from './lib/electron-cleanup.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Source or packaged E2E. Every chat and profile is synthetic; no device, user profile,
// desktop screenshot, external provider or private model is accessed.
// Coordinate the shared build/native-UI lease in ACTIVE-WORK.md before running.
const output = path.resolve('.local/reply-smoke');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-reply-e2e-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile);
const checks = [], errors = [], requests = [], timings = {}, layouts = [];
let instance, controls, pet, bubble;
// A hung main process must not leave this smoke's window behind (scripts/lib/electron-cleanup.mjs).
const disarm = armSmokeWatchdog(() => instance, 270_000, 'reply-smoke');
let report;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
async function waitFor(condition, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs) that streams these fixed replies.
const claude = await createClaudeFixture({ root: temporary, respond: turn => {
  const message = turn.currentUser;
  assert.equal(typeof message, 'string');
  assert.ok(['CHAT_FIRST', 'CHAT_SECOND', 'CHAT_ERROR', 'CHAT_STOP'].includes(message));
  const record = { message, completed: false, aborted: false };
  requests.push(record);
  if (message === 'CHAT_ERROR') {
    record.completed = true;
    turn.fail('SYNTHETIC_REPLY_ERROR');
    return;
  }
  const timers = [];
  const begin = () => {
    turn.delta(message === 'CHAT_STOP' ? 'STOP_REPLY' : message === 'CHAT_FIRST' ? 'FIRST_' : 'SECOND_');
    timers.push(setTimeout(() => {
      record.completed = true;
      if (message !== 'CHAT_STOP') turn.delta('REPLY');
      turn.done();
    }, message === 'CHAT_STOP' ? 20000 : 450));
  };
  if (message === 'CHAT_SECOND') timers.push(setTimeout(begin, 1400));
  else begin();
  turn.onCancel(() => {
    for (const timer of timers) clearTimeout(timer);
    record.aborted = !record.completed;
  });
} });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
  version: 1, model: null, motion: null,
  provider: claude.provider,
  voiceInput: { baseUrl: 'http://127.0.0.1:9/v1', model: 'unused-no-asr', language: 'zh', apiKey: '' },
  persona: 'Synthetic local reply test companion.',
  pet: { visible: true, alwaysOnTop: true, clickThrough: false, scale: 1, followMouse: false, fps: 24 },
  voice: { enabled: false, rate: 1, volume: 0 },
}));

async function hostState() {
  return instance.evaluate(({ BrowserWindow, screen }) => {
    const all = BrowserWindow.getAllWindows();
    const owner = all.find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'));
    const reply = all.find(win => win.webContents.getURL().endsWith('#soft-hearts-reply'));
    return {
      owner: owner && { id: owner.id, bounds: owner.getBounds(), visible: owner.isVisible(), minimized: owner.isMinimized(), top: owner.isAlwaysOnTop() },
      reply: reply && { id: reply.id, bounds: reply.getBounds(), visible: reply.isVisible(), focusable: reply.isFocusable(), top: reply.isAlwaysOnTop(), parent: reply.getParentWindow()?.id, title: reply.getTitle() },
      displays: screen.getAllDisplays().map(display => ({ id: display.id, workArea: display.workArea, scaleFactor: display.scaleFactor })),
      primary: screen.getPrimaryDisplay().workArea,
    };
  });
}
async function moveOwner(bounds) {
  await instance.evaluate(({ BrowserWindow }, next) => {
    const owner = BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'));
    owner.setBounds(next);
  }, bounds);
  await waitFor(async () => {
    const actual = (await hostState()).owner.bounds;
    return Object.entries(bounds).every(([key, value]) => actual[key] === value);
  }, 'pet bounds updated');
}
async function update(patch) { await pet.evaluate(value => window.desktop.updatePetReply(value), patch); }
async function visible() { return Boolean((await hostState()).reply?.visible); }
async function waitVisible(expected, label = 'reply visibility', timeout = 15000) {
  await waitFor(async () => await visible() === expected, label, timeout);
}
async function textIs(expected) {
  return bubble.evaluate(value => document.getElementById('reply-body')?.textContent === value, expected);
}
async function waitText(expected) {
  await waitFor(async () => await visible() && await textIs(expected), `reply text ${expected}`);
}
async function inspectLayout(anchor, name) {
  await waitVisible(true);
  // The native move event and the preload's DOM paint are separate deliveries.
  // Observe coherent native/preload bounds before measuring the body, rather than relying
  // on the preceding IPC invocation to mean the auxiliary DOM has already run.
  await waitFor(async () => {
    const native = await hostState();
    const painted = await bubble.evaluate(() => {
      const tail = document.getElementById('reply-tail');
      return { x: Number(tail.dataset.layoutX), y: Number(tail.dataset.layoutY), width: Number(tail.dataset.layoutWidth), height: Number(tail.dataset.layoutHeight) };
    });
    return Object.entries(painted).every(([key, value]) => Math.abs(native.reply.bounds[key] - value) < 1.1);
  }, `coherent native and DOM geometry: ${name}`);
  const native = await hostState();
  const dom = await bubble.evaluate(() => {
    const body = document.getElementById('reply-body'), tail = document.getElementById('reply-tail');
    const rect = body.getBoundingClientRect();
    return { body: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, side: body.dataset.side, above: body.dataset.above === 'true', tip: { x: Number(tail.dataset.tipX), y: Number(tail.dataset.tipY) }, path: tail.querySelector('path').getAttribute('d') };
  });
  const owner = native.owner.bounds, window = native.reply.bounds;
  const body = { ...dom.body, x: window.x + dom.body.x, y: window.y + dom.body.y };
  const mouth = { x: owner.x + anchor.x, y: owner.y + anchor.y };
  const area = native.displays.find(display => mouth.x >= display.workArea.x && mouth.x <= display.workArea.x + display.workArea.width && mouth.y >= display.workArea.y && mouth.y <= display.workArea.y + display.workArea.height)?.workArea;
  const radius = Math.max(20, anchor.radius ?? 80), tolerance = 1.1;
  assert.ok(area, 'mouth is on a connected display');
  assert.ok(body.x >= mouth.x + radius - tolerance || body.x + body.width <= mouth.x - radius + tolerance || body.y >= mouth.y + radius - tolerance || body.y + body.height <= mouth.y - radius + tolerance, 'visible body avoids head keepout');
  assert.ok(body.x >= area.x - tolerance && body.y >= area.y - tolerance);
  assert.ok(body.x + body.width <= area.x + area.width + tolerance && body.y + body.height <= area.y + area.height + tolerance);
  const pathStart = /^M\s+([\d.+-]+)\s+([\d.+-]+)/.exec(dom.path);
  assert.ok(pathStart, 'tail has a rendered path');
  const join = { x: Number(pathStart[1]), y: Number(pathStart[2]) };
  const cornerX = dom.side === 'right' ? dom.body.x : dom.body.x + dom.body.width;
  const cornerY = dom.above ? dom.body.y + dom.body.height : dom.body.y;
  assert.ok(Math.abs(join.x - cornerX) <= 28 && Math.abs(join.y - cornerY) <= 2, 'tail joins the nearest corner');
  const tailDepth = dom.above ? dom.tip.y - dom.body.y - dom.body.height : dom.body.y - dom.tip.y;
  assert.ok(Math.abs(tailDepth - 10) < tolerance, 'tail is a short triangle with bounded depth');
  assert.ok(Math.hypot(join.x - dom.tip.x, join.y - dom.tip.y) < 15, 'tail never stretches to the mouth');
  assert.ok(Math.abs(dom.tip.x - cornerX) <= 8, 'tail tip stays at its nearby corner');
  assert.ok(window.width <= dom.body.width + 18, 'native width excludes the gap to the mouth');
  assert.equal(native.reply.parent, native.owner.id);
  assert.equal(native.reply.focusable, false);
  assert.equal(native.reply.top, native.owner.top);
  const result = { name, owner, window, body, mouth, tailDepth, side: dom.side, above: dom.above };
  layouts.push(result);
  return result;
}
async function submit(message) {
  await controls.evaluate(text => {
    document.getElementById('chat-input').value = text;
    document.getElementById('chat-form').requestSubmit();
  }, message);
}
async function chatDone() {
  await waitFor(() => controls.evaluate(() => !document.getElementById('send-chat').classList.contains('hidden')), 'chat completed');
}
async function pointerBoundary(type) {
  await pet.evaluate(eventType => {
    const rect = document.querySelector('#pet-toolbar').getBoundingClientRect();
    document.documentElement.dispatchEvent(new PointerEvent(eventType === 'pointerenter' ? 'pointermove' : eventType,
      { pointerId: 1, pointerType: 'mouse', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  }, type);
}
async function toolbarVisible() {
  return pet.evaluate(() => document.getElementById('pet-toolbar').classList.contains('is-visible'));
}
async function toolbarHover() {
  await pointerBoundary('pointerenter');
  assert.equal(await toolbarVisible(), true);
  // A real CDP mouse click gives this ordinary button mouse focus; synthetic
  // element.focus() alone could accidentally select keyboard :focus-visible.
  await pet.locator('#pet-size-toggle').click();
  assert.deepEqual(await pet.evaluate(() => ({ pressed: document.getElementById('pet-size-toggle').getAttribute('aria-pressed'), keyboard: document.getElementById('pet-size-toggle').matches(':focus-visible') })), { pressed: 'true', keyboard: false });
  await pet.locator('#pet-window-done').click();
  await pet.evaluate(() => {
    document.body.classList.add('camera-editing');
    document.getElementById('pet-size-toggle').dispatchEvent(new PointerEvent('pointerenter', { pointerId: 1, pointerType: 'mouse' }));
  });
  assert.equal(await pet.evaluate(() => document.getElementById('pet-tooltip').classList.contains('hidden')), false);
  const leftAt = Date.now();
  await pointerBoundary('pointerleave');
  await pause(650);
  assert.equal(await toolbarVisible(), true, 'toolbar remains during the one-second grace period');
  await waitFor(async () => !await toolbarVisible(), 'toolbar leaves after one second', 1300);
  timings.toolbarLeave = Date.now() - leftAt;
  assert.ok(timings.toolbarLeave >= 950 && timings.toolbarLeave < 2000);
  assert.deepEqual(await pet.evaluate(() => ({ adjusting: document.body.classList.contains('window-adjusting'), tooltipHidden: document.getElementById('pet-tooltip').classList.contains('hidden'), pressed: document.getElementById('pet-size-toggle').getAttribute('aria-pressed') })), { adjusting: false, tooltipHidden: true, pressed: 'false' });
  await pointerBoundary('pointerenter');
  await pointerBoundary('pointerleave');
  await pause(650);
  await pointerBoundary('pointerenter');
  await pause(550);
  assert.equal(await toolbarVisible(), true, 'reentry cancels the previous leave deadline');
  await pointerBoundary('pointerleave');
  await waitFor(async () => !await toolbarVisible(), 'new toolbar leave deadline', 1700);
  await pet.evaluate(() => document.body.classList.remove('camera-editing'));
  check('after window adjustment ends toolbar waits one second, closes tip, ignores mouse focus and camera class, and cancels stale leave deadlines');
}
async function expiresAfterComplete(name, completeAt) {
  await pause(Math.max(0, 4200 - (Date.now() - completeAt)));
  assert.equal(await visible(), true, `${name} remains visible before five seconds`);
  await waitVisible(false, `${name} expires`, 2500);
  const elapsed = Date.now() - completeAt;
  assert.ok(elapsed >= 4850 && elapsed < 7000, `${name} five-second expiry: ${elapsed}ms`);
  timings[name] = elapsed;
}

try {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.MMD_TEST_EXE;
  delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({ ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] } : { args: ['.'] }), env, timeout: 30000 });
  await claude.install(instance);
  await instance.firstWindow();
  assert.deepEqual(await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData') })), { packaged: !!executable, profile });
  await waitFor(() => {
    controls = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'explicit controls and pet windows');
  for (const [name, page] of [['controls', controls], ['pet', pet]]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.waitForSelector('#chat-input');
    await page.waitForFunction(() => !!window.desktop?.updatePetReply, undefined, { polling: 100 });
    await page.evaluate(() => {
      window.__replySmokeChatIds = [];
      window.desktop.onChatStarted(chat => window.__replySmokeChatIds.push(chat.id));
    });
  }
  // Clear the synthetic default greeting through normal UI so no renderer-owned
  // reply lifetime or anchor update can race the following direct host fixtures.
  await controls.evaluate(() => document.getElementById('new-chat').click());
  await pause(150);
  const state = await hostState(), area = state.primary;
  assert.ok(area.width >= 760 && area.height >= 420, 'desktop is large enough for readable test fixtures');
  const bounds = { x: area.x + 24, y: area.y + 24, width: 400, height: Math.min(560, area.height - 48) };
  const anchor = { x: 200, y: Math.min(210, bounds.height / 2), radius: 110, visible: true };
  await moveOwner(bounds);
  await toolbarHover();
  await update({ state: 'hidden' });
  const denied = await controls.evaluate(async () => {
    try { await window.desktop.updatePetReply({ text: 'CONTROL_MUST_NOT_WRITE', state: 'streaming', anchor: { x: 200, y: 200, visible: true } }); return false; }
    catch { return true; }
  });
  assert.equal(denied, true);
  check('reply IPC rejects the controls window');
  const literal = '<img src=x onerror="window.fixtureExecuted=true"> & <script>window.fixtureExecuted=true</script>';
  const streamAt = Date.now();
  await update({ text: literal, state: 'streaming', anchor });
  await waitFor(() => { bubble = instance.windows().find(page => page.url().endsWith('#soft-hearts-reply')); return bubble; }, 'lazy auxiliary reply window');
  bubble.on('pageerror', error => errors.push(`reply: ${error.message}`));
  await waitText(literal);
  assert.deepEqual(await bubble.evaluate(() => ({ desktop: typeof window.desktop, require: typeof window.require, images: document.querySelectorAll('img,script,canvas').length, executed: Boolean(window.fixtureExecuted) })), { desktop: 'undefined', require: 'undefined', images: 0, executed: false });
  assert.equal((await hostState()).reply.title, 'soft hearts next · 回复');
  const first = await inspectLayout(anchor, 'left-edge rightward reply');
  assert.equal(first.side, 'right');
  assert.ok(first.body.x + first.body.width > first.owner.x + first.owner.width, 'reply extends beyond pet viewport');
  assert.deepEqual((await hostState()).owner.bounds, bounds);
  await bubble.screenshot({ path: path.join(output, 'reply-literal.png') });
  check('literal text, isolated preload, bounded corner triangle, native overflow and unchanged pet bounds');

  const moved = { ...bounds, x: bounds.x + 40, y: bounds.y + 20 };
  await moveOwner(moved);
  await inspectLayout(anchor, 'reply follows owner move');
  assert.deepEqual((await hostState()).owner.bounds, moved);
  await moveOwner({ ...bounds, x: area.x + area.width - bounds.width });
  assert.equal((await inspectLayout(anchor, 'right-edge leftward reply')).side, 'left');
  await moveOwner({ ...bounds, x: area.x });
  assert.equal((await inspectLayout(anchor, 'left-edge restores rightward reply')).side, 'right');
  await moveOwner({ ...bounds, x: area.x, y: area.y });
  await update({ anchor: { ...anchor, y: 16 } });
  assert.equal((await inspectLayout({ ...anchor, y: 16 }, 'near-top below-corner reply')).above, false);
  for (const display of state.displays.filter(display => display.workArea.x < 0 || display.workArea.y < 0)) {
    const a = display.workArea;
    if (a.width < 760 || a.height < 420) continue;
    await moveOwner({ ...bounds, x: a.x + 20, y: a.y + 20, height: Math.min(bounds.height, a.height - 40) });
    await update({ anchor });
    await inspectLayout(anchor, 'negative-coordinate connected display');
  }
  await moveOwner(bounds);
  await update({ anchor });
  check('monitor edges, top edge and owner movement preserve head clearance and a bounded directional tail');
  await pause(Math.max(0, 5250 - (Date.now() - streamAt)));
  assert.equal(await visible(), true, 'streaming has no five-second expiry');
  await update({ text: 'DIRECT_COMPLETE', state: 'complete' });
  const completeAt = Date.now();
  await waitText('DIRECT_COMPLETE');
  await expiresAfterComplete('directComplete', completeAt);
  check('streaming stays visible beyond five seconds and completion expires after five seconds');

  await update({ text: 'OLD_EXPIRY', state: 'complete', anchor });
  await waitText('OLD_EXPIRY');
  await pause(2700);
  await update({ state: 'hidden' });
  await waitVisible(false);
  await update({ text: 'NEW_STREAM', state: 'streaming', anchor });
  await waitText('NEW_STREAM');
  await pause(2550);
  assert.equal(await visible(), true);
  assert.equal(await textIs('NEW_STREAM'), true);
  await pointerBoundary('pointerenter');
  assert.equal(await toolbarVisible(), true);
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).hide());
  await waitVisible(false);
  await waitFor(async () => !await toolbarVisible(), 'native owner hide resets toolbar');
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).showInactive());
  await pause(250);
  assert.equal(await visible(), false, 'showing owner never resurrects cleared text');
  await update({ text: 'MINIMIZE_CLEARS', state: 'streaming', anchor });
  await waitText('MINIMIZE_CLEARS');
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).minimize());
  await waitFor(async () => (await hostState()).owner.minimized, 'native owner finishes minimizing');
  await waitVisible(false);
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).restore());
  await waitFor(async () => !(await hostState()).owner.minimized, 'native owner finishes restoring');
  await pause(250);
  assert.equal(await visible(), false);
  check('replacement cancels old expiry and owner hide/minimize clear the reply');

  await controls.evaluate(() => window.desktop.useBundledModel());
  await waitFor(() => pet.evaluate(() => /模型已就绪|VMD 播放中/.test(document.getElementById('pet-status').textContent)), 'public Gene renderer ready', 30000);
  await submit('CHAT_FIRST');
  await waitText('FIRST_REPLY');
  await chatDone();
  const firstChatId = await controls.evaluate(() => window.__replySmokeChatIds.at(-1));
  assert.match(firstChatId, /^[a-zA-Z0-9_-]{1,100}$/);
  requests.find(item => item.message === 'CHAT_FIRST').chatId = firstChatId;
  await bubble.screenshot({ path: path.join(output, 'gene-reply.png') });
  await pet.screenshot({ path: path.join(output, 'gene-pet.png') });
  await submit('CHAT_SECOND');
  await waitFor(() => requests.some(item => item.message === 'CHAT_SECOND'), 'next chat started');
  // Since the accepted-request waiting feature, the old answer is replaced by
  // visible, text-free dots. The native surface must not disappear for this gap.
  await waitFor(async () => {
    if (!await visible()) return false;
    const [controlsId, petId, nativeWaiting, controlsWaiting] = await Promise.all([
      controls.evaluate(() => window.__replySmokeChatIds.at(-1)),
      pet.evaluate(() => window.__replySmokeChatIds.at(-1)),
      bubble.evaluate(() => {
        const body = document.getElementById('reply-body');
        return body.classList.contains('reply-waiting') && body.textContent === '' && body.querySelectorAll('.reply-waiting-dot').length === 3 && body.getAttribute('aria-label') === '正在等待回复';
      }),
      controls.evaluate(() => {
        const body = [...document.querySelectorAll('.message.assistant .message-body')].at(-1);
        return body?.classList.contains('reply-waiting') && body.textContent === '' && body.querySelectorAll('.reply-waiting-dot').length === 3;
      }),
    ]);
    return typeof controlsId === 'string' && controlsId !== firstChatId && controlsId === petId && nativeWaiting && controlsWaiting;
  }, 'new accepted identity replaces old text with three waiting dots before its first delta', 900);
  requests.find(item => item.message === 'CHAT_SECOND').chatId = await controls.evaluate(() => window.__replySmokeChatIds.at(-1));
  await waitText('SECOND_REPLY');
  await chatDone();
  const secondAt = Date.now();
  await expiresAfterComplete('chatComplete', secondAt);
  const history = await controls.evaluate(() => [...document.querySelectorAll('.message.assistant .message-body')].map(node => node.textContent));
  assert.ok(history.includes('FIRST_REPLY') && history.includes('SECOND_REPLY'), 'full answers remain in controls history');
  check('real UI chat uses Gene layout and a new shared identity replaces old text with waiting dots before the next delta');

  await submit('CHAT_ERROR');
  await waitFor(() => requests.some(item => item.message === 'CHAT_ERROR'), 'error fixture requested');
  await chatDone();
  // R38 (default immersive): outside developer mode the bubble shows the fixed chat failure
  // (src/notice-policy.ts conciseFailure(..., 'chat')); the raw failure stays behind the
  // controls window's explicit details entry. The old check expected the raw text in the bubble.
  const chatFailure = '这次回复未完成，可查看问题详情后重试。';
  await waitFor(async () => await visible() && await bubble.evaluate(text => document.getElementById('reply-body').textContent.includes(text), chatFailure), 'error reply visible');
  assert.equal(await bubble.evaluate(() => document.getElementById('reply-body').textContent.includes('SYNTHETIC_REPLY_ERROR')), false, 'the bubble never shows the raw failure outside developer mode');
  assert.deepEqual(await controls.evaluate(() => ({ details: !document.getElementById('notice-details').hidden, raw: document.getElementById('notice-detail-text').textContent.includes('SYNTHETIC_REPLY_ERROR') })), { details: true, raw: true }, 'the raw failure stays reachable through the controls details entry');
  await expiresAfterComplete('chatError', Date.now());
  await submit('CHAT_STOP');
  await waitText('STOP_REPLY');
  await controls.evaluate(() => document.getElementById('stop-chat').click());
  await waitFor(async () => await visible() && await bubble.evaluate(() => document.getElementById('reply-body').textContent.includes('[已停止]')), 'stopped reply visible');
  await expiresAfterComplete('chatStop', Date.now());
  await waitFor(() => requests.find(item => item.message === 'CHAT_STOP')?.aborted, 'stopped fixture request aborted');
  check('error and stopped answers receive the same five-second lifetime');
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(runtime.voiceInput, false);
  assert.equal(runtime.screenSharing, false);
  assert.equal(runtime.cameraSharing, false);
  assert.deepEqual(errors, []);
  claude.assertClean(); assert.deepEqual((await claude.evidence(instance)).denied, []);
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet')).destroy());
  await waitFor(async () => !(await hostState()).reply, 'auxiliary window disposed with its owner');
  check('all media remains disabled and reply window is disposed with pet');
  report = { ok: true, checks, timings, layouts, requests, displays: state.displays.map(display => ({ workArea: display.workArea, scaleFactor: display.scaleFactor })), negativeDisplayTested: layouts.some(layout => layout.name.includes('negative-coordinate')), errors };
} catch (error) {
  const windowStates = await Promise.all([['controls', controls], ['pet', pet]].map(async ([name, page]) => ({ name, state: await page?.evaluate(() => ({ status: document.getElementById('pet-status')?.textContent ?? document.getElementById('stage-status')?.textContent, toast: document.getElementById('toast')?.textContent, chat: document.getElementById('chat-state')?.textContent })).catch(() => null) })));
  report = { ok: false, checks, timings, layouts, requests, errors, windowStates, failure: error.stack ?? String(error) };
  console.error(error);
  process.exitCode = 1;
} finally {
  const shutdown = await closeElectron(instance);
  disarm();
  if (!shutdown.closed) { process.exitCode = 1; console.error('reply-smoke: Electron did not close by itself', shutdown); }
  if (report) report.shutdown = shutdown;
  if (report) report.fakeClaude = await claude.close();
  else await claude.close();
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  // The only recursively removed folder was created by this process under TEMP.
  const resolved = path.resolve(temporary), tempRoot = path.resolve(os.tmpdir());
  assert.ok(path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('soft-reply-e2e-'));
  await rm(resolved, { recursive: true, force: true });
}
